import { S } from "./core/store.js";
import { api } from "./core/api.js";
import { $, html, paint } from "./core/dom.js";
import { XI, eth, millions, n, short } from "./core/format.js";
import { rowFor } from "./core/store.js";
import { EXPLORER } from "./core/constants.js";
import { liveToast, modal, note, toast } from "./core/ui.js";
import { renderLaunches } from "./pages/launches.js";
import { renderShell } from "./pages/shell.js";
import { renderTokenIfOpen } from "./pages/token.js";
import { renderWalletPanel } from "./pages/wallet.js";
import { acknowledge, acknowledgeTrading } from "./trade/acknowledge.js";
import { CHAIN_ID } from "./trade/constants.js";
import { createHoldings } from "./trade/holdings.js";
import { createSheet, ethText } from "./trade/planSheet.js";
import { readQuote, verifyQuote } from "./trade/quote.js";
import { createSequence, parseEth } from "./trade/sequence.js";
import { readIdentity, verifyPlan } from "./trade/verify.js";
import { backup } from "./wallet/backup.js";
import { ensureChain, onChange, provider, refreshBalance, walletError } from "./wallet/eip6963.js";
import { session } from "./wallet/session.js";
import { buyWallets, multi, splitNote, tickedBalance, walletTicks } from "./wallets.js";

// ====================================================================== //
// trading                                                                //
// ====================================================================== //
//
// Not on the design canvas — the artboards have no trade control anywhere.
// Added because a hot wallet with nothing to click is the wrong half of the
// feature.
//
// The server is what actually enforces every limit here. This code asks
// nicely; `/api/trade/buy` refuses anything over MAX_TRADE_ETH outright and
// anything over INSTANT_UNDER_ETH without an explicit confirm, whatever the
// page sends. The confirm dialog below exists because it is better UX, not
// because it is the control.

export const BUY_PRESETS = [0.005, 0.01, 0.02];

const HELD_KEY = "clank.held";

/** Tokens bought from this console, so their sell controls survive a reload. */
export const held = new Map();

/** Tokens whose balance this page load has read: until then, "holds none" is not known. */
export const heldRead = new Set();

/** "Review each trade" (W3.1): present, as "1", only while it is on. */
export const REVIEW_KEY = "clank.review";

export const loadPrefs = () => {
  try {
    S.buySize = Number(localStorage.getItem("clank.size")) || 0.01;
    const slip = localStorage.getItem("clank.slip");
    if (slip) $("#qslip").value = slip;
    for (const t of JSON.parse(localStorage.getItem(HELD_KEY) || "[]")) held.set(t, null);
    S.reviewTrades = localStorage.getItem(REVIEW_KEY) === "1";
  } catch { /* private window, or storage is blocked — defaults are fine */ }
};

/**
 * Turn "Review each trade" on or off. It holds from the next trade on; a
 * trade already running keeps the way it started.
 *
 * @param {boolean} on
 */
export function setReview(on) {
  S.reviewTrades = on === true;
  try {
    if (S.reviewTrades) localStorage.setItem(REVIEW_KEY, "1");
    else localStorage.removeItem(REVIEW_KEY);
  } catch { /* this page load only */ }
}

export const savePrefs = () => {
  try {
    localStorage.setItem("clank.size", String(S.buySize));
    localStorage.setItem("clank.slip", $("#qslip").value);
    localStorage.setItem(HELD_KEY, JSON.stringify([...held.keys()]));
  } catch { /* nothing here is worth failing a trade over */ }
};

export const slippageBps = () => {
  const pct = Number($("#qslip").value);
  return Number.isFinite(pct) && pct > 0 ? Math.round(pct * 100)
    : (S.wallet && S.wallet.slippage ? S.wallet.slippage.default : 300);
};

// ------------------------------------------------ which wallet trades --
// A hosted page trades from the trading wallet where this origin has one
// (public-release W1.2), and from the visitor's own wallet (F2) everywhere
// else. Which is decided once, when the page loads (`S.login.here`), and the
// main wallet never trades where there is a trading wallet (TW3).

/** Whether this page trades from the trading wallet. */
export const fromTradingWallet = () => S.mode === "hosted" && S.login.here === true;

/** The provider that trades: the trading wallet's while logged in, or the visitor's own. */
export const traderProvider = () => (fromTradingWallet() ? session.provider() : provider());

/** Read the ETH balance of the wallet that trades again, as after a fill. */
export const refreshTraderBalance = () => (fromTradingWallet() ? session.refreshBalance() : refreshBalance());

/**
 * The wallet that trades, as `{ address, chainId, balanceWei }`, or null. The
 * trading wallet is always on Robinhood Chain: its provider answers for 4663.
 */
export function trader() {
  if (!fromTradingWallet()) return S.conn;
  const t = S.trading;
  return t ? { address: t.address, chainId: CHAIN_ID, balanceWei: t.balanceWei } : null;
}

/**
 * Phases in which a trade is working, not waiting for the person. The idle
 * lock waits for these, and not for a plan sheet or a Resume left open.
 */
export const IN_FLIGHT = new Set(["preparing", "running", "signing", "pending"]);

