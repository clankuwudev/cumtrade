/**
 * Counts of Content Security Policy reports (public-release B5.4).
 *
 * The page's policy is report-only until F5.2, and these counts say whether
 * it can be enforced. Each report is kept as `"<directive> <source>"`. The
 * source is a CSP keyword, `data` or `blob`, an origin with no path or query,
 * `extension` for anything a browser extension injected, or `other`. No URL,
 * sample or line number is kept, and the keys stop at 100.
 */

const MAX_KEYS = 100;
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "self", "trusted-types-policy", "trusted-types-sink"]);

let counts = new Map<string, number>();

const scheme = (uri: string) => uri.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? null;

/** What a report's blocked URI and source file reduce to. */
export function reportSource(blockedUri: unknown, sourceFile?: unknown): string {
  // Wallets and other extensions inject scripts into the page. The page cannot
  // stop that, and F5.2 must not wait on it, so it is named apart.
  for (const u of [blockedUri, sourceFile]) {
    if (typeof u === "string" && scheme(u)?.endsWith("-extension")) return "extension";
  }
  if (typeof blockedUri !== "string" || blockedUri === "") return "other";
  if (KEYWORDS.has(blockedUri)) return blockedUri;
  const s = scheme(blockedUri);
  if (s === "data" || s === "blob") return s;
  if (s === "http" || s === "https" || s === "ws" || s === "wss") {
    try { return new URL(blockedUri).origin; } catch { return "other"; }
  }
  return "other";
}

/**
 * Count one `application/csp-report` body. False when it is not a report, so
 * the route can say so.
 */
export function recordReport(body: Record<string, unknown>): boolean {
  const r = body["csp-report"];
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const report = r as Record<string, unknown>;
  const raw = report["effective-directive"] ?? String(report["violated-directive"] ?? "").split(" ")[0];
  const directive = typeof raw === "string" && /^[a-z-]{1,40}$/.test(raw) ? raw : "unknown";
  let key = `${directive} ${reportSource(report["blocked-uri"], report["source-file"])}`;
  if (!counts.has(key) && counts.size >= MAX_KEYS) key = "(more)";
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return true;
}

/** Every count since the process started (self's `/api/stats`). */
export const cspCounts = (): Record<string, number> => Object.fromEntries(counts);

/** The counts since the last call, then reset (hosted's minute log). */
export function drainCsp(): Map<string, number> {
  const out = counts;
  counts = new Map();
  return out;
}
