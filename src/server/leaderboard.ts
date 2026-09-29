import { isAddress, type Address } from "viem";
import { indexedLaunches, indexedLedgerInput, indexedTraders, onIndexCommit } from "../core/lib/chainIndex.js";
import {
  buildFromIndex, type CurveMeta, type IndexedInput, type LedgerPosition, type LedgerSources,
} from "../core/positions/ledger.js";
import {
  DEFAULT_WINDOW, MIN_CLOSED, WINDOWS, leaders, type Ranked, type TraderLedger, type Window,
} from "../core/record/leaders.js";
import { MAX_TXS, judged, sells, soldNowOne } from "./ledgerPayload.js";

/**
 * The process's leaderboard (x29-leaderboard.md, X29a): every trading
 * address's ledger from the chain index, ranked per window.
 *
 *   - Every ledger is `buildFromIndex`'s, as `/api/ledger` builds it, with
 *     the same transaction cap. The curves come from the index's launches
 *     and the history fetches nothing, so a rebuild spends no RPC. A trade
 *     whose receipt is not in yet waits for the next rebuild.
 *   - A commit marks the board stale. It is rebuilt when asked, at most once
 *     a minute (`everyMs`), and asks during a rebuild share it.
 *   - The paperhand rate (L6) is worked out for the rows a page can show
 *     only, at most 100 a window, with the Portfolio's own valuation and
 *     caches, so a trader's rate agrees with their own "Your sell" calls.
 *   - `LEADERS_EXCLUDE` (L7): the operator's wallets and the opt-outs, one
 *     list, never published. Nothing here logs an address.
 */

/** At most this many rows a page, and the rows the paperhand rate is worked out for. */
export const MAX_ROWS = 100;
/** A rebuild over this is logged as over its target (the pre-check took 244 ms). */
const SLOW_MS = 2_000;

export type LeaderRow = {
  rank: number;
  address: string;
  realizedPnlEth: number;
  realizedEth: number;
  costEth: number;
  gasEth: number;
  closed: number;
  wins: number;
  winRate: number;
  unknownProceeds: number;
  paperhandRate: number | null;
  paperhandOf: number;
  lastClosedAt: number;
};

type WindowBoard = { traders: number; eligible: number; rows: LeaderRow[]; rankOf: Map<string, number>; closedOf: Map<string, number> };

export type Board = {
  asOfBlock: string;
  builtAt: number;
  windows: Record<Window, WindowBoard>;
  /** For the log and the tests: what the rebuild did. */
  stats: { ledgers: number; ledgerMs: number; valueMs: number; valued: number; unfetched: number };
};

