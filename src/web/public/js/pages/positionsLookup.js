import { S, rows } from "../core/store.js";
import { openLedgerShare } from "../card/share.js";
import { AMB, DIM, EXPLORER, GRN, RED } from "../core/constants.js";
import { $, html, paint } from "../core/dom.js";
import { initials, verdictPill } from "../core/domain.js";
import { ago, cap1, dur, durExact, millions, n, pc, short, sign, usd } from "../core/format.js";
import { ring } from "../core/svg.js";
import { heldFrom, sellButtons, trader } from "../trade.js";
import { onChange } from "../wallet/eip6963.js";
import { session } from "../wallet/session.js";
import { flagRow, gradCell, verdictBadge } from "./launches.js";
import { feeLedger, ledgerKey, ledgerOpen } from "./positions.js";
import { loadRank, rankLine } from "./traders.js";

// ====================================================================== //
// positions for any address (hosted)                                     //
// ====================================================================== //
//
// The hosted Portfolio (u-redesign.md, U5; public-release F1.2): the server
// rebuilds an address's positions from the chain (`GET /api/ledger`, B3.5)
// and this draws them. Your own wallet's are shown at once; any other
// address is a lookup, read only, at its own URL, `#/portfolio/0x…`, so it
// can be shared. Nothing here sells for you, and the page says so where a
// self page shows the exit manager's next rule: on your own wallet the rows
// carry the board's 50% and All, which you press.

/** Whether `a` is an address: 0x and 40 hex digits. */
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? "").trim());

/** A busy node is tried again this many times, since the server keeps what it read. */
const RETRIES = 5;

/**
 * The lookup's engine, with no page: which address, where its request is, and
 * the answer or the reason there is none. Timers and the request are
 * injected, so tests drive it. `start`'s `fresh` asks the server for the
 * newest blocks, not its cached ledger (D1.0): the address has just traded.
 *
 * @param {{
 *   fetch: (address: string, fresh?: boolean) => Promise<{ status: number, data: any, retryAfter?: number }>,
 *   render: () => void,
 *   now?: () => number,
 *   after?: (ms: number, fn: () => void) => unknown,
 *   every?: (ms: number, fn: () => void) => unknown,
 *   cancel?: (t: unknown) => void,
 * }} d
 */
export function createLookup(d) {
  const now = d.now ?? (() => Date.now());
  const after = d.after ?? ((ms, fn) => setTimeout(fn, ms));
  const every = d.every ?? ((ms, fn) => setInterval(fn, ms));
  const cancel = d.cancel ?? ((t) => { clearTimeout(/** @type {any} */ (t)); clearInterval(/** @type {any} */ (t)); });
  let seq = 0;
  /** @type {unknown[]} */
  let timers = [];
  const stop = () => { timers.forEach(cancel); timers = []; };
  const set = (patch) => { S.lookup = { ...S.lookup, ...patch }; };

  async function start(address, attempt = 0, fresh = false) {
    stop();
    const a = String(address ?? "").trim();
    const my = ++seq;
    if (!isAddress(a)) {
      set({ address: a, state: "error", data: null, error: {
        kind: "bad", text: "That is not an address. Paste one that starts with 0x and has 40 characters after it." } });
      return d.render();
    }
    // The same address again keeps what it showed while it is read again.
    const keep = S.lookup.address && S.lookup.address.toLowerCase() === a.toLowerCase() ? S.lookup.data : null;
    set({ address: a, state: "loading", data: keep, error: null, startedAt: now(), attempt });
    d.render();
    timers.push(every(1000, () => { if (my === seq) d.render(); }));

    /** @type {{ status: number, data: any, retryAfter?: number }} */
    const r = await d.fetch(a, fresh).catch(() => ({ status: 0, data: {}, retryAfter: undefined }));
    if (my !== seq) return; // another lookup started meanwhile
    stop();
    const wait = Math.max(1, Math.round(n(r.retryAfter ?? r.data?.retryAfter) || 30));

    if (r.status === 200 && r.data && Array.isArray(r.data.open)) {
      set({ state: "ok", data: r.data, error: null, readAt: now() });
    } else if (r.status === 503 && attempt < RETRIES) {
      // The node refused part way. The server keeps what it read, so the
      // next attempt carries on from there (B3.3).
      set({ state: "waiting", error: { kind: "busy", retryAfter: wait,
        text: `The chain's history node is busy. Trying again in ${wait}s — what was read so far is kept.` } });
      timers.push(after(wait * 1000, () => { if (my === seq) void start(a, attempt + 1, fresh); }));
    } else {
      const kind = r.status === 400 ? "bad" : r.status === 429 ? "limited" : r.status === 503 ? "busy" : "failed";
      const text = kind === "bad" ? "That is not an address. Paste one that starts with 0x."
        : kind === "limited" ? `Too many lookups from your network. Try again in ${wait}s.`
        : kind === "busy" ? "The chain's history node is still busy. Try again in a minute — what was read so far is kept."
        : "Could not read the chain just now. Try again shortly.";
      set({ state: "error", error: { kind, text, retryAfter: wait } });
    }
    d.render();
  }

  return { start, stop };
}

