import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { GRN, RED } from "../core/constants.js";
import { $, html } from "../core/dom.js";
import { XI } from "../core/format.js";

// ====================================================================== //
// the token page's candlestick chart (tv-candlestick-chart.md, TV2)      //
// ====================================================================== //
//
// A curve token's candles from /api/candles?tf=, drawn by TradingView's
// Lightweight Charts (vendor/charts.js, loaded only here and only when a
// token page first needs it). The page repaints its whole body on every
// update, so the chart lives in one element of its own, made once, and is
// moved back into the page's slot after each paint: it keeps its zoom, its
// scroll and its crosshair across repaints.
//
// The library's own TradingView logo is off: it is written with innerHTML
// and an inline <style>, which the page's Trusted Types and style-src-elem
// refuse (TV0). The page shows the licence's notice and link instead
// (`attribution`).

/** The candle sizes, as /api/candles takes them. */
export const TFS = ["1s", "15s", "1m", "5m"];
const TF_MS = { "1s": 1_000, "15s": 15_000, "1m": 60_000, "5m": 300_000 };
/** Every launch mints a billion whole tokens: market cap is price × this. */
const SUPPLY = 1e9;
/** A token younger than this opens on 1s candles, unless a size was picked (O1). */
const YOUNG_MS = 10 * 60_000;
/** The picked size and axis, remembered in this browser (O5). */
const PREFS_KEY = "clank.chart";

const view = readPrefs();

function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { tf: TFS.includes(p.tf) ? p.tf : null, axis: p.axis === "price" ? "price" : "mcap" };
  } catch {
    return { tf: null, axis: "mcap" };
  }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tf: view.tf, axis: view.axis })); } catch { /* a private window */ }
}

/** Asked back by the page when something here changes: it repaints, then mounts. */
let rerender = () => {};
export function onChartChange(fn) { rerender = fn; }

const key = (a) => String(a || "").toLowerCase();

/** The size shown for a token: the one picked, or by its age (O1). */
export function tfFor(m) {
  if (view.tf) return view.tf;
  const age = m && m.launchedAt ? Date.now() - m.launchedAt * 1000 : Infinity;
  return age < YOUNG_MS ? "1s" : "1m";
}
export const axisNow = () => view.axis;

// ---------------------------------------------------------------- data --

/**
 * The open token's candles at one size: where the read is ("loading",
 * "ready", "notIndexed" or "error") and the candles, as /api/candles?tf=
 * answers them, oldest first.
 *
 * `asOfBlock` is the block the read was current to: a live trade at or before
 * it is already in the candles (TV3).
 *
 * @type {{ for: string, tf: string, state: string, candles: any[], asOfBlock: number, at: number }}
 */
let frames = { for: "", tf: "", state: "idle", candles: [], asOfBlock: 0, at: 0 };

/**
 * Read a token's candles at a size. A failed read keeps what is drawn; a
 * read for another token or size that lands late is dropped.
 *
 * @param {string} token @param {string} tf
 */
export async function loadFrames(token, tf) {
  const k = key(token);
  const same = frames.for === k && frames.tf === tf;
  if (!same) frames = { for: k, tf, state: "loading", candles: [], asOfBlock: 0, at: 0 };
  let r;
  try { r = await api(`/api/candles?token=${encodeURIComponent(token)}&tf=${tf}`); } catch { r = { status: 0, data: null }; }
  if (frames.for !== k || frames.tf !== tf) return;
  if (r.status === 200 && r.data && Array.isArray(r.data.candles)) {
    frames = { for: k, tf, state: "ready", candles: r.data.candles, asOfBlock: Number(r.data.asOfBlock) || 0, at: Date.now() };
  } else if (frames.state !== "ready") {
    frames = { for: k, tf, state: r.status === 404 ? "notIndexed" : "error", candles: [], asOfBlock: 0, at: Date.now() };
  }
  rerender();
}

/**
 * Whether the candle chart is the one to draw for this token now: a curve
 * token whose candles at its size are read or being read. On "notIndexed"
 * or "error" the page falls back to its line.
 */
export function showsCandles(m) {
  if (!m || m.graduated) return false;
  const k = key(m.token), tf = tfFor(m);
  if (frames.for !== k || frames.tf !== tf) return true; // the first read is about to start
  return frames.state === "loading" || frames.state === "ready";
}

