// Why a Buy button is disabled. Every Buy control asks buyBlocked(), and a
// bonded token is bought on V4 like any other now, so the only reasons left
// are the wallet's, and they come in a fixed order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S, checked, rows } from "../public/js/core/store.js";
import {
  BACK_UP_FIRST, IN_FLIGHT, REVIEW_KEY, asksPerson, buyAmountBlocked, buyBlocked, doBuy, doSell, ensureHolding, heldInLedger, holdingOf,
  approvingAhead, loadPrefs, progressOf, refreshHeldFromLedger, refreshTraderBalance, renderQuickBuy, sellBlocked, setReview, trader,
  traderProvider, tradeBar, tradeInProgress, tradeProgress,
} from "../public/js/trade.js";
import { backup } from "../public/js/wallet/backup.js";
import { session } from "../public/js/wallet/session.js";
import { recall } from "./support/calldata.js";
import { fixture, fixtureWallet } from "./support/fixtureWallet.js";
import { stubDom, textOf } from "./support/stubdom.js";

const ready = {
  hasKeystore: true, unlocked: true, balanceEth: "0.03", address: "0x0000000000000000000000000000000000c1a4e5",
  arm: { manual: { armed: true }, auto: { armed: false } },
};

test("a wallet that can trade is not blocked", () => {
  S.wallet = ready;
  assert.equal(buyBlocked(), null);
});

// A hosted page trades from the visitor's own wallet, never the server's.
const VISITOR = "0x00000000000000000000000000000000000A11cE";
const conn = (over = {}) => ({
  info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" },
  address: VISITOR, chainId: 4663, balanceWei: 10n ** 16n, ...over,
});
const hosted = (fn) => { S.mode = "hosted"; try { fn(); } finally { S.mode = "self"; S.conn = null; } };

test("a hosted page's reasons come in the order the visitor would fix them", () => hosted(() => {
  // The server's wallet is irrelevant here, even when it could trade.
  S.wallet = ready;
  S.conn = null;
  assert.equal(buyBlocked(), "Connect a wallet");
  S.conn = conn({ chainId: 1 });
  assert.equal(buyBlocked(), "Switch to Robinhood Chain");
  S.conn = conn({ balanceWei: null });
  assert.equal(buyBlocked(), "Checking your balance");
  S.conn = conn({ balanceWei: 0n });
  assert.equal(buyBlocked(), "Fund 0x0000…11cE to trade");
}));

test("a hosted buy is open once the wallet is connected, on the chain and funded", () => hosted(() => {
  S.conn = conn();
  assert.equal(buyBlocked(), null);
}));

test("a hosted card draws its trade bar, with Buy disabled and the reason as its title", () => hosted(() => {
  const row = { token: "0x00000000000000000000000000000000000070a1", status: "ready", graduated: false,
    sellable: true, band: "CLEAN" };
  S.conn = null;
  const bar = tradeBar(row).s;
  assert.match(bar, /data-buy="0x00000000000000000000000000000000000070a1"/);
  assert.match(bar, /disabled/);
  assert.match(bar, /title="Connect a wallet"/);
  // Without a server wallet, nothing is held, so no sell controls.
  assert.doesNotMatch(bar, /data-sell/);
}));

// The token page's sell side (F3.4): what the wallet holds, read through it.
const ROW = { token: "0x00000000000000000000000000000000000070a1", symbol: "TKN", status: "ready" };
const holding = (state, balance) => ({ state, balance });

test("a hosted sell's reasons come in the order the visitor would fix them", () => hosted(() => {
  const ok = holding("ok", 5n * 10n ** 18n);
  S.conn = null;
  assert.equal(sellBlocked(ROW, ok), "Connect a wallet");
  S.conn = conn({ chainId: 1 });
  assert.equal(sellBlocked(ROW, ok), "Switch to Robinhood Chain");
  S.conn = conn({ balanceWei: null });
  assert.equal(sellBlocked(ROW, ok), "Checking your balance");
  S.conn = conn({ balanceWei: 0n });
  assert.equal(sellBlocked(ROW, ok), "Fund 0x0000…11cE for gas", "a sell still pays gas");
  S.conn = conn();
  assert.equal(sellBlocked(ROW, holding("unknown", null)), "Reading your TKN balance");
  assert.equal(sellBlocked(ROW, holding("loading", null)), "Reading your TKN balance");
  assert.equal(sellBlocked(ROW, holding("error", null)), "Could not read your TKN balance");
  assert.equal(sellBlocked(ROW, holding("ok", 0n)), "You hold no TKN");
  assert.equal(sellBlocked(ROW, ok), null);
  assert.equal(sellBlocked(ROW, holding("loading", 5n)), null, "a re-read keeps the last balance usable");
  assert.equal(sellBlocked({ ...ROW, symbol: "" }, holding("ok", 0n)), "You hold no 0x0000…70a1");
}));

test("a typed buy amount must be an exact positive amount of ETH, within the wallet's balance", () => hosted(() => {
  S.conn = conn({ balanceWei: 10n ** 16n });
  for (const bad of ["", "abc", "0", "0.0", "-1", "1e-3", "0.0000000000000000001", "1,5", ".5", "1."]) {
    assert.equal(buyAmountBlocked(bad), "Enter an amount of ETH", JSON.stringify(bad));
  }
  assert.equal(buyAmountBlocked("0.01"), null, "exactly the balance");
  assert.equal(buyAmountBlocked("0.010000000000000001"), "More than this wallet holds");
  assert.equal(buyAmountBlocked("0.0000001"), null);
  S.conn = conn({ balanceWei: null });
  assert.equal(buyAmountBlocked("5"), null, "an unknown balance is not a reason; buyBlocked says it is still checking");
}));

// -------------------------------------------------- the trading wallet --
// On an origin with a trading wallet (public-release W1.2), only it trades.
// The visitor's own wallet, connected or not, on any chain, changes nothing.

