/**
 * Candles for the share cards — docs/specs/share-cards.md, C1. Pure; every
 * number is made up.
 *
 *   npm run test:record
 */
import {
  BUCKET_BLOCKS, addPrice, dailyTotals, group, groupTimes, mergeBuckets, priceFromCurve, priceFromSqrt, timeOf, type Buckets,
} from "./candles.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
const E = 10n ** 18n;

console.log("\nbuckets");
{
  const b: Buckets = {};
  addPrice(b, 10, 2);
  addPrice(b, 20, 5);
  addPrice(b, 30, 1);
  addPrice(b, 40, 3);
  addPrice(b, BUCKET_BLOCKS + 1, 7);
  ok("open, high, low and close of the first bucket", JSON.stringify(b["0"]) === "[2,5,1,3]", JSON.stringify(b["0"]));
  ok("a price in the next bucket starts it", JSON.stringify(b["1"]) === "[7,7,7,7]");
  addPrice(b, 50, 0);
  addPrice(b, 60, Number.NaN);
  ok("zero and NaN are ignored", JSON.stringify(b["0"]) === "[2,5,1,3]");

  const curve: Buckets = { "5": [1, 2, 1, 2], "6": [2, 3, 2, 3] };
  const pool: Buckets = { "6": [3, 9, 3, 8], "7": [8, 8, 6, 6] };
  const m = mergeBuckets(curve, pool);
  ok("a bucket both have opens on the curve and closes on the pool", JSON.stringify(m["6"]) === "[2,9,2,8]", JSON.stringify(m["6"]));
  ok("the rest are kept as they were", JSON.stringify(m["5"]) === "[1,2,1,2]" && JSON.stringify(m["7"]) === "[8,8,6,6]");
  ok("merging copies, never changes its inputs", JSON.stringify(curve["6"]) === "[2,3,2,3]");
}

console.log("\nprices, ETH per whole token");
{
  // 1,000,000 tokens per ETH: a token costs 0.000001 ETH.
  const sqrt = BigInt(Math.round(Math.sqrt(1e6) * 2 ** 96));
  ok("from a pool's sqrtPrice", near(priceFromSqrt(sqrt, 18), 1e-6), String(priceFromSqrt(sqrt, 18)));
  // A 6-decimal token at 1e-6 raw units per wei: 1e12 raw per ETH, which is
  // 1e6 whole tokens per ETH, so 0.000001 ETH a token.
  const sqrt6 = BigInt(Math.round(Math.sqrt(1e-6) * 2 ** 96));
  ok("decimals are respected", near(priceFromSqrt(sqrt6, 6), 1e-6, 1e-6), String(priceFromSqrt(sqrt6, 6)));
  ok("a curve buy: ETH after fee over tokens out", near(priceFromCurve("buy", 101n * E / 100n, 1_000_000n * E, E / 100n, 18), 1e-6));
  ok("a curve sell: ETH out plus fee over tokens in", near(priceFromCurve("sell", 1_000_000n * E, 99n * E / 100n, E / 100n, 18), 1e-6));
  ok("the same price reads the same from a pool and from a curve",
    near(priceFromSqrt(sqrt, 18), priceFromCurve("buy", E, 1_000_000n * E, 0n, 18)));
  ok("an empty trade has no price", priceFromCurve("buy", 0n, 0n, 0n, 18) === 0);
}

console.log("\ntimes from blocks");
{
  const anchors: [number, number][] = [[1000, 10_000], [2000, 20_000], [4000, 30_000]];
  ok("in between two known blocks", timeOf(anchors, 1500) === 15_000);
  ok("across a change of block rate", timeOf(anchors, 3000) === 25_000);
  ok("after the last, at the last rate", timeOf(anchors, 6000) === 40_000);
  ok("before the first, at the first rate", timeOf(anchors, 500) === 5_000);
}

console.log("\ncandles from buckets");
{
  const B = BUCKET_BLOCKS;
  const b: Buckets = { "10": [1, 2, 1, 2], "11": [2, 4, 2, 3], "14": [3, 3, 1, 1] };
  const anchors: [number, number][] = [[0, 0], [100 * B, 100 * 3_600_000]];
  const one = group(b, anchors, 10 * B, 15 * B, 100);
  ok("one candle per bucket when there is room", one.length === 6, String(one.length));
  ok("an empty bucket carries the last close, flat", one[2]!.o === 3 && one[2]!.c === 3 && one[2]!.h === 3);
  ok("the next trade opens where the last closed", one[4]!.o === 3 && one[4]!.c === 1);
  ok("times come from the blocks", one[0]!.t0 === 10 * 3_600_000 && one[0]!.t1 === 11 * 3_600_000);
  const two = group(b, anchors, 10 * B, 15 * B, 3);
  ok("grouped into no more than asked for", two.length === 3, String(two.length));
  ok("a group spans its buckets' high and low", two[0]!.h === 4 && two[0]!.l === 1 && two[0]!.c === 3);
  ok("nothing before the first price", group({ "12": [5, 5, 5, 5] }, anchors, 10 * B, 12 * B, 10).length === 1);
}

console.log("\nthe record's daily running total");
{
  const DAY = 86_400_000;
  const flows = [
    { at: 1 * DAY + 100, delta: -0.5 },
    { at: 1 * DAY + 200, delta: 0.8 },
    { at: 3 * DAY + 50, delta: -0.1 },
  ];
  const c = dailyTotals(flows);
  ok("one candle per day, empty days included", c.length === 3);
  ok("a day's low and high include every step", c[0]!.l === -0.5 && near(c[0]!.h, 0.3) && c[0]!.o === 0);
  ok("an empty day is flat at the last total", near(c[1]!.o, 0.3) && near(c[1]!.c, 0.3));
  ok("the last close is the total", near(c[2]!.c, 0.2), String(c[2]!.c));
  ok("nothing in, nothing out", dailyTotals([]).length === 0);
}

console.log("\ncandles by time (p-sell-verdict.md P4a)");
{
  const pts = [{ at: 5, price: 1 }, { at: 12, price: 3 }, { at: 14, price: 2 }, { at: 35, price: 4 }];
  const cs = groupTimes(pts, 0, 39, 4);
  ok("four candles of ten", cs.length === 4 && cs[0]!.t0 === 0 && cs[1]!.t0 === 10, cs.map((c) => c.t0).join(","));
  ok("each opens where the last closed, highs and lows include the open",
    cs[1]!.o === 1 && cs[1]!.h === 3 && cs[1]!.l === 1 && cs[1]!.c === 2, JSON.stringify(cs[1]));
  ok("a quiet stretch carries the close, flat", JSON.stringify([cs[2]!.o, cs[2]!.h, cs[2]!.l, cs[2]!.c]) === "[2,2,2,2]");
  ok("the last candle takes a price at the very end", cs[3]!.c === 4);
  const late = groupTimes(pts, 20, 29, 2);
  ok("before any price in range, the last one before opens it", late.length === 2 && late[0]!.o === 2 && late[0]!.c === 2);
  ok("nothing before and nothing inside: no candle", groupTimes(pts, -20, -1, 3).length === 0);
  ok("zero prices are ignored", groupTimes([{ at: 1, price: 0 }], 0, 9, 1).length === 0);
}

console.log(failures === 0
  ? "\n\x1b[32mall candle checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