/** Start the read for this token at its size, unless it is already the one held. */
export function ensureFrames(m) {
  const k = key(m.token), tf = tfFor(m);
  if (frames.for !== k || frames.tf !== tf) void loadFrames(m.token, tf);
}

/** Read the open token's candles again (a row changed: it traded). */
export function refreshFrames(m) {
  if (!m || m.graduated || frames.for !== key(m.token)) return;
  // Live trades move the candles in between (TV3): this only keeps them honest.
  if (frames.state === "ready" && Date.now() - frames.at < REFRESH_MS) return;
  void loadFrames(m.token, frames.tf || tfFor(m));
}
/** The candles held for the open token, oldest first: what the chart draws. */
export const candlesNow = () => frames.candles;

/** A full read of the open token's candles, at most this often. */
const REFRESH_MS = 15_000;

/**
 * A live trade in the open token (the `trade` event, TV3): into the last
 * candle, or a new one after it, and straight onto the chart. A trade the
 * last read already had, one without a price, or one older than the last
 * candle is left to the next full read.
 *
 * @param {{ token: string, block: number, at: number, price: number | null, eth: number }} d
 * @returns {boolean} whether it moved the candles
 */
export function onCandleTrade(d) {
  if (!d || frames.for !== key(d.token) || frames.state !== "ready") return false;
  if (!(d.price > 0) || !(d.block > frames.asOfBlock)) return false;
  const ms = TF_MS[frames.tf];
  const t = Math.floor(d.at / ms) * ms;
  const cs = frames.candles;
  const last = cs[cs.length - 1];
  if (last && t < last.t) return false;
  if (last && last.t === t) {
    last.h = Math.max(last.h, d.price);
    last.l = Math.min(last.l, d.price);
    last.c = d.price;
    last.v += d.eth;
  } else {
    const o = last ? last.c : d.price;
    cs.push({ t, o, h: Math.max(o, d.price), l: Math.min(o, d.price), c: d.price, v: d.eth });
  }
  drawLast();
  return true;
}

// ------------------------------------------------------------- choices --

export function setChartTf(tf) {
  if (!TFS.includes(tf)) return;
  view.tf = tf;
  savePrefs();
  rerender();
}

export function setChartAxis(axis) {
  if (axis !== "price" && axis !== "mcap") return;
  view.axis = axis;
  savePrefs();
  rerender();
}

// ------------------------------------------------------------- numbers --

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const sub = (n) => String(n).split("").map((d) => SUB[Number(d)]).join("");

/**
 * A value on the axis, in dollars when the page has an ETH price, else in
 * ETH. A market cap reads as $4.2K; a price per token keeps four significant
 * digits, and one with four or more zeros after the point writes their count
 * small, as DEX Screener does: $0.0₅2710.
 */
export function axisValue(v, axis, rate) {
  if (!Number.isFinite(v)) return "—";
  const [pre, post] = rate ? ["$", ""] : ["", " " + XI];
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a === 0) return `${pre}0${post}`;
  if (axis === "mcap" || a >= 1) {
    if (a >= 1e9) return `${s}${pre}${(a / 1e9).toFixed(2)}B${post}`;
    if (a >= 1e6) return `${s}${pre}${(a / 1e6).toFixed(2)}M${post}`;
    if (a >= 1e3) return `${s}${pre}${(a / 1e3).toFixed(1)}K${post}`;
    return `${s}${pre}${a >= 100 ? a.toFixed(0) : a.toFixed(2)}${post}`;
  }
  let e = Math.floor(Math.log10(a));
  let digits = Math.round(a / 10 ** (e - 3));
  if (digits >= 10_000) { digits = Math.round(digits / 10); e += 1; }
  const zeros = -e - 1;
  const sig = String(digits).replace(/0+$/, "") || "0";
  if (zeros >= 4) return `${s}${pre}0.0${sub(zeros)}${sig}${post}`;
  return `${s}${pre}${a.toFixed(Math.min(20, zeros + 4)).replace(/0+$/, "").replace(/\.$/, "")}${post}`;
}

const ethAmount = (v) => (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4)) + " " + XI;

/** Local time, as the page's clock shows it. */
const hms = (t) => new Date(t * 1000).toTimeString().slice(0, 8);
const hm = (t) => new Date(t * 1000).toTimeString().slice(0, 5);

// ---------------------------------------------------------- the markup --

