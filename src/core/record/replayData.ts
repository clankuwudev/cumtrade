import type { ReceiptRow, TradeRow } from "../lib/indexStore.js";
import { groupTimes, priceFromCurve, timeOf, type Candle } from "./candles.js";

/**
 * One position's trade replay, from the chain index's curve trades
 * (p-sell-verdict.md, P4a): the shape self's `/api/record/replay` answers, so
 * the same video draws it. Pure: the token's trades and receipts go in.
 *
 * The index has curve trades only, not pool swaps (X26), so a graduated
 * token's chart ends at graduation: `graduatedAt` says where, and the video
 * draws a step from there to today's value instead of candles it has not got.
 */

/** Before the first buy, the chart shows up to this long, as self's 12 buckets do. */
export const LEAD_MS = 12 * 3600_000;
/** Candles per stretch: a little before, the hold, and what came after. */
const BEFORE = 6, HOLD = 24, AFTER = 24;
const DECIMALS = 18;

export type ReplayFill = { kind: "buy" | "sell"; at: number; eth: number; tokens: number; price: number | null; usd: number | null };

export type ReplayData = {
  token: string;
  segments: { before: Candle[]; holding: Candle[]; after: Candle[] };
  fills: ReplayFill[];
  gasEth: number;
  best: null;
  usdNow: number | null;
  usdDay: Record<string, number>;
  /** When the token graduated to its V4 pool, if it has; the chart stops there. */
  graduatedAt: number | null;
  asOfBlock: string;
};

type Input = {
  address: string;
  token: string;
  /** The position's opening (ms, /api/ledger's openedAt) and its close, if closed: which of several it is. */
  opened: number;
  closed: number | null;
  trades: TradeRow[];
  receipts: Map<string, ReceiptRow>;
  graduatedBlock: bigint | null;
  toBlock: bigint;
  now: number;
  usdNow: number | null;
  usdDay: Record<string, number>;
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The replay, or null when the index has no trade of this address's in the
 * position's window.
 */
export function replayData(i: Input): ReplayData | null {
  const a = i.address.toLowerCase();
  // Block times from the receipts the index keeps; a block without one is
  // placed between the nearest known, as the track record's are.
  const anchors: [number, number][] = [...i.receipts.values()].map((r) => [Number(r.block), Number(r.time) * 1000]);
  const at = (t: TradeRow) => {
    const r = i.receipts.get(t.tx);
    return r ? Number(r.time) * 1000 : timeOf(anchors, Number(t.block));
  };
  const priced = i.trades.map((t) => ({
    t, at: at(t), price: priceFromCurve(t.kind, t.amountIn, t.amountOut, t.fee, DECIMALS),
  }));

  // This position's own trades: the address bought or sold, inside its window.
  // A second of slack either side, since openedAt is a block's time.
  const mine = priced.filter(({ t, at: when }) => (t.caller === a || t.recipient === a)
    && when >= i.opened - 1000 && (i.closed === null || when <= i.closed + 1000));
  if (mine.length === 0) return null;

  const fills: ReplayFill[] = mine.map(({ t, at: when }) => {
    const eth = Number(t.kind === "buy" ? t.amountIn : t.amountOut) / 1e18;
    const tokens = Number(t.kind === "buy" ? t.amountOut : t.amountIn) / 10 ** DECIMALS;
    const rate = i.usdDay[dayOf(when)] ?? null;
    return { kind: t.kind, at: when, eth, tokens, price: tokens > 0 ? eth / tokens : null, usd: rate ? eth * rate : null };
  });
  // Gas the address paid, once per transaction it sent.
  const sent = new Set(mine.map(({ t }) => t.tx).filter((tx) => i.receipts.get(tx)?.sender === a));
  const gasEth = [...sent].reduce((s, tx) => s + Number(i.receipts.get(tx)!.gas) / 1e18, 0);

  const buys = fills.filter((f) => f.kind === "buy"), sells = fills.filter((f) => f.kind === "sell");
  const firstBuy = buys.length ? buys[0]!.at : fills[0]!.at;
  const lastSell = sells.length ? sells[sells.length - 1]!.at : null;
  const launch = priced.length ? priced[0]!.at : firstBuy;
  const graduatedAt = i.graduatedBlock === null ? null : timeOf(anchors, Number(i.graduatedBlock));
  // The curve's last word: graduation for a graduated token, else now.
  const end = graduatedAt !== null ? Math.max(graduatedAt, lastSell ?? firstBuy) : i.now;
  const points = priced.map(({ at: when, price }) => ({ at: when, price }));

  const beforeFrom = Math.max(launch, firstBuy - LEAD_MS);
  const holdTo = lastSell ?? end;
  const segments = {
    before: beforeFrom < firstBuy ? groupTimes(points, beforeFrom, firstBuy - 1, BEFORE) : [],
    holding: groupTimes(points, firstBuy, holdTo, HOLD),
    after: lastSell !== null && end > lastSell ? groupTimes(points, lastSell + 1, end, AFTER) : [],
  };

  return {
    token: i.token, segments, fills, gasEth, best: null,
    usdNow: i.usdNow, usdDay: i.usdDay, graduatedAt, asOfBlock: i.toBlock.toString(),
  };
}