export function renderQuickBuy() {
  paint($("#qsizes"), BUY_PRESETS.map((a) =>
    html`<button type="button" class="qsz ${a === S.buySize ? "on" : ""}" data-size="${a}"
      aria-pressed="${a === S.buySize}">${a}</button>`));
  // The top bar's button says the size (U1), and a size that is none of the
  // presets is the one in the custom field.
  const label = $("#sizelbl");
  if (label) label.textContent = `${S.buySize} ${XI}`;
  const custom = $("#qcustom");
  if (custom && document.activeElement !== custom) {
    custom.value = BUY_PRESETS.includes(S.buySize) ? "" : String(S.buySize);
  }
  // "Review each trade" (W3.1) is the trading wallet's alone: a browser
  // wallet's trades always show the sheet, and its own pop-up.
  const review = $("#qrevrow");
  if (review) {
    review.hidden = !fromTradingWallet();
    const box = $("#qreview");
    if (box) {
      box.checked = S.reviewTrades;
      box.onchange = () => setReview(box.checked === true);
    }
  }
  const note = $("#qnote");
  if (fromTradingWallet()) {
    const t = S.trading;
    note.textContent = !t ? "not logged in"
      : t.balanceWei === null ? "…"
      : eth(Number(t.balanceWei) / 1e18, 3) + " " + XI;
    return;
  }
  if (S.mode === "hosted") {
    const c = S.conn;
    note.textContent = !c ? "not connected"
      : c.chainId !== CHAIN_ID ? "wrong network"
      : c.balanceWei === null ? "…"
      : eth(Number(c.balanceWei) / 1e18, 3) + " " + XI;
    return;
  }
  const w = S.wallet;
  // Several wallets: which ones a buy goes out from, and what they hold
  // between them (multi-wallet.md). Nothing is drawn for main alone.
  renderQuickTicks();
  const bal = multi() ? tickedBalance() : n(w && w.balanceEth);
  if (!w || !w.hasKeystore) note.textContent = "no wallet";
  else if (!w.unlocked) note.textContent = "locked";
  else if (bal !== null && bal <= 0) note.textContent = "unfunded";
  else note.textContent = bal === null ? "…" : eth(bal, 3) + " " + XI;
}

/** The quick buy's wallet ticks, in a row of their own under the sizes. */
function renderQuickTicks() {
  let row = $("#qwallets");
  if (!row && !multi()) return;
  if (!row) {
    row = document.createElement("div");
    row.id = "qwallets";
    $("#qsizes").after(row);
  }
  paint(row, walletTicks());
}

/**
 * A trading wallet whose key this browser holds no backup confirmation for
 * neither trades nor is funded (W4). A withdraw never waits for it.
 */
export const BACK_UP_FIRST = "Back up your key first";

/** Why a buy cannot be sent right now, or null when it can. */
export function buyBlocked() {
  if (S.mode === "hosted") return hostedBuyBlocked();
  if (!S.wallet || !S.wallet.hasKeystore) return "No keystore — npm run wallet hot";
  if (!S.wallet.unlocked) return "Wallet is locked — click the wallet chip to unlock";
  if (!S.wallet.arm || !S.wallet.arm.manual.armed) return "Trading is in safe mode";
  if (multi()) {
    const bal = tickedBalance();
    if (bal !== null && bal <= 0) return `Fund ${buyWallets().join(", ")} to trade`;
    return null;
  }
  if (n(S.wallet.balanceEth) <= 0) return `Fund ${short(S.wallet.address)} to trade`;
  return null;
}

/**
 * The same question for a visitor's own wallet, in the order they would fix it,
 * and then one more: this tab trades one plan at a time.
 */
function hostedBuyBlocked() {
  if (fromTradingWallet()) {
    // The trading wallet (W1.2): no chain reason, since it is always on 4663.
    const t = S.trading;
    if (!t) return "Log in to trade";
    if (!backup.confirmed(t.address)) return BACK_UP_FIRST;
    if (t.balanceWei === null) return "Checking your balance";
    if (t.balanceWei === 0n) return "Fund your trading wallet";
    if (tradeBusy()) return "A trade is already in progress";
    return null;
  }
  const c = S.conn;
  if (!c) return "Connect a wallet";
  if (c.chainId !== CHAIN_ID) return "Switch to Robinhood Chain";
  if (c.balanceWei === null) return "Checking your balance";
  if (c.balanceWei === 0n) return `Fund ${short(c.address)} to trade`;
  if (tradeBusy()) return "A trade is already in progress";
  return null;
}

// -------------------------------------------------- the visitor's trades --
// A hosted page signs with the trading wallet where this origin has one
// (W1.2), and with the visitor's own wallet otherwise (F3.2). The sequence is
// the engine; this wires it to the API, the sheet and the wallet that trades.

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const sheet = createSheet({
  resume: () => trading.resume(),
  cancel: () => trading.cancel(),
  switchChain: async () => {
    try { await ensureChain(); } catch (e) { toast("err", "Could not switch network", walletError(e, "wallet_switchEthereumChain")); }
  },
  // The trading wallet asks no one, so the sheet never says a wallet will.
  // A fund is the exception: the main wallet sends it, and asks (W2.1).
  silent: (state) => fromTradingWallet() && !(state && state.transfer && state.intent && state.intent.kind === "fund"),
});

// ----------------------------------------------------- one click (W3.1) --
// The trading wallet signs with no pop-up, so a click on Buy or Sell trades
// (TW5). The plan sheet opens only when the person must decide: a plan with
// any warning, a capped sell, or a price that moved when the quote was
// prepared again. It also opens when a trade stops and needs them: a refusal,
// whose details they can copy for a report, or an error they can resume.
// Otherwise the trade shows its progress on its card's trade bar and in one
// toast. "Review each trade" brings the sheet back for every trade, as with a
// browser wallet.
//
// None of this is a check. The verifier and the page's own quote run in the
// sequence before anything is signed, whatever is shown (sequence.js).

/** A one-click trade that stops in one of these opens the sheet: the person can resume it, or report it. */
const STOPPED_FOR_PERSON = new Set(["paused", "rejected", "error", "refused"]);
/** A one-click trade that ends in one of these says why in its toast. */
const ENDED = new Set(["cancelled", "void", "reverted", "timeout", "failed"]);
/** How long "Done" stays on the card after a one-click trade. */
const DONE_MS = 6_000;

