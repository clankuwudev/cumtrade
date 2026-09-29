/**
 * Hosted rate limits — public-release B5.3.
 *
 * Pure: a fake clock, no server, no network.
 *
 *   npm run test:ratelimit
 */
import { clientAddress } from "./origin.js";
import { classify, createLimiter, LIMITS, type Limits } from "./rateLimit.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

/** A limiter on a clock the test moves. */
function rig(opts: { limits?: Limits; maxKeys?: number; maxWindows?: number } = {}) {
  let t = 1_000_000;
  const limiter = createLimiter({ ...opts, now: () => t });
  return { limiter, at: (ms: number) => { t = 1_000_000 + ms; } };
}
/** Take `n` in a row; how many were admitted, and the last refusal's wait. */
function takeN(l: ReturnType<typeof createLimiter>, n: number, cls: Parameters<typeof l.take>[0], client: string, address?: string) {
  let admitted = 0;
  let retryAfter: number | null = null;
  for (let i = 0; i < n; i++) {
    const d = l.take(cls, client, { address });
    if (d.ok) admitted++; else retryAfter = d.retryAfter;
  }
  return { admitted, retryAfter };
}
const ip = (remoteAddress: string) => clientAddress({ socket: { remoteAddress }, headers: {} }, false);

const V4 = "203.0.113.7";
const V6 = ip("2001:db8:1:2::1");

console.log("\nwhat is limited, and as what");
const classes: [string, string | null][] = [
  ["/", null], ["/console", null], ["/app.css", null], ["/phone.css", null], ["/phonex.css", "read"], ["/js/main.js", null], ["/js/pages/token.js", null], ["/fonts/JetBrainsMono-Regular.woff2", null], ["/fontsx", "read"],
  ["/vendor/wallet.js", null], ["/vendorx", "read"],
  ["/healthz", null], ["/events", "sse"], ["/api/check", "check"], ["/api/prepare/buy", "prepare"],
  ["/api/prepare/sell", "prepare"], ["/api/prepare", "read"], ["/api/ledger", "ledger"], ["/api/replay", "replay"], ["/api/replays", "read"], ["/api/report", "report"],
  ["/api/launches", "read"], ["/api/stats", "read"], ["/api/logo", "read"], ["/api/history", "read"],
  ["/api/config", "read"], ["/nope", "read"], ["/api/check/", "read"], ["/healthz/x", "read"], ["/jsx", "read"],
];
for (const [path, want] of classes) {
  const got = classify(path);
  ok(`${path} → ${want ?? "not limited"}`, got === want, String(got));
}

console.log("\na burst, then the rate");
{
  const { limiter, at } = rig();
  at(0);
  let r = takeN(limiter, 3, "check", V6);
  ok("3 checks at once are admitted (burst 3)", r.admitted === 3);
  at(500);
  const d = limiter.take("check", V6);
  ok("the 4th within a second is refused", !d.ok);
  ok("…with retryAfter 10 (6/min is one every 10s, 9.5s left, rounded up)", !d.ok && d.retryAfter === 10, JSON.stringify(d));
  at(9_900);
  ok("at 9.9s still refused", !limiter.take("check", V6).ok);
  at(10_000);
  ok("at 10s one is admitted", limiter.take("check", V6).ok);
  ok("…and only one", !limiter.take("check", V6).ok);
  at(30_000);
  r = takeN(limiter, 3, "check", V6);
  ok("20s later, two more", r.admitted === 2, JSON.stringify(r));
  at(10 * 60_000);
  r = takeN(limiter, 5, "check", V6);
  ok("after a long idle, never more than the burst", r.admitted === 3, JSON.stringify(r));
  at(10 * 60_000);
  r = takeN(limiter, 1, "check", V4);
  ok("another client has its own bucket", r.admitted === 1);
  r = takeN(limiter, 10, "prepare", V6);
  ok("another class has its own bucket (prepare burst 5)", r.admitted === 5, JSON.stringify(r));
  ok("a token that float arithmetic leaves at 0.9999999999999999 still counts", (() => {
    const one: Limits = { ...LIMITS, classes: { ...LIMITS.classes, read: { client: { perMin: 60, burst: 2 } } } };
    const x = rig({ limits: one });
    // 60/min is 0.001 a millisecond: 2 → 1 at 0ms; 1.9 → 0.8999999999999999 at 900ms;
    // and at 1,000ms, 0.8999999999999999 + 0.1 is just short of 1.
    x.at(0); x.limiter.take("read", V6);
    x.at(900); x.limiter.take("read", V6);
    x.at(1_000); return x.limiter.take("read", V6).ok;
  })());
  ok("a refusal's retryAfter is at least 1 second", (() => {
    const l = rig(); l.at(0); takeN(l.limiter, 300, "read", V6); l.at(1);
    const x = l.limiter.take("read", V6); return !x.ok && x.retryAfter === 1;
  })());
}

