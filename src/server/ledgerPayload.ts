import type { Address } from "viem";
import { cached } from "../core/lib/cache.js";
import { readState, valueAt, type Valuation } from "../core/positions/valuation.js";
import type { LedgerPosition } from "../core/positions/ledger.js";
import { ledgerIndex, type IndexedLedger } from "../core/positions/ledgerIndex.js";
import { buildFromIndex } from "../core/positions/ledger.js";
import { indexedLedgerInput } from "../core/lib/chainIndex.js";
import { verdict, type Verdict } from "../core/record/verdict.js";
import { unvaluedFields, valuedFields } from "./positionFields.js";

/**
 * Hosted's answer to `GET /api/ledger?address=` (public-release B3.5):
 * positions for any address, rebuilt from the chain (ledgerIndex.ts), with
 * the open ones valued.
 *
 * The fields are self's `/api/positions` fields, derived by the same helper
 * (positionFields.ts), less what only a bot's manager knows: no `peakPct`,
 * `peakValueWei` or `exit`. Nothing here sells, and the page says so (F1.2).
 *
 * Each curve's state is read once and shared by every lookup holding it for
 * 5s, and the reads of one lookup fold into one Multicall3 call.
 *
 * Every position that has sold also gets the track record's call on its sells
 * (p-sell-verdict.md, P1): what the tokens it sold would net today, against
 * what the sells got. There is no best-exit scan here, so never "fumble".
 */

type Valued = ReturnType<typeof valuedFields> | ReturnType<typeof unvaluedFields>;

/** The call on a position's sells (p-sell-verdict.md, D3 and D7). */
type Sells = {
  /** What the tokens sold would net today in one sale, in ETH; null when not sold, unknown or unpriced. */
  soldNowEth: number | null;
  /** "holding" (nothing sold), "paperhand", "good" or "unpriced"; null when the proceeds are unknown. */
  sellVerdict: Exclude<Verdict, "fumble"> | null;
};

export type HostedPosition = Omit<LedgerPosition, "peakValueWei"> & Partial<Valued> & Sells & { valued?: boolean };

export type LedgerResponse = {
  address: Address;
  asOfBlock: string;
  builtAt: number;
  partial: boolean;
  omittedTokens: { token: Address; symbol: string; txs: number }[];
  open: HostedPosition[];
  closed: HostedPosition[];
  totals: {
    /** ETH received from sells the chain shows, over every position counted. */
    realizedEth: number;
    /** What those sells made or lost against the cost of what was sold. */
    realizedPnlEth: number;
    /** What the open positions would net today, where they could be valued. */
    openValueEth: number;
    /** What the open positions cost. */
    openCostEth: number;
    /** Positions left out of the realised figures because their proceeds are unknown. */
    excluded: number;
  };
};

const CURVE_STATE_MS = 5_000;
/** A sold amount's worth today is looking back, so it is read once a minute, not every 5s (D6). */
const SOLD_NOW_MS = 60_000;

/** Every lookup this process has answered, and nothing about whose. */
let lookups = 0;
export const drainLookups = () => {
  const n = lookups;
  lookups = 0;
  return n;
};

/** Value `tokens` of a position's token, from curve state shared across lookups for 5s. */
async function valueTokens(p: LedgerPosition, tokens: bigint): Promise<Valuation> {
  const state = await cached(`ledger:curve-state:${p.curve.toLowerCase()}`, CURVE_STATE_MS, () => readState(p.curve));
  return valueAt(state, tokens, p.token);
}

/** Value one open position: what it holds. */
const valueOne = (p: LedgerPosition) => valueTokens(p, BigInt(p.tokens));

/**
 * What the tokens a position sold would net today, in ETH, the way an open
 * position is valued (D3): the curve's exact sale, or the V4 pool's once
 * graduated. Kept a minute per curve and amount (D6); a failure is not kept.
 */
export const soldNowOne = (p: LedgerPosition) =>
  cached(`ledger:sold-now:${p.curve.toLowerCase()}:${p.soldTokens}`, SOLD_NOW_MS,
    async () => Number((await valueTokens(p, BigInt(p.soldTokens))).netWei) / 1e18);

/** Whether a position has sold anything whose proceeds the chain shows. */
export const judged = (p: LedgerPosition) => BigInt(p.soldTokens) > 0n && p.confidence !== "proceeds-unknown";

