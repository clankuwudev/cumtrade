import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The chain index on disk (spec D1): what the follower has read, so a restart
 * resumes where it stopped instead of scanning the venue's history again.
 *
 * SQLite through Node's built-in `node:sqlite`: no package and no native
 * module, so a release still carries no `.node` file. Node 22 prints one
 * "experimental" warning for it. Everything here is synchronous; a round's
 * writes are one transaction of at most a few thousand rows.
 *
 * The file names the venue it indexes (`meta.venue`, the venue's key and its
 * factories). A file for another venue or factory list, one SQLite cannot
 * open or check, or one written by a newer schema is moved aside as
 * `<path>.bad-<time>` and a fresh one is started: the index can always be
 * rebuilt from the chain, and a process that will not start is worse.
 */

/** One launch, as the factory's Launch event gave it. */
export type LaunchRow = {
  token: string; curve: string; creator: string; factory: string;
  block: bigint; logIndex: number; threshold: bigint;
};

/** One Transfer of one of our tokens: the log's address, the two topics, the amount. */
export type TransferRow = { token: string; from: string; to: string; value: bigint; block: bigint };

/**
 * A wallet's holding, replayed from Transfers (D1.2). `firstIn` is what it
 * received in the block it first appears in, as analyze.ts's replay has it.
 */
export type HolderRow = { address: string; balance: bigint; firstBlock: bigint; firstIn: bigint };

/**
 * A V4 pool created for one of our tokens, from the PoolManager's Initialize
 * event (D1.3). Anyone can initialise a pool for any token, so every one seen
 * in a graduation's block is kept and the reader picks the factory's hook.
 */
export type PoolRow = {
  poolId: string; token: string; currency0: string; currency1: string;
  fee: number; tickSpacing: number; hooks: string; block: bigint;
};

/**
 * One Buy or Sell on a curve (D1.4), as its event gave it. `movers` are the
 * addresses that sent the token in the same transaction: what tells a router
 * sell from a stranger's (positions/attribution.ts).
 */
export type TradeRow = {
  tx: string; logIndex: number; block: bigint; curve: string; token: string; kind: "buy" | "sell";
  caller: string; recipient: string; amountIn: bigint; amountOut: bigint; fee: bigint; snipeTax: bigint;
  movers: string[];
};

/** Who sent a trade's transaction, what its gas cost, and its block's time (seconds). */
export type ReceiptRow = { tx: string; sender: string; gas: bigint; block: bigint; time: bigint };

/** A token whose history is not read up to the cursor yet, its curve, and where to carry on. */
export type PendingToken = { token: string; curve: string; launchBlock: bigint; from: bigint };

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The schema, one entry per version. A file at version n runs entries n..end,
 * each in its own transaction with the version bump.
 */
