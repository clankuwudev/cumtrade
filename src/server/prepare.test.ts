/**
 * The prepare API — public-release B2.3.
 *
 * Hermetic. Global fetch is a fake JSON-RPC node whose chain each scenario sets:
 * balances, allowances, which curves have graduated, and how the simulation
 * turns out. Every plan is decoded step by step and checked against what the
 * visitor asked for, not against the plan's own description of itself: the
 * recipient is the visitor, no approval is unlimited, Permit2 allowances expire
 * within half an hour, and the router's deadline and minimum match the quote.
 * It also counts the RPC requests each prepare makes.
 *
 *   npm run test:prepare
 *   npm run test:prepare -- --fixtures   also write src/web/test/fixtures/plans.json,
 *                                        which the client verifier's tests read (F3.1)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodeAbiParameters, decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi,
  parseAbi, parseEther, toFunctionSelector, toHex,
  type Abi, type AbiFunction, type Address, type Hex,
} from "viem";

const WRITE_FIXTURES = process.argv.includes("--fixtures");
process.env.UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
process.env.PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
process.env.V4_GRAD_FEE = "3000";
process.env.V4_GRAD_TICK_SPACING = "200";
process.env.ALCHEMY_CU_PER_SEC = "1000000";
process.env.DEFAULT_SLIPPAGE_BPS = "300";

const { FACTORIES, robinhood } = await import("../core/chain.js");
const FIRST_FACTORY = getAddress(FACTORIES[0]!.address), SECOND_FACTORY = getAddress(FACTORIES[1]!.address);
const { curveAbi, tokenAbi, factoryAbi } = await import("../core/abi.js");

// ---------------------------------------------------------------------------
// the fake chain
// ---------------------------------------------------------------------------

const A = (s: string) => getAddress(`0x${s.padStart(40, "0")}`);
const FROM = A("a11ce");
const TOKEN = A("70a1"), CURVE = A("c0a1");               // a curve token on the board
const BONDED = A("70b2"), BONDED_CURVE = A("c0b2");       // graduated, and the board knows
const MOVED = A("70c3"), MOVED_CURVE = A("c0c3");         // graduated since the board looked
const OFFBOARD = A("70d4"), OFFBOARD_CURVE = A("c0d4");   // real, but not on the board
const FAKE = A("70e5"), FAKE_CURVE = A("c0e5");           // wired to another factory
const IMPOSTOR = A("70f6"), IMPOSTOR_CURVE = A("c0f6");   // claims the real factory, but it never launched them
const SECONDS = A("70a7"), SECONDS_CURVE = A("c0a7");     // launched by clank.trade's second factory (B1.5)
const CROSSED = A("70a8"), CROSSED_CURVE = A("c0a8");     // registered by the first factory, its curve names the second
const ROUTER = getAddress(process.env.UNIVERSAL_ROUTER!);
const PERMIT2 = getAddress(process.env.PERMIT2!);
const POOL_MANAGER = A("9a1"), HOOK = A("400b");
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const NATIVE_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const E18 = 10n ** 18n;

const curveOf: Record<string, Address> = {
  [TOKEN]: CURVE, [BONDED]: BONDED_CURVE, [MOVED]: MOVED_CURVE, [OFFBOARD]: OFFBOARD_CURVE, [FAKE]: FAKE_CURVE,
  [IMPOSTOR]: IMPOSTOR_CURVE, [SECONDS]: SECONDS_CURVE, [CROSSED]: CROSSED_CURVE,
};
const tokenOf = Object.fromEntries(Object.entries(curveOf).map(([t, c]) => [c, t as Address]));

const defaults = () => ({
  eth: 10n * E18,
  tokens: 100_000_000n * E18,
  curveAllowance: 0n,
  erc20ToPermit2: 0n,
  permit2Amount: 0n,
  permit2Expiration: 0,
  graduated: new Set<string>([BONDED_CURVE, MOVED_CURVE]),
  realQuote: 3n * 10n ** 17n,
  snipeTax: 0n,
  /** Index of the simulated call that reverts, if any. */
  revertAt: null as number | null,
});
let chain = defaults();

