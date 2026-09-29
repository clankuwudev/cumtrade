import { EXPLORER } from "../core/constants.js";
import { $, $$, html, paint } from "../core/dom.js";
import { XI, eth, millions, short } from "../core/format.js";
import { closeOn, holdSheet, refocus, sheetHead, siteIn, toast } from "../core/ui.js";
import { TOKENS_STAY, betaLine, domainLine, here } from "../wallet/words.js";

// ====================================================================== //
// the plan sheet                                                         //
// ====================================================================== //
//
// Everything about a trade before the first wallet prompt: every step, the
// quote, the minimum, the fees and the warnings, with one Confirm. It then
// stays open as the trade's progress, and ends with what happened. The numbers
// it shows are the quote's, which the verifier has already required to equal
// the calldata being signed (F3.1), so the sheet cannot say one thing while
// the wallet signs another.
//
// Built from the sheet family's pieces (U7): the head with its ✕, the quote
// and the steps as .wrow rows on cards, the pills, the warnings and the
// outcome as callouts, and colour only where something passed (green), is
// waiting on the visitor (amber) or went wrong (red).
//
// It closes only when closing loses nothing, the same rule for the ✕, Esc and
// the scrim, and the one it always had: an open question closes as Cancel; a
// step pending on the chain hides the sheet, which comes back when the visitor
// is needed; a trade that is over closes. While a step is being prepared or
// signed, or the trade waits on Resume or Cancel, there is no ✕ and Esc and
// the scrim do nothing: those buttons are the way out.
//
// A transfer between the visitor's two wallets (W2.1, W2.2) has no quote. Its
// sheet shows both addresses in full, the amount and the gas, and the money
// step's own words: the beta line for a fund, and for Withdraw all the domain
// line and what stays behind.

const wei = (v) => Number(BigInt(v)) / 1e18;

/**
 * An amount of ETH from wei, as the sheet shows it. Six decimals, except
 * below a millionth of an ETH, where six decimals would read "0.000000" for a
 * real amount: there it is written out exactly, from the integer, without
 * trailing zeros.
 */
export function ethText(v) {
  const w = BigInt(v);
  if (w === 0n || w >= 10n ** 12n) return `${eth(Number(w) / 1e18, 6)} ${XI}`;
  return `0.${w.toString().padStart(18, "0").replace(/0+$/, "")} ${XI}`;
}
const tokenText = (v, symbol) => `${millions(wei(v))} ${symbol}`;

const STATUS = {
  waiting: ["n", "Waiting"], signing: ["a", "Confirm in wallet"], pending: ["a", "Pending"],
  mined: ["g", "Done"], skipped: ["n", "Already approved"], reverted: ["r", "Reverted"], unknown: ["r", "Not mined"],
};

/** Phases after which nothing more will happen, and the sheet can only be closed. */
const OVER = new Set(["done", "cancelled", "void", "reverted", "timeout", "failed", "refused"]);

/**
 * `silent` says whether the wallet that signs this state's steps does so
 * with no pop-up (the trading wallet, W3.1). The sheet then never tells the
 * visitor that their wallet will ask them: the two lines that say so follow
 * the signer.
 *
 * @param {{
 *   resume: () => unknown, cancel: () => unknown, switchChain: () => Promise<unknown>,
 *   silent?: (state: any) => boolean,
 * }} actions
 */
