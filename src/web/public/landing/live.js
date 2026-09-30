// The landing's pure parts (L1 L2): where an old link goes, and what the
// gateway's model list says. No DOM here, so the tests import it as it is.

/** The gateway, the landing's one connection (LANDING_PAGE_POLICY in src/server/http.ts). */
export const GATEWAY = "https://api.clankuwu.com";

/**
 * Where an old link lands (N-D7). The app lived at / with its routes in the
 * hash, so `/#/token/0x…` means `/trade#/token/0x…`, and `/#/ai` (X20's route)
 * means `/ai`. Anything else, a section id such as `#roadmap` included, stays
 * on the landing: null.
 */
export function forwardTarget(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#/")) return null;
  if (hash === "#/ai" || hash.startsWith("#/ai/") || hash.startsWith("#/ai?")) return "/ai";
  return `/trade${hash}`;
}

/**
 * GET /v1/models, as a CORS simple request: no credentials and no header of
 * our own, since the gateway answers no preflight there. Resolves to the
 * parsed body, or null on any failure, refusal or non-JSON answer. Never
 * throws: a page with no count is a page, and a broken one is not.
 */
export async function fetchModels(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${GATEWAY}/v1/models`, { credentials: "omit" });
    if (!res || res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Which lab made a model, by its id's prefix. The demo's table. */
const MAKERS = [["chatgpt", "OpenAI"], ["gpt", "OpenAI"], ["o1", "OpenAI"], ["o3", "OpenAI"], ["o4", "OpenAI"],
  ["claude", "Anthropic"], ["gemini", "Google"], ["deepseek", "DeepSeek"], ["grok", "xAI"], ["qwen", "Qwen"],
  ["kimi", "Moonshot"], ["glm", "Zhipu"], ["minimax", "MiniMax"], ["mimo", "Xiaomi"], ["step", "StepFun"]];
export const maker = (id) => (MAKERS.find(([p]) => id === p || id.startsWith(`${p}-`)
  || (id.startsWith(p) && /[\d.]/.test(id[p.length] ?? ""))) ?? [0, "Other"])[1];

/** The models the landing shows prices for, in this order, when the gateway has them. */
export const FEATURED = ["claude-sonnet-5", "gpt-5", "gemini-3-pro-preview", "deepseek-v4-pro", "grok-4.7", "qwen3.8-max", "gpt-4.1-nano"];

const price = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * What the landing shows from a /v1/models body: how many models, and the
 * featured rows. Only well-formed entries count, and an answer that is not
 * the list gives null, so the page keeps its words without a number.
 */
export function summarize(body) {
  const data = body && body.object === "list" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const models = data.filter((m) => m && typeof m.id === "string" && ID.test(m.id)
    && price(m.pricing?.input_usd_per_million) && price(m.pricing?.output_usd_per_million));
  if (models.length === 0) return null;
  const byId = new Map(models.map((m) => [m.id, m]));
  const featured = FEATURED.filter((id) => byId.has(id)).map((id) => {
    const m = byId.get(id);
    return {
      id, maker: maker(id),
      input: m.pricing.input_usd_per_million, output: m.pricing.output_usd_per_million,
      context: Number.isSafeInteger(m.context_length) && m.context_length > 0 ? m.context_length : null,
    };
  });
  return { count: models.length, featured };
}

/** $/M, as the demo wrote it. */
export const usd = (v) => `$${v >= 1 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(3) : v.toFixed(4)}`;
/** A context length: 1M, 200K, or a dash when the gateway does not say. */
export const tokens = (v) => (v == null ? "—" : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1000)}K`);

/** A count template's words: `{n}` is the count, `{m}` the count less one. */
export const fillCount = (tpl, n) => tpl.replaceAll("{n}", String(n)).replaceAll("{m}", String(n - 1));

// ------------------------------------------------------ the live board --
// The site's own board (L2b change 3): /api/launches, the rows cumOS shows,
// and /api/stats for the ETH price the market caps are in. Same origin, so
// the landing's policy allows 'self' beside the gateway.

/** How many rows the landing shows. */
export const BOARD_ROWS = 5;
/** The board's three views, as the tabs name them. */
export const VIEWS = ["new", "bonding", "grad"];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const num = (v) => typeof v === "number" && Number.isFinite(v);
/** A creator's text, trimmed to what a row can hold. Set as text, never as markup. */
const words = (s, max) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The board's rows and the ETH price, or null when either answer is not
 * what the site sends. Never throws.
 */
export async function fetchBoard(fetchImpl = globalThis.fetch) {
  try {
    const [l, s] = await Promise.all([fetchImpl("/api/launches"), fetchImpl("/api/stats")]);
    if (!l || l.status !== 200) return null;
    const launches = await l.json();
    if (!Array.isArray(launches)) return null;
    let ethUsd = null;
    if (s && s.status === 200) {
      const stats = await s.json().catch(() => null);
      if (num(stats?.price?.ethUsd) && stats.price.ethUsd > 0 && stats.price.stale !== true) ethUsd = stats.price.ethUsd;
    }
    return { launches, ethUsd };
  } catch {
    return null;
  }
}

