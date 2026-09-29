import { S } from "../core/store.js";
import { $, $$, html, node, paint } from "../core/dom.js";
import {
  bandOf, guardLabel, guardPct, initials, limitOf, ringColor, sevClass, sorted, VERDICT_NOTE, verdictNote,
} from "../core/domain.js";
import { XI, ago, eth, int, millions, n, pc, short, usd } from "../core/format.js";
import { rows } from "../core/store.js";
import { ring } from "../core/svg.js";
import { go } from "../router.js";
import { tradeBar, tradeBarSig } from "../trade.js";

// ====================================================================== //
// the board (u-redesign.md, U2 and U3)                                   //
// ====================================================================== //
//
// Every launch as one row of a dense table: the front page. A heading with
// one summary line, a first-visit intro (hosted), then a toolbar (the filter
// chips with their counts, a filter by name, the sort) over the table, whose
// sortable heads are the same five sorts. A row opens its token page; its
// last cell is the trade bar (trade.js), Buy at the size in the top bar.
//
// The heading's Table | Columns switch shows the same board as three lists
// instead (U3): New, Closest to graduation and Graduated, compact cards with
// the same verdict badge and trade bar. The chips and the name filter narrow
// both views; the sort is the table's.
//
// Neither is rebuilt on a tick: rows and cards are keyed by token, repainted
// only when what they show changed, and moved only when the order did. So a
// live launch landing, a price tick or a trade's progress keeps the reader's
// scroll, hover and focus.

// ------------------------------------------------------------- the chips --

/**
 * Each Show chip, as a rule on a row's band class (domain.js bandOf). A
 * graduated row is GRAD whatever band its curve last had, so it shows under
 * Graduated only, and never as risky; a row still being checked is SCAN and
 * shows under All only.
 */
export const FILTERS = {
  all: () => true,
  CLEAN: (cls) => cls === "CLEAN",
  CAUTION: (cls) => cls === "CAUTION",
  risky: (cls) => cls === "HIGH" || cls === "AVOID",
  GRAD: (cls) => cls === "GRAD",
};

/** Whether a row shows under a chip. */
export const shownBy = (f, r) => (FILTERS[f] || FILTERS.all)(bandOf(r)[0]);

/** What each chip counts: exactly the rows its filter leaves shown. */
export function chipCounts(all) {
  return Object.fromEntries(Object.keys(FILTERS).map((f) => [f, all.filter((r) => shownBy(f, r)).length]));
}

// -------------------------------------------------------------- the sorts --

/** The board's sorts, in the order the sort menu lists them. The first is the default. */
export const SORTS = ["new", "mcap", "hold", "prog", "score"];

/** Where this browser remembers the board's sort. */
export const SORT_KEY = "clank.lsort";

/**
 * The sort this viewer last picked, or Newest. Storage that is missing,
 * throws, or holds something that is not a sort gives the default.
 *
 * @param {() => Storage | null | undefined} [storage]
 */
export const loadSort = (storage = () => globalThis.localStorage) => recall(SORT_KEY, SORTS, storage);

/**
 * Remember the sort. Storage that fails keeps it for this page load, which
 * the board's own state already does.
 *
 * @param {string} s
 * @param {() => Storage | null | undefined} [storage]
 */
export const saveSort = (s, storage = () => globalThis.localStorage) => remember(SORT_KEY, SORTS, s, storage);

/**
 * A choice this browser remembered under `key`, or the first of `allowed`
 * where there is none, it is not one of them, or storage throws.
 *
 * @param {string} key
 * @param {string[]} allowed
 * @param {() => Storage | null | undefined} storage
 */
function recall(key, allowed, storage) {
  try {
    const v = storage()?.getItem(key);
    return allowed.includes(v) ? v : allowed[0];
  } catch { return allowed[0]; }
}

/**
 * Remember a choice, if it is one of `allowed`. Storage that fails keeps it
 * for this page load only, which the board's own state already does.
 *
 * @param {string} key
 * @param {string[]} allowed
 * @param {string} v
 * @param {() => Storage | null | undefined} storage
 */
