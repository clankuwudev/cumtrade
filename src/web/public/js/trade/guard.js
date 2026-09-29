import {
  APPROVE_AHEAD_EXPIRY_S, FACTORIES, MAX_DEADLINE_S, NATIVE, PERMIT2, READ, SEL, SETTLE_ALL, SLIPPAGE_MAX_BPS,
  SWAP_EXACT_IN_SINGLE, TAKE_ALL, UNIVERSAL_ROUTER, V4_SWAP,
} from "./constants.js";
import {
  addressAt, boolAt, bytesArrayAt, bytesAt, encBytes, encBytesArray, encTuple, hexBody, int24At, sizeAt, splitCall,
  uintAt, word,
} from "./abi.js";
import { readQuote } from "./quote.js";
import { readIdentity } from "./verify.js";

// ====================================================================== //
// the signer's trade check (P4 T2)                                       //
// ====================================================================== //
//
// verify.js checks a plan against what the visitor asked for, before any
// wallet opens. This runs later and lower down: inside the trading wallet's
// facade (scripts/vendor/wallet-entry.js), on the one transaction about to be
// signed, with no plan and no intent. It accepts the shapes cumTrade sends
// and refuses everything else (P2e, finding 1):
//
//   - approve(spender, amount) on a clank.trade token, to Permit2, the
//     Universal Router, or that token's own curve;
//   - Permit2 approve(a clank.trade token, the Universal Router, amount, expiry within a week);
//   - a curve's buy or sell, paying the signer, on a curve the factory registry lists;
//   - the Universal Router's execute with exactly one V4 swap (swap, settle
//     all, take all) of ETH against a clank.trade token, in a pool with its
//     factory's hook that the chain can price;
//   - for every trade, a minimum out no lower than the chain's own quote,
//     read now, less the page's widest slippage (SLIPPAGE_MAX_BPS), so a
//     trade can't be signed wide open to a sandwich;
//   - a plain send of ETH only to the wallet the person logged in with
//     (Withdraw all; the user, 2026-09-26: "Only to the login wallet").
//
// Curves and tokens are checked on chain, over the RPC the caller gives: the
// facade gives its own, to the pinned public RPCs. It is a speed bump against
// a script calling our provider, not a boundary: a script on the origin can
// reach Coinbase without the facade (P2e). The Coinbase project policy (T3)
// is the backstop for the rest, but by the user's choice it allows plain sends
// and any approve, so for those two this check is the only one.

/** A transaction this check will not let be signed. */
export class Refused extends Error {}

const refuse = (why) => { throw new Refused(`Refused: ${why}. Nothing was signed.`); };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const byte = (n) => n.toString(16).padStart(2, "0");
/** ABI data has one encoding for each value; any other (dirty bits, moved offsets) is refused. */
const canonical = (got, want, what) => { if (got !== want) refuse(`${what} is not encoded the one way it can be`); };

/**
 * @typedef {{ to: string, data: string, value: bigint }} Tx
 * @typedef {{
 *   signer: string,
 *   withdrawTo: string | null,
 *   request: (args: { method: string, params?: unknown[] }) => Promise<any>,
 *   now: () => number,
 *   cache?: Map<string, any>,
 *   quote?: typeof readQuote,
 * }} Deps
 *
 * `quote` is quote.js's readQuote unless a test gives its own.
 */

/**
 * Which cumTrade shape `tx` is ("approve", "permit2-approve", "curve-buy",
 * "curve-sell", "router-swap" or "withdraw"), or a Refused error.
 *
 * @param {Tx} tx
 * @param {Deps} d
 */
export async function checkTrade(tx, d) {
  try {
    return await check(tx, d);
  } catch (e) {
    if (e instanceof Refused) throw e;
    // Data that doesn't decode, or a chain answer that doesn't: never a trade.
    refuse("its data, or the chain's answer about it, is not what a trade looks like");
  }
}

