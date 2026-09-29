/**
 * Candles for the share cards (docs/specs/share-cards.md, C1). Pure.
 *
 * Prices are folded into fixed block buckets as they are read, so a card needs
 * no chain call: 36,000 blocks, about an hour on this chain. A card then groups
 * buckets into as many candles as it has room for. Times come from blocks
 * whose time is known, in between.
 */

export const BUCKET_BLOCKS = 36_000;

/** open, high, low, close. */
export type Ohlc = [number, number, number, number];
/** By bucket index: floor(block / BUCKET_BLOCKS). */
export type Buckets = Record<string, Ohlc>;

/** Fold one price in. Prices must arrive in block order within a bucket. */
export function addPrice(b: Buckets, block: number, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const k = String(Math.floor(block / BUCKET_BLOCKS));
  const c = b[k];
  if (!c) { b[k] = [price, price, price, price]; return; }
  if (price > c[1]) c[1] = price;
  if (price < c[2]) c[2] = price;
  c[3] = price;
}

/**
 * Two bucket sets over the same token, e.g. its curve and then its pool.
 * Where both have a bucket, `a` is taken to come first in it.
 */
export function mergeBuckets(a: Buckets, b: Buckets): Buckets {
  const out: Buckets = {};
  for (const [k, c] of Object.entries(a)) out[k] = [...c] as Ohlc;
  for (const [k, c] of Object.entries(b)) {
    const x = out[k];
    out[k] = x ? [x[0], Math.max(x[1], c[1]), Math.min(x[2], c[2]), c[3]] : [...c] as Ohlc;
  }
  return out;
}

/**
 * ETH per whole token from a native-ETH V4 pool's sqrtPriceX96. The token is
 * currency1, so (sqrtP / 2^96)^2 is raw token units per wei.
 */
export function priceFromSqrt(sqrtX96: bigint, decimals: number): number {
  const r = Number(sqrtX96) / 2 ** 96;
  const rawPerWei = r * r;
  return rawPerWei > 0 ? 10 ** (decimals - 18) / rawPerWei : 0;
}

/**
 * ETH per whole token of one curve trade, before the fee: a buy's ETH in less
 * its fee over the tokens out, a sell's ETH out plus its fee over the tokens
 * in. An average over the trade, not the price after it.
 */
export function priceFromCurve(kind: "buy" | "sell", amountIn: bigint, amountOut: bigint, fee: bigint, decimals: number): number {
  const eth = kind === "buy" ? amountIn - fee : amountOut + fee;
  const raw = kind === "buy" ? amountOut : amountIn;
  if (raw <= 0n || eth <= 0n) return 0;
  return (Number(eth) / 1e18) / (Number(raw) / 10 ** decimals);
}

/** A block's time from blocks whose time is known: in between, or carried on at the nearest rate. */
export function timeOf(anchors: [number, number][], block: number): number {
  const a = [...anchors].sort((x, y) => x[0] - y[0]);
  if (a.length === 0) return 0;
  if (a.length === 1) return a[0]![1];
  let i = a.findIndex(([b]) => b >= block);
  if (i === -1) i = a.length - 1;
  if (i === 0) i = 1;
  const [b0, t0] = a[i - 1]!, [b1, t1] = a[i]!;
  if (b1 === b0) return t0;
  return t0 + ((block - b0) * (t1 - t0)) / (b1 - b0);
}

export type Candle = { t0: number; t1: number; o: number; h: number; l: number; c: number };

/**
 * Group buckets into at most `n` candles, each spanning the same number of
 * buckets, from `fromBlock` to `toBlock`. An empty stretch carries the last
 * close as a flat candle, so time reads evenly across the chart.
 */