export function createSheet(actions) {
  const silent = (state) => (actions.silent ? actions.silent(state) === true : false);
  /** @type {HTMLElement | null} */
  let el = null;
  let last = null;
  let ask = null;       // { kind, ..., answer(bool) } while a question is open
  let hidden = false;   // closed by the visitor while a step was still pending
  /** Esc and the focus held inside (ui.js), while the sheet is in the page. */
  let release = () => {};

  /** Whether the visitor may close the sheet now: see the rule at the top. */
  const closable = () => !!ask || !!(last && (OVER.has(last.phase) || last.phase === "pending"));

  /** The ✕, Esc and the scrim: Cancel for a question, else close when closable. */
  function dismiss() {
    if (ask) return answer(false);
    if (closable()) close();
  }

  function open() {
    if (el && el.isConnected) return;
    // A sheet taken out of the page some other way lets go of the keys first.
    release();
    el = document.createElement("div");
    el.className = "modal";
    el.addEventListener("click", (e) => { if (e.target === el) dismiss(); });
    document.body.appendChild(el);
    release = holdSheet(el, dismiss);
  }

  function close() {
    if (last && last.phase === "pending") hidden = true;
    release();
    release = () => {};
    if (el) el.remove();
    el = null;
  }

  function answer(ok) {
    const a = ask;
    ask = null;
    if (a) a.answer(ok);
    if (last) render(last);
  }

  /** Show the trade's state. A hidden sheet comes back when the visitor is needed again. */
  function update(state) {
    last = state;
    // A trade that ended before there was anything to show (the acknowledgement
    // declined, nothing to sell) gets no sheet; a reason, if any, is a toast.
    if (!el && OVER.has(state.phase) && !state.intent) {
      if (state.phase !== "cancelled" && state.message) toast("err", state.transfer ? "Cannot move ETH" : "Cannot trade", state.message);
      return;
    }
    if (hidden && state.phase === "pending") return;
    hidden = false;
    open();
    render(state);
  }

  /** Ask the visitor a question about the trade, and resolve their answer. */
  function confirm(question) {
    return new Promise((resolve) => {
      ask = { ...question, answer: resolve };
      open();
      render(last ?? { phase: "confirming", steps: [], done: [] });
    });
  }

  function render(state) {
    if (!el) return;
    const plan = ask ? ask.plan : state.plan;
    const intent = ask ? ask.intent : state.intent;
    const symbol = plan && plan.symbol ? plan.symbol : intent ? short(intent.token) : "";
    const side = intent ? intent.side : "buy";

    if (intent && TRANSFER_KINDS.has(intent.kind)) {
      paint(el, transferBox(state, ask, intent, plan, closable()));
    } else {
      paint(el, html`<div class="mbox plansheet" role="dialog" aria-modal="true" aria-labelledby="plan-title" tabindex="-1">
        ${sheetHead("plan-title", `${side === "buy" ? "Buy" : "Sell"} ${symbol}`, closable())}
        ${plan && plan.quote ? quote(plan, side, symbol) : ""}
        ${plan && plan.warnings && plan.warnings.length ? html`<div class="planwarns">${plan.warnings.map((w) =>
          html`<div class="callout ${w.code === "band-avoid" || w.code === "sell-sim-failed" ? "danger" : "warn"}"
            ><span>${w.text}</span></div>`)}</div>` : ""}
        ${stepsOf(state, silent(state))}
        ${ask ? question(ask, symbol, silent(state)) : said(state)}
        <div class="mbtns sheetacts">${buttons(state, ask)}</div>
      </div>`);
    }

    for (const b of $$("[data-sheet]", el)) b.onclick = () => act(b.dataset.sheet);
    closeOn(el, dismiss);
    // Each step repaints the box, and the button pressed goes with the old
    // one: focus comes back to the new box, never to a button, so a stray
    // Enter confirms nothing.
    refocus(el);
  }

  async function act(what) {
    if (what === "yes") return answer(true);
    if (what === "no") return answer(false);
    if (what === "close") return close();
    if (what === "resume") return actions.resume();
    if (what === "cancel") return actions.cancel();
    if (what === "switch") {
      await actions.switchChain();
      return actions.resume();
    }
  }

  return { update, confirm, close };
}