function remember(key, allowed, v, storage) {
  if (!allowed.includes(v)) return;
  try { storage()?.setItem(key, v); } catch { /* this page load only */ }
}

/** The board's two views: the dense table (the default) and the three columns. */
export const VIEWS = ["table", "cols"];

/** Where this browser remembers the board's view. */
export const VIEW_KEY = "clank.lview";

/**
 * The view this viewer last picked, or Table.
 *
 * @param {() => Storage | null | undefined} [storage]
 */
export const loadView = (storage = () => globalThis.localStorage) => recall(VIEW_KEY, VIEWS, storage);

/**
 * Remember the view.
 *
 * @param {string} v
 * @param {() => Storage | null | undefined} [storage]
 */
export const saveView = (v, storage = () => globalThis.localStorage) => remember(VIEW_KEY, VIEWS, v, storage);

/** A number, or null for a value that is missing rather than zero. */
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Highest first, a missing value after every present one. */
const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);

/** Lowest first, a missing value still last. */
const asc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);

/** Newest first: the block, then the timestamp, then the address so a tie is still one order. */
const newest = (a, b) => (n(b.block) - n(a.block)) || (n(b.launchedAt) - n(a.launchedAt)) ||
  (String(a.token).toLowerCase() < String(b.token).toLowerCase() ? -1 : 1);

const graduated = (r) => (r.status === "ready" && r.graduated ? 1 : 0);

const byMcap = (a, b) => desc(num(a.fdvEth), num(b.fdvEth)) || newest(a, b);

/** Scored launches on their curve, then graduated ones, then those still being checked. */
const riskGroup = (r) => (r.status !== "ready" ? 2 : graduated(r));

/**
 * Each sort, as a comparator.
 *
 * Newest, Closest to graduation and Lowest risk put a graduated token after
 * every one still on its curve. Fresh launches are the board's edge, and a
 * bonded token has finished the part those three sorts are about: it has no
 * progress left, and its risk score describes a curve that is now settled.
 * Behind them, graduated tokens go newest first under Newest and highest
 * market cap first under Closest to graduation, where they have no progress to
 * rank by. Market cap and Holders rank everything together: a sort by size is
 * asking for the big ones, and those are usually graduated.
 */
export const COMPARE = {
  new: (a, b) => (graduated(a) - graduated(b)) || newest(a, b),
  mcap: byMcap,
  hold: (a, b) => desc(num(a.holders), num(b.holders)) || newest(a, b),
  prog: (a, b) => (graduated(a) - graduated(b)) ||
    (graduated(a) ? byMcap(a, b) : desc(num(a.progress), num(b.progress)) || newest(a, b)),
  score: (a, b) => (riskGroup(a) - riskGroup(b)) ||
    (riskGroup(a) === 2 ? 0 : asc(num(a.score), num(b.score))) || newest(a, b),
};

/**
 * Each sort the other way, from a second click on its column head. The value
 * turns round and nothing else does: graduated tokens still come after the
 * ones on their curve where COMPARE puts them there, a missing value is still
 * last, and a tie still goes to the newer. So "highest risk first" is not led
 * by the rows still being checked, and "oldest first" is not led by the
 * graduated ones.
 */
export const REVERSE = {
  new: (a, b) => (graduated(a) - graduated(b)) || newest(b, a),
  mcap: (a, b) => asc(num(a.fdvEth), num(b.fdvEth)) || newest(a, b),
  hold: (a, b) => asc(num(a.holders), num(b.holders)) || newest(a, b),
  prog: (a, b) => (graduated(a) - graduated(b)) ||
    (graduated(a) ? byMcap(a, b) : asc(num(a.progress), num(b.progress)) || newest(a, b)),
  score: (a, b) => (riskGroup(a) - riskGroup(b)) ||
    (riskGroup(a) === 2 ? 0 : desc(num(a.score), num(b.score))) || newest(a, b),
};

/**
 * A copy of `list` in a sort's order; `dir` -1 is the other way (REVERSE).
 * A tie the comparator leaves is kept in the list's own order.
 *
 * @param {any[]} list
 * @param {string} sort
 * @param {1 | -1} [dir]
 */