const lookup = createLookup({
  fetch: async (address, fresh) => {
    const res = await fetch("/api/ledger?address=" + encodeURIComponent(address) + (fresh ? "&fresh=1" : ""),
      { headers: { accept: "application/json" } });
    let data = {};
    try { data = await res.json(); } catch { /* a status is still an answer */ }
    return { status: res.status, data, retryAfter: Number(res.headers.get("retry-after")) || undefined };
  },
  render: () => renderLookup(),
});

// ------------------------------------------------------------- whose page --
// #/portfolio is your own positions (u-redesign.md, U5): the trading wallet's
// where this origin has one, else the connected wallet's, read at once. Any
// other address is #/portfolio/0x…, shown read only and said to be someone
// else's. `viewing` is the route's address, or null for your own.

/** The address in the route, or null: your own. */
let viewing = null;

const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** An answer older than this is read again when the page is opened. */
export const STALE_MS = 60_000;

/**
 * Whether the answer in hand for `address` should be read again as the page
 * opens, and how: "fresh" when that address has traded since it was read
 * (the server then reads the newest blocks), "stale" when it is over a
 * minute old, else null. Without this the page drew the answer it had, so
 * buys made on token pages never showed until Refresh was pressed.
 *
 * @param {any} lookup S.lookup
 * @param {{ address: string, at: number } | null} fill S.lastFill
 * @param {number} at now
 */
export function rereadFor(address, lookup, fill, at) {
  if (!same(lookup.address, address) || lookup.state !== "ok") return null;
  const readAt = Number(lookup.readAt) || 0;
  if (fill && same(fill.address, address) && fill.at > readAt) return "fresh";
  return at - readAt > STALE_MS ? "stale" : null;
}

/** Your wallet: the trading wallet where this origin has one, else the connected one; or null. */
export function myAddress() {
  const c = trader();
  return c && c.address ? String(c.address) : null;
}

/** Whether the page is your own: no address in the route, or your own address. */
const ownView = () => !viewing || same(viewing, myAddress());

/** The address to show: the route's, or yours. Null on your own page logged out. */
const wanted = () => viewing || myAddress();

/** Show `address`: read it unless it is shown or being read already. A failed read is tried again. */
function show(address) {
  // Its rank on the Traders page (X29b), read beside the ledger.
  if (isAddress(address)) void loadRank(address, renderLookup);
  if (address && (!same(S.lookup.address, address) || S.lookup.state === "error" || S.lookup.state === "idle")) {
    return lookup.start(address);
  }
  // The same address, read before: again if it has traded since, or it is old.
  // The rows it has stay shown while it is read.
  const again = address ? rereadFor(address, S.lookup, S.lastFill, Date.now()) : null;
  if (again) return lookup.start(address, 0, again === "fresh");
  renderLookup();
}

/** The router opened `#/portfolio` (with an address or not). */
export function openLookup(arg) {
  viewing = arg ? String(arg).trim() : null;
  const field = $("#pladdr");
  if (field) field.value = ownView() ? "" : viewing;
  return show(wanted());
}

/**
 * Look up what was typed in the heading. An address gets its own URL,
 * `#/portfolio/0x…`, so it can be shared and Back returns to your own; the
 * router takes it from there. The same address again is read again. Anything
 * else is said not to be an address, and nothing is asked.
 */
export function lookUp(address) {
  const a = String(address ?? "").trim();
  if (!a) return;
  if (isAddress(a) && location.hash !== "#/portfolio/" + a) {
    location.hash = "#/portfolio/" + a;
    return;
  }
  viewing = a;
  return lookup.start(a);
}

/**
 * "Use my wallet": where this origin has a trading wallet, the trading
 * wallet's address, or the login first; elsewhere the connected wallet's
 * address, or the wallet picker first. Your address is your own page,
 * #/portfolio.
 */
