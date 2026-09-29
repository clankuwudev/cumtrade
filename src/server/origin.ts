import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { TRUST_PROXY } from "./config.js";

/**
 * Is this request addressed to the console on loopback?
 *
 * `sameOrigin()` alone is not enough. A browser sends `Origin` on cross-origin
 * requests and on same-origin requests other than GET and HEAD, so a page on a
 * hostile domain that has been re-pointed at 127.0.0.1 (DNS rebinding) is
 * same-origin with the console and its GETs arrive with no `Origin` at all —
 * including the GET for the page that carries the session token. What such a
 * request cannot hide is `Host`, which still names the hostile domain.
 *
 * Exact matches only: a prefix or suffix test would accept
 * `localhost:8787.evil.test` or `evil.localhost:8787`.
 */
export function loopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const names = ["localhost", "127.0.0.1", "[::1]"];
  // A browser leaves the port out of Host when it is the scheme's default.
  if (port === 80 && names.includes(h)) return true;
  return names.some((n) => h === `${n}:${port}`);
}

/**
 * `PUBLIC_ORIGIN` as the one origin a hosted site answers for, or an error
 * that says what is wrong with it.
 *
 * An origin only: a path would suggest the site can live under one, and the
 * `Origin` a browser sends never carries it, so every POST would be refused.
 */
export function parsePublicOrigin(value: string | undefined): string {
  const example = "for example PUBLIC_ORIGIN=https://example.site";
  if (!value) {
    throw new Error(`PUBLIC_ORIGIN is not set. A hosted site answers only requests addressed to it, ${example}`);
  }
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`PUBLIC_ORIGIN is not a URL (${value}), ${example}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`PUBLIC_ORIGIN must be http: or https:, not ${u.protocol}`);
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new Error(`PUBLIC_ORIGIN must be a scheme, a host and an optional port, with no path, query or credentials (${value})`);
  }
  return u.origin;
}

/**
 * Is this request addressed to the public site?
 *
 * The hosted counterpart of `loopbackHost`, for the same reason: a request
 * naming any other host is not for us, whatever the socket says. Exact, apart
 * from case and a default port written out, which URL leaves out of `host`.
 */
export function publicHost(host: string | undefined, publicOrigin: string): boolean {
  if (!host) return false;
  const u = new URL(publicOrigin);
  const h = host.toLowerCase();
  if (h === u.host) return true;
  return u.port === "" && h === `${u.hostname}:${u.protocol === "https:" ? 443 : 80}`;
}

/**
 * Who is asking, as a rate-limit key (B5.3).
 *
 * The socket address, unless `TRUST_PROXY=1`, when it is the rightmost
 * `X-Forwarded-For` entry: the one our own proxy wrote. Everything to its left
 * is whatever the client sent. An entry that is not an address falls back to
 * the socket, which is the proxy, so those requests share one key.
 *
 * IPv6 is its /64. A host is routinely handed a whole /64, so a per-address
 * key would let one machine rotate through billions of them.
 */
export function clientAddress(
  req: { socket: { remoteAddress?: string }; headers: IncomingHttpHeaders },
  trustProxy = TRUST_PROXY,
): string {
  let ip = req.socket.remoteAddress;
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const entries = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",");
    const last = entries[entries.length - 1]!.trim();
    if (isIP(last.split("%")[0]!)) ip = last;
  }
  if (!ip) return "unknown";
  const bare = ip.split("%")[0]!; // a link-local zone index names our interface, not the client
  if (isIP(bare) !== 6) return bare;
  const g = ipv6Groups(bare);
  // IPv4-mapped (::ffff:a.b.c.d): Node reports IPv4 clients of a dual-stack
  // socket this way, and as a /64 they would all share one key.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join(".");
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The eight groups of a valid IPv6 address, including one with an IPv4 tail. */
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((x) => parseInt(x, 16));
}

/** Reject cross-origin callers outright; localhost pages have no Origin or our own. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch / curl
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch { return false; }
}
