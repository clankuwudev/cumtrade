import type { Address, Hex } from "viem";
import { logRoute } from "./client.js";
import { createLogRoute, logGate, type LogGate, type LogRoute } from "./logGate.js";

/**
 * Chain history for ledger lookups (public-release B3.2): logs, receipts and
 * block times, from the chain's public node.
 *
 * It goes the way every log request goes (client.ts `logRoute`): the log
 * endpoint, then the public node behind it on a refusal or an outage (D1.0).
 *
 * None of it goes to the fast provider. A receipt costs 15 CU and a block 20 there,
 * so one cold lookup of a few hundred transactions would spend a minute of the
 * whole CU budget, while the public node charges nothing and already serves
 * every eth_getLogs. What the public node does do is refuse volume (429), so:
 *
 *   - every request goes through the process's log gate, which stops all log
 *     traffic for a while after a refusal (logGate.ts, B4.6);
 *   - receipts and blocks go as JSON-RPC batches, so a lookup of 400
 *     transactions is a handful of HTTP requests, not 800;
 *   - at most `concurrency` HTTP requests are in flight at once (default 2,
 *     measured: the node counts calls, so more in flight buys no budget).
 *
 * And the node answers a log query that is too wide with an error, not with
 * fewer logs: "log query timed out" past about 2s of work, and "logs matched
 * by query exceeds limit of 10000". `logs` walks the range in windows and
 * halves any window the node refuses that way.
 *
 * Raw JSON-RPC over `fetch`, rather than through viem, because viem cannot
 * send a batch of chosen size on demand, and the answers here are only ever
 * read field by field.
 */

export type HistoryLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
  logIndex: Hex;
};

export type HistoryReceipt = {
  transactionHash: Hex;
  from: Address;
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  logs: HistoryLog[];
};

export type Topics = (Hex | Hex[] | null)[];

/** A JSON-RPC error from the node, with its code where it gave one. */
export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string, readonly status?: number) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

/** The node answered a log query with "too wide", in one of its two words. */
export const tooWide = (e: unknown) =>
  e instanceof RpcError
  && /timed out|exceeds limit|too many (results|logs)|query timeout|block range|response size exceeded/i.test(e.message);

export type HistoryRpc = ReturnType<typeof createHistoryRpc>;

