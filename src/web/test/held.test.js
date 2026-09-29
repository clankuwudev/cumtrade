// What the connected address holds, from the server's ledger of it
// (public-release B3.5), and the sell buttons it puts on a hosted card. The
// ledger answer is shaped as /api/ledger answers (src/server/ledgerPayload.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";
import { heldFrom, heldInLedger, ledgerBasis, refreshHeldFromLedger, tradeBar, tradeBarSig } from "../public/js/trade.js";

const VISITOR = "0x00000000000000000000000000000000000A11cE";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const TOKEN = "0x00000000000000000000000000000000000070A1";
const conn = (over = {}) => ({
  info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" },
  address: VISITOR, chainId: 4663, balanceWei: 10n ** 16n, ...over,
});
const row = { token: TOKEN.toLowerCase(), symbol: "TKN", status: "ready", graduated: false, sellable: true, band: "CLEAN" };
const answer = (open) => ({ address: VISITOR, open, closed: [], totals: {} });
const position = (over = {}) => ({
  token: TOKEN, symbol: "TKN", tokens: "2500000000000000000000000", valued: true, nowEth: 0.0123,
  capped: false, sellablePct: 100, confidence: "exact", ...over,
});

/** Run `fn` as a hosted page, then put everything back. */
async function hosted(fn) {
  const saved = { mode: S.mode, conn: S.conn, held: S.heldFromLedger, fetch: globalThis.fetch };
  S.mode = "hosted";
  try { await fn(); } finally {
    S.mode = saved.mode; S.conn = saved.conn; S.heldFromLedger = saved.held; globalThis.fetch = saved.fetch;
  }
}
/** A server that answers /api/ledger with `body`, and remembers what was asked. */
function server(status, body, asked = []) {
  return async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

test("a ledger answer becomes what is held, by token, with nothing held left out", () => {
  const h = heldFrom(VISITOR, answer([position(), position({ token: OTHER, tokens: "0" }), position({ token: "0x" + "7".repeat(40), valued: false, sellablePct: 40 })]));
  assert.equal(h.address, VISITOR.toLowerCase());
  assert.equal(h.byToken.size, 2);
  assert.deepEqual(h.byToken.get(TOKEN.toLowerCase()), { tokens: "2500000000000000000000000", nowEth: 0.0123, capped: false });
  // Not valued: no value is shown rather than a zero. Partly sellable: capped.
  assert.deepEqual(h.byToken.get("0x" + "7".repeat(40)), { tokens: "2500000000000000000000000", nowEth: null, capped: true });
});

test("the token page's Your position reads what each cost and its P&L, only for the address that trades", () => hosted(async () => {
  // U4: the token page shows cost and P&L from the ledger the page already read.
  const h = heldFrom(VISITOR, answer([
    position({ costEthNum: 0.01, pnlPct: 23 }),
    position({ token: "0x" + "7".repeat(40), costEthNum: 0.02, pnlPct: 5, valued: false }),
  ]));
  assert.deepEqual(h.basis.get(TOKEN.toLowerCase()), { costEth: 0.01, pnlPct: 23 });
  assert.deepEqual(h.basis.get("0x" + "7".repeat(40)), { costEth: 0.02, pnlPct: null }, "not valued: no P&L");
  S.heldFromLedger = h;
  S.conn = conn();
  assert.deepEqual(ledgerBasis(TOKEN), { costEth: 0.01, pnlPct: 23 });
  S.conn = conn({ address: OTHER });
  assert.equal(ledgerBasis(TOKEN), null, "another address's ledger says nothing about this one");
}));

test("the connected address's lookup fills heldFromLedger and repaints", () => hosted(async () => {
  S.conn = conn();
  const asked = [];
  globalThis.fetch = server(200, answer([position()]), asked);
  let painted = 0;
  await refreshHeldFromLedger(() => { painted++; });
  assert.equal(asked.length, 1);
  assert.equal(asked[0], `/api/ledger?address=${VISITOR}`);
  assert.equal(painted, 1);
  assert.equal(heldInLedger(TOKEN).tokens, "2500000000000000000000000");
}));

test("nothing is asked without a connection on Robinhood Chain, and what was known goes", () => hosted(async () => {
  for (const c of [null, conn({ chainId: 1 })]) {
    S.conn = c;
    S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
    const asked = [];
    globalThis.fetch = server(200, answer([position()]), asked);
    await refreshHeldFromLedger(() => {});
    assert.equal(asked.length, 0);
    assert.equal(S.heldFromLedger, null);
  }
}));

test("an answer that lands after the account changed is dropped", () => hosted(async () => {
  S.conn = conn();
  S.heldFromLedger = null;
  globalThis.fetch = async () => {
    S.conn = conn({ address: OTHER }); // the visitor switched accounts meanwhile
    return new Response(JSON.stringify(answer([position()])), { status: 200 });
  };
  await refreshHeldFromLedger(() => assert.fail("must not repaint"));
  assert.equal(S.heldFromLedger, null);
}));

test("a refusal or an error leaves what was known", () => hosted(async () => {
  S.conn = conn();
  const known = heldFrom(VISITOR, answer([position()]));
  for (const status of [429, 503, 400, 502]) {
    S.heldFromLedger = known;
    globalThis.fetch = server(status, { error: "no" });
    await refreshHeldFromLedger(() => assert.fail("must not repaint"));
    assert.equal(S.heldFromLedger, known);
  }
}));

test("heldInLedger answers only for the address it was read for", () => hosted(async () => {
  S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
  S.conn = conn();
  assert.ok(heldInLedger(TOKEN));
  assert.equal(heldInLedger(OTHER), null);
  S.conn = conn({ address: OTHER });
  assert.equal(heldInLedger(TOKEN), null);
}));

test("a hosted card shows what is held and its sell buttons", () => hosted(async () => {
  S.conn = conn();
  S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
  const bar = tradeBar(row).s;
  assert.match(bar, /data-sell="0x00000000000000000000000000000000000070a1" data-pct="50"/);
  assert.match(bar, /data-sell="0x00000000000000000000000000000000000070a1" data-pct="100"/);
  assert.match(bar, /2\.50M/);
  assert.match(bar, /≈ 0\.0123/);
  assert.doesNotMatch(bar, /data-sell[^>]*disabled/);
}));

test("its sell buttons say why they cannot be used, in the visitor's order", () => hosted(async () => {
  S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
  S.conn = conn({ balanceWei: 0n });
  const bar = tradeBar(row).s;
  assert.match(bar, /data-pct="50" disabled title="Fund 0x0000…11cE for gas"/);
}));

test("no card sell without a ledger entry for the connected address", () => hosted(async () => {
  S.conn = conn();
  S.heldFromLedger = null;
  assert.doesNotMatch(tradeBar(row).s, /data-sell/);
  S.heldFromLedger = heldFrom(OTHER, answer([position()]));
  assert.doesNotMatch(tradeBar(row).s, /data-sell/);
}));

test("what the ledger says changes the card's signature, so the card repaints", () => hosted(async () => {
  S.conn = conn();
  S.heldFromLedger = null;
  const before = JSON.stringify(tradeBarSig(row));
  S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
  const held = JSON.stringify(tradeBarSig(row));
  S.heldFromLedger = heldFrom(VISITOR, answer([position({ nowEth: 0.02 })]));
  const revalued = JSON.stringify(tradeBarSig(row));
  assert.notEqual(before, held);
  assert.notEqual(held, revalued);
}));

test("a self card is untouched: no ledger, and the same signature as before", () => {
  S.mode = "self";
  S.heldFromLedger = heldFrom(VISITOR, answer([position()]));
  try {
    assert.equal(heldInLedger(TOKEN), null);
    assert.equal(tradeBarSig(row).length, 3);
  } finally { S.heldFromLedger = null; }
});