const TRADING = "0x0000000000000000000000000000000000006006";
const tw = (over = {}) => ({ address: TRADING, method: "google", balanceWei: 10n ** 16n, ...over });
// The tests below are about the reasons after the backup (W4), so this
// wallet's key is confirmed as saved, for this run only (there is no storage).
backup.confirm(TRADING);
/** A made-up trading wallet whose key this browser has no backup confirmation for. */
const UNSAVED = "0x000000000000000000000000000000000000Ba5e";

const withTradingWallet = (fn) => hosted(() => {
  S.login = { ...S.login, here: true };
  try { return fn(); } finally { S.login = { ...S.login, here: false }; S.trading = null; }
});

test("with a trading wallet, no backup confirmation blocks buys and sells, right after logging in", () => withTradingWallet(() => {
  const ok = holding("ok", 5n * 10n ** 18n);
  const row = { token: "0x00000000000000000000000000000000000070a1", status: "ready", graduated: false, sellable: true, band: "CLEAN" };
  S.conn = conn();
  S.trading = null;
  assert.equal(buyBlocked(), "Log in to trade", "logging in comes first");
  assert.equal(sellBlocked(ROW, ok), "Log in to trade");
  for (const balanceWei of [null, 0n, 10n ** 16n]) {
    S.trading = tw({ address: UNSAVED, balanceWei });
    assert.equal(buyBlocked(), BACK_UP_FIRST, `before the balance is read or funded (${balanceWei})`);
    assert.equal(sellBlocked(ROW, ok), BACK_UP_FIRST);
  }
  assert.equal(BACK_UP_FIRST, "Back up your key first");
  assert.match(tradeBar(row).s, /title="Back up your key first"/, "the card says it");
  // Another address's confirmation is not this one's.
  S.trading = tw({ address: UNSAVED });
  assert.equal(backup.confirmed(TRADING), true);
  assert.equal(buyBlocked(), BACK_UP_FIRST);
  backup.confirm(UNSAVED.toLowerCase());
  assert.equal(buyBlocked(), null, "confirmed, in any case of the address");
  assert.equal(sellBlocked(ROW, ok), null);
}));

test("with a trading wallet, a buy's reasons come in the order the visitor would fix them, and the chain reason is gone", () => withTradingWallet(() => {
  S.conn = conn({ chainId: 1, balanceWei: 0n });
  S.trading = null;
  assert.equal(buyBlocked(), "Log in to trade");
  S.trading = tw({ balanceWei: null });
  assert.equal(buyBlocked(), "Checking your balance");
  S.trading = tw({ balanceWei: 0n });
  assert.equal(buyBlocked(), "Fund your trading wallet");
  S.trading = tw();
  assert.equal(buyBlocked(), null, "the main wallet on another chain, and empty, is not a reason");
  S.conn = null;
  assert.equal(buyBlocked(), null, "nor is no main wallet at all");
}));

test("with a trading wallet, a sell's reasons come in order, and a sell pays gas from it", () => withTradingWallet(() => {
  const ok = holding("ok", 5n * 10n ** 18n);
  S.conn = conn();
  S.trading = null;
  assert.equal(sellBlocked(ROW, ok), "Log in to trade", "a funded main wallet does not trade");
  S.trading = tw({ balanceWei: null });
  assert.equal(sellBlocked(ROW, ok), "Checking your balance");
  S.trading = tw({ balanceWei: 0n });
  assert.equal(sellBlocked(ROW, ok), "Fund your trading wallet for gas");
  S.trading = tw();
  assert.equal(sellBlocked(ROW, holding("unknown", null)), "Reading your TKN balance");
  assert.equal(sellBlocked(ROW, holding("error", null)), "Could not read your TKN balance");
  assert.equal(sellBlocked(ROW, holding("ok", 0n)), "You hold no TKN");
  assert.equal(sellBlocked(ROW, ok), null);
}));

test("with a trading wallet, the trading address trades and its balance bounds a typed buy", () => withTradingWallet(() => {
  S.conn = conn({ balanceWei: 10n ** 20n });
  S.trading = tw({ balanceWei: 10n ** 16n });
  assert.deepEqual(trader(), { address: TRADING, chainId: 4663, balanceWei: 10n ** 16n });
  assert.equal(buyAmountBlocked("0.01"), null);
  assert.equal(buyAmountBlocked("0.02"), "More than this wallet holds", "the main wallet's balance does not count");
  S.trading = null;
  assert.equal(trader(), null, "logged out, nothing trades, whatever is connected");
}));

test("without a trading wallet on this origin, a hosted page trades from the visitor's own wallet as before", () => hosted(() => {
  assert.equal(S.login.here, false);
  S.trading = tw();
  S.conn = null;
  assert.equal(buyBlocked(), "Connect a wallet", "a trading session is ignored where there is no trading wallet");
  S.conn = conn();
  assert.deepEqual(trader(), S.conn);
  S.trading = null;
}));

test("with a trading wallet, a card says Log in to trade", () => withTradingWallet(() => {
  const row = { token: "0x00000000000000000000000000000000000070a1", status: "ready", graduated: false, sellable: true, band: "CLEAN" };
  S.trading = null;
  assert.match(tradeBar(row).s, /title="Log in to trade"/);
  S.trading = tw();
  assert.doesNotMatch(tradeBar(row).s, /disabled/);
}));

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/**
 * A hosted page with a trading wallet, logged in, ready to start a trade: just
 * enough page for the plan sheet, the trading acknowledgement given at login,
 * and a prepare call that waits for `answer`. `done()` puts everything back.
 */