export type LeaderboardDeps = {
  /** Every trading address at the index's cursor, or null with no index. */
  traders: () => { toBlock: bigint; traders: string[] } | null;
  ledgerOf: (address: string) => IndexedInput | null;
  /** Each curve's token, from the index's launches. */
  launches: () => { token: string; curve: string }[];
  /** What a position's sold tokens would net now, in ETH (ledgerPayload.ts). */
  soldNow: (p: LedgerPosition) => Promise<number>;
  exclude: ReadonlySet<string>;
  maxTxs?: number;
  everyMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

/** `LEADERS_EXCLUDE`: addresses, split on commas or spaces, lowercased. Anything else is dropped, and counted. */
export function parseExclude(raw: string | undefined, log: (line: string) => void = console.log): Set<string> {
  const parts = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  const good = parts.filter((a) => isAddress(a, { strict: false }));
  if (good.length < parts.length) log(`[leaders] LEADERS_EXCLUDE: ${parts.length - good.length} entr(ies) are not addresses, ignored`);
  return new Set(good.map((a) => a.toLowerCase()));
}

const eth = (wei: bigint) => Number(wei) / 1e18;

export type Leaderboard = ReturnType<typeof createLeaderboard>;

export function createLeaderboard(deps: LeaderboardDeps) {
  const everyMs = deps.everyMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const maxTxs = deps.maxTxs ?? MAX_TXS;
  /** A board this old is still answered from while the next one builds. */
  const SERVE_OLD_MS = 5 * everyMs;
  let board: Board | null = null;
  let stale = true;
  let building: Promise<Board | null> | null = null;
  let rebuilds = 0;

  async function rebuild(): Promise<Board | null> {
    const at = deps.traders();
    if (!at) return null;
    rebuilds++;
    const t0 = now();
    const started = performance.now();
    stale = false;

    // The index's own launches say which contracts are curves: they come from
    // the factory's Launch events, as `resolveCurves` would read them. The
    // symbol is not shown anywhere here.
    const curveMap = new Map<string, CurveMeta>(deps.launches().map((l) => [
      l.curve.toLowerCase(), { token: l.token as Address, symbol: "" },
    ]));
    let unfetched = 0;
    const toBlock = at.toBlock;
    const sources: Partial<LedgerSources> = {
      curves: async (cs) => new Map(cs.flatMap((c) => {
        const m = curveMap.get(c.toLowerCase());
        return m ? [[c.toLowerCase(), m] as const] : [];
      })),
      history: {
        blockNumber: async () => toBlock,
        logs: async () => [],
        receipts: async (hashes: readonly unknown[]) => { unfetched += hashes.length; return new Map(); },
        blockTimes: async (blocks: readonly unknown[]) => { unfetched += blocks.length; return new Map(); },
      } as unknown as LedgerSources["history"],
    };

    const ledgers: TraderLedger[] = [];
    for (const address of at.traders) {
      const ix = deps.ledgerOf(address);
      if (!ix) continue;
      const b = await buildFromIndex(address as Address, ix, { maxTxs, sources });
      ledgers.push({ address, positions: b.ledger.positions });
    }
    const ledgerMs = performance.now() - started;

    const standings = Object.fromEntries(WINDOWS.map((w) => [w, leaders(ledgers, w, t0, { exclude: deps.exclude })])) as
      Record<Window, ReturnType<typeof leaders>>;

    // L6: the rows a page can show, each window's first 100, valued together
    // so the curve reads fold into one multicall.
    const valuing = performance.now();
    const shown = new Set<LedgerPosition>();
    for (const w of WINDOWS) for (const r of standings[w].ranked.slice(0, MAX_ROWS)) for (const p of r.positions) if (judged(p)) shown.add(p);
    const list = [...shown];
    const settled = await Promise.allSettled(list.map(deps.soldNow));
    const callOf = new Map(list.map((p, i) => [p, sells(p, settled[i])]));
    const valueMs = performance.now() - valuing;

    const rowOf = (r: Ranked): LeaderRow => {
      let valued = 0, paper = 0;
      for (const p of r.positions) {
        const v = callOf.get(p)?.sellVerdict;
        if (v === "paperhand" || v === "good") valued++;
        if (v === "paperhand") paper++;
      }
      return {
        rank: r.rank, address: r.address,
        realizedPnlEth: eth(r.pnlWei), realizedEth: eth(r.realizedWei), costEth: eth(r.costWei), gasEth: eth(r.gasWei),
        closed: r.closed, wins: r.wins, winRate: r.closed > 0 ? r.wins / r.closed : 0,
        unknownProceeds: r.unknownProceeds,
        paperhandRate: valued > 0 ? paper / valued : null, paperhandOf: valued,
        lastClosedAt: r.lastClosedAt,
      };
    };
    const windows = Object.fromEntries(WINDOWS.map((w) => {
      const s = standings[w];
      return [w, {
        traders: s.traders, eligible: s.ranked.length,
        rows: s.ranked.slice(0, MAX_ROWS).map(rowOf),
        rankOf: new Map(s.ranked.map((r) => [r.address, r.rank])),
        closedOf: s.closedOf,
      }];
    })) as Record<Window, WindowBoard>;

    const stats = { ledgers: ledgers.length, ledgerMs: Math.round(ledgerMs), valueMs: Math.round(valueMs), valued: list.length, unfetched };
    const total = stats.ledgerMs + stats.valueMs;
    log(`[leaders] rebuilt ${stats.ledgers} ledgers at block ${toBlock} in ${stats.ledgerMs} ms, `
      + `${stats.valued} sells valued in ${stats.valueMs} ms; ${unfetched} receipt(s) or time(s) not in the index yet`
      + (total > SLOW_MS ? ` (over the ${SLOW_MS} ms target; still at most once a minute)` : ""));
    return { asOfBlock: toBlock.toString(), builtAt: t0, windows, stats };
  }

  /**
   * The board. When it is stale and a minute old, the next one is started,
   * and this ask is answered from the board in hand while that is under five
   * minutes old, so a steady reader never waits (a cold rebuild values ~400
   * sells, about 2 s). After a quiet spell, the ask waits for the new one
   * rather than show a board long out of date.
   */
  async function get(): Promise<Board | null> {
    if (board && (!stale || now() - board.builtAt < everyMs)) return board;
    if (!building) {
      building = rebuild()
        .then((b) => (b ? (board = b) : board))
        .catch((e) => {
          stale = true;
          log(`[leaders] rebuild failed: ${(e as Error).message}`);
          if (board) return board;
          throw e;
        })
        .finally(() => { building = null; });
    }
    return board && now() - board.builtAt < SERVE_OLD_MS ? board : building;
  }

  return {
    get,
    /** A commit moved the index: the next ask after the minute rebuilds. */
    markStale() { stale = true; },

    /** One window's page. */
    async page(window: Window, limit: number) {
      const b = await get();
      if (!b) return null;
      const w = b.windows[window];
      return {
        window, asOfBlock: b.asOfBlock, builtAt: b.builtAt, traders: w.traders, eligible: w.eligible,
        minClosed: MIN_CLOSED, pnl: "after fees, before gas" as const, rows: w.rows.slice(0, limit),
      };
    },

    /**
     * One address's standing in each window, for its Portfolio. An excluded
     * address answers as one with no rank, and nothing more is said.
     */
    async standing(address: string) {
      const b = await get();
      if (!b) return null;
      const a = address.toLowerCase();
      const hidden = deps.exclude.has(a);
      return {
        address: a, asOfBlock: b.asOfBlock, builtAt: b.builtAt,
        windows: WINDOWS.map((w) => ({
          window: w,
          rank: hidden ? null : b.windows[w].rankOf.get(a) ?? null,
          closed: hidden ? null : b.windows[w].closedOf.get(a) ?? 0,
          minClosed: MIN_CLOSED,
        })),
      };
    },

    rebuilds: () => rebuilds,
  };
}

export { DEFAULT_WINDOW, WINDOWS };

/** The process's leaderboard, read from the chain index. */
export const leaderboard = createLeaderboard({
  traders: indexedTraders,
  ledgerOf: indexedLedgerInput,
  launches: indexedLaunches,
  soldNow: soldNowOne,
  exclude: parseExclude(process.env.LEADERS_EXCLUDE),
});

onIndexCommit(() => leaderboard.markStale());
