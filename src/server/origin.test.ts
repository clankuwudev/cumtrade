/**
 * The loopback Host check (public-release S1), and hosted's public host, its
 * PUBLIC_ORIGIN and its client address (B5.2).
 *
 * Pure: no server, no network.
 *
 *   npm run test:origin
 */
import type { IncomingHttpHeaders } from "node:http";
import { clientAddress, loopbackHost, parsePublicOrigin, publicHost } from "./origin.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const accepts = (host: string | undefined, port = 8787) =>
  ok(`accepts ${JSON.stringify(host)} on ${port}`, loopbackHost(host, port));
const refuses = (host: string | undefined, why: string, port = 8787) =>
  ok(`refuses ${JSON.stringify(host)} on ${port}`, !loopbackHost(host, port), why);

console.log("\nthe console's own names");
accepts("localhost:8787");
accepts("127.0.0.1:8787");
accepts("[::1]:8787");
accepts("LOCALHOST:8787");

console.log("\nanything else");
refuses("evil.test:8787", "a rebinding page's own domain");
refuses("localhost:8788", "another port");
refuses("127.0.0.1:87870", "a port that merely starts with ours");
refuses("localhost", "no port, when ours is not 80");
refuses(undefined, "no Host header at all");
refuses("", "an empty Host header");
refuses("localhost:8787.evil.test", "our name as a prefix");
refuses("evil.localhost:8787", "our name as a suffix");
refuses("127.0.0.1.evil.test:8787", "a loopback-looking subdomain");
refuses("evil@localhost:8787", "userinfo smuggled into Host");
refuses("localhost.:8787", "a trailing-dot name");
refuses("0.0.0.0:8787", "the wildcard address");
refuses("192.168.1.10:8787", "a LAN address");

console.log("\nthe default port, which browsers leave out of Host");
accepts("localhost", 80);
accepts("localhost:80", 80);
refuses("evil.test", "a hostile name without a port", 80);

console.log("\nPUBLIC_ORIGIN");
const parses = (v: string, want: string) => {
  let got: string;
  try { got = parsePublicOrigin(v); } catch (e) { got = `threw: ${(e as Error).message}`; }
  ok(`${JSON.stringify(v)} → ${want}`, got === want, got);
};
const rejects = (v: string | undefined, why: string) => {
  let threw = false;
  try { parsePublicOrigin(v); } catch { threw = true; }
  ok(`refuses ${JSON.stringify(v)}`, threw, why);
};
parses("https://example.site", "https://example.site");
parses("https://example.site/", "https://example.site");
parses("HTTPS://Example.SITE", "https://example.site");
parses("https://example.site:443", "https://example.site");
parses("http://localhost:8790", "http://localhost:8790");
parses("https://example.site:8443", "https://example.site:8443");
rejects(undefined, "unset");
rejects("", "empty");
rejects("example.site", "no scheme");
rejects("ftp://example.site", "not http or https");
rejects("https://example.site/app", "a path");
rejects("https://example.site/?x=1", "a query");
rejects("https://example.site/#top", "a fragment");
rejects("https://user:pw@example.site", "credentials");

console.log("\nthe public host");
const pub = (host: string | undefined, origin: string, want: boolean, why = "") =>
  ok(`${want ? "accepts" : "refuses"} ${JSON.stringify(host)} for ${origin}`, publicHost(host, origin) === want, why);
pub("example.site", "https://example.site", true);
pub("EXAMPLE.site", "https://example.site", true, "case");
pub("example.site:443", "https://example.site", true, "the default port written out");
pub("example.site:80", "https://example.site", false, "http's default port on an https site");
pub("example.site:8443", "https://example.site", false, "another port");
pub("localhost:8790", "http://localhost:8790", true);
pub("localhost", "http://localhost:8790", false, "no port, when ours is not the default");
pub("example.site.", "https://example.site", false, "a trailing dot");
pub("example.site.evil.test", "https://example.site", false, "our name as a prefix");
pub("evil.example.site", "https://example.site", false, "a subdomain");
pub("127.0.0.1:8787", "https://example.site", false, "loopback is not the site");
pub(undefined, "https://example.site", false, "no Host");
pub("", "https://example.site", false, "an empty Host");

console.log("\nthe client address");
const who = (remoteAddress: string | undefined, headers: IncomingHttpHeaders, trust: boolean) =>
  clientAddress({ socket: { remoteAddress }, headers }, trust);
const addr = (name: string, got: string, want: string) => ok(`${name} → ${want}`, got === want, got);
addr("IPv4 socket", who("203.0.113.7", {}, false), "203.0.113.7");
addr("IPv4-mapped socket is IPv4", who("::ffff:203.0.113.7", {}, false), "203.0.113.7");
addr("IPv6 socket is its /64", who("2001:db8:1:2:3:4:5:6", {}, false), "2001:db8:1:2::/64");
addr("another address in that /64", who("2001:db8:1:2::9", {}, false), "2001:db8:1:2::/64");
addr("the next /64 is another key", who("2001:db8:1:3::9", {}, false), "2001:db8:1:3::/64");
addr("case and leading zeros", who("2001:0DB8:0001:0002::1", {}, false), "2001:db8:1:2::/64");
addr("a zone index", who("fe80::1%eth0", {}, false), "fe80:0:0:0::/64");
addr("a zone index on an IPv4-mapped address", who("::ffff:198.51.100.9%1", {}, false), "198.51.100.9");
addr("an IPv4 tail that is not mapped", who("64:ff9b::192.0.2.33", {}, false), "64:ff9b:0:0::/64");
addr("IPv6 loopback", who("::1", {}, false), "0:0:0:0::/64");
addr("no socket address", who(undefined, {}, false), "unknown");

const forged = { "x-forwarded-for": "198.51.100.9" };
addr("without TRUST_PROXY a forged header changes nothing", who("127.0.0.1", forged, false), "127.0.0.1");
addr("with it, a single entry", who("127.0.0.1", forged, true), "198.51.100.9");
addr("with it, only the rightmost entry",
  who("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.9" }, true), "198.51.100.9");
addr("duplicate headers, as an array",
  who("127.0.0.1", { "x-forwarded-for": ["1.1.1.1", "198.51.100.9"] as unknown as string }, true), "198.51.100.9");
addr("a rightmost entry that is not an address falls back to the socket",
  who("127.0.0.1", { "x-forwarded-for": "198.51.100.9, garbage" }, true), "127.0.0.1");
addr("an address with a port is not an address",
  who("127.0.0.1", { "x-forwarded-for": "198.51.100.9:4431" }, true), "127.0.0.1");
addr("an empty header falls back to the socket", who("127.0.0.1", { "x-forwarded-for": "" }, true), "127.0.0.1");
addr("no header falls back to the socket", who("127.0.0.1", {}, true), "127.0.0.1");
addr("a forwarded IPv6 client is its /64",
  who("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 2001:db8:a:b::1" }, true), "2001:db8:a:b::/64");
addr("a forwarded IPv4-mapped client is IPv4",
  who("127.0.0.1", { "x-forwarded-for": " ::ffff:198.51.100.9 " }, true), "198.51.100.9");

console.log(failures === 0
  ? "\n\x1b[32mall origin checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
