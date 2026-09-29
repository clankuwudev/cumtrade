/**
 * A fake JSON-RPC node that answers from recorded chain data (B3.2, B3.3).
 *
 * Tests only. A node built from our own ABI would share its mistakes, so this
 * one answers with bytes the real chain returned, recorded by
 * scripts/record-ledger-fixture.mts:
 *
 *   eth_getLogs                filtered here, over every log recorded, by
 *                              block range and topics as a node does
 *   eth_getTransactionReceipt  the recorded receipt
 *   eth_getBlockByNumber       the recorded timestamp
 *   eth_call                   Multicall3 aggregate3, each call answered with
 *                              the recorded return data for (target, calldata)
 *   eth_blockNumber            the fixture's pinned block
 *
 * A test can edit what it serves (a balance, a log) to make a case the chain
 * did not happen to have, and can make the node refuse (429) or call a range
 * too wide, the way the public node does.
 */
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, type Hex } from "viem";
import type { HistoryLog, HistoryReceipt } from "../../lib/historyRpc.js";

export const MULTICALL3 = "0xca11bde05977b3631167028862bE2a173976CA11".toLowerCase();

export type Fixture = {
  note: string;
  address: string;
  toBlock: string;
  logs: HistoryLog[];
  receipts: Record<string, HistoryReceipt>;
  /** Block number (decimal) → timestamp (hex). */
  blocks: Record<string, Hex>;
  /** `${target}|${calldata}`, lowercased → the call's answer. */
  calls: Record<string, { success: boolean; returnData: Hex }>;
};

type Req = { id: number; method: string; params: unknown[] };

export type FakeNode = ReturnType<typeof fakeNode>;