/**
 * Whether the sequence's question needs the person (TW5). A browser wallet's
 * trade, and any trade with "Review each trade" on (`oneClick` false), always
 * asks. Otherwise only a plan with no warnings goes ahead by itself. A capped
 * sell and a price that moved are questions only a person can answer, and a
 * warning is something they must see. A plan whose warnings are not a list
 * asks too.
 *
 * @param {{ kind: string, plan?: any } | null} ask
 * @param {boolean} oneClick
 */
export function asksPerson(ask, oneClick) {
  if (!oneClick) return true;
  if (!ask || ask.kind !== "plan") return true;
  const w = ask.plan && ask.plan.warnings;
  return !Array.isArray(w) || w.length > 0;
}

/**
 * What a one-click trade's toast and trade bar say, for the state it is in,
 * or null once it is over.
 *
 * @param {{ phase: string, steps?: { status: string, hash: string | null }[] }} state
 * @returns {{ label: string, hash: string | null } | null}
 */
export function progressOf(state) {
  const steps = state.steps || [];
  const i = steps.findIndex((s) => s.status === "signing" || s.status === "pending");
  const of = steps.length > 1 && i >= 0 ? ` · step ${i + 1} of ${steps.length}` : "";
  const sent = i >= 0 && steps[i].status === "pending" ? steps[i].hash : null;
  switch (state.phase) {
    case "preparing":
    case "confirming": return { label: "Preparing…", hash: null };
    case "signing": return { label: `Signing…${of}`, hash: null };
    case "running": return sent ? { label: `Sent${of}`, hash: sent } : { label: "Checking…", hash: null };
    case "pending": return { label: `Still pending${of}`, hash: sent };
    default: return null;
  }
}

/**
 * How this tab's trade is shown, decided when it starts. `oneClick`: the
 * trading wallet with "Review each trade" off. `sheet`: the sheet has opened
 * for it, and shows the rest of it.
 *
 * @type {{ oneClick: boolean, sheet: boolean, token: string, title: string, toast: any } | null}
 */
let view = null;

/** A one-click trade's progress on its card, while it runs and for a moment after. */
let bar = null;
let barTimer = null;

/** Say on a card's trade bar how its one-click trade is going; null clears it. */
function setBar(next, forMs = 0) {
  clearTimeout(barTimer);
  const was = bar ? `${bar.token}:${bar.label}:${bar.hash}` : "";
  bar = next;
  if (next && forMs > 0) barTimer = setTimeout(() => { if (bar === next) setBar(null); }, forMs);
  if ((next ? `${next.token}:${next.label}:${next.hash}` : "") !== was) renderLaunches();
}

/** How a one-click trade of this token is going, for its trade bar, or null. */
export function tradeProgress(token) {
  return bar && bar.token === String(token).toLowerCase() ? bar : null;
}

/** A trade is starting from a click: decide how it is shown. */
function begin(row, side) {
  if (view && view.toast) view.toast.drop();
  setBar(null);
  // A sheet left open on the last trade's outcome would sit over this one's
  // progress, saying something no longer true. No trade is running here
  // (buyBlocked and sellBlocked say so), so nothing on it is still needed.
  sheet.close();
  view = {
    oneClick: fromTradingWallet() && !S.reviewTrades,
    sheet: false,
    token: String(row.token).toLowerCase(),
    title: `${side === "buy" ? "Buy" : "Sell"} ${row.symbol || short(row.token)}`,
    toast: null,
  };
}

/** The person is needed: the sheet takes over this trade from here, and the toast goes. */
function openSheet(v, state) {
  v.sheet = true;
  if (v.toast) { v.toast.drop(); v.toast = null; }
  setBar(null);
  sheet.update(state);
}

/** Show the sequence's state: in the sheet, or, for a one-click trade, on its card and in its toast. */
function show(state) {
  if (state.ahead) return showAhead(state);
  const v = view;
  // A transfer (W2.1), a browser wallet's trade, a reviewed one, a one-click
  // trade the sheet has taken over, and one that ended before it had anything
  // to show all go to the sheet, as before.
  if (!v || !v.oneClick || v.sheet || state.transfer || !state.intent) return sheet.update(state);
  if (STOPPED_FOR_PERSON.has(state.phase)) return openSheet(v, state);
  if (state.phase === "done") return setBar({ token: v.token, label: "Done", hash: state.fill.hash, ok: true }, DONE_MS);
  if (ENDED.has(state.phase)) {
    const lost = (state.steps || []).find((s) => s.status === "unknown");
    if (v.toast) v.toast.end("err", v.title, state.message, lost ? lost.hash : null);
    else if (state.phase !== "cancelled") toast("err", v.title, state.message, lost ? lost.hash : null);
    v.toast = null;
    return setBar(null);
  }
  const p = progressOf(state);
  if (!p) return;
  const kind = state.phase === "pending" ? "warn" : "info";
  if (v.toast) v.toast.set(kind, v.title, p.label, p.hash);
  else v.toast = liveToast(kind, v.title, p.label, p.hash);
  setBar({ token: v.token, label: p.label, hash: p.hash, ok: false });
}

let wasBusy = false;

