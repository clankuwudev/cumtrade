// cumAI's pure parts (L1 L4b): the model list the gateway gives, and the
// Models tab's view of it. No DOM here, so the tests import it as it is.
//
// GET /v1/models is a CORS simple request: no credentials and no header of
// ours, since the gateway answers no preflight there. Its CORS names
// https://clankuwu.com only.
import { GATEWAY, maker } from "../landing/live.js";

export { GATEWAY };

/**
 * cumAI's tabs, as the page's address names them after #/ (the first is the
 * default): the Build group of the demo's console (C-D8, C-D9), Status
 * included since C5b.
 */
export const TABS = ["playground", "models", "docs", "status"];

/** The tab an address names: one of TABS, and anything else the Playground. */
export const tabOf = (hash) => {
  const name = String(hash ?? "").replace(/^#\/?/, "").split(/[/?]/)[0];
  return TABS.includes(name) ? name : TABS[0];
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const price = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const size = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * The models from a /v1/models body, each `{ id, maker, in, out, ctx, max }`
 * with prices in dollars per million tokens, or null when the answer is not
 * the list. Only well-formed entries count; the ids come over the network and
 * are set as text wherever they are shown.
 */
export function parseModels(body) {
  const data = body && body.object === "list" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const rows = data.filter((m) => m && typeof m.id === "string" && ID.test(m.id)
    && price(m.pricing?.input_usd_per_million) && price(m.pricing?.output_usd_per_million))
    .map((m) => ({
      id: m.id, maker: maker(m.id),
      in: m.pricing.input_usd_per_million, out: m.pricing.output_usd_per_million,
      ctx: size(m.context_length), max: size(m.max_output_tokens),
    }));
  return rows.length ? rows : null;
}

/** The model list, or null on any failure, refusal or malformed answer. Never throws. */
export async function fetchModels(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${GATEWAY}/v1/models`, { credentials: "omit" });
    if (!res || res.status !== 200) return null;
    return parseModels(await res.json());
  } catch {
    return null;
  }
}

const TIER = /^[A-Za-z0-9]{1,16}$/;

/**
 * The picture models from a /v1/images/models body (X15a, X15c), each
 * `{ id, maker, tiers: [[tier, usd]] }` priced per picture ("default" for a
 * model with one size), or null when the answer is not the list. Only
 * well-formed entries and prices count.
 */
export function parsePictureModels(body) {
  const data = body && body.object === "list" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const rows = data.filter((m) => m && typeof m.id === "string" && ID.test(m.id) && m.pricing && typeof m.pricing === "object")
    .map((m) => ({
      id: m.id, maker: maker(m.id),
      tiers: /** @type {[string, number][]} */ (Object.entries(m.pricing).filter(([k, v]) => TIER.test(k) && price(v))),
    }))
    .filter((r) => r.tiers.length);
  return rows.length ? rows : null;
}

/** The picture models, or null on any failure: the list isn't served while pictures are off. Never throws. */
export async function fetchPictureModels(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${GATEWAY}/v1/images/models`, { credentials: "omit" });
    if (!res || res.status !== 200) return null;
    return parsePictureModels(await res.json());
  } catch {
    return null;
  }
}

/** The demo's quick filters. */
const POPULAR = ["claude-sonnet-5", "claude-opus-5", "gpt-5", "gpt-5-mini", "gemini-3-pro-preview", "gemini-3.7-flash",
  "deepseek-v4-pro", "grok-4.7", "qwen3.8-max", "kimi-k3", "glm-5.3"];
export const QUICK = {
  All: () => true,
  Popular: (r) => POPULAR.includes(r.id),
  Cheapest: (r) => r.in + r.out <= 1,
  "Long context": (r) => (r.ctx ?? 0) >= 900_000,
  Reasoning: (r) => /thinking|reasoning|^o\d|-r1|deep-research/.test(r.id),
  Code: (r) => /codex|code|build/.test(r.id),
};

/** The rows one view shows: a quick filter, a maker and a search, in a sort. Unpublished sizes sort last either way. */
export function modelView(rows, { quick = "All", fam = "All", q = "", sortKey = "id", sortDir = 1 } = {}) {
  const needle = q.trim().toLowerCase();
  const list = rows.filter((r) => (QUICK[quick] ?? QUICK.All)(r) && (fam === "All" || r.maker === fam)
    && (!needle || r.id.toLowerCase().includes(needle) || r.maker.toLowerCase().includes(needle)));
  return list.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
  });
}

/** Where `q` sits in `text`, ignoring case: `[start, end]`, or null. An empty query matches nothing. */
export function hitIn(text, q) {
  const needle = String(q ?? "").trim().toLowerCase();
  if (!needle) return null;
  const at = String(text).toLowerCase().indexOf(needle);
  return at < 0 ? null : [at, at + needle.length];
}

/** How the palette ranks a model's state: live first, down last (the Status tab's states). */
const STATE_RANK = { live: 0, degraded: 1, unknown: 2, down: 3 };

/**
 * The palette's models (C5 polish): those whose id or maker holds the query
 * (all of them with no query), live first and down last, then an id that
 * starts with the query, then by id. Each carries its state (unknown until
 * the status says) and where its id matched.
 * @param {{ id: string, maker: string }[]} rows
 * @param {(id: string) => (string | null)} stateOf
 */
export function paletteModels(rows, stateOf, q = "", limit = 12) {
  const needle = String(q).trim().toLowerCase();
  return rows
    .filter((r) => !needle || r.id.toLowerCase().includes(needle) || r.maker.toLowerCase().includes(needle))
    .map((r) => ({ row: r, state: stateOf(r.id) ?? "unknown", hit: hitIn(r.id, needle) }))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]
      || Number(b.hit?.[0] === 0) - Number(a.hit?.[0] === 0)
      || a.row.id.localeCompare(b.row.id))
    .slice(0, limit);
}

/** What 1,000 calls of 1,000 tokens in and 500 out would cost, in dollars. */
export const thousandCalls = (r) => (1000 * (1000 * r.in + 500 * r.out)) / 1e6;

/** A maker's mark in the table and the drawer. */
export const initial = (m) => ({ OpenAI: "O", Anthropic: "A", Google: "G", DeepSeek: "D", xAI: "x", Qwen: "Q", Moonshot: "K",
  Zhipu: "Z", MiniMax: "M", Xiaomi: "Mi", StepFun: "S" })[m] ?? "·";

/** Bar widths on a log scale across the whole list, so a filter doesn't rescale them. */
export function scale(rows) {
  const lo = Math.log10(Math.max(1e-6, Math.min(...rows.map((r) => r.in || 1e-6))));
  const hi = Math.log10(Math.max(...rows.map((r) => r.out || 1e-6)));
  const pct = (v) => `${Math.max(3, Math.round(((Math.log10(Math.max(v, 1e-6)) - lo) / ((hi - lo) || 1)) * 100))}%`;
  const maxCtx = Math.max(1, ...rows.map((r) => r.ctx ?? 0));
  return { pct, ctx: (v) => `${Math.max(3, Math.round((v / maxCtx) * 100))}%` };
}