export function fakeNode(fixtures: Fixture[]) {
  const logs = new Map<string, HistoryLog>();
  const receipts = new Map<string, HistoryReceipt>();
  const blocks = new Map<string, Hex>();
  const calls = new Map<string, { success: boolean; returnData: Hex }>();
  let head = 0n;
  for (const f of fixtures) {
    for (const l of f.logs) logs.set(`${l.transactionHash.toLowerCase()}:${l.logIndex}`, l);
    for (const [h, r] of Object.entries(f.receipts)) receipts.set(h.toLowerCase(), r);
    for (const [b, t] of Object.entries(f.blocks)) blocks.set(b, t);
    for (const [k, v] of Object.entries(f.calls)) calls.set(k.toLowerCase(), v);
    if (BigInt(f.toBlock) > head) head = BigInt(f.toBlock);
  }

  const state = {
    head,
    /** JSON-RPC calls seen, by method, in order. */
    seen: [] as string[],
    /** Calls carried by each Multicall3 eth_call, in order. */
    inner: [] as number[],
    /** The block tag of each eth_call, in order. */
    callBlocks: [] as string[],
    /** HTTP requests received. */
    requests: 0,
    /** eth_getLogs over more blocks than this is answered "log query timed out". */
    maxLogSpan: Infinity as number | bigint,
    /** Answer every request with HTTP 429 while set. */
    refuse: false,
    /**
     * JSON-RPC calls left before the node refuses, or Infinity. A request that
     * would go past it is refused whole, as the public node counts calls.
     */
    budget: Infinity,
    /** The [fromBlock, toBlock] of each eth_getLogs, in order. */
    logRanges: [] as [bigint, bigint][],
    /** Calls asked for that nothing was recorded for. A test should see none. */
    unknown: [] as string[],
    /** Balance overrides: `${token}|${owner}` lowercased → value. */
    balances: new Map<string, bigint>(),
    logs, receipts, blocks, calls,
  };

  const matches = (topic: string | undefined, want: unknown) =>
    want === null || want === undefined ||
    (Array.isArray(want) ? want.some((w) => String(w).toLowerCase() === topic?.toLowerCase())
      : String(want).toLowerCase() === topic?.toLowerCase());

  function getLogs(f: { fromBlock: Hex; toBlock: Hex; topics?: unknown[]; address?: string }) {
    const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
    state.logRanges.push([from, to]);
    if (state.maxLogSpan !== Infinity && to - from + 1n > BigInt(state.maxLogSpan)) {
      throw { code: -32000, message: "log query timed out" };
    }
    return [...logs.values()].filter((l) => {
      const b = BigInt(l.blockNumber);
      if (b < from || b > to) return false;
      if (f.address && f.address.toLowerCase() !== l.address.toLowerCase()) return false;
      return (f.topics ?? []).every((want, i) => matches(l.topics[i], want));
    }).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  }

  function call(target: string, data: Hex): { success: boolean; returnData: Hex } {
    // balanceOf(owner), overridden by the test.
    if (data.startsWith("0x70a08231")) {
      const owner = `0x${data.slice(34, 74)}`.toLowerCase();
      const over = state.balances.get(`${target.toLowerCase()}|${owner}`);
      if (over !== undefined) return { success: true, returnData: `0x${over.toString(16).padStart(64, "0")}` };
    }
    const hit = calls.get(`${target}|${data}`.toLowerCase());
    if (!hit) {
      state.unknown.push(`eth_call ${target} ${data.slice(0, 10)}`);
      return { success: false, returnData: "0x" };
    }
    return hit;
  }

  function answer(r: Req): unknown {
    state.seen.push(r.method);
    switch (r.method) {
      case "eth_chainId": return "0x1237";
      case "eth_blockNumber": return `0x${state.head.toString(16)}`;
      case "eth_getLogs": return getLogs(r.params[0] as never);
      case "eth_getTransactionReceipt": {
        const got = receipts.get(String(r.params[0]).toLowerCase());
        if (!got) state.unknown.push(`receipt ${r.params[0]}`);
        return got ?? null;
      }
      case "eth_getBlockByNumber": {
        const n = BigInt(r.params[0] as Hex).toString();
        const ts = blocks.get(n);
        if (!ts) state.unknown.push(`block ${n}`);
        return ts ? { number: r.params[0], timestamp: ts } : null;
      }
      case "eth_call": {
        const { to, data } = r.params[0] as { to: string; data: Hex };
        state.callBlocks.push(String(r.params[1] ?? "latest"));
        if (to.toLowerCase() !== MULTICALL3) {
          const got = call(to, data);
          if (!got.success) throw { code: 3, message: "execution reverted", data: "0x" };
          return got.returnData;
        }
        const d = decodeFunctionData({ abi: multicall3Abi, data });
        const inner = d.args[0] as readonly { target: string; callData: Hex }[];
        state.inner.push(inner.length);
        return encodeFunctionResult({
          abi: multicall3Abi, functionName: "aggregate3",
          result: inner.map((c) => call(c.target, c.callData)),
        });
      }
      default:
        state.unknown.push(r.method);
        throw { code: -32601, message: `the fake node does not serve ${r.method}` };
    }
  }

  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    state.requests++;
    const sent = JSON.parse(String(init?.body)) as Req | Req[];
    const calls = Array.isArray(sent) ? sent.length : 1;
    let refused = state.refuse;
    if (!refused && state.budget !== Infinity) {
      if (calls > state.budget) { refused = true; state.budget = 0; } else state.budget -= calls;
    }
    if (refused) {
      return new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}',
        { status: 429, headers: { "content-type": "application/json" } });
    }
    const body = sent;
    const one = (r: Req) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: answer(r) };
      } catch (e) {
        // A thrown Error is a fault in the fake, and says so.
        if (!(e instanceof Error)) return { jsonrpc: "2.0", id: r.id, error: e };
        state.unknown.push(`fake node: ${e.message}`);
        return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: `fake node: ${e.message}` } };
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  const count = (method: string) => state.seen.filter((m) => m === method).length;
  const reset = () => {
    state.seen.length = 0; state.inner.length = 0; state.callBlocks.length = 0; state.logRanges.length = 0;
    state.requests = 0;
  };

  return { state, fetch, count, reset };
}
