/**
 * ETH/USD by day for the trade replay — docs/specs/trade-replay.md, V1.
 *
 * Hermetic: the price source is a fake answering in Coinbase's shape, and the
 * cache lives in a temp directory.
 *
 *   npm run test:record
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "clank-ethusd-"));
Object.assign(process.env, {
  ETHUSD_FILE: join(dir, "ethusd.json"),
  ETHUSD_HISTORY_URL: "http://fake-coinbase.invalid/candles",
  ETH_PRICE_URL: "http://fake-coinbase.invalid/spot",
});

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 7, 10); // 2026-08-10
// Every day for 30 days has a close except the third, which the source never had.
const closes = new Map<number, number>();
for (let i = 0; i < 30; i++) if (i !== 2) closes.set(D0 + i * DAY, i === 0 ? 1871 : i === 1 ? 1900 : 1900 + i * 10);
const asked: string[] = [];

globalThis.fetch = (async (url: unknown) => {
  const u = new URL(String(url));
  asked.push(u.href);
  if (u.pathname === "/spot") {
    return new Response(JSON.stringify({ data: { amount: "2732.5" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const start = Date.parse(u.searchParams.get("start")!), end = Date.parse(u.searchParams.get("end")!);
  // Coinbase's rows: [time (s), low, high, open, close, volume], newest first.
  const rows = [...closes].filter(([t]) => t >= start && t < end).sort((a, b) => b[0] - a[0])
    .map(([t, c]) => [t / 1000, c - 10, c + 10, c - 5, c, 1000]);
  return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { dailyUsd, dayOf } = await import("./ethusd.js");
const { ethUsdReady } = await import("./price.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

console.log("\nETH/USD by day");
{
  await ethUsdReady();
  const now = D0 + 30 * DAY + 3600_000; // 2026-09-09, an hour in
  const got = await dailyUsd(D0, now, now);
  ok("a day's close is the source's close", got["2026-08-10"] === 1871 && got["2026-08-11"] === 1900, JSON.stringify(got));
  ok("a day the source has no close for takes the last one before it", got["2026-08-12"] === 1900);
  ok("the next close is its own", got["2026-08-13"] === 1930);
  ok("today is the live price, not a partial candle", got["2026-09-09"] === 2732.5);
  ok("only dates were asked for", asked.every((a) => !/0x[0-9a-f]{40}/i.test(a)));
  const before = asked.filter((a) => a.includes("/candles")).length;
  await dailyUsd(D0, now, now);
  ok("days on disk, and an old day with no close, are not asked for again",
    asked.filter((a) => a.includes("/candles")).length === before);

  // A day later: 2026-09-09 is past now and the source has no close for it
  // yet. Only a day old, it may just be late, so it is asked for again.
  const later = D0 + 31 * DAY + 3600_000;
  await dailyUsd(D0 + 28 * DAY, later, later);
  const n = asked.filter((a) => a.includes("/candles")).length;
  await dailyUsd(D0 + 28 * DAY, later, later);
  ok("a recent day with no close is asked for again", asked.filter((a) => a.includes("/candles")).length === n + 1);
  ok("the day of a moment is its UTC date", dayOf(D0 + DAY - 1) === "2026-08-10" && dayOf(D0 + DAY) === "2026-08-11");
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? "\n\x1b[32mall ETH/USD checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
