import { S } from "./core/store.js";
import { $ } from "./core/dom.js";
import { int, short } from "./core/format.js";
import { onBoardEvent } from "./boardEvents.js";
import { copyText, note, toast } from "./core/ui.js";
import { loadConfig, loadDecisions, loadPositions, loadStats, loadWallet } from "./loaders.js";
import { bindBoard, renderLaunches, showIntro } from "./pages/launches.js";
import { ledgerOpen, renderPositions } from "./pages/positions.js";
import { afterPageTrade, bindLookup } from "./pages/positionsLookup.js";
import {
  connPanel, renderShell, startTradingWallet, startWallet, switchChain, toggleArm, toggleSystem, twPanel, walletPanel,
} from "./pages/shell.js";
import { session } from "./wallet/session.js";
import { refreshRecord } from "./pages/record.js";
import { openShare } from "./card/share.js";
import {
  moreTrades, openTradeSheet, renderToken, renderTokenIfOpen, retryHolders, runCheck, setTokenTab,
} from "./pages/token.js";
import { setChartAxis, setChartTf } from "./pages/tokenChart.js";
import { retryTraders, setTradersWindow } from "./pages/traders.js";
import { go, pathLinks, resolve } from "./router.js";
import { doBuy, doSell, loadPrefs, renderQuickBuy, savePrefs } from "./trade.js";
import { bindFrame, setBuySize } from "./frame.js";
import { CHIP_TARGET, flash, mark, renderAll } from "./wiring.js";
import { setSellWallet, toggleTick } from "./wallets.js";
import { dropBrokenLogo } from "./core/svg.js";
import { onPhoneChange } from "./core/layout.js";
import { showBeta } from "./pages/beta.js";
import { renderAbout } from "./pages/about.js";
import { bindLearn } from "./pages/learn.js";

// Before anything renders: a logo that fails to load is removed (see svg.js).
document.addEventListener("error", dropBrokenLogo, true);

