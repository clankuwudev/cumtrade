// The trading-wallet panel (public-release W2.2).
//
// Two layers: the panel's markup in every state, from made-up states; and the
// panel on a stub page, wired to the page's real trade.js, sequence, verifier
// and plan sheet, with F2's real eip6963.js finding one scripted browser
// wallet. The trading wallet stands in for W1.1's embedded provider. Both
// wallets share one fake chain. Nothing leaves the process, and every address
// is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";
import { S } from "../public/js/core/store.js";
import {
  connectMarkup, fundButtonMarkup, fundWordsMarkup, headMarkup, openWalletPanel, panelMarkup, panelState,
  renderWalletPanel, walletPanelOpen, withdrawMarkup,
} from "../public/js/pages/wallet.js";
import { BACK_UP_FIRST, WITHDRAW_LOGIN_ONLY, fundBlocked, startTransfer, tradeInProgress, withdrawBlocked } from "../public/js/trade.js";
import { backup } from "../public/js/wallet/backup.js";
import { discover } from "../public/js/wallet/eip6963.js";
import { session } from "../public/js/wallet/session.js";
import { MONEY_WARNING, TOKENS_STAY, WHY_MAIN, betaLine, domainLine } from "../public/js/wallet/words.js";
import { stubDom, textOf } from "./support/stubdom.js";

/** The site as the money steps name it: the page's host, with no scheme. */
const ORIGIN = "staging.clank.example";
const TRADING = "0x0000000000000000000000000000000000007Ead";
const MAIN = "0x00000000000000000000000000000000000A11cE";
/** Another account in the same browser wallet. */
const OTHER = "0x000000000000000000000000000000000000B0b0";
const BASE_FEE = 50_080_000n;
const ETH = 10n ** 18n;

const lower = (a) => String(a).toLowerCase();
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ================================================ the markup, by state --

/** A panel state, as `panelState` builds it, with made-up values. */
const state = (over = {}) => ({
  trading: { address: TRADING, method: "google", balanceWei: ETH / 10n },
  main: { address: MAIN, name: "Scripted", chainId: 4663 },
  backedUp: true, fundWhy: null, withdrawWhy: null, transfer: null, origin: ORIGIN,
  ...over,
});
const words = (st) => textOf(panelMarkup(st).s);
const markup = (st) => panelMarkup(st).s;

/**
 * What every state must say wherever money moves: the warning beside the
 * balance, the beta line at Fund, and the domain line and what stays behind
 * at Withdraw all. The fund amount's field is in no part that is repainted.
 */
function moneyWords(st, name) {
  const w = words(st);
  assert.ok(textOf(headMarkup(st).s).includes(MONEY_WARNING), `${name}: the warning, beside the balance`);
  assert.ok(textOf(fundWordsMarkup(st).s).includes(betaLine(ORIGIN)), `${name}: the beta line, at Fund`);
  const out = textOf(withdrawMarkup(st).s);
  assert.ok(out.includes(domainLine(ORIGIN)), `${name}: the domain line, at Withdraw all`);
  assert.ok(out.includes(TOKENS_STAY), `${name}: what stays behind`);
  assert.ok(w.indexOf(MONEY_WARNING) < w.indexOf("Fund from my wallet"), `${name}: the warning comes before Fund`);
  for (const part of [headMarkup, fundWordsMarkup, fundButtonMarkup, withdrawMarkup]) {
    assert.doesNotMatch(part(st).s, /data-fund-amount/, `${name}: the field is not in ${part.name}`);
  }
  assert.equal((markup(st).match(/<input[^>]*data-fund-amount/g) ?? []).length, 1, `${name}: one field, in the panel`);
}

