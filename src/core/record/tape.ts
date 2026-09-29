import type { ReceiptRow, TradeRow } from "../lib/indexStore.js";
import { groupTimes, priceFromCurve, timeOf, type Candle } from "./candles.js";

/**
 * A token's trade tape and its candles, from the chain index's curve trades
 * (x25-batch2-token-page.md, X25a). Pure: the index's reading of one token
 * goes in; the cache that keeps one tape per token per cursor (E3) is here
 * too, with its reads passed in.
 *
 * Who traded is who signed, the receipt's sender (E4). Time is the block's
 * (E5). A trade whose receipt is not in yet takes its trader from the event
 * (a buy's recipient, a sell's caller) and its time from the nearest known
 * blocks, and says so. Prices are ETH per whole token before the fee (E6).
 *
 * The index has curve trades only (X26 adds pool swaps), so a graduated
 * token's tape and candles end at graduation (E7).
 */

/** Every launch mints this many whole tokens: market cap is price × this (E6). */
export const SUPPLY = 1_000_000_000;
const DECIMALS = 18;

/** One token as the index reads it at its cursor (follower.tokenTrades). */
export type TokenReading = {
  toBlock: bigint;
  trades: TradeRow[];
  receipts: Map<string, ReceiptRow>;
  graduatedBlock: bigint | null;
  /** Null for a token the index has not seen launch. */
  launch: { curve: string; creator: string; block: bigint; syncedTo: bigint | null } | null;
  /** [block, ms] the index knows beyond this token's receipts. */
  anchors: [number, number][];
};

export type TapeRow = {
  tx: string; block: number; logIndex: number;
  /** Unix ms, the block's time; estimated between known blocks when `atEstimated`. */
  at: number; atEstimated: boolean;
  side: "buy" | "sell";
  /** ETH paid in (a buy) or taken out (a sell), fees included. */
  eth: number;
  tokens: number;
  /** ETH per whole token, before the fee; null when it cannot be worked out. */
  price: number | null;
  trader: string; traderFromEvent: boolean;
};

export type Tape = {
  token: string;
  asOfBlock: string;
  /** Whether the index has read this token's history up to its cursor (E2). */
  indexed: boolean;
  launchedAt: number | null;
  graduatedAt: number | null;
  /** Oldest first. */
  rows: TapeRow[];
};

/**
 * A block's time (ms) from what the reading knows: this token's receipts and
 * the index's newest and oldest. Never later than now: past the newest known
 * block, time is carried on at the nearest rate, which a burst of blocks can
 * run ahead of the clock. With no block time known at all, now.
 */
export function clockOf(r: TokenReading, now: number): (block: bigint) => number {
  const own: [number, number][] = [...r.receipts.values()].map((x) => [Number(x.block), Number(x.time) * 1000]);
  const anchors = [...own, ...r.anchors];
  return (block) => (anchors.length ? Math.min(now, Math.round(timeOf(anchors, Number(block)))) : now);
}

export function tapeOf(token: string, r: TokenReading, now: number): Tape {
  const timeAt = clockOf(r, now);
  const rows: TapeRow[] = r.trades.map((t) => {
    const rc = r.receipts.get(t.tx);
    const eth = Number(t.kind === "buy" ? t.amountIn : t.amountOut) / 1e18;
    const tokens = Number(t.kind === "buy" ? t.amountOut : t.amountIn) / 10 ** DECIMALS;
    const price = priceFromCurve(t.kind, t.amountIn, t.amountOut, t.fee, DECIMALS);
    return {
      tx: t.tx, block: Number(t.block), logIndex: t.logIndex,
      at: rc ? Number(rc.time) * 1000 : timeAt(t.block), atEstimated: !rc,
      side: t.kind, eth, tokens, price: price > 0 ? price : null,
      // A router sell's caller is the router: until the receipt names who
      // signed, a sell's caller is the best the event has.
      trader: rc ? rc.sender : t.kind === "buy" ? t.recipient : t.caller,
      traderFromEvent: !rc,
    };
  });
  const syncedTo = r.launch?.syncedTo ?? null;
  return {
    token: token.toLowerCase(),
    asOfBlock: r.toBlock.toString(),
    indexed: syncedTo !== null && syncedTo >= r.toBlock,
    launchedAt: r.launch ? timeAt(r.launch.block) : rows.length ? rows[0]!.at : null,
    graduatedAt: r.graduatedBlock === null ? null : timeAt(r.graduatedBlock),
    rows,
  };
}

/** A place in the tape: `block:logIndex`. */
export type TapeCursor = { block: number; logIndex: number };

export function parseCursor(s: string): TapeCursor | null {
  const m = s.match(/^(\d{1,15}):(\d{1,9})$/);
  return m ? { block: Number(m[1]), logIndex: Number(m[2]) } : null;
}

/**
 * One page of the tape, newest first: up to `limit` trades strictly before
 * `before` (all of them without it), and the cursor to ask for next, or null
 * at the first trade.
 */
export function pageOf(rows: TapeRow[], before: TapeCursor | null, limit: number): { trades: TapeRow[]; next: string | null } {
  let end = rows.length;
  if (before) {
    while (end > 0) {
      const r = rows[end - 1]!;
      if (r.block < before.block || (r.block === before.block && r.logIndex < before.logIndex)) break;
      end--;
    }
  }
  const start = Math.max(0, end - limit);
  const first = rows[start];
  return {
    trades: rows.slice(start, end).reverse(),
    next: start > 0 && first ? `${first.block}:${first.logIndex}` : null,
  };
}

