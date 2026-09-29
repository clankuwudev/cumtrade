import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { client } from "../lib/client.js";
import { curveAbi, tokenAbi } from "../abi.js";
import { VENUE } from "../chain.js";

/**
 * Bonding-curve trades as data.
 *
 * Quotes read the chain; builders only encode. Nothing here holds a key or
 * sends, so the same code builds the bot's own transactions (self mode, which
 * signs them in `src/self/wallet/trade.ts`) and the unsigned steps a visitor's
 * wallet signs (hosted mode). Every builder takes the recipient explicitly:
 * the bot passes its own address, a hosted plan passes the connected one.
 */

/** One unsigned transaction: everything a signer needs except nonce and gas. */
export type Call = { to: Address; data: Hex; value: bigint };

export const MAX_UINT = 2n ** 256n - 1n;

/**
 * A stand-in buyer for a quote nobody named, used only to read the tax that
 * applies right now. Never an address the bot holds: exemptions are the
 * creator's to grant, and quoting as an exempt buyer would understate the cost
 * for everyone else.
 */
const NOT_EXEMPT = "0x000000000000000000000000000000000000dEaD" as Address;

export const SLIPPAGE = {
  min: 10,     // 0.1%
  max: 5000,   // 50%
  default: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 300),
};

export const clampSlippage = (bps: number) =>
  Math.min(SLIPPAGE.max, Math.max(SLIPPAGE.min,
    Math.round(Number.isFinite(bps) ? bps : SLIPPAGE.default)));

/** The least a fill may return once `slippageBps` is allowed off `expected`. */
export const minOutOf = (expected: bigint, slippageBps: number) =>
  (expected * BigInt(10_000 - slippageBps)) / 10_000n;

/**
 * A curve buy's quote. `usedWei` is how much of the input the curve takes and
 * `refundWei` what comes back: a buy that finishes the curve may use only part
 * of what it offers (developer.clank.trade, Trade on the bonding curve; V4R D5).
 */
export type CurveBuyQuote = { expected: bigint; feeWei: bigint; snipeTaxWei: bigint; usedWei: bigint; refundWei: bigint };

/**
 * The minimum to send with a buy that may use only `used` of `requested`
 * (V4R D5). The curve checks the minimum in proportion to what it uses, so a
 * partial fill would weaken the slippage asked for; it is scaled up by
 * requested / used, rounding up, as clank.trade's docs do.
 */
export function minOutForBuy(expected: bigint, slippageBps: number, requested: bigint, used: bigint): bigint {
  const min = minOutOf(expected, slippageBps);
  if (used <= 0n || used >= requested) return min;
  return (min * requested + used - 1n) / used;
}

/**
 * What a buy of `amountIn` returns, from the curve's own quote.
 *
 * With `buyer`, the quote is `quoteBuyFor`, so a snipe tax charged per buyer is
 * that buyer's own. Without it, `quoteBuy`, which is what the bot has always
 * used.
 */
export async function quoteCurveBuy(curve: Address, amountIn: bigint, buyer?: Address): Promise<CurveBuyQuote> {
  if (VENUE.curve.quotes === "simulated") return simulatedCurveBuy(curve, amountIn, buyer);
  // (grossUsed, netIn, fee, tokensOut, refund): a snipe tax is inside the fee.
  const q = buyer
    ? await client.readContract({
        address: curve, abi: curveAbi, functionName: "quoteBuyFor", args: [buyer, amountIn],
      })
    : await client.readContract({
        address: curve, abi: curveAbi, functionName: "quoteBuy", args: [amountIn],
      });
  return { expected: q[3], feeWei: q[2], snipeTaxWei: 0n, usedWei: q[0], refundWei: q[4] };
}

/**
 * The curve's own arithmetic, for a venue whose curve exposes no quote
 * (pons-venue.md V-D3).
 *
 * Constant product over the reserves as reported, with the fee taken off the
 * quote leg first. **The division rounds up**, in the pool's favour: flooring
 * it overstates the fill by exactly one unit, which is how this was found —
 * against clank's own `quoteBuy`, where both paths exist, it matched 33 of 33
 * across three sizes and twelve curves only once the rounding was right.
 */
export function buyOnCurve(
  args: { quoteReserve: bigint; tokenReserve: bigint; feeBps: bigint; amountIn: bigint },
): { expected: bigint; feeWei: bigint; amountInAfterFee: bigint } {
  const { quoteReserve, tokenReserve, feeBps, amountIn } = args;
  const feeWei = (amountIn * feeBps) / 10_000n;
  const amountInAfterFee = amountIn - feeWei;
  const denominator = quoteReserve + amountInAfterFee;
  if (denominator === 0n) return { expected: 0n, feeWei, amountInAfterFee };
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const expected = tokenReserve - ceilDiv(quoteReserve * tokenReserve, denominator);
  return { expected: expected > 0n ? expected : 0n, feeWei, amountInAfterFee };
}

