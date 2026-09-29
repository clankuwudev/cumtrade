// What a sell should return, shown on the token page's sell side before it
// is quoted (sellEstimate.js). The curve's figures are held to real ones:
// valuation.ts's exact sale, read from the chain on 2026-09-25 for a live
// curve whose board row is RIGHT below. The pool's estimate was held to
// eth_simulateV1 fills on all four graduated pools that day, to the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";
import { IMPACT_WARN_PCT, sellEstimate } from "../public/js/trade/sellEstimate.js";
import { hostedTradePanel } from "../public/js/pages/token.js";

const RIGHT = { graduated: false, v4: null, raised: 0.02704045626854272, phantomEth: 1.68, tokensPerEth: 626358293.7233275, feeBps: 100 };
const CUM = { graduated: true, feeBps: 100, tokensPerEth: 63058755.66461838,
  v4: { poolId: "0x", liquidity: "30672463220289302506437", lpFee: 3000 } };
const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} is not ${b}`);

test("the curve's estimate is its exact sale, fee off, as the chain quotes it", () => {
  close(sellEstimate(RIGHT, 1e6).netEth, 0.001579088144202264);
  const e = sellEstimate(RIGHT, 1e7);
  close(e.netEth, 0.015659195528513845);
  close(e.feeEth, e.netEth / 99, 1e-9);
  assert.equal(e.capped, false);
  assert.equal(e.venue, "curve");
  // Impact, fees apart: s / (T + s), T the curve's token reserve.
  const T = (1.68 + RIGHT.raised) * RIGHT.tokensPerEth;
  close(e.impactPct, (100 * 1e7) / (T + 1e7));
});

test("past what the curve can take, it is capped there: the real ETH, fee off", () => {
  const e = sellEstimate(RIGHT, 5e7);
  close(e.netEth, 0.026770051705857292, 1e-6);
  assert.equal(e.capped, true);
  assert.ok(e.sellable < 5e7 && e.sellable > 1.7e7);
  // A curve nobody has bought on has nothing to pay out.
  const empty = sellEstimate({ ...RIGHT, raised: 0 }, 1e6);
  assert.deepEqual([empty.netEth, empty.capped, empty.sellable], [0, true, 0]);
});

test("a graduated token is estimated at its pool: small sells at spot less the pool fee, larger ones less", () => {
  const tiny = sellEstimate(CUM, 1);
  close(tiny.netEth, (1 * 0.997) / CUM.tokensPerEth, 1e-6);
  assert.equal(tiny.venue, "pool");
  const big = sellEstimate(CUM, 2e7);
  const L = 30672463220289302506437 / 1e18, E = L / Math.sqrt(CUM.tokensPerEth), T = L * Math.sqrt(CUM.tokensPerEth);
  const s = 2e7 * 0.997;
  close(big.netEth, (E * s) / (T + s));
  close(big.impactPct, (100 * s) / (T + s));
  close(big.feeEth, (2e7 * 0.003) / CUM.tokensPerEth);
  assert.ok(big.netEth < (2e7 * 0.997) / CUM.tokensPerEth);
  assert.equal(big.capped, false);
});

test("a row that cannot say gives no estimate, never a guess", () => {
  for (const [r, t] of [[null, 1], [RIGHT, 0], [RIGHT, -1], [RIGHT, NaN], [{ ...RIGHT, tokensPerEth: 0 }, 1],
    [{ ...RIGHT, phantomEth: 0 }, 1], [{ ...RIGHT, feeBps: undefined }, 1], [{ ...CUM, v4: null }, 1],
    [{ ...CUM, v4: { ...CUM.v4, liquidity: "0" } }, 1]]) {
    assert.equal(sellEstimate(r, t), null, JSON.stringify([r, t]));
  }
  assert.equal(IMPACT_WARN_PCT, 3);
});

// ------------------------------------------------------------ on the page --

globalThis.document = { querySelector: (sel) => (sel === "#qslip" ? { value: "3" } : null) };
const TOKEN = "0x00000000000000000000000000000000000070a1";
const conn = { info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" }, address: "0x00000000000000000000000000000000000A11cE", chainId: 4663, balanceWei: 10n ** 16n };

function sellSide(r, tokens, pct, ethUsd = 3000) {
  const saved = { mode: S.mode, conn: S.conn, tradeSide: S.tradeSide, sellPct: S.sellPct, stats: S.stats };
  Object.assign(S, { mode: "hosted", conn, tradeSide: "sell", sellPct: pct, stats: ethUsd ? { price: { ethUsd } } : null });
  try {
    return hostedTradePanel({ token: TOKEN, symbol: "TKN", status: "ready", sellable: true, band: "CLEAN", ...r },
      { state: "ok", balance: BigInt(tokens) * 10n ** 18n }).s;
  } finally {
    Object.assign(S, saved);
  }
}

test("the sell side says what the picked share should bring, in ETH and dollars, and its impact", () => {
  const html = sellSide(RIGHT, 20_000_000, 50);
  const e = sellEstimate(RIGHT, 1e7);
  assert.match(html, new RegExp(`<span>You receive</span>\\s*<b title="After the curve fee and the price impact, before gas\\.[^"]*"\\s*>≈ ${e.netEth.toFixed(5)} Ξ · \\$\\d`));
  assert.match(html, new RegExp(`<span>Price impact</span>\\s*<b class="" [^>]*>−${e.impactPct.toFixed(2)}%</b>`));
  assert.doesNotMatch(html, /can take at most/);
  // The share picked is what is estimated.
  assert.match(sellSide(RIGHT, 20_000_000, 25), new RegExp(`≈ ${sellEstimate(RIGHT, 5e6).netEth.toFixed(5)} Ξ`));
  // No ETH price yet: ETH alone, never a wrong dollar figure.
  assert.match(sellSide(RIGHT, 20_000_000, 50, null), new RegExp(`≈ ${e.netEth.toFixed(5)} Ξ</b>`));
});

test("an impact over 3% is amber, and a sell past the curve's cap says what it is for", () => {
  // 100M into a curve that has raised 0.5 ETH: about 6.8%, and under its cap.
  const deep = sellSide({ ...RIGHT, raised: 0.5 }, 100_000_000, 100);
  assert.match(deep, /<span>Price impact<\/span>\s*<b class="amb" [^>]*>−6\.\d\d%/);
  assert.doesNotMatch(deep, /can take at most/);
  const html = sellSide(RIGHT, 50_000_000, 100);
  assert.match(html, /<span>Price impact<\/span>\s*<b class="" /, "capped at 17M, about 1.6%");
  assert.match(html, /The curve can take at most 17\.\d\dM TKN in one sell; this is for that much\./);
  const pool = sellSide(CUM, 1_000, 100);
  assert.match(pool, /After the pool fee/);
  assert.match(pool, /<span>Price impact<\/span>\s*<b class="" [^>]*>&lt;0\.01%<\/b>/);
});

test("a panel row's value takes its colour class: amber impact, green or red P&L", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  assert.match(css, /\.tprow b\.grn\{color:var\(--grn\)\} \.tprow b\.red\{color:var\(--red\)\} \.tprow b\.amb\{color:var\(--amb\)\}/);
  assert.ok(css.indexOf(".tprow b.amb") > css.indexOf(".tprow b{"), "after the plain rule, so it wins");
});

test("nothing held, or a row that cannot say: no estimate rows", () => {
  assert.doesNotMatch(sellSide(RIGHT, 0, 50), /You receive|Price impact/);
  assert.doesNotMatch(sellSide({ ...RIGHT, phantomEth: 0 }, 1_000, 50), /You receive|Price impact/);
});
