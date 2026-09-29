// The share videos' soundtrack (docs/specs/trade-replay.md, V4). Synthesised
// with Web Audio: no sound files, nothing to license, nothing the page's CSP
// has to allow. A score is a list of cues read off the same timeline the
// drawing uses; it is rendered once, offline, into a buffer, so the preview
// and the recording play exactly the same sound on exactly the same frames.

import { BEATS, MOTION_MS, cardCandleTimes } from "./draw.js";
import { replayCandleTimes } from "./replay.js";
import { TIMELINE } from "./replayModel.js";

export const SAMPLE_RATE = 48_000;

// ------------------------------------------------------------------ score --
/**
 * The replay's cues.
 *
 * @param {any} m from replayModel
 * @returns {{ seconds: number, cues: any[] }}
 */
export function replayScore(m) {
  const T = TIMELINE;
  const cues = [];
  cues.push({ t: 0.1, kind: "whoosh", dur: 0.7, up: true });
  for (const t of [0.95, 1.4, 1.85]) cues.push({ t, kind: "ping" });
  cues.push({ t: 2.15, kind: "press" });
  cues.push({ t: T.move[0], kind: "drone", dur: T.move[1] - T.move[0] });

  // A blip per candle, pitched by its price: up is higher.
  const times = replayCandleTimes(m);
  const pitch = pitcher(m.candles.map((c) => c.c));
  m.candles.forEach((c, i) => {
    const t = times[i];
    if (t === null || t < T.move[0] - 0.05 || c.seg === "before") return;
    cues.push({ t, kind: "blip", semi: pitch(c.c), up: c.c >= c.o, ghost: c.seg === "after" });
  });

  if (m.exit) cues.push({ t: T.exit[0] + 0.05, kind: "cash" });
  if (m.missed) cues.push({ t: T.missed[0] + 0.15, kind: "riser", dur: T.missed[1] - T.missed[0] - 0.3 });
  cues.push({ t: T.result[0] + 0.05, kind: "impact" });
  for (let t = T.result[0] + 0.12; t < T.result[1] - 0.05; t += 0.07) cues.push({ t, kind: "tick" });
  cues.push({ t: T.result[0] + 0.4, kind: "whoosh", dur: 0.45, up: true, soft: true });
  cues.push({ t: T.result[0] + 0.55, kind: "stinger", verdict: stingerFor(m.verdict, m.holding, m.realised.eth) });
  return { seconds: T.total, cues };
}

/**
 * The card's cues.
 *
 * @param {any} card from model.js
 * @param {number} durationMs
 */
export function cardScore(card, durationMs) {
  const at = (f) => (f * MOTION_MS) / 1000;
  /** @type {any[]} */
  const cues = [{ t: 0.05, kind: "whoosh", dur: 0.6, up: true }];
  const cs = card.chart.candles || [];
  const times = cardCandleTimes(cs.length);
  const pitch = pitcher(cs.map((c) => c.c));
  // A card has up to 48 candles; every one of them blipping is a buzz.
  const every = Math.max(1, Math.ceil(cs.length / 24));
  cs.forEach((c, i) => {
    if (i % every === 0) cues.push({ t: times[i], kind: "blip", semi: pitch(c.c), up: c.c >= c.o, ghost: true });
  });
  for (let t = at(BEATS.count[0]); t < at(BEATS.count[1]); t += 0.07) cues.push({ t, kind: "tick" });
  cues.push({ t: at(BEATS.art[0]), kind: "whoosh", dur: 0.45, up: true, soft: true });
  cues.push({ t: at(BEATS.verdict[0]), kind: "impact" });
  const label = card.verdict.label;
  const verdict = label === "PAPERHANDED" ? "paperhand" : label === "FUMBLED THE TOP" ? "fumble"
    : label === "GOOD SELL" ? "good" : label === "HOLDING" ? "holding"
    : (card.big.value ?? 0) >= 0 ? "good" : "paperhand";
  cues.push({ t: at(BEATS.verdict[0]) + 0.15, kind: "stinger", verdict });
  return { seconds: durationMs / 1000, cues };
}

/** Which stinger a result gets. */
export function stingerFor(verdict, holding, realisedEth) {
  if (holding) return "holding";
  if (verdict === "paperhand" || verdict === "fumble" || verdict === "good") return verdict;
  return realisedEth >= 0 ? "good" : "paperhand";
}

/** Map prices to semitones 0..19 on a log scale, so a doubling always sounds the same. */
function pitcher(prices) {
  const logs = prices.filter((p) => p > 0).map(Math.log);
  const lo = Math.min(...logs), hi = Math.max(...logs);
  return (p) => (p > 0 && hi > lo ? Math.round(((Math.log(p) - lo) / (hi - lo)) * 19) : 7);
}

