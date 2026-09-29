// cumAI's live model status (stage C, C5b; C-D10): what `GET /v1/status`
// says, and nothing else. Nothing is made up: a model with nothing measured
// is "unknown", and the page says so. No DOM here, so the tests import it as it
// is.
//
// Like /v1/models, it is a CORS simple request: no credentials and no header
// of ours. Its CORS names https://clankuwu.com only.
import { GATEWAY } from "./models.js";

export const MODEL_STATES = Object.freeze(["live", "degraded", "down", "unknown"]);
export const SERVICE_STATES = Object.freeze(["operational", "degraded", "down"]);
export const SERVICES = Object.freeze(["gateway", "moderation", "supplier"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const iso = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A /v1/status body, checked field by field, or null when it isn't one.
 * Anything malformed is left out, never guessed; ids are set as text
 * wherever they are shown.
 */
export function parseStatus(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.models) || !Array.isArray(body.services)) return null;
  const services = body.services
    .filter((s) => SERVICES.includes(s?.id) && SERVICE_STATES.includes(s?.state))
    .map((s) => ({ id: s.id, state: s.state }));
  const models = body.models
    .filter((m) => typeof m?.id === "string" && ID.test(m.id) && MODEL_STATES.includes(m.state))
    .map((m) => ({
      id: m.id, state: m.state,
      firstTokenMs: num(m.first_token_ms), tokensPerS: num(m.tokens_per_s),
      checkedAt: iso(m.checked_at), source: m.source === "call" || m.source === "probe" ? m.source : null,
    }));
  const incidents = (Array.isArray(body.incidents) ? body.incidents : [])
    .filter((i) => typeof i?.subject === "string" && ID.test(i.subject) && ["degraded", "down"].includes(i.state) && iso(i.from))
    .map((i) => ({ subject: i.subject, state: i.state, from: i.from, to: iso(i.to) }));
  const p = body.probe && typeof body.probe === "object" ? body.probe : {};
  const probe = {
    on: p.on === true, everyMinutes: num(p.every_minutes), budgetUsdDay: num(p.budget_usd_day), spentUsdToday: num(p.spent_usd_today),
  };
  return { generatedAt: iso(body.generated_at), services, models, incidents, probe };
}

/** The status, or null on any failure, refusal or malformed answer. Never throws. */
export async function fetchStatus(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${GATEWAY}/v1/status`, { credentials: "omit" });
    if (!res || res.status !== 200) return null;
    return parseStatus(await res.json());
  } catch {
    return null;
  }
}

/** How many models are in each state. */
export function counts(models) {
  const c = { live: 0, degraded: 0, down: 0, unknown: 0 };
  for (const m of models) c[m.state]++;
  return c;
}

/** The worst of some states, for the sidebar's dot: down, then degraded, then live; unknown only when nothing else is known. */
export function worst(models) {
  const c = counts(models);
  return c.down ? "down" : c.degraded ? "degraded" : c.live ? "live" : "unknown";
}

/** A model's rows in the order the page lists them: the worst first, then by id. */
export function statusView(models, filter = "all") {
  const rank = { down: 0, degraded: 1, live: 2, unknown: 3 };
  return models.filter((m) => filter === "all" || m.state === filter)
    .sort((a, b) => rank[a.state] - rank[b.state] || a.id.localeCompare(b.id));
}

/** Time to the first token: "0.42 s", or "—". */
export const firstToken = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)} s`);
/** Speed: "88 tok/s", or "—". */
export const speed = (tps) => (tps == null ? "—" : `${Math.round(tps)} tok/s`);

/** How long ago, from the gateway's own clock: "just now", "4 min ago", "2 h ago", or "—". */
export function ago(at, now) {
  const t = at ? Date.parse(at) : NaN;
  const n = now ? Date.parse(now) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(n)) return "—";
  const min = Math.max(0, Math.round((n - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

/** How long an incident has lasted, or did: "for 12 min", "for 2 h". */
export function lasted(from, to, now) {
  const a = Date.parse(from);
  const b = Date.parse(to ?? now ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  const min = Math.max(1, Math.round((b - a) / 60_000));
  return min < 60 ? `for ${min} min` : `for ${Math.round(min / 60)} h`;
}