export function sortBoard(list, sort, dir = 1) {
  const cmp = (dir < 0 ? REVERSE : COMPARE)[sort] || COMPARE.new;
  return list.map((r, i) => ({ r, i })).sort((a, b) => cmp(a.r, b.r) || a.i - b.i).map((x) => x.r);
}

/**
 * Which way each sort's column reads when the sort runs its usual way. Newest
 * is the Age column youngest first; Lowest risk is the Verdict column by
 * ascending score.
 */
const NATURAL = { new: "ascending", mcap: "descending", hold: "descending", prog: "descending", score: "ascending" };

/** The value of a sortable head's aria-sort, for the board's current sort. */
export function ariaSort(col, sort, dir) {
  if (col !== sort) return "none";
  const nat = NATURAL[sort];
  return dir > 0 ? nat : nat === "ascending" ? "descending" : "ascending";
}

// ----------------------------------------------------------- the columns --

/**
 * The Columns view's three lists (u-redesign.md, U3), left to right. Each
 * keeps its own order, so the toolbar's sort is the table's only; the chips
 * and the name filter narrow all three.
 */
export const COLUMNS = [
  { id: "new", title: "New", none: "Nothing on its curve" },
  { id: "near", title: "Closest to graduation", none: "Nothing on its curve" },
  { id: "grad", title: "Graduated", none: "Nothing graduated" },
];

/**
 * A board (already filtered) as the three columns: New, every launch still on
 * its curve, newest first; Closest to graduation, the same launches, furthest
 * along first (a missing progress last, a tie to the newer); Graduated, by
 * market cap, a missing cap last. They are the sorts Newest, Closest to
 * graduation and Market cap, so a column is in the order its sort puts a
 * table in. A launch still being checked is on its curve until it is known
 * to have graduated, as the Graduated chip has it.
 *
 * @param {any[]} list
 */
export function columnsOf(list) {
  const curve = list.filter((r) => !graduated(r));
  return {
    new: sortBoard(curve, "new"),
    near: sortBoard(curve, "prog"),
    grad: sortBoard(list.filter(graduated), "mcap"),
  };
}

// ------------------------------------------------------------ the view --

/**
 * What the board shows: the chip, the name typed, the sort and its
 * direction, the view (Table or Columns), and which column a narrow window
 * shows, where the three are tabs.
 */
const view = {
  f: "all", q: "", sort: SORTS[0], dir: /** @type {1 | -1} */ (1), layout: VIEWS[0], col: COLUMNS[0].id, loaded: false,
};

/** Change what the board shows (the toolbar, and tests). */
export function setBoardView(next) {
  Object.assign(view, next);
  view.loaded = true;
}

/** The board's view as it stands. */
export const boardView = () => ({ ...view });

/** Whether a row matches what was typed in the filter: its symbol, its name, or the start of its address. */
export function matchesName(r, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;
  return String(r.symbol || "").toLowerCase().includes(s) || String(r.name || "").toLowerCase().includes(s)
    || (s.startsWith("0x") && String(r.token).toLowerCase().startsWith(s));
}

// ---------------------------------------------------------------- render --

export function renderLaunches() {
  if (!view.loaded) setBoardView({ sort: loadSort(), layout: loadView() });
  const all = sorted();
  const cols = view.layout === "cols";

  const tally = chipCounts(all);
  counts("#lchips", tally);
  for (const chip of $$("#lchips .chip")) chip.setAttribute("aria-pressed", String(chip.dataset.f === view.f));
  for (const th of $$("#ltable th[data-sort]")) th.setAttribute("aria-sort", ariaSort(th.dataset.sort, view.sort, view.dir));
  const sel = $("#lsort");
  if (sel && sel.value !== view.sort) sel.value = view.sort;
  for (const b of $$("#lview button")) b.setAttribute("aria-pressed", String(b.dataset.v === view.layout));
  // Only the view shown is drawn. The other keeps its built rows or cards,
  // checked against their signatures when it is shown again.
  $("#lbox").dataset.view = view.layout;
  $("#ltable").hidden = cols;
  $("#lcols").hidden = !cols;

  renderSummary(all, tally.CLEAN);
  paint($("#lnote"), verdictNote());

  const filtered = all.filter((r) => shownBy(view.f, r) && matchesName(r, view.q));
  if (cols) return renderColumns(all, filtered);

  const body = $("#lrows");
  if (!all.length) {
    // Before the first data, the table's shape; after it, an empty board.
    clearCaches();
    return paint(body, S.boardReady ? emptyRow(NOTHING_YET) : SKELETON);
  }
  if (!filtered.length) return paint(body, emptyRow(noMatch(all.length)));
  reconcile(body, sortBoard(filtered, view.sort, view.dir), all[0], "table", boardRow);
}

