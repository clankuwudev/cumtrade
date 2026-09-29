// The page's own quote (public-release F3.3).
//
// readQuote is run against real chain bytes: every eth_call it makes is
// answered from fixtures/quote-chain.json, which holds the public node's
// answers at one block, and anything else it asks throws. The expected figures
// are the curve's own answers and, for V4, what eth_simulateV1 actually
// delivered for the same swaps at the same block. So these tests cannot share
// a mistake with a fake node built from our own ABI.
//
// verifyQuote is then checked at its boundary, and against the one lie F3.1
// could not see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, keccak256, parseAbi } from "viem";
import { QUOTE_TOLERANCE_BPS, READ } from "../public/js/trade/constants.js";
import { poolReader, readQuote, verifyQuote } from "../public/js/trade/quote.js";
import { verifyPlan } from "../public/js/trade/verify.js";
import { closeSwap, recall, reswap } from "./support/calldata.js";

const real = JSON.parse(readFileSync(new URL("./fixtures/quote-chain.json", import.meta.url), "utf8"));
const { chain, plans } = JSON.parse(readFileSync(new URL("./fixtures/plans.json", import.meta.url), "utf8"));
const fixture = (name) => structuredClone(plans.find((p) => p.name === name));

const lower = (a) => String(a).toLowerCase();
const NATIVE = "0x0000000000000000000000000000000000000000";
const curveAbi = parseAbi([
  "function quoteBuyFor(address, uint256) view returns (uint256, uint256, uint256, uint256, uint256)",
  "function quoteSell(uint256) view returns (uint256 gross, uint256 net, uint256 fee)",
]);

// --------------------------------------------------------- the real chain --

/**
 * An EIP-1193 provider that answers eth_call from the recorded transcript.
 * `edit(to, data, result)` may change an answer or throw; `result` is
 * undefined for a call the transcript does not have. Every request is logged,
 * and a call left without an answer throws.
 */
function replay(edit = (to, data, result) => result, calls = real.calls) {
  const log = [];
  const answers = new Map(calls.map((c) => [`${c.to} ${c.data}`, c.result]));
  return {
    log,
    request: async ({ method, params }) => {
      log.push(method === "eth_call" ? { method, to: lower(params[0].to), data: lower(params[0].data), tag: params[1] } : { method });
      if (method !== "eth_call") throw new Error(`the quote may not call ${method}`);
      const [to, data] = [lower(params[0].to), lower(params[0].data)];
      const out = edit(to, data, answers.get(`${to} ${data}`));
      if (out === undefined) throw new Error(`not in the transcript: ${to} ${data.slice(0, 40)}…`);
      return out;
    },
  };
}

const curveReads = { graduated: false, tokenCurve: real.curve.curve, curveFactory: real.factory };
const v4Reads = { graduated: true, tokenCurve: real.v4.curve, curveFactory: real.factory };

/** A plan whose last step is a router swap on CABO's pool (only that step is read), with `hooks` swappable. */
function v4Plan(side, amountIn, hooks = real.v4.hook) {
  const data = closeSwap({
    commands: "0x10", deadline: 1n << 40n, actions: "0x060c0f", key: [NATIVE, real.v4.token, real.v4.fee, real.v4.tickSpacing, hooks],
    zeroForOne: side === "buy", amountIn, minOut: 1n, hookData: "0x",
    settle: side === "buy" ? [NATIVE, amountIn] : [real.v4.token, amountIn], take: side === "buy" ? [real.v4.token, 1n] : [NATIVE, 1n],
    moreInputs: [], moreParams: [],
  });
  return { steps: [{ kind: "router-swap", data }] };
}
const v4Intent = (side, amount) => side === "buy"
  ? { side, from: real.probe, amountIn: String(amount), slippageBps: 500 }
  : { side, from: real.probe, tokens: String(amount), slippageBps: 500 };

/** The storage slots of CABO's pool, computed with viem rather than the page's keccak. */
const SLOTS = (() => {
  const id = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [NATIVE, real.v4.token, real.v4.fee, real.v4.tickSpacing, real.v4.hook]));
  const state = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
  const hex = (n) => n.toString(16).padStart(64, "0");
  const bitmap = (w) => keccak256(encodeAbiParameters([{ type: "int16" }, { type: "uint256" }], [w, state + 5n])).slice(2);
  const tick = (t) => keccak256(encodeAbiParameters([{ type: "int24" }, { type: "uint256" }], [t, state + 4n])).slice(2);
  return { slot0: hex(state), liquidity: hex(state + 3n), bitmap, tick };
})();
const extsloads = (log) => log.filter((r) => r.data.startsWith(READ.extsload)).map((r) => r.data.slice(10));

