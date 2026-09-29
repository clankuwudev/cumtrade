import type { LedgerPosition } from "../positions/ledger.js";

/**
 * The profitability leaderboard (x29-leaderboard.md, X29a): who has realised
 * the most on this venue's curves, from each address's own ledger. Pure: the
 * ledgers come in built, and nothing here reads the chain.
 *
 *   - What is ranked is realised P&L of closed positions, after fees and
 *     before gas (L3): exactly `/api/ledger`'s `realizedWei − realizedCostWei`
 *     for those positions. Open positions do not count until they close.
 *   - A position counts in the window in which it closed, its whole round
 *     trip there (L5).
 *   - Positions whose proceeds are unknown are left out of the P&L and the
 *     floor, and counted (as `/api/ledger`'s `excluded`).
 *   - An address needs `minClosed` closed positions in the window to be
 *     ranked (L4).
 *   - Excluded addresses (L7) are removed before anything is counted, and
 *     the ranks close up. Nothing in the result names them.
 */

export type Window = "7d" | "30d" | "all";
export const WINDOWS: readonly Window[] = ["7d", "30d", "all"];
export const DEFAULT_WINDOW: Window = "7d";
/** L4: closed positions in the window an address needs to be ranked. */
export const MIN_CLOSED = 5;

const DAY_MS = 86_400_000;
const SPAN_MS: Record<Window, number> = { "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, all: Infinity };

/** An address and its ledger's positions, as `buildFromIndex` gives them. */
export type TraderLedger = { address: string; positions: LedgerPosition[] };

/** One address's figures in one window, before ranking. */
export type Tally = {
  address: string;
  /** Wei, exact, for ranking. */
  pnlWei: bigint;
  realizedWei: bigint;
  costWei: bigint;
  gasWei: bigint;
  closed: number;
  wins: number;
  unknownProceeds: number;
  /** Unix ms, 0 when nothing closed in the window. */
  lastClosedAt: number;
  /** The closed positions counted, for the paperhand rate (L6). */
  positions: LedgerPosition[];
};

export type Ranked = Tally & { rank: number };

export type Standing = {
  /** Addresses with a position opened or closed in the window. */
  traders: number;
  /** Every address at or over the floor, ranked, best first. */
  ranked: Ranked[];
  /** Closed positions in the window, for every address that has a ledger. */
  closedOf: Map<string, number>;
};

/** Whether `at` (unix ms) falls in `window`, counted back from `now`. */
export const inWindow = (at: number, window: Window, now: number) => at > 0 && now - at <= SPAN_MS[window];

/**
 * One address's closed positions in the window, tallied. A close with no time
 * yet (its block's time is not in the index) waits for the next rebuild, as a
 * trade with no receipt does in `/api/holders`.
 */
export function tally(l: TraderLedger, window: Window, now: number): Tally & { touched: boolean } {
  const t: Tally = {
    address: l.address.toLowerCase(), pnlWei: 0n, realizedWei: 0n, costWei: 0n, gasWei: 0n,
    closed: 0, wins: 0, unknownProceeds: 0, lastClosedAt: 0, positions: [],
  };
  let touched = false;
  for (const p of l.positions) {
    if (inWindow(p.openedAt, window, now)) touched = true;
    if (!p.closed || !inWindow(p.closed.at, window, now)) continue;
    touched = true;
    if (p.confidence === "proceeds-unknown") {
      t.unknownProceeds++;
      continue;
    }
    const pnl = BigInt(p.realizedWei) - BigInt(p.realizedCostWei);
    t.pnlWei += pnl;
    t.realizedWei += BigInt(p.realizedWei);
    t.costWei += BigInt(p.realizedCostWei);
    t.gasWei += BigInt(p.gasWei);
    t.closed++;
    if (pnl > 0n) t.wins++;
    if (p.closed.at > t.lastClosedAt) t.lastClosedAt = p.closed.at;
    t.positions.push(p);
  }
  return { ...t, touched };
}

/** By realised P&L, then more closed positions, then the earlier last close; the address last, so the order is fixed. */
export function byRank(a: Tally, b: Tally): number {
  if (a.pnlWei !== b.pnlWei) return a.pnlWei > b.pnlWei ? -1 : 1;
  if (a.closed !== b.closed) return b.closed - a.closed;
  if (a.lastClosedAt !== b.lastClosedAt) return a.lastClosedAt - b.lastClosedAt;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/** The leaderboard for one window. `exclude` holds lowercased addresses. */
export function leaders(
  ledgers: TraderLedger[], window: Window, now: number,
  opts: { minClosed?: number; exclude?: ReadonlySet<string> } = {},
): Standing {
  const minClosed = opts.minClosed ?? MIN_CLOSED;
  const exclude = opts.exclude ?? new Set<string>();
  let traders = 0;
  const closedOf = new Map<string, number>();
  const eligible: Tally[] = [];
  for (const l of ledgers) {
    const address = l.address.toLowerCase();
    if (exclude.has(address)) continue;
    const { touched, ...t } = tally(l, window, now);
    if (touched) traders++;
    closedOf.set(address, t.closed);
    if (t.closed >= minClosed) eligible.push(t);
  }
  eligible.sort(byRank);
  return { traders, ranked: eligible.map((t, i) => ({ ...t, rank: i + 1 })), closedOf };
}