function tradingPage() {
  const dom = stubDom();
  const make = document.createElement;
  document.createElement = () => Object.assign(make(), { querySelectorAll: () => [] });
  Object.assign(document, { body: { appendChild() {} } });
  const store = new Map([["clank.ack.tw", "1"]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const page = { asked: [], answer: null };
  globalThis.fetch = (url, init) => {
    page.asked.push([url, JSON.parse(init.body)]);
    return new Promise((r) => { page.answer = r; });
  };
  rows.set(ROW.token, { ...ROW, sellable: true, band: "CLEAN", graduated: false });
  S.mode = "hosted";
  S.login = { ...S.login, here: true };
  S.trading = tw();
  const saved = { provider: session.provider, tradeRunning: session.tradeRunning };
  page.done = () => {
    dom.reset();
    rows.delete(ROW.token);
    Object.assign(session, saved);
    S.mode = "self";
    S.login = { ...S.login, here: false };
    S.trading = null;
    S.conn = null;
  };
  return page;
}

test("with a trading wallet, a trade in flight is the last reason, after logging in, funding and the token's own", async () => {
  const page = tradingPage();
  const running = [];
  session.tradeRunning = (on) => { running.push(on); };
  try {
    const run = doBuy(ROW.token, null, null, "0.001");
    await settle();
    assert.deepEqual(page.asked.map(([url, body]) => [url, body.from]), [["/api/prepare/buy", TRADING]], "from the trading address");
    assert.deepEqual(running, [true], "preparing holds off the idle lock");
    assert.equal(buyBlocked(), "A trade is already in progress");
    S.trading = tw({ balanceWei: 0n });
    assert.equal(buyBlocked(), "Fund your trading wallet");
    S.trading = null;
    assert.equal(buyBlocked(), "Log in to trade");
    S.trading = tw();
    assert.equal(sellBlocked(ROW, holding("ok", 0n)), "You hold no TKN");
    assert.equal(sellBlocked(ROW, holding("ok", 5n)), "A trade is already in progress");
    page.answer({ status: 503, json: async () => ({ error: "not now" }) });
    await run;
    assert.equal(buyBlocked(), null, "once it has ended");
    assert.deepEqual(running, [true, false], "and it lets the lock go when it ends");
  } finally {
    page.done();
  }
});

test("hosted: a token a check left off the board still prepares a buy (B5.1b)", async () => {
  const page = tradingPage();
  session.tradeRunning = () => {};
  // Off the board: the page trades it from the check's row.
  const row = rows.get(ROW.token);
  rows.delete(ROW.token);
  checked.set(ROW.token, { ...row, fromCheck: Date.now() });
  try {
    const run = doBuy(ROW.token, null, null, "0.001");
    await settle();
    assert.deepEqual(page.asked.map(([url, body]) => [url, body.token]), [["/api/prepare/buy", ROW.token]]);
    page.answer({ status: 503, json: async () => ({ error: "not now" }) });
    await run;
  } finally {
    checked.delete(ROW.token);
    page.done();
  }
});

test("with a trading wallet, a sell reads the balance through it and trades from its address, never the main wallet's", async () => {
  const page = tradingPage();
  const HELD = 5n * 10n ** 18n;
  const reads = [];
  session.provider = () => ({
    async request({ method, params }) {
      const data = method === "eth_call" ? params[0].data : "";
      reads.push(data.startsWith("0x70a08231") ? `balanceOf:0x${data.slice(-40)}` : method === "eth_call" ? `call:${data.slice(0, 10)}` : method);
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_call") return `0x${HELD.toString(16).padStart(64, "0")}`;
      throw Object.assign(new Error("not here"), { code: 4200 });
    },
  });
  session.tradeRunning = () => {};
  S.conn = conn();
  try {
    // A sell of a token not read yet reads it first, for the trading address.
    assert.equal(holdingOf(ROW.token).state, "unknown");
    const run = doSell(ROW.token, "100", null);
    await settle();
    assert.deepEqual(page.asked.map(([url, body]) => [url, body.from, body.tokens]), [["/api/prepare/sell", TRADING, HELD.toString()]]);
    page.answer({ status: 503, json: async () => ({}) });
    await run;
    // And the token page's read, for another token.
    const OTHER = "0x00000000000000000000000000000000000070a2";
    ensureHolding(OTHER);
    await settle();
    const h = holdingOf(OTHER);
    assert.deepEqual([h.state, h.balance], ["ok", HELD], "read for the trading address");
    assert.ok(reads.filter((r) => r.startsWith("balanceOf:")).length >= 3);
    assert.ok(reads.filter((r) => r.startsWith("balanceOf:")).every((r) => r === `balanceOf:${TRADING.toLowerCase()}`), reads.join(" "));
    // The visit also looks, through the same wallet, at whether its sell is
    // approved ahead (W3.2): the token's identity first, which this facade
    // cannot answer, so nothing more is read or sent.
    assert.deepEqual(reads.slice(reads.lastIndexOf(`balanceOf:${TRADING.toLowerCase()}`) + 1), ["eth_chainId", "eth_getBlockByNumber", "call:0x7165485d"]);
    assert.ok(!reads.includes("eth_sendTransaction"));
    assert.ok(!reads.some((r) => r.includes(VISITOR.slice(2).toLowerCase())));
  } finally {
    page.done();
  }
});

test("the idle lock waits for a trade that is working, and not for one waiting on the person", () => {
  assert.deepEqual([...IN_FLIGHT].sort(), ["pending", "preparing", "running", "signing"]);
  for (const waiting of ["confirming", "paused", "rejected", "error", "done", "failed", "cancelled", "void", "refused"]) {
    assert.ok(!IN_FLIGHT.has(waiting), waiting);
  }
});

test("the wallet that trades: the trading wallet's provider where there is one, the visitor's own elsewhere, and never on a self page", () => {
  const fake = { request: async () => null };
  const saved = session.provider;
  session.provider = () => fake;
  try {
    hosted(() => {
      assert.equal(traderProvider(), null, "F2's, with nothing connected");
      S.login = { ...S.login, here: true };
      try { assert.equal(traderProvider(), fake); } finally { S.login = { ...S.login, here: false }; }
    });
    S.login = { ...S.login, here: true };
    try {
      assert.notEqual(traderProvider(), fake, "a self page trades through its own server");
    } finally { S.login = { ...S.login, here: false }; }
  } finally {
    session.provider = saved;
  }
});

test("after a fill, the balance read again is the trading wallet's where there is one", async () => {
  const saved = session.refreshBalance;
  let n = 0;
  session.refreshBalance = async () => { n++; };
  S.mode = "hosted";
  try {
    S.login = { ...S.login, here: true };
    await refreshTraderBalance();
    assert.equal(n, 1);
    S.login = { ...S.login, here: false };
    await refreshTraderBalance();
    assert.equal(n, 1, "F2's own read instead");
  } finally {
    session.refreshBalance = saved;
    S.mode = "self";
  }
});

test("with a trading wallet, the ledger is asked about the trading address, and its answer is kept for it alone", async () => {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    return { status: 200, json: async () => ({ open: [{ token: ROW.token, tokens: "5", valued: false, sellablePct: 100 }] }) };
  };
  S.mode = "hosted";
  S.login = { ...S.login, here: true };
  S.conn = conn();
  S.trading = tw();
  try {
    await refreshHeldFromLedger(() => {});
    assert.deepEqual(asked, [`/api/ledger?address=${encodeURIComponent(TRADING)}`], "not the main wallet's");
    assert.equal(heldInLedger(ROW.token).tokens, "5");
    S.trading = null;
    assert.equal(heldInLedger(ROW.token), null, "logged out, nothing shows as held");
    await refreshHeldFromLedger(() => {});
    assert.equal(asked.length, 1, "and nothing is asked");
    assert.equal(S.heldFromLedger, null);
  } finally {
    S.mode = "self";
    S.login = { ...S.login, here: false };
    S.trading = null;
    S.conn = null;
    S.heldFromLedger = null;
  }
});

test("each wallet reason blocks, in order", () => {
  S.wallet = { ...ready, hasKeystore: false, unlocked: false };
  assert.match(buyBlocked(), /No keystore/);
  S.wallet = { ...ready, unlocked: false };
  assert.match(buyBlocked(), /locked/);
  S.wallet = { ...ready, arm: { manual: { armed: false }, auto: { armed: false } } };
  assert.match(buyBlocked(), /safe mode/);
  S.wallet = { ...ready, balanceEth: "0" };
  assert.match(buyBlocked(), /^Fund /);
});

// ====================================================================== //
// one click (public-release W3.1)                                        //
// ====================================================================== //
// The trading wallet signs with no pop-up, so a click trades, and the plan
// sheet opens only when the person must decide (TW5). These run real trades
// through trade.js's own wiring: the real sequence, verifier and page quote,
// with the fixture chain's scripted wallet as the trading wallet.

const WARNINGS = ["sell-sim-failed", "band-avoid", "price-impact", "capped", "near-graduation", "snipe-tax", "venue-changed"];

test("only a plan with no warnings goes ahead by itself, and only in one click", () => {
  const plan = (warnings) => ({ kind: "plan", plan: { warnings } });
  assert.equal(asksPerson(plan([]), true), false);
  for (const code of WARNINGS) assert.equal(asksPerson(plan([{ code, text: code }]), true), true, code);
  assert.equal(asksPerson(plan(undefined), true), true, "no list of warnings is not an empty one");
  assert.equal(asksPerson({ kind: "plan", plan: null }, true), true);
  for (const kind of ["capped", "priceMoved", "transfer", "anything"]) assert.equal(asksPerson({ kind, plan: { warnings: [] } }, true), true, kind);
  assert.equal(asksPerson(null, true), true);
  // A browser wallet, or "Review each trade": every question asks.
  assert.equal(asksPerson(plan([]), false), true);
});

test("a one-click trade's progress reads Preparing, Checking, Signing, Sent and Still pending, with the sent step's link", () => {
  const step = (status, hash = null) => ({ status, hash });
  assert.deepEqual(progressOf({ phase: "preparing", steps: [] }), { label: "Preparing…", hash: null });
  assert.deepEqual(progressOf({ phase: "confirming", steps: [step("waiting")] }), { label: "Preparing…", hash: null });
  assert.deepEqual(progressOf({ phase: "running", steps: [step("waiting")] }), { label: "Checking…", hash: null });
  assert.deepEqual(progressOf({ phase: "signing", steps: [step("signing")] }), { label: "Signing…", hash: null });
  assert.deepEqual(progressOf({ phase: "running", steps: [step("pending", "0xabc")] }), { label: "Sent", hash: "0xabc" });
  assert.deepEqual(progressOf({ phase: "pending", steps: [step("pending", "0xabc")] }), { label: "Still pending", hash: "0xabc" });
  // Several steps are counted.
  assert.deepEqual(progressOf({ phase: "signing", steps: [step("mined", "0x1"), step("signing"), step("waiting")] }),
    { label: "Signing… · step 2 of 3", hash: null });
  assert.deepEqual(progressOf({ phase: "running", steps: [step("skipped"), step("pending", "0x2")] }),
    { label: "Sent · step 2 of 2", hash: "0x2" });
  for (const phase of ["done", "failed", "refused", "void", "reverted", "timeout", "cancelled", "error", "rejected", "paused"]) {
    assert.equal(progressOf({ phase, steps: [] }), null, phase);
  }
});

const settleUntil = async (cond, what) => {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`never: ${what}`);
};