/**
 * The tape's prices as up to `n` candles from the launch to graduation, or
 * to now for a curve still trading. Empty before the first trade.
 */
export function candlesOf(tape: Tape, n: number, now: number): { from: number | null; to: number | null; candles: Candle[] } {
  const points = tape.rows.filter((r) => r.price !== null).map((r) => ({ at: r.at, price: r.price! }));
  const from = tape.launchedAt ?? (points.length ? points[0]!.at : null);
  const to = tape.graduatedAt ?? now;
  if (from === null || points.length === 0 || to < from) return { from, to: from === null ? null : to, candles: [] };
  return { from, to, candles: groupTimes(points, from, to, n) };
}

/** The token page's candle sizes, in ms (tv-candlestick-chart.md, TV1). */
export const TIMEFRAMES = { "1s": 1_000, "15s": 15_000, "1m": 60_000, "5m": 300_000 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
/** At most this many candles in one answer: the newest ones. */
export const FRAME_CAP = 500;

/** One fixed-interval candle: `t` is its start in unix ms, `v` the ETH traded in it. */
export type FrameCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export const isTimeframe = (s: string): s is Timeframe => Object.hasOwn(TIMEFRAMES, s);

/**
 * A tape's candles on fixed boundaries of `tf` (TV1): multiples of it since
 * the epoch, so the same trade falls in the same candle on every read. Each
 * candle opens at the last close, as the curve's price does not move between
 * trades, and its high and low take that open in. A stretch with no trade has
 * no candle: the chart leaves the gap, as TradingView does. The newest `cap`.
 * `to` is graduation, as in candlesOf, or now.
 */
export function framesOf(tape: Tape, tf: Timeframe, now: number, cap = FRAME_CAP): { from: number | null; to: number | null; candles: FrameCandle[] } {
  const ms = TIMEFRAMES[tf];
  const rows = tape.rows.filter((r) => r.price !== null)
    .slice().sort((a, b) => a.at - b.at || a.block - b.block || a.logIndex - b.logIndex);
  const out: FrameCandle[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const t = Math.floor(r.at / ms) * ms;
    const p = r.price!;
    let c = out[out.length - 1];
    if (!c || c.t !== t) {
      const o = prev ?? p;
      c = { t, o, h: o, l: o, c: o, v: 0 };
      out.push(c);
    }
    if (p > c.h) c.h = p;
    if (p < c.l) c.l = p;
    c.c = p;
    c.v += r.eth;
    prev = p;
  }
  const from = tape.launchedAt ?? (rows.length ? rows[0]!.at : null);
  return { from, to: tape.graduatedAt ?? now, candles: out.slice(-cap) };
}

/**
 * A new trade is sent live when it is at most this many blocks behind the
 * cursor, about two minutes of this chain. A token read again from its launch
 * (a rebuild, D1.5) brings its whole history in as new rows, and none of that
 * is live.
 */
export const LIVE_BLOCKS = 1_200;
/** At most this many trades are sent for one committed window (E8). */
export const EVENT_CAP = 200;

/**
 * The `trade` events one committed window sends: the trades the store did not
 * have before, as tape rows with their token, oldest first. The newest
 * `EVENT_CAP` of them, and only those `LIVE_BLOCKS` or less behind the cursor.
 */
export function tradeEvents(fresh: TradeRow[], tapeFor: (token: string) => Tape | null): (TapeRow & { token: string })[] {
  const byToken = new Map<string, Set<string>>();
  for (const t of fresh) {
    const k = t.token.toLowerCase();
    if (!byToken.has(k)) byToken.set(k, new Set());
    byToken.get(k)!.add(`${t.tx.toLowerCase()}:${t.logIndex}`);
  }
  const out: (TapeRow & { token: string })[] = [];
  for (const [token, keys] of byToken) {
    const tape = tapeFor(token);
    if (!tape) continue;
    const live = Number(tape.asOfBlock) - LIVE_BLOCKS;
    for (const r of tape.rows) {
      if (r.block >= live && keys.has(`${r.tx.toLowerCase()}:${r.logIndex}`)) out.push({ token, ...r });
    }
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out.slice(-EVENT_CAP);
}

/**
 * One tape per token, kept while the cursor stays where it was (E3): every
 * route and the live event for a token share it. `drop` forgets tokens whose
 * history moved without the cursor (a catch-up window).
 */
export function createTapeCache(opts: {
  read: (token: string) => TokenReading | null;
  cursor: () => bigint | null;
  now?: () => number;
  max?: number;
}) {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 256;
  const kept = new Map<string, { at: bigint; tape: Tape; reading: TokenReading }>();
  const entry = (token: string) => {
    const t = token.toLowerCase();
    const cur = opts.cursor();
    if (cur === null) return null;
    const hit = kept.get(t);
    if (hit && hit.at === cur) return hit;
    const r = opts.read(t);
    if (!r) return null;
    const e = { at: r.toBlock, tape: tapeOf(t, r, now()), reading: r };
    kept.delete(t);
    kept.set(t, e);
    if (kept.size > max) kept.delete(kept.keys().next().value!);
    return e;
  };
  return {
    get(token: string): Tape | null {
      return entry(token)?.tape ?? null;
    },
    /** The index's reading the tape was made from, for other routes on the same token (X27a). */
    reading(token: string): TokenReading | null {
      return entry(token)?.reading ?? null;
    },
    drop(tokens: Iterable<string>) {
      for (const t of tokens) kept.delete(t.toLowerCase());
    },
    size: () => kept.size,
  };
}