console.log("\nIPv6: a /64 is one client, and a /48 shares a larger allowance");
{
  const { limiter, at } = rig();
  at(0);
  const a = ip("2001:db8:1:2::1"), b = ip("2001:db8:1:2:ffff:ffff:ffff:ffff");
  ok("two addresses in one /64 are one client", a === b, `${a} ${b}`);
  let r = takeN(limiter, 2, "check", ip("2001:db8:1:2::1"));
  const r2 = takeN(limiter, 2, "check", ip("2001:db8:1:2::2"));
  ok("…so they share a bucket (2 + 1 of 3)", r.admitted + r2.admitted === 3, `${r.admitted}+${r2.admitted}`);
  r = takeN(limiter, 3, "check", ip("2001:db8:1:3::1"));
  ok("a different /64 in the same /48 has its own 3", r.admitted === 3);
  // The /48 allows 4 × 3 = 12 at once: 3 + 3 used, so 6 more from two new /64s.
  const more = [4, 5, 6].map((n) => takeN(limiter, 3, "check", ip(`2001:db8:1:${n}::1`)).admitted);
  ok("the /48 stops the 13th check across its /64s", more.join() === "3,3,0", more.join());
  const refusal = limiter.take("check", ip("2001:db8:1:7::1"));
  ok("…and says how long, from the /48's rate (24/min: 2.5s → 3)", !refusal.ok && refusal.retryAfter === 3, JSON.stringify(refusal));
  r = takeN(limiter, 3, "check", ip("2001:db8:2:1::1"));
  ok("a different /48 is untouched", r.admitted === 3);
}

console.log("\nIPv4 gets more of what does not spend the budget");
{
  const { limiter, at } = rig();
  at(0);
  ok("an IPv4 client reads 1,200 at once", takeN(limiter, 1300, "read", V4).admitted === 1200);
  ok("an IPv6 client reads 300", takeN(limiter, 400, "read", V6).admitted === 300);
  ok("an IPv4 client checks 3, like anyone", takeN(limiter, 10, "check", V4).admitted === 3);
  ok("an IPv4 client prepares 5, like anyone", takeN(limiter, 10, "prepare", V4).admitted === 5);
  const streams = (client: string) => { let n = 0; while (n < 100 && limiter.open(client).ok) n++; return n; };
  ok("an IPv4 client opens 24 streams", streams("198.51.100.1") === 24);
  ok("an IPv6 client opens 6", streams(ip("2001:db8:9:9::1")) === 6);
  ok("an unknown client opens 6", streams("unknown") === 6);
}

console.log("\nglobal buckets");
{
  const { limiter, at } = rig();
  at(0);
  // 20 clients, one check each, empty the global burst of 20.
  let admitted = 0;
  for (let i = 1; i <= 20; i++) if (limiter.take("check", `198.51.100.${i}`).ok) admitted++;
  ok("20 clients take the global burst", admitted === 20);
  const d = limiter.take("check", "198.51.100.21");
  ok("the 21st client is refused by the global bucket", !d.ok);
  ok("…with the global's wait (120/min: 0.5s → 1)", !d.ok && d.retryAfter === 1, JSON.stringify(d));
  // Five seconds on, the global has 10. Had the refusal charged .21, it would
  // have 2.5 tokens now and get 2 of 3.
  at(5_000);
  const r = takeN(limiter, 3, "check", "198.51.100.21");
  ok("a client refused only by the global keeps its own tokens", r.admitted === 3, JSON.stringify(r));
  ok("read has no global bucket", (() => {
    const x = rig(); x.at(0); let n = 0;
    for (let i = 0; i < 2000; i++) if (x.limiter.take("read", `10.0.${i >> 8}.${i & 255}`).ok) n++;
    return n === 2000;
  })());
}

