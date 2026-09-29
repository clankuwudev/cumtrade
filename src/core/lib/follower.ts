import { isRateLimited, isTooWide, type LogEndpoint } from "./logGate.js";
import { withSource } from "./meter.js";
import type { IndexStore, LaunchRow, PoolRow, ReceiptRow, TradeRow, TransferRow } from "./indexStore.js";
import { BUY_TOPIC, SELL_TOPIC } from "../positions/attribution.js";

/**
 * The chain follower (spec D1): one loop, one cursor, the only reader of
 * history.
 *
 * Every `followMs` it asks a log endpoint for its head and reads from the
 * cursor + 1 to that head − `confirm` with one filter: every listed factory
 * and every token whose Transfers are caught up, topic Launch, Transfer or
 * the factory's pool-created event, and those tokens' curves' Buy and Sell
 * (D1.4). A pool created is followed by one Initialize query in its block,
 * for its key (D1.3). Each trade's receipt and block time are fetched once,
 * a few each round, for ledgers.
 * It commits what it read with the cursor past it, one window at a time. A
 * round that fails leaves the cursor at the last window it committed, and
 * the next round carries on from there.
 *
 * A token not caught up (one just launched, or every token when holders
 * first came in, D1.2) is read on its own, newest launch first, from where
 * it stopped to the cursor, for up to `catchUpMs` a round. Its `synced_to`
 * in the store says how far it has been read, and a Transfer at or below it
 * is never folded in again, so a window read twice changes nothing.
 *
 * Two routes. A round with more than `wideOver` blocks to read (an empty
 * index, a restart, a long stop) and every catch-up go the wide way: the
 * log endpoint that answers big ranges (Alchemy PAYG), in windows that start
 * as wide as the range, halve when the endpoint says a window matched too
 * much, and double again after `growAfter` clean ones. The steady tail,
 * ~20 blocks every 2 s, goes the cheap way (the public node first,
 * `TAIL_RPC`). Each route moves to its other endpoint on an outage.
 *
 * The websocket only wakes it (`wake`): the poll is what moves the cursor,
 * so a dropped socket loses nothing.
 */

/** A log endpoint the follower can send any request to. */
export type RpcEndpoint = LogEndpoint & {
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
};

/** The two things the follower needs of a route (logGate.ts `createLogRoute`). */
export type RpcRoute = {
  run<T>(fn: (ep: RpcEndpoint) => Promise<T>): Promise<T>;
  state(): { open: boolean; retryInMs: number };
};

export type RawLog = {
  address: string; topics: string[]; data: string;
  blockNumber: string; logIndex: string; transactionHash: string;
};

/** Where launches come from, and how a Launch log reads. */
export type LaunchSource = {
  factories: string[];
  topic: string;
  decode: (log: RawLog) => LaunchRow;
};

/**
 * Where graduated tokens' pools come from (D1.3): the factory event emitted
 * in the transaction that creates a token's V4 pool (topic1 the token), and
 * the PoolManager whose Initialize event in that block names the pool.
 */
export type PoolSource = { manager: string; createdTopic: string };

/** topic0 of the PoolManager's Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick). */
export const INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const NATIVE_TOPIC = `0x${"0".repeat(64)}`;

/**
 * What one committed window changed. `trades` are the curve trades the store
 * did not have before: a window read twice brings none.
 */
export type Committed = {
  from: bigint; to: bigint; launches: LaunchRow[]; changed: Set<string>; synced: string[]; pools: PoolRow[];
  trades: TradeRow[];
};

export type Follower = ReturnType<typeof createFollower>;

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hex = (n: bigint) => `0x${n.toString(16)}`;
const topicAddress = (t: string | undefined) => `0x${(t ?? "").slice(26)}`.toLowerCase();
const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