export function createHistoryRpc(opts: {
  /** One endpoint and its gate, or a whole route (`route` wins). */
  url?: string;
  gate?: LogGate;
  route?: LogRoute;
  fetch?: typeof fetch;
  /** Calls per batch. */
  batchSize?: number;
  /** HTTP requests in flight. */
  concurrency?: number;
  /**
   * Blocks per eth_getLogs window before any halving. Unset: the whole range
   * in one query, halved only if the node refuses it.
   */
  logSpan?: bigint;
  /** Below this, a refused window is an error rather than halved again. */
  minSpan?: bigint;
}) {
  const route = opts.route
    ?? createLogRoute([{ name: "log", url: opts.url ?? "", gate: opts.gate ?? logGate }]);
  const batchSize = Math.max(1, opts.batchSize ?? 50);
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const minSpan = opts.minSpan ?? 1_000n;
  /**
   * The window a scan starts with after the node last refused a wider one.
   * Fixed windows would cost a request each on every scan, and the node
   * refuses a burst of log queries sooner than one slow one: a run of 1M-block
   * windows drew a 429 within five queries on 2026-09-22, where the same
   * history in one query per filter went through. So a scan asks for the
   * whole range, halves what is refused, starts the next scan at the size
   * that worked, and doubles it again after `GROW_AFTER` scans in a row that
   * needed no halving, since the node's patience varies with its load.
   */
  let hint: bigint | undefined = opts.logSpan;
  let clean = 0;
  const GROW_AFTER = 10;
  const doFetch = () => opts.fetch ?? globalThis.fetch;

  const stats = { requests: 0, calls: 0, halved: 0 };
  let active = 0;
  const waiting: (() => void)[] = [];
  /** Run `fn` holding one of `concurrency` slots. A freed slot passes straight to the next waiter. */
  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  let id = 0;
  /** One HTTP request carrying `calls`, answered in order. Throws on any error. */
  async function post(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    return slot(() => route.run(async (ep) => {
      const body = calls.map((c) => ({ jsonrpc: "2.0", id: ++id, method: c.method, params: c.params }));
      stats.requests++;
      stats.calls += calls.length;
      const res = await doFetch()(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.length === 1 ? body[0] : body),
      });
      const text = await res.text();
      const first = calls[0]!.method;
      if (res.status === 429) throw new RpcError(first, 429, "Too Many Requests", 429);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        throw new RpcError(first, undefined, `HTTP ${res.status}, not JSON`, res.status);
      }
      if (!res.ok && !Array.isArray(parsed)) {
        // Alchemy says why in the body, with a 400: "Log response size
        // exceeded" is what `tooWide` halves on.
        const e = (parsed as { error?: { code?: number; message?: string } } | null)?.error;
        throw new RpcError(first, e?.code, e?.message ?? `HTTP ${res.status}`, res.status);
      }
      const answers = (Array.isArray(parsed) ? parsed : [parsed]) as
        { id?: number; result?: unknown; error?: { code?: number; message?: string } }[];
      // A batch refused as a whole comes back as one error object.
      if (answers.length !== body.length && answers.length === 1 && answers[0]!.error) {
        const e = answers[0]!.error;
        throw new RpcError(first, e.code, e.message ?? "error", res.status);
      }
      const byId = new Map(answers.map((a) => [a.id, a]));
      return body.map((b) => {
        const a = byId.get(b.id);
        if (!a) throw new RpcError(b.method, undefined, "no answer in the batch", res.status);
        if (a.error) throw new RpcError(b.method, a.error.code, a.error.message ?? "error", res.status);
        return a.result;
      });
    }));
  }

  /** Every call answered, `batchSize` to a request. */
  async function batched(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const chunks: (typeof calls)[] = [];
    for (let i = 0; i < calls.length; i += batchSize) chunks.push(calls.slice(i, i + batchSize));
    return (await Promise.all(chunks.map(post))).flat();
  }

  const hex = (n: bigint) => `0x${n.toString(16)}`;

  /** One window of logs, halved while the node says it is too wide. */
  async function window(from: bigint, to: bigint, topics: Topics, run: { halved: boolean }): Promise<HistoryLog[]> {
    try {
      const [got] = await post([{ method: "eth_getLogs", params: [{ fromBlock: hex(from), toBlock: hex(to), topics }] }]);
      return got as HistoryLog[];
    } catch (e) {
      if (!tooWide(e) || to - from + 1n <= minSpan) throw e;
      stats.halved++;
      run.halved = true;
      const mid = from + (to - from) / 2n;
      const half = mid - from + 1n;
      if (hint === undefined || half < hint) hint = half;
      return [...await window(from, mid, topics, run), ...await window(mid + 1n, to, topics, run)];
    }
  }

  return {
    stats: () => ({ ...stats }),

    async blockNumber(): Promise<bigint> {
      const [n] = await post([{ method: "eth_blockNumber", params: [] }]);
      return BigInt(n as Hex);
    },

    /**
     * Logs matching `topics` in [from, to], oldest window first. Windows run
     * one after another: each is a heavy query, and the node refuses bursts.
     */
    async logs(from: bigint, to: bigint, topics: Topics): Promise<HistoryLog[]> {
      const out: HistoryLog[] = [];
      const span = hint ?? to - from + 1n;
      const run = { halved: false };
      for (let a = from; a <= to; a += span) {
        const b = a + span - 1n < to ? a + span - 1n : to;
        out.push(...await window(a, b, topics, run));
      }
      clean = run.halved ? 0 : clean + 1;
      if (clean >= GROW_AFTER && hint !== undefined && span < to - from + 1n) {
        hint = span * 2n;
        clean = 0;
      }
      return out;
    },

    /** The window the next scan starts with; undefined for the whole range. */
    logSpan: () => hint,

    /** Receipts by lowercased hash. A receipt the node does not have is an error. */
    async receipts(hashes: Hex[]): Promise<Map<string, HistoryReceipt>> {
      const got = await batched(hashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })));
      const map = new Map<string, HistoryReceipt>();
      got.forEach((r, i) => {
        if (!r) throw new RpcError("eth_getTransactionReceipt", undefined, `no receipt for ${hashes[i]}`);
        map.set(hashes[i]!.toLowerCase(), r as HistoryReceipt);
      });
      return map;
    },

    /** Block timestamps in seconds, by block number. */
    async blockTimes(blocks: bigint[]): Promise<Map<bigint, bigint>> {
      const got = await batched(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
      const map = new Map<bigint, bigint>();
      got.forEach((b, i) => {
        const ts = (b as { timestamp?: Hex } | null)?.timestamp;
        if (!ts) throw new RpcError("eth_getBlockByNumber", undefined, `no block ${blocks[i]}`);
        map.set(blocks[i]!, BigInt(ts));
      });
      return map;
    },
  };
}

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

/** The process's history client, on the log route and its gates. */
export const historyRpc = createHistoryRpc({
  route: logRoute,
  batchSize: num("LEDGER_HISTORY_BATCH", 50),
  // 8 drew a 429 before a single answer; the node counts calls, so more in
  // flight buys no budget (docs/rpc-optimization.md, B3.3).
  concurrency: num("LEDGER_HISTORY_CONCURRENCY", 2),
  logSpan: process.env.LEDGER_LOG_SPAN ? BigInt(num("LEDGER_LOG_SPAN", 1_000_000)) : undefined,
});
