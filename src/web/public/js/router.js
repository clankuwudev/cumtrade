import { S } from "./core/store.js";
import { $, $$ } from "./core/dom.js";
import { loadConfig, loadDecisions } from "./loaders.js";
import { renderActivity } from "./pages/activity.js";
import { renderFlow } from "./pages/flow.js";
import { loadHistory, renderToken, renderTokenIfOpen } from "./pages/token.js";
import { loadRecord } from "./pages/record.js";
import { openLookup } from "./pages/positionsLookup.js";
import { renderAbout } from "./pages/about.js";
import { HOW_IT_WORKS, renderLearn } from "./pages/learn.js";
import { refreshHolding } from "./trade.js";
import { openSearch } from "./pages/search.js";
import { openTraders } from "./pages/traders.js";

// ---------------------------------------------------------------- routing --
// The pages are sections of app.html (#pg-<page>), and keep their names. The
// addresses people see are the redesign's (u-redesign.md, U1): the board at
// #/, #/portfolio, #/learn. Every older address still lands, and the address
// bar is corrected to the new one, so a link shared on X keeps working.

const PAGES = ["launches", "positions", "traders", "sniper", "flow", "activity", "token", "about"];
/** Pages about this process's own wallet, sniper and RPC spend. A hosted page has none of them. */
const SELF_ONLY = ["sniper", "activity"];
/**
 * The public site's About, terms and privacy (public-release F5.3), and the
 * Traders page, whose rows are Portfolios (x29-leaderboard.md, L2). The
 * console has neither.
 */
const HOSTED_ONLY = ["about", "traders"];

// A hosted page is the terminal, cumTrade, at /trade (L1 L3; P2b moved it from /os). cumAI is a page of
// its own at /ai (N-D6, changed by the user): an address that names it here
// leaves for it. The console keeps /.
export const OS_PATH = "/trade";
export const AI_PATH = "/ai";
/** cumAI's tabs as its own page names them, after /ai#/. */
export const AI_TABS = ["models", "docs"];

/** Learn's first section: the Flow page, with About's sections beside it (U6). */
export { HOW_IT_WORKS };

/** The address each page is known by. A page's argument follows it after a slash. */
const ADDRESS = {
  launches: "", positions: "portfolio", traders: "traders", flow: "learn/" + HOW_IT_WORKS, about: "learn",
  token: "token", sniper: "sniper", activity: "activity",
};

/** Which item of the top bar and the tab bar is lit on each page. */
const NAV = {
  launches: "board", token: "board", positions: "portfolio", traders: "traders",
  flow: "learn", about: "learn", sniper: "sniper", activity: "activity",
};

/**
 * The page a route shows, and its argument. New addresses and old ones:
 * #/, #/home, #/launches → the board; #/portfolio… and #/positions… → the
 * positions page; #/learn/how-it-works and #/flow → Flow; #/learn… and
 * #/about… → About on a hosted page. A self page has no About, so Learn is
 * Flow there. The Checker is no page since U4: #/checker is the board with
 * search open (search is the checker), and #/checker/0x… that address's token
 * page, which runs the check. A page the mode does not have, or no page at
 * all, is the board.
 *
 * @param {string} spec what follows "#/", e.g. "token/0x…"
 * @param {string} mode "hosted" or "self"
 * @returns {{ page: string, arg: string, search?: boolean }}
 */
export function resolve(spec, mode) {
  // A query after the route is for whoever made the link, not a page's
  // argument: the gateway's sign-in names #/learn/terms?version=… (L1 N1).
  const [name = "", arg = ""] = String(spec || "").split("?")[0].split("/");
  const hosted = mode === "hosted";
  const to = (page, a = "") => ({ page, arg: a });
  switch (name) {
    case "portfolio": case "positions": return to("positions", arg);
    case "flow": return to("flow");
    case "learn": case "about":
      return !hosted || (name === "learn" && arg === HOW_IT_WORKS) ? to("flow") : to("about", arg);
    case "token": return to("token", arg);
    case "checker": return arg ? to("token", arg) : { ...to("launches"), search: true };
  }
  // #/home is no page (U2 folded Home into the board), so it lands there too.
  const p = PAGES.includes(name) ? name : "launches";
  if ((hosted && SELF_ONLY.includes(p)) || (!hosted && HOSTED_ONLY.includes(p))) return to("launches");
  return to(p);
}

