/**
 * The page's pinned constants against the server's — public-release F3.1.
 *
 * The step verifier in src/web/public/js/trade/ trusts a handful of addresses,
 * selectors and V4 command bytes that it cannot import from src/core, because
 * the page has no build step. This checks every one of them against the chain
 * config, the ABIs, and calldata the server's own builders produce, so the
 * page and the server cannot drift apart. The verifier's limits (expiry,
 * deadline, gas) are policy, not mirrors, and verify.test.js pins them at
 * their boundaries.
 *
 * Pure: no server, no network.
 *
 *   npm run test:constants
 */
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, toFunctionSelector, type AbiFunction, type Hex } from "viem";

// Pins are compared with the builders' defaults, never an override.
delete process.env.UNIVERSAL_ROUTER;
delete process.env.PERMIT2;

// A variable specifier: the page's modules are plain JS with no declarations.
const pagePath = "../../web/public/js/trade/constants.js";
const page = await import(pagePath) as Record<string, any>;
const { robinhood, FACTORIES } = await import("../chain.js");
const { curveAbi, factoryAbi, tokenAbi } = await import("../abi.js");
const v4 = await import("./v4.js");
const curve = await import("./curve.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const same = (name: string, got: unknown, want: unknown) =>
  ok(name, got === want, got === want ? String(got) : `page ${String(got)}, server ${String(want)}`);

/** The selector of `name` in a core ABI. */
const selectorIn = (abi: readonly unknown[], name: string) =>
  toFunctionSelector((abi as AbiFunction[]).find((x) => x.type === "function" && x.name === name)!);

const A = (s: string) => getAddress(`0x${s.padStart(40, "0")}`);
const TOKEN = A("70a1"), CURVE = A("c0a1"), FROM = A("a11ce");

console.log("\nthe chain and the contracts");
same("chain id", page.CHAIN_ID, robinhood.id);
// The trading wallet reads and broadcasts through it, straight from the page (W1.1).
same("the public RPC", page.PUBLIC_RPC, robinhood.rpcUrls.default.http[0]);
ok("…and it is https, on another origin than ours", /^https:\/\/[^/]+$/.test(page.PUBLIC_RPC), page.PUBLIC_RPC);
same("Universal Router, checksummed", page.UNIVERSAL_ROUTER, v4.UNIVERSAL_ROUTER);
same("Permit2, checksummed", page.PERMIT2, v4.PERMIT2);
same("native ETH", page.NATIVE, v4.NATIVE);
ok("the factories are exactly the server's list, in its order",
  JSON.stringify(page.FACTORIES) === JSON.stringify(FACTORIES.map((f) => f.address)), JSON.stringify(page.FACTORIES));

console.log("\nwhat the builders actually encode");
const [erc20Approve, permit2Approve] = v4.approvalCalls(TOKEN, 5n, { erc20Amount: 5n, expiration: 1n });
same("ERC20 approve, as v4.approvalCalls sends it", page.SEL.erc20Approve, erc20Approve!.data.slice(0, 10));
same("ERC20 approve, as curve.approveCall sends it", page.SEL.erc20Approve,
  curve.approveCall({ token: TOKEN, spender: CURVE, amount: 5n }).data.slice(0, 10));
same("Permit2 approve", page.SEL.permit2Approve, permit2Approve!.data.slice(0, 10));
same("curve buy", page.SEL.curveBuy, curve.curveBuyCall({ curve: CURVE, amountIn: 5n, minOut: 1n, recipient: FROM }).data.slice(0, 10));
same("curve sell", page.SEL.curveSell, curve.curveSellCall({ curve: CURVE, tokens: 5n, minOut: 1n, recipient: FROM }).data.slice(0, 10));

const key = { currency0: v4.NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 200, hooks: A("400b") };
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
for (const [side, data] of [["buy", v4.buildBuy(key, 5n, 1n, 9n)], ["sell", v4.buildSell(key, 5n, 1n, 9n)]] as const) {
  same(`router execute (${side})`, page.SEL.execute, data.slice(0, 10));
  const [commands, inputs] = decodeFunctionData({ abi: routerAbi, data }).args;
  same(`the V4 swap command (${side})`, `0x${page.V4_SWAP.toString(16).padStart(2, "0")}`, commands);
  const [actions] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0] as Hex);
  const want = [page.SWAP_EXACT_IN_SINGLE, page.SETTLE_ALL, page.TAKE_ALL].map((b: number) => b.toString(16).padStart(2, "0")).join("");
  same(`swap, settle all, take all (${side})`, `0x${want}`, actions);
}

