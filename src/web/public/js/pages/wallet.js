import { S } from "../core/store.js";
import { $, $$, html, paint } from "../core/dom.js";
import { XI, eth, short } from "../core/format.js";
import { avatar, closeOn, holdSheet, note, sheetHead, siteIn, toast } from "../core/ui.js";
import { fundBlocked, startTransfer, transferNow, withdrawBlocked } from "../trade.js";
import { CHAIN_ID } from "../trade/constants.js";
import { parseEth } from "../trade/sequence.js";
import { backup } from "../wallet/backup.js";
import { connect, disconnect, ensureChain, walletError, wallets } from "../wallet/eip6963.js";
import { IDLE_MS, session } from "../wallet/session.js";
import { MONEY_WARNING, TOKENS_STAY, WHY_MAIN, betaLine, domainLine, here } from "../wallet/words.js";
import { openBackup } from "./backup.js";

// ====================================================================== //
// the trading-wallet panel                                               //
// ====================================================================== //
//
// What the trading wallet's chip opens once logged in (public-release W2.2):
// the address and balance, the warning, Fund, Withdraw all, Back up key and
// Log out. Fund and Withdraw all go through W2.1's `startTransfer`, which
// reads both addresses from the wallets themselves and checks the plan
// before anything is signed; this panel never passes an address (TW4).
//
// On an origin with a trading wallet there is no separate chip for the
// visitor's own wallet. A wallet-login visitor's wallet is already the main
// wallet. A Google or X visitor is asked to connect one only when they press
// Fund or Withdraw all, and told why: withdrawals go nowhere else.
//
// The fund amount's field is never repainted, so a balance read or a login
// change while the visitor types does not take it away.

/** How each login reads on its own. */
const LOGIN = { google: "Google", x: "X", wallet: "Wallet" };
const IDLE_MINUTES = Math.round(IDLE_MS / 60_000);
/** An address that must be read in full, never cut short, on a phone too. */
const IN_FULL = "white-space:normal;word-break:break-all";

/**
 * @typedef {{
 *   trading: { address: string, method: string | null, balanceWei: bigint | null },
 *   main: { address: string, name: string, chainId: number } | null,
 *   backedUp: boolean,
 *   fundWhy: string | null,
 *   withdrawWhy: string | null,
 *   transfer: { kind: string | null, phase: string, message: string } | null,
 *   origin: string,
 * }} PanelState
 */

/**
 * What the panel shows, from the page's state now. Logged out, null.
 *
 * @param {{ origin?: string }} [d]
 * @returns {PanelState | null}
 */
export function panelState(d = {}) {
  const t = S.trading;
  if (!t) return null;
  const c = S.conn;
  return {
    trading: t,
    main: c ? { address: c.address, name: c.info ? c.info.name : "Wallet", chainId: c.chainId } : null,
    backedUp: backup.confirmed(t.address),
    fundWhy: fundBlocked(),
    withdrawWhy: withdrawBlocked(),
    transfer: transferNow(),
    origin: d.origin ?? here(),
  };
}

// ------------------------------------------------------------ markup --
//
// Built from the shared components since U0 (app.css SHARED COMPONENTS):
// the sheet's head with its ✕, .callout, .seg, .field, .avatar and the .btn
// variants. The .tw* classes left are the wallet's own.