test("funded, backed up, with a main wallet: everything can be pressed, and Withdraw all names its destination in full", () => {
  const st = state();
  moneyWords(st, "funded");
  const w = words(st);
  for (const want of [
    "Your trading wallet", "Login Google", `Address ${TRADING} copy`, "Balance 0.1000 Ξ",
    `Beta: new software. Keep only trading money here. You are on ${ORIGIN}. Only fund a trading wallet on this site.`,
    `or send ETH on Robinhood Chain to this address: ${TRADING}`,
    `Sends all the ETH here, less its gas, to your main wallet: ${MAIN}`,
    `You are on ${ORIGIN}. Only fund a trading wallet on this site.`,
    "After 30 minutes with no activity, this page logs you out.", "Back up key Log out",
  ]) assert.ok(w.includes(want), want);
  // Close is the corner's ✕, named for a screen reader.
  assert.match(markup(st), /<button class="sheetx" type="button" data-x aria-label="Close"/);
  // The main wallet, shortened in its row, in full where it receives.
  assert.match(w, /Main 0x0000…11cE Scripted Disconnect/);
  assert.match(markup(st), /data-fund\s+title=""/, "Fund is not disabled");
  assert.match(markup(st), /data-withdraw\s+title=""/, "nor is Withdraw all");
  assert.doesNotMatch(w, /Back up your key first|in progress|Switch to Robinhood Chain/);
});

test("not backed up: the panel says so first, Fund waits and its address is not offered, Withdraw all does not wait", () => {
  const st = state({ backedUp: false, fundWhy: BACK_UP_FIRST });
  moneyWords(st, "not backed up");
  const w = words(st);
  assert.match(w, /Back up your key first\. Funding and trading wait until you have saved it\. Back up key/);
  assert.match(markup(st), /data-fund disabled title="Back up your key first"/);
  assert.doesNotMatch(w, /or send ETH/, "no address to send to before the backup");
  assert.match(markup(st), /data-withdraw\s+title=""/, "a withdraw never waits for the backup");
});

test("unfunded, and still reading: Withdraw all says why it cannot run", () => {
  const empty = state({ trading: { address: TRADING, method: "x", balanceWei: 0n }, withdrawWhy: "There is nothing to withdraw" });
  moneyWords(empty, "unfunded");
  assert.match(words(empty), /Login X/);
  assert.match(words(empty), /Balance 0\.0000 Ξ/);
  assert.match(markup(empty), /data-withdraw disabled title="There is nothing to withdraw"/);
  assert.match(markup(empty), /data-fund\s+title=""/, "an empty wallet can be funded");
  const reading = state({ trading: { address: TRADING, method: "wallet", balanceWei: null }, withdrawWhy: "Checking your balance" });
  assert.match(words(reading), /Login Wallet/);
  assert.match(words(reading), /Balance reading…/);
  assert.match(markup(reading), /data-withdraw disabled title="Checking your balance"/);
});

test("no main wallet: no row and no Connect button, and Withdraw all goes to a wallet the visitor connects", () => {
  const st = state({ main: null });
  moneyWords(st, "no main wallet");
  const w = words(st);
  assert.doesNotMatch(w, /Main |Disconnect|Connect/);
  assert.match(w, /Sends all the ETH here, less its gas, to a wallet you connect\./);
  assert.match(markup(st), /data-fund\s+title=""/, "Fund asks for one when pressed");
  // The main wallet on another chain: a switch, in its row.
  assert.match(words(state({ main: { address: MAIN, name: "Scripted", chainId: 1 } })), /Main 0x0000…11cE Scripted Disconnect Your main wallet is on another network. Switch to Robinhood Chain/);
});

test("a withdraw in progress: the panel says so, and neither button can start another", () => {
  const busy = "A trade or transfer is already in progress";
  const st = state({
    fundWhy: busy, withdrawWhy: busy,
    transfer: { kind: "withdraw", phase: "pending", message: "The withdrawal is still pending." },
  });
  moneyWords(st, "in progress");
  assert.match(words(st), /A withdrawal is in progress: The withdrawal is still pending\./);
  assert.match(markup(st), /data-fund disabled title="A trade or transfer is already in progress"/);
  assert.match(markup(st), /data-withdraw disabled title="A trade or transfer is already in progress"/);
  assert.match(words(state({ transfer: { kind: "fund", phase: "signing", message: "" } })), /A fund is in progress\./);
});

test("the connect sheet says why first, then lists the wallets found", () => {
  const list = [{ uuid: "u1", name: "Scripted", icon: "" }];
  const fund = textOf(connectMarkup("fund", list).s);
  assert.match(fund, new RegExp(`^Connect a wallet ${WHY_MAIN.replace(/\./g, "\\.")} Fund sends ETH from it`));
  assert.match(fund, /Scripted/);
  assert.match(textOf(connectMarkup("withdraw", list).s), /Withdrawals only go to a wallet you connect\. Withdraw all sends everything to it\./);
  assert.match(textOf(connectMarkup("withdraw", []).s), /No browser wallet was found/);
  // One sheet family (U7): a named dialog, its head with the ✕, the wallets as option buttons.
  assert.match(connectMarkup("fund", list).s, /^<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="cf-title" tabindex="-1">\s*<div class="sheethd"><h3 id="cf-title">Connect a wallet<\/h3><button class="sheetx"/);
  assert.match(connectMarkup("fund", list).s, /<div class="wpicks"><button class="wpick" type="button" data-connect-main="u1">/);
});

