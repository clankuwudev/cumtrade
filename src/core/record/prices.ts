import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { client } from "../lib/client.js";
import { isRateLimited } from "../lib/logGate.js";
import { BUY_TOPIC, SELL_TOPIC } from "../positions/attribution.js";
import { addPrice, priceFromCurve, priceFromSqrt, type Buckets } from "./candles.js";
import { VENUES, type Venue } from "../chain.js";

/**
 * What a track record's tokens are worth, and were worth after they were sold
 * (docs/specs/track-record.md, T2).
 *
 * Uniswap V4 pools only, for any token: found by their Initialize event, read
 * straight out of the PoolManager, and replayed through their Swap events.
 * A clank.trade curve is valued by the caller with the curve's own maths.
 */

/** Robinhood Chain's Uniswap V4 PoolManager, as clank.trade's factory reports it. */
export const POOL_MANAGER = getAddress(process.env.V4_POOL_MANAGER ?? "0x8366a39cc670b4001a1121b8f6a443a643e40951");
const POOLS_SLOT = 6n;
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** topic0 of the PoolManager's Swap event; topic1 is the pool id. */
export const SWAP = keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const NATIVE_TOPIC = `0x${"0".repeat(64)}`;
const PM_ABI = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);

const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const hexBlock = (b: number) => `0x${b.toString(16)}`;

/**
 * ETH out for selling `raw` token units into a native-ETH V4 pool, after its
 * fee, holding the active liquidity constant. The token is currency1, so
 * selling it raises sqrtP by raw/L, and ETH out is L(1/sqrtP - 1/sqrtP').
 * Exact while the sale stays inside the current tick range, which it does in
 * the full-range pools launchpads create; past it, an overestimate.
 */
export function sellEstimate(raw: bigint, sqrtX96: bigint, liquidity: bigint, feePips: number): number {
  if (liquidity === 0n || raw === 0n || sqrtX96 === 0n) return 0;
  const sp = Number(sqrtX96) / 2 ** 96;
  const L = Number(liquidity);
  const after = sp + (Number(raw) * (1 - feePips / 1e6)) / L;
  return (L * (1 / sp - 1 / after)) / 1e18;
}

export type Pool = { id: Hex; fee: number; sqrtX96: bigint; liquidity: bigint };

/** The ids of every native-ETH pool the token has. One log scan. */
export async function poolsOf(token: string): Promise<Hex[]> {
  const logs = await client.request({
    method: "eth_getLogs",
    params: [{ address: POOL_MANAGER, fromBlock: "0x0", toBlock: "latest",
      topics: [INITIALIZE, null, NATIVE_TOPIC, topicOf(token)] }],
  } as never) as { topics: Hex[] }[];
  return logs.map((l) => l.topics[1]!);
}

/** Each pool's price, fee and active liquidity now. Folds into one multicall. */
export async function poolStates(ids: Hex[]): Promise<Pool[]> {
  const read = (slot: bigint) => client.readContract({
    address: POOL_MANAGER, abi: PM_ABI, functionName: "extsload",
    args: [`0x${slot.toString(16).padStart(64, "0")}` as Hex],
  }) as Promise<Hex>;
  return Promise.all(ids.map(async (id) => {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT])));
    const [slot0, liq] = await Promise.all([read(base), read(base + 3n)]);
    const v = BigInt(slot0);
    return {
      id, sqrtX96: v & ((1n << 160n) - 1n), fee: Number((v >> 208n) & 0xffffffn), liquidity: BigInt(liq),
    };
  }));
}

/** The pool a sale would go to: the one with the most active liquidity. */
export const deepest = (pools: Pool[]): Pool | null =>
  pools.filter((p) => p.sqrtX96 > 0n && p.liquidity > 0n)
    .sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0))[0] ?? null;