/** The wallet itself: its login, address, balance and warning, any transfer running, and the main wallet. */
export function headMarkup(/** @type {PanelState} */ st) {
  const t = st.trading;
  const m = st.main;
  const login = t.method ? LOGIN[t.method] : "—";
  return html`
    <div class="twcard">
      <div class="twacct">
        ${avatar(t.address, "lg")}
        <div class="twid">
          <div class="twidtop"><span class="twnet">Robinhood Chain</span>
            <span class="twchip" title="Logged in with ${login}"><span class="sr">Login</span> ${login}</span></div>
          <div class="twaddr"><span class="sr">Address</span><span class="mo" title="${t.address}">${t.address}</span>
            <span class="addrcopy" data-copy="${t.address}">copy</span></div>
        </div>
      </div>
      <div class="twbal"><span class="twk">Balance</span>
        <span class="twamt">${t.balanceWei === null ? html`<span class="twread">reading…</span>`
          : html`${eth(Number(t.balanceWei) / 1e18)} <span class="twxi">${XI}</span>`}</span></div>
      ${m ? html`<div class="twmain"><span class="twk">Main</span>
        <span class="mo" title="${m.address}">${short(m.address)}</span>
        <span class="t3">${m.name}</span>
        <button class="btn sm ghost" type="button" data-main-off>Disconnect</button></div>
        ${m.chainId === CHAIN_ID ? "" : html`<div class="callout warn"><span>Your main wallet is on another network.</span>
          <button class="btn sm pri" type="button" data-switch-chain>Switch to Robinhood Chain</button></div>`}` : ""}
    </div>
    <div class="callout warn"><span>${MONEY_WARNING}</span></div>
    ${st.backedUp ? "" : html`<div class="callout warn strong"><span><b>Back up your key first.</b> Funding and trading
      wait until you have saved it.</span> <button class="btn sm pri" type="button" data-backup-now>Back up key</button></div>`}
    ${st.transfer ? html`<div class="callout info busy"><span>${st.transfer.kind === "fund" ? "A fund" : "A withdrawal"} is in
      progress${st.transfer.message ? `: ${st.transfer.message}` : "."}</span></div>` : ""}`;
}

/** Fund's words: the beta line, which names this page's origin. */
export const fundWordsMarkup = (/** @type {PanelState} */ st) => html`
    <p class="twsitel">${siteIn(betaLine(st.origin), st.origin)}</p>`;

/** Fund's button, why it cannot be pressed, and the other way in once the key is saved. */
export function fundButtonMarkup(/** @type {PanelState} */ st) {
  const t = st.trading;
  return html`<button class="btn pri lg block" type="button" data-fund ${st.fundWhy ? "disabled" : ""} title="${st.fundWhy || ""}"
        >Fund from my wallet</button>
    ${st.fundWhy ? html`<p class="twwhy">${st.fundWhy}</p>` : ""}
    ${st.backedUp ? html`<div class="twalt"><p>or send ETH on Robinhood Chain to this address:
      <span class="mo" style="${IN_FULL}">${t.address}</span></p>
      <span class="addrcopy" data-copy="${t.address}">copy</span></div>` : ""}`;
}

/** Withdraw all: where it goes, in full, what stays, and the domain line. */
export function withdrawMarkup(/** @type {PanelState} */ st) {
  const m = st.main;
  return html`
    <div class="twdest">${m ? html`Sends all the ETH here, less its gas, to your main wallet:
      <span class="mo" style="${IN_FULL}">${m.address}</span>` : "Sends all the ETH here, less its gas, to a wallet you connect."}</div>
    <p class="twsmall">${TOKENS_STAY}</p>
    <p class="twsitel">${siteIn(domainLine(st.origin), st.origin)}</p>
    <button class="btn lg block" type="button" data-withdraw ${st.withdrawWhy ? "disabled" : ""} title="${st.withdrawWhy || ""}"
        >Withdraw all</button>
    ${st.withdrawWhy ? html`<p class="twwhy">${st.withdrawWhy}</p>` : ""}`;
}

/**
 * The whole panel. Each part has a container of its own; the amount's field
 * is in none of them. Fund and Withdraw all are tabs: both are always in the
 * page, the one not chosen is hidden, and a repaint keeps the choice.
 */
export function panelMarkup(/** @type {PanelState} */ st) {
  return html`<div class="mbox twbox" role="dialog" aria-modal="true" aria-labelledby="tw-title" tabindex="-1">
      ${sheetHead("tw-title", "Your trading wallet")}
      <div class="twpart" data-tw-head>${headMarkup(st)}</div>
      <div class="seg full twtabs" role="tablist" aria-label="Move money">
        <button type="button" role="tab" id="tw-tab-fund" aria-controls="tw-pane-fund" aria-selected="true"
          data-tw-tab="fund">Fund</button>
        <button type="button" role="tab" id="tw-tab-withdraw" aria-controls="tw-pane-withdraw" aria-selected="false"
          data-tw-tab="withdraw">Withdraw</button>
      </div>
      <section class="twpane" id="tw-pane-fund" role="tabpanel" aria-labelledby="tw-tab-fund" data-tw-pane="fund">
        <div class="twpart" data-tw-fundwords>${fundWordsMarkup(st)}</div>
        <label class="field lg">
          <input type="text" data-fund-amount inputmode="decimal" autocomplete="off" spellcheck="false"
            placeholder="0.00" aria-label="Amount of ETH to fund">
          <span class="unit" aria-hidden="true">ETH</span></label>
        <div class="twpart" data-tw-fund>${fundButtonMarkup(st)}</div>
      </section>
      <section class="twpane twpart" id="tw-pane-withdraw" role="tabpanel" aria-labelledby="tw-tab-withdraw" hidden
        data-tw-pane="withdraw" data-tw-withdraw>${withdrawMarkup(st)}</section>
      <div class="sheetfoot">
        <button class="btn ghost" type="button" data-backup>Back up key</button>
        <button class="btn ghost danger" type="button" data-logout>Log out</button>
      </div>
      <p class="twidle">Log out when you leave. After ${IDLE_MINUTES} minutes with no activity, this
        page logs you out.</p>
    </div>`;
}