const MIGRATIONS: string[] = [
  // 1 (D1.1): the cursor and the launches.
  `CREATE TABLE cursor (name TEXT PRIMARY KEY, block INTEGER NOT NULL);
   CREATE TABLE launches (
     token TEXT PRIMARY KEY, curve TEXT NOT NULL, creator TEXT NOT NULL, factory TEXT NOT NULL,
     block INTEGER NOT NULL, log_index INTEGER NOT NULL, threshold TEXT NOT NULL
   );
   CREATE INDEX launches_creator ON launches (creator);
   CREATE INDEX launches_block ON launches (block, log_index);`,
  // 2 (D1.2): holders, replayed from each token's Transfers. `synced_to` is
  // the last block a token's Transfers are folded in for (null: none yet);
  // `supply` is what was minted less what was burned, from the same logs.
  `ALTER TABLE launches ADD COLUMN synced_to INTEGER;
   ALTER TABLE launches ADD COLUMN supply TEXT NOT NULL DEFAULT '0';
   CREATE TABLE holders (
     token TEXT NOT NULL, address TEXT NOT NULL, balance TEXT NOT NULL,
     first_block INTEGER NOT NULL, first_in TEXT NOT NULL,
     PRIMARY KEY (token, address)
   ) WITHOUT ROWID;`,
  // 3 (D1.3): each graduated token's V4 pool key, read once.
  `CREATE TABLE pools (
     pool_id TEXT PRIMARY KEY, token TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL,
     fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL, hooks TEXT NOT NULL, block INTEGER NOT NULL
   );
   CREATE INDEX pools_token ON pools (token);`,
  // 4 (D1.4): curve trades and their receipts, for ledgers. A token's trades
  // are read with its Transfers, from its launch, so every token is read
  // again: its holders are rebuilt on the way.
  `CREATE TABLE trades (
     tx TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, curve TEXT NOT NULL, token TEXT NOT NULL,
     kind TEXT NOT NULL, caller TEXT NOT NULL, recipient TEXT NOT NULL,
     amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, fee TEXT NOT NULL, snipe_tax TEXT NOT NULL,
     movers TEXT NOT NULL,
     PRIMARY KEY (tx, log_index)
   ) WITHOUT ROWID;
   CREATE INDEX trades_caller ON trades (caller);
   CREATE INDEX trades_recipient ON trades (recipient);
   CREATE TABLE receipts (
     tx TEXT PRIMARY KEY, sender TEXT NOT NULL, gas TEXT NOT NULL, block INTEGER NOT NULL, time INTEGER NOT NULL
   ) WITHOUT ROWID;
   DELETE FROM holders;
   UPDATE launches SET synced_to = NULL, supply = '0';`,
  // 5 (p-sell-verdict.md P4a; X25's index): a token's trades in order, for
  // its replay's candles, without reading the whole table. Only an index.
  `CREATE INDEX trades_token ON trades (token, block);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Run SQL with no result: statements, pragmas, transactions. */
const runSql = (db: DatabaseSync, sql: string) => db["exec"](sql);

/** Run `fn` in one write transaction. */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  runSql(db, "BEGIN IMMEDIATE");
  try {
    const out = fn();
    runSql(db, "COMMIT");
    return out;
  } catch (e) {
    runSql(db, "ROLLBACK");
    throw e;
  }
}

export type IndexStore = ReturnType<typeof openIndexStore>;

export function openIndexStore(path: string, opts: { venue: string; log?: (line: string) => void }) {
  const log = opts.log ?? ((l: string) => console.warn(l));
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  let db: DatabaseSync;
  try {
    db = open(path, opts.venue);
  } catch (e) {
    // Another process holding the file is not a broken file: moving it aside
    // would pull it out from under that process. Two processes must not
    // share one INDEX_DB (spec D1, decision 9).
    if (path === ":memory:" || /database is locked|busy/i.test((e as Error).message)) throw e;
    const aside = `${path}.bad-${Date.now()}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix);
    }
    log(`[index] ${path} moved aside to ${aside} and rebuilt: ${(e as Error).message}`);
    db = open(path, opts.venue);
  }

  const stmt = {
    cursor: db.prepare("SELECT block FROM cursor WHERE name = ?"),
    setCursor: db.prepare(
      "INSERT INTO cursor (name, block) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET block = excluded.block"),
    addLaunch: db.prepare(
      `INSERT OR IGNORE INTO launches (token, curve, creator, factory, block, log_index, threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    launches: db.prepare(
      "SELECT token, curve, creator, factory, block, log_index, threshold FROM launches ORDER BY block, log_index"),
    count: db.prepare("SELECT count(*) AS n FROM launches"),
    launch: db.prepare("SELECT curve, creator, block, synced_to, supply FROM launches WHERE token = ?"),
    setSynced: db.prepare("UPDATE launches SET synced_to = ? WHERE token = ? AND (synced_to IS NULL OR synced_to < ?)"),
    setSupply: db.prepare("UPDATE launches SET supply = ? WHERE token = ?"),
    holder: db.prepare("SELECT balance, first_block, first_in FROM holders WHERE token = ? AND address = ?"),
    putHolder: db.prepare(
      `INSERT INTO holders (token, address, balance, first_block, first_in) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token, address) DO UPDATE SET balance = excluded.balance, first_in = excluded.first_in`),
    holders: db.prepare("SELECT address, balance, first_block, first_in FROM holders WHERE token = ?"),
    caughtUp: db.prepare("SELECT token, curve FROM launches WHERE synced_to >= ?"),
    pending: db.prepare(
      `SELECT token, curve, block, synced_to FROM launches WHERE coalesce(synced_to, block - 1) < ?
       ORDER BY block DESC, log_index DESC LIMIT ?`),
    addTrade: db.prepare(
      `INSERT OR IGNORE INTO trades (tx, log_index, block, curve, token, kind, caller, recipient,
         amount_in, amount_out, fee, snipe_tax, movers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    tradesOf: db.prepare(
      `SELECT tx, log_index, block, curve, token, kind, caller, recipient, amount_in, amount_out, fee, snipe_tax, movers
       FROM trades WHERE caller = ? OR recipient = ? ORDER BY block, log_index`),
    traders: db.prepare(
      `SELECT a FROM (SELECT caller AS a FROM trades UNION SELECT recipient FROM trades)
       WHERE a NOT IN (SELECT curve FROM launches) ORDER BY a`),
    tradesOfToken: db.prepare(
      `SELECT tx, log_index, block, curve, token, kind, caller, recipient, amount_in, amount_out, fee, snipe_tax, movers
       FROM trades WHERE token = ? ORDER BY block, log_index`),
    receiptsOfToken: db.prepare(
      `SELECT r.tx AS tx, r.sender AS sender, r.gas AS gas, r.block AS block, r.time AS time
       FROM receipts r WHERE r.tx IN (SELECT tx FROM trades WHERE token = ?)`),
    poolBlockOf: db.prepare("SELECT min(block) AS block FROM pools WHERE token = ?"),
    graduatedTokens: db.prepare("SELECT DISTINCT token FROM pools"),
    lastTradeBlocks: db.prepare("SELECT token, max(block) AS block FROM trades GROUP BY token"),
    newestReceipt: db.prepare("SELECT block, time FROM receipts ORDER BY block DESC LIMIT 1"),
    oldestReceipt: db.prepare("SELECT block, time FROM receipts ORDER BY block ASC LIMIT 1"),
    tradesIn: db.prepare(
      `SELECT tx, log_index, block, curve, token, kind, caller, recipient, amount_in, amount_out, fee, snipe_tax, movers
       FROM trades WHERE tx = ?`),
    addReceipt: db.prepare("INSERT OR IGNORE INTO receipts (tx, sender, gas, block, time) VALUES (?, ?, ?, ?, ?)"),
    receipt: db.prepare("SELECT tx, sender, gas, block, time FROM receipts WHERE tx = ?"),
    missingReceipts: db.prepare(
      `SELECT DISTINCT t.tx AS tx, t.block AS block FROM trades t LEFT JOIN receipts r ON r.tx = t.tx
       WHERE r.tx IS NULL ORDER BY t.block DESC LIMIT ?`),
    tradeCount: db.prepare("SELECT count(*) AS n FROM trades"),
    behindCount: db.prepare("SELECT count(*) AS n FROM launches WHERE coalesce(synced_to, block - 1) < ?"),
    creator: db.prepare("SELECT creator FROM launches WHERE token = ?"),
    resetHolders: db.prepare("DELETE FROM holders WHERE token = ?"),
    resetTrades: db.prepare("DELETE FROM trades WHERE token = ?"),
    resetLaunch: db.prepare("UPDATE launches SET synced_to = NULL, supply = '0' WHERE token = ?"),
    receiptCount: db.prepare("SELECT count(*) AS n FROM receipts"),
    holderCount: db.prepare("SELECT count(*) AS n FROM holders"),
    addPool: db.prepare(
      `INSERT OR IGNORE INTO pools (pool_id, token, currency0, currency1, fee, tick_spacing, hooks, block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    pools: db.prepare(
      "SELECT pool_id, token, currency0, currency1, fee, tick_spacing, hooks, block FROM pools WHERE token = ? ORDER BY block"),
    poolCount: db.prepare("SELECT count(*) AS n FROM pools"),
    syncedCount: db.prepare("SELECT count(*) AS n FROM launches WHERE synced_to IS NOT NULL"),
  };

  /**
   * Fold Transfers into holders and supply. A token's logs at or below its
   * `synced_to` are already in and are skipped, so a window read twice
   * changes nothing. Returns the tokens that changed.
   */
  function fold(transfers: TransferRow[]): Set<string> {
    const changed = new Set<string>();
    type Held = { balance: bigint; firstBlock: bigint; firstIn: bigint; dirty: boolean };
    type Tok = { synced: bigint; supply: bigint; held: Map<string, Held> };
    const byToken = new Map<string, Tok | null>();
    const tokenOf = (t: string): Tok | null => {
      if (!byToken.has(t)) {
        const r = stmt.launch.get(t) as { block: number; synced_to: number | null; supply: string } | undefined;
        byToken.set(t, r ? {
          synced: r.synced_to === null ? BigInt(r.block) - 1n : BigInt(r.synced_to),
          supply: BigInt(r.supply), held: new Map(),
        } : null);
      }
      return byToken.get(t)!;
    };
    const holderOf = (t: string, s: Tok, a: string, block: bigint): Held => {
      let h = s.held.get(a);
      if (!h) {
        const r = stmt.holder.get(t, a) as { balance: string; first_block: number; first_in: string } | undefined;
        h = r
          ? { balance: BigInt(r.balance), firstBlock: BigInt(r.first_block), firstIn: BigInt(r.first_in), dirty: false }
          : { balance: 0n, firstBlock: block, firstIn: 0n, dirty: true };
        s.held.set(a, h);
      }
      return h;
    };
    for (const x of transfers) {
      const t = x.token.toLowerCase();
      const s = tokenOf(t);
      if (!s || x.block <= s.synced) continue;
      const from = x.from.toLowerCase(), to = x.to.toLowerCase();
      // Minted from 0x0, burned to it. 0x0 itself is not a holder.
      if (from === ZERO) s.supply += x.value;
      else {
        const h = holderOf(t, s, from, x.block);
        h.balance -= x.value;
        h.dirty = true;
      }
      if (to === ZERO) s.supply -= x.value;
      else {
        const h = holderOf(t, s, to, x.block);
        h.balance += x.value;
        // What it received in the block it first appears in.
        if (h.firstBlock === x.block) h.firstIn += x.value;
        h.dirty = true;
      }
      changed.add(t);
    }
    for (const [t, s] of byToken) {
      if (!s || !changed.has(t)) continue;
      for (const [a, h] of s.held) {
        if (h.dirty) stmt.putHolder.run(t, a, h.balance.toString(), Number(h.firstBlock), h.firstIn.toString());
      }
      stmt.setSupply.run(s.supply.toString(), t);
    }
    return changed;
  }

  let isOpen = true;

  return {
    path,

    /** A cursor's block, or null if it has never been set. */
    cursor(name: string): bigint | null {
      const row = stmt.cursor.get(name) as { block: number } | undefined;
      return row ? BigInt(row.block) : null;
    },

    /**
     * Everything one window of a round learned, as one transaction: a crash
     * leaves the file either before the window or after it, never between.
     *
     *   launches  new ones are added; one already known is left as it is
     *   transfers folded into holders and supply, each token's only past its
     *             `synced_to`
     *   synced    these tokens' Transfers are now in up to `block`
     *   pools     pool keys seen; one already known is left as it is
     *   trades    curve trades, each once by its transaction and log index
     *   cursor    the follower's cursor, moved to `block`
     *
     * So a window read twice changes nothing. Returns how many launches were
     * new, which tokens' holders changed, and the trades not in before.
     */
    commit(w: {
      cursor?: string; block: bigint; launches?: LaunchRow[]; transfers?: TransferRow[]; synced?: string[];
      pools?: PoolRow[]; trades?: TradeRow[];
    }): { added: number; changed: Set<string>; trades: TradeRow[] } {
      return inTransaction(db, () => {
        let added = 0;
        for (const l of w.launches ?? []) {
          const r = stmt.addLaunch.run(
            l.token.toLowerCase(), l.curve.toLowerCase(), l.creator.toLowerCase(), l.factory.toLowerCase(),
            Number(l.block), l.logIndex, l.threshold.toString());
          added += Number(r.changes);
        }
        const changed = fold(w.transfers ?? []);
        for (const t of w.synced ?? []) stmt.setSynced.run(Number(w.block), t.toLowerCase(), Number(w.block));
        const fresh: TradeRow[] = [];
        for (const t of w.trades ?? []) {
          const r = stmt.addTrade.run(t.tx.toLowerCase(), t.logIndex, Number(t.block), t.curve.toLowerCase(), t.token.toLowerCase(),
            t.kind, t.caller.toLowerCase(), t.recipient.toLowerCase(), t.amountIn.toString(), t.amountOut.toString(),
            t.fee.toString(), t.snipeTax.toString(), JSON.stringify(t.movers.map((m) => m.toLowerCase())));
          if (Number(r.changes) > 0) fresh.push(t);
        }
        for (const p of w.pools ?? []) {
          stmt.addPool.run(p.poolId.toLowerCase(), p.token.toLowerCase(), p.currency0.toLowerCase(), p.currency1.toLowerCase(),
            p.fee, p.tickSpacing, p.hooks.toLowerCase(), Number(p.block));
        }
        if (w.cursor) stmt.setCursor.run(w.cursor, Number(w.block));
        return { added, changed, trades: fresh };
      });
    },

    /** Every pool key seen for a token, oldest first. */
    pools(token: string): PoolRow[] {
      return (stmt.pools.all(token.toLowerCase()) as { pool_id: string; token: string; currency0: string; currency1: string;
        fee: number; tick_spacing: number; hooks: string; block: number }[]).map((r) => ({
        poolId: r.pool_id, token: r.token, currency0: r.currency0, currency1: r.currency1,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks, block: BigInt(r.block),
      }));
    },

    /** How many tokens' history is not in up to `block`. */
    behind(block: bigint): number {
      return Number((stmt.behindCount.get(Number(block)) as { n: number }).n);
    },

    /** The wallet that launched a token, or null for one not in the index. */
    creatorOf(token: string): string | null {
      return (stmt.creator.get(token.toLowerCase()) as { creator: string } | undefined)?.creator ?? null;
    },

    /**
     * Forget everything read from a token's history (D1.5): its holders, its
     * trades and its supply. The follower reads it again from its launch,
     * as it catches up any token behind.
     */
    resetToken(token: string) {
      const t = token.toLowerCase();
      inTransaction(db, () => {
        stmt.resetHolders.run(t);
        stmt.resetTrades.run(t);
        stmt.resetLaunch.run(t);
      });
    },

    /** Tokens whose history is in up to `block` or later, with their curves. */
    caughtUp(block: bigint): { token: string; curve: string }[] {
      return stmt.caughtUp.all(Number(block)) as { token: string; curve: string }[];
    },

    /** Receipts to keep: every trade's transaction not kept yet, newest first. */
    missingReceipts(limit: number): { tx: string; block: bigint }[] {
      return (stmt.missingReceipts.all(limit) as { tx: string; block: number }[])
        .map((r) => ({ tx: r.tx, block: BigInt(r.block) }));
    },

    addReceipts(rows: ReceiptRow[]) {
      inTransaction(db, () => {
        for (const r of rows) {
          stmt.addReceipt.run(r.tx.toLowerCase(), r.sender.toLowerCase(), r.gas.toString(), Number(r.block), Number(r.time));
        }
      });
    },

    /**
     * Everything a ledger for `address` reads from the index (D1.4): each
     * trade naming it as caller or recipient, every trade in those
     * transactions (for the other tokens' movers), their receipts where kept,
     * and its balance of any token.
     */
    ledgerOf(address: string) {
      const a = address.toLowerCase();
      type Raw = { tx: string; log_index: number; block: number; curve: string; token: string; kind: string;
        caller: string; recipient: string; amount_in: string; amount_out: string; fee: string; snipe_tax: string; movers: string };
      const toTrade = (r: Raw): TradeRow => ({
        tx: r.tx, logIndex: r.log_index, block: BigInt(r.block), curve: r.curve, token: r.token,
        kind: r.kind as "buy" | "sell", caller: r.caller, recipient: r.recipient,
        amountIn: BigInt(r.amount_in), amountOut: BigInt(r.amount_out), fee: BigInt(r.fee), snipeTax: BigInt(r.snipe_tax),
        movers: JSON.parse(r.movers) as string[],
      });
      const trades = (stmt.tradesOf.all(a, a) as Raw[]).map(toTrade);
      const txs = [...new Set(trades.map((t) => t.tx))];
      const inTx = new Map(txs.map((tx) => [tx, (stmt.tradesIn.all(tx) as Raw[]).map(toTrade)]));
      const receipts = new Map<string, ReceiptRow>();
      for (const tx of txs) {
        const r = stmt.receipt.get(tx) as { tx: string; sender: string; gas: string; block: number; time: number } | undefined;
        if (r) receipts.set(tx, { tx: r.tx, sender: r.sender, gas: BigInt(r.gas), block: BigInt(r.block), time: BigInt(r.time) });
      }
      return {
        trades, inTx, receipts,
        balance: (token: string) => {
          const r = stmt.holder.get(token.toLowerCase(), a) as { balance: string } | undefined;
          return r ? BigInt(r.balance) : 0n;
        },
      };
    },

    /**
     * Every address a curve trade names as its caller or recipient, less the
     * curves themselves (X29a): whose ledgers the leaderboard builds.
     */
    traders(): string[] {
      return (stmt.traders.all() as { a: string }[]).map((r) => r.a);
    },

    /**
     * Every curve trade of `token`, oldest first, the receipts the index has
     * for them (their block times), and the block its V4 pool was made, if
     * it has graduated (p-sell-verdict.md P4a). Also its launch (null for a
     * token the index has not seen), with how far its history is read, and
     * the index's newest and oldest block times, which place a trade whose
     * receipt is not in yet when the token has few of its own (X25a).
     */
    tokenTrades(token: string) {
      const t = token.toLowerCase();
      type Raw = { tx: string; log_index: number; block: number; curve: string; token: string; kind: string;
        caller: string; recipient: string; amount_in: string; amount_out: string; fee: string; snipe_tax: string; movers: string };
      const trades: TradeRow[] = (stmt.tradesOfToken.all(t) as Raw[]).map((r) => ({
        tx: r.tx, logIndex: r.log_index, block: BigInt(r.block), curve: r.curve, token: r.token,
        kind: r.kind as "buy" | "sell", caller: r.caller, recipient: r.recipient,
        amountIn: BigInt(r.amount_in), amountOut: BigInt(r.amount_out), fee: BigInt(r.fee), snipeTax: BigInt(r.snipe_tax),
        movers: JSON.parse(r.movers) as string[],
      }));
      const receipts = new Map<string, ReceiptRow>();
      for (const r of stmt.receiptsOfToken.all(t) as { tx: string; sender: string; gas: string; block: number; time: number }[]) {
        receipts.set(r.tx, { tx: r.tx, sender: r.sender, gas: BigInt(r.gas), block: BigInt(r.block), time: BigInt(r.time) });
      }
      const pool = stmt.poolBlockOf.get(t) as { block: number | null } | undefined;
      const l = stmt.launch.get(t) as { curve: string; creator: string; block: number; synced_to: number | null } | undefined;
      const anchors = [stmt.newestReceipt.get(), stmt.oldestReceipt.get()]
        .filter((r): r is { block: number; time: number } => !!r)
        .map((r): [number, number] => [r.block, r.time * 1000]);
      return {
        trades, receipts, graduatedBlock: pool && pool.block !== null ? BigInt(pool.block) : null,
        launch: l ? {
          curve: l.curve, creator: l.creator, block: BigInt(l.block), syncedTo: l.synced_to === null ? null : BigInt(l.synced_to),
        } : null,
        anchors,
      };
    },

    /** Tokens behind `block`, newest launch first, and the block each carries on from. */
    pending(block: bigint, limit: number): PendingToken[] {
      return (stmt.pending.all(Number(block), limit) as { token: string; curve: string; block: number; synced_to: number | null }[])
        .map((r) => ({
          token: r.token, curve: r.curve, launchBlock: BigInt(r.block),
          from: r.synced_to === null ? BigInt(r.block) : BigInt(r.synced_to) + 1n,
        }));
    },

    /**
     * A token's holders, largest first, less the curve, and its supply, if
     * its Transfers are in up to `atLeast`. Otherwise null: the index does
     * not know them yet.
     */
    holders(token: string, atLeast: bigint): { holders: HolderRow[]; supply: bigint; syncedTo: bigint } | null {
      const t = token.toLowerCase();
      const l = stmt.launch.get(t) as { curve: string; synced_to: number | null; supply: string } | undefined;
      if (!l || l.synced_to === null || BigInt(l.synced_to) < atLeast) return null;
      const rows = (stmt.holders.all(t) as { address: string; balance: string; first_block: number; first_in: string }[])
        .filter((r) => r.address !== l.curve)
        .map((r) => ({ address: r.address, balance: BigInt(r.balance), firstBlock: BigInt(r.first_block), firstIn: BigInt(r.first_in) }))
        .filter((r) => r.balance > 0n)
        .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
      return { holders: rows, supply: BigInt(l.supply), syncedTo: BigInt(l.synced_to) };
    },

    /**
     * Which tokens have graduated (a pool is known for them) and the newest
     * block each token's curve traded in, for the board's dead-launch rule (B6).
     */
    activity(): { graduated: Set<string>; lastTrade: Map<string, bigint> } {
      const graduated = new Set((stmt.graduatedTokens.all() as { token: string }[]).map((r) => r.token.toLowerCase()));
      const lastTrade = new Map((stmt.lastTradeBlocks.all() as { token: string; block: number }[])
        .map((r) => [r.token.toLowerCase(), BigInt(r.block)] as const));
      return { graduated, lastTrade };
    },

    /** Every launch, oldest first. */
    launches(): LaunchRow[] {
      return (stmt.launches.all() as { token: string; curve: string; creator: string; factory: string;
        block: number; log_index: number; threshold: string }[]).map((r) => ({
        token: r.token, curve: r.curve, creator: r.creator, factory: r.factory,
        block: BigInt(r.block), logIndex: r.log_index, threshold: BigInt(r.threshold),
      }));
    },

    stats: () => ({
      launches: Number((stmt.count.get() as { n: number }).n),
      withHolders: Number((stmt.syncedCount.get() as { n: number }).n),
      holderRows: Number((stmt.holderCount.get() as { n: number }).n),
      pools: Number((stmt.poolCount.get() as { n: number }).n),
      trades: Number((stmt.tradeCount.get() as { n: number }).n),
      receipts: Number((stmt.receiptCount.get() as { n: number }).n),
    }),

    close() {
      if (!isOpen) return;
      isOpen = false;
      db.close();
    },
  };
}

/** Open and check a file, migrating it to the current schema. Throws if it is unusable. */
function open(path: string, venue: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    runSql(db, "PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") runSql(db, "PRAGMA journal_mode = WAL");
    runSql(db, "PRAGMA synchronous = NORMAL");
    const check = db.prepare("PRAGMA quick_check").get() as Record<string, string> | undefined;
    if (!check || Object.values(check)[0] !== "ok") throw new Error(`quick_check: ${JSON.stringify(check)}`);

    runSql(db, "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const get = (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    const set = (k: string, v: string) =>
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);

    const had = get("venue");
    if (had !== undefined && had !== venue) throw new Error(`it indexes ${had}, not ${venue}`);
    const version = Number(get("version") ?? 0);
    if (version > SCHEMA_VERSION) throw new Error(`schema ${version} is newer than this build's ${SCHEMA_VERSION}`);

    for (let v = version; v < SCHEMA_VERSION; v++) {
      inTransaction(db, () => {
        runSql(db, MIGRATIONS[v]!);
        set("version", String(v + 1));
        if (had === undefined) set("venue", venue);
      });
    }
    return db;
  } catch (e) {
    try { db.close(); } catch { /* already unusable */ }
    throw e;
  }
}
