// The page's port of v4-core's exact-input swap (F3.3).
//
// quote.test.js holds it to the wei against real fills on CABO's pool. That
// pool has one full-range position, so no swap there crosses an initialised
// tick. These tests cover what it cannot: the tick maths against a
// high-precision reference, crossings in both directions against an
// independent floating-point model, the protocol fee, a pool drained to the
// price limit, and every guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, Unpriceable,
  amount1Delta, computeSwapStep, sqrtPriceAtTick, swapExactIn,
} from "../public/js/trade/v4math.js";

const Q96 = 2n ** 96n;
const E18 = 10n ** 18n;

// ------------------------------------------------------------- the model --

/** sqrt(1.0001^tick) × 2^96 to 400 bits, independent of TickMath's constants. */
function referenceSqrtPrice(tick) {
  const P = 400n, ONE = 1n << P;
  const base = (10001n << P) / 10000n;
  let r = ONE, x = base;
  for (let e = BigInt(Math.abs(tick)); e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * x) >> P;
    x = (x * x) >> P;
  }
  const n = r << P;
  let s = 1n << BigInt(Math.ceil(n.toString(2).length / 2) + 1);
  for (;;) { const y = (s + n / s) >> 1n; if (y >= s) break; s = y; }
  if (tick < 0) s = (ONE * ONE) / s;
  return (s << 96n) >> P;
}

/**
 * An exact-input swap over piecewise-constant liquidity, in floating point:
 * the textbook formulas, not the contract's. `ticks` are the initialised ticks
 * with their net liquidity.
 */
function model({ sqrtPriceX96, liquidity, ticks, zeroForOne, amountIn, fee }) {
  let s = Number(sqrtPriceX96) / 2 ** 96, L = Number(liquidity), rem = Number(amountIn) * (1 - fee), out = 0;
  const price = (t) => Math.pow(1.0001, t / 2);
  const ahead = ticks
    .filter((t) => (zeroForOne ? price(t.tick) < s : price(t.tick) > s))
    .sort((a, b) => (zeroForOne ? b.tick - a.tick : a.tick - b.tick));
  for (const t of ahead) {
    const sb = price(t.tick);
    const need = zeroForOne ? L * (1 / sb - 1 / s) : L * (sb - s);
    if (rem < need) break;
    out += zeroForOne ? L * (s - sb) : L * (1 / s - 1 / sb);
    rem -= need;
    s = sb;
    L += zeroForOne ? -Number(t.net) : Number(t.net);
  }
  const end = zeroForOne ? 1 / (1 / s + rem / L) : s + rem / L;
  return out + (zeroForOne ? L * (s - end) : L * (1 / s - 1 / end));
}

/** A tick bitmap and tick table from a list of initialised ticks. */
function state(ticks, spacing) {
  const words = new Map(), nets = new Map(), reads = { words: [], ticks: [] };
  for (const { tick, net } of ticks) {
    const c = Math.floor(tick / spacing);
    words.set(c >> 8, (words.get(c >> 8) ?? 0n) | (1n << BigInt(c & 0xff)));
    nets.set(tick, net);
  }
  return {
    reads,
    word: async (pos) => { reads.words.push(pos); return words.get(pos) ?? 0n; },
    tickNet: async (tick) => {
      reads.ticks.push(tick);
      if (!nets.has(tick)) throw new Error(`tick ${tick} is not initialised`);
      return nets.get(tick);
    },
  };
}

const close = (got, want, rel, what) =>
  assert.ok(Math.abs(Number(got) - want) <= want * rel, `${what}: got ${got}, the model says ${want}`);

// ------------------------------------------------------------ tick maths --

test("sqrtPriceAtTick is v4-core's at both ends and at zero", () => {
  assert.equal(sqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE);
  assert.equal(sqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE);
  assert.equal(sqrtPriceAtTick(0), Q96);
});

test("sqrtPriceAtTick matches a 400-bit reference for ticks that set every bit, both signs", () => {
  // TickMath inverts a Q128 value for positive ticks, which costs it precision
  // at the top of the range; everywhere else it is within one unit.
  const ticks = [...Array.from({ length: 20 }, (_, i) => 2 ** i), 887271, 524287, 164401, 153600, 204600, 12345];
  for (const t of ticks.flatMap((t) => [t, -t])) {
    const got = sqrtPriceAtTick(t), want = referenceSqrtPrice(t);
    const diff = got > want ? got - want : want - got;
    assert.ok(diff <= 1n || Number(diff) / Number(want) < 1e-19, `tick ${t}: ${got} vs ${want}`);
  }
});