console.log("\nrefusing spends nothing");
{
  const { limiter, at } = rig();
  at(0);
  takeN(limiter, 2, "check", V6);
  // Empty the /48 from sibling /64s, so the next check from V6 is refused by the /48 only.
  for (let n = 10; n < 20; n++) limiter.take("check", ip(`2001:db8:1:${n}::1`));
  ok("V6 is refused by its /48", !limiter.take("check", V6).ok);
  at(2_500); // the /48 regains one; V6's own bucket, untouched by the refusal, has 1.25
  ok("…and its own bucket was not charged for the refusal", limiter.take("check", V6).ok);
}

console.log("\nthe ledger's distinct addresses");
{
  const { limiter, at } = rig();
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  let t = 0;
  const look = (client: string, a: string) => { t += 6_000; at(t); return limiter.take("ledger", client, { address: a }); };
  let admitted = 0;
  for (let i = 1; i <= 30; i++) if (look(V4, addr(i)).ok) admitted++;
  ok("30 distinct addresses in an hour are admitted", admitted === 30, String(admitted));
  const d = look(V4, addr(31));
  ok("the 31st is refused", !d.ok);
  // The first was seen at 6s; this is at 186s, so it expires in 3,600 - 180 = 3,420s.
  ok("…until the first leaves the window", !d.ok && d.retryAfter === 3420, JSON.stringify(d));
  let repeats = 0;
  for (let i = 1; i <= 30; i++) if (look(V4, addr(i)).ok) repeats++;
  ok("repeat lookups of the first 30 still pass", repeats === 30, String(repeats));
  ok("the same address in another case is a repeat", look(V4, addr(26).toUpperCase().replace("0X", "0x")).ok,
    addr(26).toUpperCase());
  ok("a refused distinct lookup took no token", (() => {
    const x = rig(); let tt = 0; const go = (a: string) => { tt += 6_000; x.at(tt); return x.limiter.take("ledger", V4, { address: a }); };
    for (let i = 1; i <= 30; i++) go(addr(i));
    x.at(tt + 6_000); x.limiter.take("ledger", V4, { address: addr(99) }); // refused: distinct
    // Had the refusal been charged, three immediate repeats would find 2 tokens.
    return takeN(x.limiter, 3, "ledger", V4, addr(1)).admitted === 3;
  })());
  at(6_000 + 3_600_000);
  ok("an hour after the first lookup, a new address fits", limiter.take("ledger", V4, { address: addr(32) }).ok);
  // Before the second address (seen at 12s) leaves too.
  ok("…but only one", (() => { at(6_000 + 3_600_000 + 3_000); return !limiter.take("ledger", V4, { address: addr(33) }).ok; })());
  ok("a lookup with no address is only rate-limited", (() => {
    const x = rig(); x.at(0); return takeN(x.limiter, 5, "ledger", V4).admitted === 3;
  })());
  ok("another class ignores an address", (() => {
    const x = rig(); let tt = 0; let n = 0;
    // One every 10s: exactly the check rate, so only a distinct-address rule could refuse.
    for (let i = 1; i <= 40; i++) { tt += 10_000; x.at(tt); if (x.limiter.take("check", V4, { address: addr(i) }).ok) n++; }
    return n === 40;
  })());
  ok("a /48 holds 120 distinct addresses across its /64s", (() => {
    const x = rig(); let tt = 0; let n = 0;
    for (let i = 1; i <= 121; i++) {
      tt += 2_000; x.at(tt); // /64s rotate, so only the /48's 40/min bucket and its window bind
      if (x.limiter.take("ledger", ip(`2001:db8:5:${i}::1`), { address: addr(i) }).ok) n++;
    }
    return n === 120;
  })());
}