const trading = createSequence({
  provider: traderProvider,
  // A transfer's other wallet (W2.1): the visitor's main wallet, F2's. It
  // funds the trading wallet and receives Withdraw all, and never trades.
  main: () => (fromTradingWallet() ? provider() : null),
  // The trading wallet signs with no pop-up: the sequence's words, its errors
  // and its receipt polling follow (W3.1).
  silent: () => fromTradingWallet(),
  prepare: (side, body) => api(`/api/prepare/${side}`, body),
  readIdentity, verifyPlan, readQuote, verifyQuote,
  // The trading wallet's acknowledgement was asked at login (W1.2); this
  // passes then, and asks if it somehow was not.
  acknowledge: () => (fromTradingWallet() ? acknowledgeTrading() : acknowledge()),
  // A one-click trade asks only what needs a person (TW5); the sheet opens
  // for the question and stays for the rest of the trade.
  confirm: (ask) => {
    const v = view;
    const st = trading.state();
    if (v && v.oneClick && !(st && st.transfer)) {
      if (!asksPerson(ask, true)) return Promise.resolve(true);
      if (!v.sheet) openSheet(v, st);
    }
    return sheet.confirm(ask);
  },
  update: (state) => {
    // A trade in flight holds off the idle lock, in every tab (W1.2).
    session.tradeRunning(IN_FLIGHT.has(state.phase));
    show(state);
    // Starting or finishing a trade changes every card's Buy, and the token page's.
    if (trading.busy() !== wasBusy) {
      wasBusy = trading.busy();
      renderLaunches();
      renderTokenIfOpen();
      renderWalletPanel();
    }
  },
  afterFill: (fill) => {
    const { intent, plan, hash, receipt } = fill;
    const symbol = plan.symbol || short(intent.token);
    // A one-click trade's toast ends with the fill; any other trade gets one.
    const live = view && view.oneClick && !view.sheet && view.toast ? view.toast : null;
    if (view) view.toast = null;
    const say = (title, detail) => (live ? live.end("ok", title, detail, hash) : toast("ok", title, detail, hash));
    if (intent.side === "buy") {
      // What actually arrived, from the token's own Transfer logs.
      const me = "0x" + intent.from.slice(2).toLowerCase().padStart(64, "0");
      const got = (receipt.logs || [])
        .filter((l) => String(l.address).toLowerCase() === intent.token.toLowerCase()
          && l.topics && l.topics[0] === TRANSFER && String(l.topics[2]).toLowerCase() === me)
        .reduce((sum, l) => sum + BigInt(l.data), 0n);
      say(`Bought ${symbol}`, got > 0n
        ? `${millions(Number(got) / 1e18)} ${symbol}` : `at least ${millions(Number(BigInt(plan.quote.minOut)) / 1e18)} ${symbol}`);
    } else {
      say(`Sold ${symbol}`, `at least ${eth(Number(BigInt(plan.quote.minOut)) / 1e18, 5)} ${XI}`);
    }
    note("trade", `${intent.side === "buy" ? "bought" : "sold"} ${symbol} · ${hash}`);
    // The Portfolio reads this address again when it is next opened.
    S.lastFill = { address: String(intent.from).toLowerCase(), at: Date.now() };
    void refreshTraderBalance();
    void holdings.refresh(intent.from, intent.token);
    // The ledger again, 5s on as the spec has it, and once more 30s later,
    // both marked fresh: this address has just traded, so the server reads
    // the newest blocks instead of its cached ledger (D1.0).
    for (const ms of LEDGER_AFTER_FILL_MS) setTimeout(() => void refreshHeldFromLedger(renderLaunches, { fresh: true }), ms);
    // The sell this buy will need, approved now (W3.2).
    if (intent.side === "buy") approveAhead(intent.token, plan.symbol);
  },
  afterApproval: ({ intent, step, hash }) => {
    toast("ok", `Approved ${intent.symbol || short(intent.token)} for selling`, `${step.label}. Your sell of it is then one step.`, hash);
    note("approve", `${intent.symbol || short(intent.token)} ahead · ${hash}`);
    void refreshTraderBalance();
  },
  // A fund or a Withdraw all (W2.2): both wallets' balances have moved.
  afterTransfer: (fill) => {
    const { intent, plan, hash } = fill;
    const sent = ethText(plan.steps[0].value);
    if (intent.kind === "fund") {
      toast("ok", "Funded your trading wallet", `${sent} from ${short(intent.from)}`, hash);
      note("wallet", `funded the trading wallet · ${sent} · ${hash}`);
    } else {
      toast("ok", "Withdrew to your main wallet", `${sent} to ${short(intent.to)}`, hash);
      note("wallet", `withdrew to ${short(intent.to)} · ${sent} · ${hash}`);
    }
    void session.refreshBalance();
    void refreshBalance();
  },
});

const LEDGER_AFTER_FILL_MS = [5_000, 35_000];

/** Whether this tab has a trade in flight (for the chrome). */
export const tradeInProgress = () => tradeBusy();

// ------------------------------------------ approvals ahead of need (W3.2) --
// Right after a buy fills, the trading wallet approves that token for the
// sell it will need, for exactly what it holds (TW6), so that sell is one
// transaction. It looks again after every buy, and on the first visit to a
// held token's page in a page load: a raised balance, a Permit2 allowance
// within a day of its end, or a graduation each need a new approval, and a
// covered one sends nothing. Each approval gets a toast with its link, since
// each costs gas. A trade clicked meanwhile waits for it. The main wallet
// never approves ahead: it keeps P3's exact approvals inside each sell plan.

/** The approval ahead that is running, as a promise that settles when it has ended, or null. */
let ahead = null;
/** Whether a trade clicked during an approval ahead is waiting for it. One may wait; more clicks are refused. */
let queued = false;
/** Tokens whose approvals have been looked at on a visit to their page, this page load, for this address. */
const visited = new Set();

/** The approval ahead that is running, for a test to wait on, or null. */
export const approvingAhead = () => ahead;