/** The size buttons and the Price / MCap switch, over the chart. */
export function chartBar(m) {
  const tf = tfFor(m);
  return html`<div class="tvbar">
      <div class="seg sm" role="group" aria-label="Candle size">${TFS.map((x) => html`<button type="button"
        data-ctf="${x}" aria-pressed="${String(x === tf)}">${x}</button>`)}</div>
      <div class="seg sm" role="group" aria-label="Chart axis">
        <button type="button" data-caxis="price" aria-pressed="${String(view.axis === "price")}">Price</button>
        <button type="button" data-caxis="mcap" aria-pressed="${String(view.axis === "mcap")}">MCap</button>
      </div>
    </div>`;
}

/** Where the chart goes: its element is moved in after the paint. */
export function chartSlot(h) {
  const loading = frames.state !== "ready" || !lib;
  return html`<div class="tvslot" id="tvslot" style="height:${h}px">${loading
    ? html`<div class="tvwait">Loading candles…</div>` : ""}</div>`;
}

/** The licence's attribution notice and its link to TradingView (O4, TV0). */
export const attribution = () => html`<span class="tvattr"><a href="https://www.tradingview.com/" target="_blank"
    rel="noopener noreferrer">TradingView Lightweight Charts™</a> © 2025 TradingView, Inc.</span>`;

// ---------------------------------------------------------- the chart --

/** @type {any} */ let lib = null;
/** @type {Promise<any> | null} */ let libLoading = null;
/** @type {null | { el: HTMLElement, legend: HTMLElement, chart: any, candles: any, volume: any, token: string, drawn: string, fit: string }} */
let live = null;

function loadLib() {
  if (!libLoading) {
    libLoading = import("../../vendor/charts.js").then((m) => { lib = m; rerender(); return m; },
      (e) => { libLoading = null; console.warn("chart library failed to load", e); throw e; });
  }
  return libLoading;
}

const cssVar = (name, dflt) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt;

/** Make the chart inside `slot`: on the page first, so it is sized before it draws. */
function build(token, slot) {
  const el = document.createElement("div");
  el.className = "tvwrap";
  const host = document.createElement("div");
  host.className = "tvhost";
  const legend = document.createElement("div");
  legend.className = "tvlegend";
  legend.setAttribute("aria-live", "off");
  el.append(host, legend);
  slot.replaceChildren(el);
  const chart = lib.createChart(host, {
    autoSize: true,
    layout: {
      background: { type: lib.ColorType.Solid, color: "rgba(0,0,0,0)" },
      textColor: cssVar("--tx3", "#6d6d77"),
      fontFamily: cssVar("--mo", "ui-monospace, monospace"),
      fontSize: 11,
      attributionLogo: false,
    },
    grid: { vertLines: { color: cssVar("--line2", "#1c1c21") }, horzLines: { color: cssVar("--line2", "#1c1c21") } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.22 } },
    timeScale: {
      borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 4,
      // 0 year, 1 month, 2 day, 3 time, 4 time with seconds.
      tickMarkFormatter: (t, type) => (type === 4 ? hms(t) : type === 3 ? hm(t)
        : new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
    },
    localization: { timeFormatter: (t) => hms(t) },
    crosshair: { mode: lib.CrosshairMode.Normal },
    // A vertical drag on a phone scrolls the page, not the chart.
    handleScroll: { vertTouchDrag: false },
  });
  const candles = chart.addSeries(lib.CandlestickSeries, {
    upColor: GRN, downColor: RED, borderVisible: false, wickUpColor: GRN, wickDownColor: RED,
    priceLineVisible: true, lastValueVisible: true,
  });
  const volume = chart.addSeries(lib.HistogramSeries, {
    priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
  });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  chart.subscribeCrosshairMove((p) => showLegend(p && p.time !== undefined ? p.time : null));
  live = { el, legend, chart, candles, volume, token, drawn: "", fit: "" };
}

/** The shown candles, in the page's units, and what the legend reads. */
let shown = { bars: /** @type {any[]} */ ([]), axis: "mcap", rate: /** @type {number | null} */ (null) };

