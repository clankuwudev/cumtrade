import { QUOTE_TOLERANCE_BPS, READ, SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from "./constants.js";
import { addressAt, bytesArrayAt, hexBody, int24At, sizeAt, splitCall, uintAt, word } from "./abi.js";
import { keccak256 } from "./keccak.js";
import { Unpriceable, swapExactIn } from "./v4math.js";

// ====================================================================== //
// the page's own quote                                                   //
// ====================================================================== //
//
// The step verifier (verify.js) ties every signed minimum to the plan's
// quote, and the quote's minimum to its expected output. What it cannot tell
// is whether that expected output is true: an API that halves it, and halves
// the minimum to match, passes every one of its rules. So once a plan has
// passed them, the page works out what the trade should return from its own
// reads of the chain, through the visitor's provider, and refuses a plan that
// expects less than that by more than a small tolerance (F3.3).
//
// - A curve buy asks the curve's own quoteBuyFor(from, amountIn), and a curve
//   sell its own quoteSell(tokens). The server reads the first itself. For the
//   second it does reserve arithmetic, which can come out a wei above the
//   curve's (the curve rounds the new reserve up), so its plans pass.
// - A V4 swap is priced here (v4math.js), from the pool's state read through
//   the PoolManager's extsload. The server simulates the swap instead, which
//   a wallet may not pass through to its RPC; eth_call it will.
//
// A figure this cannot work out is never a pass: readQuote throws, and the
// sequence refuses the plan.

/** Hook permissions (the low bits of a hook's address) that let it change a swap's price or amounts. */
const SWAP_FLAGS = (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n); // beforeSwap, afterSwap, and their returns-delta flags

/** v4-core's PoolManager: `mapping(PoolId => Pool.State) _pools` is slot 6; a State's liquidity, ticks and bitmap follow its slot0. */
const POOLS_SLOT = 6n, LIQUIDITY = 3n, TICKS = 4n, BITMAP = 5n;

/** Return data of exactly `n` words. Anything else is not the answer to the call made. */
function answer(hex, n) {
  if (hex.length !== 64 * n) throw new Unpriceable(`the chain answered ${hex.length / 2} bytes where ${32 * n} were expected`);
  return hex;
}

const slotOf = (hex) => BigInt(`0x${hex}`);

/** eth_call through the visitor's provider, as lowercase hex without 0x. */
const caller = (request) => async (to, data) => hexBody(await request({ method: "eth_call", params: [{ to, data }, "latest"] }));

/**
 * One V4 pool's state, read through the PoolManager's extsload. Exported for
 * the tests, which hold each slot to the chain's real bytes.
 *
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} request EIP-1193
 * @param {string} manager the PoolManager
 * @param {{ currency0: string, currency1: string, fee: bigint | number, tickSpacing: number, hooks: string }} key
 */
export function poolReader(request, manager, key) {
  const call = caller(request);
  const id = keccak256([key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks].map(word).join(""));
  const state = slotOf(keccak256(id + word(POOLS_SLOT)));
  const load = async (slot) => uintAt(answer(await call(manager, READ.extsload + word(slot)), 1), 0);
  return {
    slot0: () => load(state),
    liquidity: async () => (await load(state + LIQUIDITY)) & ((1n << 128n) - 1n),
    /** A tick bitmap word. */
    word: (pos) => load(slotOf(keccak256(word(pos) + word(state + BITMAP)))),
    /** A tick's first slot: liquidityGross in the low 128 bits, liquidityNet (signed) in the high. */
    tickNet: async (tick) => BigInt.asIntN(128, (await load(slotOf(keccak256(word(tick) + word(state + TICKS))))) >> 128n),
  };
}

/** The pool key of a router swap the verifier has already passed. */
function poolKey(data) {
  const { args } = splitCall(data);
  const [input] = bytesArrayAt(args, 32);
  const [swap] = bytesArrayAt(input, 32);
  const at = sizeAt(swap, 0);
  return {
    currency0: addressAt(swap, at), currency1: addressAt(swap, at + 32),
    fee: uintAt(swap, at + 64, 24), tickSpacing: Number(int24At(swap, at + 96)), hooks: addressAt(swap, at + 128),
  };
}

/**
 * What the chain says this trade returns now: tokens for a buy, wei for a
 * sell. Call it only with a plan `verifyPlan` has passed and the reads it
 * passed with, since it prices the curve and the pool those name.
 *
 * Every read goes through `request`, the visitor's own EIP-1193 provider (a
 * browser wallet today, an embedded wallet later). A read that fails, an
 * answer of the wrong shape, or a pool this page cannot model throws.
 *
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} request EIP-1193
 * @param {any} plan
 * @param {{ side: "buy" | "sell", from: string, amountIn?: string, tokens?: string }} intent
 * @param {{ graduated: boolean, tokenCurve: string, curveFactory: string }} reads from readIdentity
 * @returns {Promise<bigint>}
 */
export async function readQuote(request, plan, intent, reads) {
  const call = caller(request);
  const buy = intent.side === "buy";
  const amount = BigInt(buy ? intent.amountIn : intent.tokens);

  if (!reads.graduated) {
    // quoteBuyFor → (amountIn, amountInAfterFee, fee, tokensOut, snipeTax); quoteSell → (gross, net, fee).
    return buy
      ? uintAt(answer(await call(reads.tokenCurve, READ.quoteBuyFor + word(intent.from) + word(amount)), 5), 96)
      : uintAt(answer(await call(reads.tokenCurve, READ.quoteSell + word(amount)), 3), 32);
  }

  const key = poolKey(plan.steps[plan.steps.length - 1].data);
  if ((BigInt(key.hooks) & SWAP_FLAGS) !== 0n) {
    throw new Unpriceable(`the pool's hook ${key.hooks} can change a swap, so this page cannot price it`);
  }
  // A manager with no code (the zero address included) answers every read
  // with no bytes, which `answer` refuses.
  const manager = addressAt(answer(await call(reads.curveFactory, READ.poolManager), 1), 0);
  const pool = poolReader(request, manager, key);
  const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
  // slot0: the price in the low 160 bits, then the tick, the protocol fee and the LP fee, 24 bits each.
  const swap = await swapExactIn({
    sqrtPriceX96: slot0 & ((1n << 160n) - 1n),
    tick: Number(BigInt.asIntN(24, slot0 >> 160n)),
    protocolFee: Number((slot0 >> 184n) & 0xffffffn),
    lpFee: Number((slot0 >> 208n) & 0xffffffn),
    liquidity,
  }, { tickSpacing: key.tickSpacing, zeroForOne: buy, amountIn: amount, word: pool.word, tickNet: pool.tickNet });
  return swap.amountOut;
}

// ---------------------------------------------------------------- check --

const pct = (bps) => `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Refuse a plan that expects less than the page's own figure `own`, by more
 * than the smaller of QUOTE_TOLERANCE_BPS and the visitor's slippage. A plan
 * that expects more passes: its minimum is higher, and the worst it can do is
 * revert.
 *
 * @param {any} plan
 * @param {{ slippageBps: number }} intent
 * @param {bigint} own from readQuote
 * @returns {{ ok: true } | { ok: false, step: null, rule: string, reason: string }}
 */
export function verifyQuote(plan, intent, own) {
  const refuse = (rule, reason) => ({ ok: false, step: null, rule, reason });
  if (typeof own !== "bigint" || own <= 0n) {
    return refuse("quote-read", `Your wallet's reads of the chain say this trade returns ${String(own)}.`);
  }
  const expectedOut = plan && typeof plan === "object" && plan.quote && typeof plan.quote === "object" ? plan.quote.expectedOut : undefined;
  if (typeof expectedOut !== "string" || !/^(0|[1-9][0-9]*)$/.test(expectedOut)) {
    return refuse("quote", `The plan's expected output is not a whole number: ${JSON.stringify(expectedOut)}.`);
  }
  const slip = intent && intent.slippageBps;
  if (!Number.isInteger(slip) || slip < SLIPPAGE_MIN_BPS || slip > SLIPPAGE_MAX_BPS) {
    return refuse("intent", `Slippage must be between ${SLIPPAGE_MIN_BPS} and ${SLIPPAGE_MAX_BPS} bps.`);
  }
  const expected = BigInt(expectedOut);
  const t = BigInt(Math.min(QUOTE_TOLERANCE_BPS, slip));
  if (expected * 10_000n < own * (10_000n - t)) {
    return refuse("quote",
      `The server expects ${expected}, but your wallet's reads of the chain give ${own}: ` +
      `${pct(((own - expected) * 10_000n) / own)} less, where at most ${pct(t)} is allowed. ` +
      "If the price just moved, try again.");
  }
  return { ok: true };
}