const NOTHING_YET = html`<b>Nothing on the board yet</b>
    <p>Launches appear here the moment the factory deploys one.</p>`;

/** What a filter that matches nothing says, with a way back to everything. */
const noMatch = (total) => html`<b>No launches match</b>
    <p>Nothing on the board is ${view.q ? `named like "${view.q}"` : "in this filter"}${
      view.q && view.f !== "all" ? " in this filter" : ""}.</p>
    <button class="btn sm" type="button" data-bclear>Show all ${total}</button>`;

/**
 * The Columns view: each column's count, in its header and its tab, and its
 * cards, patched as the table's rows are. A column the filter empties says
 * so on its own; a board, or a filter, with nothing at all says it once,
 * across the three.
 */
function renderColumns(all, filtered) {
  const host = $("#lcols");
  host.dataset.col = view.col;
  const groups = columnsOf(filtered);
  for (const b of $$("#lctabs button")) {
    b.setAttribute("aria-pressed", String(b.dataset.col === view.col));
    const nEl = $(".n", b);
    if (nEl) nEl.textContent = all.length ? int(groups[b.dataset.col]?.length ?? 0) : "";
  }

  const whole = !all.length ? (S.boardReady ? NOTHING_YET : null) : !filtered.length ? noMatch(all.length) : null;
  host.dataset.empty = whole ? "1" : "";
  paint($("#lcempty"), whole ? html`<div class="empty plain">${whole}</div>` : "");
  if (whole) return;

  if (!all.length) clearCaches();
  for (const c of COLUMNS) {
    const list = $("#lcl-" + c.id);
    $("#lcn-" + c.id).textContent = all.length ? int(groups[c.id].length) : "";
    if (!all.length) {
      paint(list, CARD_SKELETON);
    } else if (!groups[c.id].length) {
      paint(list, html`<p class="bcnone">${c.none}${view.f !== "all" || view.q ? " in this filter" : " yet"}</p>`);
    } else {
      reconcile(list, groups[c.id], all[0], c.id, boardCard);
    }
  }
}

/**
 * The line under the heading: the board in four figures, in a trader's words
 * (the old stat cards spoke the sniper's). "No issues found" counts what its
 * chip counts.
 */
function renderSummary(all, clean) {
  const host = $("#lsum");
  if (!all.length) return paint(host, S.boardReady ? "Nothing on the board yet" : "");
  const ready = all.filter((r) => r.status === "ready");
  const raised = ready.reduce((a, r) => a + n(r.raised), 0);
  paint(host, html`<span><b>${int(all.length)}</b> on the board</span>
      <span><b class="${clean ? "grn" : ""}">${int(clean)}</b> no issues found</span>
      <span>newest <b>${ago(n(all[0].launchedAt) * 1000).replace(/ ago$/, "")}</b> ago</span>
      <span><b>${usd(raised, 2)}</b> raised across the board</span>`);
}

/** The table's shape while the first data is on its way. */
const SKELETON = Array.from({ length: 8 }, (_, i) => html`<tr class="bskel" aria-hidden="true">
    <td><span class="bskt"><span class="skel bdot"></span><span class="skel line" style="width:${70 + (i * 23) % 50}px"></span></span></td>
    <td class="num"><span class="skel line"></span></td><td class="num"><span class="skel line"></span></td>
    <td class="c-grad"><span class="skel line"></span></td><td class="num c-hold"><span class="skel line"></span></td>
    <td class="num c-top"><span class="skel line"></span></td><td class="num c-dev"><span class="skel line"></span></td>
    <td class="num c-bun"><span class="skel line"></span></td><td><span class="skel line" style="width:96px"></span></td>
    <td class="c-act"><span class="skel line" style="width:84px;margin-left:auto"></span></td></tr>`);

