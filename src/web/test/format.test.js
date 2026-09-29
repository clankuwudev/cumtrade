// Money formatting. `usd` decides what every valuation on the console reads
// as, including the case where there is no price at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";
import { usd, sign, eth, pc } from "../public/js/core/format.js";

const withPrice = (ethUsd, fn) => {
  const prev = S.stats;
  S.stats = { price: { ethUsd } };
  try { fn(); } finally { S.stats = prev; }
};

test("with no price, valuations stay in ETH rather than faking a dollar sign", () => {
  S.stats = null;
  assert.equal(usd(0.0123), "0.0123 Ξ");
  assert.equal(usd(1.5, 2), "1.50 Ξ");
});

test("dust reads as $0, not as a string of zeros", () => {
  withPrice(2400, () => {
    // One wei of raise, which every fresh curve reports.
    assert.equal(usd(1e-18), "$0");
    assert.equal(usd(0), "$0");
  });
});

test("the thresholds between cents, whole dollars, K, M and B", () => {
  withPrice(2000, () => {
    assert.equal(usd(0.0000005), "$0.0010");     // below a cent: four places
    assert.equal(usd(0.00001), "$0.02");         // cents
    assert.equal(usd(0.049), "$98.00");          // under 100: cents
    assert.equal(usd(0.05), "$100");             // 100 and up: whole dollars
    assert.equal(usd(0.5), "$1.0K");
    assert.equal(usd(500), "$1.00M");
    assert.equal(usd(500_000), "$1.00B");
    assert.equal(usd(-0.5), "$-1.0K");
  });
});

test("sign uses a real minus, and eth / pc fix their places", () => {
  assert.equal(sign(-1.99), "−2.0"); // one place by default, so 1.99 rounds to 2.0
  assert.equal(sign(2.03, 2), "+2.03");
  assert.equal(eth("0.1"), "0.1000");
  assert.equal(pc(1.99, 2), "1.99%");
  // Non-numbers format as zero rather than NaN.
  assert.equal(eth("not a number"), "0.0000");
});