/** An Initialize log as the store keeps it. */
function poolOf(l: RawLog): PoolRow {
  const word = (i: number) => BigInt(`0x${l.data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  return {
    poolId: l.topics[1]!.toLowerCase(), token: topicAddress(l.topics[3]),
    currency0: topicAddress(l.topics[2]), currency1: topicAddress(l.topics[3]),
    fee: Number(word(0)), tickSpacing: Number(BigInt.asIntN(24, word(1))),
    hooks: `0x${l.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)}`.toLowerCase(),
    block: BigInt(l.blockNumber),
  };
}

/** A Transfer log as the store folds it. */
function transferOf(l: RawLog): TransferRow {
  return {
    token: l.address.toLowerCase(),
    from: topicAddress(l.topics[1]),
    to: topicAddress(l.topics[2]),
    value: l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n,
    block: BigInt(l.blockNumber),
  };
}

/**
 * A window's curve trades, with the addresses that sent each trade's token in
 * the same transaction: a window is whole blocks, so a trade's Transfers are
 * always in the same window as its event.
 */
function tradesOf(logs: RawLog[], curveToken: Map<string, string>): TradeRow[] {
  const movers = new Map<string, Set<string>>();
  for (const l of logs) {
    if (l.topics[0] !== TRANSFER_TOPIC) continue;
    const k = `${l.transactionHash.toLowerCase()}:${l.address.toLowerCase()}`;
    let s = movers.get(k);
    if (!s) movers.set(k, (s = new Set()));
    s.add(topicAddress(l.topics[1]));
  }
  const out: TradeRow[] = [];
  for (const l of logs) {
    const kind = l.topics[0] === BUY_TOPIC ? "buy" : l.topics[0] === SELL_TOPIC ? "sell" : null;
    const token = curveToken.get(l.address.toLowerCase());
    if (!kind || !token) continue;
    const word = (i: number) => BigInt(`0x${l.data.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"}`);
    out.push({
      tx: l.transactionHash.toLowerCase(), logIndex: Number(BigInt(l.logIndex)), block: BigInt(l.blockNumber),
      curve: l.address.toLowerCase(), token, kind,
      caller: topicAddress(l.topics[1]), recipient: topicAddress(l.topics[2]),
      amountIn: word(0), amountOut: word(1), fee: word(2), snipeTax: word(3),
      movers: [...(movers.get(`${l.transactionHash.toLowerCase()}:${token}`) ?? [])],
    });
  }
  return out;
}

/** A window's size, halved on "too wide" and grown after clean windows. */
function windowing(minSpan: bigint, growAfter: number) {
  let span: bigint | null = null;
  let clean = 0;
  return {
    end: (a: bigint, to: bigint) => (span === null || a + span - 1n > to ? to : a + span - 1n),
    /** The endpoint refused [a, b] as too wide: false if it cannot be halved. */
    refused(a: bigint, b: bigint) {
      if (b - a + 1n <= minSpan) return false;
      const half = (b - a + 1n) / 2n;
      span = half > minSpan ? half : minSpan;
      clean = 0;
      return true;
    },
    ok() {
      if (span !== null && ++clean >= growAfter) {
        span *= 2n;
        clean = 0;
      }
    },
    span: () => span,
  };
}