/**
 * The rows one view shows, at most BOARD_ROWS: New, newest first; Bonding,
 * not graduated, furthest along first; Graduated, largest first. Only
 * well-formed rows count. `now` is in seconds.
 */
export function boardRows(launches, ethUsd, view, now) {
  if (!Array.isArray(launches)) return [];
  // Only rows the board has finished reading: one still being checked, or one
  // that failed, has no name or launch time yet (current-issues.md #6).
  const rows = launches.filter((r) => r && r.status === "ready" && typeof r.token === "string" && ADDRESS.test(r.token)
    && num(r.launchedAt) && r.launchedAt > 0 && num(r.fdvEth) && num(r.progress) && num(r.holders) && typeof r.graduated === "boolean")
    .map((r) => ({
      token: r.token,
      symbol: words(r.symbol, 14) || "?",
      name: words(r.name, 32),
      age: Math.max(0, now - r.launchedAt),
      launchedAt: r.launchedAt,
      mcapUsd: ethUsd ? r.fdvEth * ethUsd : null,
      fdvEth: r.fdvEth,
      holders: Math.max(0, Math.round(r.holders)),
      progress: Math.min(1, Math.max(0, r.progress)),
      graduated: r.graduated,
    }));
  const pick = view === "bonding" ? rows.filter((r) => !r.graduated).sort((a, b) => b.progress - a.progress || b.launchedAt - a.launchedAt)
    : view === "grad" ? rows.filter((r) => r.graduated).sort((a, b) => b.fdvEth - a.fdvEth)
      : rows.sort((a, b) => b.launchedAt - a.launchedAt);
  return pick.slice(0, BOARD_ROWS);
}

/** An age as the board writes it: 45s, 7m, 3h, 2d. */
export function ago(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** A market cap: $950, $42.0K, $1.25M, or a dash without a price. */
export function cap(usd) {
  if (!num(usd)) return "—";
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${Math.round(usd)}`;
}

/** Bonding progress as a percent, or "Graduated". */
export const bonding = (r) => (r.graduated ? "Graduated" : `${Math.floor(r.progress * 100)}%`);

/**
 * A token's dot: two colours from its address, the same every time. Not its
 * logo, which is whatever its creator uploaded.
 */
export function dotColors(address) {
  const h = parseInt(address.slice(2, 8), 16) % 360;
  const h2 = (h + 40 + (parseInt(address.slice(8, 10), 16) % 80)) % 360;
  return [`hsl(${h} 70% 55%)`, `hsl(${h2} 80% 80%)`];
}

/** The app's page for a token (N-D7's route, at /os). */
export const tokenHref = (address) => `/trade#/token/${address}`;

// ---------------------------------------------------- the calculator (CP3) --

/**
 * cumAI's own per-million prices from a /v1/models body: id → [input, output],
 * well-formed entries only, or null when the answer is not the list. The
 * calculator prefers these to the price book's recorded ones, so a price the
 * gateway changes shows on the page without a site release.
 */
export function livePrices(body) {
  const data = body && body.object === "list" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const out = new Map();
  for (const m of data) {
    if (m && typeof m.id === "string" && ID.test(m.id)
      && price(m.pricing?.input_usd_per_million) && price(m.pricing?.output_usd_per_million)) {
      out.set(m.id, [m.pricing.input_usd_per_million, m.pricing.output_usd_per_million]);
    }
  }
  return out.size ? out : null;
}

/**
 * The calculator's rows: [id, maker, [official in, out], [cumAI in, out]] for
 * each model in the price book, with cumAI's live price when the gateway lists
 * the model and the recorded one when there is no answer. A model the gateway
 * no longer lists is dropped: nobody could use it.
 */
export function calculatorRows(book, live) {
  const rows = [];
  for (const [id, mk, oi, oo, ri, ro] of book) {
    if (live && !live.has(id)) continue;
    rows.push([id, mk, [oi, oo], live ? live.get(id) : [ri, ro]]);
  }
  return rows;
}

/** A month at official prices and on cumAI, in dollars, for millions of tokens in and out. */
export function monthCost([offIn, offOut], [ourIn, ourOut], inM, outM) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const official = n(inM) * offIn + n(outM) * offOut;
  const ours = n(inM) * ourIn + n(outM) * ourOut;
  return { official, ours, save: official - ours, pct: official > 0 ? Math.round((1 - ours / official) * 100) : 0 };
}

/** Dollars for the calculator: two decimals and thousands separators. */
export const dollars = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