const extraAbi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const bySelector = new Map<Hex, AbiFunction>();
for (const item of [...curveAbi, ...tokenAbi, ...factoryAbi, ...extraAbi] as Abi) {
  if (item.type === "function" && !bySelector.has(toFunctionSelector(item))) bySelector.set(toFunctionSelector(item), item);
}

const counts = { eth_call: 0, eth_simulateV1: 0, other: 0 };

/** The token a router swap trades, read from its pool key. */
function swapToken(data: Hex): Address {
  const [, inputs] = decodeFunctionData({ abi: routerAbi, data }).args;
  const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
  const [[key]] = decodeAbiParameters(exactInSingle, params[0]!);
  return getAddress(key[1]);
}
const unexpected: string[] = [];

/**
 * What a buy delivers for `amountIn`: close to the fake curve's spot of 400M
 * tokens per ETH after its 1% fee, so price impact reads about half a percent.
 */
const buyOut = (amountIn: bigint) => amountIn * 394_000_000n;

/** One ABI word. */
const word = (v: bigint | number | string) => BigInt(v).toString(16).padStart(64, "0");

function read(to: Address, data: Hex): Hex {
  const fn = bySelector.get(data.slice(0, 10) as Hex);
  if (!fn) throw new Error(`unknown selector ${data.slice(0, 10)}`);
  const args = (decodeFunctionData({ abi: [fn], data }).args ?? []) as readonly unknown[];
  const t = getAddress(to);
  // The real factory answers with a registry struct, not the bool core/abi.ts
  // declares: token, curve, launch parameters, a status word. All zeros for an
  // address it never launched. Encoded by hand, so this fake cannot share the
  // ABI's mistake.
  // Each factory lists only what it launched: SECONDS by the second, the rest
  // by the first, and FAKE and IMPOSTOR by neither.
  if (fn.name === "getLaunchedToken") {
    const asked = getAddress(args[0] as string);
    const registrar = asked === SECONDS ? SECOND_FACTORY : FIRST_FACTORY;
    const listed = t === registrar && asked !== FAKE && asked !== IMPOSTOR && curveOf[asked];
    return `0x${listed
      ? word(asked) + word(curveOf[asked]!) + word(0).repeat(9) + word(1)
      : word(0).repeat(12)}` as Hex;
  }
  const result = ((): unknown => {
    switch (fn.name) {
      case "curve": return curveOf[t];
      case "symbol": return t === BONDED ? "BND" : "TKN";
      // Like the live chain: a token's factory() reverts, and only its curve says.
      case "factory":
        if (!tokenOf[t]) throw new Error("revert: token.factory() does not exist on the live chain");
        return t === FAKE_CURVE ? A("bad0")
          : t === SECONDS_CURVE || t === CROSSED_CURVE ? SECOND_FACTORY : FIRST_FACTORY;
      case "token": return tokenOf[t];
      case "balanceOf": return chain.tokens;
      case "allowance":
        if (fn.inputs.length === 3) return [chain.permit2Amount, chain.permit2Expiration, 0];
        return getAddress(args[1] as string) === PERMIT2 ? chain.erc20ToPermit2 : chain.curveAllowance;
      case "quoteReserve": return 2n * E18;
      case "tokenReserve": return 800_000_000n * E18;
      case "realQuoteReserve": return chain.realQuote;
      case "phantomQuote": return 168n * 10n ** 16n;
      case "feeBps": return 100n;
      case "graduationThreshold": return 42_764n * 10n ** 14n;
      case "graduated": return chain.graduated.has(t);
      case "quoteBuyFor": {
        if (chain.graduated.has(t)) throw new Error("revert: graduated");
        const amountIn = args[1] as bigint;
        return [amountIn, (amountIn * 99n) / 100n, amountIn / 100n, buyOut(amountIn), chain.snipeTax];
      }
      case "poolManager": return POOL_MANAGER;
      case "memeHook": return HOOK;
      case "extsload": return toHex((1n << 96n) | (3000n << 208n), { size: 32 });
    }
    throw new Error(`unanswered read ${fn.name}`);
  })();
  return encodeFunctionResult({ abi: [fn], functionName: fn.name, result } as never);
}

type Rpc = { id: number; method: string; params: unknown[] };
class Unsupported extends Error {}