// ----------------------------------------------------------------- render --
/**
 * Render a score to a stereo buffer.
 *
 * @param {{ seconds: number, cues: any[] }} score
 * @returns {Promise<AudioBuffer>}
 */
export async function renderScore(score) {
  const ctx = new OfflineAudioContext(2, Math.ceil(score.seconds * SAMPLE_RATE), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.85;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);
  // A little room, so the synths do not sound like they are in a box.
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 1.6);
  const send = ctx.createGain();
  send.gain.value = 0.22;
  send.connect(verb).connect(master);
  const rnd = mulberry32(0x5eed);
  const v = { ctx, out: master, send, rnd };
  for (const c of score.cues) VOICES[c.kind]?.(v, c);
  return ctx.startRendering();
}

/** Deterministic noise, so a render is the same every time. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function impulse(ctx, seconds) {
  const n = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const rnd = mulberry32(7);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / n, 3);
  }
  return buf;
}

function noiseBuffer(v, seconds) {
  const n = Math.max(1, Math.floor(seconds * v.ctx.sampleRate));
  const buf = v.ctx.createBuffer(1, n, v.ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = v.rnd() * 2 - 1;
  return buf;
}

/** A gain that rises over `a`, holds, and falls over `r`, peaking at `peak`. */
function envelope(v, t, dur, peak, a = 0.005, r = dur) {
  const g = v.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + Math.max(a, dur - r));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}

/** One oscillator note, optionally gliding, with vibrato, through a filter. */
function tone(v, t, dur, o) {
  const osc = v.ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide ?? dur));
  if (o.vibrato) {
    const lfo = v.ctx.createOscillator(), depth = v.ctx.createGain();
    lfo.frequency.value = o.vibrato; depth.gain.value = o.f0 * 0.012;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  const g = envelope(v, t, dur, o.gain ?? 0.2, o.attack ?? 0.005, o.release ?? dur);
  let node = osc.connect(g);
  if (o.lp) {
    const f = v.ctx.createBiquadFilter();
    f.type = "lowpass"; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.lp, t);
    if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t + dur);
    node = g.connect(f);
  }
  node.connect(v.out);
  if (o.wet) {
    const w = v.ctx.createGain(); w.gain.value = o.wet;
    node.connect(w).connect(v.send);
  }
  osc.start(t); osc.stop(t + dur + 0.05);
}

/** Filtered noise, its band sweeping from f0 to f1. */
function hiss(v, t, dur, o) {
  const src = v.ctx.createBufferSource();
  src.buffer = noiseBuffer(v, dur + 0.05);
  const f = v.ctx.createBiquadFilter();
  f.type = o.type ?? "bandpass"; f.Q.value = o.q ?? 1.2;
  f.frequency.setValueAtTime(o.f0, t);
  f.frequency.exponentialRampToValueAtTime(o.f1 ?? o.f0, t + dur);
  const g = envelope(v, t, dur, o.gain ?? 0.2, o.attack ?? dur * 0.5, o.release ?? dur * 0.5);
  src.connect(f).connect(g).connect(v.out);
  if (o.wet) { const w = v.ctx.createGain(); w.gain.value = o.wet; g.connect(w).connect(v.send); }
  src.start(t); src.stop(t + dur + 0.05);
}

const kick = (v, t, gain = 0.8, from = 140, to = 42, dur = 0.32) =>
  tone(v, t, dur, { type: "sine", f0: from, f1: to, glide: dur * 0.6, gain, attack: 0.002, release: dur * 0.9 });

const note = (semi, base = 220) => base * Math.pow(2, semi / 12);