/** A column's shape while the first data is on its way. */
const CARD_SKELETON = Array.from({ length: 6 }, (_, i) => html`<div class="bmini bskel" aria-hidden="true">
    <span class="skel bdot"></span><span class="skel line" style="width:${60 + (i * 23) % 50}px"></span>
    <span class="skel line bmsk"></span></div>`);

const emptyRow = (inner) => html`<tr class="bempty"><td colspan="10"><div class="empty plain">${inner}</div></td></tr>`;

// ---------------------------------------------------------------- rows --

/**
 * Everything about a row's launch that is worth redrawing for.
 *
 * Deliberately excludes age, which changes every minute for every row and is
 * patched in place instead — including it would mean the whole board
 * repainting on a timer, which is the thing this exists to stop.
 *
 * Encoded as JSON rather than joined on a delimiter. No delimiter is safe,
 * because symbol, name and error are text the token's creator controls: one
 * containing the delimiter shifts text across a field boundary, and two
 * different rows sign the same. JSON quotes and escapes every string.
 */
export const cardSig = (r) => JSON.stringify([
  r.status, r.error ?? "", r.band, r.score, r.symbol, r.name, r.sellable, r.graduated, !!r.logo,
  // Formatted, not raw. Signing the inputs meant every ETH/USD tick changed
  // every signature and repainted the whole board to render byte-identical
  // text — a 0.04% move does not change "$3.8K". Signing what is actually
  // displayed makes the check ask the only question that matters: would this
  // row look any different?
  usd(r.fdvEth), usd(r.raised, 4), pc(n(r.progress) * 100), eth(r.threshold),
  int(r.holders), pc(r.devBuyPct), pc(r.bundlePct), millions(r.tokensPerEth),
  r.creator, r.priorLaunches, r.priorDead, (r.findings || []).length, pc(r.top10Pct, 0),
  // The trade bar at the row's end.
  ...tradeBarSig(r),
]);

/** A row's signature: its launch's, and what the page around it adds (the mode's words, the limits, NEW). */
const rowSig = (r, fresh) => JSON.stringify([cardSig(r), S.mode, fresh, guardPct(),
  limitOf("MAX_DEV_BUY_PCT", 10), limitOf("MAX_BUNDLE_PCT", 5)]);

/**
 * Built rows and cards, one map per list they are drawn in (the table, and
 * each column: a launch on its curve is a card in two columns, so it is two
 * elements), by lowercased token. Kept while filtered out or while the other
 * view is shown, so a chip click or a switch of view does not rebuild them.
 *
 * @type {Map<string, Map<string, { el: any, sig: string }>>}
 */
const caches = new Map();

const clearCaches = () => caches.clear();

/**
 * Patch a list (the table's body, or a column) instead of rebuilding it.
 *
 * Rows and cards are keyed by token and only rebuilt when their own
 * signature changed. They are moved only where the order changed, so a new
 * launch landing at the top moves nothing else, and one that holds focus is
 * not taken out of the page. One that has to be rebuilt gives its focus to
 * its successor.
 *
 * @param {any} body the element the list is drawn in
 * @param {any[]} list
 * @param {any} newestRow
 * @param {string} which the list's cache: "table", or a column's id
 * @param {(r: any, fresh: boolean) => any} build
 */
function reconcile(body, list, newestRow, which, build) {
  if (!caches.has(which)) caches.set(which, new Map());
  const cache = /** @type {Map<string, { el: any, sig: string }>} */ (caches.get(which));
  const keep = new Set([...rows.keys()].map((k) => String(k).toLowerCase()));
  for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);

  const want = list.map((r) => {
    const key = String(r.token).toLowerCase();
    const fresh = isNew(r, newestRow);
    const sig = rowSig(r, fresh);
    const had = cache.get(key);
    if (had && had.sig === sig) {
      const a = had.el.querySelector && had.el.querySelector(".age");
      if (a) a.textContent = age(r.launchedAt);
      return had.el;
    }
    const el = node(build(r, fresh));
    if (!el) return null;
    cache.set(key, { el, sig });
    if (had && had.el.parentNode === body) replaceRow(had.el, el);
    return el;
  }).filter(Boolean);

  // What is no longer shown goes first, so the pass below moves a row only
  // where the order itself changed.
  const wanted = new Set(want);
  for (const el of [...(body.children || [])]) if (!wanted.has(el)) el.remove();
  let at = body.firstElementChild ?? null;
  for (const el of want) {
    if (el === at) { at = at.nextElementSibling; continue; }
    if (at) body.insertBefore(el, at); else body.appendChild(el);
  }
}