test("the reasons: Fund waits for a login and the backup, Withdraw all for a login and a balance, never the backup", () => {
  const saved = { mode: S.mode, login: S.login, trading: S.trading };
  const UNSAVED = "0x000000000000000000000000000000000000Ba5e";
  try {
    S.mode = "hosted";
    S.login = { here: false, phase: "idle", countdown: null, waiting: false };
    assert.equal(fundBlocked(), "There is no trading wallet on this site");
    assert.equal(withdrawBlocked(), "There is no trading wallet on this site");
    S.login = { ...S.login, here: true };
    S.trading = null;
    assert.equal(fundBlocked(), "Log in to trade");
    assert.equal(withdrawBlocked(), "Log in to trade");
    assert.equal(panelState(), null, "logged out, there is no panel");
    S.trading = { address: UNSAVED, method: "google", balanceWei: ETH };
    assert.equal(fundBlocked(), BACK_UP_FIRST);
    // P4 T2: ETH leaves only for the login wallet, and Google and X logins have none.
    assert.equal(withdrawBlocked(), WITHDRAW_LOGIN_ONLY);
    S.trading = { ...S.trading, method: "x" };
    assert.equal(withdrawBlocked(), WITHDRAW_LOGIN_ONLY);
    S.trading = { ...S.trading, method: "wallet" };
    assert.equal(withdrawBlocked(), null, "a withdraw never waits for the backup");
    assert.equal(panelState({ origin: ORIGIN }).backedUp, false);
    backup.confirm(UNSAVED);
    assert.equal(fundBlocked(), null);
    S.trading = { ...S.trading, balanceWei: null };
    assert.equal(withdrawBlocked(), "Checking your balance");
    S.trading = { ...S.trading, balanceWei: 0n };
    assert.equal(withdrawBlocked(), "There is nothing to withdraw");
    assert.equal(fundBlocked(), null, "an empty wallet can be funded");
  } finally {
    Object.assign(S, saved);
  }
});

// ============================================ on a page, end to end --

/**
 * The visitor's two wallets on one fake chain, as in sequence.test.js. The
 * main wallet announces itself over EIP-6963 and can switch account, as a
 * browser wallet does; each send it gets is its pop-up. The trading wallet
 * signs with no pop-up, and refuses a send it cannot pay for at twice the
 * base fee. A mined send moves its value and pays its gas at the base fee.
 */
function chain() {
  const c = {
    balances: new Map([[lower(MAIN), 2n * ETH], [lower(OTHER), 2n * ETH], [lower(TRADING), 3n * ETH / 10n]]),
    receipts: new Map(), hashes: 0,
  };
  c.balance = (a) => c.balances.get(lower(a)) ?? 0n;
  const make = (who, account) => {
    const w = { who, account, sent: [], calls: [], listeners: new Map() };
    w.provider = {
      on: (ev, fn) => w.listeners.set(ev, fn),
      removeListener: (ev) => w.listeners.delete(ev),
      async request({ method, params }) {
        w.calls.push(method);
        switch (method) {
          case "eth_chainId": return "0x1237";
          case "eth_requestAccounts":
          case "eth_accounts": return [w.account];
          case "eth_getBlockByNumber": return { number: "0x1", timestamp: "0x6a9c1d00", baseFeePerGas: toHex(BASE_FEE) };
          case "eth_getBalance": return toHex(c.balance(params[0]));
          case "eth_estimateGas": return toHex(21_000n);
          case "eth_sendTransaction": {
            const tx = params[0];
            assert.equal(lower(tx.from), lower(w.account), `the ${who} wallet was asked to send from another account`);
            if (who === "trading" && BigInt(tx.value) + BigInt(tx.gas) * 2n * BASE_FEE > c.balance(tx.from)) {
              throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 });
            }
            w.sent.push(tx);
            const hash = `0x${(++c.hashes).toString(16).padStart(64, "0")}`;
            c.receipts.set(hash, { tx, seen: false });
            return hash;
          }
          case "eth_getTransactionReceipt": {
            const r = c.receipts.get(params[0]);
            if (!r) return null;
            if (!r.seen) {
              r.seen = true;
              c.balances.set(lower(r.tx.from), c.balance(r.tx.from) - BigInt(r.tx.value) - BigInt(r.tx.gas) * BASE_FEE);
              c.balances.set(lower(r.tx.to), c.balance(r.tx.to) + BigInt(r.tx.value));
            }
            return { transactionHash: params[0], status: "0x1", logs: [] };
          }
        }
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
    /** The browser wallet switches account, and tells the page. */
    w.switchTo = (a) => { w.account = a; const fn = w.listeners.get("accountsChanged"); if (fn) fn([a]); };
    return w;
  };
  c.main = make("main", MAIN);
  c.trading = make("trading", TRADING);
  return c;
}