// ------------------------------------------------------------ the curve --

test("a curve buy is the curve's own quoteBuyFor for this buyer, in one eth_call", async () => {
  const p = replay();
  const own = await readQuote(p.request, fixture("curve buy").plan,
    { side: "buy", from: real.probe, amountIn: real.curve.buy.amountIn, slippageBps: 500 }, curveReads);
  const call = real.calls.find((c) => c.data.startsWith(READ.quoteBuyFor));
  const words = decodeFunctionResult({ abi: curveAbi, functionName: "quoteBuyFor", data: call.result });
  assert.equal(own, words[3], "tokensOut, the fourth word");
  assert.equal(own, 6006557275036072791197850n);
  assert.deepEqual(p.log.map((r) => [r.method, r.to, r.data.slice(0, 10), r.tag]), [["eth_call", lower(real.curve.curve), READ.quoteBuyFor, "latest"]]);
});

test("a curve sell is the curve's own quoteSell, and the server's reserve arithmetic is at most a wei above it", async () => {
  const p = replay();
  const own = await readQuote(p.request, fixture("curve sell with approval").plan,
    { side: "sell", from: real.probe, tokens: real.curve.sell.tokens, slippageBps: 500 }, curveReads);
  const call = real.calls.find((c) => c.data.startsWith(READ.quoteSell));
  assert.equal(own, decodeFunctionResult({ abi: curveAbi, functionName: "quoteSell", data: call.result })[1], "quoteOutNet");
  assert.equal(p.log.length, 1);

  // prepare.ts: gross = quoteReserve − k / (tokenReserve + tokens), less the fee. The
  // curve rounds that division up, so the server can be one wei high, never low.
  const r = Object.fromEntries(Object.entries(real.curve.reserves).map(([k, v]) => [k, BigInt(v)]));
  const t = BigInt(real.curve.sell.tokens), k = r.quoteReserve * r.tokenReserve;
  const server = ((r.quoteReserve - k / (r.tokenReserve + t)) * (10_000n - r.feeBps)) / 10_000n;
  assert.equal(server - own, 1n, "one wei above, at this block");
  assert.deepEqual(verifyQuote({ quote: { expectedOut: server.toString() } }, { slippageBps: 10 }, own), { ok: true });
});

// ---------------------------------------------------------------- V4 --

for (const s of real.v4.swaps) {
  test(`V4 ${s.name}: the page's figure is the real fill, to the wei`, async () => {
    const p = replay();
    const own = await readQuote(p.request, v4Plan(s.side, BigInt(s.amountIn)), v4Intent(s.side, s.amountIn), v4Reads);
    assert.equal(own, BigInt(s.fill));
    assert.ok(p.log.every((r) => r.method === "eth_call" && r.tag === "latest"));
    assert.equal(p.log[0].to, lower(real.factory), "the pool manager comes from the verified factory");
    assert.equal(p.log[0].data, READ.poolManager);
  });
}

test("V4 reads are the pool's slot0 and liquidity, then the bitmap words the swap walks through", async () => {
  const walk = async (name) => {
    const s = real.v4.swaps.find((x) => x.name.startsWith(name));
    const p = replay();
    await readQuote(p.request, v4Plan(s.side, BigInt(s.amountIn)), v4Intent(s.side, s.amountIn), v4Reads);
    return extsloads(p.log);
  };
  const { slot0, liquidity, bitmap } = SLOTS;
  // CABO sits at tick 164401: compressed 822, in bitmap word 3.
  assert.deepEqual(await walk("buy 0.01"), [slot0, liquidity, bitmap(3)]);
  assert.deepEqual(await walk("buy 10"), [slot0, liquidity, bitmap(3), bitmap(2)], "a large buy crosses down into word 2");
  assert.deepEqual(await walk("sell 800M"), [slot0, liquidity, bitmap(3), bitmap(4)], "a large sell crosses up into word 4");
});

