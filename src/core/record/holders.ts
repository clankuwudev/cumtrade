import type { Address, Hex } from "viem";
import type { HolderRow, TradeRow } from "../lib/indexStore.js";
import { attribute, type TxContext } from "../positions/attribution.js";
import { movedLogs, tradeLog } from "../positions/indexLogs.js";
import { clockOf, type TokenReading } from "./tape.js";

/**
 * A token's holders from the chain index, with what each one is and how each
 * has done on it (x25-batch2-token-page.md, X27a). Pure: the index's holders
 * and its reading of the token's trades go in.
 *
 * A holder's buys and sells are the ones the ledger books for that address
 * (`attribute`, as `buildFromIndex` feeds it), so they agree with its
 * `/api/ledger`. A buy is its ETH in, fee included; a sell its ETH out. Gas is
 * not counted: P&L here is before gas (H3). The index has curve trades only,
 * so a graduated token's pool sells are not in `ethOut` yet (H4, X26).
 *
 * Roles are chain facts (E10): `creator`, `launch-block` (first seen in the
 * launch block), `pool` (the V4 PoolManager, once graduated) and `received`
 * (holds the token, with no curve buy of its own). Nothing else is said of
 * an address.
 */

export type Role = "creator" | "launch-block" | "pool" | "received";

/** A holder before its spot value is known. */
export type HolderBase = {
  address: string;
  /** Whole tokens. */
  balance: number;
  /** % of the supply. */
  pct: number;
  /** When it first held the token, unix ms. */
  firstAt: number;
  /** Whole tokens it received in that block. */
  firstIn: number;
  roles: Role[];
  /** ETH into its curve buys of this token, fees included; null for the pool. */
  ethIn: number | null;
  /** ETH out of its curve sells of this token; null for the pool. */
  ethOut: number | null;
};

export type HolderLine = HolderBase & {
  /** Its balance at spot, "est."; null for the pool, or without a price. */
  nowEth: number | null;
  /** ethOut + nowEth − ethIn, before gas; null where nowEth is. */
  pnlEth: number | null;
};

export type HolderSet = {
  /** Whole tokens, as the index has them: minted less burned. */
  supply: number;
  /** Every holder with a balance, less the curve. */
  holders: number;
  /** What the ten largest hold, % of the supply, as the Checker has it. */
  top10Pct: number;
  rows: HolderBase[];
};

const DECIMALS = 18;
const whole = (v: bigint) => Number(v) / 10 ** DECIMALS;
const eth = (v: bigint) => Number(v) / 1e18;

export function holderSet(i: {
  token: string;
  reading: TokenReading;
  holders: HolderRow[];
  supply: bigint;
  poolManager: string;
  limit: number;
  now: number;
}): HolderSet {
  const token = i.token.toLowerCase();
  const pool = i.poolManager.toLowerCase();
  const graduated = i.reading.graduatedBlock !== null;
  const creator = i.reading.launch?.creator.toLowerCase() ?? null;
  const launchBlock = i.reading.launch?.block ?? null;
  const timeAt = clockOf(i.reading, i.now);
  const supply = whole(i.supply);
  const share = (v: bigint) => (i.supply > 0n ? (Number(v) / Number(i.supply)) * 100 : 0);
  const sorted = [...i.holders].sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  // Only a trade naming an address as its caller or recipient can be its
  // (attribution.ts), so each holder is judged on those alone.
  const naming = new Map<string, TradeRow[]>();
  for (const t of i.reading.trades) {
    for (const a of new Set([t.caller.toLowerCase(), t.recipient.toLowerCase()])) {
      if (!naming.has(a)) naming.set(a, []);
      naming.get(a)!.push(t);
    }
  }
  const byTx = new Map<string, TradeRow[]>();
  for (const t of i.reading.trades) {
    if (!byTx.has(t.tx)) byTx.set(t.tx, []);
    byTx.get(t.tx)!.push(t);
  }
  // Who sent each transaction, and the token's Transfers out of its movers.
  // No receipt yet, no context: as in the ledger, a router's buy counts once
  // the receipt names who sent it.
  const ctx = (tx: Hex): TxContext | undefined => {
    const r = i.reading.receipts.get(tx);
    return r ? { from: r.sender as Address, logs: movedLogs(tx, byTx.get(tx) ?? []) } : undefined;
  };

  const rows = sorted.slice(0, i.limit).map((h): HolderBase => {
    const a = h.address.toLowerCase();
    const isPool = graduated && a === pool;
    const mine = isPool ? [] : attribute(a as Address, (naming.get(a) ?? []).map(tradeLog), ctx, () => token as Address);
    const bought = mine.filter((t) => t.kind === "buy");
    const roles: Role[] = [];
    if (creator && a === creator) roles.push("creator");
    if (launchBlock !== null && h.firstBlock === launchBlock) roles.push("launch-block");
    if (isPool) roles.push("pool");
    else if (bought.length === 0) roles.push("received");
    return {
      address: a,
      balance: whole(h.balance),
      pct: share(h.balance),
      firstAt: timeAt(h.firstBlock),
      firstIn: whole(h.firstIn),
      roles,
      ethIn: isPool ? null : eth(bought.reduce((s, t) => s + t.amountIn, 0n)),
      ethOut: isPool ? null : eth(mine.filter((t) => t.kind === "sell").reduce((s, t) => s + t.amountOut, 0n)),
    };
  });

  return {
    supply,
    holders: sorted.length,
    top10Pct: share(sorted.slice(0, 10).reduce((s, h) => s + h.balance, 0n)),
    rows,
  };
}

/**
 * Each holder valued at spot: tokens ÷ tokens-per-ETH, before impact and fees,
 * so "est." wherever it is shown (E9). No price, or the pool: null.
 */
export function withSpot(rows: HolderBase[], tokensPerEth: number | null): HolderLine[] {
  const priced = tokensPerEth !== null && Number.isFinite(tokensPerEth) && tokensPerEth > 0;
  return rows.map((r) => {
    const nowEth = priced && r.ethIn !== null ? r.balance / tokensPerEth! : null;
    return {
      ...r,
      nowEth,
      pnlEth: nowEth === null || r.ethIn === null || r.ethOut === null ? null : r.ethOut + nowEth - r.ethIn,
    };
  });
}