/**
 * A stub page where each element finds its own parts, a sheet's buttons are
 * the ones in its markup, and every element made is kept. The main wallet
 * announces itself to eip6963.js on this page's window, once for the file.
 */
function page(c) {
  const dom = stubDom();
  const make = document.createElement;
  const made = [];
  document.createElement = () => {
    const el = make();
    const found = new Map();
    el.querySelector = (sel) => { if (!found.has(sel)) found.set(sel, document.createElement()); return found.get(sel); };
    el.q = el.querySelector;
    // The plan sheet binds its buttons with querySelectorAll("[data-sheet]").
    el.querySelectorAll = (sel) => {
      if (sel !== "[data-sheet]") return [];
      el.sheet = [...String(el.markup).matchAll(/data-sheet="(\w+)"/g)].map((m) => ({ dataset: { sheet: m[1] }, onclick: null }));
      return el.sheet;
    };
    el.press = (what) => el.sheet.find((b) => b.dataset.sheet === what).onclick();
    el.isConnected = true;
    el.removed = 0;
    el.remove = () => { el.removed++; el.isConnected = false; };
    el.listeners = new Map();
    el.addEventListener = (type, fn) => { el.listeners.set(type, fn); };
    made.push(el);
    return el;
  };
  const body = { appended: [], appendChild(el) { body.appended.push(el); return el; } };
  Object.assign(document, { body });
  globalThis.location = /** @type {any} */ ({ hash: "", origin: `https://${ORIGIN}`, host: ORIGIN });
  const store = new Map([["clank.ack.tw", "1"]]);
  globalThis.localStorage = /** @type {any} */ ({
    getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  });
  // No server here: the ledger lookups that follow a wallet change answer nothing.
  globalThis.fetch = /** @type {any} */ (async () => ({ status: 503, json: async () => ({}) }));
  const shown = new Map();
  globalThis.window = /** @type {any} */ ({
    scrollTo() {},
    addEventListener: (type, fn) => shown.set(type, fn),
    removeEventListener() {},
    dispatchEvent: (e) => {
      const heard = shown.get("eip6963:announceProvider");
      if (e.type === "eip6963:requestProvider" && heard) {
        heard({ detail: { info: { uuid: "scripted-1", name: "Scripted", icon: "", rdns: "test.scripted" }, provider: c.main.provider } });
      }
      return true;
    },
  });
  /** The newest element appended whose words match. */
  const find = (re) => [...body.appended].reverse().find((el) => re.test(textOf(el.markup)));
  return { dom, body, made, find };
}

