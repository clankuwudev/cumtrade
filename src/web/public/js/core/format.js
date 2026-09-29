import { S } from "./store.js";

export const XI = "Ξ";

// ------------------------------------------------------------ formatting --
export const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const eth = (v, dp = 4) => n(v).toFixed(dp);

export const pc = (v, dp = 1) => n(v).toFixed(dp) + "%";

export const int = (v) => Math.round(n(v)).toLocaleString("en-US");

export const sign = (v, dp = 1) => (n(v) >= 0 ? "+" : "−") + Math.abs(n(v)).toFixed(dp);

/**
 * A round trip pays the fee twice: f on the way in, then f on the (1-f) that
 * survived. So a 1% curve costs 1.99%, not 2%, and breakeven is a +2.03%
 * move rather than +2%. Both mirror `roundTripDragPct` / `breakevenMovePct`
 * in src/core/positions/valuation.ts — the server is the authority, these are for
 * the panels that quote a fee before any position exists to ask the server
 * about.
 */
export const roundTripPct = (feeBps) => { const f = n(feeBps) / 10000; return (2 * f - f * f) * 100; };

export const breakevenPct = (feeBps) => {
  const f = n(feeBps) / 10000;
  return f >= 1 ? 0 : (1 / ((1 - f) * (1 - f)) - 1) * 100;
};

export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

export const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

export const cap1 = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + " second" + (s === 1 ? "" : "s") + " ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}

/** Compact duration for a card footer: 47s, 14m, 2h 41m. */
export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/** Precise duration for the closed table, where the seconds are the point. */
export function durExact(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

/**
 * ETH shown as dollars.
 *
 * Only valuations go through this — market cap and what a curve has raised.
 * Trade size, balance and the caps stay in ETH, because those are the units
 * the contracts and the server-side limits are actually denominated in, and
 * quoting a limit in a currency it is not enforced in is how you talk
 * yourself past it.
 *
 * Falls back to the ETH figure when no price is available, rather than
 * printing a dollar sign in front of a number that is not dollars.
 */
export function usd(ethAmount, dp) {
  const rate = S.stats && S.stats.price ? S.stats.price.ethUsd : null;
  if (!rate) return eth(ethAmount, dp ?? 4) + " " + XI;
  const v = n(ethAmount) * rate;
  const sig = Math.abs(v);
  // Curves report a raise of one wei before anyone has bought, which is dust,
  // not a value. Anything that would render as all zeros reads as "$0".
  if (sig < 0.00005) return "$0";
  if (sig >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (sig >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (sig >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  // Cents stop being information well before this, and the extra characters
  // were overflowing the four-up grid cells on a card.
  if (sig >= 100) return "$" + v.toFixed(0);
  if (sig >= 0.01) return "$" + v.toFixed(2);
  return "$" + v.toFixed(4);
}

export function millions(v) {
  const x = n(v);
  if (!x) return "—";
  if (x >= 1e9) return (x / 1e9).toFixed(2) + "B";
  if (x >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return x.toFixed(0);
}
