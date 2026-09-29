// Drawing a trade replay (docs/specs/trade-replay.md, V2): entry, the candles
// growing with the camera on them, the exit, what the sell missed, and the
// result. Every frame is a function of the second it is at, with no state
// carried between frames, so the preview, the PNG and the video agree.

import { FOOTER, fmtEth } from "./model.js";
import { TIMELINE, fmtMoney, story, times, verdictLine } from "./replayModel.js";

const BG = "#06070a", TX = "#f2f2f4", TX2 = "#a2a2aa", TX3 = "#6d6d77";
const GRN = "#3fd68c", RED = "#ff5f57", AMB = "#ffb340", VIO = "#c4b5fd";
const SANS = "'Schibsted Grotesk', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const easeIO = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const span = (s, a, b) => clamp((s - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
/** Green or red by the sign of the number shown: dollars when there are any. A trade can lose ETH and still make dollars when ETH rose between the buy and the sell. What shows as nothing ($0) is neither. */
const signColor = (usd, eth) => (usd != null ? Math.abs(usd) < 0.5 : Math.abs(eth) < 0.00005) ? TX2
  : (usd ?? eth) >= 0 ? GRN : RED;

/** Where things sit, by shape. */
function layout(m) {
  const tall = m.shape === "9:16";
  return tall
    ? { tall, pad: 60, top: 400, bot: 1500, vis: 7, hudY: 118, big: 170, badge: 34 }
    : { tall, pad: 56, top: 250, bot: 900, vis: 10, hudY: 92, big: 128, badge: 30 };
}

/** How many candles are drawn at second `s`: fractional, the last one growing. */
function revealAt(s, m) {
  const T = TIMELINE;
  const n = m.candles.length;
  const heldTo = m.holding ? n : m.holdEnd + 1;
  if (s < T.entry[0]) return m.holdStart;
  if (s < T.move[0]) return m.holdStart + 0.35 * ease(span(s, T.entry[1] - 0.6, T.entry[1]));
  if (s < T.move[1]) return lerp(m.holdStart + 0.35, heldTo, easeIO(span(s, T.move[0], T.move[1])));
  if (!m.missed || s < T.missed[0]) return heldTo;
  const done = m.graduation ? T.missed[1] - STEP_SEC : T.missed[1];
  if (s < done) return lerp(heldTo, n, easeIO(span(s, T.missed[0] + 0.3, done)));
  return n;
}

/**
 * A graduated token's step (p-sell-verdict.md P4c): its candles stop at
 * graduation, where the curve's trades end, and the move since, on its pool,
 * is one dashed step to today's price. This long at the end of "missed".
 */
const STEP_SEC = 0.8;

/** How far the step has risen at second `s`: 0 before it, 1 once done. */
function stepAt(s, m) {
  if (!m.graduation || !m.graduation.nowPrice) return 0;
  const end = TIMELINE.missed[1];
  return easeIO(span(s, end - STEP_SEC, end - 0.1));
}

/** The camera: which stretch of candles is in view, in candle units. */
function cameraAt(s, m, L, rv) {
  const n = m.candles.length;
  const width = Math.min(L.vis, Math.max(5, n));
  const right = rv + 1.6;
  const T = TIMELINE;
  // The entry is framed in the middle, like a button waiting to be pressed;
  // the camera then eases over to following the newest candle.
  const centred = m.entry.index + 0.5 - width / 2;
  const followLeft = Math.max(-0.5, right - width);
  const settle = easeIO(span(s, T.move[0], T.move[0] + 1.2));
  const follow = { left: lerp(Math.min(centred, followLeft), followLeft, settle), width };
  const all = { left: -0.5, width: Math.max(width, n + 0.5) };
  if (!m.missed && !m.holding) {
    // No ghosts: pull back to the whole trade for the result.
    const k = easeIO(span(s, T.result[0] - 0.2, T.result[0] + 0.6));
    return { left: lerp(follow.left, all.left, k), width: lerp(follow.width, all.width, k) };
  }
  const k = easeIO(span(s, T.missed[0], T.missed[0] + 0.9));
  return { left: lerp(follow.left, all.left, k), width: lerp(follow.width, all.width, k) };
}