document.addEventListener("click", /** @param {MouseEvent & { target: any }} e */ (e) => {
  // A real link inside a card is the link, not the card. Without this, the
  // Explorer button on a launch card would also re-run the check behind it.
  if (e.target.closest("a[href]")) return;

  // Trade controls sit inside a card that is itself clickable, so they claim
  // the click before the card can turn it into a re-check.
  const buy = e.target.closest("[data-buy]");
  if (buy) {
    e.stopPropagation();
    return doBuy(buy.dataset.buy, buy, buy.dataset.amount ? Number(buy.dataset.amount) : null, buy.dataset.amountEth);
  }
  const sell = e.target.closest("[data-sell]");
  if (sell) {
    e.stopPropagation();
    const run = doSell(sell.dataset.sell, sell.dataset.pct, sell, sell.dataset.wallet);
    // A sell from the Portfolio reads the page again once it has filled (U8).
    if (sell.closest("#plookup")) void Promise.resolve(run).then(afterPageTrade, () => {});
    return run;
  }

  // Which of the console's wallets a buy goes out from (multi-wallet.md).
  const wtick = e.target.closest("[data-wtick]");
  if (wtick) {
    e.stopPropagation();
    toggleTick(wtick.dataset.wtick);
    renderQuickBuy(); renderLaunches(); renderTokenIfOpen();
    return;
  }

  const size = e.target.closest("[data-size]");
  if (size) {
    e.stopPropagation();
    return setBuySize(Number(size.dataset.size));
  }

  const side = e.target.closest("[data-side]");
  if (side) { S.tradeSide = side.dataset.side; return renderToken(); }

  const pick = e.target.closest("[data-pct-pick]");
  if (pick) { S.sellPct = Number(pick.dataset.pctPick); return renderToken(); }

  const from = e.target.closest("[data-sellfrom]");
  if (from) { setSellWallet(from.dataset.sellfrom); return renderToken(); }

  const ledger = e.target.closest("[data-ledger]");
  if (ledger) {
    const k = ledger.dataset.ledger;
    if (ledgerOpen.has(k)) ledgerOpen.delete(k); else ledgerOpen.add(k);
    return renderPositions();
  }

  // The token page's Re-check runs the check again where it is (U4).
  const recheck = e.target.closest("[data-recheck]");
  if (recheck) return void runCheck(recheck.dataset.recheck);

  // Its tabs, and on a phone the bar that opens its trade panel as a sheet.
  // The candle chart's size buttons and its Price / MCap switch (TV2).
  const ctf = e.target.closest("[data-ctf]");
  if (ctf) return setChartTf(ctf.dataset.ctf);
  const caxis = e.target.closest("[data-caxis]");
  if (caxis) return setChartAxis(caxis.dataset.caxis);
  const ttab = e.target.closest("[data-ttab]");
  if (ttab) return setTokenTab(ttab.dataset.ttab);
  // The Trades tab's Load more, and its Try again (X25b).
  if (e.target.closest("[data-tape-more]") || e.target.closest("[data-tape-retry]")) return moreTrades();
  // The Holders tab's Try again (X27b).
  if (e.target.closest("[data-holders-retry]")) return retryHolders();
  // The Traders page's window switch, and its Try again (X29b).
  const trwin = e.target.closest("[data-traders-window]");
  if (trwin) return void setTradersWindow(trwin.dataset.tradersWindow);
  if (e.target.closest("[data-traders-retry]")) return void retryTraders();
  const tsheet = e.target.closest("[data-tsheet]");
  if (tsheet) return openTradeSheet(tsheet.dataset.tsheet);

  const copy = e.target.closest("[data-copy]");
  if (copy) {
    // Remember the label rather than assuming it: these controls show "copy"
    // in one place and a shortened address in another, and a second click
    // during the confirmation must not leave "copied" stuck there forever.
    const original = copy.dataset.copyLabel ?? copy.textContent;
    copy.dataset.copyLabel = original;
    void copyText(copy.dataset.copy).then((ok) => {
      if (!ok) return toast("err", "Could not copy", copy.dataset.copy);
      copy.textContent = "copied";
      copy.classList.add("done");
      clearTimeout(copy._t);
      copy._t = setTimeout(() => {
        copy.textContent = copy.dataset.copyLabel;
        copy.classList.remove("done");
      }, 1200);
    });
    return;
  }

  if (e.target.closest("[data-switch-chain]")) return switchChain();
  if (e.target.closest("#twstay")) return session.stay();
  if (e.target.closest("#tw")) return twPanel();
  if (e.target.closest("#conn")) return connPanel();
  if (e.target.closest("#whoami")) return walletPanel();
  if (e.target.closest("#armsw") || e.target.closest("#ah-sw")) return toggleArm();
  if (e.target.closest("#syssw")) return toggleSystem();
  if (e.target.closest("#syson")) return toggleSystem(true);
  if (e.target.closest("#recrefresh")) return refreshRecord();
  if (e.target.closest("#recshare")) return openShare();
  const shr = e.target.closest("[data-share-token]");
  if (shr) return openShare({ token: shr.dataset.shareToken });

  const chip = e.target.closest(".chip");
  if (chip) {
    const target = CHIP_TARGET[chip.parentElement.id];
    if (target) {
      $(target[0]).dataset[target[1]] = chip.dataset.f ?? chip.dataset.s;
      return mark("#" + chip.parentElement.id, chip);
    }
  }

  // A board row (or a card) opens its token page. Re-running the deep check is a deliberate
  // act with its own button there, not something a stray click pays for.
  const card = e.target.closest("[data-token]");
  if (card) return go("token/" + card.dataset.token);

  const flash = e.target.closest("[data-flash]");
  if (flash) return go("token/" + flash.dataset.flash);

  const target = e.target.closest("[data-go]");
  if (target) return go(target.dataset.go);
});

// The hosted Portfolio: your own positions, any address on request (U5). Its
// markup is in both pages, hidden on a self page.
bindLookup(connPanel, twPanel);

window.addEventListener("hashchange", () => go(location.hash.slice(2), false));

// The token chart is drawn for the width it is shown at, so a phone turning
// across the phone breakpoint redraws it (public-release F5.7).
onPhoneChange(() => renderTokenIfOpen());

// -------------------------------------------------------------------- SSE --
const es = new EventSource("/events");

es.addEventListener("open", () => { S.connected = true; renderShell(); });

es.addEventListener("error", () => { S.connected = false; renderShell(); });