test("sqrtPriceAtTick refuses a tick outside the range", () => {
  for (const t of [MAX_TICK + 1, MIN_TICK - 1, 1.5, NaN]) assert.throws(() => sqrtPriceAtTick(t), Unpriceable, String(t));
});

// --------------------------------------------------------------- crossings --

// Two positions: [-2000, 2000] with 1e21 and [-500, 500] with 2e21. The price
// starts at tick 37, inside both.
const SPACING = 10;
const TICKS = [
  { tick: -2000, net: 10n ** 21n }, { tick: -500, net: 2n * 10n ** 21n },
  { tick: 500, net: -2n * 10n ** 21n }, { tick: 2000, net: -(10n ** 21n) },
];
const START = { sqrtPriceX96: sqrtPriceAtTick(37) + 12345n, tick: 37, liquidity: 3n * 10n ** 21n, lpFee: 3000, protocolFee: 0 };

for (const [what, zeroForOne, amountIn, crossed] of [
  ["a buy that crosses one tick leftward", true, 12n * 10n ** 19n, [-500]],
  ["a buy that stays inside", true, 5n * 10n ** 19n, []],
  ["a sell that crosses one tick rightward", false, 12n * 10n ** 19n, [500]],
  ["a sell that stays inside", false, 5n * 10n ** 19n, []],
]) {
  test(`${what} matches the model`, async () => {
    const s = state(TICKS, SPACING);
    const r = await swapExactIn(START, { tickSpacing: SPACING, zeroForOne, amountIn, word: s.word, tickNet: s.tickNet });
    close(r.amountOut, model({ ...START, ticks: TICKS, zeroForOne, amountIn, fee: 0.003 }), 1e-9, what);
    assert.deepEqual(s.reads.ticks, crossed, "the ticks crossed");
    assert.equal(r.amountIn, amountIn, "all of it was swapped");
    assert.equal(r.liquidity, crossed.length ? 10n ** 21n : START.liquidity, "the liquidity after");
  });
}

test("a bitmap word with nothing in it is stepped across, and the swap continues in the next", async () => {
  // Only the full range, far away: the swap walks word by word.
  const ticks = [{ tick: -887200, net: 10n ** 22n }, { tick: 887200, net: -(10n ** 22n) }];
  const s = state(ticks, 200);
  const start = { sqrtPriceX96: sqrtPriceAtTick(164401) + 1n, tick: 164401, liquidity: 10n ** 22n, lpFee: 3000, protocolFee: 0 };
  const amountIn = 20n * E18;
  const r = await swapExactIn(start, { tickSpacing: 200, zeroForOne: true, amountIn, word: s.word, tickNet: s.tickNet });
  assert.deepEqual(s.reads.words, [3, 2], "the word it started in, then the next one down");
  close(r.amountOut, model({ ...start, ticks, zeroForOne: true, amountIn, fee: 0.003 }), 1e-9, "20 ETH");
});

test("a pool drained to the price limit stops there, with input left over", async () => {
  const L = E18;
  const ticks = [{ tick: -887200, net: L }, { tick: 887200, net: -L }];
  const s = state(ticks, 200);
  const start = { sqrtPriceX96: Q96, tick: 0, liquidity: L, lpFee: 3000, protocolFee: 0 };
  const amountIn = 10n ** 38n; // about 5× what it takes to reach the edge of the range
  const r = await swapExactIn(start, { tickSpacing: 200, zeroForOne: true, amountIn, word: s.word, tickNet: s.tickNet });
  assert.equal(r.sqrtPriceX96, MIN_SQRT_PRICE + 1n, "the router's price limit");
  assert.ok(r.amountIn < amountIn, "not all the input was taken");
  assert.equal(r.liquidity, 0n, "past the last position");
  assert.deepEqual(s.reads.ticks, [-887200]);
  // Everything the position held in token1, less a wei per step for rounding down.
  const all = amount1Delta(sqrtPriceAtTick(-887200), Q96, L, false);
  assert.ok(r.amountOut <= all && all - r.amountOut < 64n, `${r.amountOut} of ${all}`);
});

