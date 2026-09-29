import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { EXPLORER, GREY, GRN, RED } from "../core/constants.js";
import { $, html, paint } from "../core/dom.js";
import { bandLabel, bandOf, guardLabel, guardPct, initials, limitOf, ringColor, venueFeeBps, verdictNote } from "../core/domain.js";
import { XI, ago, breakevenPct, dur, eth, int, millions, n, pc, roundTripPct, short, sign, usd } from "../core/format.js";
import { checked, rows } from "../core/store.js";
import { ring } from "../core/svg.js";
import { CLOSE_X, holdSheet, note, toast } from "../core/ui.js";
import { chartWidth, isPhone, tipLeft } from "../core/layout.js";
import { asOfLine, readIndexLag } from "../core/indexLag.js";
import { findingRows } from "./launches.js";
import { positionFor, spreadAcross } from "./positions.js";
import {
  BUY_PRESETS, buyAmountBlocked, buyBlocked, ensureHolding, fromTradingWallet, held, heldInLedger, heldRead, holdingOf,
  ledgerBasis, savePrefs, sellBlocked, slippageBps, trader,
} from "../trade.js";
import { CHAIN_ID } from "../trade/constants.js";
import { IMPACT_WARN_PCT, sellEstimate } from "../trade/sellEstimate.js";
import { buyLabel, holdingFor, multi, sellPicker, sellWallet, splitNote, walletTicks } from "../wallets.js";
import {
  attribution, chartBar, chartSlot, dropChart, ensureFrames, mountCandles, onCandleTrade, onChartChange, refreshFrames,
  showsCandles, tfFor,
} from "./tokenChart.js";

// ====================================================================== //
// the token page (u-redesign.md, U4)                                     //
// ====================================================================== //
//
// Everything about one token on one page: the header, the chart and four
// figures, then the check, the addresses and your position as tabs, with
// the trade panel beside them (a bar and a sheet on a phone). The Checker is
// folded in: an address that is not on the board gets this same page, which
// runs the deep check (/api/check) and draws its answer. Self's server puts
// a checked token on the board as it answers (board.ts analyseInto), so the
// board's row, and the trade panel with it, follows a moment later. Hosted's
// does not (public-release B5.1): its answer says `onBoard: false`, and the
// page trades the token from a row built from that answer (`checkRow`).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const key = (a) => String(a || "").toLowerCase();

/**
 * Deep checks run from this page, by lowercased address (the one asked, and
 * the token it answered for): where the request is ("loading", "done" or
 * "error"), the answer, the error, and when it came.
 *
 * @type {Map<string, { state: string, data: any, error: string | null, at: number }>}
 */
export const checks = new Map();

/** The page's own choices: the tab under the chart, and the phone's trade sheet. */
const view = {
  tab: "check",
  tabFor: "",
  /** @type {null | { back: any, release: () => void }} */
  sheet: null,
};

/** The board's row for an address: the token's own, or the token whose curve it is. */
export function boardRow(addr) {
  const a = key(addr);
  if (!a) return null;
  const r = rows.get(a);
  if (r) return r;
  for (const x of rows.values()) if (key(x.curve) === a) return x;
  return null;
}

export async function loadHistory(token) {
  void loadCandles(token);
  // The candle chart's candles too, at the size shown (TV2).
  refreshFrames(boardRow(token));
  const r = await api("/api/history?token=" + encodeURIComponent(token));
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.points)) return;
  S.hist = r.data;
  S.histFor = String(token).toLowerCase();
  if (S.openToken && String(S.openToken).toLowerCase() === S.histFor) renderToken();
}

/** Every launch mints a billion whole tokens: market cap is price × this (X25a E6). */
const SUPPLY = 1e9;

/** A GET, with a page that could not reach the server read as status 0. */
const get = async (path) => {
  try { return await api(path); } catch { return { status: 0, data: null }; }
};

/**
 * A curve token's candles, from every trade since launch (X25b). A graduated
 * token's curve trades end at graduation, so it keeps /api/history (E7). A
 * failed read keeps the candles already drawn.
 *
 * @param {string} token
 */
export async function loadCandles(token) {
  const k = key(token);
  const row = boardRow(token);
  if (row && row.graduated) return;
  const r = await get("/api/candles?token=" + encodeURIComponent(token));
  const was = S.candles && S.candles.for === k ? S.candles : null;
  if (r.status === 200 && r.data && Array.isArray(r.data.candles)) {
    S.candles = { for: k, state: "ready", from: r.data.from, to: r.data.to, candles: r.data.candles };
  } else if (!was || was.state !== "ready") {
    S.candles = { for: k, state: r.status === 404 ? "notIndexed" : "error", from: null, to: null, candles: [] };
  }
  if (key(S.openToken) === k) renderToken();
}

/**
 * A page of the open token's trades (X25b): the newest 50, or with `before`
 * the 50 after the ones shown. Live trades that came in the meantime stay.
 *
 * @param {string} token
 * @param {string | null} [before]
 */
export async function loadTape(token, before = null) {
  const k = key(token);
  const was = S.tape && S.tape.for === k ? S.tape : null;
  if (was && (before ? was.more : was.state === "loading")) return;
  if (before && was) was.more = true;
  else S.tape = { for: k, state: "loading", trades: was ? was.trades : [], next: null, graduatedAt: null, more: false };
  rerender(k);
  if (!before) void readIndexLag();
  const r = await get(`/api/trades?token=${encodeURIComponent(token)}&limit=50${before ? "&before=" + encodeURIComponent(before) : ""}`);
  const t = S.tape && S.tape.for === k ? S.tape : null;
  if (!t) return;
  t.more = false;
  if (r.status === 200 && r.data && Array.isArray(r.data.trades)) {
    const seen = new Set(t.trades.map(tradeId));
    const got = r.data.trades.filter((x) => !seen.has(tradeId(x)));
    t.trades = sortTrades(before ? [...t.trades, ...got] : [...got, ...t.trades]);
    t.next = r.data.next ?? null;
    t.graduatedAt = r.data.graduatedAt ?? null;
    t.state = "ready";
  } else if (!before) {
    t.state = r.status === 404 ? "notIndexed" : "error";
  } else {
    toast("err", "Could not load more trades", "Try again in a moment.");
  }
  rerender(k);
}

/**
 * The open token's holders (X27b), largest first. A failed refresh keeps the
 * holders already shown.
 *
 * @param {string} token
 */
export async function loadHolders(token) {
  const k = key(token);
  const was = S.holders && S.holders.for === k ? S.holders : null;
  if (!was || was.state !== "ready") S.holders = { for: k, state: "loading", data: null };
  rerender(k);
  void readIndexLag();
  const r = await get(`/api/holders?token=${encodeURIComponent(token)}&limit=50`);
  const now = S.holders && S.holders.for === k ? S.holders : null;
  if (!now) return;
  if (r.status === 200 && r.data && Array.isArray(r.data.rows)) S.holders = { for: k, state: "ready", data: r.data };
  else if (now.state !== "ready") S.holders = { for: k, state: r.status === 404 ? "notIndexed" : "error", data: null };
  rerender(k);
}

const tradeId = (t) => `${key(t.tx)}:${t.logIndex}`;
/** Newest first, by block and place in it. */
const sortTrades = (ts) => ts.slice().sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);

/** A not-indexed tape is asked again when a live trade for it comes, at most this often. */
const TAPE_RETRY_MS = 5_000;
let tapeAskedAt = 0;
/** The page repaints for live trades at most once a second, however many come. */
let repaintTimer = /** @type {any} */ (null);
let paintedAt = 0;

function repaintSoon() {
  if (repaintTimer) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    paintedAt = Date.now();
    renderTokenIfOpen();
  }, Math.max(0, 1000 - (Date.now() - paintedAt)));
  if (typeof repaintTimer === "object" && repaintTimer.unref) repaintTimer.unref();
}

/**
 * A live trade from /events (X25a's `trade` event). Only the open token's is
 * kept: at the top of its tape if the tape is read, and counted on the tab
 * while the tab is not showing.
 *
 * @param {any} d
 */
export function onTokenTrade(d) {
  const k = key(d && d.token);
  if (!k || key(S.openToken) !== k) return;
  // Straight onto the candle chart (TV3); the repaint below finds it drawn.
  onCandleTrade(d);
  const t = S.tape && S.tape.for === k ? S.tape : null;
  if (t && t.state === "ready") {
    if (t.trades.some((x) => tradeId(x) === tradeId(d))) return;
    t.trades = sortTrades([d, ...t.trades]);
  } else if (t && t.state === "notIndexed" && Date.now() - tapeAskedAt > TAPE_RETRY_MS) {
    // The index has caught this token up: it has trades to tell of.
    tapeAskedAt = Date.now();
    void loadTape(k);
  }
  if (view.tab !== "trades") S.tapeUnseen++;
  // Balances move with every trade: an open Holders tab reads them again.
  if (view.tab === "holders" && Date.now() - holdersAskedAt > HOLDERS_REFRESH_MS) {
    holdersAskedAt = Date.now();
    void loadHolders(k);
  }
  repaintSoon();
}

/** An open Holders tab reads its holders again on a live trade, at most this often. */
const HOLDERS_REFRESH_MS = 5_000;
let holdersAskedAt = 0;