export function lookUpMine(connect, logIn) {
  if (S.login.here) return S.trading && S.trading.address ? yours() : logIn();
  if (S.conn && S.conn.address) return yours();
  return connect();
}

function yours() {
  if (location.hash !== "#/portfolio") location.hash = "#/portfolio";
  else void openLookup("");
}

/** The wallet logged in or out, or changed account: your own page follows it. */
function walletMoved() {
  if (S.mode !== "hosted" || typeof document === "undefined") return;
  if ($("#shell")?.dataset.page !== "positions" || !ownView()) return;
  void show(wanted());
}
onChange(walletMoved);
session.on((type) => { if (type === "change") walletMoved(); });

/**
 * When a reading is taken after one of your own trades: 5s on, and again
 * 30s later, as trade.js reads the board's holdings after a fill.
 */
export const READ_AFTER_TRADE_MS = [5_000, 35_000];

/**
 * A sell pressed on this page has ended (main.js hands over what `doSell`
 * resolved with: the trade's last state). When it went through, your own
 * page is read again, fresh, so its rows stop showing what you held before
 * (U5's leftover). While it is read, the rows it had stay shown. Nothing is
 * read for a trade that did not fill, for someone else's address, or once
 * you have left the page.
 *
 * @param {any} state
 * @param {(ms: number, fn: () => void) => unknown} [after]
 */
export function afterPageTrade(state, after = (ms, fn) => setTimeout(fn, ms)) {
  if (S.mode !== "hosted" || !state || state.phase !== "done") return;
  const mine = myAddress();
  if (!mine || !ownView()) return;
  for (const ms of READ_AFTER_TRADE_MS) {
    after(ms, () => {
      if ($("#shell")?.dataset.page !== "positions" || !ownView() || !same(myAddress(), mine)) return;
      void lookup.start(mine, 0, true);
    });
  }
}

/**
 * The page's own controls, once at boot: the lookup field, the login in the
 * empty state, Refresh, and a row's Fees, which opens under its row. The row
 * itself opens its token page (main.js reads `data-token`), so Fees keeps
 * its click to itself.
 *
 * @param {() => unknown} connect the wallet picker
 * @param {() => unknown} logIn the trading wallet's login
 */
export function bindLookup(connect, logIn) {
  const page = $("#plookup");
  const form = $("#plform");
  if (!page || !form) return;
  form.addEventListener("submit", (e) => { e.preventDefault(); void lookUp($("#pladdr").value); });
  // Enter is the field's own too, not left to the form's implicit submission.
  $("#pladdr").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void lookUp($("#pladdr").value);
  });
  page.addEventListener("click", (e) => {
    const t = /** @type {any} */ (e.target);
    if (t.closest("[data-lookup-login]")) return void lookUpMine(connect, logIn);
    if (t.closest("[data-lookup-refresh]")) {
      if (S.lookup.address) void lookup.start(S.lookup.address);
      return;
    }
    const shr = t.closest("[data-share]");
    if (shr) {
      e.stopPropagation();
      const d = S.lookup.data;
      const p = d ? [...d.open, ...d.closed].find((q) => shareKey(q) === shr.dataset.share) : null;
      if (p) void openLedgerShare(p, S.lookup.address, ownView());
      return;
    }
    const more = t.closest("[data-ledger]");
    if (more) {
      e.stopPropagation();
      const k = more.dataset.ledger;
      if (ledgerOpen.has(k)) ledgerOpen.delete(k); else ledgerOpen.add(k);
      renderLookup();
    }
  });
}

// ---------------------------------------------------------------- drawing --

const CONFIDENCE = {
  "proceeds-unknown": ["proceeds unknown",
    "These tokens left the wallet without a curve sale this page can see: a sale on the V4 pool, " +
    "a transfer, or a router it does not recognise. What came back is unknown, so this row is left " +
    "out of the realised totals."],
  "size-adjusted": ["size from chain",
    "The wallet holds a different amount than its curve trades add up to, after a transfer or a V4 " +
    "trade. The size is the chain's; the cost is still what the trades paid."],
};

/** The badge for a position the chain cannot fully account for, or nothing. */
export const confidenceBadge = (c) => CONFIDENCE[c]
  ? html`<span class="ltag amb" title="${CONFIDENCE[c][1]}">${CONFIDENCE[c][0]}</span>` : "";

// ------------------------------------------------------------ your sell --
// The track record's call on a position's sells (p-sell-verdict.md, P2),
// from /api/ledger's sellVerdict and soldNowEth (P1). Called "Your sell", not
// "Verdict": on this page a verdict is the Checker's call on the token.