// The board itself: the whole of it, a card changing, a card dropping off,
// and a trade in any token (boardEvents.js).
for (const type of ["snapshot", "row", "evict", "trade"]) {
  es.addEventListener(type, (e) => onBoardEvent(type, JSON.parse(/** @type {MessageEvent} */ (e).data)));
}

es.addEventListener("launch", (e) => {
  const d = JSON.parse(e.data);
  note("launch", short(d.token) + " at block " + int(d.block));
  toast("info", "New launch", short(d.token) + " — checking it now");
});

es.addEventListener("ready", (e) => {
  note("backfill", JSON.parse(e.data).count + " launches loaded");
  renderAll();
});

// Slippage is one setting, in the top bar's popover and on the token page's panel.
$("#qslip").addEventListener("change", () => { savePrefs(); renderTokenIfOpen(); });

// ------------------------------------------------------------------ boot --
// The mode first, before anything awaits. A hosted page is served stamped, so
// its chrome is right from the first paint, and reading the stamp here means no
// SSE message can render a card for the wrong mode either.
S.mode = document.body.dataset.mode === "hosted" ? "hosted" : "self";

// Whether this origin has a trading wallet (public-release W1.2), before any
// card draws its trade reasons. A self page never asks.
if (S.mode === "hosted") session.detect();
// A hosted page's nav points at its paths, /os and /ai (L1 L3), before the first route.
if (S.mode === "hosted") pathLinks();

// The beta badge and notice (F5.3), and the board's first-visit intro (U2).
// Hosted only, like everything above.
showBeta();
showIntro();

loadPrefs();

renderQuickBuy();

// The top bar: the buy-size popover, and search's buttons and keys (U1).
bindFrame();

// Learn's contents: the scroll-spy on About, and a link to the section already named (U6).
bindLearn(go);

go(location.hash.slice(2), false);

for (const id of ["#pchips", "#schips"]) mark(id, $(id + " .chip"));

// The board's toolbar and table heads (U2). Its sort is the one this viewer
// last picked, read on its first render.
bindBoard();
renderLaunches();

// Config is the first request, and it is awaited: it names the features and
// the brand. If it disagrees with the stamp, hosted wins, because the other
// mistake polls a wallet from a public page. If it fails, the stamp stands.
try { await loadConfig(); } catch { /* the stamp decides */ }
if (S.cfg && S.cfg.mode === "hosted" && S.mode !== "hosted") {
  S.mode = "hosted";
  session.detect();
  pathLinks();
  showBeta();
  showIntro();
  go(location.hash.slice(2), false);
}
if (S.mode === "hosted") {
  document.body.dataset.mode = "hosted";
  // The visitor's own wallet. A self page never looks for one.
  void startWallet();
  // The trading wallet, where this origin has one (W1.2). Nothing loads
  // without a login, a return from one, or a remembered session.
  void startTradingWallet();
}
// The hosted app is cumTrade (P2a); the self-hosted console keeps the brand alone.
document.title = S.mode === "hosted" ? `cumTrade · ${S.brand}` : S.brand;
$("#brand").textContent = S.brand;
// The About page names the brand too, and may have been drawn before the config came.
// Drawn again, it goes back to the section the address names (#/learn/terms),
// which what came in above it may have moved.
if ($("#shell").dataset.page === "about") renderAbout(resolve(location.hash.slice(2), S.mode).arg);

// A hosted process has no wallet, positions or decisions of its own. Asking
// for them would only collect 404s.
if (S.mode === "self") {
  loadWallet();

  loadPositions();

  loadDecisions();
}

loadStats();

// Polling. Decisions and stats are local reads. Wallet and positions are
// chain values, and the server keeps them cheap rather than this cadence:
// the balance is cached for a minute, and positions reuse the manager's
// last sweep. Uncached, each open page cost 12 eth_calls a minute for the
// balance and 12 more per open position. See docs/specs/rpc-budget.md.
if (S.mode === "self") {
  setInterval(loadWallet, 5000);

  setInterval(loadPositions, 5000);

  setInterval(loadDecisions, 10000);
}

setInterval(loadStats, 15000);

// Ages and "valued N seconds ago" go stale on their own.
setInterval(() => {
  const page = $("#shell").dataset.page;
  if (page === "launches") renderLaunches();
  if (page === "positions" && S.mode === "hosted") renderPositions();
}, 30000);
