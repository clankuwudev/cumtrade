import { isAddress, type Address } from "viem";
import { send, type Route } from "../http.js";
import { rows } from "../board.js";
import { indexedHolders } from "../../core/lib/chainIndex.js";
import { cached } from "../../core/lib/cache.js";
import { client } from "../../core/lib/client.js";
import { curveAbi } from "../../core/abi.js";
import { poolFor } from "../../core/market/v4.js";
import { POOL_MANAGER } from "../../core/record/prices.js";
import { holderSet, withSpot } from "../../core/record/holders.js";
import { clockOf, type TokenReading } from "../../core/record/tape.js";
import { tapes } from "./tape.js";

/**
 * `GET /api/holders?token=&limit=` (x25-batch2-token-page.md, X27a): a token's
 * holders from the chain index, largest first, with their roles and how each
 * has done on it. In the `read` class (E15): the rows are worked out once per
 * token per cursor from the tape's reading (E3), and only the spot price is
 * applied per request.
 */

/** A spot price read from the chain, for a token off the board, is shared this long (E9). */
export const SPOT_MS = 5_000;

export type HoldersDeps = {
  reading: (token: string) => TokenReading | null;
  holders: typeof indexedHolders;
  /** Tokens per ETH at spot, or null when it cannot be read. */
  spot: (token: string, reading: TokenReading) => Promise<number | null>;
  now?: () => number;
};

/**
 * H1: the board's row where the token has one (re-read after every trade, so
 * no RPC); otherwise one read, shared for 5 s: the curve's reserves, or the
 * V4 pool's price once graduated.
 */
export async function boardOrChainSpot(token: string, reading: TokenReading): Promise<number | null> {
  const row = rows.get(token.toLowerCase());
  const graduated = reading.graduatedBlock !== null;
  if (row && row.status === "ready") {
    if (row.graduated) return row.v4 && row.tokensPerEth > 0 ? row.tokensPerEth : null;
    if (!graduated) return row.tokensPerEth > 0 ? row.tokensPerEth : null;
  }
  try {
    return await cached(`spot:${token.toLowerCase()}`, SPOT_MS, async () => {
      if (graduated) {
        const pool = await poolFor(token as Address);
        return pool && pool.tokensPerEth > 0 ? pool.tokensPerEth : null;
      }
      const curve = reading.launch?.curve;
      if (!curve) return null;
      const C = { address: curve as Address, abi: curveAbi } as const;
      const [quote, tokens] = await Promise.all([
        client.readContract({ ...C, functionName: "quoteReserve" }),
        client.readContract({ ...C, functionName: "tokenReserve" }),
      ]);
      return quote > 0n ? Number(tokens) / Number(quote) : null;
    });
  } catch {
    return null;
  }
}

const DEPS: HoldersDeps = { reading: (t) => tapes.reading(t), holders: indexedHolders, spot: boardOrChainSpot };

/** A whole number from a query, clamped into [lo, hi]; `dflt` when absent, null when not a number. */
function count(raw: string | null, dflt: number, lo: number, hi: number): number | null {
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

export function holdersRoute(deps: HoldersDeps = DEPS): Route {
  const now = deps.now ?? Date.now;
  // The rows without their spot value, one set per token per cursor.
  const kept = new Map<string, { at: string; limit: number; set: ReturnType<typeof holderSet> }>();
  return {
    name: "holders",
    match: (url) => url.pathname === "/api/holders",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const token = url.searchParams.get("token") ?? "";
      const limit = count(url.searchParams.get("limit"), 50, 1, 100);
      if (!isAddress(token, { strict: false }) || limit === null) {
        return send(res, 400, { error: "bad request", text: "Holders need a token's address; limit is a number." });
      }
      const k = token.toLowerCase();
      const reading = deps.reading(k);
      const held = deps.holders(k);
      if (!reading || !held || !reading.launch) {
        return send(res, 404, {
          error: "not indexed", indexed: false,
          text: "The index has not read this token's holders up to now yet. Try again in a minute.",
        });
      }
      const at = reading.toBlock.toString();
      let hit = kept.get(k);
      if (!hit || hit.at !== at || hit.limit !== limit) {
        hit = {
          at, limit,
          set: holderSet({ token: k, reading, holders: held.holders, supply: held.supply, poolManager: POOL_MANAGER, limit, now: now() }),
        };
        kept.delete(k);
        kept.set(k, hit);
        if (kept.size > 256) kept.delete(kept.keys().next().value!);
      }
      const spot = await deps.spot(k, reading);
      const graduatedAt = reading.graduatedBlock === null ? null
        : clockOf(reading, now())(reading.graduatedBlock);
      return send(res, 200, {
        token: k, asOfBlock: at, supply: hit.set.supply, holders: hit.set.holders, top10Pct: hit.set.top10Pct,
        graduatedAt, pnl: "before gas", rows: withSpot(hit.set.rows, spot),
      });
    },
  };
}
