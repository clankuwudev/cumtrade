import { S } from "./store.js";
import { AMB, GREY, GRN, RED, VIO } from "./constants.js";
import { html } from "./dom.js";
import { n } from "./format.js";
import { rows } from "./store.js";

// ------------------------------------------------------------- semantics --
// Colour is rationed, per the canvas annotation: green means a gate passed or
// a position is up, amber means approaching a limit, red means over one or
// down, blue means interactive. A value inside its limits stays plain white.
// Every branch below exists to keep that true.

export const valueOf = (list, key) => {
  const r = list && list.find((x) => x.key === key);
  return r ? n(r.value) : null;
};

export const guardPct = () => (S.cfg ? valueOf(S.cfg.exits, "EXIT_BEFORE_GRADUATION_PCT") ?? 95 : 95);

/** The words before the progress bar's marker: the console's exit guard, or, on a hosted page with no exit manager, where graduation is close. */
export const guardLabel = () => (S.mode === "hosted" ? "Close to graduation at" : "Guard at");

export const limitOf = (key, fallback) =>
  S.cfg ? (valueOf(S.cfg.filters, key) ?? fallback) : fallback;

/**
 * Each band's CSS class and the words shown for it.
 *
 * The key stays `CLEAN` (the rules, filters and stylesheet key on it), but it
 * is never shown. It reads "No issues found": the checks found nothing, which
 * is not the same as a token being safe (public-release F5.1).
 */
export const BANDS = {
  "CLEAN": ["CLEAN", "No issues found"],
  "CAUTION": ["CAUTION", "Caution"],
  "HIGH RISK": ["HIGH", "High risk"],
  "AVOID": ["AVOID", "Avoid"],
};

/** A band's words, for the places that print a verdict as text. */
export const bandLabel = (band) => (BANDS[band] ? BANDS[band][1] : String(band ?? ""));

/** What a verdict is, said next to it on a public page (public-release F5.1). */
export const VERDICT_NOTE = "Automated checks, not advice";

/** Where that note leads: About's Verdicts section says what a verdict does not mean (F5.3), under Learn since U6. */
export const ABOUT_HREF = "#/learn/verdicts";

/**
 * The note under a verdict band. Hosted only: a self page gains nothing, so
 * its DOM does not change.
 */
export const verdictNote = () => S.mode === "hosted"
  ? html`<a class="vnote" href="${ABOUT_HREF}">${VERDICT_NOTE}</a>`
  : "";

/**
 * A graduated token gets its own badge rather than a risk band.
 *
 * The band answers "is this dangerous"; graduation answers "can I trade it
 * here". Collapsing the second into the first is what made a completed
 * graduation render as AVOID — the worst verdict, on the outcome the
 * launchpad exists to reach.
 */
export const bandOf = (r) =>
  r.status !== "ready" ? ["SCAN", "Checking"]
  : r.graduated ? ["GRAD", "Graduated"]
  : (BANDS[r.band] || ["SCAN", "Unknown"]);

/**
 * The fee a trade of `r` pays where it trades now, in bps.
 *
 * `r.feeBps` is the curve's fee, and a bonded token no longer trades on its
 * curve: it trades in its V4 pool, whose LP fee is in pips (1e-6), so 3000 is
 * 30 bps. Quoting the curve's 1% there overstated a bonded round trip about
 * threefold. Null for a bonded token with no pool found, because there is no
 * venue and so no fee to quote.
 */
export const venueFeeBps = (r) =>
  r.graduated ? (r.v4 ? r.v4.lpFee / 100 : null) : r.feeBps;

export function ringColor(r) {
  if (r.status !== "ready") return GREY;
  if (r.graduated) return VIO;
  if (r.sellable === false) return RED;
  if (n(r.progress) * 100 >= guardPct()) return AMB;
  if (r.band === "CLEAN" || r.band === "CAUTION") return GRN;
  if (r.band === "AVOID") return RED;
  return GREY;
}

export const initials = (s) =>
  String(s || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "??";

export const sevClass = { critical: "c", high: "h", medium: "m", low: "l", info: "i" };

export const sorted = () => [...rows.values()].sort((a, b) => b.block - a.block || b.launchedAt - a.launchedAt);

// ------------------------------------------------------------ the switch --
/**
 * What the system switch and its banner say, from the server's `system`
 * (docs/specs/system-switch.md). A pure function so the words are tested
 * without a page.
 *
 * @param {{ on: boolean, reason: string | null, managing: number }} sys
 */
export function systemCopy(sys) {
  const n = sys.managing;
  return {
    label: sys.on ? "System on" : "System off",
    note: sys.on ? "Watching launches" : "Standby",
    banner: sys.on ? null :
      (sys.reason ? `It came up off because ${sys.reason}. ` : "") +
      "Not watching launches, not buying." +
      (n ? ` Exits still run for ${n} sniper position${n === 1 ? "" : "s"}.` : ""),
  };
}

// ---------------------------------------------------------- track record --
/**
 * The verdict pill for a track-record row (docs/specs/track-record.md): its
 * label, its colour class and what it means, for the tooltip.
 *
 * @param {string} v
 */
export function verdictPill(v) {
  switch (v) {
    case "paperhand": return { label: "Paperhand", cls: "a", tip: "What you sold would fetch more today than you got for it." };
    case "fumble": return { label: "Fumbled the top", cls: "r", tip: "It is not worth more now, but the market offered more after you sold." };
    case "good": return { label: "Good sell", cls: "g", tip: "Nothing after your sell beat what you got." };
    case "holding": return { label: "Holding", cls: "b", tip: "Nothing sold yet." };
    default: return { label: "No price", cls: "n", tip: "No curve or pool to price it from." };
  }
}

/**
 * The track record's status line: what a refresh is doing, or how old the
 * record is.
 *
 * @param {{ running: boolean, phase: string | null, detail: string | null, done: number, total: number, error: string | null }} progress
 * @param {number | null} builtAt
 * @param {number} [now]
 */
export function recordStatus(progress, builtAt, now = Date.now()) {
  if (progress.running) {
    if (progress.phase === "transactions") return `Reading ${progress.done} of ${progress.total} transactions…`;
    if (progress.phase === "prices") {
      return `Pricing${progress.detail ? " " + progress.detail : ""} (${progress.done} of ${progress.total})…`;
    }
    return "Reading transfers…";
  }
  if (progress.error) return `Refresh failed: ${progress.error}`;
  if (!builtAt) return "Not read yet";
  const min = Math.round((now - builtAt) / 60_000);
  return min < 1 ? "Updated just now" : min < 60 ? `Updated ${min} min ago` : `Updated ${Math.round(min / 60)} h ago`;
}
