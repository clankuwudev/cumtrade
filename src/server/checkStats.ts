import { sellableOf, type Analysis } from "../core/checker/analyze.js";
import type { Derived } from "../core/checker/rules.js";
import type { Row } from "./board.js";

/** A bonded token's live market: what a board row carries, or a pool read on its own. */
export type Market = Pick<Row, "v4" | "tokensPerEth" | "fdvEth">;

/** A number the page can print, or null for one it must print as "—". */
const fin = (x: number) => (Number.isFinite(x) ? x : null);

/**
 * The numbers a launch card shows, from the check's own analysis
 * (`/api/check`'s `stats`).
 *
 * A checked token need not be on the board, so the Checker cannot count on a
 * board row for them. Everything here was computed by `analyze` / `derive`
 * already: no call is added. The distribution figures are the ones the
 * findings quote, so the two always agree: `devBuyPct` is the creator's
 * launch-block buy ("Creator dev-buy at launch"), `creatorPct` what the
 * creator holds now ("Creator holds a large position").
 *
 * A bonded curve's reserves are drained, so its own price froze at
 * graduation. Its market cap comes from a V4 read (the board row's, or the
 * hosted check's own for a token off the board, B5.1), and is null (unknown)
 * without one, rather than the frozen figure.
 */
export function checkStats(a: Analysis, d: Derived, market?: Market) {
  const v4 = a.graduated && market && market.v4 && market.tokensPerEth > 0 ? market : null;
  const deadPriors = a.creatorLaunches.filter((p) => !p.graduated && p.raised < 10n ** 17n).length;
  // An empty curve has no spot price, and so no market cap either.
  const priced = Number.isFinite(d.tokensPerEth) && d.tokensPerEth > 0;
  // Without the launch block nobody can be said to have bought in it.
  const block = a.launchBlock > 0n;
  return {
    curve: a.curve,
    creator: a.creator,
    launchedAt: Number(a.launchedAt) > 0 ? Number(a.launchedAt) : null,
    launchBlock: block ? Number(a.launchBlock) : null,
    holders: a.holders.length,
    devBuyPct: block ? fin(d.creatorBundlePct) : null,
    creatorPct: fin(d.creatorPct),
    bundlePct: block ? fin(d.foreignBundlePct) : null,
    top10Pct: fin(d.top10Pct),
    // A shallow analysis does not look the creator's record up.
    priorLaunches: a.deep ? a.creatorLaunches.length : null,
    priorDead: a.deep ? deadPriors : null,
    raised: Number(a.realQuote) / 1e18,
    threshold: a.gradThreshold > 0n ? Number(a.gradThreshold) / 1e18 : null,
    progress: a.graduated ? 1 : fin(d.progress),
    fdvEth: a.graduated ? (v4 ? v4.fdvEth : null) : priced ? fin(d.fdvEth) : null,
    tokensPerEth: a.graduated ? (v4 ? v4.tokensPerEth : null) : priced ? d.tokensPerEth : null,
    feeBps: Number(a.feeBps),
    sellable: sellableOf(a.sim),
    graduated: a.graduated,
    readyToGraduate: a.readyToGrad,
    v4: v4 ? v4.v4 : null,
  };
}

export type CheckStats = ReturnType<typeof checkStats>;