export function createFollower(opts: {
  store: IndexStore;
  /** The venue's first block: an empty index reads from here. */
  floor: bigint;
  launches: LaunchSource;
  pools?: PoolSource;
  tail: RpcRoute;
  wide: RpcRoute;
  /** The cursor's name in the store. */
  cursor?: string;
  followMs?: number;
  /** Blocks left unread behind the head, in case the chain reorganises. */
  confirm?: bigint;
  /** A round with more than this many blocks to read goes the wide way. */
  wideOver?: bigint;
  /** The smallest window; one refused at this size is an error. */
  minSpan?: bigint;
  growAfter?: number;
  /** How long a round spends catching tokens up, at most. */
  catchUpMs?: number;
  /** Tokens caught up together in one request. */
  catchUpBatch?: number;
  /** Trade receipts fetched a round, at most. */
  receiptsPerRound?: number;
  /**
   * The drift check (D1.5): every `everyMs`, for up to `tokens` tokens in
   * turn, the creator's and the `top` largest holders' balances and the
   * supply, read from the chain at the cursor block, against the index.
   */
  drift?: {
    everyMs?: number; tokens?: number; top?: number;
    balances: (token: string, owners: string[], block: bigint) => Promise<Map<string, bigint>>;
    supply: (token: string, block: bigint) => Promise<bigint>;
  };
  /** After each committed window, with what it changed. */
  onCommit?: (w: Committed) => void;
  log?: (line: string) => void;
}) {
  const name = opts.cursor ?? "main";
  const followMs = opts.followMs ?? 2_000;
  const confirm = opts.confirm ?? 20n;
  const wideOver = opts.wideOver ?? 5_000n;
  const minSpan = opts.minSpan ?? 500n;
  const growAfter = opts.growAfter ?? 4;
  const catchUpMs = opts.catchUpMs ?? 5_000;
  const catchUpBatch = opts.catchUpBatch ?? 20;
  const receiptsPerRound = opts.receiptsPerRound ?? 200;
  const driftEvery = opts.drift?.everyMs ?? 10 * 60_000;
  const driftTokens = opts.drift?.tokens ?? 20;
  const driftTop = opts.drift?.top ?? 5;
  let driftAt = Date.now();
  let driftTurn = 0;
  let lastRoundAt = 0;
  const log = opts.log ?? ((l: string) => console.log(l));
  const factories = new Set(opts.launches.factories.map((f) => f.toLowerCase()));

  const main = windowing(minSpan, growAfter);
  const catchUp = windowing(minSpan, growAfter);
  let head: bigint | null = null;
  let caught = false;
  let inFlight: Promise<RoundResult> | null = null;
  const stats = { rounds: 0, windows: 0, catchUpWindows: 0, failures: 0, lastError: "", driftChecked: 0, rebuilds: 0 };

  type RoundResult = { from: bigint; to: bigint; windows: number; wide: boolean; pending: number };

  async function getLogs(ep: RpcEndpoint, address: string[], topics: (string | string[])[], from: bigint, to: bigint) {
    return await ep.request({
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }],
    }) as RawLog[];
  }

  /** Commit a window and tell whoever listens. */
  function commit(w: {
    cursor?: string; from: bigint; to: bigint; launches: LaunchRow[]; transfers: TransferRow[]; synced: string[];
    pools?: PoolRow[]; trades?: TradeRow[];
  }) {
    const r = opts.store.commit({
      cursor: w.cursor, block: w.to,
      launches: w.launches, transfers: w.transfers, synced: w.synced, pools: w.pools, trades: w.trades,
    });
    opts.onCommit?.({
      from: w.from, to: w.to, launches: w.launches, changed: r.changed, synced: w.synced, pools: w.pools ?? [], trades: r.trades,
    });
  }

  /**
   * The pools created for `tokens`, each in the block its factory said so:
   * one Initialize query per graduation, native ETH against the token.
   */
  async function poolsCreated(ep: RpcEndpoint, created: { token: string; block: bigint }[]): Promise<PoolRow[]> {
    if (!opts.pools || created.length === 0) return [];
    const out: PoolRow[] = [];
    for (const c of created) {
      const logs = await getLogs(ep, [opts.pools.manager], [INITIALIZE_TOPIC, null, NATIVE_TOPIC, topicOf(c.token)] as never, c.block, c.block);
      out.push(...logs.map(poolOf));
    }
    return out;
  }

  /**
   * The cursor from `from` to `to`: launches, and the caught-up tokens'
   * Transfers. Which tokens is read once, before the first window, since
   * every one of them moves with the cursor.
   */
  async function follow(ep: RpcEndpoint, from: bigint, to: bigint): Promise<number> {
    const caught = opts.store.caughtUp(from - 1n);
    const tokens = caught.map((c) => c.token);
    const curveToken = new Map(caught.map((c) => [c.curve, c.token]));
    const address = [...factories, ...tokens, ...curveToken.keys()];
    const topic0 = [opts.launches.topic, TRANSFER_TOPIC, BUY_TOPIC, SELL_TOPIC, ...(opts.pools ? [opts.pools.createdTopic] : [])];
    let windows = 0;
    for (let a = from; a <= to;) {
      const b = main.end(a, to);
      let logs: RawLog[];
      try {
        logs = await getLogs(ep, address, [topic0], a, b);
      } catch (e) {
        if (!isTooWide(e) || !main.refused(a, b)) throw e;
        continue;
      }
      const launches: LaunchRow[] = [];
      const transfers: TransferRow[] = [];
      const created: { token: string; block: bigint }[] = [];
      for (const l of logs) {
        const at = l.address.toLowerCase();
        if (factories.has(at)) {
          if (l.topics[0] === opts.launches.topic) launches.push(opts.launches.decode(l));
          else if (l.topics[0] === opts.pools?.createdTopic) created.push({ token: topicAddress(l.topics[1]), block: BigInt(l.blockNumber) });
        } else if (l.topics[0] === TRANSFER_TOPIC) transfers.push(transferOf(l));
      }
      const pools = await poolsCreated(ep, created);
      const trades = tradesOf(logs, curveToken);
      commit({ cursor: name, from: a, to: b, launches, transfers, synced: tokens, pools, trades });
      windows++;
      stats.windows++;
      main.ok();
      a = b + 1n;
    }
    return windows;
  }

  /**
   * Tokens behind the cursor, newest launch first, for up to `catchUpMs`:
   * their Transfers and their curves' trades from where each stopped to the
   * cursor. Read together in
   * batches from the batch's earliest block; a token's logs at or below its
   * own `synced_to` are skipped by the store. Returns how many are left.
   */
  async function catchUpTokens(ep: RpcEndpoint, deadline: number): Promise<number> {
    for (;;) {
      const cursor = opts.store.cursor(name);
      if (cursor === null) return 0;
      const batch = opts.store.pending(cursor, catchUpBatch);
      if (batch.length === 0 || Date.now() >= deadline) return batch.length;
      const tokens = batch.map((p) => p.token);
      const curveToken = new Map(batch.map((p) => [p.curve, p.token]));
      let a = batch.reduce((m, p) => (p.from < m ? p.from : m), batch[0]!.from);
      while (a <= cursor) {
        if (Date.now() >= deadline) return batch.length;
        const b = catchUp.end(a, cursor);
        let logs: RawLog[];
        try {
          logs = await getLogs(ep, [...tokens, ...curveToken.keys()], [[TRANSFER_TOPIC, BUY_TOPIC, SELL_TOPIC]], a, b);
        } catch (e) {
          if (!isTooWide(e) || !catchUp.refused(a, b)) throw e;
          continue;
        }
        const transfers = logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).map(transferOf);
        commit({ from: a, to: b, launches: [], transfers, synced: tokens, trades: tradesOf(logs, curveToken) });
        stats.catchUpWindows++;
        catchUp.ok();
        a = b + 1n;
      }
    }
  }

  async function roundOnce(): Promise<RoundResult> {
    const cur = opts.store.cursor(name);
    // An empty index, a first round after a restart (how far behind is not
    // known yet), or a gap too long for the tail.
    const wide = cur === null || head === null || head - confirm - cur > wideOver;
    const route = wide ? opts.wide : opts.tail;
    const r = await withSource(wide ? "follow-wide" : "follow", () => route.run(async (ep) => {
      const h = BigInt(await ep.request({ method: "eth_blockNumber" }) as string);
      if (head === null || h > head) head = h;
      const to = h - confirm;
      // Read again inside the run: a retry on the other endpoint carries on
      // from whatever the first one committed.
      const from = (opts.store.cursor(name) ?? opts.floor - 1n) + 1n;
      if (from > to) return { from, to, windows: 0, wide };
      return { from, to, windows: await follow(ep, from, to), wide };
    }));
    stats.rounds++;
    lastRoundAt = Date.now();
    caught = true;
    if (r.wide && r.windows > 0) log(`[index] read blocks ${r.from}..${r.to} in ${r.windows} window(s)`);
    // Like catching up: the cursor has moved, so a failure here is logged and
    // tried again next round, and the round is not a failure.
    await poolHistory().catch((e) => log(`[index] pool history: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 150)}`));

    // Nothing behind: no request, and no gate to pass. Receipts wait until
    // no token is behind: the board's verdicts wait on catching up, and a
    // ledger fetches a receipt it needs itself.
    const cursor = opts.store.cursor(name);
    if (cursor === null || opts.store.pending(cursor, 1).length === 0) {
      if (catchingUp) log("[index] every token's holders and trades are caught up");
      catchingUp = false;
      await keepReceipts();
      if (opts.drift && Date.now() - driftAt >= driftEvery) {
        driftAt = Date.now();
        await withSource("drift", checkDrift).catch((e) => log(`[index] drift check: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 150)}`));
      }
      return { ...r, pending: 0 };
    }
    catchingUp = true;
    const deadline = Date.now() + catchUpMs;
    try {
      const pending = await withSource("follow-catch-up", () => opts.wide.run((ep) => catchUpTokens(ep, deadline)));
      catchUpFailures = 0;
      return { ...r, pending };
    } catch (e) {
      // The cursor moved; only the catching up failed. It carries on next
      // round from what it committed, and the round is not a failure.
      stats.lastError = `catch-up: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 150)}`;
      if (++catchUpFailures === 1 || catchUpFailures % 30 === 0) {
        log(`[index] ${stats.lastError} (${catchUpFailures} in a row)`);
      }
      return { ...r, pending: -1 };
    }
  }
  let catchingUp = false;
  let catchUpFailures = 0;

  /**
   * The drift check (D1.5), inside a round, so the index holds still at the
   * cursor while the chain is read at that same block. Tokens are taken in
   * turn, `driftTokens` at a time. One that disagrees on any balance or on
   * its supply is read again from its launch, and said so.
   */
  async function checkDrift() {
    const d = opts.drift!;
    const cursor = opts.store.cursor(name);
    if (cursor === null) return;
    const all = opts.store.caughtUp(cursor).map((c) => c.token);
    if (all.length === 0) return;
    const start = driftTurn % all.length;
    const turn = [...all.slice(start), ...all.slice(0, start)].slice(0, driftTokens);
    driftTurn = start + turn.length;
    await Promise.all(turn.map(async (token) => {
      const ix = opts.store.holders(token, cursor);
      if (!ix) return;
      const creator = opts.store.creatorOf(token);
      const owners = [...new Set([...(creator ? [creator] : []), ...ix.holders.slice(0, driftTop).map((h) => h.address)])];
      const [chain, supply] = await Promise.all([d.balances(token, owners, cursor), d.supply(token, cursor)]);
      const held = new Map(ix.holders.map((h) => [h.address, h.balance]));
      const wrong = owners.filter((o) => (held.get(o) ?? 0n) !== (chain.get(o) ?? 0n));
      stats.driftChecked++;
      if (wrong.length === 0 && supply === ix.supply) return;
      stats.rebuilds++;
      const what = wrong.length > 0
        ? `${wrong.length} of ${owners.length} balance(s), e.g. ${wrong[0]} index ${held.get(wrong[0]!) ?? 0n} chain ${chain.get(wrong[0]!) ?? 0n}`
        : `supply index ${ix.supply} chain ${supply}`;
      log(`[index] drift in ${token} at block ${cursor}: ${what}; reading it again from its launch`);
      opts.store.resetToken(token);
    }));
  }

  /**
   * Each trade's receipt and block time, once (D1.4): who sent it, the gas it
   * cost, and when. Up to `receiptsPerRound` a round, 8 in flight, the wide
   * way; a ledger that meets one not kept yet fetches it itself. A failure
   * is logged and tried next round.
   */
  async function keepReceipts() {
    const missing = opts.store.missingReceipts(receiptsPerRound);
    if (missing.length === 0) return;
    try {
      await withSource("follow-receipts", () => opts.wide.run(async (ep) => {
        const times = new Map<bigint, bigint>();
        const rows: ReceiptRow[] = [];
        for (let i = 0; i < missing.length; i += 8) {
          await Promise.all(missing.slice(i, i + 8).map(async (m) => {
            const r = await ep.request({ method: "eth_getTransactionReceipt", params: [m.tx] }) as
              { from: string; gasUsed: string; effectiveGasPrice: string } | null;
            if (!r) return;
            let t = times.get(m.block);
            if (t === undefined) {
              const blk = await ep.request({ method: "eth_getBlockByNumber", params: [hex(m.block), false] }) as { timestamp: string } | null;
              if (!blk) return;
              t = BigInt(blk.timestamp);
              times.set(m.block, t);
            }
            rows.push({ tx: m.tx, sender: r.from, gas: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), block: m.block, time: t });
          }));
        }
        opts.store.addReceipts(rows);
      }));
    } catch (e) {
      log(`[index] receipts: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 150)}`);
    }
  }

  /**
   * Once per index (D1.3): the pools of tokens that graduated before the
   * follower watched for them. One scan of the factories' pool-created event
   * up to the cursor, then an Initialize lookup for each.
   */
  async function poolHistory() {
    const cursor = opts.store.cursor(name);
    if (!opts.pools || cursor === null || opts.store.cursor("pools") !== null) return;
    await withSource("follow-wide", () => opts.wide.run(async (ep) => {
      const logs = await getLogs(ep, [...factories], [opts.pools!.createdTopic], opts.floor, cursor);
      const created = logs.map((l) => ({ token: topicAddress(l.topics[1]), block: BigInt(l.blockNumber) }));
      const pools = await poolsCreated(ep, created);
      commit({ cursor: "pools", from: opts.floor, to: cursor, launches: [], transfers: [], synced: [], pools });
      if (created.length > 0) log(`[index] ${created.length} graduated pool(s) found, ${pools.length} key(s) kept`);
    }));
  }

  /** One round now, or the one already running. */
  function round(): Promise<RoundResult> {
    if (!inFlight) inFlight = roundOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  // ------------------------------------------------------------- the loop --
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAt = 0;
  let running = false;
  let failing = 0;

  function schedule(ms: number) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    nextAt = Date.now() + ms;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    if (!running) return;
    let next = followMs;
    try {
      const r = await round();
      if (failing > 0) log(`[index] following again after ${failing} failed round(s)`);
      failing = 0;
      // Catching up is its own work: carry on at once while tokens are left.
      if (r.pending > 0) next = 0;
    } catch (e) {
      failing++;
      stats.failures++;
      stats.lastError = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 160);
      // Refused: wait for the gate. Otherwise back off, up to a minute.
      next = isRateLimited(e)
        ? Math.max(followMs, (caught ? opts.tail : opts.wide).state().retryInMs + 500)
        : Math.min(60_000, followMs * 2 ** Math.min(failing, 5));
      if (failing === 1 || failing % 10 === 0) {
        log(`[index] round failed (${failing} in a row), again in ${Math.round(next / 1000)}s: ${stats.lastError}`);
      }
    }
    schedule(next);
  }

  return {
    round,

    start() {
      if (running) return;
      running = true;
      schedule(0);
    },

    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    /**
     * Something happened on chain (the websocket said so). Its block is
     * readable once it is `confirm` blocks deep, ~2 s at 10 blocks a second;
     * read then if the next round is later.
     */
    wake() {
      const ms = Number(confirm) * 100 + 100;
      if (running && nextAt - Date.now() > ms) schedule(ms);
    },

    /** Whether a round has ever read up to the head. */
    caughtUp: () => caught,
    running: () => running,
    cursor: () => opts.store.cursor(name),

    /** Read a token's history again from its launch (D1.5). */
    rebuild(token: string) {
      opts.store.resetToken(token);
    },

    /**
     * For /healthz (D1.5): how far the cursor is behind the head the follower
     * last saw, how many tokens' history is not in yet, and how long since a
     * round last succeeded (a follower that has stopped keeps its last lag).
     */
    health() {
      const cur = opts.store.cursor(name);
      return {
        followerLagBlocks: cur !== null && head !== null ? Number(head - cur) : null,
        building: cur === null ? null : opts.store.behind(cur),
        followerRoundAgeSec: lastRoundAt > 0 ? Math.round((Date.now() - lastRoundAt) / 1000) : null,
      };
    },

    /**
     * What a ledger for `address` reads from the index, at the cursor
     * (D1.4); null before the first round.
     */
    ledgerOf(address: string) {
      const cur = opts.store.cursor(name);
      return cur === null ? null : { toBlock: cur, ...opts.store.ledgerOf(address) };
    },

    /** Every address the index's curve trades name, less the curves (X29a); null before the first round. */
    traders() {
      const cur = opts.store.cursor(name);
      return cur === null ? null : { toBlock: cur, traders: opts.store.traders() };
    },

    /**
     * A token's curve trades, their receipts and its graduation block, at the
     * cursor (p-sell-verdict.md P4a); null before the first round.
     */
    tokenTrades(token: string) {
      const cur = opts.store.cursor(name);
      return cur === null ? null : { toBlock: cur, ...opts.store.tokenTrades(token) };
    },

    /**
     * A token's holders from the index, if its Transfers are in up to the
     * cursor. Null for a token the index has not caught up yet.
     */
    holders(token: string) {
      const cur = opts.store.cursor(name);
      return cur === null ? null : opts.store.holders(token, cur);
    },

    state() {
      const cur = opts.store.cursor(name);
      return {
        cursor: cur?.toString() ?? null,
        head: head?.toString() ?? null,
        lagBlocks: cur !== null && head !== null ? Number(head - cur) : null,
        caughtUp: caught, running, ...stats,
        span: main.span()?.toString() ?? null,
        ...opts.store.stats(),
      };
    },
  };
}
