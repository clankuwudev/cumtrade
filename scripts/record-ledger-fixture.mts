// Record what the chain answers for one ledger lookup, as a test fixture
// (public-release B3.2).
//
// Runs `buildLedger` for an address at a pinned block against the real nodes,
// with every JSON-RPC answer recorded on the way: the logs, the receipts
// (trimmed to the fields the ledger reads), the block times, and each call
// inside every Multicall3 eth_call. src/core/positions/fixtures/node.ts serves
// them back, so the ledger tests run on real chain bytes and no network.
//
// Read-only: nothing here signs or sends. Use a third-party address from
// public on-chain activity, never one of the operator's.
//
//   npx tsx scripts/record-ledger-fixture.mts --address 0x… [--to-block N] \
//     --out src/core/positions/fixtures/<name>.json --note "what it shows"
import { writeFileSync } from "node:fs";
import { decodeFunctionData, decodeFunctionResult, multicall3Abi, type Hex } from "viem";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const address = opt("address");
const out = opt("out");
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !out) {
  console.error("usage: --address 0x… --out <file> [--to-block N] [--note text]");
  process.exit(1);
}

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
type Req = { id: number; method: string; params: unknown[] };
type Log = { address: string; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex; logIndex: Hex };

const logs = new Map<string, Log>();
const receipts: Record<string, unknown> = {};
const blocks: Record<string, Hex> = {};
const calls: Record<string, { success: boolean; returnData: Hex }> = {};

const trimLog = (l: Log): Log => ({
  address: l.address, topics: l.topics, data: l.data,
  transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex,
});

function record(req: Req, result: unknown) {
  if (req.method === "eth_getLogs") {
    for (const l of result as Log[]) logs.set(`${l.transactionHash.toLowerCase()}:${l.logIndex}`, trimLog(l));
  } else if (req.method === "eth_getTransactionReceipt" && result) {
    const r = result as Record<string, unknown> & { logs: Log[] };
    receipts[String(req.params[0]).toLowerCase()] = {
      transactionHash: r.transactionHash, from: r.from, status: r.status,
      gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, logs: r.logs.map(trimLog),
    };
  } else if (req.method === "eth_getBlockByNumber" && result) {
    blocks[BigInt(req.params[0] as Hex).toString()] = (result as { timestamp: Hex }).timestamp;
  } else if (req.method === "eth_call") {
    const { to, data } = req.params[0] as { to: string; data: Hex };
    if (to.toLowerCase() === MULTICALL3) {
      const inner = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { target: string; callData: Hex }[];
      const res = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: result as Hex }) as
        readonly { success: boolean; returnData: Hex }[];
      inner.forEach((c, i) => {
        calls[`${c.target}|${c.callData}`.toLowerCase()] = { success: res[i]!.success, returnData: res[i]!.returnData };
      });
    } else {
      calls[`${to}|${data}`.toLowerCase()] = { success: true, returnData: result as Hex };
    }
  }
}

// Patient with the public node, which refuses bursts from one IP: requests
// start at least GAP_MS apart, and a 429 is waited out and sent again here, so
// the lookup never sees it. A recording is a one-off; a lookup is not.
const GAP_MS = Number(opt("gap-ms") ?? 1500);
const WAIT_MS = 20_000;
let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function patient(url: unknown, init?: { body?: unknown }): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + GAP_MS - Date.now();
    last = Math.max(Date.now(), last + GAP_MS);
    if (wait > 0) await sleep(wait);
    const res = await realFetch(url as string, init as RequestInit);
    const refused = res.status === 429 || /"code":\s*429|Too Many Requests/.test(await res.clone().text());
    if (!refused || attempt >= 8) return res;
    console.error(`  429, waiting ${WAIT_MS / 1000}s (attempt ${attempt + 1})`);
    await sleep(WAIT_MS);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
  const res = await patient(url, init);
  try {
    const sent = JSON.parse(String(init?.body)) as Req | Req[];
    const got = JSON.parse(await res.clone().text()) as { id: number; result?: unknown } | { id: number; result?: unknown }[];
    const reqs = Array.isArray(sent) ? sent : [sent];
    const answers = new Map((Array.isArray(got) ? got : [got]).map((a) => [a.id, a]));
    for (const r of reqs) {
      const a = answers.get(r.id);
      if (a && "result" in a) record(r, a.result);
    }
  } catch { /* not JSON-RPC, or refused: nothing to record */ }
  return res;
}) as typeof fetch;

// --curves a,b: record only what valuing a position on each curve reads (its
// state, and its V4 pool once graduated), for the payload tests (B3.5).
if (opt("curves")) {
  const { readState, valueAt } = await import("../src/core/positions/valuation.js");
  const curves = opt("curves")!.split(",") as Hex[];
  const tokens = (opt("tokens") ?? "").split(",").filter(Boolean) as Hex[];
  const states = await Promise.all(curves.map((c) => readState(c)));
  await Promise.all(states.map((s, i) => valueAt(s, 10n ** 24n, tokens[i])));
  writeFileSync(out, JSON.stringify({
    note: opt("note") ?? "", address: address.toLowerCase(), toBlock: "0",
    logs: [], receipts: {}, blocks: {}, calls,
  }, null, 1) + "\n");
  console.log(`recorded ${out}: ${Object.keys(calls).length} calls for ${curves.length} curve(s), ` +
    `graduated ${JSON.stringify(states.map((s) => s.graduated))}`);
  process.exit(0);
}

const { buildLedger } = await import("../src/core/positions/ledger.js");
const { historyRpc } = await import("../src/core/lib/historyRpc.js");
const toBlock = opt("to-block") ? BigInt(opt("to-block")!) : (await historyRpc.blockNumber()) - 20n;

const build = await buildLedger(address as Hex, { toBlock });
const fixture = {
  note: opt("note") ?? "",
  address: address.toLowerCase(),
  toBlock: toBlock.toString(),
  logs: [...logs.values()],
  receipts, blocks, calls,
};
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
const p = build.ledger.positions;
console.log(`recorded ${out}: ${fixture.logs.length} logs, ${Object.keys(receipts).length} receipts, ` +
  `${Object.keys(blocks).length} blocks, ${Object.keys(calls).length} calls`);
console.log(`  events ${build.events}, foreign ${build.foreign}, trades ${build.trades.length} ` +
  `(${build.trades.filter((t) => t.kind === "buy").length} buys), positions ${p.length}, ` +
  `open ${p.filter((x) => !x.closed).length}, confidence ${JSON.stringify(p.map((x) => x.confidence))}`);
console.log(`  history requests ${JSON.stringify(historyRpc.stats())}`);