/** What each call says, on any address: not "you", which may not be the reader. */
const SELL_WORDS = {
  paperhand: "What was sold would fetch more today than the sells got",
  good: "What was sold would not fetch more today than the sells got",
  unpriced: "What was sold cannot be valued just now",
};

/** How the call is made, for the column's heading. */
export const SELL_HOW = "Would the tokens sold fetch more today than the sells got? Paperhand: more by at "
  + "least 10% of what the sells got and 0.0005 ETH. Good sell: they would not.";

/** Whether a position has sold something, so there is a call to show. */
export const hasSold = (p) => n(p.soldTokens) > 0;

/** The figures behind a call: what the sells got, and what the same tokens would get today. */
function sellFigures(p) {
  const back = n(p.realizedWei) / 1e18;
  return p.soldNowEth === null || p.soldNowEth === undefined ? ""
    : ` — sold for ${usd(back)}, worth ${usd(n(p.soldNowEth))} today`;
}

/**
 * A position's sell, as the track record's pill: Paperhand, Good sell or No
 * price, with its figures to hover. A dash where there is nothing to judge:
 * proceeds unknown, or an answer from a server without the call.
 *
 * @param {any} p a position from /api/ledger
 */
export function sellPill(p) {
  if (p.sellVerdict === null) {
    return html`<span class="t4" title="What its sells got is unknown, so there is nothing to compare">—</span>`;
  }
  if (!p.sellVerdict || p.sellVerdict === "holding") return html`<span class="t4">—</span>`;
  const v = verdictPill(p.sellVerdict);
  return html`<span class="pill ${v.cls}" title="${(SELL_WORDS[p.sellVerdict] ?? v.tip) + sellFigures(p)}">${v.label}</span>`;
}

/** Which position a Share is for: several closed positions can share a token, so its opening too. */
export const shareKey = (p) => `${p.token}:${p.openedAt}`.toLowerCase();

/** Whether a position has a sell to put on a card (P3): a call, and not "holding". */
const shareable = (p) => !!p.sellVerdict && p.sellVerdict !== "holding";

/** Share, which makes the trade card of this sell (P3). Its click keeps to itself, as Fees does. */
const shareButton = (p) => shareable(p)
  ? html`<button class="shr" type="button" data-share="${shareKey(p)}" title="Make a share card of this sell">Share</button>` : "";

/** A closed row's "Your sell" cell: the pill and Share, and what the tokens sold would fetch today. */
function sellCell(p) {
  const worth = p.soldNowEth !== null && p.soldNowEth !== undefined && p.sellVerdict !== null;
  return html`<td class="c-sell"><span class="pfsell"><span>${sellPill(p)}${shareButton(p)}</span>${worth
    ? html`<small>worth ${usd(n(p.soldNowEth))} today</small>` : ""}</span></td>`;
}

/** An open position that has sold some: its call as a tag beside Capped and the others. */
function sellTag(p) {
  if (!hasSold(p) || !p.sellVerdict || p.sellVerdict === "holding") return "";
  const v = verdictPill(p.sellVerdict);
  const tone = v.cls === "a" ? "amb" : v.cls === "g" ? "grn" : "";
  return html`<span class="ltag ${tone}" title="${"Part sold. " + (SELL_WORDS[p.sellVerdict] ?? v.tip) + sellFigures(p)}">${v.label}</span>`;
}

/** What the chain says happened to a closed position, in words. */
const closedWhy = (p) => p.confidence === "proceeds-unknown"
  ? "Left the wallet without a curve sale" : cap1(String(p.closed.reason || "").replace(/ \(reconstructed from chain history\)$/, ""));

/** The board's row for a token, when it is on the board: its logo, verdict and graduation. */
const boardRowOf = (token) => rows.get(String(token).toLowerCase()) ?? null;

/** A token's face and symbol, the symbol linking to its page, with its tags and a line under it. */
function tokenCell(p, r, color, progress, tags, line) {
  const logo = r ? (r.logo ? p.token : "") : p.token;
  return html`<div class="btok">${ring(30, progress, color, initials(p.symbol), logo)}
      <div class="btnm"><b><a class="bsym pfsym" href="${"#/token/" + p.token}">${p.symbol || short(p.token)}</a>${tags}</b>
        <span class="bname">${line}</span></div></div>`;
}

