// The fee the token page quotes has to be the fee of the venue the token
// actually trades on. A bonded token trades in its V4 pool, not its settled
// curve, and quoting the curve's 1% there overstated a round trip threefold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { venueFeeBps } from "../public/js/core/domain.js";
import { breakevenPct, roundTripPct } from "../public/js/core/format.js";

const curve = { graduated: false, feeBps: 100, v4: null };
const bonded = { graduated: true, feeBps: 100, v4: { poolId: "0x", liquidity: "1", lpFee: 3000 } };
const bondedNoPool = { graduated: true, feeBps: 100, v4: null };

test("a curve token pays the curve's fee", () => {
  assert.equal(venueFeeBps(curve), 100);
});

test("a bonded token pays its pool's LP fee, converted from pips", () => {
  assert.equal(venueFeeBps(bonded), 30);
});

test("a bonded token with no pool has no fee to quote", () => {
  assert.equal(venueFeeBps(bondedNoPool), null);
});

test("the round trip at 0.3% is about 0.60%, not the curve's 1.99%", () => {
  assert.equal(roundTripPct(venueFeeBps(bonded)).toFixed(2), "0.60");
  assert.equal(breakevenPct(venueFeeBps(bonded)).toFixed(2), "0.60");
  assert.equal(roundTripPct(venueFeeBps(curve)).toFixed(2), "1.99");
  assert.equal(breakevenPct(venueFeeBps(curve)).toFixed(2), "2.03");
});