async function answer(req: Rpc): Promise<unknown> {
  if (req.method === "eth_call") {
    counts.eth_call++;
    const { to, data } = req.params[0] as { to: Address; data: Hex };
    if (to.toLowerCase() !== MULTICALL3) return read(to, data);
    const d = decodeFunctionData({ abi: multicall3Abi, data });
    const balance = () => encodeFunctionResult({ abi: multicall3Abi, functionName: "getEthBalance", result: chain.eth });
    if (d.functionName === "getEthBalance") return balance();
    if (d.functionName === "aggregate3") {
      return encodeFunctionResult({
        abi: multicall3Abi, functionName: "aggregate3",
        result: (d.args[0] as readonly { target: Address; callData: Hex }[]).map((c) => {
          try {
            return { success: true, returnData: c.target.toLowerCase() === MULTICALL3 ? balance() : read(c.target, c.callData) };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
    throw new Error(`unexpected multicall ${d.functionName}`);
  }
  if (req.method === "eth_simulateV1") {
    counts.eth_simulateV1++;
    const calls = (req.params[0] as { blockStateCalls: { calls: { from: Address; to: Address; value: Hex; data: Hex }[] }[] })
      .blockStateCalls[0]!.calls;
    return [{
      calls: calls.map((c, i) => {
        if (chain.revertAt === i) return { status: "0x0", gasUsed: "0x5208", logs: [], error: { message: "execution reverted" } };
        const last = i === calls.length - 1;
        const me = `0x${c.from.slice(2).toLowerCase().padStart(64, "0")}`;
        const isBuy = BigInt(c.value) > 0n;
        const asset = !last ? null : !isBuy ? NATIVE_LOG : getAddress(c.to) === ROUTER ? swapToken(c.data) : tokenOf[getAddress(c.to)];
        const amount = isBuy ? buyOut(BigInt(c.value)) : 5n * 10n ** 17n;
        return {
          status: "0x1", gasUsed: toHex(150_000),
          logs: asset ? [{ address: asset, topics: [TRANSFER, `0x${"00".repeat(32)}`, me], data: toHex(amount, { size: 32 }) }] : [],
        };
      }),
    }];
  }
  counts.other++;
  switch (req.method) {
    case "eth_chainId": return "0x1237";
    case "eth_getLogs": throw new Error("eth_getLogs: the pool should have been found without a scan");
  }
  throw new Unsupported(req.method);
}

globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body)) as Rpc | Rpc[];
  const one = async (r: Rpc) => {
    try { return { jsonrpc: "2.0", id: r.id, result: await answer(r) }; }
    catch (e) {
      if (!(e instanceof Unsupported) && !String((e as Error).message).startsWith("revert")) unexpected.push((e as Error).message);
      return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: (e as Error).message } };
    }
  };
  const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const { prepareBuy, prepareSell } = await import("./prepare.js");
const { rows } = await import("./board.js");
type Plan = import("./prepare.js").Plan;

const row = (token: Address, curve: Address, over: Record<string, unknown> = {}) =>
  rows.set(token.toLowerCase(), {
    token, curve, status: "ready", graduated: false, sellable: true, band: "CLEAN", ...over,
  } as never);
row(TOKEN, CURVE);
row(BONDED, BONDED_CURVE, { graduated: true });
row(MOVED, MOVED_CURVE);

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

async function run(label: string, fn: () => ReturnType<typeof prepareBuy>) {
  const before = { ...counts };
  const out = await fn();
  const used = {
    eth_call: counts.eth_call - before.eth_call,
    eth_simulateV1: counts.eth_simulateV1 - before.eth_simulateV1,
  };
  console.log(`\n${label}  \x1b[90m${out.status} · ${used.eth_call} eth_call + ${used.eth_simulateV1} simulate\x1b[0m`);
  return { out, used };
}

const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const exactInSingle = [{
  type: "tuple", components: [
    { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
    { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" },
  ],
}] as const;

/** Decode every step and check it against what was asked, not what the plan says. */
function checkSteps(plan: Plan, want: { side: "buy" | "sell"; amount: bigint; token: Address }) {
  for (const s of plan.steps) {
    ok(`${s.id}: gas is set and within the cap`, BigInt(s.gas) > 0n && BigInt(s.gas) <= 3_000_000n, `${BigInt(s.gas)}`);
    if (s.kind === "curve-buy" || s.kind === "curve-sell") {
      const d = decodeFunctionData({ abi: curveAbi, data: s.data });
      const [amount, minOut, recipient] = d.args as readonly [bigint, bigint, Address];
      ok(`${s.id}: pays out to the visitor`, getAddress(recipient) === FROM, recipient);
      ok(`${s.id}: the amount is the one asked for`, amount === want.amount, `${amount}`);
      ok(`${s.id}: its minimum is the quote's`, minOut.toString() === plan.quote.minOut && minOut > 0n);
      ok(`${s.id}: ETH goes in only on a buy`, BigInt(s.value) === (s.kind === "curve-buy" ? want.amount : 0n));
      ok(`${s.id}: sent to the token's own curve`, getAddress(s.to) === curveOf[want.token]);
    }
    if (s.kind === "erc20-approve") {
      const [spender, amount] = decodeFunctionData({ abi: tokenAbi, data: s.data }).args as readonly [Address, bigint];
      ok(`${s.id}: approves exactly the amount, never unlimited`, amount === want.amount && amount !== MAX_UINT256, `${amount}`);
      ok(`${s.id}: the spender is the curve or Permit2`,
        getAddress(spender) === (plan.venue === "curve" ? curveOf[want.token] : PERMIT2), spender);
      ok(`${s.id}: sent to the token`, getAddress(s.to) === want.token);
    }
    if (s.kind === "permit2-approve") {
      const [token, spender, amount, expiration] = decodeFunctionData({ abi: permit2Abi, data: s.data }).args;
      ok(`${s.id}: for this token, to the router, for exactly the amount`,
        getAddress(token) === want.token && getAddress(spender) === ROUTER && amount === want.amount);
      ok(`${s.id}: expires within 1800s of preparedAt`,
        expiration > plan.preparedAt && expiration <= plan.preparedAt + 1800, `${expiration - plan.preparedAt}s`);
    }
    if (s.kind === "router-swap") {
      const [commands, inputs, deadline] = decodeFunctionData({ abi: routerAbi, data: s.data }).args;
      const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
      const [[key, zeroForOne, amountIn, minOut]] = decodeAbiParameters(exactInSingle, params[0]!);
      ok(`${s.id}: one V4 swap command`, commands === "0x10");
      ok(`${s.id}: deadline is expiresAt + 120s`, deadline === BigInt(plan.expiresAt + 120));
      ok(`${s.id}: the pool is ETH and this token, with the factory's hook`,
        key[0] === "0x0000000000000000000000000000000000000000" && getAddress(key[1]) === want.token && getAddress(key[4]) === HOOK);
      ok(`${s.id}: direction and amount match the side`, zeroForOne === (want.side === "buy") && amountIn === want.amount);
      ok(`${s.id}: its minimum is the quote's`, minOut.toString() === plan.quote.minOut && minOut > 0n);
      ok(`${s.id}: ETH goes in only on a buy`, BigInt(s.value) === (want.side === "buy" ? want.amount : 0n));
    }
  }
}

const fixtures: unknown[] = [];
const keep = (name: string, intent: Record<string, unknown>, plan: Plan) => fixtures.push({ name, intent, plan });

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

{
  chain = defaults();
  const amount = parseEther("0.01");
  const { out, used } = await run("curve buy", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "0.01", slippageBps: 500 }));
  ok("200", out.status === 200, JSON.stringify(out.body).slice(0, 120));
  if (out.status === 200) {
    const p = out.body;
    ok("venue curve, one curve-buy step", p.venue === "curve" && p.steps.length === 1 && p.steps[0]!.kind === "curve-buy");
    ok("quotes the buyer's own fee and expected tokens", p.quote.feeWei === (amount / 100n).toString() && p.quote.expectedOut === buyOut(amount).toString());
    ok("minOut is 5% under the quote", p.quote.minOut === ((buyOut(amount) * 9500n) / 10_000n).toString());
    ok("gas is the simulation's plus 30%", BigInt(p.steps[0]!.gas) === 195_000n);
    ok("expires 60s after it was prepared", p.expiresAt - p.preparedAt === 60);
    ok("no warnings on a clean token", p.warnings.length === 0, JSON.stringify(p.warnings));
    checkSteps(p, { side: "buy", amount, token: TOKEN });
    keep("curve buy", { side: "buy", from: FROM, token: TOKEN, amountIn: amount.toString(), slippageBps: 500 }, p);
  }
  ok("costs one eth_call and one simulation, wiring included", used.eth_call === 1 && used.eth_simulateV1 === 1, JSON.stringify(used));
}

{
  chain = defaults();
  const tokens = 20_000_000n * E18;
  const { out, used } = await run("curve sell, needs an approval", () => prepareSell({ from: FROM, token: TOKEN, tokens: tokens.toString(), slippageBps: 500 }));
  ok("200", out.status === 200, JSON.stringify(out.body).slice(0, 120));
  if (out.status === 200) {
    ok("steps: approve-token, then the sell", out.body.steps.map((s) => s.kind).join(",") === "erc20-approve,curve-sell");
    checkSteps(out.body, { side: "sell", amount: tokens, token: TOKEN });
    keep("curve sell with approval", { side: "sell", from: FROM, token: TOKEN, tokens: tokens.toString(), slippageBps: 500 }, out.body);
  }
  ok("costs one eth_call and one simulation", used.eth_call === 1 && used.eth_simulateV1 === 1, JSON.stringify(used));
}

{
  chain = { ...defaults(), curveAllowance: MAX_UINT256 };
  const { out } = await run("curve sell, allowance already in place (pct 50)", () => prepareSell({ from: FROM, token: TOKEN, pct: 50 }));
  if (out.status === 200) {
    ok("no approve step", out.body.steps.map((s) => s.kind).join(",") === "curve-sell");
    ok("sells half the balance", out.body.quote.amountIn === (chain.tokens / 2n).toString());
    ok("default slippage applies", out.body.quote.slippageBps === 300);
  } else ok("200", false, JSON.stringify(out.body));
}

{
  chain = { ...defaults(), tokens: 1_000_000_000n * E18 };
  const { out } = await run("curve sell larger than the real reserve", () => prepareSell({ from: FROM, token: TOKEN, tokens: (400_000_000n * E18).toString() }));
  if (out.status === 200) {
    const cap = (2n * E18 * 800_000_000n * E18) / (168n * 10n ** 16n) - 800_000_000n * E18;
    ok("capped warning", out.body.warnings.some((w) => w.code === "capped"));
    ok("sells exactly the cap", out.body.quote.amountIn === cap.toString(), out.body.quote.amountIn);
  } else ok("200", false, JSON.stringify(out.body));
}

{
  chain = defaults();
  const tokens = 7_000_000n * E18;
  await run("V4 sell, warming the pool wiring", () => prepareSell({ from: FROM, token: BONDED, tokens: tokens.toString() }));
  const { out, used } = await run("V4 sell, needs both approvals", () => prepareSell({ from: FROM, token: BONDED, tokens: tokens.toString(), slippageBps: 500 }));
  ok("200", out.status === 200, JSON.stringify(out.body).slice(0, 120));
  if (out.status === 200) {
    ok("steps: approve-token, approve-permit2, router-swap",
      out.body.steps.map((s) => s.kind).join(",") === "erc20-approve,permit2-approve,router-swap");
    ok("venue v4, with the pool's fee", out.body.venue === "v4" && BigInt(out.body.quote.feeWei) > 0n);
    checkSteps(out.body, { side: "sell", amount: tokens, token: BONDED });
    keep("v4 sell with both approvals", { side: "sell", from: FROM, token: BONDED, tokens: tokens.toString(), slippageBps: 500 }, out.body);
  }
  ok("costs one eth_call and one simulation once the pool wiring is cached", used.eth_call === 1 && used.eth_simulateV1 === 1, JSON.stringify(used));
}

{
  chain = { ...defaults(), erc20ToPermit2: MAX_UINT256, permit2Amount: MAX_UINT160, permit2Expiration: 2 ** 40 };
  const { out } = await run("V4 sell, approvals already in place", () => prepareSell({ from: FROM, token: BONDED, tokens: (1n * E18).toString() }));
  if (out.status === 200) ok("only the swap", out.body.steps.map((s) => s.kind).join(",") === "router-swap");
  else ok("200", false, JSON.stringify(out.body));
}

{
  chain = { ...defaults(), erc20ToPermit2: MAX_UINT256, permit2Amount: MAX_UINT160, permit2Expiration: 1 };
  const { out } = await run("V4 sell, Permit2 allowance expired", () => prepareSell({ from: FROM, token: BONDED, tokens: (1n * E18).toString() }));
  if (out.status === 200) ok("re-approves Permit2 only", out.body.steps.map((s) => s.kind).join(",") === "permit2-approve,router-swap");
  else ok("200", false, JSON.stringify(out.body));
}

{
  chain = defaults();
  const amount = parseEther("0.01");
  const { out, used } = await run("V4 buy", () => prepareBuy({ from: FROM, token: BONDED, amountEth: "0.01", slippageBps: 500 }));
  ok("200", out.status === 200, JSON.stringify(out.body).slice(0, 120));
  if (out.status === 200) {
    ok("one router swap, nothing to approve", out.body.steps.map((s) => s.kind).join(",") === "router-swap");
    ok("fee is the pool's 0.3% of the ETH in", out.body.quote.feeWei === ((amount * 3000n) / 1_000_000n).toString());
    checkSteps(out.body, { side: "buy", amount, token: BONDED });
    keep("v4 buy", { side: "buy", from: FROM, token: BONDED, amountIn: amount.toString(), slippageBps: 500 }, out.body);
  }
  ok("costs one eth_call and one simulation", used.eth_call === 1 && used.eth_simulateV1 === 1, JSON.stringify(used));
}

{
  chain = defaults();
  const { out } = await run("graduated since the board looked", () => prepareBuy({ from: FROM, token: MOVED, amountEth: "0.01" }));
  if (out.status === 200) {
    ok("routed to V4", out.body.venue === "v4" && out.body.steps[0]!.kind === "router-swap");
    ok("venue-changed warning", out.body.warnings.some((w) => w.code === "venue-changed"));
  } else ok("200", false, JSON.stringify(out.body));
}

{
  chain = defaults();
  rows.delete(TOKEN.toLowerCase());
  await run("off-board token, first prepare", () => prepareBuy({ from: FROM, token: OFFBOARD, amountEth: "0.01" }));
  const { out, used } = await run("off-board token, second prepare", () => prepareBuy({ from: FROM, token: OFFBOARD, amountEth: "0.01" }));
  row(TOKEN, CURVE);
  ok("200 without a board row", out.status === 200);
  ok("once its wiring is cached: two eth_call rounds and one simulation", used.eth_call === 2 && used.eth_simulateV1 === 1, JSON.stringify(used));
}

{
  chain = { ...defaults(), revertAt: 0 };
  const { out } = await run("the simulation reverts", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "0.01" }));
  ok("422 simulation-failed, naming the step", out.status === 422 && (out.body as { code: string }).code === "simulation-failed"
    && /the buy reverted/.test((out.body as { text: string }).text), JSON.stringify(out.body));
}

