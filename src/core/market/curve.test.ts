// V2 of docs/specs/pons-venue.md: the curve arithmetic a venue without a
// quote function needs.
//
// The formula was validated against clank's own quoteBuy(), where both paths
// exist: 33 of 33 exact across 0.001, 0.01 and 0.5 ETH on twelve curves,
// 2026-09-21. What is pinned here is the part that was wrong first and would
// be wrong again — the rounding — plus the invariants a fill must never break.
//
//   npm run test:curve
import { strict as assert } from "node:assert";
import { parseEther } from "viem";
import { buyOnCurve } from "./curve.js";

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  catch (e) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${(e as Error).message}`); }
};

console.log("\nconstant-product buy");

check("the fee comes off the quote leg before pricing", () => {
  const r = buyOnCurve({ quoteReserve: parseEther("10"), tokenReserve: 10n ** 24n, feeBps: 100n, amountIn: parseEther("1") });
  assert.equal(r.feeWei, parseEther("0.01"));
  assert.equal(r.amountInAfterFee, parseEther("0.99"));
});

check("the division rounds UP, in the pool's favour", () => {
  // 7 * 99 / 10 = 69.3, so floor and ceil differ — which is the whole point.
  // Flooring hands out one extra token unit. That is exactly how the first
  // version of this differed from the chain: by one, on every curve tried.
  const curve = { quoteReserve: 7n, tokenReserve: 99n, feeBps: 0n, amountIn: 3n };
  const k = 7n * 99n;
  const denominator = 7n + 3n;
  assert.notEqual(k % denominator, 0n, "the fixture has to be one that does not divide exactly");

  const rounded = buyOnCurve(curve).expected;
  assert.equal(rounded, 99n - (k + denominator - 1n) / denominator, "takes the ceiling");
  assert.equal(rounded, 99n - k / denominator - 1n, "which is one fewer than flooring would give");
});

check("a fill can never exceed the token reserve", () => {
  const huge = buyOnCurve({ quoteReserve: 1n, tokenReserve: 1000n, feeBps: 0n, amountIn: parseEther("1000") });
  assert.ok(huge.expected <= 1000n, `got ${huge.expected}`);
});

check("more in is never less out", () => {
  const base = { quoteReserve: parseEther("1.68"), tokenReserve: 10n ** 27n, feeBps: 100n };
  let prev = -1n;
  for (const eth of ["0.001", "0.01", "0.1", "1"]) {
    const out = buyOnCurve({ ...base, amountIn: parseEther(eth) }).expected;
    assert.ok(out > prev, `${eth} ETH returned ${out}, not more than ${prev}`);
    prev = out;
  }
});

check("an empty curve returns nothing rather than dividing by zero", () => {
  const r = buyOnCurve({ quoteReserve: 0n, tokenReserve: 0n, feeBps: 100n, amountIn: 0n });
  assert.equal(r.expected, 0n);
});

check("a fill is never negative, however drained the curve", () => {
  const r = buyOnCurve({ quoteReserve: parseEther("100"), tokenReserve: 0n, feeBps: 100n, amountIn: parseEther("1") });
  assert.equal(r.expected, 0n);
});

check("the shape of a real launch prices sanely", () => {
  // The most common Pons config: 1.68 ETH phantom against 1B supply.
  const r = buyOnCurve({
    quoteReserve: parseEther("1.68"), tokenReserve: parseEther("1000000000"),
    feeBps: 100n, amountIn: parseEther("0.01"),
  });
  // 0.0099 into 1.68 is ~0.59% of the pool, so ~0.58% of supply after the curve.
  const pct = Number(r.expected * 10_000n / parseEther("1000000000")) / 100;
  assert.ok(pct > 0.5 && pct < 0.6, `got ${pct}% of supply`);
});

console.log(failures ? `\n\x1b[31m${failures} curve check(s) failed\x1b[0m\n` : "\n\x1b[32mall curve maths checks passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