/** Whether a trade the person started is running or waiting in this tab. An approval ahead is not one. */
function tradeBusy() {
  if (queued) return true;
  const st = trading.state();
  return trading.busy() && !(st && st.ahead);
}

/** Start an approval ahead of `token`'s sell, from the trading wallet, if nothing else is running. */
function approveAhead(token, symbol) {
  const t = trader();
  if (!fromTradingWallet() || !t || trading.busy() || queued) return;
  const run = trading.startApproveAhead({ from: t.address, token, symbol: symbol || undefined })
    .finally(() => { if (ahead === run) ahead = null; });
  ahead = run;
}

/**
 * Wait for a running approval ahead before a trade starts, saying so on the
 * token's card. False when another click is already waiting: that one trades.
 */
async function afterApprovals(row) {
  if (!ahead) return true;
  if (queued) return false;
  queued = true;
  setBar({ token: String(row.token).toLowerCase(), label: "Waiting for the approval…", hash: null, ok: false });
  renderTokenIfOpen();
  try { await ahead; } finally { queued = false; }
  setBar(null);
  return true;
}

/** An approval ahead only speaks when it could not finish: the sell will then include it. */
function showAhead(state) {
  if (!["failed", "refused", "void", "reverted", "timeout"].includes(state.phase)) return;
  // Reads that failed before there was a plan sent nothing and changed nothing.
  if (state.phase === "failed" && !state.plan) return;
  const intent = state.intent;
  const lost = (state.steps || []).find((s) => s.status === "unknown" || s.status === "reverted");
  toast("warn", `Could not approve ${intent.symbol || short(intent.token)} ahead`,
    `${state.message} Your next sell of it will include the approval.`, lost ? lost.hash : null);
}

/** On a visit to a held token's page, look once at whether its sell is approved. */
function visitApprovals(token) {
  const key = String(token).toLowerCase();
  if (!fromTradingWallet() || visited.has(key)) return;
  const h = holdingOf(token);
  if (h.state !== "ok" || !h.balance) return;
  // Something is running: a later render asks again.
  if (trading.busy() || queued) return;
  visited.add(key);
  const row = rowFor(key);
  approveAhead(token, row && row.symbol);
}

// ------------------------------------------- moving ETH between wallets --
// Fund and Withdraw all (public-release W2.2), through W2.1's `startTransfer`
// in the same sequence, so a tab runs one trade or transfer at a time. The
// panel (pages/wallet.js) connects the main wallet first when there is none;
// these say only why a transfer cannot start at all.

/**
 * Why Fund cannot start now, or null. It waits for the backup (W4). No main
 * wallet is not a reason: the panel asks for one when Fund is pressed.
 */
export function fundBlocked() {
  if (!fromTradingWallet()) return "There is no trading wallet on this site";
  const t = S.trading;
  if (!t) return "Log in to trade";
  if (!backup.confirmed(t.address)) return BACK_UP_FIRST;
  if (trading.busy()) return "A trade or transfer is already in progress";
  return null;
}

/**
 * Why Withdraw all goes nowhere after a Google or X login (P4 T2; the user,
 * 2026-09-26: "Only to the login wallet"): the trading wallet sends ETH only
 * to the wallet the person logged in with, and these logins have none.
 */
export const WITHDRAW_LOGIN_ONLY = "Withdraw all goes only to the wallet you logged in with. "
  + "Use Back up key to export this wallet's key and move the funds from there";

/** Why Withdraw all cannot start now, or null. It never waits for the backup. */
export function withdrawBlocked() {
  if (!fromTradingWallet()) return "There is no trading wallet on this site";
  const t = S.trading;
  if (!t) return "Log in to trade";
  if (t.method !== "wallet") return WITHDRAW_LOGIN_ONLY;
  if (t.balanceWei === null) return "Checking your balance";
  if (t.balanceWei === 0n) return "There is nothing to withdraw";
  if (trading.busy()) return "A trade or transfer is already in progress";
  return null;
}

/**
 * Start a fund (`{ kind: "fund", amountEth }`) or a Withdraw all (`{ kind:
 * "withdraw" }`). Neither takes an address: the sequence reads both from the
 * wallets (TW4). A reason to refuse is a toast, and nothing starts.
 *
 * @param {{ kind: "fund", amountEth: string } | { kind: "withdraw" }} input
 */
export function startTransfer(input) {
  const fund = input && input.kind === "fund";
  const why = fund ? fundBlocked() : withdrawBlocked();
  if (why) {
    toast("err", fund ? "Cannot fund" : "Cannot withdraw", why);
    return Promise.resolve(null);
  }
  return trading.startTransfer(input);
}

/** The transfer this tab is running or showing, or null: its kind, phase and words (for the panel). */
export function transferNow() {
  const st = trading.state();
  if (!st || !st.transfer || !trading.busy()) return null;
  return { kind: st.intent ? st.intent.kind : null, phase: st.phase, message: st.message };
}

// What the trading address holds of a token (public-release F3.4), read
// through the wallet that trades, for the token page's sell side.
const holdings = createHoldings({ provider: traderProvider, onChange: () => renderTokenIfOpen() });

let lastChain = null;
let lastAddress = null;
/** The wallet that trades may have changed account or chain, or logged in or out. */
function traderMoved() {
  const c = trader();
  // A balance read on one chain means nothing on another.
  const chain = c ? c.chainId : null;
  const address = c ? String(c.address).toLowerCase() : null;
  const moved = chain !== lastChain || address !== lastAddress;
  if (chain !== lastChain) {
    lastChain = chain;
    holdings.clear();
  }
  // A new account, or a new chain: what the last one held is not this one's.
  if (moved) {
    lastAddress = address;
    visited.clear();
    S.heldFromLedger = null;
    void refreshHeldFromLedger();
  }
  renderTokenIfOpen();
}
onChange(traderMoved);
session.on((type) => { if (type === "change") traderMoved(); });