/** @param {Tx} tx @param {Deps} d */
async function check(tx, d) {
  const to = tx.to, data = tx.data ?? "0x", value = tx.value;
  if (typeof to !== "string" || !ADDRESS.test(to)) refuse("it names no contract to call");
  if (typeof value !== "bigint" || value < 0n) refuse("its value is not an amount");
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) refuse("its data is not hex");

  // Withdraw all: the only plain send, and only to the login wallet.
  if (data === "0x") {
    if (value > 0n && d.withdrawTo && same(to, d.withdrawTo) && !same(to, d.signer)) return "withdraw";
    refuse("ETH is sent only to the wallet you logged in with, by Withdraw all");
  }
  let call;
  try { call = splitCall(data); } catch { refuse("its data is not a function call"); }
  const { selector, args } = call;

  if (selector === SEL.erc20Approve) {
    const spender = addressAt(args, 0), amount = uintAt(args, 32);
    canonical(args, word(spender) + word(amount), "The approval");
    if (value !== 0n) refuse("an approval carries no ETH");
    const id = await genuineToken(to, d);
    if (same(spender, PERMIT2) || same(spender, UNIVERSAL_ROUTER)) return "approve";
    if (!same(spender, id.tokenCurve)) refuse(`the approval lets ${spender} move tokens, which is not Permit2, the router or this token's curve`);
    return "approve";
  }

  if (selector === SEL.permit2Approve) {
    if (!same(to, PERMIT2)) refuse("a Permit2 approval goes to Permit2");
    const token = addressAt(args, 0), spender = addressAt(args, 32);
    const amount = uintAt(args, 64, 160), expiration = uintAt(args, 96, 48);
    canonical(args, word(token) + word(spender) + word(amount) + word(expiration), "The Permit2 approval");
    if (value !== 0n) refuse("an approval carries no ETH");
    if (!same(spender, UNIVERSAL_ROUTER)) refuse(`the Permit2 approval lets ${spender} spend, not the Uniswap router`);
    await genuineToken(token, d);
    if (expiration > BigInt(Math.floor(d.now()) + APPROVE_AHEAD_EXPIRY_S)) refuse("the Permit2 approval lasts more than a week");
    return "permit2-approve";
  }

  if (selector === SEL.curveBuy || selector === SEL.curveSell) {
    const buy = selector === SEL.curveBuy;
    const amount = uintAt(args, 0), minOut = uintAt(args, 32), recipient = addressAt(args, 64);
    canonical(args, word(amount) + word(minOut) + word(recipient), `The ${buy ? "buy" : "sell"}`);
    if (!same(recipient, d.signer)) refuse(`the ${buy ? "buy" : "sell"} pays ${recipient}, not this wallet`);
    if (buy ? value !== amount : value !== 0n) refuse(`the ${buy ? "buy's ETH is not the amount it buys with" : "sell carries ETH"}`);
    const id = await genuineCurve(to, d);
    if (id.graduated) refuse("this token has left its curve for Uniswap");
    const own = await (d.quote ?? readQuote)(d.request, null,
      buy ? { side: "buy", from: d.signer, amountIn: String(amount) } : { side: "sell", from: d.signer, tokens: String(amount) }, id);
    floor(minOut, own, buy ? "buy" : "sell");
    return buy ? "curve-buy" : "curve-sell";
  }

  if (selector === SEL.execute) {
    if (!same(to, UNIVERSAL_ROUTER)) refuse("execute goes to the Uniswap router");
    await routerSwap(args, value, d, data);
    return "router-swap";
  }

  refuse(`it calls ${selector}, which is not one of cumTrade's trades`);
}