/**
 * A hosted page with a trading wallet, logged in as the fixture's own address,
 * whose provider is the fixture chain's scripted wallet. /api/prepare answers
 * with `page.plans` in turn. Everything appended to the page is kept: the plan
 * sheet goes to the body, toasts to #toasts. The sheet's buttons can be
 * pressed. Timers are held, never run. `done()` puts everything back.
 *
 * @param {string} name a fixture
 */
function oneClickPage(name) {
  const fx = fixture(name);
  const dom = stubDom();
  const page = { fx, added: [], prepared: [], plans: [fx.plan], timers: [], buttons: {}, answers: [] };
  for (const k of ["yes", "no", "resume", "cancel", "close", "switch"]) page.buttons[k] = { dataset: { sheet: k } };
  const make = document.createElement;
  document.createElement = () => Object.assign(make(), {
    querySelectorAll: (sel) => (sel === "[data-sheet]" ? Object.values(page.buttons) : []),
    remove() { this.isConnected = false; this.removed = true; },
  });
  Object.assign(document, { body: { appendChild: (el) => { el.isConnected = true; page.added.push(el); return el; } } });
  const store = new Map([["clank.ack.tw", "1"]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  page.store = store;
  page.w = fixtureWallet({ from: fx.intent.from, now: fx.plan.preparedAt });
  // The sell path already approved for all it holds, so the approval ahead a
  // buy starts (W3.2) is covered and sends nothing. The W3.2 tests clear it.
  page.w.erc20 = page.w.balance;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("/api/prepare/")) {
      page.prepared.push(JSON.parse(init.body));
      const plan = page.plans[Math.min(page.prepared.length - 1, page.plans.length - 1)];
      if (typeof plan === "number") return { status: plan, json: async () => ({ error: "The server is not here." }) };
      return { status: 200, json: async () => structuredClone(plan) };
    }
    return { status: 404, json: async () => ({}) };
  };
  const timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.setTimeout = (fn, ms) => page.timers.push({ fn, ms });
  globalThis.clearTimeout = () => {};
  page.row = { token: fx.intent.token, symbol: "TKN", status: "ready", sellable: true, band: "CLEAN", graduated: fx.plan.venue === "v4",
    v4: fx.plan.venue === "v4" ? { lpFee: 10_000 } : null };
  rows.set(fx.intent.token.toLowerCase(), page.row);
  dom.el("#qslip").value = String(fx.intent.slippageBps / 100);
  S.mode = "hosted";
  S.login = { ...S.login, here: true };
  S.trading = { address: fx.intent.from, method: "google", balanceWei: 10n ** 18n };
  S.reviewTrades = false;
  // One click comes after the backup (W4), as it does on a real page.
  backup.confirm(fx.intent.from);
  const saved = { provider: session.provider, tradeRunning: session.tradeRunning, refreshBalance: session.refreshBalance };
  session.provider = () => page.w.provider;
  session.tradeRunning = () => {};
  session.refreshBalance = async () => {};
  /** The plan sheets opened: modals added to the body. */
  page.sheets = () => page.added.filter((el) => el.className === "modal");
  page.toasts = () => dom.el("#toasts").appended;
  page.press = (k) => page.buttons[k].onclick();
  /** A buy, and then the approval ahead it starts, if any, to its end. */
  page.buy = async () => {
    const out = await doBuy(fx.intent.token, null, null, "0.01");
    await page.ahead();
    return out;
  };
  page.ahead = async () => { const a = approvingAhead(); if (a) await a; };
  page.done = () => {
    for (const undo of page.cleanups ?? []) undo();
    Object.assign(globalThis, timers);
    Object.assign(session, saved);
    rows.delete(fx.intent.token.toLowerCase());
    dom.reset();
    S.mode = "self";
    S.login = { ...S.login, here: false };
    S.trading = null;
    S.reviewTrades = false;
  };
  return page;
}