export function group(b: Buckets, anchors: [number, number][], fromBlock: number, toBlock: number, n: number): Candle[] {
  const first = Math.floor(fromBlock / BUCKET_BLOCKS);
  const last = Math.floor(toBlock / BUCKET_BLOCKS);
  const span = Math.max(1, Math.ceil((last - first + 1) / Math.max(1, n)));
  const out: Candle[] = [];
  let prev: number | null = null;
  for (let s = first; s <= last; s += span) {
    let o: number | null = null, h = -Infinity, l = Infinity, c: number | null = null;
    for (let k = s; k < s + span && k <= last; k++) {
      const x = b[String(k)];
      if (!x) continue;
      if (o === null) o = x[0];
      h = Math.max(h, x[1]);
      l = Math.min(l, x[2]);
      c = x[3];
    }
    const t0 = timeOf(anchors, s * BUCKET_BLOCKS);
    const t1 = timeOf(anchors, Math.min(last + 1, s + span) * BUCKET_BLOCKS);
    if (o === null || c === null) {
      if (prev === null) continue;
      out.push({ t0, t1, o: prev, h: prev, l: prev, c: prev });
    } else {
      // Open where the last candle closed, so a gap between trades shows as a move.
      const open: number = prev ?? o;
      out.push({ t0, t1, o: open, h: Math.max(h, open), l: Math.min(l, open), c });
      prev = c;
    }
  }
  return out;
}

/**
 * `group`, by time instead of block buckets: up to `n` candles from `from` to
 * `to` (ms), from prices at moments. A stretch with no price carries the last
 * close as a flat candle; each candle opens where the last one closed. Before
 * the first price in range, the last price before `from` opens it, if any.
 */
export function groupTimes(points: { at: number; price: number }[], from: number, to: number, n: number): Candle[] {
  const pts = points.filter((p) => p.price > 0).sort((a, b) => a.at - b.at);
  // `to` is inside the range, so the last candle ends just after it.
  const span = Math.max(1, (to + 1 - from) / Math.max(1, n));
  const out: Candle[] = [];
  const before = pts.filter((p) => p.at < from);
  let prev: number | null = before.length ? before[before.length - 1]!.price : null;
  let k = pts.findIndex((p) => p.at >= from);
  if (k === -1) k = pts.length;
  for (let i = 0; i < n; i++) {
    const t0 = from + i * span, t1 = i === n - 1 ? to + 1 : t0 + span;
    const inside: number[] = [];
    while (k < pts.length && pts[k]!.at < t1) inside.push(pts[k++]!.price);
    if (inside.length === 0) {
      if (prev !== null) out.push({ t0, t1, o: prev, h: prev, l: prev, c: prev });
      continue;
    }
    const open = prev ?? inside[0]!;
    const c = inside[inside.length - 1]!;
    out.push({ t0, t1, o: open, h: Math.max(open, ...inside), l: Math.min(open, ...inside), c });
    prev = c;
  }
  return out;
}

/** A change to the running total at a moment: + ETH in, - ETH out. */
export type Flow = { at: number; delta: number };

/**
 * Daily candles of a running total, UTC days, from the first flow's day to the
 * last's. Each day opens where the last closed; its high and low include every
 * step within it. A day with nothing is a flat candle.
 */
export function dailyTotals(flows: Flow[]): Candle[] {
  if (flows.length === 0) return [];
  const DAY = 86_400_000;
  const sorted = [...flows].sort((a, b) => a.at - b.at);
  const firstDay = Math.floor(sorted[0]!.at / DAY);
  const lastDay = Math.floor(sorted[sorted.length - 1]!.at / DAY);
  const out: Candle[] = [];
  let total = 0, i = 0;
  for (let d = firstDay; d <= lastDay; d++) {
    const o = total;
    let h = total, l = total;
    while (i < sorted.length && Math.floor(sorted[i]!.at / DAY) === d) {
      total += sorted[i]!.delta;
      h = Math.max(h, total);
      l = Math.min(l, total);
      i++;
    }
    out.push({ t0: d * DAY, t1: (d + 1) * DAY, o, h, l, c: total });
  }
  return out;
}
