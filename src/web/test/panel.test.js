// The hosted token page's trade panel (public-release F3.4), as markup, in
// each state a visitor can be in. It trades from their own wallet, so nothing
// here may describe a server wallet: no keystore, lock, cost basis, P&L or
// per-trade cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";
import { hostedTradePanel } from "../public/js/pages/token.js";

const VISITOR = "0x00000000000000000000000000000000000A11cE";
const row = (over = {}) => ({
  token: "0x00000000000000000000000000000000000070a1", symbol: "TKN", name: "token", status: "ready",
  graduated: false, v4: null, sellable: true, band: "CLEAN", feeBps: 100, tokensPerEth: 500_000_000, ...over,
});
const conn = (over = {}) => ({
  info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" },
  address: VISITOR, chainId: 4663, balanceWei: 2n * 10n ** 16n, ...over,
});
const holding = (state, balance) => ({ state, balance });

// The panel reads slippage from the quick-buy field in the top bar's buy size
// (#qslip), the one setting for it, and edits it in place (U4). That field is
// all of the page this test needs.
globalThis.document = { querySelector: (sel) => (sel === "#qslip" ? { value: "3" } : null) };

/** Render in hosted with the given state, and hand back the markup. */
function panel(r, { c = conn(), side = "buy", typed = "", h = holding("ok", 0n), pct = 50 } = {}) {
  const saved = { mode: S.mode, conn: S.conn, tradeSide: S.tradeSide, customAmount: S.customAmount, sellPct: S.sellPct, buySize: S.buySize };
  Object.assign(S, { mode: "hosted", conn: c, tradeSide: side, customAmount: typed, sellPct: pct, buySize: 0.01 });
  try {
    return hostedTradePanel(r, h).s;
  } finally {
    Object.assign(S, saved);
  }
}

const SELF_WORDS = /keystore|locked|Per-trade cap|Cost<|P&amp;L|Worth now|Sellable in one go|npm run/i;
const button = (html, attr) => {
  const m = html.match(new RegExp(`<button class="bigbtn[^"]*" ${attr}[^>]*>([^<]*)</button>`));
  return m ? { tag: m[0], text: m[1].trim(), disabled: /\sdisabled(\s|>)/.test(m[0]) } : null;
};

test("disconnected: Buy says to connect, and the wallet row says so", () => {
  const html = panel(row(), { c: null });
  const b = button(html, 'data-buy="[^"]*"');
  assert.ok(b.disabled);
  assert.equal(b.text, "Connect a wallet");
  assert.match(b.tag, /data-amount-eth="0\.01"/, "the preset, as a string");
  assert.match(html, /<span>Wallet<\/span><b>not connected<\/b>/);
  assert.doesNotMatch(html, SELF_WORDS);
});

test("a typed amount is carried exactly, however small", () => {
  const html = panel(row(), { typed: "0.0000001" });
  const b = button(html, 'data-buy="[^"]*"');
  assert.ok(!b.disabled);
  assert.equal(b.text, "Buy 0.0000001 Ξ");
  assert.match(b.tag, /data-amount-eth="0\.0000001"/);
  assert.match(html, /id="tokamt" type="text"/, "a text field, so the browser never reformats it");
});

test("an amount that is not ETH, or is more than the wallet holds, is refused on the button", () => {
  let b = button(panel(row(), { typed: "abc" }), 'data-buy="[^"]*"');
  assert.ok(b.disabled);
  assert.equal(b.text, "Enter an amount of ETH");
  b = button(panel(row(), { typed: "0.03" }), 'data-buy="[^"]*"');
  assert.ok(b.disabled);
  assert.equal(b.text, "More than this wallet holds");
});

test("the sell side with nothing held says so, and offers no value", () => {
  const html = panel(row(), { side: "sell", h: holding("ok", 0n) });
  const b = button(html, 'data-sell="[^"]*"');
  assert.ok(b.disabled);
  assert.equal(b.text, "You hold no TKN");
  assert.doesNotMatch(html, /At the current price/);
  assert.doesNotMatch(html, SELF_WORDS);
});

test("the sell side with a holding shows it, its value at spot, and a live Sell of the picked share", () => {
  const html = panel(row(), { side: "sell", h: holding("ok", 5_000_000n * 10n ** 18n), pct: 25 });
  assert.match(html, /<span>Holding<\/span><b>5\.00M TKN<\/b>/);
  assert.match(html, /≈ 0\.01000 Ξ/, "5M tokens at 500M per ETH");
  const b = button(html, 'data-sell="[^"]*"');
  assert.ok(!b.disabled);
  assert.equal(b.text, "Sell 25%");
  assert.match(b.tag, /data-pct="25"/);
  for (const p of [25, 50, 100]) assert.match(html, new RegExp(`data-pct-pick="${p}"`));
});

test("while the holding is being read, Sell waits", () => {
  const html = panel(row(), { side: "sell", h: holding("loading", null) });
  assert.match(html, /<span>Holding<\/span><b>reading…<\/b>/);
  assert.equal(button(html, 'data-sell="[^"]*"').text, "Reading your TKN balance");
});

test("a bonded token with its pool quotes the pool's fee", () => {
  const html = panel(row({ graduated: true, v4: { poolId: "0x", liquidity: "1", lpFee: 3000 } }), { typed: "1" });
  assert.match(html, /0\.30% pool fee/);
  assert.match(html, /<span>Pool fee in<\/span>\s*<b>0\.003000 Ξ<\/b>/);
});

test("a bonded token without a pool has nowhere to trade", () => {
  const html = panel(row({ graduated: true, v4: null }));
  assert.match(html, /No pool found/);
  assert.doesNotMatch(html, /data-buy|data-sell/);
});

test("a token that failed a gate says so under Buy", () => {
  const html = panel(row({ band: "AVOID" }));
  assert.match(html, /class="bigbtn risky"/);
  assert.match(html, /Banded AVOID\./);
  const unsellable = panel(row({ sellable: false }));
  assert.match(unsellable, /The sell simulation reverted/);
});

test("the slippage shown is the quick-buy setting, and is edited right in the panel", () => {
  // U4: the panel no longer sends you elsewhere to change it ("Change it in
  // Quick buy, in the sidebar"); the field beside the trade is the same setting.
  for (const side of ["buy", "sell"]) {
    const html = panel(row(), { side });
    assert.match(html, /<span>Slippage<\/span><label class="tslip">\s*<input id="tslip" type="text"[^>]*value="3\.0" aria-label="Slippage, percent"/);
    assert.doesNotMatch(html, /Quick buy|sidebar/);
  }
});