/** A rebuilt row or card takes the old one's place and, if it had it, its focus. */
function replaceRow(old, next) {
  const active = /** @type {any} */ (document.activeElement);
  const had = !!active && old.contains(active);
  old.replaceWith(next);
  if (!had) return;
  const same = active === old ? next
    : active.dataset && active.dataset.buy ? next.querySelector("[data-buy]")
    : active.dataset && active.dataset.pct ? next.querySelector(`[data-pct="${active.dataset.pct}"]`)
    : next;
  if (same && same.focus) same.focus({ preventScroll: true });
}

/**
 * How long ago a launch landed, in the fewest characters: 47s, 14m, 5h, 3d.
 * A row still being read has no launch time yet (0): a dash, never 20720d
 * (current-issues.md #6).
 */
export function age(launchedAt, now = Date.now()) {
  if (!(n(launchedAt) > 0)) return "—";
  const s = Math.max(0, Math.round(now / 1000 - n(launchedAt)));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
}

/** An hour. A launch younger than this is marked New. */
const NEW_FOR_S = 3600;

/** New: the newest launch on the board, and any other that landed in the last hour. */
export const isNew = (r, newestRow, now = Date.now()) =>
  r === newestRow || now / 1000 - n(r.launchedAt) < NEW_FOR_S;

/** A percentage cell, or a dash where the value is not known. */
const pct = (v, dp = 1) => (v == null || v === "" ? "—" : pc(v, dp));

/**
 * One launch as a table row. A click on it (not on a button) opens its token
 * page: main.js's document handler reads `data-token`, and Enter does the
 * same (bindBoard).
 *
 * @param {any} r
 * @param {boolean} fresh whether it is marked New
 */
export function boardRow(r, fresh) {
  const [bc] = bandOf(r);
  const ready = r.status === "ready";

  // A cell is tinted only when the value is over a limit the sniper enforces.
  const devLimit = limitOf("MAX_DEV_BUY_PCT", 10);
  const bundleLimit = limitOf("MAX_BUNDLE_PCT", 5);
  const tint = (v, limit) => (!ready || v == null ? "" : n(v) > limit ? "red" : n(v) > limit * 0.8 ? "amb" : "");

  return html`<tr class="link" data-token="${r.token}" data-b="${bc}" tabindex="0">
      <td class="c-tok"><div class="btok">
        ${ring(30, r.graduated ? 1 : r.progress, ringColor(r), initials(r.symbol), r.logo ? r.token : "")}
        ${tokenName(r, fresh)}</div></td>
      <td class="num c-age">${ageSpan(r)}</td>
      <td class="num c-mc"><b>${r.fdvEth == null ? "—" : usd(r.fdvEth)}</b></td>
      <td class="c-grad">${gradCell(r)}</td>
      <td class="num c-hold">${r.holders == null ? "—" : int(r.holders)}</td>
      <td class="num c-top t2">${pct(r.top10Pct)}</td>
      <td class="num c-dev t2"><span class="${tint(r.devBuyPct, devLimit)}">${pct(r.devBuyPct)}</span></td>
      <td class="num c-bun t2"><span class="${tint(r.bundlePct, bundleLimit)}">${pct(r.bundlePct)}</span></td>
      <td class="c-vd">${verdictBadge(r)}</td>
      <td class="c-act">${tradeBar(r)}</td>
    </tr>`;
}

