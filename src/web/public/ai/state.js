// The playground's pure parts (stage C, C5): which state it is in, the
// checks made before a message leaves, and how figures and replies are
// written. No DOM and no network, so the tests import it as it is.

/**
 * The playground's state, from `GET /v1/free` (`free`) and `GET /v1/account`
 * (`account`, or null when signed out). `free` is undefined while loading,
 * and null when the gateway didn't answer.
 * - "in": open to this visitor, and signed in under the current terms (the
 *   gateway only says what is left today to such a session);
 * - "out": open, but not signed in, or signed in under older terms;
 * - "preview": a private preview (C-D7), and no one is signed in;
 * - "preview-denied": a private preview, and this wallet isn't on its list;
 * - "off": not open yet;
 * - "loading", "down".
 */
export function playState(free, account) {
  if (free === undefined) return "loading";
  if (!free || typeof free !== "object") return "down";
  if (free.on === true) return typeof free.left_usd === "number" ? "in" : "out";
  if (free.preview === true) return account ? "preview-denied" : "preview";
  return "off";
}

/** The words of a recovery phrase: 12 to 24 of them, each 3 to 8 lower-case letters (BIP-39's). */
const PHRASE_LENGTHS = new Set([12, 15, 18, 21, 24]);

/**
 * Whether a message looks like a wallet's recovery phrase, so it never
 * leaves the browser (F12, before the gateway's own check). Only the
 * phrase's shape counts: a sentence of plain words passes.
 */
export function looksLikePhrase(text) {
  const words = String(text ?? "").trim().split(/\s+/);
  return PHRASE_LENGTHS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

/** An address as the page shows it: 0x12ab…34cd. */
export const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));

/** Dollars at the size a free call costs, to 2 significant figures: "$0.000054", "$0.0087", "$0.01", "<$0.00001". */
export function dollars(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "—";
  if (v === 0) return "$0";
  if (v < 0.00001) return "<$0.00001";
  return `$${v.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 8 })}`;
}

/** A size in bytes as the box counts it: "812 B", "6.4 KB". */
export const kb = (n) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`);

/**
 * A reply cut into prose and code (A8): text between ``` fences is code, set
 * in a monospace block. The first line after a fence names a language when
 * it is one word, and is dropped. Everything stays text: the page sets each
 * part with textContent.
 * @returns {{ code: boolean, text: string }[]}
 */
export function replyParts(text) {
  const bits = String(text ?? "").split("```");
  const parts = [];
  bits.forEach((bit, i) => {
    if (i % 2 === 0) {
      if (bit) parts.push({ code: false, text: bit });
      return;
    }
    const lang = bit.match(/^[A-Za-z0-9+#.-]{1,20}\n/);
    const body = (lang ? bit.slice(lang[0].length) : bit.replace(/^\n/, "")).replace(/\n$/, "");
    parts.push({ code: true, text: body });
  });
  return parts;
}

/** A session's running totals: this tab only, never saved. */
export const emptySession = () => ({ calls: 0, tokens: 0, cost: 0 });

/** The totals after one reply. */
export function addCall(session, { tokens = 0, cost = 0 } = {}) {
  return {
    calls: session.calls + 1,
    tokens: session.tokens + (Number.isFinite(tokens) ? tokens : 0),
    cost: session.cost + (Number.isFinite(cost) ? cost : 0),
  };
}

/**
 * The free pictures `/v1/free` offers this visitor, or null: shown only when
 * the gateway names them, on, with a model (X15c).
 * @param {any} free
 */
export function picturesOffered(free) {
  const p = free?.pictures;
  return p && typeof p === "object" && p.on === true && typeof p.model === "string" && p.model ? p : null;
}

/** Free pictures a day, as offered: a whole number from 1 to 100, else the spec's 2. */
export const picturesPerDay = (p) => (Number.isSafeInteger(p?.per_day) && p.per_day >= 1 && p.per_day <= 100 ? p.per_day : 2);

/** Free pictures left today: a whole number from 0 to the day's allowance, or null when unknown or impossible. */
export const picturesLeft = (p) =>
  (Number.isSafeInteger(p?.left_today) && p.left_today >= 0 && p.left_today <= picturesPerDay(p) ? p.left_today : null);
