// The console's wallets on the page (docs/specs/multi-wallet.md, M2): with main
// alone nothing changes, and with several the buy is split across the ticked
// wallets, positions say which wallet holds them, and a token held by several
// offers "Sell all wallets".
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";

const { el, reset } = stubDom();
const { S, rows } = await import("../public/js/core/store.js");
const { buyLabel, buyWallets, multi, splitNote, toggleTick, walletTicks } = await import("../public/js/wallets.js");
const { doBuy, tradeBar } = await import("../public/js/trade.js");
const { renderPositions } = await import("../public/js/pages/positions.js");
const { renderShell } = await import("../public/js/pages/shell.js");

const MAIN = "0x00000000000000000000000000000000000000a1";
const W2 = "0x00000000000000000000000000000000000000b2";
const W3 = "0x00000000000000000000000000000000000000c3";
const TOKEN = "0x00000000000000000000000000000000000070a1";
const ROW = { token: TOKEN, symbol: "TKN", status: "ready", graduated: false, sellable: true, band: "CLEAN" };

const wallet = (label, address, over = {}) => ({
  label, address, main: label === "main", unlocked: true, error: null,
  balanceEth: "0.1", ...over,
});
const base = {
  hasKeystore: true, unlocked: true, address: MAIN, keystoreAddress: MAIN, balanceEth: "0.1",
  arm: { manual: { armed: true }, auto: { armed: false }, hot: [] },
  budget: { spentEth: "0", budgetEth: "0.05", positions: 0, maxPositions: 3 },
};
const one = () => ({ ...base, wallets: [wallet("main", MAIN)], totalEth: "0.1" });
const three = () => ({
  ...base, wallets: [wallet("main", MAIN), wallet("w2", W2), wallet("w3", W3)], totalEth: "0.3",
});

// A position as /api/positions sends it. `walletLabel`/`wallet` are the fields
// this change adds; an old one has neither.
const position = (over = {}) => ({
  token: TOKEN, curve: "0x000000000000000000000000000000000000c0a1", symbol: "TKN", source: "manual",
  costEth: "10000000000000000", costEthNum: 0.01, tokens: "5000000000000000000000000", feeBps: 100,
  entryFeeWei: "100000000000000", snipeTaxWei: "0", realizedWei: "0", realizedCostWei: "0",
  realizedEntryFeeWei: "0", exitFeeWei: "0", soldTokens: "0", gasWei: "0", openedAt: 1_700_000_000_000,
  openTx: null, peakValueWei: "0", dryRun: false, nowEth: 0.0098, pnlPct: -2, priceMovePct: 0,
  feeDragPct: 2, breakevenMovePct: 2.03, progress: 0.1, sellablePct: 100, capped: false, peakPct: 0,
  exit: null, ...over,
});

function positionsMarkup(state, open) {
  reset();
  S.wallet = state;
  S.positions = { open, closed: [] };
  S.lastPositionsAt = 0;
  renderPositions();
  return el("#pgrid").markup;
}

test("with main alone the page draws no wallet controls", () => {
  S.wallet = one();
  assert.equal(multi(), false);
  assert.equal(walletTicks(), "");
  assert.equal(buyLabel(0.01), "Buy 0.01 Ξ");
  assert.equal(splitNote(), "");
  assert.doesNotMatch(tradeBar(ROW).s, /split|data-wtick/);
});

test("positions saved before wallets render exactly as they did", () => {
  // The same position, before (no wallet list, no wallet fields) and after
  // (main alone, and the fields /api/positions now adds).
  const before = positionsMarkup({ ...base }, [position()]);
  const after = positionsMarkup(one(), [position({ wallet: MAIN, walletLabel: "main" })]);
  assert.ok(before.length > 200);
  assert.equal(after, before);
});

test("several wallets: ticks for each, main alone ticked at first, and the buy says it is split", () => {
  S.wallet = three();
  assert.equal(multi(), true);
  const ticks = walletTicks().s;
  for (const l of ["main", "w2", "w3"]) assert.match(ticks, new RegExp(`data-wtick="${l}"`));
  assert.deepEqual(buyWallets(), ["main"]);
  toggleTick("w2");
  assert.deepEqual(buyWallets(), ["main", "w2"]);
  assert.equal(buyLabel(0.02), "Buy 0.02 Ξ across 2");
  assert.equal(splitNote(), "split evenly across main, w2");
  assert.match(tradeBar(ROW).s, /title="split evenly across main, w2"/);
  toggleTick("main");
  toggleTick("w2");
  assert.deepEqual(buyWallets(), ["w2"], "the last tick stays: a buy needs a wallet");
  // A locked wallet is not a buy's to use, ticked or not.
  S.wallet = { ...three(), wallets: [wallet("main", MAIN), wallet("w2", W2, { unlocked: false }), wallet("w3", W3)] };
  assert.deepEqual(buyWallets(), ["main"]);
  S.wallet = three();
  toggleTick("main");
});

test("a buy posts the ticked wallets, and main alone posts what it always did", async () => {
  rows.set(TOKEN, ROW);
  const bodies = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); throw new Error("stop here"); };
  const btn = { classList: { add() {}, remove() {} } };
  try {
    S.wallet = three();
    await assert.rejects(doBuy(TOKEN, btn, 0.02));
    S.wallet = one();
    await assert.rejects(doBuy(TOKEN, btn, 0.01));
  } finally { globalThis.fetch = saved; rows.delete(TOKEN); }
  assert.deepEqual(bodies[0].wallets, ["main", "w2"]);
  assert.equal(bodies[0].amountEth, "0.02", "the whole buy: the server splits it");
  assert.ok(!("wallets" in bodies[1]), "main alone sends no wallet list");
});

test("positions name their wallet, and a token held by several offers Sell all wallets", () => {
  const markup = positionsMarkup(three(), [
    position({ wallet: MAIN, walletLabel: "main" }),
    position({ wallet: W2, walletLabel: "w2" }),
    position({ token: "0x00000000000000000000000000000000000070b2", symbol: "SOLO", wallet: W3, walletLabel: "w3" }),
  ]);
  const cards = markup.split("<article").slice(1);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /<span class="pill n"[^>]*>main<\/span>/);
  assert.match(cards[1], /<span class="pill n"[^>]*>w2<\/span>/);
  for (const c of cards.slice(0, 2)) {
    assert.match(c, /data-sell="0x0+70a1" data-pct="100" data-wallet="all"/);
    assert.match(textOf(c), /Sell all wallets/);
  }
  assert.doesNotMatch(cards[2], /Sell all wallets/, "one wallet's token has nothing to sell across");
});

test("the chip counts the wallets and adds up what they hold", () => {
  reset();
  S.wallet = three();
  renderShell();
  assert.equal(el("#whoname").textContent, "3 wallets · 0.3000 Ξ");
  assert.equal(el("#whoaddr").textContent, "main 0x0000…00a1");
  reset();
  S.wallet = one();
  renderShell();
  assert.equal(el("#whoname").textContent, "0.1000 Ξ", "main alone reads as it did");
});