/** The address bar names the token, not its curve, without a new history entry. */
function showAddress(token) {
  const at = "#/token/" + token;
  if ($("#shell").dataset.page !== "token" || typeof history === "undefined") return;
  if (location.hash !== at) history.replaceState(null, "", at);
}

// ------------------------------------------------------------ the check --

/**
 * Run the deep check on an address, in place on its token page. A second
 * click while one runs does nothing. The answer is kept under the address
 * asked and the token it names, so a curve's address becomes its token's page.
 *
 * @param {string} addr
 */
export async function runCheck(addr) {
  const a = String(addr || "").trim();
  if (!ADDRESS.test(a)) {
    return toast("err", "That is not an address", "Paste a token or bonding-curve address.");
  }
  const k = key(a);
  const was = checks.get(k);
  if (was && was.state === "loading") return;
  checks.set(k, { state: "loading", data: was ? was.data : null, error: null, at: was ? was.at : 0 });
  rerender(k);

  let r;
  try {
    r = await api("/api/check?addr=" + encodeURIComponent(a));
  } catch {
    r = { status: 0, data: { error: "The page could not reach the server." } };
  }
  if (r.status !== 200) {
    checks.set(k, { state: "error", data: was ? was.data : null, error: (r.data && r.data.error) || "unknown error", at: Date.now() });
    return rerender(k);
  }
  const c = r.data;
  // When the server computed it: a hosted answer can be a minute old (B5.1).
  const done = { state: "done", data: c, error: null, at: c.checkedAt || Date.now() };
  checks.set(k, done);
  checks.set(key(c.token), done);
  // Hosted leaves a checked token off the board; the page trades it from the answer.
  const tradable = checkRow(c);
  if (tradable) checked.set(key(c.token), tradable);
  else checked.delete(key(c.token));
  note("check", `${c.symbol || short(c.token)} — ${bandLabel(c.band)}`);
  // A curve's address was asked: from here on the page is its token's.
  if (key(S.openToken) === k && key(c.token) !== k) {
    S.openToken = c.token;
    showAddress(c.token);
    void loadHistory(c.token);
  }
  rerender(key(c.token));
}

/**
 * A row to trade from, built from a hosted check's answer for a token that is
 * not on the board (public-release B5.1b), or null. The answer carries all the
 * trade panel reads. Its price is the check's, which the panel says; the plan
 * a trade signs is quoted from the chain when Buy or Sell is pressed.
 *
 * @param {any} c
 */
export function checkRow(c) {
  const s = c && c.onBoard === false ? c.stats : null;
  if (!s || !s.curve) return null;
  return {
    token: c.token, curve: s.curve, creator: s.creator,
    symbol: c.symbol, name: c.name, logo: "",
    band: c.band, score: c.score, findings: c.findings || [],
    sellable: s.sellable, graduated: s.graduated, readyToGraduate: s.readyToGraduate, v4: s.v4 ?? null,
    feeBps: s.feeBps, tokensPerEth: s.tokensPerEth ?? 0, fdvEth: s.fdvEth ?? 0,
    raised: s.raised ?? 0, threshold: s.threshold ?? 0, progress: s.progress ?? 0,
    holders: s.holders, top10Pct: s.top10Pct, devBuyPct: s.devBuyPct, bundlePct: s.bundlePct,
    priorLaunches: s.priorLaunches, priorDead: s.priorDead,
    block: s.launchBlock ?? 0, launchedAt: s.launchedAt ?? 0,
    status: "ready",
    /** When the check ran: this row is that moment's, and never moves. */
    fromCheck: c.checkedAt || Date.now(),
  };
}

/** Redraw the page if it is the one this check is about. */
const rerender = (k) => { if (key(S.openToken) === k) renderToken(); };

/**
 * The three gates a reader wants a yes or no on, in one set of words
 * wherever they show. Each fails on a critical finding about it, as the
 * Checker had it; Sellable fails too where the sell simulation itself said
 * no, as the board's spotlight had it. A graduated token's curve is settled,
 * so its simulation says no by design: it trades on V4, and the board never
 * calls it unsellable for that.
 */
export function checkGates(t) {
  const critical = (t.findings || []).filter((f) => f.severity === "critical");
  const hit = (re) => critical.some((f) => re.test(f.title));
  const simulated = t.graduated === true || t.sellable !== false;
  // Not known: the check could not run (current-issues.md #4). Neither a tick nor a cross.
  const unknown = t.graduated !== true && t.sellable === null && !hit(/sell|honeypot|simulat/i);
  return [
    { ok: unknown ? null : simulated && !hit(/sell|honeypot|simulat/i), label: "Sellable" },
    { ok: !hit(/factor|registr|imperson/i), label: "Factory wiring" },
    { ok: !hit(/selector|bytecode/i), label: "Canonical selectors" },
  ];
}

/**
 * The figures the page shows, for a checked token.
 *
 * The check's own `stats` come first: they are from the same analysis as the
 * findings, so "Creator buy" here is the figure the dev-buy finding quotes,
 * and a token that is not on the board (older than the backfill, or any
 * address pasted in) still has them. A null in them is the check saying it
 * does not know. The board row fills only what the check could not say: a
 * bonded token's V4 price, or everything when the answer carries no `stats`.
 * Anything neither knows is null, and prints as "—", never as 0.
 */
export function statsFor(c, row) {
  const s = c && c.stats ? c.stats : null;
  const r = row && row.status === "ready" ? row : null;
  // A bonded curve's own price froze at graduation; only a V4 read is live.
  const priced = r && (!r.graduated || r.v4) ? r : null;
  const pick = (k, from = s ? null : r) => (s ? s[k] ?? null : null) ?? (from ? (from[k] ?? null) : null);
  return {
    curve: pick("curve"),
    creator: pick("creator"),
    launchedAt: s ? s.launchedAt ?? null : r && r.launchedAt > 0 ? r.launchedAt : null,
    block: s ? s.launchBlock ?? null : r ? r.block ?? null : null,
    holders: pick("holders"),
    devBuyPct: pick("devBuyPct"),
    // The row has no "holds now" figure: only the check's own analysis does.
    creatorPct: pick("creatorPct", null),
    bundlePct: pick("bundlePct"),
    top10Pct: pick("top10Pct"),
    priorLaunches: pick("priorLaunches"),
    priorDead: pick("priorDead"),
    raised: pick("raised"),
    threshold: pick("threshold") || null,
    progress: pick("progress"),
    fdvEth: pick("fdvEth", priced),
    tokensPerEth: pick("tokensPerEth", priced),
    feeBps: pick("feeBps"),
    v4: pick("v4", priced),
    sellable: pick("sellable"),
    graduated: pick("graduated"),
  };
}

/**
 * One token, whichever way the page knows it: its board row, or a check's
 * answer (while the board has no ready row for it). `row` is the board's row
 * once it is ready, which the trade panel needs; `ready` says the verdict is in.
 */
function modelOf(row, c) {
  if (row && (row.status === "ready" || !c)) {
    const ready = row.status === "ready";
    return {
      ...row, row: ready ? row : null, ready, check: c || null, findings: row.findings || [],
      // The check alone knows what the creator holds now.
      creatorPct: c && c.stats ? c.stats.creatorPct ?? null : null,
    };
  }
  return {
    ...statsFor(c, row), token: c.token, symbol: c.symbol, name: c.name, band: c.band, score: c.score,
    findings: c.findings || [], logo: row ? row.logo : null, status: "ready", ready: true, check: c,
    // Hosted, off the board: the check's own row, so the panel can trade it (B5.1b).
    row: checked.get(key(c.token)) ?? null,
  };
}

// ------------------------------------------------------------ the chart --

/**
 * A curve token's market cap from every trade since launch (X25b), or null
 * where there are no candles for it: each candle's close × a billion, from
 * the first one's open. A close is the last trade's average price, so the
 * line ends on the board's live price, the spot after that trade: the figure
 * over the chart (the user's call, 2026-09-23). Points are [unix seconds,
 * market cap, raised or null, "live" on the last].
 *
 * @param {any} m
 * @returns {any[] | null}
 */
export function tradeSeries(m, now = Date.now()) {
  const c = S.candles;
  if (m.graduated || !c || c.for !== key(m.token) || c.state !== "ready" || !c.candles.length) return null;
  const end = c.to ?? now;
  const pts = [[c.candles[0].t0 / 1000, c.candles[0].o * SUPPLY, null]];
  for (const x of c.candles) pts.push([Math.min(x.t1, end) / 1000, x.c * SUPPLY, null]);
  const live = n(m.fdvEth);
  if (live > 0) pts.push([Math.max(now, end) / 1000, live, m.raised ?? null, "live"]);
  return pts;
}

/** The points the chart last drew, which its readout reads. */
let drawn = /** @type {any[]} */ ([]);

/**
 * The chart.
 *
 * From every trade where the index has the token's trades (`tradeSeries`);
 * otherwise sampled, not reconstructed — see src/core/lib/history.ts. The
 * footnote under it says which, because a sampled line that starts partway
 * through a token's life looks like a token that started there.
 */
