/**
 * The read cache's bound — public-release B4.1b.
 *
 * Both maps hold at most CACHE_MAX_ENTRIES (20,000) each, least recently used
 * first to go; an expired entry is dropped when it is found; a dropped value
 * loads again, once, however many ask for it at the same time. A stubbed
 * clock, no chain.
 *
 *   npm run test:cache
 */
import { cacheStats, cached, clearCache, immutable, seed } from "./cache.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const MAX = 20_000;
let loads = 0;
const load = (v: unknown) => async () => { loads++; return v; };

console.log("\npermanent entries");
{
  clearCache();
  for (let i = 0; i < 30_000; i++) await immutable(`p${i}`, load(i));
  ok("30,000 writes leave 20,000", cacheStats().permanent === MAX, String(cacheStats().permanent));
  loads = 0;
  await immutable("p29999", load(-1));
  ok("the newest is still cached", loads === 0);
  await immutable("p0", load(0));
  ok("the oldest went first, and loads again", loads === 1);

  clearCache();
  for (let i = 0; i < MAX; i++) await immutable(`q${i}`, load(i));
  await immutable("q0", load(-1)); // read: q0 is now the newest
  await immutable("q-new", load("new"));
  loads = 0;
  await immutable("q0", load(-1));
  ok("a read makes an entry newest again", loads === 0);
  await immutable("q1", load(1));
  ok("…so the next oldest went instead", loads === 1);
}

console.log("\nentries with a lifetime");
{
  clearCache();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 30_000; i++) await cached(`t${i}`, 60_000, load(i));
    ok("30,000 writes leave 20,000", cacheStats().ttl === MAX, String(cacheStats().ttl));

    clearCache();
    await cached("x", 60_000, load("first"));
    ok("one entry", cacheStats().ttl === 1);
    now += 61_000;
    loads = 0;
    const again = await cached("x", 60_000, load("second"));
    ok("an expired entry loads again", loads === 1 && again === "second");

    clearCache();
    await cached("gone", 1_000, load(1));
    now += 2_000;
    // Asked again with a load that fails: the expired entry must not survive the miss.
    await cached("gone", 1_000, async () => { throw new Error("refused"); }).catch(() => {});
    ok("an expired entry is dropped when a read finds it, even if the reload fails", cacheStats().ttl === 0,
      String(cacheStats().ttl));

    clearCache();
    for (let i = 0; i < 10_000; i++) seed(`s${i}`, i, 60_000);
    for (let i = 0; i < 15_000; i++) await cached(`check:0x${i.toString(16).padStart(40, "0")}`, 60_000, load(i));
    ok("seeds and 15,000 distinct check answers stay within the bound", cacheStats().ttl === MAX, String(cacheStats().ttl));

    clearCache();
    for (let i = 0; i < 30_000; i++) seed(`z${i}`, i, 60_000);
    ok("seeds alone stay within the bound", cacheStats().ttl === MAX, String(cacheStats().ttl));

    clearCache();
    for (let i = 0; i < MAX; i++) await cached(`u${i}`, 60_000, load(i));
    await cached("u0", 60_000, load(-1)); // a live read: u0 is now the newest
    await cached("u-new", 60_000, load("new"));
    loads = 0;
    await cached("u0", 60_000, load(-1));
    ok("a read makes a live entry newest again", loads === 0);
    await cached("u1", 60_000, load(1));
    ok("…so the next oldest went instead", loads === 1);

    clearCache();
    for (let i = 0; i < MAX; i++) seed(`w${i}`, i, 60_000);
    seed("w0", "again", 60_000); // written again: newest
    seed("w-new", "new", 60_000);
    loads = 0;
    const w0 = await cached("w0", 60_000, load(-1));
    ok("a rewritten entry is the newest", loads === 0 && w0 === "again", `${loads} ${String(w0)}`);
  } finally {
    Date.now = realNow;
  }
}

console.log("\na dropped value loads once");
{
  clearCache();
  for (let i = 0; i <= MAX; i++) await immutable(`r${i}`, load(i)); // r0 is dropped
  loads = 0;
  let release: () => void = () => {};
  const slow = async () => { loads++; await new Promise<void>((r) => { release = r; }); return "r0"; };
  const readers = Array.from({ length: 10 }, () => immutable("r0", slow));
  release();
  const got = await Promise.all(readers);
  ok("10 concurrent readers share one load", loads === 1 && got.every((v) => v === "r0"), String(loads));
}

console.log("\ncounts");
{
  clearCache();
  const before = cacheStats().evicted;
  for (let i = 0; i < MAX + 5; i++) await immutable(`c${i}`, load(i));
  ok("evicted counts what the bound dropped", cacheStats().evicted - before === 5, String(cacheStats().evicted - before));
}

console.log(failures === 0
  ? "\n\x1b[32mall cache checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