function quote(plan, side, symbol) {
  const q = plan.quote;
  const inText = side === "buy" ? ethText(q.amountIn) : tokenText(q.amountIn, symbol);
  const outText = (v) => (side === "buy" ? tokenText(v, symbol) : ethText(v));
  const curve = plan.venue === "curve";
  return html`<div class="sheetcard">
    <div class="wrow"><span class="k">You pay</span><span class="v">${inText}</span></div>
    <div class="wrow"><span class="k">Expected</span><span class="v">${outText(q.expectedOut)}</span></div>
    <div class="wrow"><span class="k">At least</span><span class="v"><b>${outText(q.minOut)}</b>
      <span class="t3"> · ${(q.slippageBps / 100).toFixed(2)}% slippage</span></span></div>
    <div class="wrow"><span class="k">Fee</span><span class="v">${ethText(q.feeWei)}${
      q.snipeTaxWei && q.snipeTaxWei !== "0" ? html` <span class="amb">+ ${ethText(q.snipeTaxWei)} snipe tax</span>` : ""}</span></div>
    <div class="wrow"><span class="k">Impact</span><span class="v ${q.priceImpactBps > 300 ? "amb" : ""}"
      >${(q.priceImpactBps / 100).toFixed(2)}%</span></div>
    <div class="wrow"><span class="k">Venue</span><span class="v">${curve ? "Bonding curve" : "Uniswap V4"}</span></div>
    </div>
    <p class="sheetnote">${curve
      ? html`A curve trade has no deadline, so <b>at least</b> is your protection.`
      : "The router refuses the swap if it lands more than a few minutes late, or below the minimum."}</p>`;
}

/** The kinds of a transfer's intent (W2.1). */
const TRANSFER_KINDS = new Set(["fund", "withdraw"]);
/** A transfer's addresses are written out in full, never cut short, on a phone too. */
const IN_FULL = "white-space:normal;word-break:break-all";

/**
 * A transfer's sheet: where the ETH leaves from and goes to, both in full, as
 * the wallets gave them when the button was pressed; how much; and the gas.
 * A withdraw's amount is the balance less the gas it keeps back, so it is
 * known only once the plan is built.
 */
function transferBox(state, ask, intent, plan, closable) {
  const fund = intent.kind === "fund";
  const step = plan && plan.steps && plan.steps[0];
  const reserve = step && step.maxFeePerGas ? BigInt(step.gas) * BigInt(step.maxFeePerGas) : null;
  const origin = here();
  return html`<div class="mbox plansheet" role="dialog" aria-modal="true" aria-labelledby="plan-title" tabindex="-1">
      ${sheetHead("plan-title", fund ? "Fund your trading wallet" : "Withdraw all", closable)}
      <p>${fund ? "From your wallet to your trading wallet." : "Everything in your trading wallet, less its gas, to your main wallet."}</p>
      <div class="sheetcard">
      <div class="wrow"><span class="k">From</span><span class="v mo" style="${IN_FULL}">${intent.from}</span></div>
      <div class="wrow"><span class="k">To</span><span class="v mo" style="${IN_FULL}">${intent.to}</span></div>
      <div class="wrow"><span class="k">Amount</span><span class="v"><b>${
        fund ? ethText(intent.amountWei) : step ? ethText(step.value) : "working it out…"}</b></span></div>
      ${step ? html`<div class="wrow"><span class="k">Gas</span><span class="v">${BigInt(step.gas).toLocaleString("en-US")}${
        reserve !== null ? html` <span class="t3">· up to ${ethText(reserve)} kept back for it</span>` : ""}</span></div>` : ""}
      </div>
      ${reserve !== null ? html`<p class="sheetnote">What the gas does not use stays in the trading wallet, as dust.</p>` : ""}
      ${fund ? html`<p class="twsitel">${siteIn(betaLine(origin), origin)}</p>`
        : html`<p>${TOKENS_STAY}</p><p class="twsitel">${siteIn(domainLine(origin), origin)}</p>`}
      ${stepsOf(state, !fund)}
      ${ask ? html`<p>${fund ? "Your wallet will ask you to confirm the transfer."
          : "Check the address: it is your main wallet's, read from it just now. Confirm signs the withdrawal with no pop-up."}</p>`
        : said(state)}
      <div class="mbtns sheetacts">${buttons(state, ask)}</div>
    </div>`;
}

