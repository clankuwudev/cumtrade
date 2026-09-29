import type { Address } from "viem";
import {
  assemble, defaultSources, scanMore,
  type Ledger, type LedgerSources, type Receipt, type Scanned,
} from "./ledger.js";

/**
 * Ledgers by address, kept and brought up to date (public-release B3.3).
 *
 * A cold lookup reads an address's whole history. After that, what the chain
 * has added is only the tail: the index keeps each address's events, receipts
 * and block times, and a later lookup scans from where the last one stopped,
 * fetches receipts and times only for what is new, and replays the whole list
 * in memory, which is cheap. Balances are read again every time, because a
 * transfer moves them without any event the scan looks for.
 *
 *   - A ledger built within `freshMs` and not marked dirty is served as is,
 *     with no request at all.
 *   - Concurrent lookups of one address share one build.
 *   - At most `maxAddresses` addresses are kept, least recently used first out.
 *   - Over `maxTxs` transactions, whole tokens are left out, never parts of one
 *     (ledger.ts, `choose`).
 *
 * Addresses are the map's keys and nothing else: nothing here logs one.
 */

export type IndexOptions = {
  sources?: Partial<LedgerSources>;
  maxAddresses?: number;
  /**
   * Events kept across every address. The address count alone does not bound
   * memory: one busy wallet holds thousands of events. Measured at about
   * 1.3 KB an event with its receipt and time (test:ledgerindex), so the
   * default of 200,000 is about 260 MB at worst.
   */
  maxEvents?: number;
  freshMs?: number;
  maxTxs?: number;
  now?: () => number;
};

type Entry = {
  scanned: Scanned;
  receipts: Map<string, Receipt>;
  times: Map<bigint, bigint>;
  ledger: IndexedLedger | null;
  builtAt: number;
  dirty: boolean;
};

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export type LedgerIndex = ReturnType<typeof createLedgerIndex>;

/** A ledger as the index serves it, with when it was built (ms). */
export type IndexedLedger = Ledger & { builtAt: number };

export function createLedgerIndex(opts: IndexOptions = {}) {
  const src = { ...defaultSources(), ...opts.sources };
  const maxAddresses = opts.maxAddresses ?? num("LEDGER_CACHE_ADDRESSES", 2_000);
  const maxEvents = opts.maxEvents ?? num("LEDGER_CACHE_EVENTS", 200_000);
  const freshMs = opts.freshMs ?? num("LEDGER_FRESH_MS", 30_000);
  const maxTxs = opts.maxTxs ?? num("LEDGER_MAX_TXS", 400);
  const now = opts.now ?? Date.now;

  // A Map iterates in insertion order, so re-inserting on use keeps the least
  // recently used entry first.
  const entries = new Map<string, Entry>();
  const building = new Map<string, Promise<IndexedLedger>>();
  const stats = { hits: 0, builds: 0, evicted: 0 };

  let events = 0;
  const touch = (key: string, e: Entry) => {
    const old = entries.get(key);
    if (old) events -= old.scanned.logs.length;
    entries.delete(key);
    entries.set(key, e);
    events += e.scanned.logs.length;
    // Least recently used first out, but never the one just used.
    while (entries.size > 1 && (entries.size > maxAddresses || events > maxEvents)) {
      const [k, gone] = entries.entries().next().value!;
      entries.delete(k);
      events -= gone.scanned.logs.length;
      stats.evicted++;
    }
  };

  async function build(address: Address, key: string): Promise<IndexedLedger> {
    stats.builds++;
    const prior = entries.get(key);
    const toBlock = await src.history.blockNumber();
    const scanned = prior && prior.scanned.scannedTo >= toBlock
      ? prior.scanned
      : await scanMore(src, address, prior?.scanned ?? null, toBlock);
    const e: Entry = {
      scanned,
      receipts: prior?.receipts ?? new Map(),
      times: prior?.times ?? new Map(),
      ledger: prior?.ledger ?? null,
      builtAt: prior?.builtAt ?? 0,
      dirty: prior?.dirty ?? false,
    };
    try {
      const b = await assemble(src, address, scanned, e, toBlock, { maxTxs });
      e.builtAt = now();
      const ledger = { ...b.ledger, builtAt: e.builtAt };
      e.ledger = ledger;
      e.dirty = false;
      return ledger;
    } finally {
      // Kept even when the build fails part way: the scan, and every receipt
      // and block time that landed. The public node refuses a big lookup a
      // few hundred calls in (docs/rpc-optimization.md), and the next
      // attempt carries on from here instead of starting again.
      touch(key, e);
    }
  }

  return {
    /** The ledger for `address`, from the cache while it is fresh. */
    get(address: Address): Promise<IndexedLedger> {
      const key = address.toLowerCase();
      const e = entries.get(key);
      if (e?.ledger && !e.dirty && now() - e.builtAt < freshMs) {
        stats.hits++;
        touch(key, e);
        return Promise.resolve(e.ledger);
      }
      const running = building.get(key);
      if (running) return running;
      const p = build(address, key).finally(() => building.delete(key));
      building.set(key, p);
      return p;
    },

    /** The next `get` scans the tail even inside the freshness window (B2.4's hook). */
    markDirty(address: Address) {
      const e = entries.get(address.toLowerCase());
      if (e) e.dirty = true;
    },

    size: () => entries.size,
    has: (address: Address) => entries.has(address.toLowerCase()),
    stats: () => ({ ...stats, addresses: entries.size, events }),
  };
}

/** The process's index, which hosted's `/api/ledger` reads (B3.5). */
export const ledgerIndex = createLedgerIndex();