function chart(points, w, h, up, offBoard = false) {
  if (offBoard) {
    // Hosted keeps no series for a token a check left off the board (B5.1).
    return html`<div class="empty tchartnone" style="min-height:${h}px">
        <b>No price history</b>Not on the board, so no price history is kept for this token.</div>`;
  }
  if (points.length < 2) {
    return html`<div class="empty tchartnone" style="min-height:${h}px">
        <b>Not enough history yet</b>The first points land as the board refreshes.</div>`;
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const mid = (hi + lo) / 2;
  // A curve that has not moved has to read flat. Left to itself the
  // autoscale expands a rounding-level difference to fill the card, so a
  // token sitting perfectly still draws what looks like a collapse. Floor the
  // visible range at ±1% of the value; real moves are far bigger than that
  // and still fill the space.
  const span = Math.max(hi - lo, Math.abs(mid) * 0.02 || 1);
  const pad = span * 0.12;
  const yLo = mid - span / 2 - pad;
  const yHi = mid + span / 2 + pad;

  const px = (t) => ((t - x0) / (x1 - x0 || 1)) * w;
  const py = (v) => h - ((v - yLo) / (yHi - yLo || 1)) * h;

  const pts = points.map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(" ");
  const colour = up ? GRN : RED;
  const last = points[points.length - 1];

  // Three gridlines, labelled in the unit the reader is actually using. The
  // drawing is stretched to the panel's width (preserveAspectRatio none), so
  // its labels and the last point's dot are drawn over it as page elements,
  // placed in pixels (the height is not stretched), where text keeps its
  // shape at every width (U8). Its lines keep theirs with non-scaling strokes.
  const ticks = [0, 0.5, 1].map((f) => ({ v: yLo + (yHi - yLo) * (1 - f), y: f * h }));
  const lines = ticks.map(({ y }) => html`<line class="gridline" x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}"
        vector-effect="non-scaling-stroke"/>`);
  const labels = ticks.map(({ v, y }) => html`<span class="axlb" style="top:${y.toFixed(1)}px">${usd(v)}</span>`);
  const dotAt = `left:${((px(last[0]) / w) * 100).toFixed(2)}%;top:${py(last[1]).toFixed(1)}px`;

  return html`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" id="chartsvg"
      style="height:${h}px" role="img" aria-label="Market cap over time">
      <defs><linearGradient id="cfill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colour}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
      </linearGradient></defs>
      ${lines}
      <polyline points="0,${h} ${pts} ${w},${h}" fill="url(#cfill)" stroke="none"/>
      <polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <line class="crosshair" id="chairline" x1="0" y1="0" x2="0" y2="${h}" style="display:none"
        vector-effect="non-scaling-stroke"/>
    </svg>${labels}<span class="chartdot ${up ? "" : "down"}" style="${dotAt}" aria-hidden="true"></span>`;
}

/**
 * Nearest-point readout. Rebound after each render of the token page.
 *
 * Pointer events, so a finger dragging along the chart reads it as a mouse
 * does (public-release F5.7). phone.css gives the chart `touch-action: pan-y`,
 * so a vertical drag still scrolls the page.
 */
function bindChartHover() {
  const svg = $("#chartsvg");
  const tip = $("#charttip");
  const line = $("#chairline");
  if (!svg || !tip || drawn.length < 2) return;

  const pts = drawn;
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];

  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const t = x0 + frac * (x1 - x0);
    let bestD = Infinity;
    for (const p of pts) bestD = Math.min(bestD, Math.abs(p[0] - t));
    // Of points within half a pixel of the nearest, the latest: the live
    // price drawn a moment after the last trade's candle is the one at the
    // right edge, as the figure over the chart is.
    const halfPx = (x1 - x0) / (box.width || 1) / 2;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) <= bestD + halfPx) best = p;
    const at = new Date(best[0] * 1000);
    tip.textContent = "";
    paint(tip, html`${usd(best[1])}<i>${best[3] === "live" ? "now · live price" : at.toTimeString().slice(0, 8)}${
      best[2] === null || best[2] === undefined ? "" : ` · ${usd(best[2])} raised`}</i>`);
    // Kept inside the panel, so a readout at either end neither spills out
    // of it nor widens a phone's page.
    tip.style.left = tipLeft(frac * box.width, box.width, tip.offsetWidth) + "px";
    tip.style.top = "0px";
    tip.classList.add("on");
    // The svg is drawn in its own user space when preserveAspectRatio is
    // none, so the crosshair x is a fraction of that, not of the pixel box.
    const vb = svg.viewBox.baseVal.width;
    line.setAttribute("x1", String(frac * vb));
    line.setAttribute("x2", String(frac * vb));
    line.style.display = "";
  };
  const hide = () => {
    tip.classList.remove("on");
    line.style.display = "none";
  };
  svg.addEventListener("pointermove", show);
  // A tap has no move before it: read the point it lands on.
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
  // The browser took the touch for a scroll.
  svg.addEventListener("pointercancel", hide);
}

// ------------------------------------------------------------- the page --

/** `f(v)` for a known number, "—" for an unknown one. */
const or = (v, f) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : f(Number(v)));

/** A moment as the page's clock shows it, HH:MM:SS. */
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

/** The way back to the board, on every state of the page. */
const BACK = html`<a class="back" href="#/">← Board</a>`;

export function renderToken() {
  const host = $("#tokbody");
  if (!S.openToken) { closeTradeSheet(); dropChart(); return paint(host, ""); }

  const row = boardRow(S.openToken);
  // A curve's address, or another casing: the page is its token's.
  if (row && key(row.token) !== key(S.openToken)) {
    S.openToken = row.token;
    showAddress(row.token);
  }
  const k = key(S.openToken);
  if (view.tabFor !== k) { view.tab = "check"; view.tabFor = k; S.tapeUnseen = 0; closeTradeSheet(); }
  const ck = checks.get(k);

  if (!row && !(ck && ck.data)) {
    closeTradeSheet();
    // On a fresh load of a /token/ link the board has not streamed in yet.
    // "Not on the board" would be a lie for the first second.
    if (!S.boardReady && rows.size === 0) {
      return paint(host, html`${BACK}<div class="empty"><b>Loading the board…</b>${short(S.openToken)}</div>`);
    }
    // Not on the board: the deep check, here. It draws the page as it goes.
    if (!ck) return void runCheck(S.openToken);
    return paint(host, ck.state === "error" ? failedPage(S.openToken, ck.error) : checkingPage(S.openToken));
  }

  const m = modelOf(row, ck && ck.data);
  if (view.sheet && !isPhone()) closeTradeSheet();
  if (candlesFor(m)) ensureFrames(m);
  const focus = keepFocus(host);
  const panel = tradePanel(m);

  paint(host, html`
      ${BACK}
      ${header(m)}
      <div class="tgrid">
        <div class="tmain">
          ${chartPanel(m)}
          ${tabsPanel(m, ck || null)}
        </div>
        <aside class="panel tpanel" id="tpanel" aria-label="Trade">${view.sheet ? "" : panel}</aside>
      </div>
      ${phoneBar(m)}`);
  if (view.sheet) paint($(".tsheetbd", view.sheet.back), panel);

  bindChartHover();
  if (candlesFor(m)) mountCandles(m);
  bindPanel();
  focus();
  if (S.mode === "hosted" && m.row) ensureHolding(m.row.token);
}

/** While the check runs: the address, and what is happening. */
const checkingPage = (addr) => html`${BACK}
    <div class="thead">
      <span class="tface skel"></span>
      <div class="ttl"><div class="tsym"><b class="big">Checking…</b></div>
        <div class="tsub"><button class="addrcopy" type="button" data-copy="${addr}"
          title="${"Copy address — " + addr}">${short(addr)}</button></div></div>
    </div>
    <div class="callout info busy" role="status"><span>Running the deep check on <span class="mo">${addr}</span>…
      this takes a second and a handful of calls.</span></div>`;

/** The check could not read it: most often an address that is not a clank.trade token. */
const failedPage = (addr, error) => html`${BACK}
    <div class="thead">
      <span class="tface" aria-hidden="true">?</span>
      <div class="ttl"><div class="tsym"><b class="big">Check failed</b></div>
        <div class="tsub"><button class="addrcopy" type="button" data-copy="${addr}"
          title="${"Copy address — " + addr}">${short(addr)}</button>
          <a class="tlink" href="${EXPLORER + "/address/" + addr}" target="_blank" rel="noopener noreferrer">Explorer ↗</a></div></div>
    </div>
    <div class="callout danger" role="alert"><span><b>The check could not read this address.</b>
      ${String(error).replace(/\.\s*$/, "")}. Nothing here can be traded: paste a clank.trade token or its bonding curve.</span>
      <button class="btn sm" type="button" data-recheck="${addr}">Check again</button></div>`;