/** How far along its curve a token is: the board's cell when it is listed, else the ledger's figure. */
function gradOf(p, r) {
  if (r) return gradCell(r);
  if (p.venue === "v4") return html`<span class="ltag grad">Graduated</span>`;
  const prog = n(p.progress) * 100;
  return html`<span class="bgrad"><span class="bbar"><i style="width:${Math.max(2, Math.min(100, prog)).toFixed(1)}%"></i></span><span class="t2">${pc(prog)}</span></span>`;
}

/** The verdict from the board, or a dash for a token the board does not list. */
const verdictOf = (r) => r ? verdictBadge(r)
  : html`<span class="t4" title="Not on the board just now. Its token page runs the check.">—</span>`;

/**
 * An open position as a row: the token, what is held, what it cost, what it
 * is worth and the P&L, its graduation and verdict, then (on your own
 * wallet) the board's 50% and All, and Fees, which opens under the row what
 * the card used to show. Nothing a manager decides.
 *
 * @param {any} p a position from /api/ledger
 * @param {Map<string, any> | null} [held] your holdings by token (trade.js heldFrom), on your own wallet only
 * @param {boolean} [expanded] Fees open
 */
export function lookupOpenRow(p, held = null, expanded = ledgerOpen.has(ledgerKey(p))) {
  const r = boardRowOf(p.token);
  const valued = p.valued !== false;
  const up = n(p.pnlPct) >= 0;
  const sell = n(p.sellablePct);
  const capped = valued && (p.capped || sell < 99.5);
  const delta = n(p.nowEth) - n(p.costEthNum);
  const key = ledgerKey(p);
  const tag = !valued ? html`<span class="ltag amb" title="Could not be valued just now — shown at cost">Not valued</span>`
    : capped ? html`<span class="ltag amb" title="${sell > 0 ? `Only ${pc(sell, 0)} of this can be sold in one go`
      : "The curve cannot absorb the whole position in one sell"}">Capped</span>` : "";

  /** @type {any} */
  let act = "";
  if (held) {
    const lh = held.get(String(p.token).toLowerCase());
    const tradable = r && r.status === "ready" && !(r.graduated && !r.v4);
    act = html`<td class="c-act"><div class="tradebar">${lh && tradable ? sellButtons(r, lh)
      : html`<a class="btn sm" href="${"#/token/" + p.token}" title="Not tradable from the board just now: its token page says why">Open</a>`}</div></td>`;
  }

  return html`<tr class="link" data-token="${p.token}">
      <td class="c-tok">${tokenCell(p, r, !valued ? AMB : up ? GRN : RED, r ? (r.graduated ? 1 : r.progress) : p.progress,
        html`${confidenceBadge(p.confidence)}${tag}${sellTag(p)}`, `opened ${dur(Date.now() - p.openedAt)} ago`)}</td>
      <td class="num c-held" data-l="Held">${millions(n(p.tokens) / 1e18)}</td>
      <td class="num c-cost t2" data-l="Cost">${usd(p.costEthNum)}</td>
      <td class="num c-val" data-l="Value" title="${valued ? "" : "Could not be valued just now — shown at cost"}">${valued ? html`<b>${usd(p.nowEth)}</b>` : "—"}</td>
      <td class="num c-pnl" title="${valued ? `Net P&L is the market move less the fee paid entering and the fee leaving would cost: price ${
        sign(n(p.priceMovePct))}% · fees −${n(p.feeDragPct).toFixed(2)}%` : ""}"><span class="pfpnl"><b class="${!valued ? "t3" : up ? "grn" : "red"}"
        >${valued ? sign(p.pnlPct) + "%" : "—"}</b><small class="${!valued ? "t3" : up ? "grn" : "red"}">${valued
        ? `${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))}` : "not valued"}</small></span></td>
      <td class="c-grad">${gradOf(p, r)}</td>
      <td class="c-vd">${verdictOf(r)}</td>
      ${act}
      <td class="c-more"><button class="feetog pfmore" type="button" data-ledger="${key}" aria-expanded="${expanded ? "true" : "false"}"
        >Fees ${expanded ? "▴" : "▾"}</button></td>
    </tr>${expanded ? html`<tr class="pfdetail"><td colspan="${held ? 9 : 8}">${lookupDetail(p)}</td></tr>` : ""}`;
}

/**
 * What opens under a row: why it is shown at cost or capped, the figures
 * behind its P&L, its fees and its entry. Where a narrow window has hidden
 * the row's cost, graduation or verdict, they are here too (.pfph).
 */