/** Which launchpad made a token, and its curve, or null. One log scan over every venue's factories. */
export async function launchOf(token: string): Promise<{ venue: Venue["key"]; curve: Address } | null> {
  const venues = Object.values(VENUES);
  const factories = venues.flatMap((v) => v.factories.map((f) => ({ venue: v, factory: f })));
  const floor = factories.reduce((m, x) => (x.factory.genesisBlock < m ? x.factory.genesisBlock : m),
    factories[0]!.factory.genesisBlock);
  const logs = await client.request({
    method: "eth_getLogs",
    params: [{ address: factories.map((x) => x.factory.address), fromBlock: `0x${floor.toString(16)}`, toBlock: "latest",
      // Every venue's launch event has the same topic (chain.ts).
      topics: [venues[0]!.launchTopic, topicOf(token)] }],
  } as never) as { address: string; topics: Hex[] }[];
  const l = logs[0];
  if (!l) return null;
  const venue = factories.find((x) => x.factory.address.toLowerCase() === l.address.toLowerCase())!.venue;
  return { venue: venue.key, curve: getAddress(`0x${l.topics[2]!.slice(26)}`) };
}

/**
 * Where a scan of one pool has got to. It reads every swap from `start` (a
 * little before the first buy), folding each price into `buckets` for the
 * candles, and measures the best exit only from `from` (the last sell) on.
 */
export type Scan = {
  pool: Hex;
  /** The sale being measured: this many raw units, sold at or after `from`. */
  raw: string;
  from: number;
  /** Where the price series begins. */
  start: number;
  /** The token's decimals, for pricing a whole token. */
  decimals: number;
  /** Every swap up to and including this block has been seen. */
  scannedTo: number;
  swaps: number;
  best: { eth: number; block: number; price: number } | null;
  buckets: Buckets;
  /** Bumped when what a scan records changes, so older scans are read again. */
  v?: number;
  /** The window size that last worked, so the next refresh starts there. */
  window?: number;
};

/** The current scan version: 2 leaves swaps that emptied the pool's range out of the candles. */
export const SCAN_VERSION = 2;

export const newScan = (pool: Hex, raw: bigint, from: number, start = from, decimals = 18): Scan =>
  ({ pool, raw: raw.toString(), from, start, decimals, scannedTo: Math.min(start, from) - 1, swaps: 0, best: null,
    buckets: {}, v: SCAN_VERSION });

/**
 * Carry a scan forward to `to`, in windows that halve when the node rejects a
 * wide one. Stops early, keeping what it has, after `maxCalls` requests, when
 * the node refuses us for volume (smaller windows would only be refused too),
 * or when it keeps rejecting even small windows: the next refresh resumes
 * from `scannedTo`. `pauseMs` spaces the requests, so a long scan does not
 * trip the public node's limit on its own.
 */
