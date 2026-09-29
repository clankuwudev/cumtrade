import type { Position } from "../core/positions/accounting.js";
import { pnl, type Valuation } from "../core/positions/valuation.js";

/**
 * The fields a position page reads, derived from a stored position and its
 * valuation (public-release B3.5). Self's `/api/positions` and hosted's
 * `/api/ledger` both answer with these, so a position reads the same in
 * either. Self adds what only its manager knows (`peakPct`, `exit`).
 *
 * Key order is part of the answer: self's response is compared byte for
 * byte, so these come after the position's own fields and in this order.
 */
export function valuedFields(p: Position, v: Valuation) {
  const tokens = BigInt(p.tokens);
  const cost = BigInt(p.costEth);
  const m = pnl(p, v);
  return {
    nowEth: Number(v.netWei) / 1e18,
    grossEth: Number(v.grossWei) / 1e18,
    costEthNum: Number(cost) / 1e18,
    pnlPct: m.pnlPct,
    // The split. `pnlPct` is what you would bank; `priceMovePct` is what
    // the market did. They differ by the round trip, which is why a
    // position reads about -2% the moment it opens on a 1% curve.
    priceMovePct: m.priceMovePct,
    feeDragPct: m.feeDragPct,
    breakevenMovePct: m.breakevenMovePct,
    entryFeeEth: Number(m.entryFeeWei) / 1e18,
    exitFeeEth: Number(m.exitFeeWei) / 1e18,
    realizedEth: Number(m.realizedWei) / 1e18,
    totalPnlPct: m.totalPnlPct,
    totalDeltaEth: Number(m.totalDeltaWei) / 1e18,
    feeBps: v.feeBps,
    venue: v.venue,
    capped: v.capped,
    progress: v.progress,
    // What fraction of the holding the curve can actually absorb right now.
    // The UI draws this as its own bar because a position that is up 90%
    // and 60% sellable is not a position that is up 90%.
    sellablePct: tokens > 0n ? (Number(v.sellable) / Number(tokens)) * 100 : 0,
  };
}

/** The same fields for a position that could not be valued: zeros, not guesses. */
export function unvaluedFields(p: Position) {
  return {
    nowEth: 0, grossEth: 0, costEthNum: Number(p.costEth) / 1e18, pnlPct: 0,
    priceMovePct: 0, feeDragPct: 0, breakevenMovePct: 0,
    entryFeeEth: Number(p.entryFeeWei) / 1e18, exitFeeEth: 0,
    realizedEth: Number(p.realizedWei) / 1e18, totalPnlPct: 0, totalDeltaEth: 0,
    feeBps: p.feeBps, venue: "curve" as const,
    capped: false, progress: 0, sellablePct: 0,
  };
}