/** The call on a position's sells, from what they got and what the same tokens would net now. */
export function sells(p: LedgerPosition, now: PromiseSettledResult<number> | undefined): Sells {
  if (p.confidence === "proceeds-unknown") return { soldNowEth: null, sellVerdict: null };
  if (BigInt(p.soldTokens) === 0n) return { soldNowEth: null, sellVerdict: "holding" };
  const soldNowEth = now && now.status === "fulfilled" ? now.value : null;
  const v = verdict({ sold: true, back: Number(BigInt(p.realizedWei)) / 1e18, soldNow: soldNowEth, best: null });
  // With no best exit there is no fumble; the type says so too.
  return { soldNowEth, sellVerdict: v === "fumble" ? "good" : v };
}

const strip = ({ peakValueWei: _peak, ...p }: LedgerPosition) => p;

/**
 * Shape a ledger for the page. Valuation is injected so tests need no chain:
 * `value` values an open position's holding, `soldNow` what a position sold.
 */
export async function shapeLedger(
  l: IndexedLedger,
  value: (p: LedgerPosition) => Promise<Valuation> = valueOne,
  soldNow: (p: LedgerPosition) => Promise<number> = soldNowOne,
): Promise<LedgerResponse> {
  const openPs = l.positions.filter((p) => !p.closed);
  const closedPs = l.positions.filter((p) => p.closed);

  // Started together, so every curve read of this lookup folds into one call.
  const soldPs = l.positions.filter(judged);
  const [valuations, soldNows] = await Promise.all([
    Promise.allSettled(openPs.map(value)),
    Promise.allSettled(soldPs.map(soldNow)),
  ]);
  const nowOf = new Map(soldPs.map((p, i) => [p, soldNows[i]!]));
  const open: HostedPosition[] = openPs.map((p, i) => {
    const v = valuations[i]!;
    return v.status === "fulfilled"
      ? { ...strip(p), ...valuedFields(p, v.value), valued: true, ...sells(p, nowOf.get(p)) }
      : { ...strip(p), ...unvaluedFields(p), valued: false, ...sells(p, nowOf.get(p)) };
  });
  const closed: HostedPosition[] = closedPs.map((p) => ({ ...strip(p), ...sells(p, nowOf.get(p)) }));

  // A number that includes a guess reads exactly like one that does not, so
  // positions whose proceeds are unknown are left out of the realised totals
  // and counted instead.
  const counted = l.positions.filter((p) => p.confidence !== "proceeds-unknown");
  const eth = (v: bigint) => Number(v) / 1e18;
  const sum = (ps: LedgerPosition[], f: (p: LedgerPosition) => bigint) => ps.reduce((a, p) => a + f(p), 0n);

  return {
    address: l.address,
    asOfBlock: l.toBlock.toString(),
    builtAt: l.builtAt,
    partial: l.partial,
    omittedTokens: l.omittedTokens,
    open,
    closed,
    totals: {
      realizedEth: eth(sum(counted, (p) => BigInt(p.realizedWei))),
      realizedPnlEth: eth(sum(counted, (p) => BigInt(p.realizedWei) - BigInt(p.realizedCostWei))),
      openValueEth: open.reduce((a, p) => a + (p.valued ? p.nowEth ?? 0 : 0), 0),
      openCostEth: eth(sum(openPs, (p) => BigInt(p.costEth))),
      excluded: l.positions.length - counted.length,
    },
  };
}

/**
 * The ledger for `address`, from the process's index, shaped for the page.
 * `fresh`: the page saw this address trade, so the index reads the newest
 * blocks first instead of answering from its cache (D1.0).
 */
export async function ledgerPayload(address: Address, opts: { fresh?: boolean } = {}): Promise<LedgerResponse> {
  lookups++;
  // From the chain index (D1.4): every trade naming the address is in it
  // already, so a lookup reads no log, a new address included, and it is
  // always as fresh as the follower's cursor.
  const ix = indexedLedgerInput(address);
  if (ix) {
    const b = await buildFromIndex(address, ix, { maxTxs: MAX_TXS });
    return shapeLedger({ ...b.ledger, builtAt: Date.now() });
  }
  // No index in this process: the per-address scans, kept as they were.
  if (opts.fresh) ledgerIndex.markDirty(address);
  return shapeLedger(await ledgerIndex.get(address));
}

/** Transactions a ledger is built from at most; whole tokens past it are left out (B3.3). */
export const MAX_TXS = (() => {
  const v = Number(process.env.LEDGER_MAX_TXS);
  return Number.isFinite(v) && v > 0 ? v : 400;
})();