/**
 * A launch as a card in a column of the Columns view (U3): its face, symbol
 * and name with the row's tags, market cap; its age, holders and how far to
 * graduation; then the row's verdict badge and trade bar. A click on it (not
 * on a button) opens its token page as a row's does (main.js reads
 * `data-token`), and so does Enter (bindBoard).
 *
 * @param {any} r
 * @param {boolean} fresh whether it is marked New
 */
export function boardCard(r, fresh) {
  const [bc] = bandOf(r);
  return html`<div class="bmini link" data-token="${r.token}" data-b="${bc}" tabindex="0">
      ${ring(30, r.graduated ? 1 : r.progress, ringColor(r), initials(r.symbol), r.logo ? r.token : "")}
      ${tokenName(r, fresh)}
      <b class="bmc">${r.fdvEth == null ? "—" : usd(r.fdvEth)}</b>
      <div class="bmeta">${ageSpan(r)}<span>${r.holders == null ? "—" : int(r.holders)} ${n(r.holders) === 1 ? "holder" : "holders"}</span>${gradWords(r)}</div>
      <div class="bmfoot">${verdictBadge(r)}${tradeBar(r)}</div>
    </div>`;
}

/** Symbol and name, with New, Can't sell and Check failed beside the symbol: a row's and a card's. */
function tokenName(r, fresh) {
  const noSell = r.status === "ready" && !r.graduated && r.sellable === false;
  return html`<div class="btnm"><b><span class="bsym">${r.symbol || "—"}</span>${fresh
      ? html`<span class="ltag new" title="${"Launched " + ago(n(r.launchedAt) * 1000)}">New</span>` : ""}${noSell
      ? html`<span class="ltag nosell" title="The sell simulation reverted — this cannot be exited">Can’t sell</span>` : ""}${
      r.status === "error" ? html`<span class="ltag nosell" title="${r.error || "analysis failed"}">Check failed</span>` : ""}</b>
      <span class="bname">${r.name || short(r.token)}</span></div>`;
}

/** The launch's age, with its date and time in the tooltip. reconcile() keeps `.age` current. */
const ageSpan = (r) =>
  html`<span class="age" title="${new Date(n(r.launchedAt) * 1000).toLocaleString()}">${age(r.launchedAt)}</span>`;

/**
 * The verdict: the band's words, and in the tooltip the risk score and, on a
 * hosted page, "Automated checks, not advice" (u-redesign.md, "Density vs.
 * warnings"). The same badge on a row and a card.
 */
export function verdictBadge(r) {
  const [bc, bl] = bandOf(r);
  const risk = r.status === "ready" ? `Risk ${r.score} of 100` : r.status === "error" ? "The check failed" : "analysing…";
  return html`<span class="bd band ${bc}" title="${risk + (S.mode === "hosted" ? " · " + VERDICT_NOTE : "")}">${bl}</span>`;
}

/**
 * A card's graduation, in words: the percentage (amber past the mark, with
 * the graduation's size and the mark in the tooltip, as the table's bar), or
 * graduated, with what it migrated at.
 */
function gradWords(r) {
  if (r.status !== "ready") return "";
  if (r.graduated) {
    return html`<span title="${"Migrated at " + eth(r.threshold) + " " + XI + " — trading on Uniswap V4"}">graduated</span>`;
  }
  const prog = n(r.progress) * 100;
  const guard = guardPct();
  return html`<span class="${prog >= guard ? "amb" : ""}" title="${`${pc(prog)} of the ${eth(r.threshold)} ${XI} graduation · ${
    guardLabel()} ${eth(n(r.threshold) * guard / 100)} ${XI}`}">${pc(prog)} to graduation</span>`;
}

/**
 * How far along its curve a launch is: a bar with the percentage, amber past
 * the mark where graduation is close (the console's exit guard on a self
 * page), and the graduation's size in the tooltip. A graduated token says so,
 * with the ETH it migrated at.
 */