/** A fixture plan with one warning. */
const warned = (plan, code) => ({ ...structuredClone(plan), warnings: [{ code, text: `A ${code} warning.` }] });

test("one click: a plan with no warnings trades with no sheet, and its progress shows on its card and in one toast", async () => {
  const page = oneClickPage("curve buy");
  try {
    // What the card and the toast said at the send and at the receipt.
    const seen = [];
    const inner = page.w.provider.request;
    page.w.provider = {
      request: async (args) => {
        if (args.method === "eth_sendTransaction" || args.method === "eth_getTransactionReceipt") {
          const box = page.toasts()[0];
          seen.push([args.method, tradeProgress(page.row.token)?.label, box && textOf(box.markup)]);
        }
        return inner(args);
      },
    };
    const out = await page.buy();
    assert.equal(out.phase, "done", out.message);
    assert.deepEqual(page.sheets(), [], "no plan sheet");
    assert.equal(page.w.sends.length, 1);
    const s = page.fx.plan.steps[0];
    assert.deepEqual(page.w.sends[0], { from: page.fx.intent.from, to: s.to, data: s.data, value: s.value, gas: s.gas });
    assert.deepEqual(seen.map(([m, bar]) => [m, bar]), [["eth_sendTransaction", "Signing…"], ["eth_getTransactionReceipt", "Sent"]]);
    assert.match(seen[0][2], /^Buy TKN Signing…$/);
    assert.match(seen[1][2], /^Buy TKN Sent 0x0000000000000000… ↗$/, "the sent transaction's link");
    // One toast, ended with the fill and its link.
    assert.equal(page.toasts().length, 1);
    const box = page.toasts()[0];
    assert.equal(box.className, "toast ok");
    assert.match(textOf(box.markup), /^Bought TKN at least .* TKN 0x0000000000000000… ↗$/);
    assert.match(box.markup, /href="[^"]*\/tx\/0x0{63}1"/);
    // The card says Done, with the link, for a moment.
    assert.deepEqual(tradeProgress(page.row.token), { token: page.row.token.toLowerCase(), label: "Done", hash: `0x${"0".repeat(63)}1`, ok: true });
    const bar = tradeBar(page.row).s;
    assert.match(bar, /<span class="tprog ok">Done/);
    assert.match(bar, /href="[^"]*\/tx\/0x0{63}1"/);
    assert.ok(!tradeInProgress());
    const done = page.timers.find((t) => t.ms === 6_000 && String(t.fn).includes("setBar"));
    assert.ok(done, "Done goes after 6 s");
    done.fn();
    assert.equal(tradeProgress(page.row.token), null);
    assert.doesNotMatch(tradeBar(page.row).s, /tprog/);
  } finally {
    page.done();
  }
});

