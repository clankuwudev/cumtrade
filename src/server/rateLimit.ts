import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * Hosted rate limits (public-release B5.3).
 *
 * Token buckets per client, per IPv6 /48 and per class globally, a window of
 * distinct looked-up addresses for the ledger, and a count of open event
 * streams. Pure: nothing here knows about HTTP, and the only clock is `now`.
 *
 * A client is what `clientAddress` returns: an IPv4 address, or an IPv6 /64
 * written `2001:db8:1:2::/64`.
 */

/** A class a request is limited as. `sse` is counted by concurrency, not rate. */
export type Class = "check" | "prepare" | "ledger" | "replay" | "report" | "read" | "sse";
export type Metered = Exclude<Class, "sse">;
type Rate = { perMin: number; burst: number };
type Scope = "client" | "prefix" | "global" | "distinct";

export type Limits = {
  classes: Record<Metered, { client: Rate; global?: Rate; distinctPerHour?: number }>;
  /** Concurrent event streams per client. */
  streams: number;
  /**
   * One IPv4 address is often a whole campus, office or carrier NAT, and costs
   * an attacker money, so it gets more of what does not spend the budget.
   */
  ipv4: { factor: number; classes: readonly Class[] };
  /** Every IPv6 request also draws on its /48, at this multiple of the client's allowance. */
  prefix48: number;
};

/** Starting values. H1's staging measurement tunes them (see the spec). */
export const LIMITS: Limits = {
  classes: {
    check: { client: { perMin: 6, burst: 3 }, global: { perMin: 120, burst: 20 } },
    prepare: { client: { perMin: 20, burst: 5 }, global: { perMin: 600, burst: 100 } },
    ledger: { client: { perMin: 10, burst: 3 }, global: { perMin: 300, burst: 50 }, distinctPerHour: 30 },
    // One position's replay (p-sell-verdict.md P4a): an index read of a few
    // ms, asked once per Share, so a Portfolio's shares fit in the burst. Its
    // own count of distinct addresses, so it cannot widen the ledger's.
    replay: { client: { perMin: 30, burst: 10 }, global: { perMin: 600, burst: 100 }, distinctPerHour: 30 },
    report: { client: { perMin: 10, burst: 10 }, global: { perMin: 600, burst: 100 } },
    read: { client: { perMin: 300, burst: 300 } },
  },
  streams: 6,
  ipv4: { factor: 4, classes: ["read", "sse"] },
  prefix48: 4,
};

/**
 * Which class a path is limited as, or null for what is never limited: the
 * page, its static files (served by the proxy in production) and the health
 * check, none of which reaches the budget. Everything else is `read`, 404s
 * included.
 */
export function classify(pathname: string): Class | null {
  // The landing, the app's paths and its old names (L1), and the docs (PD).
  if (pathname === "/" || pathname === "/trade" || pathname === "/os" || pathname === "/ai" || pathname === "/docs" || pathname === "/console"
    || pathname === "/cumOS" || pathname === "/cumos" || pathname === "/terminal"
    || pathname === "/app.css" || pathname === "/phone.css"
    || pathname === "/favicon-32.png" || pathname === "/apple-touch-icon.png"
    || pathname === "/healthz" || pathname.startsWith("/js/") || pathname.startsWith("/fonts/")
    || pathname.startsWith("/landing/") || pathname.startsWith("/ai/") || pathname.startsWith("/docs/") || pathname.startsWith("/vendor/")) return null;
  if (pathname === "/events") return "sse";
  if (pathname === "/api/check") return "check";
  if (pathname.startsWith("/api/prepare/")) return "prepare";
  if (pathname === "/api/ledger") return "ledger";
  if (pathname === "/api/replay") return "replay";
  if (pathname === "/api/report") return "report";
  return "read";
}

export type Decision = { ok: true } | { ok: false; retryAfter: number };
export type Stream = { ok: true; release: () => void } | { ok: false; retryAfter: number };
export type Limiter = ReturnType<typeof createLimiter>;

const HOUR = 3_600_000;
/** A refused stream has no real time to wait for, only a hint. */
const STREAM_RETRY_SEC = 30;

