/**
 * The call on a sell, shared by self's track record (record.ts, with its
 * best-exit scans) and hosted's `/api/ledger` (p-sell-verdict.md, which has
 * none and passes `best: null`). One function, so the two cannot disagree on
 * the threshold. Pure: hosted imports this and never the scan code.
 */

export type Verdict = "holding" | "unpriced" | "paperhand" | "fumble" | "good";

/**
 * How a sold position went, by what the tokens did after.
 *
 *  - paperhand: they would fetch more now than the sell got
 *  - fumble: they are not worth more now, but the market offered more after
 *  - good: neither
 *
 * "More" has to clear 10% of what the sell got, and 0.0005 ETH, or every
 * position a pool has since wobbled above would read as a mistake.
 */
export function verdict(p: { sold: boolean; back: number; soldNow: number | null; best: number | null }): Verdict {
  if (!p.sold) return "holding";
  if (p.soldNow === null && p.best === null) return "unpriced";
  const margin = Math.max(0.0005, 0.1 * p.back);
  if (p.soldNow !== null && p.soldNow - p.back > margin) return "paperhand";
  if (p.best !== null && p.best - p.back > margin) return "fumble";
  return "good";
}