test("one click: each warning kind opens the sheet before anything is sent, and the person decides", async () => {
  for (const code of WARNINGS) {
    const page = oneClickPage("curve buy");
    try {
      page.plans = [warned(page.fx.plan, code)];
      const run = page.buy();
      await settleUntil(() => page.sheets().length > 0, `the sheet for ${code}`);
      assert.equal(page.sheets().length, 1, code);
      const sheet = page.sheets()[0];
      assert.match(textOf(sheet.markup), new RegExp(`A ${code} warning\\.`), code);
      assert.match(textOf(sheet.markup), /Confirm signs them all with your trading wallet, with no pop-up\./);
      assert.doesNotMatch(textOf(sheet.markup), /Your wallet will ask you/);
      assert.equal(page.w.sends.length, 0, `${code}: nothing is sent before the person answers`);
      assert.ok(page.toasts().every((t) => t.removed), `${code}: the progress toast gives way to the sheet`);
      if (code === "price-impact") {
        page.press("yes");
        const out = await run;
        assert.equal(out.phase, "done", out.message);
        assert.equal(page.w.sends.length, 1);
        assert.equal(page.sheets().length, 1, "the same sheet shows the rest of the trade");
        assert.match(textOf(sheet.markup), /Done\./);
      } else {
        page.press("no");
        const out = await run;
        assert.equal(out.phase, "cancelled", code);
        assert.equal(page.w.sends.length, 0, code);
      }
    } finally {
      page.done();
    }
  }
});

test("one click: a capped sell opens the sheet with the curve's offer, and the new plan then trades", async () => {
  const page = oneClickPage("curve sell with approval");
  try {
    const tokens = BigInt(page.fx.intent.tokens);
    page.w.balance = tokens * 3n;
    page.w.erc20 = 0n;
    page.plans = [{ ...structuredClone(page.fx.plan), warnings: [{ code: "capped", text: "capped" }] }, page.fx.plan];
    const run = doSell(page.fx.intent.token, "100", null);
    await settleUntil(() => page.sheets().length > 0, "the capped question");
    assert.match(textOf(page.sheets()[0].markup), /The curve can only absorb/);
    assert.equal(page.w.sends.length, 0);
    page.press("yes");
    const out = await run;
    assert.equal(out.phase, "done", out.message);
    assert.equal(page.prepared[0].tokens, (tokens * 3n).toString());
    assert.equal(page.prepared[1].tokens, tokens.toString(), "prepared again for what the curve can take");
    assert.equal(page.w.sends.length, 2, "the approval and the sell");
    assert.equal(page.sheets().length, 1, "one sheet, for the one question");
  } finally {
    page.done();
  }
});

test("one click: a price that moved when the quote was prepared again opens the sheet", async () => {
  const page = oneClickPage("curve buy");
  try {
    const old = page.fx.plan;
    // The chain moves on after the first check, and its price falls 10%. The
    // page's clock moves too: a check under two seconds old is not taken again.
    let moved = false;
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + (moved ? (skew += 3000) : 0);
    page.cleanups = [...(page.cleanups ?? []), () => { Date.now = realNow; }];
    page.w.now = () => (moved ? old.expiresAt + 30 : (moved = true, old.preparedAt));
    const quote = page.w.quote;
    page.w.quote = (amountIn) => (moved ? (quote(amountIn) * 90n) / 100n : quote(amountIn));
    const expected = (BigInt(old.quote.expectedOut) * 90n) / 100n;
    const minOut = (expected * BigInt(10_000 - page.fx.intent.slippageBps)) / 10_000n;
    const lower = structuredClone(old);
    lower.expiresAt = old.expiresAt + 200;
    lower.quote = { ...old.quote, expectedOut: expected.toString(), minOut: minOut.toString() };
    lower.steps[0].data = recall(lower.steps[0].data, (a) => (a[1] = minOut, a));
    page.plans = [old, lower];
    const run = page.buy();
    await settleUntil(() => page.sheets().length > 0, "the price question");
    assert.equal(page.prepared.length, 2);
    assert.match(textOf(page.sheets()[0].markup), /The quote expired and the price moved/);
    assert.equal(page.w.sends.length, 0);
    page.press("yes");
    const out = await run;
    assert.equal(out.phase, "done", out.message);
    assert.equal(page.w.sends.length, 1);
    assert.equal(page.w.sends[0].data, lower.steps[0].data, "the new plan's buy");
  } finally {
    page.done();
  }
});

test("Review each trade: the sheet opens for every trade, from the start, and its words follow the signer", async () => {
  const page = oneClickPage("curve buy");
  try {
    setReview(true);
    assert.equal(page.store.get(REVIEW_KEY), "1");
    let atSend = null;
    const inner = page.w.provider.request;
    page.w.provider = {
      request: async (args) => {
        if (args.method === "eth_sendTransaction") atSend = textOf(page.sheets()[0].markup);
        return inner(args);
      },
    };
    const run = page.buy();
    await settleUntil(() => page.sheets().length > 0 && /Check every step/.test(page.sheets()[0].markup), "the plan question");
    assert.equal(page.sheets().length, 1);
    assert.match(textOf(page.sheets()[0].markup), /Confirm signs them all with your trading wallet, with no pop-up\./);
    assert.equal(page.w.sends.length, 0);
    assert.deepEqual(page.toasts(), [], "no progress toast: the sheet shows it");
    page.press("yes");
    const out = await run;
    assert.equal(out.phase, "done", out.message);
    assert.match(atSend, /Signing/);
    assert.doesNotMatch(atSend, /Confirm in wallet|in your wallet/);
    // The fill still gets its toast.
    assert.equal(page.toasts().length, 1);
    assert.match(textOf(page.toasts()[0].markup), /^Bought TKN/);
    assert.equal(tradeProgress(page.row.token), null, "the card shows no progress for a reviewed trade");

    // Off again: the next trade is one click.
    setReview(false);
    assert.equal(page.store.has(REVIEW_KEY), false);
    const again = await page.buy();
    assert.equal(again.phase, "done");
    assert.equal(page.sheets().length, 1, "no new sheet");
  } finally {
    page.done();
  }
});

