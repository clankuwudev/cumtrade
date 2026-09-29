import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { $, $$, html, paint } from "../core/dom.js";
import { XI, eth, n, short } from "../core/format.js";
import { avatar, closeOn, holdSheet, modal, note, refocus, sheetHead, toast } from "../core/ui.js";
import { renderLaunches } from "./launches.js";
import { renderSniper } from "./sniper.js";
import { renderTokenIfOpen } from "./token.js";
import { renderQuickBuy } from "../trade.js";
import { CHAIN_ID } from "../trade/constants.js";
import { systemCopy } from "../core/domain.js";
import { googleIcon, walletIcon, xIcon } from "../core/svg.js";
import {
  connect, disconnect, discover, ensureChain, onChange, reconnect, refreshBalance, walletError, wallets,
} from "../wallet/eip6963.js";
import { IDLE_MS, session } from "../wallet/session.js";
import { offerBackup, watchBackups } from "./backup.js";
import { openWalletPanel, renderWalletPanel } from "./wallet.js";
import { multi, walletList } from "../wallets.js";

// ====================================================================== //
// shell                                                                  //
// ====================================================================== //

export function renderShell() {
  // "Live" is the SSE connection to this process; whether launches actually
  // stream in is the websocket behind it, which is a separate thing to be
  // wrong about — so both are named. The top bar shows the dot; the words are
  // its tooltip, and what a screen reader hears.
  const ws = S.stats ? S.stats.ws : null;
  const off = S.wallet && S.wallet.system && !S.wallet.system.on;
  const [dot, words] = !S.connected ? ["r", "disconnected"]
    : off ? ["n", "Live · system off"]
    : ws === false ? ["a", "Live · polling only"]
    : ["", "Live · websocket"];
  const live = $("#livepill");
  live.title = words;
  paint(live, html`<span class="dot ${dot}"></span><span class="sr">${words}</span>`);

  const price = S.stats && S.stats.price ? S.stats.price.ethUsd : null;
  paint($("#pricepill"), html`ETH <b>${price ? "$" + price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"}</b>${
      S.stats && S.stats.price && S.stats.price.stale ? html` <span class="t4">stale</span>` : ""}`);

  renderSystem();
  renderArmCard();
  renderWhoami();
  renderQuickBuy();
  if (S.mode === "hosted") {
    renderConn();
    renderTw();
    renderTwLock();
    renderWalletPanel();
  }
}

/**
 * The system switch and, while it is off, the banner over every page. Drawn
 * only from the server's reply, never from the click, so a switch that failed
 * to save cannot read as done.
 */
function renderSystem() {
  const sys = S.wallet && S.wallet.system;
  const btn = /** @type {HTMLButtonElement} */ ($("#syssw"));
  btn.disabled = S.sysBusy || !sys;
  if (!sys) return;
  btn.className = "syscard " + (sys.on ? "on" : "off");
  btn.setAttribute("aria-pressed", String(sys.on));
  const copy = systemCopy(sys);
  $("#sysdot").className = "dot " + (sys.on ? "" : "n");
  $("#syslb").textContent = copy.label;
  $("#sysnote").textContent = copy.note;

  $("#sysoff").hidden = sys.on;
  $("#sysoffmsg").textContent = copy.banner ?? "";
  /** @type {HTMLButtonElement} */ ($("#syson")).disabled = S.sysBusy;
}

function renderArmCard() {
  const arm = S.wallet && S.wallet.arm;
  const armed = !!(arm && arm.auto.armed);
  $("#armcard").className = "armcard " + (armed ? "armed" : "safe");
  $("#armsw").setAttribute("aria-pressed", String(armed));
  const off = !!(S.wallet && S.wallet.system && !S.wallet.system.on);

  // The switch is the sniper's. When manual is hot the two disagree, and a
  // card that only reports the sniper would read "Safe" over a wallet that
  // fires real buys on a click — so the safe copy says which is which.
  const manualHot = !!(arm && arm.manual.armed);
  $("#armsafe").textContent = off
    ? "The system is off: no launch is watched and nothing is bought."
    : manualHot
    ? "Sniper is dry run. Your own buys fire instantly — the wallet is hot."
    : "Dry run. Candidates are quoted and simulated, nothing is broadcast.";

  // Armed while off: the arm still lets exits sell, but nothing is bought, and
  // "Buying with a real key" would say otherwise.
  if (off) {
    $("#armdetail").textContent =
      "The system is off, so nothing is bought. Take-profit and stop-loss still sell. " +
      armLife(arm && arm.auto);
  } else if (S.wallet && S.wallet.budget) {
    const b = S.wallet.budget;
    $("#armdetail").textContent =
      `Buying with a real key. ${eth(b.spentEth)} of ${eth(b.budgetEth)} ${XI} committed, ` +
      `${b.positions} of ${b.maxPositions} slots used. ` + armLife(arm && arm.auto);
  }
}