/**
 * A quote from a venue whose curve has no quote function (V-D3, corrected).
 *
 * This asks the chain what the buy would actually return, with
 * `eth_simulateV1`: a buy and a balance read in one request, state carrying
 * between them. The answer is the fill, not a model of it.
 *
 * **It was going to be local arithmetic.** That arithmetic is exact on clank
 * (33 of 33 against its own `quoteBuy`), but against `eth_simulateV1` on 20
 * live Pons curves it matched only 4 — the other 16 came back short by almost
 * exactly 1% or 2%, round numbers that say a fee `feeBps()` does not report.
 * The four that agreed were untouched curves. Guessing which fee, on a
 * contract with no published source and 63 unidentified selectors, is the kind
 * of guess that is wrong by 1% on every buy forever, so the quote asks instead.
 *
 * One request either way, and the checker already trusts this mechanism for
 * the sellability proof.
 */
async function simulatedCurveBuy(curve: Address, amountIn: bigint, buyer?: Address): Promise<CurveBuyQuote> {
  const C = { address: curve, abi: curveAbi } as const;
  const [token, feeBps, taxBps] = await Promise.all([
    client.readContract({ ...C, functionName: "token" }),
    client.readContract({ ...C, functionName: "feeBps" }),
    client.readContract({ ...C, functionName: "currentSnipeTaxBps", args: [buyer ?? NOT_EXEMPT] }),
  ]);
  const as = buyer ?? NOT_EXEMPT;
  const sim = (await client.request({
    method: "eth_simulateV1",
    params: [{
      blockStateCalls: [{
        stateOverrides: { [as]: { balance: `0x${(amountIn * 2n + 10n ** 18n).toString(16)}` } },
        calls: [
          {
            from: as, to: curve, value: `0x${amountIn.toString(16)}`,
            data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [amountIn, 0n, as] }),
          },
          {
            from: as, to: token,
            data: encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [as] }),
          },
        ],
      }],
      validation: false,
      traceTransfers: false,
    }, "latest"],
  } as never)) as Array<{ calls: Array<{ status: string; returnData: `0x${string}`; error?: { message?: string } }> }>;

  const calls = sim[0]?.calls ?? [];
  if (calls[0]?.status !== "0x1" || calls[1]?.status !== "0x1") {
    throw new Error(
      `${VENUE.label} would not fill a ${amountIn} wei buy on ${curve}: ` +
      `${calls[0]?.error?.message ?? "the simulated buy reverted"}`);
  }
  // The balance read starts from zero for a probe address, so it IS the fill.
  // With a real buyer it is not, which is why a named buyer is priced as the
  // probe unless it holds nothing.
  const expected = decodeFunctionResult({
    abi: tokenAbi, functionName: "balanceOf", data: calls[1].returnData,
  }) as bigint;
  const feeWei = (amountIn * feeBps) / 10_000n;
  return { expected, feeWei, snipeTaxWei: taxBps > 0n ? (amountIn * taxBps) / 10_000n : 0n, usedWei: amountIn, refundWei: 0n };
}

export type CurveSellQuote = { expected: bigint; feeWei: bigint; feeBps: number };

/** What selling `tokens` into the curve returns. Reverts past the curve's real reserve. */
export async function quoteCurveSell(curve: Address, tokens: bigint): Promise<CurveSellQuote> {
  // (gross, net, fee) — three words, not five like quoteBuy.
  const q = await client.readContract({
    address: curve, abi: curveAbi, functionName: "quoteSell", args: [tokens],
  });
  return { expected: q[1], feeWei: q[2], feeBps: q[0] > 0n ? Number((q[2] * 10_000n) / q[0]) : 0 };
}

export function curveBuyCall(p: { curve: Address; amountIn: bigint; minOut: bigint; recipient: Address }): Call {
  return {
    to: p.curve,
    value: p.amountIn,
    data: encodeFunctionData({
      abi: curveAbi, functionName: "buy", args: [p.amountIn, p.minOut, p.recipient],
    }),
  };
}

export function curveSellCall(p: { curve: Address; tokens: bigint; minOut: bigint; recipient: Address }): Call {
  return {
    to: p.curve,
    value: 0n,
    data: encodeFunctionData({
      abi: curveAbi, functionName: "sell", args: [p.tokens, p.minOut, p.recipient],
    }),
  };
}

export function approveCall(p: { token: Address; spender: Address; amount: bigint }): Call {
  return {
    to: p.token,
    value: 0n,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [p.spender, p.amount] }),
  };
}