export async function advance(
  scan: Scan, to: number, opts: { maxCalls?: number; window?: number; pauseMs?: number } = {},
) {
  const raw = BigInt(scan.raw);
  const win = windowing(opts.window ?? 2_000_000, scan.window);
  let calls = 0, refusals = 0;
  const budget = opts.maxCalls ?? 400;
  const pause = opts.pauseMs ?? 0;
  while (scan.scannedTo < to && calls < budget) {
    const lo = scan.scannedTo + 1;
    const hi = Math.min(to, lo + win.step - 1);
    if (calls > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
    calls++;
    let logs: { data: Hex; blockNumber: Hex }[];
    try {
      logs = await client.request({
        method: "eth_getLogs",
        params: [{ address: POOL_MANAGER, fromBlock: hexBlock(lo), toBlock: hexBlock(hi), topics: [SWAP, scan.pool] }],
      } as never) as { data: Hex; blockNumber: Hex }[];
    } catch (e) {
      if (isRateLimited(e)) return { calls, complete: false, error: e as Error, refused: true };
      if (win.rejected()) continue;
      if (++refusals >= 3) return { calls, complete: false, error: e as Error, refused: false };
      continue;
    }
    for (const l of logs) {
      const word = (i: number) => BigInt(`0x${l.data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
      // data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee
      const block = Number(BigInt(l.blockNumber));
      const sqrt = word(2);
      scan.buckets ??= {};
      // A swap that left no liquidity in range left the price at the edge of
      // the pool, not at a market price: it is not a candle.
      if (word(3) > 0n) addPrice(scan.buckets, block, priceFromSqrt(sqrt, scan.decimals ?? 18));
      scan.swaps++;
      if (block < scan.from) continue;
      const eth = sellEstimate(raw, sqrt, word(3), Number(word(5) & 0xffffffn));
      // A best carried over from an older scan may lack its price; fill it in
      // when this scan reaches the same swap.
      if (!scan.best || eth > scan.best.eth || (block === scan.best.block && scan.best.price == null)) {
        scan.best = { eth: Math.max(eth, scan.best?.eth ?? 0), block, price: priceFromSqrt(sqrt, scan.decimals ?? 18) };
      }
    }
    scan.scannedTo = hi;
    win.answered(logs.length, hi - lo + 1);
    scan.window = win.good;
  }
  return { calls, complete: scan.scannedTo >= to, error: null, refused: false };
}

// The call on a sell lives in verdict.ts, pure, so hosted can use it without
// loading the scans (p-sell-verdict.md, D2).
export { verdict, type Verdict } from "./verdict.js";

/**
 * How wide a window of blocks to ask for. The public node rejects a window
 * that would take too long, and for the PoolManager, the busiest contract on
 * the chain, that happens well below 2M blocks. A rejected size becomes the
 * ceiling and the scan carries on at half of it; after 8 windows answered in
 * a row it tries double once. Widening after every answer instead made a scan
 * swing between a rejection and a success, and one token cost 1,500 requests.
 */
export function windowing(widest: number, from?: number) {
  const MIN = 25_000;
  let cap = Math.max(MIN, Math.min(widest, from ?? widest));
  let good = from ?? 0;
  let streak = 0;
  return {
    get step() { return cap; },
    /** The last size the node answered: where the next refresh should start. */
    get good() { return good || cap; },
    /** The node rejected a window of the current size. False when it cannot get smaller. */
    rejected(): boolean {
      streak = 0;
      if (cap <= MIN) return false;
      cap = Math.max(MIN, Math.floor(cap / 2));
      return true;
    },
    /**
     * The node answered a window of `size` blocks with `n` logs. Only a
     * full-size window says the size works: the last one of a scan is short.
     */
    answered(n: number, size: number) {
      if (size < cap) return;
      good = cap;
      if (n >= 5_000) { streak = 0; return; }
      if (++streak >= 8 && cap < widest) { cap = Math.min(widest, cap * 2); streak = 0; }
    },
  };
}

/** Where a scan of one launchpad curve's trades has got to: prices only. */
export type CurveSeries = {
  curve: Address;
  start: number;
  decimals: number;
  scannedTo: number;
  trades: number;
  buckets: Buckets;
  window?: number;
};

export const newCurveSeries = (curve: Address, start: number, decimals = 18): CurveSeries =>
  ({ curve, start, decimals, scannedTo: start - 1, trades: 0, buckets: {} });

/**
 * Carry a curve's price series forward to `to`, from its Buy and Sell events.
 * The same windows, budget, pacing and refusal rule as a pool scan.
 */
export async function advanceCurve(
  series: CurveSeries, to: number, opts: { maxCalls?: number; window?: number; pauseMs?: number } = {},
) {
  const win = windowing(opts.window ?? 2_000_000, series.window);
  let calls = 0, refusals = 0;
  const budget = opts.maxCalls ?? 400;
  const pause = opts.pauseMs ?? 0;
  while (series.scannedTo < to && calls < budget) {
    const lo = series.scannedTo + 1;
    const hi = Math.min(to, lo + win.step - 1);
    if (calls > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
    calls++;
    let logs: { topics: Hex[]; data: Hex; blockNumber: Hex }[];
    try {
      logs = await client.request({
        method: "eth_getLogs",
        params: [{ address: series.curve, fromBlock: hexBlock(lo), toBlock: hexBlock(hi), topics: [[BUY_TOPIC, SELL_TOPIC]] }],
      } as never) as { topics: Hex[]; data: Hex; blockNumber: Hex }[];
    } catch (e) {
      if (isRateLimited(e)) return { calls, complete: false, error: e as Error, refused: true };
      if (win.rejected()) continue;
      if (++refusals >= 3) return { calls, complete: false, error: e as Error, refused: false };
      continue;
    }
    for (const l of logs) {
      const word = (i: number) => BigInt(`0x${l.data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
      const kind = l.topics[0]?.toLowerCase() === BUY_TOPIC.toLowerCase() ? "buy" : "sell";
      // data: amountIn, amountOut, fee, snipeTax
      addPrice(series.buckets, Number(BigInt(l.blockNumber)), priceFromCurve(kind, word(0), word(1), word(2), series.decimals));
      series.trades++;
    }
    series.scannedTo = hi;
    win.answered(logs.length, hi - lo + 1);
    series.window = win.good;
  }
  return { calls, complete: series.scannedTo >= to, error: null, refused: false };
}