test("a pool drained upward stops at the ceiling the same way", async () => {
  const L = E18;
  const ticks = [{ tick: -887200, net: L }, { tick: 887200, net: -L }];
  const s = state(ticks, 200);
  const start = { sqrtPriceX96: Q96, tick: 0, liquidity: L, lpFee: 3000, protocolFee: 0 };
  const amountIn = 10n ** 38n;
  const r = await swapExactIn(start, { tickSpacing: 200, zeroForOne: false, amountIn, word: s.word, tickNet: s.tickNet });
  assert.equal(r.sqrtPriceX96, MAX_SQRT_PRICE - 1n);
  assert.ok(r.amountIn < amountIn);
  assert.equal(r.liquidity, 0n);
  assert.deepEqual(s.reads.ticks, [887200]);
});

// ------------------------------------------------------------ the fees --

test("the protocol fee is added for its own direction only", async () => {
  const ticks = [{ tick: -887200, net: 10n ** 22n }, { tick: 887200, net: -(10n ** 22n) }];
  const base = { sqrtPriceX96: Q96, tick: 0, liquidity: 10n ** 22n, lpFee: 3000, protocolFee: 0 };
  const swap = async (protocolFee, zeroForOne) => {
    const s = state(ticks, 200);
    return (await swapExactIn({ ...base, protocolFee }, { tickSpacing: 200, zeroForOne, amountIn: E18, word: s.word, tickNet: s.tickNet })).amountOut;
  };
  const buyNone = await swap(0, true), sellNone = await swap(0, false);
  // 500 pips on zeroForOne (the low 12 bits), none the other way.
  const buy500 = await swap(500, true), sell500 = await swap(500, false);
  // 500 + 3000 − ⌊500·3000 / 1e6⌋ = 3499 pips (ProtocolFeeLibrary.calculateSwapFee).
  close(buy500, model({ ...base, ticks, zeroForOne: true, amountIn: E18, fee: 0.003499 }), 1e-12, "a buy with the protocol fee");
  assert.ok(buy500 < buyNone);
  assert.equal(sell500, sellNone, "a sell pays no zeroForOne protocol fee");
  // And 500 on oneForZero (the high 12 bits) only.
  assert.equal(await swap(500 << 12, true), buyNone);
  close(await swap(500 << 12, false), model({ ...base, ticks, zeroForOne: false, amountIn: E18, fee: 0.003499 }), 1e-12, "a sell with the protocol fee");
});

test("an exact-input step that does not reach its target takes the rest as fee", () => {
  const s = computeSwapStep(Q96, sqrtPriceAtTick(-1000), 10n ** 22n, E18, 3000n);
  assert.equal(s.amountIn + s.fee, E18);
  assert.equal(s.amountIn, (E18 * 997_000n) / 1_000_000n);
});

test("the price after an input rounds as v4-core's names say: up for token0, down for token1", () => {
  // At CABO's liquidity this is well under a wei of output, which is why the
  // real fills cannot see it; at a large enough liquidity it is not.
  const sqrtP = Q96 * 3n + 12345n, L = 10n ** 22n + 7n, remaining = 10n ** 18n + 3n;
  const n1 = L << 96n;
  // getNextSqrtPriceFromAmount0RoundingUp
  const down = computeSwapStep(sqrtP, MIN_SQRT_PRICE + 1n, L, remaining, 0n);
  const num = n1 * sqrtP, den = n1 + remaining * sqrtP;
  assert.notEqual(num % den, 0n, "not exact, so up and down differ");
  assert.equal(down.next, num / den + 1n);
  // getNextSqrtPriceFromAmount1RoundingDown
  const up = computeSwapStep(sqrtP, MAX_SQRT_PRICE - 1n, L, remaining, 0n);
  assert.notEqual((remaining << 96n) % L, 0n);
  assert.equal(up.next, sqrtP + (remaining << 96n) / L);
});

test("when the price times the input would wrap 256 bits, the step uses v4-core's other formula", () => {
  // SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp: past the overflow,
  // divRoundingUp(L << 96, (L << 96) / sqrtP + amount), which rounds differently.
  // The two only disagree near the top of the price range, with liquidity as
  // large as the token1 side can hold; these values were searched for.
  const MAX = 2n ** 256n - 1n;
  const sqrtP = (1n << 159n) * 3n / 2n, L = MAX / sqrtP / 2n, remaining = MAX / sqrtP + 1n;
  const s = computeSwapStep(sqrtP, MIN_SQRT_PRICE + 1n, L, remaining, 0n);
  const n1 = L << 96n, up = (a, b) => a / b + (a % b > 0n ? 1n : 0n);
  const fallback = up(n1, n1 / sqrtP + remaining), exact = up(n1 * sqrtP, n1 + remaining * sqrtP);
  assert.ok(remaining * sqrtP > 2n ** 256n - 1n, "the product would wrap");
  assert.notEqual(fallback, exact, "the two formulas differ here, so this test can tell them apart");
  assert.equal(s.next, fallback);
});