export function gradCell(r) {
  if (r.status !== "ready") return html`<span class="t4">—</span>`;
  if (r.graduated) {
    return html`<span class="ltag grad" title="${"Migrated at " + eth(r.threshold) + " " + XI + " — trading on Uniswap V4"}">Graduated</span>`;
  }
  const prog = n(r.progress) * 100;
  const guard = guardPct();
  return html`<span class="bgrad" title="${`${pc(prog)} of the ${eth(r.threshold)} ${XI} graduation · ${guardLabel()} ${
      eth(n(r.threshold) * guard / 100)} ${XI}`}"><span class="bbar"><i class="${prog >= guard ? "hot" : ""}"
      style="width:${Math.max(2, Math.min(100, prog)).toFixed(1)}%"></i></span><span class="${prog >= guard ? "amb" : "t2"}">${pc(prog)}</span></span>`;
}

// -------------------------------------------------------------- toolbar --

/**
 * The toolbar, the heads and the rows' keys. Once, at boot: everything it
 * binds is in app.html and never repainted.
 */
export function bindBoard() {
  const table = $("#ltable");
  if (!table) return;
  $("#lchips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-f]");
    if (!chip) return;
    e.stopPropagation();
    setBoardView({ f: chip.dataset.f });
    renderLaunches();
  });
  $("#lq").addEventListener("input", (e) => { setBoardView({ q: e.target.value }); renderLaunches(); });
  $("#lsort").addEventListener("change", (e) => {
    setBoardView({ sort: SORTS.includes(e.target.value) ? e.target.value : SORTS[0], dir: 1 });
    saveSort(view.sort);
    renderLaunches();
  });
  table.querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th || !e.target.closest("button")) return;
    const s = th.dataset.sort;
    setBoardView(s === view.sort ? { dir: view.dir > 0 ? -1 : 1 } : { sort: s, dir: 1 });
    saveSort(view.sort);
    renderLaunches();
  });
  // Table | Columns, remembered in this browser (U3).
  $("#lview").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || !VIEWS.includes(b.dataset.v)) return;
    setBoardView({ layout: b.dataset.v });
    saveView(view.layout);
    renderLaunches();
  });
  // Below 960px the three columns are tabs, one shown at a time.
  $("#lctabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-col]");
    if (!b) return;
    setBoardView({ col: b.dataset.col });
    renderLaunches();
  });
  // A row or a card opens its token page on Enter, as a click does. The
  // box holds the table and the columns both.
  const box = $("#lbox");
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("tr[data-token], .bmini[data-token]")) return;
    e.preventDefault();
    go("token/" + e.target.dataset.token);
  });
  box.addEventListener("click", (e) => {
    if (!e.target.closest("[data-bclear]")) return;
    e.stopPropagation();
    setBoardView({ f: "all", q: "" });
    $("#lq").value = "";
    renderLaunches();
  });
}

// ---------------------------------------------------------------- intro --

/** Where this browser remembers that it closed the board's intro. */
export const INTRO_DISMISSED = "clank.intro";

/**
 * The first-visit line above the board (hosted): what the site is, and a way
 * to How it works. Closed for good in this browser, or for this page load
 * where storage fails.
 */
export function showIntro() {
  const bar = $("#bintro");
  if (!bar || S.mode !== "hosted") return;
  let closed = false;
  try { closed = globalThis.localStorage.getItem(INTRO_DISMISSED) === "1"; } catch { /* shown */ }
  bar.hidden = closed;
  const x = $("#bintrox");
  if (x) {
    x.onclick = () => {
      bar.hidden = true;
      try { globalThis.localStorage.setItem(INTRO_DISMISSED, "1"); } catch { /* this page load only */ }
    };
  }
}

// ------------------------------------------------ shared with other pages --

export function counts(scope, map) {
  for (const chip of $$(scope + " .chip")) {
    const nEl = $(".n", chip);
    if (nEl) nEl.textContent = map[chip.dataset.f] ?? "";
  }
}

export const findingRows = (findings) => findings.length
  ? findings.map((f) => html`<div class="frow">
        <span class="sv ${sevClass[f.severity] || "i"}">${String(f.severity).toUpperCase()}</span>
        <div><b>${f.title}</b><p>${f.detail}</p></div></div>`)
  : html`<div class="frow"><span class="sv i">INFO</span><div><b>Nothing to report</b>
        <p>Every gate passed and no rule produced a finding.</p></div></div>`;

export const flagRow = (kind, text) => html`<div class="flag ${kind}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9.2"/></svg>
    ${text}</div>`;
