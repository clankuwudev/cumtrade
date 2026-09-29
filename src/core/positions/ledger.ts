import type { Address, Hex } from "viem";
import { client } from "../lib/client.js";
import { FACTORIES, genesisFloor } from "../chain.js";
import { factoryAbi, tokenAbi } from "../abi.js";
import { historyRpc, type HistoryReceipt } from "../lib/historyRpc.js";
import {
  attribute, BUY_TOPIC, logFilters, SELL_TOPIC, TRANSFER_TOPIC, type RawLog, type Trade, type TxContext,
} from "./attribution.js";
import type { ReceiptRow, TradeRow } from "../lib/indexStore.js";
import { movedLogs, tradeLog } from "./indexLogs.js";
import {
  applyAdd, applyGas, applyReduce, applyUpdate, openIndex, type Position, type Source,
} from "./accounting.js";

/**
 * Positions for any address, rebuilt from chain events (public-release B3.2).
 *
 * No file and no database: the curve's Buy and Sell events that name the
 * address, the receipts of their transactions, and the block times, replayed
 * through the same accounting the bot's own store applies
 * (accounting.ts). The backfill CLI is this, plus a merge into the bot's
 * ledger file.
 *
 *   1. scan: every Buy or Sell naming the address (attribution.ts's filters)
 *   2. drop events from anything no listed factory knows as a curve
 *   3. receipts for the remaining transactions, from the public node
 *   4. attribute: which events are really this address's trades
 *   5. block times for those trades
 *   6. replay into a list in memory
 *   7. reconcile every open position against the address's balance
 *
 * Where the chain cannot say what happened, the position says so rather than
 * guessing (`confidence`).
 */

/**
 * How much of a position the chain accounts for.
 *
 *   exact             every leg is a curve event with its receipt
 *   proceeds-unknown  closed because the balance is gone without a sell the
 *                     scan can see: a V4 sell, a plain transfer, or a router
 *                     the attribution rule did not accept
 *   size-adjusted     open, but the balance differs from the replay, so
 *                     `tokens` is the chain's figure while the basis is still
 *                     the replay's
 */
export type Confidence = "exact" | "proceeds-unknown" | "size-adjusted";
export type LedgerPosition = Position & { confidence: Confidence };

export type Ledger = {
  address: Address;
  /** Everything up to and including this block, balances read at it. */
  toBlock: bigint;
  positions: LedgerPosition[];
  /** True when some tokens were left out to stay under the cap (B3.3). */
  partial: boolean;
  /** The tokens left out, whole, with how many transactions each has. */
  omittedTokens: Omitted[];
};

export type CurveMeta = { token: Address; symbol: string };
export type Receipt = TxContext & { gas: bigint };

/** Why an open position was changed by reconciliation, for the backfill's report. */
export type Reconciled = { symbol: string; token: Address; held: bigint; replayed: bigint };

/** The chain, as the ledger reads it. Injected by tests. */
export type LedgerSources = {
  history: Pick<typeof historyRpc, "blockNumber" | "logs" | "receipts" | "blockTimes">;
  /** The token and symbol of each address that is a curve of the factory. Others are absent. */
  curves: (curves: Address[]) => Promise<Map<string, CurveMeta>>;
  /** `owner`'s balance of each token at `block`, by lowercased token. Throws if any read fails. */
  balances: (owner: Address, tokens: Address[], block: bigint) => Promise<Map<string, bigint>>;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: string) => a.toLowerCase();

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

/**
 * Curve → token, from the factory, and the token's symbol. Both are fixed at
 * deploy, so each curve is read once per process.
 *
 * `tokenForCurve` answers the zero address for anything that is not one of the
 * factory's curves. Anyone can deploy a contract that emits an event shaped
 * like a curve's Buy, naming any address as buyer and caller; checked live on
 * 2026-09-22, and the reason a curve is only a curve when the factory says so.
 * A read that fails is thrown, never cached: a curve missing from the map
 * would silently drop that address's trades on it.
 */