export function lookupDetail(p) {
  const r = boardRowOf(p.token);
  const valued = p.valued !== false;
  const sell = n(p.sellablePct);
  const capped = valued && (p.capped || sell < 99.5);
  const flag = !valued ? flagRow("amb", "Could not be valued just now — shown at cost")
    : capped && sell > 0 ? flagRow("amb", `Only ${pc(sell, 0)} of this can be sold in one go`) : "";
  return html`<div class="pfdet">${flag}
      <div class="pfkv">
        <div class="pfph pfph-held"><i>Held</i><b>${millions(n(p.tokens) / 1e18)}</b></div>
        <div class="pfph pfph-cost"><i>Cost</i><b>${usd(p.costEthNum)}</b></div>
        <div class="pfph pfph-grad"><i>Graduation</i><b>${gradOf(p, r)}</b></div>
        <div class="pfph pfph-vd"><i>Verdict</i><b>${verdictOf(r)}</b></div>
        <div><i>Price move</i><b>${valued ? sign(n(p.priceMovePct)) + "%" : "—"}</b></div>
        <div><i>Fees</i><b title="The fee paid entering and the fee leaving would cost, as a share of the position">${valued
          ? "−" + n(p.feeDragPct).toFixed(2) + "%" : "—"}</b></div>
        <div><i>To break even</i>
          <b class="${n(p.priceMovePct) >= n(p.breakevenMovePct) ? "grn" : ""}"
            title="The price move this position needs to come out even, after the fee each way"
            >+${n(p.breakevenMovePct).toFixed(2)}%</b></div>
        <div><i>Sellable</i><b class="${capped ? "amb" : ""}"
          title="How much of it the curve can take in one sale">${valued ? pc(Math.min(100, sell), 0) : "—"}</b></div>
        <div><i>Opened</i><b>${dur(Date.now() - p.openedAt)} ago</b></div>
        ${hasSold(p) ? html`<div><i>Your sell</i><b>${sellPill(p)}${shareButton(p)}</b></div>
        <div><i>Sold, worth today</i><b title="What the tokens sold would fetch in one sale today">${
          p.soldNowEth === null || p.soldNowEth === undefined ? "—" : usd(n(p.soldNowEth))}</b></div>` : ""}
        ${p.openTx ? html`<div><i>Entry tx</i><b><a class="mo" href="${EXPLORER + "/tx/" + p.openTx}" target="_blank"
          rel="noopener noreferrer">${short(p.openTx)} ↗</a></b></div>` : ""}
      </div>
      ${feeLedger(p)}
    </div>`;
}

/** A closed position's row. Proceeds the chain does not show are not a loss. */
export function lookupRow(p) {
  const r = boardRowOf(p.token);
  const cost = n(p.realizedCostWei) / 1e18;
  const unknown = p.confidence === "proceeds-unknown";
  const proceeds = n(p.closed.proceedsEth) / 1e18;
  const pnl = cost > 0 ? ((proceeds - cost) / cost) * 100 : 0;
  return html`<tr class="link" data-token="${p.token}">
      <td class="c-tok">${tokenCell(p, r, DIM, 0, confidenceBadge(p.confidence), html`<span class="mo">${short(p.token)}</span>`)}</td>
      <td class="num c-cost t2" data-l="Cost">${usd(cost)}</td>
      <td class="num c-proc" data-l="Proceeds">${unknown ? "—" : usd(proceeds)}</td>
      <td class="num c-pnl"><b class="${unknown ? "" : pnl >= 0 ? "grn" : "red"}">${unknown ? "—" : sign(pnl) + "%"}</b></td>
      <td class="num c-for t2" data-l="Held for">${durExact(p.closed.at - p.openedAt)}</td>
      <td class="c-why">${closedWhy(p)}${p.closed.tx
        ? html` <a class="mo pftx" href="${EXPLORER + "/tx/" + p.closed.tx}" target="_blank" rel="noopener noreferrer">${short(p.closed.tx)} ↗</a>` : ""}</td>
      ${sellCell(p)}</tr>`;
}

/** What the lookup is doing, or why it has nothing: one line at the top. */
export function lookupStatus(l, now = Date.now()) {
  if (l.state === "loading") {
    const s = Math.max(0, Math.floor((now - l.startedAt) / 1000));
    return html`<div class="callout info busy" role="status"><span>Rebuilding from chain… ${s}s${
      l.attempt > 0 ? ` · attempt ${l.attempt + 1}` : ""}</span></div>`;
  }
  if ((l.state === "error" || l.state === "waiting") && l.error) {
    const bad = l.error.kind === "bad";
    return html`<div class="callout ${bad ? "danger" : "warn"}" role="${bad ? "alert" : "status"}"><span>${l.error.text}</span></div>`;
  }
  return "";
}

