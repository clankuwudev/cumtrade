// ====================================================================== //
// what a sell should return, before it is quoted                        //
// ====================================================================== //
//
// The sell side of the token page shows what a sell of the chosen share
// should bring, in ETH and dollars, and its price impact, the way the buy
// side shows its amount in dollars (the user's ask, from a cumOS tester).
// It is worked out from the board's row alone, with no request:
//
//   curve  the constant product valuation.ts uses, from the row's reserves:
//          ETH = phantom + raised, tokens = ETH × tokensPerEth. A seller can
//          only drain the real ETH, so a sell past k / phantom − tokens is
//          capped there, as the curve caps it. The fee comes off the ETH.
//   pool   a graduated token's V4 pool, at its active liquidity L: ETH =
//          L / √price, tokens = L × √price, the pool's fee off the tokens in.
//          The canonical pools are full range, and this matched eth_simulateV1
//          fills to the token on every graduated pool on the board.
//
// Price impact is the share the size itself costs, fees apart: s / (T + s)
// for s tokens into a reserve of T. It is an estimate either way; the plan
// sheet's quote, read fresh from the chain, is what the sell is held to.

/**
 * @param {any} row a board row
 * @param {number} tokens whole tokens to sell
 * @returns {{ netEth: number, feeEth: number, impactPct: number, sellable: number, capped: boolean, venue: "curve" | "pool" } | null}
 *   null when the row cannot say (no price, no reserves, no pool)
 */
export function sellEstimate(row, tokens) {
  const s0 = Number(tokens);
  const tpe = Number(row && row.tokensPerEth);
  if (!row || !(s0 > 0) || !(tpe > 0) || !Number.isFinite(s0)) return null;

  if (row.graduated) {
    const L = Number(row.v4 && row.v4.liquidity) / 1e18;
    const fee = Number(row.v4 && row.v4.lpFee) / 1e6;
    if (!(L > 0) || !(fee >= 0 && fee < 1)) return null;
    const E = L / Math.sqrt(tpe), T = L * Math.sqrt(tpe);
    const s = s0 * (1 - fee);
    const netEth = (E * s) / (T + s);
    return { netEth, feeEth: (s0 * fee) / tpe, impactPct: (100 * s) / (T + s), sellable: s0, capped: false, venue: "pool" };
  }

  const phantom = Number(row.phantomEth), raised = Number(row.raised);
  const feeBps = Number(row.feeBps);
  if (!(phantom > 0) || !(raised >= 0) || !(feeBps >= 0 && feeBps < 10_000)) return null;
  const Q = phantom + raised, T = Q * tpe, k = Q * T;
  // k / phantom − T, written so that nothing raised is exactly nothing.
  const cap = (T * raised) / phantom;
  const s = Math.min(s0, cap);
  if (!(s > 0)) return { netEth: 0, feeEth: 0, impactPct: 0, sellable: 0, capped: true, venue: "curve" };
  const gross = Q - k / (T + s);
  const feeEth = (gross * feeBps) / 10_000;
  return { netEth: gross - feeEth, feeEth, impactPct: (100 * s) / (T + s), sellable: s, capped: s < s0, venue: "curve" };
}

/** Above this impact the page says so in amber, as the server's prepare warns (PRICE_IMPACT_WARN_BPS). */
export const IMPACT_WARN_PCT = 3;