// --------------------------------------- what the ledger says is held --
// The cards' sell buttons need to know what the trading address holds of
// every token on the board. One `/api/ledger` lookup answers that for all of
// them (public-release B3.5), where a `balanceOf` per card through the wallet
// would not scale. With the prepare API, it is one of the requests to our
// server that name the trading address: on connect or login, on an account
// or chain change, and after a fill. The server logs no address (B3.5).

/** The address a lookup is out for, so an answer for an old account is dropped. */
let ledgerAsk = null;

/**
 * The open positions in a `/api/ledger` answer, by lowercased token. `basis`
 * is what each cost and its P&L (null where it could not be valued), for the
 * token page's Your position (U4); nothing trades on it.
 */
export const heldFrom = (address, data) => {
  const open = data.open.filter((p) => p.tokens && p.tokens !== "0");
  return {
    address: String(address).toLowerCase(),
    byToken: new Map(open.map((p) => [String(p.token).toLowerCase(), {
      tokens: String(p.tokens),
      nowEth: p.valued ? n(p.nowEth) : null,
      capped: !!p.capped || n(p.sellablePct) < 99.5,
    }])),
    basis: new Map(open.filter((p) => Number.isFinite(Number(p.costEthNum))).map((p) => [String(p.token).toLowerCase(), {
      costEth: n(p.costEthNum),
      pnlPct: p.valued && Number.isFinite(Number(p.pnlPct)) ? n(p.pnlPct) : null,
    }])),
  };
};

/**
 * Read the trading address's positions into `S.heldFromLedger`. Nothing is
 * asked without a wallet that trades, on Robinhood Chain. A refusal or
 * failure leaves what was known.
 *
 * @param {() => void} [rerender]
 * @param {{ fresh?: boolean }} [opts] fresh: the address has just traded (D1.0)
 */
export async function refreshHeldFromLedger(rerender = renderLaunches, opts = {}) {
  const c = trader();
  if (S.mode !== "hosted" || !c || c.chainId !== CHAIN_ID) {
    S.heldFromLedger = null;
    return;
  }
  const address = String(c.address).toLowerCase();
  ledgerAsk = address;
  let r;
  try { r = await api("/api/ledger?address=" + encodeURIComponent(c.address) + (opts.fresh ? "&fresh=1" : "")); } catch { return; }
  const now = trader();
  if (ledgerAsk !== address || !now || String(now.address).toLowerCase() !== address) return;
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.open)) return;
  S.heldFromLedger = heldFrom(address, r.data);
  rerender();
}

/** What the ledger says the trading address holds of a token, or null. */
export function heldInLedger(token) {
  const h = S.heldFromLedger;
  const c = trader();
  if (S.mode !== "hosted" || !h || !c || String(c.address).toLowerCase() !== h.address) return null;
  return h.byToken.get(String(token).toLowerCase()) ?? null;
}

/** What the ledger says the trading address paid for a token, and its P&L, or null. */
export function ledgerBasis(token) {
  const h = S.heldFromLedger;
  if (!heldInLedger(token) || !h.basis) return null;
  return h.basis.get(String(token).toLowerCase()) ?? null;
}

/** Why a card's sell buttons are disabled: `sellBlocked`, with the ledger's size standing in for a wallet read. */
const cardSellBlocked = (r, lh) => sellBlocked(r, { state: "ok", balance: BigInt(lh.tokens) });

/** The trading address's balance of a token, as far as it is known. */
export function holdingOf(token) {
  const c = trader();
  return c ? holdings.get(c.address, token) : { state: "unknown", balance: null };
}

/** Read the trading address's balance of a token if it is not known or has gone stale. */
export function ensureHolding(token) {
  const c = trader();
  if (S.mode !== "hosted" || !c || c.chainId !== CHAIN_ID) return;
  void holdings.ensure(c.address, token).then(() => visitApprovals(token));
}

/**
 * Why a hosted sell of this token cannot be sent, in the order the visitor
 * would fix it, or null. A sell pays gas, so an empty wallet cannot sell even
 * what it holds.
 */
export function sellBlocked(r, h = holdingOf(r.token)) {
  if (fromTradingWallet()) {
    const t = S.trading;
    if (!t) return "Log in to trade";
    if (!backup.confirmed(t.address)) return BACK_UP_FIRST;
    if (t.balanceWei === null) return "Checking your balance";
    if (t.balanceWei === 0n) return "Fund your trading wallet for gas";
  } else {
    const c = S.conn;
    if (!c) return "Connect a wallet";
    if (c.chainId !== CHAIN_ID) return "Switch to Robinhood Chain";
    if (c.balanceWei === null) return "Checking your balance";
    if (c.balanceWei === 0n) return `Fund ${short(c.address)} for gas`;
  }
  const symbol = r.symbol || short(r.token);
  if (h.state === "error") return `Could not read your ${symbol} balance`;
  if (h.balance === null) return `Reading your ${symbol} balance`;
  if (h.balance === 0n) return `You hold no ${symbol}`;
  if (tradeBusy()) return "A trade is already in progress";
  return null;
}

/** Why this typed amount of ETH cannot be bought, or null. */
export function buyAmountBlocked(amountEth) {
  let wei;
  try { wei = parseEth(amountEth); } catch { return "Enter an amount of ETH"; }
  if (wei <= 0n) return "Enter an amount of ETH";
  const c = trader();
  if (c && c.balanceWei !== null && wei > c.balanceWei) return "More than this wallet holds";
  return null;
}