// ----------------------------------------------------------------- voices --
const VOICES = {
  whoosh(v, c) {
    hiss(v, c.t, c.dur, { f0: c.up ? 350 : 3500, f1: c.up ? 3800 : 300, gain: c.soft ? 0.12 : 0.22, q: 1.4, wet: 0.5 });
  },
  ping(v, c) {
    tone(v, c.t, 0.45, { f0: 1318.5, gain: 0.06, release: 0.44, wet: 0.9 });
  },
  press(v, c) {
    kick(v, c.t, 0.9);
    tone(v, c.t, 0.35, { type: "triangle", f0: note(3, 440), gain: 0.2, release: 0.34, wet: 0.5 });
    tone(v, c.t + 0.09, 0.5, { type: "triangle", f0: note(10, 440), gain: 0.2, release: 0.48, wet: 0.6 });
  },
  drone(v, c) {
    for (const [f, g] of [[55, 0.07], [55.4, 0.05], [110, 0.025]]) {
      tone(v, c.t, c.dur, { f0: f, f1: f * 1.12, glide: c.dur, gain: g, attack: 0.6, release: 0.8 });
    }
  },
  blip(v, c) {
    const f = note(c.semi);
    if (c.up) {
      tone(v, c.t, 0.14, { type: "triangle", f0: f * 2, gain: c.ghost ? 0.07 : 0.13, release: 0.13, wet: c.ghost ? 0.8 : 0.3 });
      tone(v, c.t, 0.1, { f0: f * 4, gain: c.ghost ? 0.02 : 0.04, release: 0.09 });
    } else {
      tone(v, c.t, 0.16, { type: "square", f0: f, gain: c.ghost ? 0.035 : 0.06, lp: 900, lp1: 300, release: 0.15, wet: c.ghost ? 0.8 : 0.3 });
    }
  },
  cash(v, c) {
    kick(v, c.t, 0.5, 180, 60, 0.18);
    hiss(v, c.t, 0.09, { type: "highpass", f0: 4200, gain: 0.3, attack: 0.002, release: 0.08 });
    tone(v, c.t + 0.03, 0.9, { f0: 2093, gain: 0.1, release: 0.88, wet: 0.7 });
    tone(v, c.t + 0.03, 0.9, { f0: 2637, gain: 0.08, release: 0.88, wet: 0.7 });
    tone(v, c.t + 0.12, 0.7, { f0: 3136, gain: 0.05, release: 0.68, wet: 0.7 });
  },
  riser(v, c) {
    tone(v, c.t, c.dur, { type: "sawtooth", f0: 140, f1: 880, glide: c.dur, gain: 0.05, lp: 400, lp1: 3200, attack: c.dur * 0.7, release: c.dur * 0.3, wet: 0.4 });
    hiss(v, c.t, c.dur, { f0: 500, f1: 6000, gain: 0.08, attack: c.dur * 0.8, release: c.dur * 0.2 });
  },
  impact(v, c) {
    kick(v, c.t, 1, 120, 34, 0.55);
    tone(v, c.t, 0.7, { f0: 46, gain: 0.35, attack: 0.01, release: 0.65 });
    hiss(v, c.t, 0.35, { type: "lowpass", f0: 2400, f1: 200, gain: 0.35, attack: 0.002, release: 0.33, wet: 0.6 });
  },
  tick(v, c) {
    tone(v, c.t, 0.025, { type: "square", f0: 1760, gain: 0.025, lp: 4000, release: 0.024 });
  },
  stinger(v, c) {
    const t = c.t;
    if (c.verdict === "paperhand") {
      // Wah, wah, wah, waaah.
      const notes = [233.08, 220, 207.65, 196];
      notes.forEach((f, i) => {
        const long = i === notes.length - 1;
        const d = long ? 1.2 : 0.3;
        const at = t + i * 0.34;
        tone(v, at, d, { type: "sawtooth", f0: f, gain: 0.16, lp: 500, lp1: long ? 380 : 1600, q: 4, attack: 0.03,
          release: long ? 0.6 : 0.12, vibrato: long ? 5.5 : 0, wet: 0.35 });
      });
    } else if (c.verdict === "fumble") {
      // A slide whistle, all the way down, and a thud.
      tone(v, t, 1.0, { f0: 1500, f1: 260, glide: 0.95, gain: 0.14, vibrato: 7, release: 0.2, wet: 0.5 });
      kick(v, t + 1.0, 0.6, 90, 40, 0.3);
    } else if (c.verdict === "good") {
      [0, 4, 7, 12].forEach((s, i) => tone(v, t + i * 0.08, 0.6, { type: "triangle", f0: note(s, 523.25), gain: 0.13, release: 0.55, wet: 0.6 }));
      [0, 4, 7].forEach((s) => tone(v, t + 0.34, 0.9, { type: "triangle", f0: note(s, 523.25), gain: 0.08, attack: 0.02, release: 0.85, wet: 0.7 }));
      for (let i = 0; i < 5; i++) tone(v, t + 0.4 + i * 0.07, 0.3, { f0: note(24 + (i % 3) * 5, 523.25), gain: 0.03, release: 0.28, wet: 0.9 });
    } else {
      tone(v, t, 0.5, { type: "triangle", f0: 659.25, gain: 0.12, release: 0.48, wet: 0.6 });
      tone(v, t + 0.12, 0.7, { type: "triangle", f0: 987.77, gain: 0.12, release: 0.68, wet: 0.6 });
    }
  },
};