/** A candle as far as it has grown: `f` from 0 (just opened) to 1 (closed). */
function grown(c, f) {
  const k = ease(f);
  const close = lerp(c.o, c.c, k);
  return { o: c.o, c: close, h: Math.max(c.o, close, lerp(c.o, c.h, k)), l: Math.min(c.o, close, lerp(c.o, c.l, k)) };
}

/**
 * Draw the frame at `sec` seconds.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} m from replayModel
 * @param {number} sec
 * @param {HTMLImageElement | null} art
 * @param {HTMLImageElement | null} [logo] the token's own picture, for its badge
 */
export function drawReplay(ctx, m, sec, art, logo = null) {
  const L = layout(m);
  const W = m.w, H = m.h;
  const s = Math.min(sec, TIMELINE.end);
  const rv = revealAt(s, m);
  const cam = cameraAt(s, m, L, rv);

  ctx.save();
  ground(ctx, W, H);
  const geo = chart(ctx, m, L, W, s, rv, cam);
  step(ctx, m, L, s, geo);
  markers(ctx, m, L, s, geo);
  hud(ctx, m, L, W, s, rv);
  badge(ctx, m, L, s, logo);
  result(ctx, m, L, W, H, s, art, geo);
  footer(ctx, m, L, W, H, s);
  ctx.restore();
}