function stepsOf(state, quiet) {
  const rows = [...(state.done || []), ...(state.steps || [])];
  if (!rows.length) return "";
  return html`<div class="sheetcard">${rows.map((s, i) => {
    const [cls, label] = quiet && s.status === "signing" ? ["a", "Signing"] : STATUS[s.status] || ["n", s.status];
    return html`<div class="wrow"><span class="k">Step ${i + 1}</span>
        <span class="v">${s.label}</span>
        ${s.hash ? html`<a class="copy" href="${EXPLORER + "/tx/" + s.hash}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ""}
        <span class="pill ${cls}" style="margin-left:${s.hash ? "8px" : "auto"}">${label}</span></div>`;
  })}</div>`;
}

function question(ask, symbol, quiet) {
  if (ask.kind === "capped") {
    return html`<div class="callout warn"><span>The curve can only absorb ${tokenText(ask.can, symbol)} of the
      ${tokenText(ask.asked, symbol)} you asked to sell in one go. Sell that much instead?</span></div>`;
  }
  if (ask.kind === "priceMoved") {
    const out = (v) => (ask.intent.side === "buy" ? tokenText(v, symbol) : ethText(v));
    return html`<div class="callout warn"><span>The quote expired and the price moved: you would now get at least
      <b>${out(ask.now)}</b>, where it was ${out(ask.was)}.</span></div>`;
  }
  return quiet
    ? html`<p>Check every step. Confirm signs them all with your trading wallet, with no pop-up.</p>`
    : html`<p>Check every step. Your wallet will ask you to confirm each one.</p>`;
}

/**
 * The state's message, in the colour its phase always had: green when done;
 * a red callout when it went wrong; amber when it waits on the visitor; a
 * pulsing one while a step is pending on the chain; plain words otherwise.
 */
function said(state) {
  const { phase, message } = state;
  if (!message) return "";
  if (phase === "done") return html`<p class="sheetok">${message}</p>`;
  const kind = ["refused", "reverted", "timeout", "failed", "void"].includes(phase) ? "danger"
    : phase === "pending" ? "warn busy"
    : ["paused", "rejected", "error"].includes(phase) ? "warn" : "";
  return kind ? html`<div class="callout ${kind}"><span>${message}</span></div>` : html`<p>${message}</p>`;
}

/** What a refusal's "Copy details" puts on the clipboard, for a report. */
const details = (state) => JSON.stringify({
  plan: state.plan ? state.plan.planId : null,
  side: state.intent ? state.intent.side : null,
  token: state.intent ? state.intent.token : null,
  ...(state.refusal || {}),
});

/** The sheet's buttons: the open question's, or the phase's. */
function buttons(state, ask) {
  const phase = state.phase;
  if (ask) {
    const yes = ask.kind === "capped" ? "Sell that much" : ask.kind === "priceMoved" ? "Continue" : "Confirm";
    return html`<button class="btn" type="button" data-sheet="no">Cancel</button><button class="btn pri" type="button" data-sheet="yes">${yes}</button>`;
  }
  switch (phase) {
    case "paused": return html`<button class="btn" type="button" data-sheet="cancel">Cancel</button>
      <button class="btn pri" type="button" data-sheet="switch">Switch and resume</button>`;
    case "rejected":
    case "error": return html`<button class="btn" type="button" data-sheet="cancel">Cancel</button>
      <button class="btn pri" type="button" data-sheet="resume">Resume</button>`;
    case "pending": return html`<button class="btn" type="button" data-sheet="close">Close</button>`;
    case "refused": return html`<button class="btn" type="button" data-copy="${details(state)}">Copy details</button>
      <button class="btn" type="button" data-sheet="close">Close</button>`;
    default: return OVER.has(phase) ? html`<button class="btn" type="button" data-sheet="close">Close</button>` : "";
  }
}