function showLegend(time) {
  if (!live) return;
  const bars = shown.bars;
  const b = (time === null ? null : bars.find((x) => x.time === time)) || bars[bars.length - 1];
  live.legend.replaceChildren();
  if (!b) return;
  const f = (v) => axisValue(v, shown.axis, shown.rate);
  const up = b.close >= b.open;
  for (const [k, v] of [["O", f(b.open)], ["H", f(b.high)], ["L", f(b.low)], ["C", f(b.close)], ["Vol", ethAmount(b.vol)]]) {
    const item = document.createElement("span");
    const lb = document.createElement("i");
    lb.textContent = k;
    const val = document.createElement("b");
    val.textContent = v;
    if (k !== "Vol") val.className = up ? "grn" : "red";
    item.append(lb, val);
    live.legend.append(item);
  }
}

/** The candles as the chart draws them: seconds, and the axis's unit. */
function toBars(candles, axis, rate) {
  const k = (axis === "mcap" ? SUPPLY : 1) * (rate || 1);
  return candles.map((c) => ({
    time: Math.floor(c.t / 1000), open: c.o * k, high: c.h * k, low: c.l * k, close: c.c * k, vol: c.v,
  }));
}

/**
 * After each paint of the token page: put the chart in its slot, made or
 * loaded as needed, and give it the candles if they changed.
 */
export function mountCandles(m) {
  if (!m || frames.for !== key(m.token) || frames.state !== "ready") return;
  const slot = $("#tvslot");
  if (!slot) return;
  if (!lib) { void loadLib().catch(() => {}); return; }
  const k = key(m.token);
  if (live && live.token !== k) { live.chart.remove(); live = null; }
  if (!live) build(k, slot);
  if (live.el.parentElement !== slot) slot.replaceChildren(live.el);

  const rate = S.stats && S.stats.price ? S.stats.price.ethUsd : null;
  const axis = view.axis;
  const drawn = drawnKey(axis, rate);
  if (live.drawn === drawn) return;
  live.drawn = drawn;

  const bars = toBars(frames.candles, axis, rate);
  shown = { bars, axis, rate };
  const low = bars.reduce((lo, b) => Math.min(lo, b.low), Infinity);
  // The axis steps down to four significant digits of the smallest price shown.
  const minMove = axis === "mcap" ? 0.01 : Number.isFinite(low) && low > 0 ? 10 ** (Math.floor(Math.log10(low)) - 4) : 1e-12;
  live.candles.applyOptions({ priceFormat: { type: "custom", minMove, formatter: (v) => axisValue(v, axis, rate) } });
  live.candles.setData(bars.map(({ time, open, high, low: l, close }) => ({ time, open, high, low: l, close })));
  live.volume.setData(bars.map((b) => ({ time: b.time, value: b.vol, color: (b.close >= b.open ? GRN : RED) + "59" })));
  live.chart.timeScale().applyOptions({ secondsVisible: TF_MS[frames.tf] < 60_000 });
  // A new token or size starts at its latest candles; the same one keeps where the reader scrolled to.
  const fit = `${k}|${frames.tf}`;
  if (live.fit !== fit) {
    live.fit = fit;
    const ts = live.chart.timeScale();
    const place = () => (bars.length < 80 ? ts.fitContent() : ts.scrollToRealTime());
    place();
    // Once more after layout: a chart just put on the page may not have its width yet.
    requestAnimationFrame(place);
  }
  showLegend(null);
}

/**
 * The newest candle onto the drawn chart, without setting all of them again:
 * it keeps the reader's zoom, and costs one bar. The page's next mount sees
 * nothing new to draw.
 */
function drawLast() {
  if (!live || live.token !== frames.for || !live.drawn) return;
  const { axis, rate } = shown;
  const c = frames.candles[frames.candles.length - 1];
  const [bar] = toBars([c], axis, rate);
  const bars = shown.bars;
  if (bars.length && bars[bars.length - 1].time === bar.time) bars[bars.length - 1] = bar; else bars.push(bar);
  live.candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  live.volume.update({ time: bar.time, value: bar.vol, color: (bar.close >= bar.open ? GRN : RED) + "59" });
  live.drawn = drawnKey(axis, rate);
  showLegend(null);
}

/** What the chart shows, so a mount with nothing new draws nothing. */
function drawnKey(axis, rate) {
  const last = frames.candles[frames.candles.length - 1];
  return `${frames.tf}|${axis}|${rate}|${frames.candles.length}|${last ? `${last.t}:${last.c}:${last.v}` : ""}`;
}

/** Leaving the token page: the chart goes, and a later page makes a fresh one. */
export function dropChart() {
  if (live) { live.chart.remove(); live = null; }
}