/** The logo in its ring, the symbol and name, the address, the age, and the verdict. */
function header(m) {
  const [bc, bl] = bandOf(m);
  const colour = m.sellable === null || m.sellable === undefined ? GREY : ringColor(m);
  const noSell = m.ready && !m.graduated && m.sellable === false;
  return html`<div class="thead">
      ${ring(56, m.graduated ? 1 : m.progress ?? 0, colour, initials(m.symbol), m.logo ? m.token : "")}
      <div class="ttl">
        <div class="tsym"><b class="big">${m.symbol || "—"}</b>${noSell
          ? html`<span class="ltag nosell" title="The sell simulation reverted — this cannot be exited">Can’t sell</span>` : ""}</div>
        <div class="tsub"><span class="tname">${m.name || ""}</span>
          <button class="addrcopy" type="button" data-copy="${m.token}"
            title="${"Copy token address — " + m.token}">${short(m.token)}</button>
          <span class="tage">${m.launchedAt ? dur(Date.now() - m.launchedAt * 1000) + " old" : "age —"}</span></div>
      </div>
      <div class="tvd">
        <span class="bd ${bc}">${bl}</span>
        <div class="trisk">${m.ready ? `Risk ${m.score} of 100` : "analysing…"}</div>${verdictNote()}
      </div>
    </div>`;
}

/** Market cap and its move, the chart, the graduation bar, the honest note; then the four figures. */
function chartPanel(m) {
  const prog = m.progress === null || m.progress === undefined ? null : n(m.progress) * 100;
  const guard = guardPct();
  // Hosted, off the board: every figure is the check's, from one moment
  // (B5.1b). A series left from when it was on the board is not its history
  // now, so no change is measured against it.
  const offBoard = !!(m.row && m.row.fromCheck);
  const candles = candlesFor(m);
  const fromTrades = offBoard ? null : tradeSeries(m);
  const series = fromTrades ?? (!offBoard && S.histFor === key(m.token) ? S.hist.points : []);
  drawn = series;
  const first = series.length ? series[0][1] : n(m.fdvEth);
  const changePct = first > 0 ? ((n(m.fdvEth) - first) / first) * 100 : 0;
  const up = changePct >= 0;
  const feeBps = venueFeeBps(m);
  const known = (v) => v !== null && v !== undefined;
  const over = (v, limit) => (known(v) && Number(v) > limit ? "red" : "");
  const record = !known(m.priorLaunches) ? "prior launches —"
    : m.priorLaunches === 0 ? "first launch"
    : `${or(m.priorDead, int)} of ${m.priorLaunches} prior launches died`;

  return html`<section class="panel tchart" aria-label="Market">
      <div class="tchartin">
        <div class="tlead">
          <div>
            <div class="tk">${m.graduated ? "Market cap · V4" : "Market cap"}</div>
            <div class="tmc"><span class="mc">${or(m.fdvEth, usd)}</span>${m.graduated
              ? html`<span class="chg vio">Bonded</span>`
              : html`<span class="chg ${series.length > 1 ? (up ? "grn" : "red") : "t3"}"
                >${series.length > 1 ? sign(changePct) + "%" : "—"}</span>`}</div>
          </div>
          <div class="tright">
            <div class="tk">${m.graduated ? "Migrated at" : "Raised"}</div>
            <b>${m.graduated ? or(m.threshold, (v) => eth(v) + " " + XI) : or(m.raised, (v) => usd(v))}</b>
          </div>
        </div>

        ${candles ? html`${chartBar(m)}<div class="chartwrap">${chartSlot(isPhone() ? 240 : 300)}</div>`
          : html`<div class="chartwrap">
          ${chart(series, chartWidth(isPhone()), 200, up, offBoard)}
          <div class="tip" id="charttip"></div>
        </div>`}

        <div class="tgrad">
          <div class="bar"><i class="${m.graduated ? "" : prog !== null && prog >= guard ? "hot" : ""}"
            style="width:${m.graduated ? 100 : Math.min(100, prog ?? 0).toFixed(1)}%${
              m.graduated ? ";background:var(--vio)" : ""}"></i>${
            m.graduated ? "" : html`<u style="left:${guard}%"></u>`}</div>
          <div class="barlb">${m.graduated
            ? html`<span class="vio">Completed the curve</span><span>trading on Uniswap V4</span>`
            : html`<span>${or(prog, (v) => pc(v))} to graduation</span>
                <span>${guardLabel()} ${or(m.threshold, (v) => eth(v * guard / 100) + " " + XI)}</span>`}</div>
        </div>

        <div class="chartnote">
          <span class="dot ${m.graduated || offBoard ? "n" : S.connected ? "" : "n"}" style="box-shadow:none"></span>
          ${offBoard
            ? `Figures from the check at ${clock(m.row.fromCheck)}, not updated live`
            : m.graduated
            ? "Live price from the Uniswap V4 pool — the curve settled at graduation"
            : candles
            ? html`<span>${tfFor(m)} candles from every trade since launch</span>${attribution()}`
            : fromTrades
            ? "From every trade since launch"
            : series.length > 1
            ? `${S.hist.sampledOn === "trades" ? "Recorded at each trade" : `Sampled every ${Math.round((S.hist.sampledMs || 10000) / 1000)}s`} since ${new Date((S.hist.since || 0) * 1000).toTimeString().slice(0, 5)} — not full trade history`
            : "Sampling starts when this process first sees the curve"}
        </div>
      </div>

      <div class="tfigs">
        <div class="tfig"><span class="lb">Holders</span><b>${or(m.holders, int)}</b>
          <small>top 10 hold ${or(m.top10Pct, (v) => pc(v, 0))}</small></div>
        <div class="tfig"><span class="lb">Creator buy</span>
          <b class="${over(m.devBuyPct, limitOf("MAX_DEV_BUY_PCT", 10))}">${or(m.devBuyPct, (v) => pc(v))}</b>
          <small>${record}${known(m.creatorPct) ? ` · holds ${or(m.creatorPct, (v) => pc(v))} now` : ""}</small></div>
        <div class="tfig"><span class="lb">Launch bundle</span>
          <b class="${over(m.bundlePct, limitOf("MAX_BUNDLE_PCT", 5))}">${or(m.bundlePct, (v) => pc(v))}</b>
          <small>non-creator wallets in the launch block</small></div>
        <div class="tfig"><span class="lb">Per ${XI}</span>
          <b>${known(feeBps) ? or(m.tokensPerEth, (v) => millions(v * (1 - feeBps / 10000))) : "—"}</b>
          <small>${m.graduated && !m.v4
            ? "no V4 pool found, so no price to quote"
            : !known(feeBps) || !known(m.tokensPerEth)
            ? "no price to quote"
            : html`after the ${(feeBps / 100).toFixed(2)}% fee, before impact ·
              spot ${millions(m.tokensPerEth)}`}</small></div>
      </div>
    </section>`;
}

/** The tabs, in their order (x25-batch2-token-page.md B5); Creator comes with X28b. */
const TABS = ["check", "trades", "holders", "addr", "pos"];

/** The check, the trades, the addresses and your position, as tabs under the chart; Re-check at their right. */
function tabsPanel(m, ck) {
  const pos = positionSummary(m);
  const tab = view.tab;
  const t = (id, label, count) => html`<button type="button" role="tab" id="${"tt-" + id}" data-ttab="${id}"
      aria-selected="${tab === id}" aria-controls="tpane">${label}${
      count ? html`<span class="n">${count}</span>` : ""}</button>`;
  return html`<section class="panel ttabs">
      <div class="ttabhd">
        <div class="tabs" role="tablist" aria-label="About this token">
          ${t("check", "The check", String((m.findings || []).length))}
          ${t("trades", "Trades", S.tapeUnseen > 0 && tab !== "trades" ? (S.tapeUnseen > 99 ? "99+" : String(S.tapeUnseen)) : "")}
          ${t("holders", "Holders", "")}
          ${t("addr", "Addresses", "")}
          ${t("pos", "Your position", pos.held ? "1" : "")}
        </div>
        <button type="button" class="trecheck" data-recheck="${m.token}" aria-label="Re-check" title="Run the check again"
          ${ck && ck.state === "loading" ? "disabled" : ""}><span aria-hidden="true">↻</span><span class="trw"> Re-check</span></button>
      </div>
      <div class="tpane" id="tpane" role="tabpanel" aria-labelledby="${"tt-" + tab}">${
        tab === "trades" ? tradesPane(m) : tab === "holders" ? holdersPane(m) : tab === "addr" ? addressesPane(m) : tab === "pos" ? pos.markup : checkPane(m, ck)}</div>
    </section>`;
}

/**
 * The Trades tab (X25b): every curve trade, newest first, 50 at a time. Each
 * trader links to their Portfolio on a hosted page. The creator and the
 * launch-block buyers are tagged from what the page knows: the creator's
 * address, and the buys it has read in the launch block.
 */