test("a tick's net liquidity is read from its own slot: CABO's full range, from real bytes", async () => {
  // No swap on CABO can reach its only initialised ticks, so they are read directly.
  const p = replay(undefined, real.ticks.calls);
  const pool = poolReader(p.request, real.ticks.manager,
    { currency0: NATIVE, currency1: real.v4.token, fee: real.v4.fee, tickSpacing: real.v4.tickSpacing, hooks: real.v4.hook });
  const L = await pool.liquidity();
  assert.equal(L, 30672463220289302387998n);
  assert.equal(await pool.tickNet(-887200), L, "the position's lower tick adds its liquidity");
  assert.equal(await pool.tickNet(887200), -L, "and its upper tick takes it away");
  assert.deepEqual(extsloads(p.log), [SLOTS.liquidity, SLOTS.tick(-887200), SLOTS.tick(887200)]);
});

// ------------------------------------------------ every failure throws --

const hexWords = (...ws) => `0x${ws.map((w) => BigInt(w).toString(16).padStart(64, "0")).join("")}`;
const buy01 = real.v4.swaps[0];
// Each names the reason it must fail with, so one guard cannot stand in for another.
const failures = [
  ["the wallet's RPC failing on a curve quote", "curve buy", () => { throw new Error("rpc down"); }, /rpc down/],
  ["a curve buy answered with four words", "curve buy", (to, data, r) => (data.startsWith(READ.quoteBuyFor) ? r.slice(0, 2 + 64 * 4) : r), /answered 128 bytes where 160/],
  ["a curve buy answered with six words", "curve buy", (to, data, r) => (data.startsWith(READ.quoteBuyFor) ? r + "00".repeat(32) : r), /answered 192 bytes where 160/],
  ["a curve sell answered with two words", "curve sell", (to, data, r) => (data.startsWith(READ.quoteSell) ? r.slice(0, 2 + 64 * 2) : r), /answered 64 bytes where 96/],
  ["a curve answer that is not hex", "curve sell", () => "0xzz", /not hex/],
  // A node answers a call to an address without code with no bytes.
  ["a factory that names no pool manager", "v4", (to, data, r) => (data === READ.poolManager ? hexWords(0) : to === NATIVE ? "0x" : r), /answered 0 bytes/],
  ["a pool manager with dirty high bits", "v4", (to, data, r) => (data === READ.poolManager ? `0x01${r.slice(4)}` : r), /wider than 160 bits/],
  ["a pool manager answer of the wrong length", "v4", (to, data, r) => (data === READ.poolManager ? r + "00".repeat(32) : r), /answered 64 bytes where 32/],
  ["a pool that is not initialised", "v4", (to, data, r) => (data === READ.extsload + SLOTS.slot0 ? hexWords(0) : r), /not initialised/],
  ["an empty storage answer", "v4", (to, data, r) => (data.startsWith(READ.extsload) && data.endsWith(SLOTS.liquidity) ? "0x" : r), /answered 0 bytes/],
  ["a bitmap read that fails", "v4", (to, data, r) => { if (data === READ.extsload + SLOTS.bitmap(3)) throw new Error("rate limited"); return r; }, /rate limited/],
];
for (const [what, kind, edit, why] of failures) {
  test(`throws, rather than pricing, on ${what}`, async () => {
    const p = replay(edit);
    const run = kind === "curve buy"
      ? readQuote(p.request, null, { side: "buy", from: real.probe, amountIn: real.curve.buy.amountIn }, curveReads)
      : kind === "curve sell"
        ? readQuote(p.request, null, { side: "sell", from: real.probe, tokens: real.curve.sell.tokens }, curveReads)
        : readQuote(p.request, v4Plan("buy", BigInt(buy01.amountIn)), v4Intent("buy", buy01.amountIn), v4Reads);
    await assert.rejects(run, why);
  });
}

// A hook's permissions are the low bits of its address.
for (const [flag, bit] of [["beforeSwap", 7], ["afterSwap", 6], ["beforeSwapReturnDelta", 3], ["afterSwapReturnDelta", 2]]) {
  test(`refuses to price a pool whose hook has ${flag}, before reading anything`, async () => {
    const hook = `0x${(BigInt(real.v4.hook) | (1n << BigInt(bit))).toString(16).padStart(40, "0")}`;
    const p = replay();
    await assert.rejects(readQuote(p.request, v4Plan("buy", 10n ** 16n, hook), v4Intent("buy", 10n ** 16n), v4Reads), /hook/);
    assert.equal(p.log.length, 0);
  });
}

