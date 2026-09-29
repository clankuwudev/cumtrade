// What the visitor's wallet holds (public-release F3.4): one balanceOf
// through their own provider, cached per address and token, read once at a
// time, only on Robinhood Chain, and never shown for an address or chain that
// has since changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";
import { READ } from "../public/js/trade/constants.js";
import { createHoldings } from "../public/js/trade/holdings.js";
import { word } from "./support/calldata.js";

const ALICE = "0x00000000000000000000000000000000000A11cE";
const BOB = "0x000000000000000000000000000000000000B0b0";
const TOKEN = "0x00000000000000000000000000000000000070A1";
const OTHER = "0x00000000000000000000000000000000000070B2";

/** A wallet whose balanceOf answers from a table, and can be slowed or broken. */
function wallet() {
  const w = { chainId: 4663, balances: new Map(), calls: [], chainChecks: 0, gate: null, fail: false };
  w.provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") { w.chainChecks++; return toHex(w.chainId); }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0];
      assert.equal(data.slice(0, 10), READ.balanceOf);
      const owner = `0x${data.slice(-40)}`.toLowerCase();
      w.calls.push(`${owner}:${to.toLowerCase()}`);
      if (w.gate) await w.gate;
      if (w.fail) throw new Error("execution reverted");
      return `0x${word(w.balances.get(`${owner}:${to.toLowerCase()}`) ?? 0n)}`;
    },
  };
  return w;
}

function setup() {
  const w = wallet();
  const clock = { t: 1_000_000 };
  let changes = 0;
  const h = createHoldings({ provider: () => w.provider, onChange: () => changes++, now: () => clock.t });
  return { w, h, clock, changes: () => changes };
}

const slot = (a, t) => `${a.toLowerCase()}:${t.toLowerCase()}`;

test("a balance is read once, cached per address and token, and read again when stale", async () => {
  const { w, h, clock } = setup();
  w.balances.set(slot(ALICE, TOKEN), 5n * 10n ** 18n);
  assert.deepEqual(h.get(ALICE, TOKEN), { state: "unknown", balance: null });
  await h.ensure(ALICE, TOKEN);
  assert.deepEqual(h.get(ALICE, TOKEN), { state: "ok", balance: 5n * 10n ** 18n });
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 1, "fresh: not read again");
  assert.deepEqual(h.get(ALICE, OTHER), { state: "unknown", balance: null }, "another token is its own entry");
  assert.deepEqual(h.get(BOB, TOKEN), { state: "unknown", balance: null }, "another address is its own entry");
  clock.t += 29_999;
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 1);
  clock.t += 2;
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 2, "stale after 30s: read again");
});

test("refresh reads even when fresh, but never twice at once for the same key", async () => {
  const { w, h } = setup();
  let open;
  w.gate = new Promise((r) => { open = r; });
  const a = h.refresh(ALICE, TOKEN), b = h.refresh(ALICE, TOKEN), c = h.ensure(ALICE, TOKEN);
  assert.equal(h.get(ALICE, TOKEN).state, "loading");
  open();
  await Promise.all([a, b, c]);
  assert.equal(w.calls.length, 1);
  w.gate = null;
  await h.refresh(ALICE, TOKEN);
  assert.equal(w.calls.length, 2, "a fresh entry is read again on refresh (after a fill)");
});

test("while a balance is being read again, the last one known is still shown", async () => {
  const { w, h } = setup();
  w.balances.set(slot(ALICE, TOKEN), 7n);
  await h.refresh(ALICE, TOKEN);
  let open;
  w.gate = new Promise((r) => { open = r; });
  const p = h.refresh(ALICE, TOKEN);
  assert.deepEqual(h.get(ALICE, TOKEN), { state: "loading", balance: 7n });
  open();
  await p;
});

test("nothing is read off Robinhood Chain, and a redraw does not ask again at once", async () => {
  const { w, h, clock } = setup();
  w.chainId = 1;
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 0);
  assert.equal(h.get(ALICE, TOKEN).state, "unknown");
  await h.ensure(ALICE, TOKEN);
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 0, "no balance read");
  assert.equal(w.chainChecks, 1, "and the page redrawing does not ask the wallet again and again");
  w.chainId = 4663;
  clock.t += 30_001;
  await h.ensure(ALICE, TOKEN);
  assert.equal(w.calls.length, 1);
});

test("a failed read is an error, not a zero balance", async () => {
  const { w, h } = setup();
  w.fail = true;
  await h.ensure(ALICE, TOKEN);
  assert.deepEqual(h.get(ALICE, TOKEN), { state: "error", balance: null });
});

test("a read still out when the cache is cleared (the chain moved) is dropped", async () => {
  const { w, h } = setup();
  w.balances.set(slot(ALICE, TOKEN), 9n);
  let open;
  w.gate = new Promise((r) => { open = r; });
  const p = h.refresh(ALICE, TOKEN);
  h.clear();
  open();
  await p;
  assert.deepEqual(h.get(ALICE, TOKEN), { state: "unknown", balance: null });
});

test("a balance for one address is never shown for another", async () => {
  const { w, h } = setup();
  w.balances.set(slot(ALICE, TOKEN), 9n);
  await h.refresh(ALICE, TOKEN);
  assert.deepEqual(h.get(BOB, TOKEN), { state: "unknown", balance: null });
});

test("every change is announced, so the page can redraw", async () => {
  const { h, changes } = setup();
  await h.refresh(ALICE, TOKEN);
  assert.ok(changes() >= 2, "loading, then the result");
  const before = changes();
  h.clear();
  assert.equal(changes(), before + 1);
});

test("no provider, no read", async () => {
  let asked = 0;
  const h = createHoldings({ provider: () => { asked++; return null; } });
  await h.ensure(ALICE, TOKEN);
  assert.equal(asked, 1);
  assert.equal(h.get(ALICE, TOKEN).state, "unknown");
});