{
  chain = { ...defaults(), revertAt: 0 };
  const { out } = await run("a sell whose approval reverts", () => prepareSell({ from: FROM, token: TOKEN, tokens: (1n * E18).toString() }));
  ok("422, and the text names the approval", out.status === 422 && /Let the curve move/.test((out.body as { text: string }).text), JSON.stringify(out.body));
}

{
  chain = { ...defaults(), eth: 0n };
  const { out, used } = await run("a wallet with no ETH", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "0.01" }));
  ok("422 insufficient-funds", out.status === 422 && (out.body as { code: string }).code === "insufficient-funds", JSON.stringify(out.body));
  ok("…refused before simulating", used.eth_simulateV1 === 0);
}

{
  chain = { ...defaults(), tokens: 0n };
  const { out } = await run("a sell with nothing held", () => prepareSell({ from: FROM, token: TOKEN, pct: 100 }));
  ok("422 no-balance", out.status === 422 && (out.body as { code: string }).code === "no-balance", JSON.stringify(out.body));
}

{
  chain = defaults();
  const first = await run("a token wired to another factory", () => prepareBuy({ from: FROM, token: FAKE, amountEth: "0.01" }));
  const again = await run("…asked again", () => prepareBuy({ from: FROM, token: FAKE, amountEth: "0.01" }));
  ok("422 not-authentic", first.out.status === 422 && (first.out.body as { code: string }).code === "not-authentic", JSON.stringify(first.out.body));
  ok("a failed check is not cached: the second ask reads the chain again", again.used.eth_call > 0, JSON.stringify(again.used));
}