/**
 * Everything outside the row that changes what `tradeBar` draws. A card's
 * signature includes it, so a new input here repaints the board without
 * anyone having to remember `cardSig`.
 */
export const tradeBarSig = (r) => {
  const sig = [S.buySize, held.has(String(r.token).toLowerCase()), buyBlocked() ?? ""];
  if (S.mode !== "hosted") return multi() ? [...sig, buyWallets().join(",")] : sig;
  const lh = heldInLedger(r.token);
  const p = tradeProgress(r.token);
  return [...sig, lh ? `${lh.tokens}:${lh.nowEth}:${lh.capped}:${cardSellBlocked(r, lh) ?? ""}` : "",
    p ? `${p.label}:${p.hash}` : ""];
};

/**
 * The trade cell at the end of a board row (u-redesign.md, U2): a one-click
 * trade's progress, what is held and its sells when there is a holding, and
 * Buy last, so the Buy buttons line up down the table.
 *
 * A token that failed the sell simulation still gets a button — declining to
 * render it would be the app quietly making the decision — but it is red and
 * it always asks, because a position that cannot be exited is the one
 * mistake this whole project exists to prevent.
 */
export function tradeBar(r) {
  if (r.status !== "ready") return "";
  // A bonded token trades on V4, not the curve — but only once a pool has
  // actually been found. Without one there is genuinely nowhere to send it.
  if (r.graduated && !r.v4) return "";
  const blocked = buyBlocked();
  const risky = !r.graduated && (r.sellable === false || r.band === "AVOID");
  const h = held.get(String(r.token).toLowerCase());
  const lh = heldInLedger(r.token);
  const p = S.mode === "hosted" ? tradeProgress(r.token) : null;

  return html`<div class="tradebar">${p ? html`
      <span class="tprog ${p.ok ? "ok" : ""}">${p.label}${p.hash ? html` <a href="${EXPLORER + "/tx/" + p.hash}"
        target="_blank" rel="noopener noreferrer">↗</a>` : ""}</span>` : ""}
      ${h && h.balance && h.balance !== "0" ? html`
        <span class="hold" title="${h.capped ? "the curve cannot absorb the whole position in one sell" : ""}"
          >${millions(n(h.balance) / 1e18)} ≈ ${eth(h.netEth)} ${XI}${h.capped ? " ⚠" : ""}</span>
        <button class="btn sm sell" data-sell="${r.token}" data-pct="50">50%</button>
        <button class="btn sm sell" data-sell="${r.token}" data-pct="100">All</button>` : ""}${lh ? hostedSellButtons(r, lh) : ""}
      <button class="btn sm ${risky ? "risky" : "buy"}" data-buy="${r.token}"
        ${blocked ? "disabled" : ""} title="${blocked || (risky ? "This failed a gate — it will ask first" : S.mode === "hosted" ? "" : splitNote())}"
        >Buy ${S.buySize} ${XI}</button>
    </div>`;
}

/**
 * What the connected address holds of this token, by the ledger, and its sell
 * buttons (hosted). A sell still reads the wallet's own balance before it is
 * prepared (`doSell`); the ledger only says there is something to sell.
 */
function hostedSellButtons(r, lh) {
  return html`
    <span class="hold" title="${lh.capped ? "the curve cannot absorb the whole position in one sell" : "what this wallet holds, from the chain"}"
      >${millions(n(lh.tokens) / 1e18)}${lh.nowEth !== null ? ` ≈ ${eth(lh.nowEth)} ${XI}` : ""}${lh.capped ? " ⚠" : ""}</span>
    ${sellButtons(r, lh)}`;
}

/**
 * The 50% and All of a ledger holding, without the amount beside them: the
 * board's, and the Portfolio's on your own wallet (U5), which shows the
 * amount in its own column. Disabled with the reason as their title.
 */
export function sellButtons(r, lh) {
  const why = cardSellBlocked(r, lh);
  return html`<button class="btn sm sell" data-sell="${r.token}" data-pct="50" ${why ? "disabled" : ""} title="${why || ""}">50%</button>
    <button class="btn sm sell" data-sell="${r.token}" data-pct="100" ${why ? "disabled" : ""} title="${why || ""}">All</button>`;
}

export async function refreshHolding(token) {
  if (!S.wallet || !S.wallet.unlocked) return;
  const key = String(token).toLowerCase();
  try {
    const r = await api("/api/trade/sellable?token=" + encodeURIComponent(token));
    if (r.status !== 200) return;
    heldRead.add(key);
    if (r.data.balance && r.data.balance !== "0") held.set(key, r.data);
    else held.delete(key);
    savePrefs();
  } catch { /* the row may have gone, or the server is restarting */ }
}

function afterTrade(r, symbol, verb) {
  if (r.status !== 200) return toast("err", verb + " failed", r.data.error || "");
  const d = r.data;
  if (d.wallet) S.wallet = d.wallet;
  // One result per wallet when several took part (multi-wallet.md): say which
  // went through, and name any that did not rather than let the success hide it.
  const legs = Array.isArray(d.results) && d.results.length > 1 ? d.results : null;
  const from = legs ? ` · from ${legs.filter((x) => x.ok).map((x) => x.wallet).join(", ")}` : "";
  const detail = verb === "Bought"
    ? `~${millions(n(d.expected) / 1e18)} ${symbol} · ${d.slippageBps / 100}% slippage · ${d.ms}ms${from}`
    : `~${eth(d.expectedEth, 5)} ${XI}${d.capped ? " (capped by the curve reserve)" : ""} · ${d.ms}ms${from}`;
  toast("ok", `${verb} ${symbol}`, detail, d.hash);
  note("trade", `${verb.toLowerCase()} ${symbol} · ${d.hash || "no hash"}${from}`);
  const failed = legs ? legs.filter((x) => !x.ok) : [];
  if (failed.length) {
    toast("warn", `${failed.length} wallet${failed.length === 1 ? "" : "s"} did not ${verb === "Bought" ? "buy" : "sell"}`,
      failed.map((x) => `${x.wallet}: ${x.error}`).join(" · "));
  }
  return true;
}

