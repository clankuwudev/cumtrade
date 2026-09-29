// Drawing a share card on a 1080×1080 canvas (docs/specs/share-cards.md, C2).
//
// Everything is a function of `t` from 0 to 1, so the picture is the last
// frame of the same animation the video records: candles draw in, the fills
// and the top drop onto them, the headline counts up, and clankchan slides in
// with a shake on the verdict.

import { BRAND } from "../core/constants.js";
import { bigText, fmtEth } from "./model.js";

export const SIZE = 1080;
/** The whole video. */
export const DURATION_MS = 8000;
/** After this the last frame holds, so the video ends on the card. */
export const MOTION_MS = 6400;

/**
 * When the card's beats happen, as fractions of MOTION_MS. The drawing below
 * and the soundtrack (sound.js) both read these, so a sound lands on its frame.
 */
export const BEATS = {
  candles: [0.05, 0.56], count: [0.36, 0.64], art: [0.44, 0.62], verdict: [0.62, 0.72],
};

/** Seconds at which each of the card's candles starts to show. */
export function cardCandleTimes(n) {
  const out = [];
  const [a, b] = BEATS.candles;
  // reveal = ease(span(t, a, b)) * n: candle i shows once reveal passes i.
  for (let i = 0; i < n; i++) {
    const k = 1 - Math.cbrt(1 - (i + 0.001) / n);
    out.push(((a + k * (b - a)) * MOTION_MS) / 1000);
  }
  return out;
}

const BG = "#09090b", TX = "#f2f2f4", TX2 = "#a2a2aa", TX3 = "#6d6d77", LINE = "#26262c";
const VIO = "#c4b5fd", GRN = "#3fd68c", RED = "#ff5f57", AMB = "#ffb340";
const SANS = "'Schibsted Grotesk', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const PAD = 64;

const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const span = (t, a, b) => clamp((t - a) / (b - a));

/**
 * Draw one frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} card from model.js
 * @param {number} t 0..1
 * @param {HTMLImageElement | null} art
 */
export function drawCard(ctx, card, t, art) {
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SIZE, SIZE);
  drawArt(ctx, art, t);
  drawHeader(ctx, card, t);
  drawHeadline(ctx, card, t);
  drawStats(ctx, card, t);
  drawChart(ctx, card.chart, t);
  drawFooter(ctx, card, t);
  ctx.restore();
}

/** Set a font, shrinking it until `text` fits `max` pixels. Returns the size used. */
function fit(ctx, text, weight, size, family, max, min = 14) {
  let s = size;
  for (; s > min; s -= 2) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= max) break;
  }
  return s;
}

