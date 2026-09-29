import type { Address, Hex } from "viem";

/**
 * Position accounting: the record, and the arithmetic that moves it.
 *
 * Pure functions over an in-memory list. The bot's store (self/positions/
 * store.ts) loads its file, applies one of these under the file lock and
 * writes the result back; a ledger rebuilt from chain history (the backfill,
 * `ledgerFor`) applies the same functions to a list that never touches a file.
 * One implementation of the arithmetic is what makes a rebuilt ledger agree
 * with the recorded one by construction.
 *
 * Each `apply*` changes `all` in place and returns false when it changed
 * nothing, which is the contract the store's `mutate` callback has always had.
 */

/**
 * Who opened it, and therefore who is allowed to close it.
 *
 * The manager auto-sells `auto` positions and only ever *values* `manual` ones.
 * A hand-bought bag disappearing because a trailing stop fired while you were
 * looking at something else is not a feature, so the distinction is stored on
 * the position rather than inferred from whether `openTx` came from the sniper.
 */
export type Source = "auto" | "manual";

export type Position = {
  token: Address;
  curve: Address;
  symbol: string;
  source: Source;
  /**
   * Cost basis of the STILL-OPEN part, in wei — the full `msg.value`, so the
   * entry fee is inside it. Partial sells move a pro-rata slice of this into
   * `realizedCostWei`, which keeps `netWei - costEth` meaningful after one.
   */
  costEth: string;
  /** Tokens still held. Partial sells decrement this. */
  tokens: string;
  /** Curve fee at entry, in bps. Stored because it is per-curve and mutable. */
  feeBps: number;
  /** Entry fee actually charged, from the curve's own `quoteBuy`. */
  entryFeeWei: string;
  /** Snipe tax actually charged at entry. Zero protocol-wide right now. */
  snipeTaxWei: string;
  /** Cumulative ETH received from sells so far. */
  realizedWei: string;
  /** Cost basis attributed to what has already been sold. */
  realizedCostWei: string;
  /**
   * Entry fee and snipe tax attributed to what has already been sold.
   *
   * `entryFeeWei` shrinks pro-rata with the position for the same reason
   * `costEth` does: it has to describe the part still open, or `pnl()`
   * subtracts a whole position's entry fee from half a position's basis and
   * reports a price move that never happened. This is where the other half
   * goes, so the lifetime total is still recoverable.
   */
  realizedEntryFeeWei: string;
  /** Cumulative exit fees paid, from the curve's own `quoteSell`. */
  exitFeeWei: string;
  /** Tokens sold so far, across every partial. */
  soldTokens: string;
  /**
   * Gas actually burned on this position's own transactions, in wei, summed
   * from receipts as they confirm. Excludes the one-off ERC20 approval, which
   * is fired without awaiting and whose hash never reaches the caller.
   */
  gasWei: string;
  openedAt: number;
  openTx: Hex | null;
  /** Best net exit value seen, in wei — drives the trailing stop. */
  peakValueWei: string;
  dryRun: boolean;
  closed?: {
    at: number;
    reason: string;
    proceedsEth: string;
    tokensSold: string;
    tx: Hex | null;
  };
};

/**
 * Fill in fields added after a position file was written.
 *
 * Every pre-existing record is a sniper position with no fee breakdown, and
 * treating one as `manual` would quietly take it out of the manager's hands.
 */
export function migrate(p: Partial<Position>): Position {
  const cost = p.costEth ?? "0";
  const feeBps = p.feeBps ?? 100;
  // A record that was already closed realised its whole basis in one go, so
  // that is where the basis belongs under the new scheme. Without this the
  // closed table reads every historical exit as pure profit against a zero
  // cost, which is the most flattering possible way to be wrong.
  const wasClosed = p.closed !== undefined;
  return {
    source: "auto",
    feeBps,
    // Reconstructed, not observed: these predate the fee being recorded.
    entryFeeWei: ((BigInt(cost) * BigInt(feeBps)) / 10_000n).toString(),
    snipeTaxWei: "0",
    realizedWei: wasClosed ? (p.closed!.proceedsEth ?? "0") : "0",
    realizedCostWei: wasClosed ? cost : "0",
    realizedEntryFeeWei: "0",
    exitFeeWei: "0",
    soldTokens: wasClosed ? (p.closed!.tokensSold ?? "0") : "0",
    gasWei: "0",
    ...p,
  } as Position;
}

export const sameToken = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * At most one open position per (token, source).
 *
 * Keyed on both because the sniper and your own clicks can legitimately be in
 * the same token at once, and they have different owners: merging them would
 * hand a manual bag to the manager, while a flat list would make `update` pick
 * whichever happened to be written first.
 */
export const openIndex = (all: Position[], token: string, source: Source) =>
  all.findIndex((p) => !p.closed && p.source === source && sameToken(p.token, token));

/** The open position in (token, source), or null. */
export function findOpen(all: Position[], token: string, source: Source): Position | null {
  const i = openIndex(all, token, source);
  return i >= 0 ? all[i]! : null;
}