{
  chain = defaults();
  const { out } = await run("an address that is not a launch token at all", () => prepareBuy({ from: FROM, token: A("dead"), amountEth: "0.01" }));
  ok("422 not-authentic, not an RPC error", out.status === 422 && (out.body as { code: string }).code === "not-authentic", JSON.stringify(out.body));
}

{
  chain = defaults();
  const { out } = await run("a self-consistent impostor the factory never launched", () => prepareBuy({ from: FROM, token: IMPOSTOR, amountEth: "0.01" }));
  ok("422 not-authentic: only the factory's registry can tell", out.status === 422 && (out.body as { code: string }).code === "not-authentic", JSON.stringify(out.body));
}

{
  chain = defaults();
  const { out } = await run("a launch from clank.trade's second factory", () => prepareBuy({ from: FROM, token: SECONDS, amountEth: "0.01" }));
  ok("200: its own factory's registry lists it", out.status === 200, JSON.stringify(out.body).slice(0, 160));
  ok("…and the buy goes to its own curve", out.status === 200 && getAddress(out.body.steps.at(-1)!.to) === SECONDS_CURVE,
    out.status === 200 ? out.body.steps.at(-1)!.to : "");
}

{
  chain = defaults();
  const { out } = await run("a curve naming the second factory for a token only the first listed", () => prepareBuy({ from: FROM, token: CROSSED, amountEth: "0.01" }));
  ok("422 not-authentic: one factory's entry never stands in for another's", out.status === 422 && (out.body as { code: string }).code === "not-authentic", JSON.stringify(out.body));
}