export async function resolveCurves(curves: Address[]): Promise<Map<string, CurveMeta>> {
  // Started together, so the factory reads fold into one Multicall3 call and
  // the symbol reads into a second (lib/client.ts).
  const got = await Promise.all(curves.map(curveMeta));
  const map = new Map<string, CurveMeta>();
  curves.forEach((c, i) => {
    const m = got[i];
    if (m) map.set(lower(c), m);
  });
  return map;
}

/** Curves already read, and addresses known not to be curves (null). */
const curveCache = new Map<string, CurveMeta | null>();

async function curveMeta(curve: Address): Promise<CurveMeta | null> {
  const key = lower(curve);
  const hit = curveCache.get(key);
  if (hit !== undefined) return hit;
  // Every listed factory is asked at once, so the reads still fold into one
  // multicall (B1.5). A curve is a curve when one of them says so; the others
  // answer zero for a curve they did not deploy.
  const answers = await Promise.all(FACTORIES.map((f) => client.readContract({
    address: f.address as Address, abi: factoryAbi, functionName: "tokenForCurve", args: [curve],
  }) as Promise<Address>));
  const token = answers.find((t) => lower(t) !== ZERO) ?? (ZERO as Address);
  if (lower(token) === ZERO) {
    curveCache.set(key, null);
    return null;
  }
  // A symbol is presentation. One that cannot be read shows as "?", as in the
  // backfill, and is read again next time rather than remembered that way.
  const symbol = await client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" })
    .then((s) => s as string, () => null);
  const meta = { token, symbol: symbol ?? "?" };
  if (symbol !== null) curveCache.set(key, meta);
  return meta;
}

/**
 * Balances at one block, read concurrently so they fold into one Multicall3
 * call (lib/client.ts), where the backfill used to read them one at a time.
 */
export async function balancesAt(owner: Address, tokens: Address[], block: bigint): Promise<Map<string, bigint>> {
  const got = await Promise.all(tokens.map((t) => client.readContract({
    address: t, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber: block,
  }) as Promise<bigint>));
  return new Map(tokens.map((t, i) => [lower(t), got[i]!]));
}

export const defaultSources = (): LedgerSources => ({
  history: historyRpc, curves: resolveCurves, balances: balancesAt,
});