/** The banner for a ledger that left whole tokens out to stay under its cap. */
export function partialBanner(d) {
  if (!d || !d.partial) return "";
  const list = d.omittedTokens.map((o) => `${o.symbol || short(o.token)} (${o.txs} transaction${o.txs === 1 ? "" : "s"})`).join(", ");
  return html`<div class="callout warn"><span>This address has more history than one lookup reads, so only its most recently active tokens are shown, each in full. Left out: ${list}.</span></div>`;
}

/** The four figures over the page, from the answer's totals. */
export function lookupStats(d) {
  const t = d.totals || {};
  const open = d.open.filter((p) => p.valued !== false);
  const cost = open.reduce((a, p) => a + n(p.costEthNum), 0);
  const now = open.reduce((a, p) => a + n(p.nowEth), 0);
  const delta = now - cost;
  const moveCls = open.length === 0 ? "" : delta >= 0 ? "grn" : "red";
  const all = [...d.open, ...d.closed];
  const fees = all.reduce((a, p) => a + (n(p.entryFeeWei) + n(p.snipeTaxWei) + n(p.realizedEntryFeeWei) + n(p.exitFeeWei)) / 1e18, 0);
  const gas = all.reduce((a, p) => a + n(p.gasWei) / 1e18, 0);
  const realised = n(t.realizedPnlEth);
  const excluded = n(t.excluded);
  return html`
      <div class="kpi"><small>Open value</small><b>${usd(n(t.openValueEth))}</b>
        <span>${usd(n(t.openCostEth))} in across ${d.open.length} position${d.open.length === 1 ? "" : "s"}</span></div>
      <div class="kpi"><small>Unrealised</small>
        <b class="${moveCls}">${open.length ? sign(cost > 0 ? (delta / cost) * 100 : 0) + "%" : "—"}</b>
        <span class="${moveCls}">${open.length ? `${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))} at today’s quote` : "nothing open"}</span></div>
      <div class="kpi"><small>Realised</small>
        <b class="${d.closed.length === 0 ? "" : realised >= 0 ? "grn" : "red"}">${d.closed.length
          ? (realised >= 0 ? "+" : "−") + usd(Math.abs(realised)) : "—"}</b>
        <span>${d.closed.length ? `${d.closed.length} closed` : "nothing closed"}${excluded > 0
          ? ` · ${excluded} excluded, proceeds unknown` : ""}</span></div>
      <div class="kpi"><small>Fees paid</small>
        <b class="${fees > 0 ? "amb" : ""}">${fees > 0 ? usd(fees) : "—"}</b>
        <span>${gas > 0 ? `${usd(gas)} gas on top` : "curve fees, entry and exit"}</span></div>`;
}

/** The line under the heading: whose positions these are. */
export function whose(own, mine, address = viewing) {
  const chip = (a) => html`<button class="addrcopy" type="button" data-copy="${a}" title="${"Copy address — " + a}">${short(a)}</button>`;
  if (own && mine) {
    return html`<span class="pfwho">${S.login.here ? "Your trading wallet" : "Your wallet"} ${chip(mine)}</span>
      <span>Rebuilt from the chain, the open ones valued at today’s price</span>`;
  }
  if (own) return html`<span>Your positions on clank.trade, rebuilt from the chain.</span>`;
  return html`<span class="pfwho pfro">${isAddress(address)
      ? html`Viewing ${chip(address)} — not your wallet` : "Not an address"}</span>
    <button class="btn sm ghost pfback" type="button" data-go="portfolio">← Your positions</button>`;
}

/** Logged out on your own page: the login, and the lookup field (renderLookup moves it in). */
const loggedOut = () => html`<div class="empty pfout"><b>Log in to see your positions</b>
    <p>Or look up any address: its positions on clank.trade are rebuilt from the chain.</p>
    <div class="pfoutrow"><button class="btn pri" type="button" data-lookup-login>${S.login.here ? "Log in" : "Connect wallet"}</button>
      <div class="pfslot"></div></div></div>`;

/** Four figures still being read. */
const SKELETON = html`<div class="kpis" aria-hidden="true">${[0, 1, 2, 3].map(() => html`<div class="kpi">
    <span class="skel line" style="width:40%"></span><span class="skel line" style="height:20px;width:70%"></span></div>`)}</div>`;