// ------------------------------------------------------------ the guards --

const simple = () => state([{ tick: -887200, net: 10n ** 22n }, { tick: 887200, net: -(10n ** 22n) }], 200);
const ok = { sqrtPriceX96: Q96, tick: 0, liquidity: 10n ** 22n, lpFee: 3000, protocolFee: 0 };
const run = (pool, over = {}) => { const s = simple(); return swapExactIn(pool, { tickSpacing: 200, zeroForOne: true, amountIn: E18, word: s.word, tickNet: s.tickNet, ...over }); };

// Each refusal names its own reason, so one guard cannot stand in for another.
const because = (why) => (e) => e instanceof Unpriceable && why.test(e.message);
for (const [what, pool, over, why] of [
  ["a pool that is not initialised (buying)", { ...ok, sqrtPriceX96: 0n }, {}, /not initialised/],
  ["a pool that is not initialised (selling)", { ...ok, sqrtPriceX96: 0n }, { zeroForOne: false }, /not initialised/],
  ["a tick spacing of zero", ok, { tickSpacing: 0 }, /tick spacing/],
  ["a tick spacing past int16", ok, { tickSpacing: 32768 }, /tick spacing/],
  ["nothing to swap", ok, { amountIn: 0n }, /nothing to swap/],
  ["an LP fee over 100%", { ...ok, lpFee: 1_000_001 }, {}, /fees/],
  ["a zeroForOne protocol fee over its cap", { ...ok, protocolFee: 1001 }, {}, /fees/],
  ["a oneForZero protocol fee over its cap", { ...ok, protocolFee: 1001 << 12 }, {}, /fees/],
  ["a buy with the price already at its floor", { ...ok, sqrtPriceX96: MIN_SQRT_PRICE + 1n, tick: MIN_TICK }, {}, /at its limit/],
  ["a sell with the price already at its ceiling", { ...ok, sqrtPriceX96: MAX_SQRT_PRICE - 1n, tick: MAX_TICK - 1 }, { zeroForOne: false }, /at its limit/],
]) {
  test(`refuses to price ${what}`, async () => {
    await assert.rejects(run(pool, over), because(why));
  });
}

test("refuses a swap that takes more steps than allowed", async () => {
  const s = state(TICKS, SPACING);
  const p = { tickSpacing: SPACING, zeroForOne: true, amountIn: 12n * 10n ** 19n, word: s.word, tickNet: s.tickNet };
  // To the edge of the word (tick 0), to the tick at -500, then on inside the next range.
  await assert.rejects(swapExactIn(START, { ...p, maxSteps: 2 }), because(/more than 2 steps/));
  assert.ok((await swapExactIn(START, { ...p, maxSteps: 3 })).amountOut > 0n, "three steps are enough");
});

test("refuses liquidity that a crossing takes below zero or past 128 bits", async () => {
  const below = state([{ tick: -500, net: 4n * 10n ** 21n }], SPACING);
  await assert.rejects(swapExactIn(START, { tickSpacing: SPACING, zeroForOne: true, amountIn: 12n * 10n ** 19n, word: below.word, tickNet: below.tickNet }), because(/liquidity/));
  const above = state([{ tick: 500, net: 2n ** 128n }], SPACING);
  await assert.rejects(swapExactIn(START, { tickSpacing: SPACING, zeroForOne: false, amountIn: 12n * 10n ** 19n, word: above.word, tickNet: above.tickNet }), because(/liquidity/));
});

test("refuses a token1 amount whose product would wrap 256 bits in the contract", () => {
  assert.throws(() => amount1Delta(MIN_SQRT_PRICE, MAX_SQRT_PRICE, 2n ** 128n - 1n, true), because(/256 bits/));
  assert.ok(amount1Delta(MIN_SQRT_PRICE, MAX_SQRT_PRICE, 2n ** 90n, true) > 0n);
});