export function createLimiter(opts: {
  now?: () => number;
  limits?: Limits;
  /** Buckets for clients and /48s, across every class. */
  maxKeys?: number;
  /** Distinct-address windows. */
  maxWindows?: number;
} = {}) {
  const now = opts.now ?? Date.now;
  const limits = opts.limits ?? LIMITS;
  const buckets = new Lru<Bucket>(opts.maxKeys ?? 50_000);
  const windows = new Lru<Map<number, number>>(opts.maxWindows ?? 10_000);
  const globals = new Map<Metered, Bucket>();
  // Not an LRU: forgetting an open stream's count would let its client open more.
  const streams = new Map<string, number>();
  // Addresses are kept only as keyed hashes. The key is never written anywhere,
  // so the window cannot say who looked up what (B3).
  const secret = randomBytes(32);
  const refused = new Map<string, number>();
  const count = (what: string) => refused.set(what, (refused.get(what) ?? 0) + 1);

  const hashAddress = (a: string) =>
    createHmac("sha256", secret).update(a.trim().toLowerCase()).digest().readUIntBE(0, 6);

  return {
    /** Admit one request of a metered class, or say how long to wait. */
    take(cls: Metered, client: string, o: { address?: string } = {}): Decision {
      const t = now();
      const spec = limits.classes[cls];
      const v6 = client.endsWith("::/64");
      const factor = isIP(client) === 4 && limits.ipv4.classes.includes(cls) ? limits.ipv4.factor : 1;
      const rate = scale(spec.client, factor);

      const draws: { b: Bucket; r: Rate; scope: Scope }[] = [
        { b: buckets.getOr(`${cls} ${client}`, () => full(rate, t)), r: rate, scope: "client" },
      ];
      if (v6) {
        const r = scale(spec.client, limits.prefix48);
        draws.push({ b: buckets.getOr(`${cls} ${prefix48(client)}`, () => full(r, t)), r, scope: "prefix" });
      }
      if (spec.global) {
        const r = spec.global;
        if (!globals.has(cls)) globals.set(cls, full(r, t));
        draws.push({ b: globals.get(cls)!, r, scope: "global" });
      }

      let waitMs = 0;
      let why: Scope = "client";
      for (const d of draws) {
        const w = msUntilToken(level(d.b, d.r, t), d.r);
        if (w > waitMs) { waitMs = w; why = d.scope; }
      }

      // The window of distinct addresses, per client and per /48.
      const seen: { w: Map<number, number>; h: number }[] = [];
      if (spec.distinctPerHour && o.address) {
        const h = hashAddress(o.address);
        const tiers: [string, number][] = [[client, spec.distinctPerHour]];
        if (v6) tiers.push([prefix48(client), spec.distinctPerHour * limits.prefix48]);
        for (const [key, cap] of tiers) {
          const w = windows.getOr(key, () => new Map());
          // Insertion order is time order: nothing is ever re-added.
          for (const [k, at] of w) { if (t - at < HOUR) break; w.delete(k); }
          if (!w.has(h) && w.size >= cap) {
            const oldest = w.values().next().value!;
            const wait = oldest + HOUR - t;
            if (wait > waitMs) { waitMs = wait; why = "distinct"; }
          }
          seen.push({ w, h });
        }
      }

      if (waitMs > 0) {
        count(`${cls} ${why}`);
        return { ok: false, retryAfter: Math.ceil(waitMs / 1000) };
      }
      // Admitted: charge everything it drew on, together.
      for (const d of draws) { d.b.tokens = level(d.b, d.r, t) - 1; d.b.at = t; }
      for (const { w, h } of seen) if (!w.has(h)) w.set(h, t);
      return { ok: true };
    },

    /** Open an event stream, or refuse one. `release` gives the slot back, once. */
    open(client: string): Stream {
      const v6 = client.endsWith("::/64");
      const cap = limits.streams * (isIP(client) === 4 && limits.ipv4.classes.includes("sse") ? limits.ipv4.factor : 1);
      const tiers: [string, number, Scope][] = [[client, cap, "client"]];
      if (v6) tiers.push([prefix48(client), limits.streams * limits.prefix48, "prefix"]);
      for (const [key, max, scope] of tiers) {
        if ((streams.get(key) ?? 0) >= max) {
          count(`sse ${scope}`);
          return { ok: false, retryAfter: STREAM_RETRY_SEC };
        }
      }
      for (const [key] of tiers) streams.set(key, (streams.get(key) ?? 0) + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          for (const [key] of tiers) {
            const n = (streams.get(key) ?? 1) - 1;
            if (n > 0) streams.set(key, n); else streams.delete(key);
          }
        },
      };
    },

    /** Refusals since the last call, as `"class scope" → count`. */
    drain(): Map<string, number> {
      const out = new Map(refused);
      refused.clear();
      return out;
    },

    /** How much is held, for tests. */
    size: () => ({ keys: buckets.size, windows: windows.size, streams: streams.size }),
  };
}

type Bucket = { tokens: number; at: number };

const full = (r: Rate, t: number): Bucket => ({ tokens: r.burst, at: t });
const scale = (r: Rate, f: number): Rate => (f === 1 ? r : { perMin: r.perMin * f, burst: r.burst * f });
const level = (b: Bucket, r: Rate, t: number) => Math.min(r.burst, b.tokens + (t - b.at) * r.perMin / 60_000);
// The epsilon keeps a bucket refilled to 0.9999999 by float arithmetic from
// refusing with a one-second wait.
const msUntilToken = (tokens: number, r: Rate) => (tokens >= 1 - 1e-9 ? 0 : (1 - tokens) * 60_000 / r.perMin);

/** `2001:db8:1:2::/64` → `2001:db8:1::/48`. */
const prefix48 = (client: string) => `${client.split(":").slice(0, 3).join(":")}::/48`;

/** A Map that forgets its least recently used key beyond `max`. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get size() { return this.map.size; }
  getOr(key: string, make: () => V): V {
    let v = this.map.get(key);
    if (v === undefined) v = make();
    else this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return v;
  }
}
