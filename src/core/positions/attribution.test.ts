/**
 * Trade attribution — which curve events are really a wallet's own trades.
 *
 * Two layers. The synthetic cases pin the rule in attribution.ts against every
 * shape a trade can take: direct, routed, and a stranger's trade that merely
 * names this wallet. The live case pins the assumption the rule stands on —
 * that on the deployed curve topic1 is msg.sender and topic2 the recipient —
 * by simulating a routed buy and sell and feeding the real log bytes through
 * `attribute`. If the contract ever changes that layout, the synthetic cases
 * would keep passing against a rule that no longer describes the chain, so the
 * live case is the one that catches it.
 *
 *   npx tsx src/core/positions/attribution.test.ts
 */
import { toFunctionSelector, type Address, type Hex } from "viem";
import {
  attribute, logFilters, BUY_TOPIC, SELL_TOPIC, TRANSFER_TOPIC,
  type RawLog, type TxContext,
} from "./attribution.js";
import "dotenv/config";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}` +
    (detail ? `  \x1b[90m${detail}\x1b[0m` : ""));
};

const OWNER = "0x00000000000000000000000000000000000000Aa" as Address; // mixed case on purpose
const STRANGER = "0x00000000000000000000000000000000000000bb" as Address;
const ROUTER = "0x00000000000000000000000000000000000000cc" as Address;
const CURVE = "0x00000000000000000000000000000000000000c0" as Address;
const TOKEN = "0x0000000000000000000000000000000000000070" as Address;
const OTHER_TOKEN = "0x0000000000000000000000000000000000000071" as Address;

const pad = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const u = (v: bigint) => v.toString(16).padStart(64, "0");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const curveEvent = (
  kind: "buy" | "sell", caller: Address, recipient: Address, tx: number,
  opts: { block?: number; logIndex?: number; a?: bigint; b?: bigint; fee?: bigint } = {},
): RawLog => ({
  address: CURVE,
  topics: [kind === "buy" ? BUY_TOPIC : SELL_TOPIC, pad(caller), pad(recipient)],
  data: `0x${u(opts.a ?? 1000n)}${u(opts.b ?? 2000n)}${u(opts.fee ?? 10n)}${u(0n)}` as Hex,
  transactionHash: hash(tx),
  blockNumber: `0x${(opts.block ?? 100).toString(16)}` as Hex,
  logIndex: `0x${(opts.logIndex ?? 0).toString(16)}` as Hex,
});

const transfer = (token: Address, from: Address, to: Address, tx: number): RawLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad(from), pad(to)],
  data: `0x${u(500n)}` as Hex,
  transactionHash: hash(tx), blockNumber: "0x64" as Hex, logIndex: "0x0" as Hex,
});

const run = (logs: RawLog[], ctx: Record<number, TxContext> = {}) =>
  attribute(OWNER, logs,
    (tx) => Object.entries(ctx).find(([n]) => hash(Number(n)) === tx)?.[1],
    (curve) => (curve.toLowerCase() === CURVE.toLowerCase() ? TOKEN : undefined));

console.log("\nDirect trades\n");
{
  const t = run([curveEvent("buy", OWNER, OWNER, 1)]);
  ok("a direct buy is the owner's, with no receipt needed", t.length === 1 && t[0]!.kind === "buy");

  // A direct sell matches both sell filters, so the same event arrives twice.
  const s = curveEvent("sell", OWNER, OWNER, 2);
  ok("a direct sell fetched by two filters is booked once", run([s, s]).length === 1);

  ok("a sale whose proceeds go elsewhere is still the owner's sale",
    run([curveEvent("sell", OWNER, STRANGER, 3)]).length === 1);

  const d = run([curveEvent("buy", OWNER, OWNER, 4, { a: 5n * 10n ** 15n, b: 3n * 10n ** 24n, fee: 5n * 10n ** 13n })])[0]!;
  ok("amounts decode from the data words",
    d.amountIn === 5n * 10n ** 15n && d.amountOut === 3n * 10n ** 24n && d.fee === 5n * 10n ** 13n);
}

console.log("\nRouted trades\n");
{
  ok("a routed buy the owner sent is the owner's",
    run([curveEvent("buy", ROUTER, OWNER, 10)], { 10: { from: OWNER, logs: [] } }).length === 1);

  ok("a routed sell that moved the owner's tokens is the owner's",
    run([curveEvent("sell", ROUTER, OWNER, 11)],
      { 11: { from: OWNER, logs: [transfer(TOKEN, OWNER, ROUTER, 11)] } }).length === 1);
}

console.log("\nStrangers' trades that merely name the owner\n");
{
  ok("a purchase delivered to the owner but paid by a stranger is not booked",
    run([curveEvent("buy", STRANGER, OWNER, 20)], { 20: { from: STRANGER, logs: [] } }).length === 0);

  ok("a stranger's sale paid out to the owner is not booked",
    run([curveEvent("sell", STRANGER, OWNER, 21)],
      { 21: { from: STRANGER, logs: [transfer(TOKEN, STRANGER, CURVE, 21)] } }).length === 0);

  ok("a routed sell is not booked on a transfer of a different token",
    run([curveEvent("sell", ROUTER, OWNER, 22)],
      { 22: { from: OWNER, logs: [transfer(OTHER_TOKEN, OWNER, ROUTER, 22)] } }).length === 0);

  ok("with no receipt to prove otherwise, a topic2-only event is not booked",
    run([curveEvent("buy", ROUTER, OWNER, 23), curveEvent("sell", ROUTER, OWNER, 24)]).length === 0);

  ok("an event naming the owner nowhere is ignored",
    run([curveEvent("buy", STRANGER, STRANGER, 25)]).length === 0);
}

console.log("\nOrdering and filters\n");
{
  const t = run([
    curveEvent("sell", OWNER, OWNER, 30, { block: 200, logIndex: 1 }),
    curveEvent("buy", OWNER, OWNER, 31, { block: 100, logIndex: 5 }),
    curveEvent("buy", OWNER, OWNER, 32, { block: 200, logIndex: 0 }),
  ]);
  ok("trades come back oldest first, by block then log index",
    t.map((x) => `${x.block}:${x.logIndex}`).join(",") === "100:5,200:0,200:1",
    t.map((x) => `${x.block}:${x.logIndex}`).join(","));

  const f = logFilters(OWNER);
  const either = f[0]![0] as Hex[];
  ok("filters fetch buys and proceeds delivered to the owner in one query, and sales by the owner",
    f.length === 2 &&
    Array.isArray(either) && either.length === 2 && either[0] === BUY_TOPIC && either[1] === SELL_TOPIC &&
    f[0]![1] === null && f[0]![2] === pad(OWNER) &&
    f[1]![0] === SELL_TOPIC && f[1]![1] === pad(OWNER) && f[1]!.length === 2);
}

console.log("\nLive curve — the event layout the rule depends on\n");
// Only with a node to ask (public-release O1.4a): a clone or CI with no .env
// skips it and says so. The chain's public node serves it too:
// RPC_URL=https://rpc.mainnet.chain.robinhood.com.
const RPC = process.env.RPC_URL;
if (!RPC) {
  console.log("  \x1b[90mskip  the live case: RPC_URL is unset\x1b[0m");
} else {
  // Any live, ungraduated curve works. This is a third party's launch, the
  // curve the page's quote test reads (src/web/test/fixtures/quote-chain.json).
  // If it graduates, the simulated buy reverts: pick another from the board.
  const LIVE_CURVE = "0x2b61d4d8f304fdd8353d87f097739420f9b7bfb9" as Address;
  const LIVE_TOKEN = "0xe1e17d8c662be09b05b9a0afaff2bccf59bcf719" as Address;
  const SIM_ROUTER = "0x000000000000000000000000000000000000c0de" as Address;
  const SIM_USER = "0x000000000000000000000000000000000000beef" as Address;
  const amt = 10n ** 15n;

  try {
    const rpc = async (method: string, params: unknown[]) => {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json() as { result?: unknown; error?: unknown };
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    };

    // The router buys for itself, approves, then sells with the proceeds sent
    // to the user — one routed buy and one routed sell against the real curve.
    const quote = await rpc("eth_call", [{
      to: LIVE_CURVE, data: `${toFunctionSelector("quoteBuy(uint256)")}${u(amt)}`,
    }, "latest"]).catch(() => null) as Hex | null;
    const tokens = quote && quote.length >= 2 + 64 * 4
      ? BigInt(`0x${quote.slice(2 + 3 * 64, 2 + 4 * 64)}`) / 2n
      : 10n ** 21n;

    const res = await rpc("eth_simulateV1", [{
      blockStateCalls: [{
        stateOverrides: { [SIM_ROUTER]: { balance: "0x56bc75e2d63100000" } },
        calls: [
          { from: SIM_ROUTER, to: LIVE_CURVE, value: `0x${amt.toString(16)}`,
            data: `0x59a87bc1${u(amt)}${u(0n)}${pad(SIM_USER).slice(2)}` },
          { from: SIM_ROUTER, to: LIVE_CURVE, value: `0x${amt.toString(16)}`,
            data: `0x59a87bc1${u(amt)}${u(0n)}${pad(SIM_ROUTER).slice(2)}` },
          { from: SIM_ROUTER, to: LIVE_TOKEN, data: `0x095ea7b3${pad(LIVE_CURVE).slice(2)}${"f".repeat(64)}` },
          { from: SIM_ROUTER, to: LIVE_CURVE,
            data: `0xd04c6983${u(tokens)}${u(0n)}${pad(SIM_USER).slice(2)}` },
        ],
      }],
      validation: false, traceTransfers: false,
    }, "latest"]) as Array<{ calls: Array<{ status: string; logs: RawLog[] }> }>;

    const calls = res[0]!.calls;
    ok("the simulated routed buy and sell both succeed",
      calls.every((c) => c.status === "0x1"), calls.map((c) => c.status).join(" "));

    const buy = calls[0]!.logs.find((l) => l.topics[0] === BUY_TOPIC)!;
    const sell = calls[3]!.logs.find((l) => l.topics[0] === SELL_TOPIC)!;
    ok("Buy: topic1 is msg.sender, topic2 the recipient",
      buy.topics[1] === pad(SIM_ROUTER) && buy.topics[2] === pad(SIM_USER));
    ok("Sell: topic1 is msg.sender, topic2 the recipient",
      sell.topics[1] === pad(SIM_ROUTER) && sell.topics[2] === pad(SIM_USER));

    // Real log bytes through the real rule. The user sent the transaction that
    // called the router, so the routed buy is the user's and not the router's.
    const liveBuy = { ...buy, transactionHash: hash(900), blockNumber: "0x1" as Hex, logIndex: "0x0" as Hex };
    const asUser = attribute(SIM_USER, [liveBuy], () => ({ from: SIM_USER, logs: [] }),
      () => LIVE_TOKEN);
    const asRouter = attribute(SIM_ROUTER, [liveBuy], () => ({ from: SIM_USER, logs: [] }),
      () => LIVE_TOKEN);
    ok("a routed buy is credited to the user who sent it, not the router",
      asUser.length === 1 && asRouter.length === 0);
  } catch (e) {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  live simulation could not run: ${(e as Error).message.slice(0, 120)}`);
  }
}

console.log(`\n${failures === 0 ? "\x1b[32mall passed\x1b[0m" : `\x1b[31m${failures} failed\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
