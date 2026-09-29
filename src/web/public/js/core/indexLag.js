import { S } from "./store.js";
import { api } from "./api.js";
import { html } from "./dom.js";
import { dur } from "./format.js";

// The "as of" line (x25-batch2-token-page.md, D3): shown when the chain
// index is more than a minute behind the chain. The token page's tabs and
// the Traders page (x29-leaderboard.md, X29b) share it.

/**
 * How far the chain index is behind, for the "as of" line (D3): from /healthz
 * on a hosted page, at most once every 30 s. A page without it (self) shows
 * no line.
 */
export async function readIndexLag() {
  if (S.indexLag && Date.now() - S.indexLag.at < 30_000) return;
  const r = await api("/healthz").catch(() => ({ status: 0, data: null }));
  const blocks = r.status === 200 && r.data ? r.data.followerLagBlocks : null;
  S.indexLag = typeof blocks === "number" ? { blocks, at: Date.now() } : null;
}

/** The chain runs about ten blocks a second (D1.0). */
const BLOCKS_PER_SEC = 10;

/**
 * "As of N s ago" when the index is more than a minute behind the chain
 * (x25-batch2-token-page.md edge cases, D3); nothing when it is not, or not
 * known.
 */
export function asOfLine() {
  const lag = S.indexLag;
  if (!lag || lag.blocks / BLOCKS_PER_SEC <= 60) return "";
  const behind = Math.round(lag.blocks / BLOCKS_PER_SEC);
  return html`<p class="tasof" role="status">As of ${dur(behind * 1000)} ago: the index is behind the chain, and catches up by itself.</p>`;
}