/** How long an arm has left, or that it has no clock at all. */
export const armLife = (a) =>
  !a || !a.armed ? "" :
  !a.expires ? "No expiry — disarm by hand." :
  `Disarms itself in ${Math.ceil(a.expiresInSec / 60)}m.`;

function renderWhoami() {
  const av = $("#whoav"), name = $("#whoname"), addr = $("#whoaddr"), lk = $("#wholk");
  if (!S.wallet || !S.wallet.hasKeystore) {
    av.textContent = "··";
    name.textContent = "No keystore";
    addr.textContent = "npm run wallet hot";
    lk.textContent = "";
    return;
  }
  const a = S.wallet.address || S.wallet.keystoreAddress || "";
  av.textContent = a.slice(2, 4).toLowerCase();
  lk.textContent = S.wallet.unlocked ? "Lock" : "Unlock";
  // Several wallets: how many, and what they hold between them (multi-wallet.md).
  if (multi()) {
    name.textContent = S.wallet.unlocked
      ? `${walletList().length} wallets · ${S.wallet.totalEth ? eth(S.wallet.totalEth) : "…"} ${XI}`
      : "Locked";
    addr.textContent = `main ${short(a)}`;
    return;
  }
  name.textContent = S.wallet.unlocked
    ? (S.wallet.balanceEth ? eth(S.wallet.balanceEth) + " " + XI : "Unlocked")
    : "Locked";
  addr.textContent = short(a);
}

// ------------------------------------------------------ visitor wallet --
// A hosted page's chip is the visitor's own wallet (public-release F2). The
// self chip above is the server's keystore; the two never render together.

const ethOf = (wei) => eth(Number(wei) / 1e18);

function renderConn() {
  const c = S.conn;
  const chip = $("#conn"), av = $("#connav"), name = $("#connname"), addr = $("#connaddr"), lk = $("#connlk");
  // Where there is a trading wallet, this one never trades (TW3), and has no
  // chip of its own: it is the trading wallet's panel that asks for it, at
  // Fund or Withdraw all (W2.2). A wallet login connects it already.
  chip.hidden = S.login.here === true;
  if (chip.hidden) return;
  // Not connected, the chip is the button that connects: the primary style.
  chip.classList.toggle("out", !c);
  if (!c) {
    paint(av, walletIcon(18));
    name.textContent = "Connect wallet";
    addr.textContent = "Robinhood Chain";
    lk.textContent = "";
    delete lk.dataset.switchChain;
    chip.title = "Connect the wallet you trade from";
    return;
  }
  paint(av, avatar(c.address, "sm"));
  addr.textContent = short(c.address);
  chip.title = `${c.info.name} · ${c.address}`;
  if (c.chainId !== CHAIN_ID) {
    name.textContent = "Wrong network";
    lk.textContent = "Switch";
    lk.dataset.switchChain = "";
  } else {
    name.textContent = c.balanceWei === null ? "…" : `${ethOf(c.balanceWei)} ${XI}`;
    lk.textContent = "";
    delete lk.dataset.switchChain;
  }
}

/** Ask the connected wallet to move to Robinhood Chain. */
export async function switchChain() {
  try {
    await ensureChain();
    note("wallet", "switched to Robinhood Chain");
  } catch (e) {
    toast("err", "Could not switch network", walletError(e, "wallet_switchEthereumChain"));
  }
}