/** Merge `patch` into the open position in (token, source). */
export function applyUpdate(all: Position[], token: Address, source: Source, patch: Partial<Position>) {
  const i = openIndex(all, token, source);
  if (i < 0) return false;
  all[i] = { ...all[i]!, ...patch };
}

/**
 * Add to an open position, or start one.
 *
 * The ONLY way a position is created. There used to be a plain `open()` that
 * pushed a record unconditionally, which quietly bypassed the one-open-record
 * -per-(token, source) invariant that `update`, `reduce` and `addGas` all rely
 * on to find the right row — a duplicate key sends a sell to whichever record
 * happened to be written first. Averaging in rather than stacking also keeps
 * "what did this cost me" answerable with one number after a second buy.
 */
export function applyAdd(all: Position[], p: Position) {
  const i = openIndex(all, p.token, p.source);
  if (i < 0) {
    all.push(p);
    return;
  }
  const prev = all[i]!;
  all[i] = {
    ...prev,
    costEth: (BigInt(prev.costEth) + BigInt(p.costEth)).toString(),
    tokens: (BigInt(prev.tokens) + BigInt(p.tokens)).toString(),
    entryFeeWei: (BigInt(prev.entryFeeWei) + BigInt(p.entryFeeWei)).toString(),
    snipeTaxWei: (BigInt(prev.snipeTaxWei) + BigInt(p.snipeTaxWei)).toString(),
    gasWei: (BigInt(prev.gasWei) + BigInt(p.gasWei)).toString(),
    realizedEntryFeeWei:
      (BigInt(prev.realizedEntryFeeWei) + BigInt(p.realizedEntryFeeWei)).toString(),
    // The newer fee reading wins: it is the one that will apply on the way out.
    feeBps: p.feeBps,
    openTx: p.openTx ?? prev.openTx,
  };
}

/**
 * Book a partial or full exit.
 *
 * Cost basis leaves pro-rata with the tokens, so the remaining `costEth` still
 * describes the remaining `tokens` and a half-sold position does not read as a
 * 50% loss. Selling the last of it closes the record.
 *
 * `at` is when it happened: the store passes now, the backfill the block time.
 */
export function applyReduce(
  all: Position[], token: Address, source: Source,
  sold: bigint, proceeds: bigint, feePaid: bigint, reason: string, tx: Hex | null,
  at: number,
) {
  const i = openIndex(all, token, source);
  if (i < 0) return false;
  const p = all[i]!;

  const held = BigInt(p.tokens);
  const take = sold >= held ? held : sold;
  const share = (v: string) => (held > 0n ? (BigInt(v) * take) / held : 0n);

  // Everything that describes the open part leaves pro-rata with the tokens:
  // the basis, and the entry costs that were paid to acquire them.
  const costOut = share(p.costEth);
  const entryOut = share(p.entryFeeWei);
  const taxOut = share(p.snipeTaxWei);

  const next: Position = {
    ...p,
    tokens: (held - take).toString(),
    costEth: (BigInt(p.costEth) - costOut).toString(),
    entryFeeWei: (BigInt(p.entryFeeWei) - entryOut).toString(),
    snipeTaxWei: (BigInt(p.snipeTaxWei) - taxOut).toString(),
    soldTokens: (BigInt(p.soldTokens) + take).toString(),
    realizedWei: (BigInt(p.realizedWei) + proceeds).toString(),
    realizedCostWei: (BigInt(p.realizedCostWei) + costOut).toString(),
    realizedEntryFeeWei:
      (BigInt(p.realizedEntryFeeWei) + entryOut + taxOut).toString(),
    exitFeeWei: (BigInt(p.exitFeeWei) + feePaid).toString(),
  };

  // Dust is not a position. A sell clamped to `maxSellable` can leave a few
  // wei of tokens behind, and leaving the record open over them would keep an
  // empty card on the board and a slot occupied in the sniper's budget.
  if (BigInt(next.tokens) <= held / 10_000n) {
    next.closed = {
      at, reason,
      proceedsEth: next.realizedWei,
      tokensSold: next.soldTokens,
      tx,
    };
  }
  all[i] = next;
}

/**
 * Add gas from a confirmed receipt.
 *
 * Arrives late and out of band — a sell's receipt usually lands after the
 * position it paid for has already closed — so this falls back to the most
 * recently closed record rather than dropping the cost on the floor.
 */
export function applyGas(all: Position[], token: Address, source: Source, wei: bigint) {
  if (wei <= 0n) return false;
  let i = openIndex(all, token, source);
  if (i < 0) {
    let latest = -1;
    all.forEach((p, k) => {
      if (p.source !== source || !sameToken(p.token, token) || !p.closed) return;
      if (latest < 0 || p.closed.at > all[latest]!.closed!.at) latest = k;
    });
    i = latest;
  }
  if (i < 0) return false;
  all[i] = { ...all[i]!, gasWei: (BigInt(all[i]!.gasWei) + wei).toString() };
}