// -------------------------------------------------------------- panel --

/** @type {{ draw: () => void, close: () => void } | null} */
let open = null;

/**
 * Open the panel for the logged-in trading wallet. Nothing opens when logged
 * out. Opening it again replaces the one open.
 *
 * @param {{
 *   origin?: string,
 *   startTransfer?: typeof startTransfer,
 *   connectFirst?: (kind: "fund" | "withdraw") => Promise<boolean>,
 *   ensureChain?: () => Promise<unknown>,
 * }} [d] tests pass their own
 */
export function openWalletPanel(d = {}) {
  const first = panelState(d);
  if (!first) return null;
  if (open) open.close();
  const back = document.createElement("div");
  back.className = "modal";
  paint(back, panelMarkup(first));
  const head = $("[data-tw-head]", back);
  const fundBox = $("[data-tw-fund]", back);
  const withdrawBox = $("[data-tw-withdraw]", back);
  const amount = $("[data-fund-amount]", back);

  let shut = false;
  /** Esc and the focus held inside, from ui.js; set once the panel is in the page. */
  let release = () => {};
  const close = () => {
    if (shut) return;
    shut = true;
    release();
    back.remove();
    if (open && open.close === close) open = null;
  };

  /** Show Fund or Withdraw all. The panes are never repainted, so the choice holds. */
  const show = (which) => {
    for (const b of $$("[data-tw-tab]", back)) b.setAttribute("aria-selected", String(b.dataset.twTab === which));
    for (const p of $$("[data-tw-pane]", back)) p.hidden = p.dataset.twPane !== which;
  };
  for (const b of $$("[data-tw-tab]", back)) b.onclick = () => show(b.dataset.twTab);

  /** Repaint what may have changed. Logged out, the panel closes. */
  function draw() {
    const st = panelState(d);
    if (!st) return close();
    paint(head, headMarkup(st));
    paint(fundBox, fundButtonMarkup(st));
    paint(withdrawBox, withdrawMarkup(st));
    bind();
  }

  function bind() {
    const now = $("[data-backup-now]", back);
    if (now) now.onclick = () => { close(); openBackup(); };
    const off = $("[data-main-off]", back);
    if (off) off.onclick = async () => { await disconnect(); note("wallet", "disconnected"); };
    const f = $("[data-fund]", back);
    if (f) f.onclick = () => void fund();
    const w = $("[data-withdraw]", back);
    if (w) w.onclick = () => void withdraw();
  }

  /** A fund of the typed amount, exactly as typed. The main wallet is connected first, if need be. */
  async function fund() {
    const why = fundBlocked();
    if (why) return toast("err", "Cannot fund", why);
    const text = String(amount.value ?? "").trim();
    let wei = 0n;
    try { wei = parseEth(text); } catch { /* not an amount */ }
    if (wei <= 0n) return toast("err", "Cannot fund", "Enter an amount of ETH.");
    if (!(await mainReady("fund"))) return;
    const c = S.conn;
    if (c && c.balanceWei !== null && wei > c.balanceWei) return toast("err", "Cannot fund", "That is more than your wallet holds.");
    close();
    await (d.startTransfer ?? startTransfer)({ kind: "fund", amountEth: text });
  }

  /** Withdraw all, to the main wallet. It is connected first, if need be; the sequence reads its address. */
  async function withdraw() {
    const why = withdrawBlocked();
    if (why) return toast("err", "Cannot withdraw", why);
    if (!(await mainReady("withdraw"))) return;
    close();
    await (d.startTransfer ?? startTransfer)({ kind: "withdraw" });
  }

  /** A main wallet, connected and on Robinhood Chain: asked for now, if there is none. */
  async function mainReady(kind) {
    if (!S.conn && !(await (d.connectFirst ?? connectFirst)(kind))) return false;
    if (!S.conn) return false;
    if (S.conn.chainId !== CHAIN_ID) {
      try {
        await (d.ensureChain ?? ensureChain)();
      } catch (e) {
        toast("err", "Could not switch network", walletError(e, "wallet_switchEthereumChain"));
        return false;
      }
    }
    return true;
  }

  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  $("[data-x]", back).onclick = close;
  $("[data-backup]", back).onclick = () => { close(); openBackup(); };
  $("[data-logout]", back).onclick = async () => {
    close();
    await session.logout();
    note("wallet", "logged out");
  };
  bind();
  open = { draw, close };
  document.body.appendChild(back);
  release = holdSheet(back, close);
  return { close, draw };
}