export async function doBuy(token, btn, amountOverride, amountEth) {
  // A hosted check's row trades a token off the board (B5.1b).
  const row = rowFor(token);
  if (!row) return;
  const blocked = buyBlocked();
  if (blocked) return toast("err", "Cannot buy", blocked);

  if (S.mode === "hosted") {
    // The exact string the visitor typed (the token page), or a preset (a card).
    // Never a JavaScript number, which can turn 0.0000001 into "1e-7".
    const amount = amountEth ?? String(S.buySize);
    const tooMuch = buyAmountBlocked(amount);
    if (tooMuch) return toast("err", "Cannot buy", tooMuch);
    // An approval ahead (W3.2) finishes first; then the world is asked again.
    if (ahead) {
      if (!(await afterApprovals(row))) return toast("err", "Cannot buy", "A trade is already in progress");
      const still = buyBlocked() ?? buyAmountBlocked(amount);
      if (still) return toast("err", "Cannot buy", still);
    }
    // The trading address where this origin has a trading wallet (W1.2),
    // the visitor's own otherwise. buyBlocked has said there is one, and
    // that no trade is running.
    begin(row, "buy");
    return trading.start({
      side: "buy", from: trader().address, token: row.token, amountEth: amount, slippageBps: slippageBps(),
    });
  }

  const amount = Number.isFinite(amountOverride) && amountOverride > 0
    ? amountOverride : S.buySize;
  const symbol = row.symbol || short(row.token);
  const risky = row.sellable === false || row.band === "AVOID";
  // With several wallets the amount is the whole buy, split across the ticked
  // ones; with main alone the body is what it always was.
  const wallets = multi() ? buyWallets() : undefined;
  const send = (confirmed) => api("/api/trade/buy", {
    token: row.token, amountEth: String(amount),
    slippageBps: slippageBps(), confirmed, wallets,
  });

  const fire = async () => {
    btn.classList.add("busy");
    try {
      const r = await send(true);
      if (afterTrade(r, symbol, "Bought")) {
        await refreshHolding(row.token);
        renderLaunches(); renderShell(); renderTokenIfOpen();
      }
    } finally { btn.classList.remove("busy"); }
  };

  if (risky) {
    return modal({
      title: `Buy ${symbol} anyway?`,
      body: row.sellable === false
        ? "The sell simulation reverted on this token. A position in it may not be exitable at any price."
        : `This scored ${row.score} of 100 and is banded AVOID.`,
      confirmText: `Buy ${S.buySize} ${XI}`,
      onConfirm: fire,
    });
  }

  btn.classList.add("busy");
  try {
    const r = await send(false);
    // Above the instant threshold the server refuses without an explicit
    // confirm, so this dialog only appears for the larger sizes.
    if (r.status === 409 && r.data.needsConfirm) {
      btn.classList.remove("busy");
      return modal({
        title: `Confirm ${r.data.amountEth} ${XI} buy`,
        body: `Above the ${r.data.thresholdEth} ETH instant threshold. This sends real funds immediately.`,
        confirmText: `Buy ${r.data.amountEth} ${XI}`,
        onConfirm: fire,
      });
    }
    if (afterTrade(r, symbol, "Bought")) {
      await refreshHolding(row.token);
      renderLaunches(); renderShell(); renderTokenIfOpen();
    }
  } finally { btn.classList.remove("busy"); }
}

/**
 * @param {string} token
 * @param {string | number} pct
 * @param {any} btn
 * @param {string} [wallet] a wallet's label, or "all" (self). Every wallet
 *   when the console holds several and none is named: the holding a card or
 *   the token page shows is their total.
 */
export async function doSell(token, pct, btn, wallet) {
  const row = rowFor(token);
  if (!row) return;
  if (S.mode === "hosted") {
    // A card's sell is drawn from the ledger; the wallet's own balance decides.
    const c = trader();
    if (c && holdingOf(row.token).state === "unknown") await holdings.ensure(c.address, row.token);
    const blocked = sellBlocked(row);
    if (blocked) return toast("err", "Cannot sell", blocked);
    // A sell clicked during an approval ahead (W3.2) waits for it, and is
    // then one step; what it holds is read again.
    if (ahead) {
      if (!(await afterApprovals(row))) return toast("err", "Cannot sell", "A trade is already in progress");
      await holdings.refresh(c.address, row.token);
      const still = sellBlocked(row);
      if (still) return toast("err", "Cannot sell", still);
    }
    begin(row, "sell");
    return trading.start({ side: "sell", from: trader().address, token: row.token, pct: Number(pct), slippageBps: slippageBps() });
  }
  btn.classList.add("busy");
  try {
    const r = await api("/api/trade/sell",
      { token: row.token, pct: Number(pct), slippageBps: slippageBps(), wallet: wallet || (multi() ? "all" : undefined) });
    if (afterTrade(r, row.symbol || short(row.token), "Sold")) {
      await refreshHolding(row.token);
      renderLaunches(); renderShell(); renderTokenIfOpen();
    }
  } finally { btn.classList.remove("busy"); }
}

/** Re-read every remembered holding, e.g. after an unlock or a reload. */
export async function refreshHoldings() {
  if (!S.wallet || !S.wallet.unlocked || held.size === 0) return;
  await Promise.all([...held.keys()].map(refreshHolding));
  renderLaunches();
}