/** An answer's Open table, under its heading with when it was valued and Refresh. */
function openSection(l, d, held) {
  const busy = l.state === "loading" || l.state === "waiting";
  return html`<section class="pfsec">
      <div class="pfsechd"><h2>Open</h2><span class="pfcount">${d.open.length}</span><span class="sp"></span>
        <span class="pfmeta">${d.builtAt ? "Valued " + ago(d.builtAt) : ""}${l.state === "loading" ? " · rebuilding" : ""}</span>
        <button class="btn sm ghost" type="button" data-lookup-refresh ${busy ? "disabled" : ""}>Refresh</button></div>
      ${d.open.length ? html`<div class="dtbox pfbox"><table class="dtable pftable pfopen">
        <thead><tr><th>Token</th><th class="num c-held">Held</th><th class="num c-cost">Cost</th><th class="num c-val">Value</th>
          <th class="num c-pnl">P&amp;L</th><th class="c-grad">Graduation</th><th class="c-vd">Verdict</th>${held
          ? html`<th class="c-act" aria-label="Sell"></th>` : ""}<th class="c-more" aria-label="Fees"></th></tr></thead>
        <tbody>${d.open.map((p) => lookupOpenRow(p, held))}</tbody></table></div>`
      : html`<div class="empty"><b>Nothing open</b>No token this address bought on a curve is still held.</div>`}
    </section>`;
}

/** An answer's Closed table, newest first. */
function closedSection(d) {
  const closed = d.closed.slice().sort((a, b) => b.closed.at - a.closed.at);
  return html`<section class="pfsec">
      <div class="pfsechd"><h2>Closed</h2><span class="pfcount">${closed.length}</span><span class="sp"></span>
        <span class="pfmeta">Read from the chain: every curve buy and sale this address made</span></div>
      ${closed.length ? html`<div class="dtbox pfbox"><table class="dtable pftable pfclosed">
        <thead><tr><th>Token</th><th class="num c-cost">Cost</th><th class="num c-proc">Proceeds</th>
          <th class="num c-pnl">P&amp;L</th><th class="num c-for">Held for</th><th class="c-why">What happened</th>
          <th class="c-sell" title="${SELL_HOW}">Your sell</th></tr></thead>
        <tbody>${closed.map(lookupRow)}</tbody></table></div>`
      : html`<div class="empty"><b>Nothing has closed.</b></div>`}
    </section>`;
}

/**
 * Draw the page: whose positions under the heading, then into `#plbody` the
 * status, the four figures and the two tables. Your own page logged out is
 * the login with the lookup field; everywhere else the field sits in the
 * heading. The same markup twice is not painted again, so a field being
 * typed in keeps its text and its focus.
 */
export function renderLookup() {
  const body = $("#plbody");
  if (!body) return;
  const own = ownView();
  const mine = myAddress();
  const target = own ? mine : viewing;
  const l = S.lookup;
  // Only the answer for the address the page is about: never the last one
  // looked up, nor a wallet since logged out.
  const here = target && same(l.address, target) ? l : null;
  const d = here ? here.data : null;
  const out = own && !mine;

  const sub = $("#plsub");
  const who = html`${whose(own, mine)}${target && isAddress(target) ? rankLine(target) : ""}`;
  if (sub && sub._painted !== who.s) {
    paint(sub, who);
    sub._painted = who.s;
  }

  let view;
  if (out) view = loggedOut();
  else if (!here) view = SKELETON;
  else if (d && d.open.length === 0 && d.closed.length === 0 && !d.partial) {
    view = html`${lookupStatus(here)}<div class="empty"><b>No positions</b>The chain shows no curve buy
      or sale on clank.trade by ${short(d.address)}, up to block ${d.asOfBlock}.</div>`;
  } else {
    const held = own && d ? heldFrom(mine, d).byToken : null;
    view = html`${lookupStatus(here)}${partialBanner(d)}${d ? html`
      <div class="kpis">${lookupStats(d)}</div>
      ${openSection(here, d, held)}
      ${closedSection(d)}` : here.state === "loading" || here.state === "waiting" ? SKELETON : ""}`;
  }
  // Held before painting: in the empty state the field is inside the body.
  const form = $("#plform");
  if (body._painted !== view.s) {
    paint(body, view);
    body._painted = view.s;
  }
  const slot = out ? $("#plbody .pfslot") : $("#plhdslot");
  if (form && slot && form.parentNode !== slot) slot.appendChild(form);
}