/** The visitor's wallet panel: a picker when nothing is connected, the connection otherwise. */
export function connPanel() {
  const c = S.conn;
  const list = wallets();
  const back = document.createElement("div");
  back.className = "modal";
  paint(back, html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="conn-title" tabindex="-1">
      ${sheetHead("conn-title", c ? "Your wallet" : "Connect a wallet")}
      ${c ? html`<div class="sheetcard">
        <div class="wrow"><span class="k">Wallet</span><span class="v">${c.info.name}</span></div>
        <div class="wrow"><span class="k">Address</span>
          <span class="v mo" title="${c.address}">${c.address}</span>
          <button class="addrcopy" type="button" data-copy="${c.address}">copy</button></div>
        <div class="wrow"><span class="k">Network</span>
          <span class="v">${c.chainId === CHAIN_ID ? "Robinhood Chain" : html`<span class="amb">Chain ${c.chainId}</span>`}</span>
          ${c.chainId === CHAIN_ID ? "" : html`<button class="btn sm pri" type="button" data-switch-chain>Switch to Robinhood Chain</button>`}</div>
        <div class="wrow"><span class="k">Balance</span>
          <span class="v">${c.chainId !== CHAIN_ID ? "—" : c.balanceWei === null ? "reading…" : `${ethOf(c.balanceWei)} ${XI}`}</span></div>
      </div>` : list.length ? html`
        <div class="wpicks">${list.map((w) => html`<button class="wpick" type="button" data-connect="${w.uuid}">
            ${w.icon ? html`<img src="${w.icon}" alt="" width="24" height="24">` : html`<span class="wpav"></span>`}
            <span>${w.name}</span></button>`)}</div>
      ` : html`<p>No browser wallet was found. Install one, or open this page in your wallet
          app&rsquo;s own browser.</p>`}
      <p class="sheetnote">This page never holds a key. Connecting reads your address and
        balance through your wallet, and nothing is sent unless your wallet asks you first.</p>
      <div class="mbtns sheetacts">
        <button class="btn" type="button" data-x>Close</button>
        ${c ? html`<button class="btn danger" type="button" data-disconnect>Disconnect</button>` : ""}
      </div>
    </div>`);

  document.body.appendChild(back);
  /** Esc and the focus held inside (ui.js); focus goes back to the wallet button. */
  let release = () => {};
  const close = () => { release(); back.remove(); };
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  closeOn(back, close);
  release = holdSheet(back, close);
  // The switch itself is handled with the chip's, in main.js; this only closes
  // a panel that would be stale once the chain moves.
  for (const b of $$("[data-switch-chain]", back)) b.addEventListener("click", close);

  for (const b of $$("[data-connect]", back)) {
    b.onclick = async () => {
      close();
      try {
        await connect(b.dataset.connect);
        const now = S.conn;
        note("wallet", `connected ${short(now.address)} · ${now.info.name}`);
        if (now.chainId !== CHAIN_ID) {
          toast("warn", "Wrong network", "Your wallet is on another chain. Switch to Robinhood Chain to trade.");
        }
      } catch (e) {
        toast("err", "Could not connect", walletError(e, "eth_requestAccounts"));
      }
    };
  }

  const off = $("[data-disconnect]", back);
  if (off) off.onclick = async () => {
    close();
    await disconnect();
    note("wallet", "disconnected");
  };
}

/** How often a visible tab re-reads a wallet's balance on its own (D1.0). */
const BALANCE_POLL_MS = 3 * 60_000;

/**
 * Keep a balance current while the tab is visible: when the tab is shown or
 * the window focused, and every 3 minutes. Only our own sends and an outside
 * deposit move it, and our sends refresh it themselves (trade.js), so the
 * 30s poll this replaces mostly read the same number again (D1.0). Showing a
 * tab also focuses its window, so the second of the two is dropped.
 *
 * @param {() => Promise<unknown>} refresh
 */
function keepBalance(refresh) {
  const visible = () => document.visibilityState === "visible";
  let last = 0;
  const read = () => {
    if (!visible() || Date.now() - last < 2_000) return;
    last = Date.now();
    void refresh();
  };
  setInterval(read, BALANCE_POLL_MS);
  document.addEventListener("visibilitychange", read);
  window.addEventListener("focus", read);
}

/**
 * Start the visitor's wallet on a hosted page: find installed wallets,
 * silently reconnect the one this browser used last, and keep the balance
 * current while the tab is visible.
 */
export async function startWallet() {
  onChange(() => { renderShell(); renderLaunches(); });
  await discover();
  try { await reconnect(); } catch { /* a remembered wallet that fails just stays disconnected */ }
  keepBalance(refreshBalance);
}

// ------------------------------------------------------ trading wallet --
// The trading wallet's chip, login sheet and idle lock (public-release W1.2),
// only on a hosted page whose origin has a pinned Coinbase project. There,
// `#conn` above is hidden: the visitor's own wallet never trades (TW3), and
// the panel (pages/wallet.js) connects it for Fund and Withdraw all.

/** How each login reads in a sentence ("logged in with …"), and on its own. */
const WITH = { google: "Google", x: "X", wallet: "a wallet" };
const LOGIN = { google: "Google", x: "X", wallet: "Wallet" };
/** What the chip says while a login or logout is under way. */
const UNDER_WAY = { restoring: "Logging in…", redirecting: "Leaving to log in…", signing: "Sign in your wallet", leaving: "Logging out…" };
const IDLE_MINUTES = Math.round(IDLE_MS / 60_000);

/** Seconds as m:ss. */
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function renderTw() {
  const chip = $("#tw");
  const L = S.login;
  chip.hidden = !L.here;
  const t = S.trading;
  const av = $("#twav"), name = $("#twname"), addr = $("#twaddr"), lk = $("#twlk");
  // Logged out, the chip is the page's one Log in button, drawn as one.
  chip.classList.toggle("out", !t);
  if (!t) {
    paint(av, walletIcon(18));
    name.textContent = UNDER_WAY[L.phase] ?? "Log in";
    addr.textContent = "Trade in one click";
    lk.textContent = "";
    chip.title = "Log in to trade";
    return;
  }
  paint(av, avatar(t.address, "sm"));
  name.textContent = L.phase === "leaving" ? UNDER_WAY.leaving
    : t.balanceWei === null ? "…" : `${ethOf(t.balanceWei)} ${XI}`;
  addr.textContent = short(t.address);
  lk.textContent = L.countdown !== null ? mmss(L.countdown) : "";
  chip.title = `Trading wallet${t.method ? ` · ${LOGIN[t.method]}` : ""} · ${t.address}`;
}

/** The idle lock's banner: its countdown, or that it waits for a trade. */
function renderTwLock() {
  const box = $("#twlock");
  const L = S.login;
  const show = !!(L.here && S.trading && (L.countdown !== null || L.waiting));
  box.hidden = !show;
  if (!show) return;
  paint($("#twlockmsg"), L.waiting
    ? html`<b>Logging out after the trade in progress.</b> No activity for ${IDLE_MINUTES} minutes.`
    : html`<b>Logging out in ${mmss(L.countdown)}.</b> No activity for ${IDLE_MINUTES - 1} minutes.`);
}

/** The trading-wallet chip: the login sheet when logged out, its panel when logged in. */
export function twPanel() {
  if (!S.login.here) return;
  if (S.trading) return void openWalletPanel();
  if (S.login.phase !== "idle") return;
  loginSheet();
}

function loginSheet() {
  const last = session.lastMethod();
  const back = document.createElement("div");
  back.className = "modal";
  /** Esc and the focus held inside (ui.js); focus goes back to Log in. */
  let release = () => {};
  const close = () => { release(); back.remove(); };

  const picks = () => {
    const list = wallets();
    return list.length ? html`<div class="wpicks">${list.map((w) => html`<button class="wpick" type="button" data-login="wallet" data-uuid="${w.uuid}">
          ${w.icon ? html`<img src="${w.icon}" alt="" width="24" height="24">` : html`<span class="wpav"></span>`}
          <span>${w.name}</span></button>`)}</div>
        <p>Your wallet signs one message to log you in.</p>`
      : html`<p>No browser wallet was found. Install one, or open this page in your wallet
          app&rsquo;s own browser.</p>`;
  };

  /**
   * The three ways in, or (`picking`) F2's list of wallets. The ✕ and Esc
   * close the sheet from either; Back, under the list, returns to the three.
   */
  const draw = (picking) => {
    paint(back, html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="login-title" tabindex="-1">
        ${sheetHead("login-title", "Log in to trade")}
        <p>Logging in gives you a trading wallet, made by Coinbase and tied to your login. It signs
          your trades here without a pop-up.</p>
        ${picking ? picks() : html`<div class="wpicks">
          <button class="wpick" type="button" data-login="google"><span class="wpav ic g">${googleIcon()}</span><span>Continue with Google</span></button>
          <button class="wpick" type="button" data-login="x"><span class="wpav ic">${xIcon()}</span><span>Continue with X</span></button>
          <button class="wpick more" type="button" data-pick-wallet><span class="wpav ic">${walletIcon()}</span><span>Continue with a wallet</span></button>
        </div>`}
        ${last ? html`<p>This browser last logged in with ${WITH[last]}. Each way of logging in has its
          own wallet.</p>` : ""}
        <p class="sheetnote">Don't log in on a shared or public computer. Logging out here does
          not log you out of Google or X.</p>
        <div class="mbtns sheetacts">${picking ? html`<button class="btn" type="button" data-back>Back</button>`
          : html`<button class="btn" type="button" data-x>Close</button>`}</div>
      </div>`);
    closeOn(back, close);
    const backTo = $("[data-back]", back);
    if (backTo) backTo.onclick = () => draw(false);
    const pick = $("[data-pick-wallet]", back);
    if (pick) pick.onclick = () => draw(true);
    for (const b of $$("[data-login]", back)) {
      b.onclick = () => { close(); void logIn(b.dataset.login, b.dataset.uuid); };
    }
    // The button pressed went with the old box: focus comes back to the new one.
    refocus(back);
  };

  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  draw(false);
  document.body.appendChild(back);
  release = holdSheet(back, close);
}

async function logIn(method, uuid) {
  try {
    const address = await session.login(method, uuid ? { uuid } : {});
    if (address) note("wallet", `logged in · ${short(address)}`);
  } catch (e) {
    toast("err", "Could not log in", walletError(e));
  }
}

/**
 * Start the trading wallet on a hosted page (W1.2): take up a returning or
 * remembered login, start the idle lock, and keep the balance current while
 * the tab is visible. On an origin with no pinned project it does nothing.
 */
export async function startTradingWallet() {
  session.on((type, detail) => {
    if (type === "out" && detail) {
      if (detail.reason === "idle") toast("info", "Logged out", `No activity for ${IDLE_MINUTES} minutes.`);
      else if (detail.elsewhere && detail.reason === "user") toast("info", "Logged out", "You logged out in another tab.");
      else if (detail.reason !== "user") toast("info", "Logged out", "Your login ended. Log in again to trade.");
    }
    if (type === "error") toast("err", "Trading wallet", String(detail));
    renderShell();
    renderLaunches();
    renderTokenIfOpen();
    // A trading address with no backup confirmation here gets the sheet (W4).
    offerBackup();
  });
  await session.boot();
  if (!S.login.here) return;
  // A backup confirmed here or in another tab changes every card's reason (W4).
  watchBackups(() => { renderShell(); renderLaunches(); renderTokenIfOpen(); });
  keepBalance(session.refreshBalance);
}

/**
 * The wallet panel.
 *
 * Lock/unlock used to be the whole interaction, which meant swapping the
 * signing key was a terminal round trip plus a restart. It lives here now.
 */
export function walletPanel() {
  const w = S.wallet || {};
  const addr = w.address || w.keystoreAddress || "";
  const hot = w.arm && w.arm.hot && w.arm.hot.length;

  const back = document.createElement("div");
  back.className = "modal";
  // The wallet list and its forms can outgrow a short window: the box scrolls.
  paint(back, html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="kw-title" tabindex="-1"
      style="width:min(540px,100%)">
      ${sheetHead("kw-title", "Wallet")}

      ${w.hasKeystore ? html`
        <div class="wrow"><span class="k">Address</span>
          <span class="v mo">${addr}</span>
          <span class="copy" data-copy="${addr}">copy</span></div>
        <div class="wrow"><span class="k">Balance</span>
          <span class="v">${w.unlocked ? eth(w.balanceEth) + " " + XI : "—"}</span></div>
        <div class="wrow"><span class="k">State</span>
          <span class="v">${w.unlocked
            ? (hot ? html`<span class="grn">unlocked · hot (${w.arm.hot.join(" + ")})</span>`
                   : html`<span class="grn">unlocked</span>`)
            : html`<span class="t3">locked</span>`}</span>
          <button class="btn sm" data-wlock>${w.unlocked ? "Lock" : "Unlock"}</button></div>
      ` : html`<p style="margin:0">No keystore yet. Generate one below, or import a key you
          already have.</p>`}

      ${w.hasKeystore ? walletsSection() : ""}

      <div class="tpdiv"></div>

      ${multi() ? html`<p style="margin:0;font-size:11.5px">Replacing main is a terminal command while
        other wallets are here: they share its passphrase, so run
        <span class="mo">npm run wallet import</span> with that same passphrase.</p>` : html`
      <h3 style="font-size:14px">${w.hasKeystore ? "Replace this wallet" : "Set up a wallet"}</h3>
      <p style="margin:0">Generating happens on the server, so no key touches this page.
        Importing means pasting one in — a browser extension can read that, a terminal
        prompt cannot. Burner only.</p>

      <div class="wseg">
        <button data-wmode="generate" class="on">Generate new</button>
        <button data-wmode="import">Import a key</button>
      </div>

      <input id="wkey" type="password" placeholder="0x… private key" autocomplete="off"
        spellcheck="false" style="display:none">

      <div id="wconfirm" style="display:none">
        <p style="margin:0;color:#ff8a84"><b>That wallet still holds funds.</b> Replacing it
          destroys the only copy of its key. Back it up first with
          <span class="mo">npm run wallet export</span>.</p>
        <input id="waddr" type="text" placeholder="type the address to confirm"
          autocomplete="off" spellcheck="false" style="margin-top:9px">
      </div>`}

      <div class="mbtns sheetacts">
        <button class="btn" type="button" data-x>Close</button>
        ${multi() ? "" : html`<button class="btn pri" type="button" data-wgo>Generate new wallet</button>`}
      </div>
      <p style="margin:0;font-size:10.5px;color:var(--tx4);line-height:1.5">Getting a key back
        <i>out</i> stays a terminal command — <span class="mo">npm run wallet export</span>.
        The token behind this page can spend, but only inside the caps; it cannot hand out the key.</p>
    </div>`);

  document.body.appendChild(back);
  /** Esc and the focus held inside (ui.js); focus goes back to the wallet card. */
  let release = () => {};
  const close = () => { release(); back.remove(); };
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  closeOn(back, close);
  release = holdSheet(back, close);

  let mode = "generate";
  const keyInput = $("#wkey", back);
  const goBtn = $("[data-wgo]", back);

  for (const b of $$("[data-wmode]", back)) {
    b.onclick = () => {
      mode = b.dataset.wmode;
      for (const o of $$("[data-wmode]", back)) o.classList.toggle("on", o === b);
      keyInput.style.display = mode === "import" ? "" : "none";
      goBtn.textContent = mode === "import" ? "Import and replace" : "Generate new wallet";
      if (mode === "import") keyInput.focus();
    };
  }

  const lockBtn = $("[data-wlock]", back);
  if (lockBtn) lockBtn.onclick = async () => { close(); await toggleLock(); };

  if (w.hasKeystore) bindWallets(back, close);
  // Several wallets: main is replaced from the terminal, so there is no button.
  if (!goBtn) return;

  goBtn.onclick = async () => {
    const body = { mode };
    if (mode === "import") {
      if (!keyInput.value.trim()) return toast("err", "No key", "Paste a private key first.");
      body.privateKey = keyInput.value.trim();
    }
    const confirmAddr = $("#waddr", back);
    if (confirmAddr && confirmAddr.value.trim()) body.confirmAddress = confirmAddr.value.trim();

    goBtn.classList.add("busy");
    try {
      const r = await api("/api/wallet/replace", body);
      // Clear the pasted key as soon as it has left, so it is not sitting in
      // a DOM node for the rest of the session.
      keyInput.value = "";

      if (r.status === 409 && r.data.needsAddress) {
        $("#wconfirm", back).style.display = "";
        return toast("warn", "That wallet holds funds",
          `Type ${short(r.data.address)} to confirm you mean to destroy it.`);
      }
      if (r.status !== 200) return toast("err", "Could not replace the wallet", r.data.error || "");

      S.wallet = r.data.wallet;
      renderShell(); renderSniper(); renderTokenIfOpen();
      note("wallet", `replaced — now ${short(r.data.address)}`);
      toast("ok", r.data.generated ? "New wallet generated" : "Wallet imported",
        `${r.data.address} · ${r.data.unlocked ? "unlocked and armed" : "locked"}` +
        (r.data.generated ? " — fund it to trade" : ""));
      close();
    } finally { goBtn.classList.remove("busy"); }
  };
}

// ------------------------------------------------- the console's wallets --
// Every wallet the console holds (multi-wallet.md), and the forms that add
// and remove one. They are for your own buys and sells: the sniper stays on
// main. A key is typed into a password field, read once, and the field is
// emptied before the request goes: it is never kept in page state, and the
// server never sends it back.

const walletState = (x) =>
  x.unlocked ? (x.balanceEth === null ? "…" : `${eth(x.balanceEth, 4)} ${XI}`)
  : x.error ? html`<span class="amb" title="${x.error}">did not open</span>`
  : html`<span class="t3">locked</span>`;

function walletsSection() {
  const ws = walletList();
  return html`
    <div class="tpdiv"></div>
    <h3 style="font-size:14px">Wallets</h3>
    <p style="margin:0;font-size:11.5px">A buy is split evenly across the wallets you tick, each sending
      its own transaction. One daily cap covers them all. The sniper and its exits stay on main.</p>
    ${ws.map((x) => html`<div class="wrow">
        <span class="k" style="width:auto;min-width:48px">${x.label}</span>
        <span class="v mo" title="${x.address}">${short(x.address)}</span>
        <span class="v">${walletState(x)}</span>
        ${x.main ? "" : html`<button class="btn sm" data-wremove="${x.label}">Remove</button>`}
      </div>${x.error ? html`<p style="margin:0;font-size:11px;color:var(--amb)">${x.label}: ${x.error}</p>` : ""}`)}

    <div id="wrmform" style="display:none">
      <p style="margin:0;color:#ff8a84" id="wrmtext"></p>
      <input id="wrmpass" type="password" placeholder="wallet passphrase" autocomplete="off" spellcheck="false" style="margin-top:9px">
      <input id="wrmaddr" type="text" placeholder="type its address to confirm" autocomplete="off"
        spellcheck="false" style="margin-top:9px;display:none">
      <div class="mbtns" style="margin-top:9px">
        <button class="btn" data-wrmcancel>Cancel</button>
        <button class="btn pri" data-wrmgo>Remove</button>
      </div>
    </div>

    <h3 style="font-size:14px;margin-top:6px">Add a wallet</h3>
    <p style="margin:0;font-size:11.5px">A private key you already hold. It is encrypted on this machine
      with the wallet passphrase and never shown again. A browser extension can read a pasted key, a
      terminal prompt cannot: <span class="mo">npm run wallet add &lt;label&gt;</span> does the same. Burner only.</p>
    <input id="walabel" type="text" placeholder="label: a-z, 0-9 and -" autocomplete="off" spellcheck="false" maxlength="24">
    <input id="wakey" type="password" placeholder="0x… private key" autocomplete="off" spellcheck="false">
    ${S.wallet && S.wallet.arm && S.wallet.arm.hot && S.wallet.arm.hot.length
      ? html`<p style="margin:0;font-size:11.5px" class="t4">Hot mode: the console uses the passphrase it already holds.</p>`
      : html`<input id="wapass" type="password" placeholder="wallet passphrase (main's)" autocomplete="off" spellcheck="false">`}
    <div class="mbtns" style="margin-top:0"><button class="btn pri" data-wadd>Add wallet</button></div>`;
}

/** Reread the wallet and redraw what shows it, then reopen the panel on the new state. */
async function refreshWalletPanel(close) {
  const r = await api("/api/wallet");
  if (r.status === 200) S.wallet = r.data;
  renderShell(); renderSniper(); renderTokenIfOpen(); renderLaunches();
  close();
  walletPanel();
}

function bindWallets(back, close) {
  const addBtn = $("[data-wadd]", back);
  if (addBtn) addBtn.onclick = async () => {
    const labelIn = $("#walabel", back), keyIn = $("#wakey", back);
    // No passphrase field in hot mode: the server uses the one it holds.
    const passIn = /** @type {HTMLInputElement | null} */ (back.querySelector("#wapass"));
    // Read once, and empty the fields before anything is sent, whatever comes back.
    const body = { label: labelIn.value.trim(), privateKey: keyIn.value.trim(), passphrase: passIn ? passIn.value : "" };
    keyIn.value = "";
    if (passIn) passIn.value = "";
    if (!body.label || !body.privateKey || (passIn && !body.passphrase)) {
      return toast("err", "Not added", passIn
        ? "A label, a private key and the passphrase are all needed."
        : "A label and a private key are both needed.");
    }
    addBtn.classList.add("busy");
    let r;
    try { r = await api("/api/wallet/add", body); }
    finally {
      body.privateKey = "";
      body.passphrase = "";
      addBtn.classList.remove("busy");
    }
    if (r.status !== 200) return toast("err", "Not added", r.data.error || "");
    note("wallet", `added ${r.data.label} · ${short(r.data.address)}`);
    toast("ok", `Added ${r.data.label}`, `${r.data.address} — fund it with gas money before it trades.`);
    await refreshWalletPanel(close);
  };

  const form = $("#wrmform", back);
  let removing = "";
  for (const b of $$("[data-wremove]", back)) {
    b.onclick = () => {
      removing = b.dataset.wremove;
      const x = walletList().find((y) => y.label === removing);
      if (!x) return;
      // A wallet holding ETH, or whose balance is not known, needs its address typed back.
      const funded = x.balanceEth === null || n(x.balanceEth) > 0;
      $("#wrmtext", back).textContent = `Remove ${x.label} (${short(x.address)})? This deletes its keystore, ` +
        "the only copy of its key in this console." + (funded ? " It holds ETH: move it out first, or type its address." : "");
      $("#wrmaddr", back).style.display = funded ? "" : "none";
      form.style.display = "";
      $("#wrmpass", back).focus();
    };
  }
  const cancel = $("[data-wrmcancel]", back);
  if (cancel) cancel.onclick = () => { form.style.display = "none"; $("#wrmpass", back).value = ""; };
  const go = $("[data-wrmgo]", back);
  if (go) go.onclick = async () => {
    const passIn = $("#wrmpass", back), addrIn = $("#wrmaddr", back);
    const body = { label: removing, passphrase: passIn.value, confirmAddress: addrIn.value.trim() };
    passIn.value = "";
    go.classList.add("busy");
    let r;
    try { r = await api("/api/wallet/remove", body); }
    finally { body.passphrase = ""; go.classList.remove("busy"); }
    if (r.status === 409 && r.data.needsAddress) {
      addrIn.style.display = "";
      return toast("warn", `${removing} holds funds`, `Type ${short(r.data.address)} to confirm you mean to delete its key.`);
    }
    if (r.status !== 200) return toast("err", "Not removed", r.data.error || "");
    note("wallet", `removed ${r.data.label} · ${short(r.data.address)}`);
    toast("info", `Removed ${r.data.label}`, `${r.data.address} is no longer one of this console's wallets.`);
    await refreshWalletPanel(close);
  };
}

async function toggleLock() {
  if (!S.wallet || !S.wallet.hasKeystore) {
    return walletPanel();
  }
  if (S.wallet.unlocked) {
    const r = await api("/api/wallet/lock", {});
    S.wallet = r.data;
    renderShell(); renderSniper();
    note("wallet", "locked");
    return toast("info", "Wallet locked", "Both switches cleared.");
  }
  // Hot mode: the server already holds the passphrase, so unlocking is one
  // click. Prompting here would ask for the exact thing hot mode exists to
  // stop asking for.
  if (S.wallet.arm && S.wallet.arm.hot && S.wallet.arm.hot.length) {
    const r = await api("/api/wallet/unlock", {});
    if (r.status !== 200) return toast("err", "Unlock failed", r.data.error || "");
    S.wallet = r.data;
    renderShell(); renderSniper();
    note("wallet", "unlocked " + short(S.wallet.address));
    return toast("ok", "Wallet unlocked",
      `Hot: ${S.wallet.arm.hot.join(" + ")} armed again.`);
  }

  modal({
    title: "Unlock trading wallet",
    body: (S.wallet.keystoreAddress || "") +
      " — the passphrase stays in this process and is never stored.",
    placeholder: "passphrase", confirmText: "Unlock",
    onConfirm: async (pass) => {
      if (!pass) return;
      const r = await api("/api/wallet/unlock", { passphrase: pass });
      if (r.status !== 200) return toast("err", "Unlock failed", r.data.error || "");
      S.wallet = r.data;
      renderShell(); renderSniper();
      note("wallet", "unlocked " + short(S.wallet.address));
      toast("ok", "Wallet unlocked", "Both switches start safe.");
    },
  });
}

/**
 * Switch the system on or off. `on` defaults to the opposite of what the
 * server last said.
 *
 * @param {boolean} [on]
 */
export async function toggleSystem(on) {
  if (S.sysBusy || !S.wallet || !S.wallet.system) return;
  const next = on ?? !S.wallet.system.on;
  S.sysBusy = true;
  renderShell();
  try {
    const r = await api("/api/system", { on: next });
    if (r.status !== 200) return toast("err", "Could not switch", r.data.error || "");
    S.wallet = { ...S.wallet, system: r.data };
    note("system", next ? "switched on" : "switched off");
    const copy = systemCopy(r.data);
    toast(next ? "ok" : "info", copy.label,
      next ? "Watching launches again. The board catches up now; launches from while it was off are shown, never bought."
        : copy.banner);
  } finally {
    S.sysBusy = false;
    renderShell(); renderSniper();
  }
}

export async function toggleArm() {
  const on = !(S.wallet && S.wallet.arm && S.wallet.arm.auto.armed);
  const r = await api("/api/wallet/arm", { kind: "auto", on });
  if (r.status !== 200) {
    // Usually a locked wallet, and the server says so plainly — surface its
    // words rather than a guess.
    return toast("err", "Could not change arm state", r.data.error || "");
  }
  S.wallet = r.data;
  renderShell(); renderSniper();
  note("sniper", on ? "armed" : "disarmed");
  toast(on ? "warn" : "info",
    on ? "Sniper ARMED" : "Sniper safe",
    on ? `Spending is capped at ${eth(S.wallet.budget.budgetEth)} ${XI} over ` +
         `${S.wallet.budget.maxPositions} slots. ` + armLife(S.wallet.arm.auto)
       : "Back to dry run. Nothing will be broadcast.");
}