test("one click: a refused plan sends nothing, and the sheet says why with its details", async () => {
  const page = oneClickPage("curve buy");
  try {
    const bad = structuredClone(page.fx.plan);
    bad.steps[0].data = recall(bad.steps[0].data, (a) => (a[2] = "0x000000000000000000000000000000000000dEaD", a));
    page.plans = [bad];
    const out = await page.buy();
    assert.equal(out.phase, "refused");
    assert.equal(out.refusal.rule, "recipient");
    assert.equal(page.w.log.filter((m) => m === "eth_sendTransaction").length, 0);
    assert.equal(page.sheets().length, 1, "the sheet opens for a refusal");
    const text = textOf(page.sheets()[0].markup);
    // The refused plan stays out of the state (F3.2), so the sheet names the token by its address.
    assert.match(text, /^Buy 0x0000…70A1 Refused before anything was signed: The buy pays .* Nothing was sent\. Copy details Close$/);
    assert.doesNotMatch(text, /your wallet opened/, "the trading wallet has no pop-up to open");
    assert.ok(page.toasts().every((t) => t.removed), "and the progress toast gives way");
  } finally {
    page.done();
  }
});

test("one click: an error the trading wallet gives opens the sheet with Resume, which finishes the trade", async () => {
  const page = oneClickPage("curve buy");
  try {
    let refused = false;
    page.w.onSend = () => (refused ? {} : (refused = true,
      { throw: Object.assign(new Error("Too many transactions in a minute. Nothing was sent."), { code: -32005 }) }));
    const out = await page.buy();
    assert.equal(out.phase, "error");
    assert.ok(tradeInProgress(), "the trade is kept, for Resume");
    assert.equal(page.sheets().length, 1);
    assert.match(textOf(page.sheets()[0].markup), /Cancel Resume$/);
    assert.match(textOf(page.sheets()[0].markup), /Too many transactions in a minute\. Nothing was sent\./);
    assert.equal(page.w.sends.length, 0);
    await page.press("resume");
    await settleUntil(() => !tradeInProgress(), "the trade to finish");
    assert.equal(page.w.sends.length, 1);
    assert.match(textOf(page.sheets()[0].markup), /Done\./);
  } finally {
    page.done();
  }
});

test("one click: a trade that fails before signing says why in its toast, and opens no sheet", async () => {
  const page = oneClickPage("curve buy");
  try {
    page.plans = [503];
    const out = await page.buy();
    assert.equal(out.phase, "failed");
    assert.deepEqual(page.sheets(), []);
    assert.equal(page.toasts().length, 1);
    assert.equal(page.toasts()[0].className, "toast err");
    assert.match(textOf(page.toasts()[0].markup), /^Buy TKN The server is not here\.$/);
    assert.equal(tradeProgress(page.row.token), null);
  } finally {
    page.done();
  }
});

test("the Review each trade switch shows only with a trading wallet, and is kept", () => {
  const dom = stubDom();
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    S.mode = "hosted";
    S.login = { ...S.login, here: true };
    S.reviewTrades = false;
    renderQuickBuy();
    const row = dom.el("#qrevrow"), box = dom.el("#qreview");
    assert.equal(row.hidden, false);
    assert.equal(box.checked, false, "off by default");
    box.checked = true;
    box.onchange();
    assert.equal(S.reviewTrades, true);
    assert.equal(store.get(REVIEW_KEY), "1");
    S.reviewTrades = false;
    loadPrefs();
    assert.equal(S.reviewTrades, true, "kept across a reload");
    box.checked = false;
    box.onchange();
    assert.equal(S.reviewTrades, false);
    assert.equal(store.has(REVIEW_KEY), false);
    // No trading wallet on this origin, or a self page: no switch.
    S.login = { ...S.login, here: false };
    renderQuickBuy();
    assert.equal(row.hidden, true);
    S.mode = "self";
    S.login = { ...S.login, here: true };
    renderQuickBuy();
    assert.equal(row.hidden, true);
  } finally {
    dom.reset();
    S.mode = "self";
    S.login = { ...S.login, here: false };
    S.reviewTrades = false;
  }
});

// ====================================================================== //
// approvals ahead of need (public-release W3.2)                          //
// ====================================================================== //
// After a buy fills, the trading wallet approves the token for its sell, for
// exactly what it holds (TW6). These run through trade.js's own wiring, as
// the one-click tests above do. approveAhead.test.js holds the plan, the
// verifier's rules and the sequence to the spec in detail.

const hashOf = (i) => `0x${(i + 1).toString(16).padStart(64, "0")}`;
const APPROVE = "0x095ea7b3";
const CURVE_OF_70A1 = "0x000000000000000000000000000000000000c0a1";

/** Run every held sleep of this length once, as if that much time had passed. */
const wake = (page, ms) => {
  const due = page.timers.filter((t) => t.ms === ms && !t.ran);
  for (const t of due) { t.ran = true; t.fn(); }
  return due.length;
};

test("after a one-click curve buy, one approval of exactly the balance to the verified curve, with its own toast", async () => {
  const page = oneClickPage("curve buy");
  try {
    page.w.erc20 = 0n;
    const out = await page.buy();
    assert.equal(out.phase, "done", out.message);
    assert.equal(page.w.sends.length, 2, "the buy, then the approval");
    const a = page.w.sends[1];
    assert.equal(a.to.toLowerCase(), page.fx.intent.token.toLowerCase());
    assert.equal(a.data, APPROVE + CURVE_OF_70A1.slice(2).padStart(64, "0") + page.w.balance.toString(16).padStart(64, "0"));
    assert.equal(a.value, "0x0");
    assert.equal(page.w.erc20, page.w.balance);
    assert.deepEqual(page.sheets(), [], "no sheet: nothing asks the visitor");
    // Its toast, with its link, after the fill's.
    const [fill, approval] = page.toasts();
    assert.match(textOf(fill.markup), /^Bought TKN/);
    assert.equal(approval.className, "toast ok");
    assert.match(textOf(approval.markup), /^Approved TKN for selling Let the curve move TKN\. Your sell of it is then one step\. 0x0000000000000000… ↗$/);
    assert.match(approval.markup, new RegExp(`href="[^"]*/tx/${hashOf(1)}"`));
    assert.ok(!tradeInProgress());
    assert.equal(approvingAhead(), null);

    // The next buy of it, with the balance unchanged, is covered: nothing more is sent.
    const again = await page.buy();
    assert.equal(again.phase, "done");
    assert.equal(page.w.sends.length, 3, "only the second buy");
  } finally {
    page.done();
  }
});