/** The address a page is shown at, with its argument when it keeps one. */
export const addressOf = (page, arg = "") => {
  const base = ADDRESS[page] ?? "";
  return "#/" + (arg ? (base ? base + "/" : "") + arg : base);
};

/** The nav item a page lights, or "" for none. */
export const navOf = (page) => NAV[page] ?? "";

/**
 * Where an address leaves this page for, or null (N-D6, changed): on a hosted
 * page, #/ai (X20's old route) and #/ai/docs are cumAI's own page.
 */
export function leaveFor(spec, mode) {
  if (mode !== "hosted") return null;
  const [name = "", arg = ""] = String(spec || "").split("?")[0].split("/");
  if (name !== "ai") return null;
  return AI_PATH + (AI_TABS.includes(arg) ? "#/" + arg : "");
}

/**
 * A hosted page's nav at its own paths (L1 L3): the top bar's and the tab
 * bar's pages at /trade#/…, whichever of the two paths the page is shown at, and
 * the logo home to the landing. The console's stay as they are.
 */
export function pathLinks(root = document) {
  for (const a of root.querySelectorAll('.tnav a[href^="#/"], .tabbar a[href^="#/"]')) {
    a.setAttribute("href", OS_PATH + a.getAttribute("href"));
  }
  const logo = root.querySelector(".logo");
  if (logo) { logo.setAttribute("href", "/"); logo.setAttribute("aria-label", "Clank Uwu Model, home"); }
}

/** `spec` is an address after "#/", old or new, e.g. "token/0x…". */
export function go(spec, push = true) {
  // An address for cumAI's own page leaves this one, with no entry left behind.
  const away = leaveFor(spec, S.mode);
  if (away) { location.replace(away); return; }
  const { page: p, arg, search } = resolve(spec, S.mode);
  $("#shell").dataset.page = p;
  for (const x of PAGES) $("#pg-" + x).classList.toggle("on", x === p);
  const lit = navOf(p);
  for (const a of $$("[data-nav]")) {
    if (a.dataset.nav === lit) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  // A hosted lookup is a URL too: #/portfolio/0x… (public-release F1.2). So
  // is a section of the About page: #/learn/terms. #/portfolio alone is your
  // own wallet's positions (U5), so it never brings back the last address
  // looked up.
  const hostedLookup = p === "positions" && S.mode === "hosted";
  const keepArg = p === "token" || hostedLookup || p === "about";
  const at = addressOf(p, keepArg ? arg : "");
  if (push) location.hash = at;
  // An old or unknown address says where it landed, without a new history entry.
  else if (location.hash && location.hash !== at) history.replaceState(null, "", at);
  window.scrollTo(0, 0);

  if (p === "sniper") { loadConfig(); loadDecisions(); }
  // The track record is about this process's wallet, so only a self page asks.
  if (p === "positions" && S.mode === "self") void loadRecord();
  if (p === "positions" && S.mode === "hosted") openLookup(arg);
  if (p === "traders") void openTraders();
  if (p === "activity") renderActivity();
  if (p === "flow") renderFlow();
  if (p === "about") renderAbout(arg);
  // Learn's contents, beside How it works and About, the current entry lit (U6).
  if (p === "flow" || p === "about") renderLearn(p, arg);
  // An old Checker link: the board, with search open to paste into.
  if (search) openSearch();
  if (p === "token") {
    S.openToken = arg || S.openToken;
    S.customAmount = "";
    renderToken();
    // The panel is drawn before the balance is read: draw it again once it is.
    if (S.openToken) { void loadHistory(S.openToken); void refreshHolding(S.openToken).then(renderTokenIfOpen); }
  }
}