// ---------------------------------------------------------------- ground --
function ground(ctx, W, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.07)";
  for (let y = 20; y < H; y += 40) for (let x = 20; x < W; x += 40) ctx.fillRect(x, y, 2, 2);
  const g = ctx.createRadialGradient(W / 2, H * 0.45, W * 0.2, W / 2, H * 0.45, Math.max(W, H) * 0.75);
  g.addColorStop(0, "rgba(6,7,10,0)");
  g.addColorStop(1, "rgba(6,7,10,.85)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ----------------------------------------------------------------- range --
/** Never less than this top to bottom: a 2% wiggle should look like one. */
const MIN_SPAN = Math.log(1.25);
/** Room above the highest price for the multiple and the top, and below the lowest for the fills. */
const PAD_TOP = 0.2, PAD_BOTTOM = 0.1;

/**
 * The price range in view at second `s`, in log price, before smoothing.
 *
 * Prices are always on a log scale: a meme coin moves 50× and 2% in the same
 * minute, and switching scales partway through a video reads as a glitch. It
 * spans every candle's body in view as far as it has grown, the fills, and
 * the top once the ghosts are out; not the wicks, since a pool's first trades
 * can spike a hundredfold. A candle at the edge of the view counts in
 * proportion to how much of it is showing, so nothing pops in or out.
 */
function rawRange(m, L, s) {
  const rv = revealAt(s, m);
  const cam = cameraAt(s, m, L, rv);
  const cs = m.candles;
  const lo = Math.max(0, Math.floor(cam.left - 0.5)), hi = Math.min(cs.length - 1, Math.ceil(cam.left + cam.width));
  const inner = [], edge = [];
  const shown = (i) => clamp(i + 0.5 - cam.left) * clamp(cam.left + cam.width - (i - 0.5));
  for (let i = lo; i <= hi && i < rv; i++) {
    const g = grown(cs[i], rv - i);
    const v = shown(i);
    // The chart's very first open has nothing before it: often a stale print,
    // or a new pool's starting price before anyone arbitraged it (PROLOGUE's
    // opened 72x under its close). It is drawn, off the edge if it must be,
    // but it does not set the scale. Every other open is the last close.
    const ps = i === 0 && cs.length > 1 ? [g.c] : [g.o, g.c];
    for (const p of ps) if (p > 0) (v >= 1 ? inner : edge).push([Math.log(p), v]);
  }
  for (const f of m.fills) {
    if (f.price > 0 && f.index >= lo && f.index <= hi && f.index < rv) inner.push([Math.log(f.price), 1]);
  }
  if (m.best && m.best.price > 0 && s >= TIMELINE.missed[0] && m.best.index < rv) inner.push([Math.log(m.best.price), 1]);
  const st = stepAt(s, m);
  if (st > 0) {
    const from = Math.log(m.candles[m.graduation.index].c), to = Math.log(m.graduation.nowPrice);
    inner.push([lerp(from, to, st), 1]);
  }
  const base = inner.length ? inner : edge.length ? edge.map(([p]) => [p, 1]) : null;
  if (!base) {
    const c = cs[Math.min(cs.length - 1, m.holdStart)] ?? cs[0];
    const p = Math.log(Math.max(c ? c.o : 1, 1e-30));
    return [p - MIN_SPAN / 2, p + MIN_SPAN / 2];
  }
  let a = Math.min(...base.map(([p]) => p)), b = Math.max(...base.map(([p]) => p));
  // Edge candles stretch the range only as far as they are showing.
  for (const [p, v] of edge) {
    if (p < a) a = lerp(a, p, v);
    if (p > b) b = lerp(b, p, v);
  }
  if (b - a < MIN_SPAN) { const mid = (a + b) / 2; a = mid - MIN_SPAN / 2; b = mid + MIN_SPAN / 2; }
  return [a, b];
}

/**
 * The range the chart draws at `s`: a follow camera. It eases toward what is
 * in view as the weighted average of where it was over the last half second,
 * so candles leaving the view do not snap the scale; and it widens at once
 * when a candle grows past it, so nothing is ever drawn off the chart. Still
 * a function of `s` alone, so every render of a second is the same.
 */
function rangeAt(m, L, s) {
  let a = 0, b = 0, w = 0;
  for (let k = 0; k < 8; k++) {
    const [x, y] = rawRange(m, L, Math.max(0, s - k * 0.07));
    const wt = 8 - k;
    a += x * wt; b += y * wt; w += wt;
  }
  a /= w; b /= w;
  const [ra, rb] = rawRange(m, L, s);
  a = Math.min(a, ra);
  b = Math.max(b, rb);
  const span = b - a;
  return [a - span * PAD_BOTTOM, b + span * PAD_TOP];
}

// ----------------------------------------------------------------- chart --
function chart(ctx, m, L, W, s, rv, cam) {
  const x0 = L.pad, x1 = W - L.pad, top = L.top, bot = L.bot;
  const cs = m.candles;
  const xOf = (i) => x0 + ((i - cam.left) / cam.width) * (x1 - x0);
  const slot = (x1 - x0) / cam.width;

  const lo = Math.max(0, Math.floor(cam.left)), hi = Math.min(cs.length - 1, Math.ceil(cam.left + cam.width));
  const [a, b] = rangeAt(m, L, s);
  const yOf = (v) => bot - ((Math.log(Math.max(v, 1e-30)) - a) / (b - a)) * (bot - top);

  // Candles, the growing one last.
  const body = Math.max(6, slot * 0.56);
  for (let i = lo; i <= hi && i < rv; i++) {
    const c = cs[i];
    const g = grown(c, rv - i);
    const up = g.c >= g.o;
    const col = up ? GRN : RED;
    const x = xOf(i);
    ctx.save();
    ctx.globalAlpha = c.seg === "before" ? 0.4 : 1;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, slot * 0.07);
    if (c.seg !== "before") { ctx.shadowColor = col; ctx.shadowBlur = 22; }
    // A price past the range is drawn to the chart's edge: bodies stop at it,
    // wicks a hair beyond, so the dates below stay clear.
    const yw = (v) => clamp(yOf(v), top - 12, bot + 12);
    const yb = (v) => clamp(yOf(v), top, bot);
    ctx.beginPath(); ctx.moveTo(x, yw(g.h)); ctx.lineTo(x, yw(g.l)); ctx.stroke();
    const y1 = yb(Math.max(g.o, g.c)), y2 = yb(Math.min(g.o, g.c));
    if (c.seg === "after") {
      // Ghosts: what happened after the sell, outlined, not filled.
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.fillStyle = up ? "rgba(63,214,140,.16)" : "rgba(255,95,87,.16)";
      ctx.fillRect(x - body / 2, y1, body, Math.max(3, y2 - y1));
      ctx.strokeRect(x - body / 2, y1, body, Math.max(3, y2 - y1));
    } else {
      ctx.fillRect(x - body / 2, y1, body, Math.max(3, y2 - y1));
    }
    ctx.restore();
  }

  // The multiple rides the newest candle.
  const i = Math.min(cs.length - 1, Math.max(0, Math.ceil(rv) - 1));
  const T = TIMELINE;
  // Not over the SELL button while it is up.
  const exiting = m.exit && s >= T.exit[0] && s < T.missed[0] + 0.4;
  if (s >= T.move[0] && s < T.result[0] && cs[i] && !exiting) {
    const g = grown(cs[i], rv - i);
    const inAfter = i >= m.afterStart && m.missed;
    const mult = inAfter ? m.ifHeld[i]?.multiple : m.live[i]?.multiple;
    if (mult != null) {
      ctx.save();
      ctx.font = `700 ${L.tall ? 44 : 34}px ${MONO}`;
      ctx.fillStyle = inAfter ? AMB : mult >= 1 ? GRN : RED;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 16;
      ctx.textBaseline = "middle";
      const x = xOf(i) + body / 2 + 16;
      ctx.textAlign = x > x1 - 160 ? "right" : "left";
      ctx.fillText(times(mult), ctx.textAlign === "right" ? xOf(i) - body / 2 - 16 : x, clamp(yOf(g.h), top + 20, bot - 20));
      ctx.restore();
    }
  }

  // Dates under the chart: where the view starts, and where it ends.
  ctx.save();
  ctx.fillStyle = TX3;
  ctx.font = `400 ${L.tall ? 24 : 20}px ${MONO}`;
  const first = cs[lo], last = cs[Math.min(hi, Math.max(0, Math.ceil(rv) - 1))];
  const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (first) ctx.fillText(day(first.t0), x0, bot + 56);
  if (last) { ctx.textAlign = "right"; ctx.fillText(day(last.t1), x1, bot + 56); }
  ctx.restore();

  return { xOf, yOf, slot, body, top, bot, x0, x1 };
}