function tradesPane(m) {
  const t = S.tape && S.tape.for === key(m.token) ? S.tape : null;
  const symbol = m.symbol || short(m.token);
  if (!t || (t.state === "loading" && t.trades.length === 0)) {
    return html`<div class="empty plain tempty" role="status">Loading trades…</div>`;
  }
  if (t.state === "notIndexed") {
    return tabEmpty(html`<b>Not indexed yet</b>The index has not read ${symbol}’s trades up to now. They show here once it has, usually within a minute.`);
  }
  if (t.state === "error" && t.trades.length === 0) {
    return html`<div class="callout danger" role="alert"><span><b>Could not load the trades.</b> Try again in a moment.</span>
      <button class="btn sm" type="button" data-tape-retry>Try again</button></div>`;
  }
  const graduated = t.graduatedAt ? html`<p class="ttapegrad">Trading on Uniswap since ${day(t.graduatedAt)}. Those trades are not here yet.</p>` : "";
  if (t.trades.length === 0) return html`${graduated}${tabEmpty(`No trades in ${symbol} yet.`)}`;
  const creator = key(m.creator);
  const launchBuyers = new Set(t.trades.filter((x) => x.side === "buy" && m.block && x.block === m.block).map((x) => key(x.trader)));
  const hosted = S.mode === "hosted";
  const row = (x) => {
    const who = key(x.trader);
    const tags = [who && who === creator ? html`<span class="ltag amb">creator</span>` : "",
      launchBuyers.has(who) ? html`<span class="ltag lb">launch block</span>` : ""];
    const addr = hosted
      ? html`<a class="mo" href="${"#/portfolio/" + x.trader}" title="${x.trader}">${short(x.trader)}</a>`
      : html`<a class="mo" href="${EXPLORER + "/address/" + x.trader}" target="_blank" rel="noopener noreferrer" title="${x.trader}">${short(x.trader)}</a>`;
    return html`<div class="ttr" role="row">
        <span class="c-at t3" role="cell" title="${x.atEstimated ? "Its block’s time is not read yet" : new Date(x.at).toLocaleString()}">${
          x.atEstimated ? "just now" : ago(x.at)}</span>
        <span class="c-side ${x.side === "buy" ? "grn" : "red"}" role="cell">${x.side === "buy" ? "BUY" : "SELL"}</span>
        <span class="c-eth mo" role="cell">${eth(x.eth)} ${XI}</span>
        <span class="c-tok mo t2" role="cell">${millions(x.tokens)}</span>
        <span class="c-who" role="cell">${addr}${tags}</span>
      </div>`;
  };
  return html`${asOfLine()}${graduated}<div class="ttape" role="table" aria-label="${"Trades in " + symbol}">
      <div class="ttr ttrhd" role="row"><span role="columnheader">When</span><span role="columnheader">Side</span>
        <span class="c-eth" role="columnheader">ETH</span><span class="c-tok" role="columnheader">${symbol}</span>
        <span role="columnheader">Trader</span></div>
      ${t.trades.map(row)}
    </div>${t.next
      ? html`<div class="ttapemore"><button class="btn sm" type="button" data-tape-more ${t.more ? "disabled" : ""}>${
        t.more ? "Loading…" : "Load more"}</button></div>`
      : ""}`;
}

/** A role's tag, and what it says: facts about an address on the chain, and no more (E10, D4). */
const ROLE_TAGS = {
  creator: ["amb", "creator", "The address that launched this token"],
  "launch-block": ["lb", "launch block", "First held this token in the block it launched in"],
  pool: ["grad", "pool", "The Uniswap V4 pool’s side of the market, not a position"],
  received: ["lb", "received", "Holds this token with no curve buy of its own. That says nothing about who sent it"],
};

/** ETH with its sign, as P&L reads. */
const signedEth = (v) => `${v >= 0 ? "+" : "−"}${eth(Math.abs(v))} ${XI}`;

/**
 * The Holders tab (X27b): the largest holders, what each one is, and how
 * each has done on this token, at spot and before gas. Every figure of value
 * is an estimate, and says so.
 */
function holdersPane(m) {
  const st = S.holders && S.holders.for === key(m.token) ? S.holders : null;
  const symbol = m.symbol || short(m.token);
  if (!st || st.state === "loading") return html`<div class="empty plain tempty" role="status">Loading holders…</div>`;
  if (st.state === "notIndexed") {
    return tabEmpty(html`<b>Not indexed yet</b>The index has not read ${symbol}’s holders up to now. They show here once it has, usually within a minute.`);
  }
  if (st.state === "error") {
    return html`<div class="callout danger" role="alert"><span><b>Could not load the holders.</b> Try again in a moment.</span>
      <button class="btn sm" type="button" data-holders-retry>Try again</button></div>`;
  }
  const d = st.data;
  if (!d.rows.length) return html`${asOfLine()}${tabEmpty(`Nobody holds ${symbol} outside its curve yet.`)}`;
  const hosted = S.mode === "hosted";
  const widest = Math.max(...d.rows.map((r) => n(r.pct)), 0.0001);
  const row = (r, i) => {
    const isPool = r.roles.includes("pool");
    const addr = hosted && !isPool
      ? html`<a class="mo" href="${"#/portfolio/" + r.address}" title="${r.address}">${short(r.address)}</a>`
      : html`<a class="mo" href="${EXPLORER + "/address/" + r.address}" target="_blank" rel="noopener noreferrer" title="${r.address}">${short(r.address)}</a>`;
    const tags = r.roles.map((x) => {
      const [cls, label, why] = ROLE_TAGS[x] || ["lb", x, ""];
      return html`<span class="ltag ${cls}" title="${why}">${label}</span>`;
    });
    const pnl = r.pnlEth === null || r.pnlEth === undefined
      ? html`<span class="t3">—</span>`
      : html`<b class="${r.pnlEth >= 0 ? "grn" : "red"}">${signedEth(r.pnlEth)}</b>`;
    const worth = r.nowEth === null || r.nowEth === undefined ? html`<span class="t3">—</span>` : html`${eth(r.nowEth)} ${XI}`;
    return html`<div class="thr" role="row">
        <span class="c-rank t3" role="cell">${i + 1}</span>
        <span class="c-who" role="cell">${addr}<span class="c-roles">${tags}</span></span>
        <span class="c-pct" role="cell"><span class="thbar" aria-hidden="true"><i style="width:${Math.max(2, (n(r.pct) / widest) * 100).toFixed(1)}%"></i></span>${pc(r.pct, 2)}</span>
        <span class="c-first t3" role="cell" title="${new Date(r.firstAt).toLocaleString()}">${ago(r.firstAt)}</span>
        <span class="c-pnl mo" role="cell" title="${isPool ? "The pool holds liquidity, not a position" : "Estimate: sold at spot, before price impact, fees and gas"}">${pnl}</span>
        <span class="c-now mo" role="cell">${worth}</span>
      </div>`;
  };
  return html`${asOfLine()}
    <p class="thsum"><b>${int(d.holders)} holders</b> · top 10 hold ${pc(d.top10Pct, 1)}<span class="t3"> · values at spot, estimated · P&amp;L before gas</span></p>
    ${d.graduatedAt ? html`<p class="ttapegrad">P&amp;L counts curve trades only: sells on Uniswap since ${day(d.graduatedAt)} are not here yet, so they still count as held.</p>` : ""}
    <div class="tholders" role="table" aria-label="${"Holders of " + symbol}">
      <div class="thr thrhd" role="row"><span role="columnheader">#</span><span role="columnheader">Holder</span>
        <span class="c-pct" role="columnheader">% of supply</span><span role="columnheader">First in</span>
        <span class="c-pnl" role="columnheader">P&amp;L est.</span><span class="c-now" role="columnheader">Worth now</span></div>
      ${d.rows.map(row)}
    </div>${d.holders > d.rows.length ? html`<p class="thmore t3">The largest ${d.rows.length} of ${int(d.holders)}.</p>` : ""}`;
}

/** Try the holders again, after a failed read. */
export function retryHolders() {
  if (S.openToken) void loadHolders(S.openToken);
}

/** A day as "Sep 22". */
const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Load more of the open token's trades, or try the first page again. */
export function moreTrades() {
  if (!S.openToken) return;
  const t = S.tape && S.tape.for === key(S.openToken) ? S.tape : null;
  void loadTape(S.openToken, t && t.state === "ready" ? t.next : null);
}

/** The gates, then what the check found. A re-check says it is running, then when it ran. */
function checkPane(m, ck) {
  return html`${ck && ck.state === "loading"
      ? html`<div class="callout info busy" role="status"><span>Running the check again… this takes a second.</span></div>`
      : ck && ck.state === "error"
      ? html`<div class="callout danger" role="alert"><span><b>The check could not run again.</b> ${ck.error}</span></div>`
      : ck && ck.at ? html`<p class="tchecked">Checked at ${clock(ck.at)}</p>` : ""}
    <div class="gates">${checkGates(m).map((g) => g.ok === null
      ? html`<span class="gate unk" title="The sell check could not run; it runs again on the next check"><span class="tick"></span>${g.label}?</span>`
      : html`<span class="gate ${g.ok ? "" : "no"}"><span class="tick"></span>${g.label}</span>`)}</div>
    <div class="tfind">${findingRows(m.findings || [])}</div>`;
}

/** Token, curve and creator with copy; when it launched; out to the explorer and clank.trade. */
function addressesPane(m) {
  const line = (k, a) => html`<div class="addrrow"><span class="k">${k}</span>
      <span class="v">${a || "—"}</span>${a ? html`<button class="addrcopy" type="button" data-copy="${a}"
        title="${"Copy the " + k.toLowerCase() + " address"}">copy</button>` : ""}</div>`;
  return html`${line("Token", m.token)}${line("Curve", m.curve)}${line("Creator", m.creator)}
    <div class="addrrow"><span class="k">Launched</span>
      <span class="v">${m.block ? "block " + int(m.block) : "block —"} · ${m.launchedAt ? ago(m.launchedAt * 1000) : "—"}</span></div>
    <div class="taddrlinks">
      <a class="btn sm" href="${EXPLORER + "/address/" + m.token}" target="_blank" rel="noopener noreferrer">Explorer ↗</a>
      <a class="btn sm" href="${"https://clank.trade/token/" + m.token}" target="_blank" rel="noopener noreferrer">clank.trade ↗</a>
    </div>`;
}