/** Every Buy or Sell that names `owner` in [from, to], each event once. */
export async function scan(
  history: LedgerSources["history"], owner: Address, from: bigint, to: bigint,
): Promise<RawLog[]> {
  const seen = new Map<string, RawLog>();
  // One filter after the other: each is a run of heavy queries to a node that
  // refuses bursts.
  for (const topics of logFilters(owner)) {
    for (const l of await history.logs(from, to, topics)) {
      seen.set(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`, l as RawLog);
    }
  }
  return [...seen.values()];
}

/**
 * Receipts, keyed by lowercased hash. They carry the gas actually paid, who
 * sent the transaction, and every log in it; the last two are what
 * attribution needs to tell a router trade from a stranger's.
 */
export async function receiptsByTx(
  history: LedgerSources["history"], hashes: Hex[],
): Promise<Map<string, Receipt>> {
  const raw = await history.receipts(hashes);
  const map = new Map<string, Receipt>();
  for (const [h, r] of raw) map.set(h, toReceipt(r));
  return map;
}

export const toReceipt = (r: HistoryReceipt): Receipt => ({
  from: r.from,
  gas: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice),
  logs: r.logs.map((l) => ({
    address: l.address, topics: l.topics, data: l.data,
    transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex,
  })),
});

// ---------------------------------------------------------------------------
// the arithmetic, which touches no chain
// ---------------------------------------------------------------------------

/**
 * Replay trades into a fresh list, oldest first. Gas is booked once per
 * transaction, and only for transactions `owner` sent: a smart-account or
 * relayed trade is paid for by someone else.
 */
export function replay(
  owner: Address, trades: Trade[], meta: Map<string, CurveMeta>,
  receipts: Map<string, Receipt>, times: Map<bigint, bigint>, source: Source,
  onSkip: (t: Trade) => void = () => {},
): Position[] {
  const ledger: Position[] = [];
  const gasBooked = new Set<string>();
  for (const t of trades) {
    const m = meta.get(lower(t.curve));
    if (!m) {
      onSkip(t);
      continue;
    }
    const at = Number((times.get(t.block) ?? 0n) * 1000n);
    if (t.kind === "buy") {
      applyAdd(ledger, {
        token: m.token, curve: t.curve, symbol: m.symbol, source,
        costEth: t.amountIn.toString(),
        tokens: t.amountOut.toString(),
        feeBps: t.amountIn > 0n ? Number((t.fee * 10_000n) / t.amountIn) : 100,
        entryFeeWei: t.fee.toString(),
        snipeTaxWei: t.snipeTax.toString(),
        realizedWei: "0", realizedCostWei: "0", realizedEntryFeeWei: "0",
        exitFeeWei: "0", soldTokens: "0", gasWei: "0",
        openedAt: at, openTx: t.tx, peakValueWei: "0", dryRun: false,
      });
    } else {
      applyReduce(ledger, m.token, source, t.amountIn, t.amountOut, t.fee,
        "sold (reconstructed from chain history)", t.tx, at);
    }
    const tx = lower(t.tx);
    const r = receipts.get(tx);
    if (r && !gasBooked.has(tx) && lower(r.from) === lower(owner)) {
      gasBooked.add(tx);
      applyGas(ledger, m.token, source, r.gas);
    }
  }
  return ledger;
}

/**
 * Hold every open position to the balance the address actually has. A curve
 * Sell is not the only way tokens leave: a graduated token is sold on V4, and
 * a plain transfer moves them with no trade at all.
 *
 * Changes `ledger` in place, and says what it did to each position.
 */
export function reconcile(
  ledger: Position[], held: Map<string, bigint>, source: Source,
  onChange: (r: Reconciled) => void = () => {},
): LedgerPosition[] {
  const confidence = new Map<number, Confidence>();
  for (const p of ledger.filter((q) => !q.closed)) {
    const bal = held.get(lower(p.token));
    if (bal === undefined) continue;
    const i = openIndex(ledger, p.token, source);
    if (bal === 0n) {
      onChange({ symbol: p.symbol, token: p.token, held: bal, replayed: BigInt(p.tokens) });
      applyReduce(ledger, p.token, source, BigInt(p.tokens), 0n, 0n,
        "left the wallet without a curve sell — proceeds unknown", null, p.openedAt);
      confidence.set(i, "proceeds-unknown");
    } else if (bal !== BigInt(p.tokens)) {
      onChange({ symbol: p.symbol, token: p.token, held: bal, replayed: BigInt(p.tokens) });
      applyUpdate(ledger, p.token, source, { tokens: bal.toString() });
      confidence.set(i, "size-adjusted");
    }
  }
  return ledger.map((p, i) => ({ ...p, confidence: confidence.get(i) ?? "exact" }));
}

// ---------------------------------------------------------------------------
// the lookup, in parts the index (ledgerIndex.ts) keeps between builds
// ---------------------------------------------------------------------------

/** An address's events on the factory's curves, scanned up to `scannedTo`. */
export type Scanned = { scannedTo: bigint; logs: RawLog[]; foreign: number };

const eventKey = (l: RawLog) => `${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`;

/**
 * Scan from where `prior` stopped (genesis without one) to `toBlock`, and keep
 * only events from the factory's curves.
 */
export async function scanMore(
  src: LedgerSources, address: Address, prior: Scanned | null, toBlock: bigint,
): Promise<Scanned> {
  const from = prior ? prior.scannedTo + 1n : genesisFloor();
  const fresh = from <= toBlock ? await scan(src.history, address, from, toBlock) : [];
  const meta = fresh.length > 0
    ? await src.curves([...new Set(fresh.map((l) => lower(l.address)))] as Address[])
    : new Map<string, CurveMeta>();
  const kept = fresh.filter((l) => meta.has(lower(l.address)));
  const seen = new Set((prior?.logs ?? []).map(eventKey));
  return {
    scannedTo: toBlock,
    logs: [...(prior?.logs ?? []), ...kept.filter((l) => !seen.has(eventKey(l)))],
    foreign: (prior?.foreign ?? 0) + fresh.length - kept.length,
  };
}

export type Omitted = { token: Address; symbol: string; txs: number };

/**
 * The events to build from, under a cap on unique transactions (B3.3).
 *
 * The cap drops whole tokens, never part of one: a ledger built from
 * truncated history books sells without their buys, which is worse than no
 * answer. Tokens are taken most recently active first while their complete
 * transaction sets fit, and the walk stops at the first that does not, so a
 * recent token is never missing while an older one is shown.
 */
export function choose(
  logs: RawLog[], meta: Map<string, CurveMeta>, maxTxs: number,
): { logs: RawLog[]; omitted: Omitted[] } {
  const all = new Set(logs.map((l) => lower(l.transactionHash)));
  if (all.size <= maxTxs) return { logs, omitted: [] };

  const byToken = new Map<string, { token: Address; symbol: string; txs: Set<string>; last: bigint }>();
  for (const l of logs) {
    const m = meta.get(lower(l.address));
    if (!m) continue;
    const k = lower(m.token);
    const t = byToken.get(k) ?? { token: m.token, symbol: m.symbol, txs: new Set<string>(), last: 0n };
    t.txs.add(lower(l.transactionHash));
    const b = BigInt(l.blockNumber);
    if (b > t.last) t.last = b;
    byToken.set(k, t);
  }
  const newestFirst = [...byToken.values()].sort((a, b) => (a.last === b.last ? 0 : a.last > b.last ? -1 : 1));

  const taken = new Set<string>();
  const chosen = new Set<string>();
  const omitted: Omitted[] = [];
  let full = false;
  for (const t of newestFirst) {
    const more = [...t.txs].filter((x) => !taken.has(x));
    if (!full && taken.size + more.length <= maxTxs) {
      more.forEach((x) => taken.add(x));
      chosen.add(lower(t.token));
    } else {
      full = true;
      omitted.push({ token: t.token, symbol: t.symbol, txs: t.txs.size });
    }
  }
  return {
    logs: logs.filter((l) => chosen.has(lower(meta.get(lower(l.address))?.token ?? ""))),
    omitted,
  };
}

/**
 * The receipt, cut to what the ledger reads: who sent it, the gas paid, and
 * the Transfers out of `owner` (the router-sell evidence in attribution.ts).
 * A receipt can carry dozens of logs, and the index keeps thousands.
 */
export const compact = (owner: Address, r: Receipt): Receipt => {
  const from = `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  return {
    from: r.from, gas: r.gas,
    logs: r.logs.filter((l) => same(l.topics[0], TRANSFER_TOPIC) && same(l.topics[1], from)),
  };
};
const same = (a?: string, b?: string) => !!a && !!b && lower(a) === lower(b);

/** Receipts or blocks fetched before the next lot is asked for. */
const SLICE = 100;

/** What one build saw, for the backfill's report and for tests. */
export type Build = {
  ledger: Ledger;
  /** Events naming the address on the factory's curves. */
  events: number;
  /** Events from contracts that are not the factory's curves, dropped. */
  foreign: number;
  /** The address's own trades, oldest first, in the tokens built. */
  trades: Trade[];
  skipped: Trade[];
  reconciled: Reconciled[];
};

/**
 * The ledger from scanned events: receipts and block times for what is not in
 * `cache` yet, then attribution, replay and reconciliation at `toBlock`.
 * `cache` gains what is fetched.
 */
export async function assemble(
  src: LedgerSources, address: Address, scanned: Scanned,
  cache: { receipts: Map<string, Receipt>; times: Map<bigint, bigint> },
  toBlock: bigint, opts: { maxTxs?: number; source?: Source } = {},
): Promise<Build> {
  const source = opts.source ?? "manual";
  const meta = scanned.logs.length > 0
    ? await src.curves([...new Set(scanned.logs.map((l) => lower(l.address)))] as Address[])
    : new Map<string, CurveMeta>();
  const { logs, omitted } = choose(scanned.logs, meta, opts.maxTxs ?? Infinity);

  // In slices, each kept as it lands. The public node refuses a few hundred
  // calls in, whatever the batching (docs/rpc-optimization.md), so a big
  // lookup is finished by the next attempt rather than started again.
  const missing = [...new Set(logs.map((l) => lower(l.transactionHash)))]
    .filter((tx) => !cache.receipts.has(tx)) as Hex[];
  for (let i = 0; i < missing.length; i += SLICE) {
    for (const [tx, r] of await receiptsByTx(src.history, missing.slice(i, i + SLICE))) {
      cache.receipts.set(tx, compact(address, r));
    }
  }

  // An event naming this address is not necessarily its trade: see
  // attribution.ts for why topic2 alone would book strangers' trades.
  const trades = attribute(address, logs,
    (tx) => cache.receipts.get(lower(tx)),
    (curve) => meta.get(lower(curve))?.token);

  const blocks = [...new Set(trades.map((t) => t.block))].filter((b) => !cache.times.has(b));
  for (let i = 0; i < blocks.length; i += SLICE) {
    for (const [b, t] of await src.history.blockTimes(blocks.slice(i, i + SLICE))) cache.times.set(b, t);
  }

  const skipped: Trade[] = [];
  const list = replay(address, trades, meta, cache.receipts, cache.times, source, (t) => skipped.push(t));

  const open = list.filter((p) => !p.closed).map((p) => p.token);
  const held = open.length > 0 ? await src.balances(address, open, toBlock) : new Map<string, bigint>();
  const reconciled: Reconciled[] = [];
  const positions = reconcile(list, held, source, (r) => reconciled.push(r));

  return {
    ledger: { address, toBlock, positions, partial: omitted.length > 0, omittedTokens: omitted },
    events: scanned.logs.length, foreign: scanned.foreign, trades, skipped, reconciled,
  };
}

/**
 * One build from nothing: the whole history, uncapped. The backfill's path;
 * hosted goes through the index, which keeps what it scanned.
 */
export async function buildLedger(address: Address, opts: {
  toBlock?: bigint; source?: Source; sources?: Partial<LedgerSources>; maxTxs?: number;
} = {}): Promise<Build> {
  const src = { ...defaultSources(), ...opts.sources };
  const toBlock = opts.toBlock ?? await src.history.blockNumber();
  const scanned = await scanMore(src, address, null, toBlock);
  return assemble(src, address, scanned, { receipts: new Map(), times: new Map() }, toBlock,
    { maxTxs: opts.maxTxs, source: opts.source });
}

/** What the chain index holds for one address (indexStore.ts `ledgerOf`), at its cursor. */
export type IndexedInput = {
  toBlock: bigint;
  trades: TradeRow[];
  inTx: Map<string, TradeRow[]>;
  receipts: Map<string, ReceiptRow>;
  balance: (token: string) => bigint;
};

/**
 * The same build, from the chain index instead of a scan (spec D1.4). The
 * index already holds every curve trade naming the address, each trade's
 * receipt and block time, and the address's balances, all at its cursor, so
 * a lookup reads no log. Each trade goes in as the event it was read from,
 * and each receipt as what `compact` keeps of one: who sent it, the gas, and
 * the Transfers of the traded token out of `address` in that transaction.
 * From there `assemble` does exactly what it does for a scan. A receipt or
 * a block time the index has not fetched yet is fetched as a scan's would be.
 */
export async function buildFromIndex(address: Address, ix: IndexedInput, opts: {
  source?: Source; sources?: Partial<LedgerSources>; maxTxs?: number;
} = {}): Promise<Build> {
  const logs: RawLog[] = ix.trades.map(tradeLog);
  const receipts = new Map<string, Receipt>();
  const times = new Map<bigint, bigint>();
  for (const [tx, r] of ix.receipts) {
    const moved = movedLogs(tx, ix.inTx.get(tx) ?? []);
    receipts.set(tx, compact(address, { from: r.sender as Address, gas: r.gas, logs: moved }));
    times.set(r.block, r.time);
  }
  const src: LedgerSources = {
    ...defaultSources(), ...opts.sources,
    balances: async (_owner, tokens) => new Map(tokens.map((t) => [lower(t), ix.balance(t)])),
  };
  return assemble(src, address, { scannedTo: ix.toBlock, logs, foreign: 0 }, { receipts, times }, ix.toBlock,
    { maxTxs: opts.maxTxs, source: opts.source });
}

/** Positions for any address, from the chain alone. */
export async function ledgerFor(address: Address, opts: {
  toBlock?: bigint; source?: Source; sources?: Partial<LedgerSources>;
} = {}): Promise<Ledger> {
  return (await buildLedger(address, opts)).ledger;
}