// ------------------------------------------------------------------- art --
function drawArt(ctx, art, t) {
  // Her panel: the right of the card, fading out before the stats and chart.
  const x0 = 480, w = SIZE - x0, h = 700;
  const k = ease(span(t, BEATS.art[0], BEATS.art[1]));
  let dx = (1 - k) * 90;
  // A shake when the verdict lands.
  const s = span(t, 0.7, 0.8);
  if (s > 0 && s < 1) dx += Math.sin(s * Math.PI * 7) * 12 * (1 - s);
  ctx.save();
  ctx.globalAlpha = k;
  if (art && art.naturalWidth) {
    // Cover the panel from the top of the picture, where her face is.
    const sw = art.naturalWidth, sh = art.naturalHeight;
    const aspect = w / h;
    const cw = Math.min(sw, sh * aspect), ch = cw / aspect;
    ctx.drawImage(art, (sw - cw) / 2, 0, cw, ch, x0 + dx, 0, w, h);
  } else {
    const g = ctx.createRadialGradient(x0 + w * 0.6, h * 0.4, 20, x0 + w * 0.6, h * 0.4, w * 0.7);
    g.addColorStop(0, "rgba(196,181,253,.22)");
    g.addColorStop(1, "rgba(196,181,253,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, w, h);
  }
  ctx.restore();
  // Fade her into the ground on the left, where the words are, and at the
  // bottom, where the chart is.
  let g = ctx.createLinearGradient(x0, 0, x0 + 300, 0);
  g.addColorStop(0, BG);
  g.addColorStop(0.3, "rgba(9,9,11,.8)");
  g.addColorStop(1, "rgba(9,9,11,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x0 - 1, 0, 302, h);
  g = ctx.createLinearGradient(0, 400, 0, 620);
  g.addColorStop(0, "rgba(9,9,11,0)");
  g.addColorStop(1, BG);
  ctx.fillStyle = g;
  ctx.fillRect(x0 - 1, 400, w + 1, h - 399);
}

// ---------------------------------------------------------------- header --
function drawHeader(ctx, card, t) {
  ctx.save();
  ctx.globalAlpha = ease(span(t, 0, 0.1));
  ctx.fillStyle = VIO;
  ctx.beginPath();
  ctx.arc(PAD + 9, 78, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = TX;
  ctx.font = `700 30px ${SANS}`;
  ctx.textBaseline = "middle";
  ctx.fillText(BRAND, PAD + 28, 79);
  ctx.fillStyle = TX3;
  ctx.font = `400 20px ${MONO}`;
  ctx.fillText([card.address, card.dates].filter(Boolean).join("  ·  "), PAD, 124);
  ctx.restore();
}

// -------------------------------------------------------------- headline --
function drawHeadline(ctx, card, t) {
  ctx.save();
  ctx.textBaseline = "alphabetic";
  // Kicker.
  ctx.globalAlpha = ease(span(t, 0.04, 0.16));
  ctx.fillStyle = TX2;
  ctx.letterSpacing = "3px";
  fit(ctx, card.kicker, 500, 24, MONO, 600);
  ctx.fillText(card.kicker, PAD, 236);
  ctx.letterSpacing = "0px";

  // Verdict: stamped in, big then settling.
  const vs = span(t, BEATS.verdict[0], BEATS.verdict[1]);
  if (vs > 0) {
    const scale = 1 + 0.35 * (1 - ease(vs));
    ctx.save();
    ctx.globalAlpha = ease(vs);
    ctx.translate(PAD, 310);
    ctx.scale(scale, scale);
    ctx.fillStyle = card.verdict.color;
    ctx.letterSpacing = "2px";
    fit(ctx, card.verdict.label, 800, 62, SANS, 600);
    ctx.fillText(card.verdict.label, 0, 0);
    ctx.restore();
  }

  // The number, counting up.
  const k = ease(span(t, BEATS.count[0], BEATS.count[1]));
  ctx.globalAlpha = ease(span(t, 0.36, 0.44));
  ctx.fillStyle = card.big.color;
  const text = card.big.text && k >= 1 ? card.big.text : bigText(card.big, k);
  ctx.letterSpacing = "-3px";
  fit(ctx, bigText(card.big, 1), 800, 128, SANS, 600);
  ctx.fillText(text, PAD - 4, 438);
  ctx.letterSpacing = "0px";

  // What it means.
  ctx.globalAlpha = ease(span(t, 0.5, 0.62));
  ctx.fillStyle = TX2;
  fit(ctx, card.sub, 400, 27, SANS, 620);
  ctx.fillText(card.sub, PAD, 490);
  ctx.restore();
}

// ----------------------------------------------------------------- stats --
function drawStats(ctx, card, t) {
  const colW = 210, y = 566;
  ctx.save();
  card.stats.forEach((s, i) => {
    const x = PAD + i * colW;
    ctx.globalAlpha = ease(span(t, 0.2 + i * 0.05, 0.34 + i * 0.05));
    ctx.fillStyle = TX3;
    ctx.letterSpacing = "2px";
    fit(ctx, s.label, 500, 15, MONO, colW - 20, 10);
    ctx.fillText(s.label, x, y);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = s.color;
    fit(ctx, s.value, 700, 30, SANS, colW - 20);
    ctx.fillText(s.value, x, y + 42);
    if (s.est) {
      ctx.fillStyle = TX3;
      ctx.font = `400 14px ${MONO}`;
      ctx.fillText("est.", x, y + 66);
    }
  });
  ctx.restore();
}

// ----------------------------------------------------------------- chart --
function drawChart(ctx, chart, t) {
  const x0 = PAD, x1 = SIZE - PAD, top = 800, bot = 990;
  const w = x1 - x0, h = bot - top;
  const cs = chart.candles || [];
  ctx.save();
  ctx.globalAlpha = ease(span(t, 0.02, 0.1));
  ctx.fillStyle = TX3;
  ctx.font = `400 16px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(chart.label, x0, top - 22);
  if (cs.length === 0) {
    ctx.fillStyle = TX3;
    ctx.font = `400 20px ${SANS}`;
    ctx.fillText("no price history to draw", x0, top + h / 2);
    ctx.restore();
    return;
  }

  // The range: every candle's body, the fills, the top and zero where it
  // applies. Not the wicks: one stray trade would flatten everything else,
  // so a wick past the range is drawn to the edge of the chart.
  const prices = [];
  // Not the very first open: it has nothing before it, and is often a stale
  // print or a new pool's starting price (see replay.js).
  cs.forEach((c, i) => prices.push(...(i === 0 && cs.length > 1 ? [c.c] : [c.o, c.c])));
  for (const m of chart.marks || []) if (m.price) prices.push(m.price);
  if (chart.best && chart.best.price) prices.push(chart.best.price);
  if (chart.zero) prices.push(0);
  const log = chart.scale === "log" && Math.min(...prices) > 0 && Math.max(...prices) / Math.min(...prices) > 8;
  const f = log ? Math.log : (v) => v;
  let lo = Math.min(...prices.map(f)), hi = Math.max(...prices.map(f));
  if (hi === lo) { hi += 1; lo -= 1; }
  const padv = (hi - lo) * 0.08;
  lo -= padv; hi += padv;
  const yOf = (v) => bot - ((f(v) - lo) / (hi - lo)) * h;

  const slot = w / cs.length;
  const xOfIndex = (i) => x0 + (i + 0.5) * slot;
  const xOfTime = (ms) => {
    if (ms <= cs[0].t0) return x0 + slot * 0.5;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (ms < c.t1) return x0 + (i + (ms - c.t0) / Math.max(1, c.t1 - c.t0)) * slot;
    }
    return x1 - slot * 0.5;
  };

  // Grid and zero.
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = top + (h * i) / 2;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
  if (chart.zero && lo < 0 && hi > 0) {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = TX3;
    const y = yOf(0);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // The range, for scale: on the record card only, where it is ETH. A trade
  // card's axis would be a price per token like 2.0e-6, which says nothing;
  // its TOP and NOW labels carry what matters, in ETH.
  if (chart.zero) {
    ctx.globalAlpha = ease(span(t, 0.5, 0.6));
    ctx.fillStyle = TX3;
    ctx.font = `400 14px ${MONO}`;
    ctx.textAlign = "right";
    const lab = (v) => (chart.zero ? (Math.abs(v) < 1e-9 ? "0 ETH" : fmtEth(v, true))
      : v >= 0.001 ? v.toPrecision(3) : v.toExponential(1));
    const vHi = log ? Math.exp(hi - padv) : hi - padv, vLo = log ? Math.exp(lo + padv) : lo + padv;
    ctx.fillText(lab(vHi), x1, top - 6);
    ctx.fillText(lab(vLo), x1, bot + 20);
    ctx.textAlign = "left";
  }
  ctx.globalAlpha = 1;

  // Candles, drawn in from the left.
  const reveal = ease(span(t, BEATS.candles[0], BEATS.candles[1])) * cs.length;
  const body = Math.max(3, slot * 0.62);
  ctx.globalAlpha = 1;
  for (let i = 0; i < cs.length && i < reveal; i++) {
    const c = cs[i];
    const a = clamp(reveal - i);
    const up = c.c >= c.o;
    ctx.globalAlpha = a;
    ctx.strokeStyle = ctx.fillStyle = up ? GRN : RED;
    const x = xOfIndex(i);
    ctx.lineWidth = Math.max(1.5, Math.min(3, slot * 0.12));
    const yc = (v) => Math.max(top, Math.min(bot, yOf(v)));
    ctx.beginPath(); ctx.moveTo(x, yc(c.h)); ctx.lineTo(x, yc(c.l)); ctx.stroke();
    // A body past the range stops at the chart's edge, like its wick.
    const yb = (v) => Math.max(top, Math.min(bot, yOf(v)));
    const y1 = yb(Math.max(c.o, c.c)), y2 = yb(Math.min(c.o, c.c));
    ctx.fillRect(x - body / 2, y1, body, Math.max(2, y2 - y1));
  }
  ctx.globalAlpha = 1;

  // Fills, the top and now drop in as the candles reach them.
  const edge = x0 + (reveal / cs.length) * w;
  const marks = chart.marks || [];
  const firstBuy = marks.findIndex((m) => m.kind === "buy");
  let lastSell = -1;
  marks.forEach((m, i) => { if (m.kind === "sell") lastSell = i; });
  marks.forEach((m, i) => {
    if (!m.price) return;
    const x = xOfTime(m.at);
    if (x > edge + 2) return;
    const pop = clamp((edge - x) / 60);
    const labelled = i === firstBuy || i === lastSell;
    marker(ctx, x, yOf(m.price), m.kind === "buy" ? GRN : RED, m.kind === "buy" ? "up" : "down",
      labelled ? (m.kind === "buy" ? "BUY" : "SELL") : null, pop);
  });
  if (chart.best && chart.best.price) {
    const x = xOfTime(chart.best.at);
    if (x <= edge + 2) star(ctx, x, yOf(chart.best.price), clamp((edge - x) / 60), `TOP ${fmtEth(chart.best.eth)}`);
  }
  if (reveal >= cs.length) {
    const last = cs[cs.length - 1];
    const x = xOfIndex(cs.length - 1), y = yOf(last.c);
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 10);
    ctx.fillStyle = VIO;
    ctx.globalAlpha = 0.25 + 0.25 * pulse;
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    pill(ctx, chart.nowEth != null ? `NOW ${fmtEth(chart.nowEth)}` : "NOW", x - 8, y - 28, VIO, "right");
  }

  ctx.restore();
}

function marker(ctx, x, y, color, dir, label, pop) {
  ctx.save();
  ctx.globalAlpha = pop;
  const s = 9 * (0.6 + 0.4 * pop);
  const tip = dir === "up" ? y + 6 : y - 6;
  const base = dir === "up" ? tip + s * 1.6 : tip - s * 1.6;
  ctx.fillStyle = color;
  ctx.strokeStyle = BG;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, tip); ctx.lineTo(x - s, base); ctx.lineTo(x + s, base); ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (label) pill(ctx, label, x, dir === "up" ? base + 22 : base - 12, color, "center");
  ctx.restore();
}

function star(ctx, x, y, pop, label) {
  ctx.save();
  ctx.globalAlpha = pop;
  ctx.fillStyle = AMB;
  ctx.strokeStyle = BG;
  ctx.lineWidth = 2;
  const R = 13 * (0.6 + 0.4 * pop), r = R * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  pill(ctx, label, x, y - R - 12, AMB, "center");
  ctx.restore();
}

function pill(ctx, text, x, y, color, align) {
  ctx.save();
  ctx.font = `700 14px ${MONO}`;
  ctx.letterSpacing = "1px";
  const w = ctx.measureText(text).width + 14, hgt = 22;
  const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  ctx.fillStyle = BG;
  ctx.globalAlpha *= 0.85;
  ctx.beginPath();
  ctx.roundRect(left, y - hgt + 5, w, hgt, 6);
  ctx.fill();
  ctx.globalAlpha /= 0.85;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, left + 7, y);
  ctx.restore();
}

// ---------------------------------------------------------------- footer --
function drawFooter(ctx, card, t) {
  ctx.save();
  ctx.globalAlpha = ease(span(t, 0.08, 0.2));
  ctx.fillStyle = TX3;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  fit(ctx, card.footer, 400, 15, MONO, SIZE - PAD * 2);
  ctx.fillText(card.footer, SIZE - PAD, SIZE - 34);
  ctx.restore();
}