{
  chain = { ...defaults(), snipeTax: 10n ** 14n, realQuote: 41n * 10n ** 17n };
  row(TOKEN, CURVE, { sellable: false, band: "AVOID" });
  const { out } = await run("warnings on a risky buy", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "0.01" }));
  row(TOKEN, CURVE);
  const codes = out.status === 200 ? out.body.warnings.map((w) => w.code).sort().join(",") : "";
  ok("band-avoid, near-graduation, sell-sim-failed and snipe-tax", codes === "band-avoid,near-graduation,sell-sim-failed,snipe-tax", codes);
}

{
  chain = defaults();
  console.log("\nmalformed requests");
  const cases: [string, () => ReturnType<typeof prepareBuy>][] = [
    ["from is not an address", () => prepareBuy({ from: "me", token: TOKEN, amountEth: "0.01" })],
    ["amountEth is not a number", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "lots" })],
    ["amountEth is zero", () => prepareBuy({ from: FROM, token: TOKEN, amountEth: "0" })],
    ["a sell with neither tokens nor pct", () => prepareSell({ from: FROM, token: TOKEN })],
    ["pct over 100", () => prepareSell({ from: FROM, token: TOKEN, pct: 150 })],
  ];
  for (const [name, fn] of cases) {
    const out = await fn();
    ok(`${name} → 400`, out.status === 400, JSON.stringify(out.body));
  }
}

ok("the fake node saw nothing it does not serve", unexpected.length === 0 && counts.other === 0,
  `${unexpected.join("; ")} other=${counts.other}`);

if (WRITE_FIXTURES) {
  const file = fileURLToPath(new URL("../web/test/fixtures/plans.json", import.meta.url));
  mkdirSync(fileURLToPath(new URL("../web/test/fixtures/", import.meta.url)), { recursive: true });
  // The fake chain goes with the plans, so the client verifier's fake provider
  // answers from the same addresses these plans were prepared against.
  const fakeChain = {
    chainId: robinhood.id, factory: FIRST_FACTORY, memeHook: HOOK,
    tokens: Object.fromEntries([TOKEN, BONDED].map((t) => [t, { curve: curveOf[t]!, graduated: defaults().graduated.has(curveOf[t]!) }])),
  };
  writeFileSync(file, JSON.stringify({ chain: fakeChain, plans: fixtures }, null, 2) + "\n");
  console.log(`\nwrote ${fixtures.length} plans and their fake chain to ${file}`);
}

console.log(failures === 0
  ? "\n\x1b[32mall prepare checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