/** An empty state inside a tab. */
const tabEmpty = (words) => html`<div class="empty plain tempty">${words}</div>`;

/** 25, 50 or 100% to sell: the same choice on the panel and in Your position. */
const sellShares = () => html`<div class="tpre three">
    ${[25, 50, 100].map((p) => html`<button type="button" class="sellpct" aria-pressed="${p === S.sellPct}"
      data-pct-pick="${p}">${p}%</button>`)}</div>`;

/**
 * What a sell of the chosen share should bring, in ETH and dollars, and its
 * price impact (sellEstimate.js), as the buy side shows its amount in
 * dollars. Nothing when the row cannot say. A sell larger than the curve can
 * take is estimated at what it can take, and says so.
 *
 * @param {any} r the board row
 * @param {number} tokens whole tokens held
 */
function sellRows(r, tokens) {
  const part = (tokens * S.sellPct) / 100;
  const est = sellEstimate(r, part);
  if (!est) return "";
  const rate = S.stats && S.stats.price ? S.stats.price.ethUsd : null;
  const impact = est.impactPct < 0.01 ? "<0.01%" : `−${est.impactPct.toFixed(2)}%`;
  return html`<div class="tprow"><span>You receive</span>
      <b title="After the ${est.venue === "pool" ? "pool" : "curve"} fee and the price impact, before gas. An estimate from the board's price; the plan sheet has the exact quote."
        >≈ ${eth(est.netEth, 5)} ${XI}${rate ? ` · ${usd(est.netEth)}` : ""}</b></div>
    <div class="tprow"><span>Price impact</span>
      <b class="${est.impactPct >= IMPACT_WARN_PCT ? "amb" : ""}" title="What the size of this sell moves the price, fees apart">${impact}</b></div>
    ${est.capped ? html`<p class="tpnote">The curve can take at most ${millions(est.sellable)} ${r.symbol || short(r.token)} in one sell; this is for that much.</p>` : ""}`;
}

/**
 * What the Your position tab shows, and whether anything is held. A hosted
 * page knows what the wallet holds (its own read, or the ledger's) and, from
 * the ledger, what it cost; the console knows its tracked position.
 */
function positionSummary(m) {
  const r = m.row;
  const symbol = m.symbol || short(m.token);
  if (!r) return { held: false, markup: tabEmpty(`${symbol} is not on the board yet, so nothing of it can be held here.`) };
  if (S.mode !== "hosted") {
    const h = holdingFor(held.get(key(r.token)));
    const pos = positionFor(r.token, multi() && sellWallet() !== "all" ? sellWallet() : undefined);
    const has = !!(h && h.balance && h.balance !== "0") || !!pos;
    return { held: has, markup: has ? selfPosition(r) : tabEmpty(`You do not hold ${symbol}.`) };
  }
  if (!trader()) {
    return { held: false, markup: tabEmpty(fromTradingWallet()
      ? `Log in to see what you hold of ${symbol}.` : `Connect a wallet to see what you hold of ${symbol}.`) };
  }
  const h = holdingOf(r.token);
  const lh = heldInLedger(r.token);
  const tokens = h.balance !== null ? Number(h.balance) / 1e18 : lh ? Number(lh.tokens) / 1e18 : null;
  if (!tokens) {
    return { held: false, markup: tabEmpty(h.state === "error" ? `Could not read your ${symbol} balance.`
      : tokens === null ? `Reading your ${symbol} balance…` : `You don’t hold ${symbol}.`) };
  }
  const worth = r.tokensPerEth > 0 ? tokens / r.tokensPerEth : lh && lh.nowEth !== null ? lh.nowEth : null;
  const basis = ledgerBasis(r.token);
  const why = sellBlocked(r, h.balance !== null ? h : { state: "ok", balance: BigInt(lh.tokens) });
  return { held: true, markup: html`<div class="trows">
    <div class="tprow"><span>Holding</span><b>${millions(tokens)} ${symbol}</b></div>
    <div class="tprow"><span>At the current price</span>
      <b title="Before fees and price impact. The plan sheet has the exact quote.">${worth === null ? "—" : `≈ ${eth(worth, 5)} ${XI}`}</b></div>
    ${basis ? html`<div class="tprow"><span>Cost</span><b>${eth(basis.costEth, 5)} ${XI}</b></div>
      <div class="tprow"><span>P&amp;L</span><b class="${basis.pnlPct === null ? "" : basis.pnlPct >= 0 ? "grn" : "red"}"
        title="From the chain's record of this wallet, after fees">${basis.pnlPct === null ? "—" : sign(basis.pnlPct) + "%"}</b></div>` : ""}
    ${sellRows(r, tokens)}
    </div>
    ${lh && lh.capped ? html`<p class="tpnote">The curve cannot absorb the whole position in one sell.</p>` : ""}
    ${sellShares()}
    <button class="bigbtn sell" data-sell="${r.token}" data-pct="${S.sellPct}" ${why ? "disabled" : ""} title="${why || ""}"
      >${why || `Sell ${S.sellPct}%`}</button>` };
}

// ------------------------------------------------------- the trade panel --

/** The trade panel for this token, or why there is none yet. */
function tradePanel(m) {
  const r = m.row;
  if (r) return S.mode === "hosted" ? hostedTradePanel(r) : selfTradePanel(r);
  if (m.graduated && !m.v4) return noPoolPanel(m);
  return html`<div class="tphd"><h3>Trade</h3></div>
    <button class="bigbtn" type="button" disabled>${m.ready ? "Waiting for the board to list it" : "Waiting for the check"}</button>
    <p class="tpnote">${m.ready
      ? "The check puts it on the board. Buying opens when its row arrives, in a moment."
      : "Buying opens once the check has a verdict."}</p>`;
}

/** A bonded token whose canonical pool was not found. Shared by both modes. */
/** A launch paired with an ERC-20 (V4R D3): not traded here, and why. */
const pairPanel = (r) => html`
            <div class="tphd"><h3>Paired with an ERC-20</h3></div>
            <p class="cardnote" style="margin:0">${r.symbol || "This token"} trades against ${short(r.pairToken)},
              not native ETH. cumTrade trades ETH-paired launches only, for now.</p>
            <a class="btn" style="text-align:center;text-decoration:none"
              href="${"https://clank.trade/token/" + r.token}" target="_blank" rel="noopener noreferrer"
              >Open on clank.trade</a>
          `;

const noPoolPanel = (r) => html`
            <div class="tphd"><h3>No pool found</h3></div>
            <p class="cardnote" style="margin:0">This curve has bonded, but the canonical V4 pool
              for ${r.symbol || "this token"} could not be located — so there is nowhere to
              route a trade. Anyone can mint a V4 pool for any token; only the one carrying the
              factory's hook is the real one, and this token does not appear to have it.</p>
            <a class="btn" style="text-align:center;text-decoration:none"
              href="${"https://clank.trade/token/" + r.token}" target="_blank" rel="noopener noreferrer"
              >Open on clank.trade</a>
          `;

/** Buy or Sell, as a segmented switch. */
const sideSwitch = () => html`<div class="seg full tside" role="group" aria-label="Buy or sell">
    <button type="button" class="b" data-side="buy" aria-pressed="${S.tradeSide === "buy"}">Buy</button>
    <button type="button" class="s" data-side="sell" aria-pressed="${S.tradeSide === "sell"}">Sell</button></div>`;

/** The buy sizes: the one picked is every Buy button's (frame.js setBuySize). */
const presets = () => html`<div class="tpre">
    ${BUY_PRESETS.map((a) => html`<button type="button" data-size="${a}"
      aria-pressed="${S.customAmount === "" && a === S.buySize}">${a}</button>`)}</div>`;

/** The amount: ETH, with what it is in dollars under the unit. */
const amountField = (value, placeholder, dollars, type) => html`<label class="field lg tamt">
    <input id="tokamt" type="${type}" ${type === "number"
      ? html`step="0.001" min="0.001"` : html`inputmode="decimal" autocomplete="off" spellcheck="false"`}
      placeholder="${placeholder}" value="${value}" aria-label="Amount of ETH">
    <span class="tunit"><span class="unit">${XI}</span><span id="tamtusd">${dollars}</span></span></label>`;

/**
 * Slippage, edited here beside the trade. It is the top bar's buy-size
 * setting (#qslip): one source, so a change in either shows in both.
 */
const slippageRow = () => html`<div class="tprow"><span>Slippage</span><label class="tslip">
    <input id="tslip" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
      value="${(slippageBps() / 100).toFixed(1)}" aria-label="Slippage, percent"
      title="Also in the top bar's buy size"><span>%</span></label></div>`;

/**
 * The trade panel on a hosted page (public-release F3.4): the visitor's own
 * wallet, through F3.2's signing sequence.
 *
 * The self panel's shape, without anything that describes a server wallet
 * (keystore, lock, cost basis, P&L, per-trade cap). A typed amount is carried
 * as the exact string, and the sell side reads what the wallet actually holds.
 */