console.log("\nthe reads, against the ABIs the server reads with");
same("token curve()", page.READ.curve, selectorIn(tokenAbi, "curve"));
same("curve token()", page.READ.token, selectorIn(curveAbi, "token"));
same("curve factory()", page.READ.factory, selectorIn(curveAbi, "factory"));
same("curve graduated()", page.READ.graduated, selectorIn(curveAbi, "graduated"));
same("factory getLaunchedToken(address)", page.READ.getLaunchedToken, selectorIn(factoryAbi, "getLaunchedToken"));
same("factory memeHook()", page.READ.memeHook, selectorIn(factoryAbi, "memeHook"));
same("token balanceOf(address)", page.READ.balanceOf, selectorIn(tokenAbi, "balanceOf"));
same("token allowance(address,address)", page.READ.allowance, selectorIn(tokenAbi, "allowance"));
same("Permit2 allowance(address,address,address), as v4.allowances reads it", page.READ.permit2Allowance,
  toFunctionSelector("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"));
// The page's own quote (F3.3).
same("curve quoteBuyFor(address,uint256), as prepare.ts reads it", page.READ.quoteBuyFor, selectorIn(curveAbi, "quoteBuyFor"));
same("curve quoteSell(uint256)", page.READ.quoteSell, selectorIn(curveAbi, "quoteSell"));
same("factory poolManager(), as v4.ts reads it", page.READ.poolManager, selectorIn(factoryAbi, "poolManager"));
same("PoolManager extsload(bytes32), as v4.ts reads it", page.READ.extsload,
  toFunctionSelector("function extsload(bytes32 slot) view returns (bytes32)"));

console.log("\neach selector is the signature it names");
for (const [k, sig] of Object.entries({
  erc20Approve: "approve(address,uint256)", permit2Approve: "approve(address,address,uint160,uint48)",
  curveBuy: "buy(uint256,uint256,address)", curveSell: "sell(uint256,uint256,address)",
  execute: "execute(bytes,bytes[],uint256)",
})) same(`SEL.${k} is ${sig}`, page.SEL[k], toFunctionSelector(`function ${sig}`));

console.log("\nthe slippage the server clamps to");
same("minimum", page.SLIPPAGE_MIN_BPS, curve.SLIPPAGE.min);
same("maximum", page.SLIPPAGE_MAX_BPS, curve.SLIPPAGE.max);

console.log("\nnothing unchecked");
const checked = new Set([
  "CHAIN_ID", "PUBLIC_RPC", "UNIVERSAL_ROUTER", "PERMIT2", "NATIVE", "FACTORIES", "SEL", "READ", "V4_SWAP",
  "SWAP_EXACT_IN_SINGLE", "SETTLE_ALL", "TAKE_ALL", "SLIPPAGE_MIN_BPS", "SLIPPAGE_MAX_BPS",
  // Policy, pinned at their boundaries by verify.test.js and quote.test.js.
  "MAX_APPROVE_EXPIRY_S", "MAX_DEADLINE_S", "MAX_GAS", "QUOTE_TOLERANCE_BPS",
  // The trading wallet's policy, pinned at its boundaries by embedded.test.js
  // and approveAhead.test.js.
  "MAX_BASE_FEE_WEI", "MAX_SENDS_PER_MINUTE", "APPROVE_AHEAD_EXPIRY_S", "APPROVE_AHEAD_RENEW_S",
  // The page's fast RPC, which session.test.js pins as the one reads go to first.
  "FAST_RPC",
]);
const extra = Object.keys(page).filter((k) => !checked.has(k));
ok("every export is covered here or by verify.test.js, quote.test.js, embedded.test.js and approveAhead.test.js", extra.length === 0, extra.join(", "));
ok("SEL has exactly the five calls", Object.keys(page.SEL).length === 5);
ok("READ has exactly the thirteen reads", Object.keys(page.READ).length === 13);

console.log(failures === 0
  ? "\n\x1b[32mall constant checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