test("a sell clicked during the approval waits for it, is then one step, and a second click is refused", async () => {
  const sellFx = fixture("curve sell with approval");
  const page = oneClickPage("curve buy");
  try {
    page.w.balance = BigInt(sellFx.intent.tokens);
    page.w.erc20 = 0n;
    page.plans = [page.fx.plan, sellFx.plan];
    // The approval stays pending until the test lets it mine.
    page.w.onSend = (i) => (i === 1 ? { receipt: "never" } : {});
    const bought = await doBuy(page.fx.intent.token, null, null, "0.01");
    assert.equal(bought.phase, "done", bought.message);
    await settleUntil(() => page.w.sends.length === 2 && page.timers.some((t) => t.ms === 250), "the approval, sent and polled");
    assert.ok(approvingAhead(), "the approval is running");
    assert.equal(buyBlocked(), null, "an approval ahead does not block the buttons");

    const sell = doSell(page.fx.intent.token, "100", null);
    await settleUntil(() => tradeProgress(page.row.token)?.label === "Waiting for the approval…", "the sell to wait");
    assert.equal(sellBlocked(page.row), "A trade is already in progress", "one click waits; the buttons say so");
    assert.equal(await doSell(page.fx.intent.token, "100", null), undefined);
    assert.match(textOf(page.toasts().at(-1).markup), /^Cannot sell A trade is already in progress$/);
    assert.equal(page.prepared.length, 1, "nothing prepared for the sell yet");

    page.w.receipts.get(hashOf(1)).outcome = "ok";
    assert.ok(wake(page, 250) > 0);
    const out = await sell;
    assert.equal(out.phase, "done", out.message);
    assert.equal(page.prepared.length, 2);
    assert.deepEqual(out.steps.map((s) => s.status), ["skipped", "mined"], "the sell plan's approval is covered");
    assert.equal(page.w.sends.length, 3, "the buy, the approval, the sell");
    assert.equal(page.w.sends[2].data, sellFx.plan.steps[1].data);
  } finally {
    page.done();
  }
});

test("an approval ahead that cannot finish says so, and the sell will include it", async () => {
  const page = oneClickPage("curve buy");
  try {
    page.w.erc20 = 0n;
    page.w.onSend = (i) => (i === 1 ? { receipt: "revert" } : {});
    const out = await page.buy();
    assert.equal(out.phase, "done");
    const last = page.toasts().at(-1);
    assert.equal(last.className, "toast warn");
    assert.match(textOf(last.markup),
      /^Could not approve TKN ahead Approval 1 reverted\. Nothing more will be sent\. Your next sell of it will include the approval\. /);
    assert.ok(!tradeInProgress());
  } finally {
    page.done();
  }
  // A read that fails before there is a plan sends nothing and says nothing.
  const quiet = oneClickPage("curve buy");
  try {
    quiet.w.erc20 = 0n;
    const inner = quiet.w.provider.request;
    quiet.w.provider.request = async (args) => {
      if (args.method === "eth_estimateGas") throw Object.assign(new Error("execution reverted"), { code: 3 });
      return inner(args);
    };
    assert.equal((await quiet.buy()).phase, "done");
    assert.equal(quiet.w.sends.length, 1);
    assert.equal(quiet.toasts().length, 1, "only the fill's toast");
  } finally {
    quiet.done();
  }
});

test("a visit to a held token's page looks once at its approval, and approves what is missing", async () => {
  const page = oneClickPage("curve buy");
  try {
    page.w.erc20 = 0n;
    ensureHolding(page.fx.intent.token);
    await settleUntil(() => page.w.receipts.size === 1, "the approval on a visit");
    await page.ahead();
    assert.equal(page.w.sends.length, 1);
    assert.equal(page.w.sends[0].data.slice(0, 10), APPROVE);
    // The page renders again, and again: once a page load is enough, and
    // nothing more is even read.
    const asked = page.w.log.length;
    ensureHolding(page.fx.intent.token);
    ensureHolding(page.fx.intent.token);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(approvingAhead(), null);
    assert.equal(page.w.sends.length, 1);
    assert.equal(page.w.log.length, asked);
  } finally {
    page.done();
  }
});

test("the main wallet never approves ahead: its sells keep P3's approvals inside their plans", async () => {
  // The fixture chain's wallet, connected as the visitor's own (F2) before
  // the page holds its timers.
  const eip6963 = await import("../public/js/wallet/eip6963.js");
  const fx = fixture("curve buy");
  const w = fixtureWallet({ from: fx.intent.from, now: fx.plan.preparedAt });
  const inner = w.provider.request;
  const own = {
    request: async (args) => {
      if (args.method === "eth_requestAccounts") return [fx.intent.from];
      if (args.method === "eth_getBalance") return "0xde0b6b3a7640000";
      if (args.method === "wallet_revokePermissions") return null;
      return inner(args);
    },
  };
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {} });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const say = () => window.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"),
    { detail: { info: { uuid: "fixture", name: "Fixture", icon: "", rdns: "fixture" }, provider: own } }));
  window.addEventListener("eip6963:requestProvider", say);
  await eip6963.discover(1);
  await eip6963.connect("fixture");
  const page = oneClickPage("curve buy");
  try {
    page.w = w;
    w.erc20 = 0n;
    page.store.set("clank.ack", "1");
    S.login = { ...S.login, here: false };
    assert.equal(trader().address, fx.intent.from);
    const run = doBuy(fx.intent.token, null, null, "0.01");
    await settleUntil(() => page.sheets().length > 0 && /Check every step/.test(page.sheets()[0].markup), "the browser wallet's sheet");
    page.press("yes");
    const out = await run;
    assert.equal(out.phase, "done", out.message);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(approvingAhead(), null);
    assert.equal(w.sends.length, 1, "the buy alone");
    assert.equal(w.erc20, 0n);
    // Nor on a visit to its page.
    ensureHolding(fx.intent.token);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(approvingAhead(), null);
    assert.equal(w.sends.length, 1);
  } finally {
    page.done();
    await eip6963.disconnect();
    S.conn = null;
  }
});