export function hostedTradePanel(r, h = holdingOf(r.token)) {
  if (r.pairToken) return pairPanel(r);
  if (r.graduated && !r.v4) return noPoolPanel(r);
  const symbol = r.symbol || short(r.token);
  const feeBps = venueFeeBps(r);
  const typed = S.customAmount !== "" ? S.customAmount : String(S.buySize);
  const typedNum = Number(typed);
  const buyReason = buyBlocked() ?? buyAmountBlocked(typed);
  const sellReason = sellBlocked(r, h);
  const risky = !r.graduated && (r.sellable === false || r.band === "AVOID");
  const c = S.conn;
  const tokens = h.balance === null ? null : Number(h.balance) / 1e18;

  return html`
    ${r.graduated ? html`<div class="v4note">Trading on Uniswap V4 ·
      ${(r.v4.lpFee / 10000).toFixed(2)}% pool fee</div>` : ""}
    ${sideSwitch()}

    ${S.tradeSide === "buy" ? html`
      ${presets()}
      ${amountField(S.customAmount, S.buySize, "≈ " + usd(Number.isFinite(typedNum) ? typedNum : 0), "text")}
      <button class="bigbtn ${risky ? "risky" : ""}" data-buy="${r.token}" data-amount-eth="${typed}"
        ${buyReason ? "disabled" : ""} title="${buyReason || ""}"
        >${buyReason || `Buy ${typed} ${XI}`}</button>
      ${risky ? html`<div class="tpnote twarn">${r.sellable === false
        ? "The sell simulation reverted. A position here may not be exitable."
        : "Banded AVOID."}</div>` : ""}
      <div class="trows">
        <div class="tprow"><span>${r.graduated ? "Pool fee in" : "Curve fee in"}</span>
          <b>${Number.isFinite(typedNum) ? eth(typedNum * (feeBps / 10000), 6) : "—"} ${XI}</b></div>
        <div class="tprow"><span>Round trip</span>
          <b>−${roundTripPct(feeBps).toFixed(2)}% · breakeven +${breakevenPct(feeBps).toFixed(2)}%</b></div>
      </div>
    ` : html`
      <div class="trows">
        <div class="tprow"><span>Holding</span><b>${
          h.state === "error" ? "—" : tokens === null ? "reading…" : `${millions(tokens)} ${symbol}`}</b></div>
        ${tokens && r.tokensPerEth > 0 ? html`<div class="tprow"><span>At the current price</span>
          <b title="Before fees and price impact. The plan sheet has the exact quote.">≈ ${eth(tokens / r.tokensPerEth, 5)} ${XI}</b></div>` : ""}
        ${tokens ? sellRows(r, tokens) : ""}
      </div>
      ${sellShares()}
      <button class="bigbtn sell" data-sell="${r.token}" data-pct="${S.sellPct}"
        ${sellReason ? "disabled" : ""} title="${sellReason || ""}"
        >${sellReason || `Sell ${S.sellPct}%`}</button>
    `}

    ${r.fromCheck ? html`<p class="tpnote">Price from the check at ${clock(r.fromCheck)}. The trade is quoted fresh
      when you press ${S.tradeSide === "buy" ? "Buy" : "Sell"}.</p>` : ""}

    <div class="trows tfoot">
      ${slippageRow()}
      <div class="tprow"><span>Wallet</span><b>${!c ? "not connected"
        : c.chainId !== CHAIN_ID ? "wrong network"
        : c.balanceWei === null ? "…" : `${eth(Number(c.balanceWei) / 1e18, 4)} ${XI}`}</b></div>
    </div>`;
}

/**
 * The console's position in a token: what it holds, what it cost and its
 * P&L, then its sells. On the panel's Sell side, and in Your position.
 */
function selfPosition(r) {
  const heldAll = held.get(key(r.token));
  const h = holdingFor(heldAll);
  const pos = positionFor(r.token, multi() && sellWallet() !== "all" ? sellWallet() : undefined);
  // Cost basis comes from the tracked position, which exists whether or not
  // the wallet is open. Only the sell CONTROLS need a live balance — gating
  // the numbers behind one meant a locked wallet could not tell you what a
  // position cost.
  const has = h && h.balance && h.balance !== "0";
  // Several wallets' positions in one token have one cost basis each: the
  // total's is not any one of them, so it is not shown.
  const spread = spreadAcross(r.token);
  // Spread across wallets, what is tracked is every wallet's, not the first's.
  const tracked = spread
    ? S.positions.open.filter((p) => key(p.token) === key(r.token) && !p.dryRun)
      .reduce((a, p) => a + n(p.tokens) / 1e18, 0)
    : n(pos && pos.tokens) / 1e18;
  const onChain = has ? n(h.balance) / 1e18 : null;
  // A gap means tokens moved outside this bot. Small ones are the dust a
  // capped exit leaves; a real one invalidates the basis.
  const drift = pos && onChain !== null && tracked > 0 ? Math.abs(onChain - tracked) / tracked : 0;
  const wallets = multi() && sellWallet() === "all";
  return html`${sellPicker(heldAll)}
    <div class="trows">
      <div class="tprow"><span>Holding</span>
        <b>${millions(onChain !== null ? onChain : tracked)}</b></div>
      ${spread ? html`
        ${has ? html`<div class="tprow"><span>Worth now</span><b>${usd(h.netEth)}</b></div>` : ""}
        <div class="tpnote" style="padding:6px 0">Held by ${spread.join(", ")}. Pick one
          above for its cost basis and P&amp;L.</div>
      ` : pos ? html`
        <div class="tprow"><span>Cost</span><b>${usd(pos.costEthNum)}</b></div>
        <div class="tprow"><span>Worth now</span>
          <b>${usd(has ? h.netEth : pos.nowEth)}</b></div>
        <div class="tprow"><span>P&amp;L</span>
          <b class="${n(pos.pnlPct) >= 0 ? "grn" : "red"}">${sign(n(pos.pnlPct))}%</b></div>
        <div class="tprow"><span>Price vs fees</span>
          <b style="font-size:12px">${sign(n(pos.priceMovePct))}% less ${
            n(pos.feeDragPct).toFixed(2)}%</b></div>
        <div class="tprow"><span>Breakeven</span>
          <b class="${n(pos.priceMovePct) >= n(pos.breakevenMovePct) ? "grn" : ""}"
            >+${n(pos.breakevenMovePct).toFixed(2)}%</b></div>
        ${drift > 0.01 ? html`<div class="tpnote" style="padding:6px 0;color:var(--amb)"
          >The wallet holds ${millions(onChain)} but this position tracks ${millions(tracked)}
          — tokens moved outside the bot, so the cost basis above is stale.</div>` : ""}
      ` : has ? html`
        <div class="tprow"><span>Worth now</span><b>${usd(h.netEth)}</b></div>
        <div class="tpnote" style="padding:6px 0">No cost basis — this holding predates
          position tracking, so P&amp;L cannot be computed for it.</div>` : ""}
      ${has ? html`
        <div class="tprow"><span>Sellable in one go</span>
          <b class="${h.capped ? "amb" : ""}">${h.capped
            ? pc((n(h.sellable) / n(h.balance)) * 100, 0) : "100%"}</b></div>` : ""}
    </div>
    ${has ? html`
      ${sellShares()}
      <button class="bigbtn sell" data-sell="${r.token}" data-pct="${S.sellPct}"${
        multi() ? html` data-wallet="${sellWallet()}"` : ""}
        >Sell ${S.sellPct}%${multi() && sellWallet() === "all" ? " of each wallet's" : ""}</button>
    ` : html`<div class="tpnote" style="padding:18px 0">${
        !S.wallet || !S.wallet.unlocked
          ? "The wallet is locked, so the balance cannot be read and nothing can be sold."
          : !heldRead.has(key(r.token))
            ? `Reading ${wallets ? "the wallets'" : "the wallet's"} balance…`
            : pos
              ? `This position is tracked but ${wallets ? "no wallet holds" : "the wallet holds no"} ${
                r.symbol || "tokens"} — it was sold elsewhere.`
              : `You do not hold ${r.symbol || "this token"}.`}</div>`}`;
}