/** Repaint the panel if it is open: the balance, the backup, the main wallet or a transfer changed. */
export function renderWalletPanel() {
  if (open) open.draw();
}

/** Whether the panel is open now (for tests). */
export const walletPanelOpen = () => open !== null;

// ------------------------------------------------ the main wallet, asked --

/**
 * Ask a visitor with no main wallet to connect one, before Fund or Withdraw
 * all, and say why. Resolves true once one is connected.
 *
 * @param {"fund" | "withdraw"} kind
 * @param {{ wallets?: typeof wallets, connect?: typeof connect }} [d] tests pass their own
 * @returns {Promise<boolean>}
 */
export function connectFirst(kind, d = {}) {
  const list = (d.wallets ?? wallets)();
  const back = document.createElement("div");
  back.className = "modal";
  paint(back, connectMarkup(kind, list));
  document.body.appendChild(back);
  return new Promise((resolve) => {
    let done = false;
    /** Esc and the focus held inside, from ui.js; focus goes back to Fund or Withdraw all. */
    let release = () => {};
    const shut = () => { release(); back.remove(); };
    const finish = (ok) => {
      if (done) return;
      done = true;
      shut();
      resolve(ok);
    };
    back.addEventListener("click", (e) => { if (e.target === back) finish(false); });
    closeOn(back, () => finish(false));
    for (const w of list) {
      const b = $(`[data-connect-main="${w.uuid}"]`, back);
      if (!b) continue;
      b.onclick = async () => {
        shut();
        try {
          const address = await (d.connect ?? connect)(w.uuid);
          note("wallet", `connected ${short(address)} · ${w.name}`);
          finish(true);
        } catch (e) {
          toast("err", "Could not connect", walletError(e, "eth_requestAccounts"));
          finish(false);
        }
      };
    }
    release = holdSheet(back, () => finish(false));
  });
}

/**
 * The connect sheet's markup: why first, then the wallets found.
 *
 * @param {"fund" | "withdraw"} kind
 * @param {{ uuid: string, name: string, icon: string }[]} list
 */
export function connectMarkup(kind, list) {
  return html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="cf-title" tabindex="-1">
      ${sheetHead("cf-title", "Connect a wallet")}
      <p><b>${WHY_MAIN}</b> ${kind === "fund"
        ? "Fund sends ETH from it to your trading wallet, and Withdraw all sends it back there."
        : "Withdraw all sends everything to it."}</p>
      ${list.length ? html`<div class="wpicks">${list.map((w) => html`<button class="wpick" type="button" data-connect-main="${w.uuid}">
          ${w.icon ? html`<img src="${w.icon}" alt="" width="24" height="24">` : html`<span class="wpav"></span>`}
          <span>${w.name}</span></button>`)}</div>`
        : html`<p>No browser wallet was found. Install one, or open this page in your wallet
          app&rsquo;s own browser.</p>`}
      <p class="sheetnote">This page never holds its key. Your wallet asks you before anything is sent
        from it.</p>
      <div class="mbtns sheetacts"><button class="btn" type="button" data-x>Cancel</button></div>
    </div>`;
}