// ------------------------------------------------------------ the check --

const own = 10n ** 24n;
const planExpecting = (expectedOut) => ({ quote: { expectedOut: String(expectedOut) } });
const check = (expectedOut, slippageBps, o = own) => verifyQuote(planExpecting(expectedOut), { slippageBps }, o);

test("the tolerance is 1%, or the visitor's slippage when that is smaller, and the boundary is exact", () => {
  assert.equal(QUOTE_TOLERANCE_BPS, 100);
  for (const [slip, t] of [[500, 100n], [100, 100n], [99, 99n], [50, 50n], [10, 10n], [5000, 100n]]) {
    const least = (own * (10_000n - t)) / 10_000n; // own is a round number, so this is exact
    assert.deepEqual(check(least, slip), { ok: true }, `slippage ${slip}: the least that passes`);
    const r = check(least - 1n, slip);
    assert.equal(r.ok, false, `slippage ${slip}: one less`);
    assert.equal(r.rule, "quote");
    assert.equal(r.step, null);
    assert.match(r.reason, /If the price just moved, try again\.$/);
  }
});

test("the boundary rounds in the page's favour when the figure does not divide", () => {
  const o = 12_345_678_901_234_567n;
  const least = (o * 9_900n + 9_999n) / 10_000n; // ⌈o × 0.99⌉
  assert.deepEqual(check(least, 500, o), { ok: true });
  assert.equal(check(least - 1n, 500, o).ok, false);
});

test("a plan expecting more than the page's figure passes", () => {
  assert.deepEqual(check(own * 2n, 500), { ok: true });
  assert.deepEqual(check(own, 10), { ok: true });
});

test("no figure, or a figure of nothing, refuses as a failure to price", () => {
  for (const bad of [0n, -1n, 5, undefined, null, "1000"]) {
    const r = verifyQuote(planExpecting(own), { slippageBps: 500 }, bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.rule, "quote-read", String(bad));
  }
});

test("a plan without a whole-number expected output refuses", () => {
  for (const bad of ["", " 1", "1.5", "01", "-1", "0x10", 1, undefined]) {
    const r = verifyQuote({ quote: { expectedOut: bad } }, { slippageBps: 500 }, own);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.rule, "quote", JSON.stringify(bad));
  }
  for (const bad of [null, {}, { quote: null }, "plan"]) assert.equal(verifyQuote(bad, { slippageBps: 500 }, own).rule, "quote");
});

test("slippage outside what the server allows refuses", () => {
  for (const bad of [9, 5001, 500.5, "500", undefined, NaN]) {
    const r = verifyQuote(planExpecting(own), { slippageBps: bad }, own);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.rule, "intent", String(bad));
  }
  assert.equal(verifyQuote(planExpecting(own), null, own).rule, "intent");
});

// --------------------------------------------- the lie F3.1 let through --

/** Reads as readIdentity would make them on the fixture chain. */
function fixtureReads(plan) {
  const row = chain.tokens[plan.token];
  return {
    chainId: 4663, now: plan.preparedAt, tokenCurve: lower(row.curve), curveToken: lower(plan.token),
    curveFactory: lower(chain.factory), graduated: row.graduated,
    registry: { token: lower(plan.token), curve: lower(row.curve) }, memeHook: lower(chain.memeHook),
  };
}

for (const name of ["curve buy", "curve sell with approval", "v4 buy", "v4 sell with both approvals"]) {
  test(`${name}: expecting 10% less, with a minimum to match, passes F3.1 and is refused here`, () => {
    const { plan, intent } = fixture(name);
    const truth = BigInt(plan.quote.expectedOut);
    const expected = (truth * 90n) / 100n;
    const minOut = (expected * BigInt(10_000 - intent.slippageBps)) / 10_000n;
    plan.quote.expectedOut = expected.toString();
    plan.quote.minOut = minOut.toString();
    const swap = plan.steps.at(-1);
    swap.data = swap.kind === "router-swap"
      ? reswap(swap.data, (s) => { s.minOut = minOut; s.take[1] = minOut; })
      : recall(swap.data, (a) => (a[1] = minOut, a));
    assert.deepEqual(verifyPlan(plan, intent, fixtureReads(plan)), { ok: true }, "F3.1 cannot see it");
    const r = verifyQuote(plan, intent, truth);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "quote");
    assert.match(r.reason, /10% less, where at most 1% is allowed/);
  });
}