// --------------------------------------------------------------- markers --
function rings(ctx, x, y, color, s0, s, big) {
  const k = s - s0;
  ctx.save();
  for (let r = 0; r < 3; r++) {
    const phase = (k * 0.9 + r / 3) % 1;
    ctx.globalAlpha = (1 - phase) * 0.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(x, y, big * (0.55 + phase * 1.3), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = color; ctx.shadowBlur = 30;
  ctx.fillStyle = BG;
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(x, y, big * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = TX;
  ctx.beginPath(); ctx.arc(x, y, big * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function pillLabel(ctx, text, x, y, color, size) {
  ctx.save();
  ctx.font = `700 ${size}px ${MONO}`;
  ctx.letterSpacing = "4px";
  const w = ctx.measureText(text).width + size * 1.4, h = size * 1.9;
  ctx.fillStyle = "rgba(6,7,10,.85)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = TX;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + 2, y + 1);
  ctx.restore();
}

function glowText(ctx, text, x, y, size, color, align = "center", weight = 800) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${SANS}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.35;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function markers(ctx, m, L, s, g) {
  const T = TIMELINE;
  const big = L.tall ? 150 : 110;
  const at = (i, price) => ({ x: g.xOf(i), y: clamp(g.yOf(price ?? m.candles[i]?.c ?? 0), g.top + 30, g.bot - 30) });
  // The buttons and their labels always sit wholly inside the frame.
  const inside = (p) => ({ x: clamp(p.x, big * 1.35, m.w - big * 1.35), y: clamp(p.y, g.top + big * 1.2, g.bot - big * 0.6) });

  // Entry: the BUY button and what went in.
  const e = inside(at(m.entry.index, m.entry.price));
  if (s >= T.entry[0] && s < T.move[0] + 0.5) {
    const k = ease(span(s, T.entry[0], T.entry[0] + 0.5));
    const out = 1 - span(s, T.move[0], T.move[0] + 0.5);
    ctx.save();
    ctx.globalAlpha = k * out;
    rings(ctx, e.x, e.y, GRN, T.entry[0], s, big * (0.8 + 0.2 * k));
    pillLabel(ctx, "BUY", e.x, e.y + big * 0.95, GRN, L.tall ? 34 : 26);
    const label = `${fmtMoney(m.entry.usd, m.entry.eth)}${m.entry.count > 1 ? ` ×${m.entry.count}` : ""}`;
    glowText(ctx, label, e.x, e.y - big * 1.05, L.tall ? 72 : 54, GRN);
    ctx.restore();
  }

  // The fills, small, once the camera has passed them.
  const rv = revealAt(s, m);
  for (const f of m.fills) {
    if (f.index >= rv || !f.price) continue;
    if (f.kind === "buy" && s < T.move[0] + 0.3) continue;
    if (f.kind === "sell" && s < T.exit[1]) continue;
    const p = at(f.index, f.price);
    const col = f.kind === "buy" ? GRN : AMB;
    ctx.save();
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, L.tall ? 13 : 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = BG; ctx.shadowBlur = 0;
    ctx.font = `800 ${L.tall ? 15 : 12}px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(f.kind === "buy" ? "B" : "S", p.x, p.y + 1);
    ctx.restore();
  }

  // Exit: the SELL button and what came out.
  if (m.exit && s >= T.exit[0] && s < T.missed[0] + 0.6) {
    const x = inside(at(m.exit.index, m.exit.price));
    const k = ease(span(s, T.exit[0], T.exit[0] + 0.4));
    const out = 1 - span(s, T.missed[0], T.missed[0] + 0.6);
    ctx.save();
    ctx.globalAlpha = k * out;
    rings(ctx, x.x, x.y, AMB, T.exit[0], s, big * (0.8 + 0.2 * k));
    pillLabel(ctx, "SELL", x.x, x.y + big * 0.95, AMB, L.tall ? 34 : 26);
    glowText(ctx, `SOLD ${fmtMoney(m.exit.usd, m.exit.eth)}`, x.x, x.y - big * 1.05, L.tall ? 64 : 48, AMB);
    ctx.restore();
  }

  // What the sell missed: where it sold, the top, and today.
  if (m.missed && s >= T.missed[0] + 0.5) {
    const k = ease(span(s, T.missed[0] + 0.5, T.missed[0] + 1));
    const fade = 1 - span(s, T.result[0], T.result[0] + 0.4);
    ctx.save();
    ctx.globalAlpha = k * fade;
    const x = at(m.exit.index, m.exit.price);
    ctx.font = `700 ${L.tall ? 24 : 19}px ${MONO}`; ctx.fillStyle = AMB; ctx.textAlign = "center";
    ctx.fillText(m.words.sold, x.x, x.y + (L.tall ? 44 : 34));
    if (m.best && m.best.price && m.best.index < rv) {
      const b = at(m.best.index, m.best.price);
      star(ctx, b.x, b.y, L.tall ? 22 : 17);
      ctx.font = `700 ${L.tall ? 26 : 20}px ${MONO}`; ctx.fillStyle = AMB;
      ctx.fillText(`TOP ${fmtMoney(m.best.usd, m.best.eth)}`, b.x, b.y - (L.tall ? 38 : 30));
    }
    ctx.restore();
  }
}

function star(ctx, x, y, R) {
  ctx.save();
  ctx.fillStyle = AMB; ctx.shadowColor = AMB; ctx.shadowBlur = 20;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 === 0 ? R : R * 0.45;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------- hud --
function hud(ctx, m, L, W, s, rv) {
  const T = TIMELINE;
  if (s < T.move[0] - 0.2 || s >= T.result[0] + 0.3) return;
  const fade = ease(span(s, T.move[0] - 0.2, T.move[0] + 0.2)) * (1 - span(s, T.result[0], T.result[0] + 0.3));
  const at = (arr) => {
    // Between two candles' values, by how far the newer one has grown.
    const i = Math.min(arr.length - 1, Math.max(0, Math.ceil(rv) - 1));
    const cur = arr[i], prev = arr[i - 1];
    if (!cur) return null;
    const f = clamp(rv - i);
    if (!prev || cur.usd == null || prev.usd == null) return cur;
    return { ...cur, usd: lerp(prev.usd, cur.usd, f), eth: lerp(prev.eth, cur.eth, f) };
  };
  let label, value, color, sub1, sub2;
  if (m.missed && s >= T.missed[0]) {
    let v = at(m.ifHeld) ?? { usd: m.exit.usd, eth: m.exit.eth };
    const st = stepAt(s, m);
    if (st > 0 && m.now) {
      // Up the step to today's value, on the pool since graduation.
      const g = m.graduation;
      const lastUsd = m.ifHeld[g.index]?.usd ?? null;
      v = { eth: lerp(g.eth, m.now.eth, st), usd: lastUsd != null && m.now.usd != null ? lerp(lastUsd, m.now.usd, st) : null };
    }
    label = m.words.held; value = fmtMoney(v.usd, v.eth); color = AMB;
    sub1 = m.words.got; sub2 = fmtMoney(m.exit.usd, m.exit.eth);
  } else if (m.exit && s >= T.exit[0] + 0.2) {
    label = "REALISED P&L"; value = fmtMoney(m.realised.usd, m.realised.eth, true);
    color = signColor(m.realised.usd, m.realised.eth);
    sub1 = "INVESTED"; sub2 = fmtMoney(m.entry.usd, m.entry.eth);
  } else {
    const v = at(m.live) ?? { usd: 0, eth: 0 };
    label = "LIVE P&L"; value = fmtMoney(v.usd, v.eth, true); color = signColor(v.usd, v.eth);
    sub1 = "INVESTED"; sub2 = fmtMoney(m.entry.usd, m.entry.eth);
  }
  const x = W - L.pad, y = L.hudY;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = "right";
  ctx.fillStyle = TX3;
  ctx.font = `600 ${L.tall ? 22 : 18}px ${MONO}`;
  ctx.letterSpacing = "3px";
  ctx.fillText(label, x, y);
  ctx.letterSpacing = "0px";
  glowText(ctx, value, x, y + (L.tall ? 58 : 46), L.tall ? 76 : 58, color, "right");
  ctx.fillStyle = TX3;
  ctx.font = `600 ${L.tall ? 20 : 16}px ${MONO}`;
  ctx.letterSpacing = "3px";
  ctx.fillText(sub1, x, y + (L.tall ? 128 : 100));
  ctx.letterSpacing = "0px";
  ctx.fillStyle = TX2;
  ctx.font = `700 ${L.tall ? 40 : 32}px ${SANS}`;
  ctx.fillText(sub2, x, y + (L.tall ? 172 : 136));
  ctx.restore();
}

// ----------------------------------------------------------------- badge --
function badge(ctx, m, L, s, logo) {
  ctx.save();
  ctx.globalAlpha = ease(span(s, 0, 0.5));
  const x = L.pad, y = L.hudY - 26, h = L.tall ? 64 : 54;
  ctx.font = `800 ${L.badge}px ${SANS}`;
  const text = `$${m.symbol}`;
  const w = ctx.measureText(text).width + h + 26;
  ctx.fillStyle = "#101116"; ctx.strokeStyle = "#26262c"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.fill(); ctx.stroke();
  if (logo && logo.naturalWidth) {
    // The token's own picture, cropped square (p-sell-verdict.md P4c).
    const side = Math.min(logo.naturalWidth, logo.naturalHeight);
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + 8, y + 8, h - 16, h - 16, 10); ctx.clip();
    ctx.drawImage(logo, (logo.naturalWidth - side) / 2, (logo.naturalHeight - side) / 2, side, side, x + 8, y + 8, h - 16, h - 16);
    ctx.restore();
  } else {
    ctx.fillStyle = VIO;
    ctx.beginPath(); ctx.roundRect(x + 8, y + 8, h - 16, h - 16, 10); ctx.fill();
    ctx.fillStyle = BG;
    ctx.font = `800 ${Math.round(h * 0.38)}px ${SANS}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(m.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase(), x + h / 2, y + h / 2 + 1);
  }
  ctx.fillStyle = TX; ctx.textAlign = "left";
  ctx.font = `800 ${L.badge}px ${SANS}`;
  ctx.fillText(text, x + h + 8, y + h / 2 + 1);
  ctx.fillStyle = TX3;
  ctx.font = `400 ${L.tall ? 22 : 18}px ${MONO}`;
  ctx.fillText(m.dates, x + 4, y + h + (L.tall ? 32 : 26));
  ctx.restore();
}

// ------------------------------------------------------------------ step --
/** A graduated token's dashed step, from the curve's last price to today's on its pool. */
function step(ctx, m, L, s, g) {
  const st = stepAt(s, m);
  if (st <= 0) return;
  const gr = m.graduation;
  const x0 = g.xOf(gr.index), x1 = x0 + Math.max(g.slot * 0.9, 40);
  const from = m.candles[gr.index].c;
  const to = Math.exp(lerp(Math.log(from), Math.log(gr.nowPrice), st));
  const y0 = clamp(g.yOf(from), g.top, g.bot), y1 = clamp(g.yOf(to), g.top, g.bot);
  ctx.save();
  ctx.strokeStyle = AMB; ctx.lineWidth = L.tall ? 5 : 4; ctx.setLineDash([14, 10]);
  ctx.shadowColor = AMB; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.setLineDash([]);
  if (st >= 1) {
    ctx.fillStyle = AMB;
    ctx.beginPath(); ctx.arc(x1, y1, L.tall ? 12 : 9, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // The label goes as the result comes in: its words would sit on the story.
    ctx.globalAlpha = 1 - span(s, TIMELINE.result[0], TIMELINE.result[0] + 0.3);
    ctx.font = `700 ${L.tall ? 22 : 17}px ${MONO}`;
    ctx.textAlign = x1 > g.x1 - 280 ? "right" : "left";
    const tx = ctx.textAlign === "right" ? x1 - 22 : x1 + 22;
    ctx.fillText("ON UNISWAP SINCE GRADUATION", tx, clamp(y1 + (L.tall ? 44 : 34), g.top + 20, g.bot - 10));
  }
  ctx.restore();
}

/** Over the dimmed chart at the result: the buy, the sell, and where it is now. */
function pins(ctx, m, L, s, g, k) {
  const at = (i, price) => ({ x: g.xOf(i), y: clamp(g.yOf(price), g.top + 20, g.bot - 20) });
  ctx.save();
  ctx.globalAlpha = k;
  for (const f of m.fills) {
    if (!f.price) continue;
    const p = at(f.index, f.price);
    const col = f.kind === "buy" ? GRN : AMB;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, L.tall ? 13 : 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = BG; ctx.shadowBlur = 0;
    ctx.font = `800 ${L.tall ? 15 : 12}px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(f.kind === "buy" ? "B" : "S", p.x, p.y + 1);
  }
  // NOW: the step's top where there is one, else the last candle.
  const last = m.candles.length - 1;
  if (last >= 0) {
    const gr = m.graduation;
    const p = gr && gr.nowPrice
      ? { x: g.xOf(gr.index) + Math.max(g.slot * 0.9, 40), y: clamp(g.yOf(gr.nowPrice), g.top + 20, g.bot - 20) }
      : at(last, m.candles[last].c);
    ctx.fillStyle = VIO; ctx.shadowColor = VIO; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(p.x, p.y, L.tall ? 12 : 9, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    pillLabel(ctx, "NOW", clamp(p.x, 90, m.w - 90), clamp(p.y - (L.tall ? 50 : 40), g.top + 20, g.bot), VIO, L.tall ? 22 : 17);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- result --
function result(ctx, m, L, W, H, s, art, geo) {
  const T = TIMELINE;
  if (s < T.result[0]) return;
  const k = ease(span(s, T.result[0], T.result[0] + 0.5));
  ctx.save();
  // Dim the chart behind the numbers, not away: the trade stays readable.
  ctx.fillStyle = `rgba(6,7,10,${0.5 * k})`;
  ctx.fillRect(0, 0, W, H);
  pins(ctx, m, L, s, geo, k);

  const pnl = m.holding
    ? { eth: m.live.filter(Boolean).at(-1)?.eth ?? 0, usd: m.live.filter(Boolean).at(-1)?.usd ?? null }
    : m.realised;
  const pnlColor = signColor(pnl.usd, pnl.eth);
  const count = ease(span(s, T.result[0] + 0.1, T.result[1]));
  const v = verdictLine(m);
  const told = story(m);
  const cx = L.tall ? W / 2 : W * 0.3;
  const cy = L.tall ? 640 : 440;
  ctx.globalAlpha = k;
  const pct = m.realised.pct;
  const pctText = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)}%`;
  let stamp, lines;
  if (told) {
    // A paperhand leads with the story: how many times over, since when.
    glowText(ctx, times(1 + (told.multiple - 1) * count), cx, cy, L.big, AMB);
    glowText(ctx, told.since, cx, cy + L.big * 0.74, Math.round(L.big * 0.3), AMB);
    stamp = { text: "PAPERHANDED", color: AMB };
    lines = [`Sold for ${fmtMoney(m.exit.usd, m.exit.eth)} · ${fmtMoney(pnl.usd, pnl.eth, true)} (${pctText(pct)})`,
      `Worth ${told.now} now · est.`];
  } else {
    glowText(ctx, fmtMoney(pnl.usd != null ? pnl.usd * count : null, pnl.eth * count, true), cx, cy, L.big, pnlColor);
    glowText(ctx, pctText(pct * count), cx, cy + L.big * 0.78, Math.round(L.big * 0.46), pnlColor);
    stamp = v;
    lines = m.holding ? [`${fmtEth(pnl.eth, true)} · est.`]
      : [`${fmtEth(m.realised.eth, true)}${m.exit ? ` · sold for ${fmtMoney(m.exit.usd, m.exit.eth)}` : ""}`,
        ...(m.now ? [`Worth ${fmtMoney(m.now.usd, m.now.eth)} now · est.`] : [])];
  }
  // The verdict stamps in.
  const vs = span(s, T.result[0] + 0.5, T.result[0] + 0.8);
  if (vs > 0) {
    ctx.save();
    ctx.globalAlpha = ease(vs);
    ctx.translate(cx, cy + L.big * 1.45);
    const sc = 1 + 0.4 * (1 - ease(vs));
    ctx.scale(sc, sc);
    ctx.letterSpacing = "3px";
    glowText(ctx, stamp.text, 0, 0, L.tall ? 50 : 36, stamp.color);
    ctx.restore();
  }
  // Two lines a phone can read, not one grey one.
  ctx.fillStyle = TX2;
  ctx.font = `600 ${L.tall ? 36 : 26}px ${SANS}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((t, i) => ctx.fillText(t, cx, cy + L.big * 1.45 + (L.tall ? 78 : 56) + i * (L.tall ? 50 : 36)));

  // clankchan reacts: in 9:16 she fills the lower third, popping in.
  if (art && art.naturalWidth) {
    const a = ease(span(s, T.result[0] + 0.4, T.result[0] + 0.9));
    let dx = 0;
    const sh = span(s, T.result[0] + 0.8, T.result[0] + 1.1);
    if (sh > 0 && sh < 1) dx = Math.sin(sh * Math.PI * 7) * 14 * (1 - sh);
    const pop = 0.9 + 0.1 * a;
    const base = L.tall ? { w: 780, h: 640, cx: W / 2, top: 1130 } : { w: 400, h: 520, cx: W * 0.58 + 200, top: 250 };
    const bw = base.w * pop, bh = base.h * pop;
    const box = { x: base.cx - bw / 2 + dx, y: base.top + (base.h - bh) / 2 + (1 - a) * 60, w: bw, h: bh };
    const sw = art.naturalWidth, shh = art.naturalHeight;
    const aspect = box.w / box.h;
    const cw = Math.min(sw, shh * aspect), ch = cw / aspect;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 28); ctx.clip();
    ctx.drawImage(art, (sw - cw) / 2, 0, cw, ch, box.x, box.y, box.w, box.h);
    const gr = ctx.createLinearGradient(0, box.y + box.h * 0.6, 0, box.y + box.h);
    gr.addColorStop(0, "rgba(6,7,10,0)"); gr.addColorStop(1, "rgba(6,7,10,.9)");
    ctx.fillStyle = gr; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = v.color; ctx.lineWidth = 3; ctx.shadowColor = v.color; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 28); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- footer --
function footer(ctx, m, L, W, H, s) {
  ctx.save();
  ctx.globalAlpha = ease(span(s, 0.1, 0.6));
  const y = H - (L.tall ? 64 : 44);
  ctx.fillStyle = VIO;
  ctx.beginPath(); ctx.arc(L.pad + 16, y - 8, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = TX;
  ctx.font = `700 ${L.tall ? 30 : 24}px ${SANS}`;
  ctx.textBaseline = "middle";
  ctx.fillText(m.address, L.pad + 44, y - 6);
  ctx.textAlign = "right";
  ctx.fillText(m.venue, W - L.pad, y - 6);
  ctx.fillStyle = TX3;
  ctx.font = `400 ${L.tall ? 18 : 14}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.fillText(FOOTER, W / 2, y - (L.tall ? 60 : 44));
  ctx.restore();
}

/**
 * Seconds at which each candle starts to show, for the soundtrack. Found by
 * stepping the same reveal the drawing uses, so they cannot disagree.
 */
export function replayCandleTimes(m) {
  const out = new Array(m.candles.length).fill(null);
  let prev = revealAt(0, m);
  for (let i = 0; i < Math.ceil(prev); i++) out[i] = 0;
  for (let s = 0.01; s <= TIMELINE.end + 1e-9; s += 0.01) {
    const rv = revealAt(s, m);
    for (let i = Math.ceil(prev); i < Math.ceil(rv) && i < out.length; i++) if (out[i] === null) out[i] = s;
    prev = rv;
  }
  return out;
}

export const REPLAY_SECONDS = TIMELINE.total;
export const REPLAY_MOTION_SECONDS = TIMELINE.end;