test("end to end: a Google visitor funds exactly the typed amount after connecting a wallet and can't withdraw; a wallet login withdraws all to it, and a switch mid-withdraw voids it", async () => {
  const c = chain();
  const p = page(c);
  const saved = {
    mode: S.mode, login: S.login, trading: S.trading, conn: S.conn,
    provider: session.provider, refreshBalance: session.refreshBalance, tradeRunning: session.tradeRunning,
  };
  let method = "google";
  const tradingBalance = () => ({ address: TRADING, method, balanceWei: c.balance(TRADING) });
  S.mode = "hosted";
  S.login = { here: true, phase: "idle", countdown: null, waiting: false };
  S.trading = tradingBalance();
  S.conn = null;
  session.provider = () => (S.trading ? c.trading.provider : null);
  session.refreshBalance = async () => { if (S.trading) S.trading = tradingBalance(); };
  session.tradeRunning = () => {};
  backup.confirm(TRADING);
  try {
    await discover(0);

    // ---- Fund: the panel asks for a wallet only now, and says why.
    assert.equal(openWalletPanel({ origin: ORIGIN }) !== null, true);
    const panel = p.body.appended[0];
    assert.equal(walletPanelOpen(), true);
    assert.doesNotMatch(textOf(panel.markup), /Main 0x/, "no main wallet yet");
    panel.q("[data-fund-amount]").value = " 0.05 ";
    panel.q("[data-fund]").onclick();
    await settle();
    const ask = p.find(/^Connect a wallet/);
    assert.ok(ask, "the connect sheet");
    assert.ok(textOf(ask.markup).includes(WHY_MAIN));
    assert.equal(c.main.calls.length, 0, "the wallet was not asked anything before the visitor picked it");
    ask.q('[data-connect-main="scripted-1"]').onclick();
    await settle();
    assert.equal(S.conn && S.conn.address, MAIN, "connected as the main wallet");
    assert.equal(walletPanelOpen(), false, "the panel gave way to the plan sheet");
    let sheet = p.find(/^Fund your trading wallet/);
    assert.ok(sheet, "the fund's sheet");
    let w = textOf(sheet.markup);
    assert.ok(w.includes(`From ${MAIN}`) && w.includes(`To ${TRADING}`), "both addresses in full");
    assert.match(w, /Amount 0\.050000 Ξ/);
    assert.ok(w.includes(betaLine(ORIGIN)), "the beta line, naming this origin");
    assert.match(w, /Your wallet will ask you to confirm the transfer\./);
    assert.equal(c.main.sent.length + c.trading.sent.length, 0, "nothing sent before Confirm");
    sheet.press("yes");
    await settle();
    assert.equal(c.main.sent.length, 1);
    const f = c.main.sent[0];
    assert.deepEqual([lower(f.from), lower(f.to), BigInt(f.value), f.data], [lower(MAIN), lower(TRADING), 5n * ETH / 100n, "0x"],
      "exactly the typed amount, from the main wallet to the trading wallet");
    assert.equal(c.trading.sent.length, 0);
    assert.match(textOf(p.find(/^Fund your trading wallet/).markup), /Done\./);
    assert.equal(tradeInProgress(), false);

    // ---- A Google login can't withdraw (P4 T2): ETH leaves only for the login wallet.
    S.trading = tradingBalance();
    assert.equal(panelState({ origin: ORIGIN }).withdrawWhy, WITHDRAW_LOGIN_ONLY);

    // ---- Withdraw all, after a wallet login: to the connected wallet, named in full first.
    method = "wallet";
    S.trading = tradingBalance();
    const before = c.balance(TRADING);
    openWalletPanel({ origin: ORIGIN });
    const again = p.body.appended[p.body.appended.length - 1];
    assert.ok(textOf(again.markup).includes(`to your main wallet: ${MAIN}`));
    again.q("[data-withdraw]").onclick();
    await settle();
    sheet = p.find(/^Withdraw all/);
    w = textOf(sheet.markup);
    const reserve = 21_000n * 2n * BASE_FEE;
    assert.ok(w.includes(`From ${TRADING}`) && w.includes(`To ${MAIN}`));
    assert.ok(w.includes(TOKENS_STAY) && w.includes(domainLine(ORIGIN)));
    assert.match(w, /Check the address: it is your main wallet's, read from it just now\./);
    // While it waits for the visitor, the panel knows it, and starts nothing else.
    const busy = panelState({ origin: ORIGIN });
    assert.deepEqual([busy.transfer.kind, busy.transfer.phase], ["withdraw", "confirming"]);
    assert.equal(busy.fundWhy, "A trade or transfer is already in progress");
    assert.equal(busy.withdrawWhy, "A trade or transfer is already in progress");
    sheet.press("yes");
    await settle();
    assert.equal(c.trading.sent.length, 1, "signed by the trading wallet");
    const out = c.trading.sent[0];
    assert.deepEqual([lower(out.to), BigInt(out.value)], [lower(MAIN), before - reserve], "everything less its gas, to the main wallet");
    assert.equal(c.main.sent.length, 1, "the main wallet sent nothing more");

    // ---- A switch of account in the main wallet while the sheet is open voids it.
    c.balances.set(lower(TRADING), ETH / 10n);
    S.trading = tradingBalance();
    openWalletPanel({ origin: ORIGIN });
    p.body.appended[p.body.appended.length - 1].q("[data-withdraw]").onclick();
    await settle();
    sheet = p.find(/^Withdraw all/);
    assert.ok(textOf(sheet.markup).includes(`To ${MAIN}`));
    c.main.switchTo(OTHER);
    await settle();
    assert.equal(S.conn.address, OTHER);
    sheet.press("yes");
    await settle();
    assert.equal(c.trading.sent.length, 1, "nothing more was sent");
    assert.match(textOf(p.find(/^Withdraw all/).markup), /A wallet changed account\. .*nothing will be sent\. Start again\./);
    assert.equal(tradeInProgress(), false);
  } finally {
    Object.assign(S, { mode: saved.mode, login: saved.login, trading: saved.trading, conn: saved.conn });
    Object.assign(session, { provider: saved.provider, refreshBalance: saved.refreshBalance, tradeRunning: saved.tradeRunning });
  }
});

test("on a page: logged out closes the panel, a cancelled connect starts nothing, and the backup or a busy tab refuses a fund", async () => {
  const c = chain();
  const p = page(c);
  const saved = { mode: S.mode, login: S.login, trading: S.trading, conn: S.conn };
  const UNSAVED = "0x000000000000000000000000000000000000Fee1";
  const started = [];
  const d = { origin: ORIGIN, startTransfer: async (input) => { started.push(input); return null; } };
  try {
    S.mode = "hosted";
    S.login = { here: true, phase: "idle", countdown: null, waiting: false };
    S.conn = null;
    S.trading = null;
    assert.equal(openWalletPanel(d), null, "logged out, nothing opens");
    S.trading = { address: UNSAVED, method: "x", balanceWei: ETH };
    openWalletPanel(d);
    const panel = p.body.appended[p.body.appended.length - 1];
    // Not backed up: Fund refuses, whatever the button's state.
    panel.q("[data-fund-amount]").value = "0.01";
    panel.q("[data-fund]").onclick();
    await settle();
    assert.equal(started.length, 0);
    assert.equal(p.find(/^Connect a wallet/), undefined, "no wallet is asked for either");
    backup.confirm(UNSAVED);
    renderWalletPanel();
    assert.doesNotMatch(textOf(panel.q("[data-tw-head]").markup), /Back up your key first/, "confirming repaints it");
    // Bad amounts start nothing.
    for (const bad of ["", "0", "-1", "abc", "1e-3", "0.0000000000000000001"]) {
      panel.q("[data-fund-amount]").value = bad;
      panel.q("[data-fund]").onclick();
      await settle();
    }
    assert.equal(started.length, 0);
    assert.equal(p.find(/^Connect a wallet/), undefined);
    // Cancelling the connect sheet starts nothing.
    panel.q("[data-fund-amount]").value = "0.01";
    panel.q("[data-fund]").onclick();
    await settle();
    const ask = p.find(/^Connect a wallet/);
    ask.q("[data-x]").onclick();
    await settle();
    assert.equal(started.length, 0);
    assert.equal(S.conn, null);
    // Withdraw all, the same: nothing without a wallet.
    panel.q("[data-withdraw]").onclick();
    await settle();
    p.find(/^Connect a wallet/).listeners.get("click")({ target: p.find(/^Connect a wallet/) });
    await settle();
    assert.equal(started.length, 0);
    assert.equal(walletPanelOpen(), true);
    // Logged out: the panel closes at its next repaint.
    S.trading = null;
    renderWalletPanel();
    assert.equal(walletPanelOpen(), false);
    assert.equal(panel.removed, 1);
    // The wrapper refuses too, with no panel: the backup, and one transfer at a time.
    S.trading = { address: "0x000000000000000000000000000000000000Fee2", method: "google", balanceWei: ETH };
    assert.equal(await startTransfer({ kind: "fund", amountEth: "0.01" }), null, "not backed up");
    S.trading = null;
    assert.equal(await startTransfer({ kind: "withdraw" }), null, "logged out");
  } finally {
    Object.assign(S, saved);
  }
});