/** The console's trade panel: its keystore wallet, its per-trade cap, its wallets' ticks. */
function selfTradePanel(r) {
  if (r.pairToken) return pairPanel(r);
  if (r.graduated && !r.v4) return noPoolPanel(r);
  const blocked = buyBlocked();
  const risky = !r.graduated && (r.sellable === false || r.band === "AVOID");
  const amount = S.customAmount === "" ? S.buySize : Number(S.customAmount);
  const feeBps = venueFeeBps(r);
  return html`
    ${r.graduated ? html`<div class="v4note">Trading on Uniswap V4 ·
      ${(r.v4.lpFee / 10000).toFixed(2)}% pool fee</div>` : ""}
    ${sideSwitch()}
    ${S.tradeSide === "buy" ? html`
      ${presets()}
      ${walletTicks()}
      ${amountField(S.customAmount, S.buySize, "≈ " + usd(amount), "number")}
      <button class="bigbtn ${risky ? "risky" : ""}" data-buy="${r.token}"
        data-amount="${amount}" ${blocked ? "disabled" : ""}${multi() ? html` title="${splitNote()}"` : ""}
        >${blocked ? blocked : buyLabel(amount)}</button>
      ${risky ? html`<div class="tpnote twarn">${r.sellable === false
        ? "The sell simulation reverted. A position here may not be exitable."
        : "Banded AVOID. This will ask again before sending."}</div>` : ""}
      <div class="trows">
        <div class="tprow"><span>${r.graduated ? "Pool fee in" : "Curve fee in"}</span>
          <b>${eth(amount * (feeBps / 10000), 6)} ${XI}</b></div>
        <div class="tprow"><span>Round trip</span>
          <b title="The fee costs ${(feeBps / 100).toFixed(2)}% going in and ${(feeBps / 100).toFixed(2)}% of what is left coming out."
            >−${roundTripPct(feeBps).toFixed(2)}% · breakeven +${breakevenPct(feeBps).toFixed(2)}%</b></div>
      </div>
    ` : selfPosition(r)}

    <div class="trows tfoot">
      ${slippageRow()}
      <div class="tprow"><span>${multi() ? "Wallets" : "Wallet"}</span><b>${S.wallet && S.wallet.unlocked
        ? eth(multi() ? S.wallet.totalEth : S.wallet.balanceEth, 4) + " " + XI : "locked"}</b></div>
      <div class="tprow"><span>Per-trade cap</span><b>${S.wallet && S.wallet.limits
        ? S.wallet.limits.perTradeEth + " " + XI : "—"}</b></div>
    </div>`;
}

// ------------------------------------------------ the phone's trade bar --

/**
 * On a phone (≤680) the panel is a bar above the tab bar: Buy at the size,
 * and Sell. Either opens the whole panel as a sheet, on that side. Nothing
 * to trade, no bar.
 */
function phoneBar(m) {
  const r = m.row;
  if (!r || (r.graduated && !r.v4)) return "";
  const risky = !r.graduated && (r.sellable === false || r.band === "AVOID");
  return html`<div class="tbar" role="group" aria-label="${"Trade " + (m.symbol || "")}">
      <button type="button" class="btn ${risky ? "risky" : "buy"}" data-tsheet="buy">Buy ${S.buySize} ${XI}</button>
      <button type="button" class="btn sell" data-tsheet="sell">Sell</button></div>`;
}

/** Open the trade panel as a sheet (a phone), on the side asked for. */
export function openTradeSheet(side) {
  S.tradeSide = side === "sell" ? "sell" : "buy";
  if (view.sheet) return renderToken();
  const back = document.createElement("div");
  back.className = "modal tsheetback";
  paint(back, html`<div class="mbox tsheet" role="dialog" aria-modal="true" aria-label="Trade" tabindex="-1">
      <div class="sheethd"><h3>Trade</h3>${CLOSE_X}</div>
      <div class="tsheetbd"></div></div>`);
  const shut = () => closeTradeSheet(true);
  back.addEventListener("click", (e) => {
    const t = /** @type {any} */ (e.target);
    if (t === back || t.closest("[data-x]")) shut();
  });
  document.body.appendChild(back);
  view.sheet = { back, release: () => {} };
  renderToken();
  if (view.sheet) view.sheet.release = holdSheet(back, shut, $(".tside [aria-pressed=true]", back));
}

/**
 * Close the phone's trade sheet, if one is open; the panel goes back beside
 * the chart. Closed by the person (Esc, ✕, the scrim), focus goes back to
 * the bar's button: the one that opened it was redrawn since.
 *
 * @param {boolean} [byPerson]
 */
export function closeTradeSheet(byPerson = false) {
  const s = view.sheet;
  if (!s) return;
  view.sheet = null;
  s.release();
  s.back.remove();
  if ($("#shell").dataset.page === "token" && S.openToken) renderToken();
  if (byPerson) {
    const bar = $(`.tbar [data-tsheet="${S.tradeSide === "sell" ? "sell" : "buy"}"]`);
    if (bar) bar.focus();
  }
}

/** Show one of the tabs under the chart. */
export function setTokenTab(tab) {
  view.tab = TABS.includes(tab) ? tab : "check";
  if (view.tab === "trades") {
    S.tapeUnseen = 0;
    const t = S.tape && S.openToken && S.tape.for === key(S.openToken) ? S.tape : null;
    if (S.openToken && (!t || t.state === "notIndexed" || t.state === "error")) void loadTape(S.openToken);
  }
  // Holders move with every trade: read each time the tab opens.
  if (view.tab === "holders" && S.openToken) {
    holdersAskedAt = Date.now();
    void loadHolders(S.openToken);
  }
  renderToken();
  const on = $("#tt-" + view.tab);
  if (on) on.focus();
}

// ------------------------------------------------------- keeping focus --

/**
 * The page redraws whenever the board, the wallet or a holding changes. What
 * had focus keeps it, and a field its place: someone typing an amount or a
 * slippage must not lose either. Returns what puts focus back.
 */
function keepFocus(host) {
  const el = /** @type {any} */ (document.activeElement);
  const scope = view.sheet ? view.sheet.back : host;
  if (!el || !scope || typeof scope.contains !== "function" || !scope.contains(el)) return () => {};
  const attrs = ["data-side", "data-size", "data-pct-pick", "data-ttab", "data-tsheet", "data-sellfrom", "data-wtick", "data-recheck",
    "data-tape-more"];
  const attr = attrs.find((a) => el.hasAttribute(a));
  const sel = el.id ? "#" + el.id : attr ? `[${attr}="${CSS.escape(el.getAttribute(attr))}"]` : null;
  const field = el.tagName === "INPUT";
  const caret = field ? [el.selectionStart, el.selectionEnd] : null;
  const typed = field ? el.value : null;
  return () => {
    if (!sel) return;
    const again = /** @type {any} */ ((view.sheet ? view.sheet.back : host).querySelector(sel));
    if (!again || again.disabled) return;
    // A slippage half typed is the person's, not the setting, until they commit it.
    if (field && again.id === "tslip") again.value = typed;
    again.focus();
    if (field) {
      // A number field (self) has no selection to restore; a text field has.
      try { again.setSelectionRange(caret[0], caret[1]); } catch { /* focus is enough */ }
    }
  };
}

/** The panel's fields: the amount and the slippage. Rebound after each paint. */
function bindPanel() {
  const amt = $("#tokamt");
  if (amt) amt.addEventListener("input", () => { S.customAmount = amt.value; renderTokenPanelOnly(); });
  const slip = $("#tslip");
  if (slip) {
    slip.addEventListener("change", () => setSlippage(slip.value));
    slip.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setSlippage(slip.value); } });
  }
}

/**
 * Set the slippage from the panel: a percentage above 0 and at most 50, as
 * the top bar's field allows, kept as the top bar keeps it. Anything else
 * puts the setting back.
 *
 * @param {string} typed
 */
export function setSlippage(typed) {
  const t = String(typed || "").trim().replace(",", ".").replace(/%$/, "");
  const v = /^\d*\.?\d+$/.test(t) ? Number(t) : NaN;
  const now = slippageBps() / 100;
  if (v > 0 && v <= 50) {
    if (Math.round(v * 10) / 10 !== now) {
      $("#qslip").value = String(Math.round(v * 10) / 10);
      savePrefs();
    }
  } else {
    toast("err", "Slippage not changed", "Enter a percentage above 0 and at most 50.");
  }
  renderTokenIfOpen();
  // The field keeps what was typed through a redraw; once committed it shows the setting.
  const field = $("#tslip");
  if (field) field.value = (slippageBps() / 100).toFixed(1);
}

/** Redraw the token dashboard only when it is the page being looked at. */
export const renderTokenIfOpen = () => {
  if ($("#shell").dataset.page === "token") renderToken();
};

/**
 * Whether this token's chart is the candle chart (TV2): a curve token on the
 * board, while its candles are read or being read. A graduated token, one a
 * check left off the board, or one whose candles cannot be read keeps the line.
 */
const candlesFor = (m) => !(m.row && m.row.fromCheck) && showsCandles(m);

// The chart asks for a repaint when its candles, size or axis change.
onChartChange(renderTokenIfOpen);

/** Update just the derived bits while typing, so the input keeps focus. */
function renderTokenPanelOnly() {
  const r = boardRow(S.openToken) ?? checked.get(key(S.openToken));
  if (!r) return;
  const dollars = $("#tamtusd");
  const btn = $(".bigbtn[data-buy]");
  if (S.mode === "hosted") {
    // The button's state follows the typed string exactly, not a parsed number.
    const typed = S.customAmount !== "" ? S.customAmount : String(S.buySize);
    const reason = buyBlocked() ?? buyAmountBlocked(typed);
    if (dollars) dollars.textContent = "≈ " + usd(Number.isFinite(Number(typed)) ? Number(typed) : 0);
    if (btn) {
      btn.disabled = !!reason;
      btn.title = reason || "";
      btn.textContent = reason || `Buy ${typed} ${XI}`;
      btn.dataset.amountEth = typed;
    }
    return;
  }
  const amount = S.customAmount === "" ? S.buySize : Number(S.customAmount);
  if (dollars) dollars.textContent = "≈ " + usd(amount);
  if (btn && !btn.disabled) {
    btn.textContent = buyLabel(Number.isFinite(amount) && amount > 0 ? amount : S.buySize);
    btn.dataset.amount = String(amount);
  }
}