console.log("\nmemory stays bounded");
{
  const { limiter, at } = rig();
  at(0);
  for (let i = 0; i < 100_000; i++) limiter.take("read", `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  ok("100,000 distinct clients leave 50,000 keys", limiter.size().keys === 50_000, JSON.stringify(limiter.size()));
  const lru = rig({ maxKeys: 3 });
  lru.at(0);
  takeN(lru.limiter, 1200, "read", "10.0.0.1"); // empty: an IPv4 client reads 1,200
  lru.limiter.take("read", "10.0.0.2");
  takeN(lru.limiter, 1, "read", "10.0.0.1"); // touched: most recent again
  lru.limiter.take("read", "10.0.0.3");
  lru.limiter.take("read", "10.0.0.4"); // evicts 10.0.0.2, the least recently used
  ok("a recently used client survives eviction", !lru.limiter.take("read", "10.0.0.1").ok);
  const w = rig({ maxWindows: 5 });
  w.at(0);
  for (let i = 0; i < 50; i++) w.limiter.take("ledger", `10.1.0.${i}`, { address: "0xabc" });
  ok("distinct-address windows are capped separately", w.limiter.size().windows === 5, JSON.stringify(w.limiter.size()));
}

console.log("\nevent streams");
{
  const { limiter } = rig();
  const held = Array.from({ length: 6 }, () => limiter.open(V6));
  ok("6 streams from one client open", held.every((s) => s.ok));
  const seventh = limiter.open(V6);
  ok("the 7th is refused", !seventh.ok);
  ok("…with the 30s hint", !seventh.ok && seventh.retryAfter === 30);
  const first = held[0]!;
  if (first.ok) { first.release(); first.release(); }
  ok("closing one lets the next in", limiter.open(V6).ok);
  ok("a double release freed one slot, not two", !limiter.open(V6).ok);
  for (const s of held) if (s.ok) s.release();
  ok("streams across a /48 stop at 24", (() => {
    const x = rig(); let n = 0;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 6; j++) if (x.limiter.open(ip(`2001:db8:7:${i}::1`)).ok) n++;
    return n === 24;
  })());
  ok("releasing everything empties the stream map", (() => {
    const x = rig(); const s = [1, 2, 3].map(() => x.limiter.open(V6));
    for (const y of s) if (y.ok) y.release();
    return x.limiter.size().streams === 0;
  })());
}

console.log("\nwhat the operator sees");
{
  const { limiter, at } = rig();
  at(0);
  takeN(limiter, 5, "check", V4);
  for (let i = 0; i < 7; i++) limiter.open(V6);
  const seen = limiter.drain();
  ok("refusals are counted by class and bucket", seen.get("check client") === 2 && seen.get("sse client") === 1,
    JSON.stringify([...seen]));
  ok("…and never by client", [...seen.keys()].every((k) => !k.includes(".") && !k.includes(":")));
  ok("drain resets the counts", limiter.drain().size === 0);
}

console.log("\nthe shipped table matches the spec");
{
  const c = LIMITS.classes;
  ok("check 6/min burst 3, global 120/min",
    c.check.client.perMin === 6 && c.check.client.burst === 3 && c.check.global!.perMin === 120);
  ok("prepare 20/min burst 5, global 600/min",
    c.prepare.client.perMin === 20 && c.prepare.client.burst === 5 && c.prepare.global!.perMin === 600);
  ok("ledger 10/min burst 3, 30 distinct an hour, global 300/min",
    c.ledger.client.perMin === 10 && c.ledger.client.burst === 3 && c.ledger.distinctPerHour === 30 && c.ledger.global!.perMin === 300);
  ok("report 10/min, global 600/min", c.report.client.perMin === 10 && c.report.global!.perMin === 600);
  ok("read 300/min, no global", c.read.client.perMin === 300 && !c.read.global);
  ok("6 streams, IPv4 ×4 for read and sse, /48 ×4",
    LIMITS.streams === 6 && LIMITS.ipv4.factor === 4 && LIMITS.ipv4.classes.join() === "read,sse" && LIMITS.prefix48 === 4);
  ok("each global burst is ten seconds of its rate",
    (["check", "prepare", "ledger", "report"] as const).every((k) => c[k].global!.burst === c[k].global!.perMin / 6));
}

console.log(failures === 0
  ? "\n\x1b[32mall rate-limit checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