/** The Universal Router's execute: exactly one V4 swap of ETH against a clank.trade token, in its own pool. */
async function routerSwap(args, value, d, data) {
  const commands = bytesAt(args, 0), inputs = bytesArrayAt(args, 32), deadline = uintAt(args, 64);
  canonical(args, encTuple([{ tail: encBytes(commands) }, { tail: encBytesArray(inputs) }, { head: word(deadline) }]), "The router call");
  if (commands !== byte(V4_SWAP) || inputs.length !== 1) refuse(`the router is asked to run commands 0x${commands}, not one V4 swap`);
  if (deadline > BigInt(Math.floor(d.now()) + MAX_DEADLINE_S)) refuse("the swap's deadline is too far away");

  const input = inputs[0];
  const actions = bytesAt(input, 0), params = bytesArrayAt(input, 32);
  canonical(input, encTuple([{ tail: encBytes(actions) }, { tail: encBytesArray(params) }]), "The V4 input");
  if (actions !== [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].map(byte).join("") || params.length !== 3) {
    refuse(`the V4 actions are 0x${actions}, not swap, settle all, take all`);
  }
  const [swap, settle, take] = params;
  const at = sizeAt(swap, 0);
  const currency0 = addressAt(swap, at), currency1 = addressAt(swap, at + 32);
  const fee = uintAt(swap, at + 64, 24), tickSpacing = int24At(swap, at + 96), hooks = addressAt(swap, at + 128);
  const zeroForOne = boolAt(swap, at + 160);
  const amountIn = uintAt(swap, at + 192, 128), amountOutMinimum = uintAt(swap, at + 224, 128);
  // Robinhood's router reads a minHopPriceX36 before the hook data (V4R).
  const minHopPriceX36 = uintAt(swap, at + 256);
  const hookData = bytesAt(swap, at + 288, at);
  canonical(swap, encTuple([{
    tail: encTuple([
      { head: [currency0, currency1, fee, tickSpacing, hooks, zeroForOne ? 1n : 0n, amountIn, amountOutMinimum, minHopPriceX36].map(word).join("") },
      { tail: encBytes(hookData) },
    ]),
  }]), "The swap parameters");
  if (!same(currency0, NATIVE)) refuse("the swap's pool does not trade ETH");
  if (minHopPriceX36 !== 0n) refuse("the swap sets a per-hop price floor, which cumTrade never sends");
  if (hookData !== "") refuse("the swap passes data to the pool's hook");
  const [paid, received] = zeroForOne ? [NATIVE, currency1] : [currency1, NATIVE];
  const settleCurrency = addressAt(settle, 0), settleAmount = uintAt(settle, 32);
  canonical(settle, word(settleCurrency) + word(settleAmount), "The settle parameters");
  const takeCurrency = addressAt(take, 0), takeAmount = uintAt(take, 32);
  canonical(take, word(takeCurrency) + word(takeAmount), "The take parameters");
  if (!same(settleCurrency, paid) || settleAmount !== amountIn) refuse("the swap settles something other than what it puts in");
  if (!same(takeCurrency, received)) refuse("the swap takes something other than what it buys");
  if (takeAmount !== amountOutMinimum) refuse("the swap takes a different minimum than it swaps for");
  if (zeroForOne ? value !== amountIn : value !== 0n) refuse("the swap's ETH is not what it puts in");

  const id = await genuineToken(currency1, d);
  if (!id.graduated || !id.memeHook || !same(hooks, id.memeHook)) refuse("the swap's pool is not the one this token graduated into");
  // The pool is read by this very key (fee and tick spacing included): a key
  // no one initialised, or one with no liquidity, prices nothing and is refused.
  const own = await (d.quote ?? readQuote)(d.request, { steps: [{ data }] },
    zeroForOne ? { side: "buy", from: d.signer, amountIn: String(amountIn) } : { side: "sell", from: d.signer, tokens: String(amountIn) }, id);
  floor(amountOutMinimum, own, zeroForOne ? "buy" : "sell");
}

/**
 * A minimum out, against the chain's own figure for the trade: never nothing,
 * and never more than the page's widest slippage under it.
 */
function floor(minOut, own, what) {
  if (typeof own !== "bigint" || own <= 0n) refuse(`the chain prices this ${what} at nothing`);
  if (minOut * 10_000n < own * BigInt(10_000 - SLIPPAGE_MAX_BPS)) {
    refuse(`its minimum out is more than ${SLIPPAGE_MAX_BPS / 100}% under the chain's own price`);
  }
}

/** A clank.trade launch's reads, for a token, or a refusal. Cached per token for the session. */
async function genuineToken(token, d) {
  const key = `token:${token.toLowerCase()}`;
  if (d.cache?.has(key)) return d.cache.get(key);
  let r;
  try { r = await readIdentity(d.request, token); } catch { refuse(`${token} could not be checked on Robinhood Chain`); }
  const ok = ADDRESS.test(r.tokenCurve) && same(r.curveToken, token) && FACTORIES.some((f) => same(f, r.curveFactory))
    && r.registry && same(r.registry.token, token) && same(r.registry.curve, r.tokenCurve);
  if (!ok) refuse(`${token} is not a clank.trade launch`);
  // Graduation only goes one way, so a graduated answer is kept; an ungraduated one is read again next time.
  if (r.graduated) d.cache?.set(key, r);
  return r;
}

/** A clank.trade curve, checked through its token, or a refusal. */
async function genuineCurve(curve, d) {
  // Returns the token's reads.
  let tokenWord;
  try {
    tokenWord = hexBody(await d.request({ method: "eth_call", params: [{ to: curve, data: READ.token }, "latest"] }));
  } catch { refuse(`${curve} could not be checked on Robinhood Chain`); }
  const token = addressAt(tokenWord, 0);
  const r = await genuineToken(token, d);
  if (!same(r.tokenCurve, curve)) refuse(`${curve} is not this token's clank.trade curve`);
  return r;
}
