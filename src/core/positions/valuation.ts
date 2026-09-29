import { encodeFunctionData, type Address } from "viem";
import { client } from "../lib/client.js";
import { curveAbi } from "../abi.js";
import type { Position } from "./accounting.js";

/**
 * What an open position is worth, and what its P&L is made of (public-release
 * B3.4). Moved from exit.ts, bodies unchanged, so any address's position can be
 * valued without the bot's exit rules (self/engine/exitRules.ts) or its
 * environment: nothing here reads .env, and hosted reaches it.
 */

/**
 * What a round trip costs before the market does anything, as a percentage of
 * what left the wallet: f on the way in, then f on the (1-f) that survived.
 */
export const roundTripDragPct = (feeBps: number) => {
  const f = feeBps / 10_000;
  return (2 * f - f * f) * 100;
};

/** How far price must move for a round trip to break even: 1/(1-f)^2 - 1. */
export const breakevenMovePct = (feeBps: number) => {
  const f = feeBps / 10_000;
  return f >= 1 ? Infinity : (1 / ((1 - f) * (1 - f)) - 1) * 100;
};

/** The launchpad's standard curve fee, used where no specific curve is in hand. */
export const STANDARD_FEE_BPS = 100;

export type CurveState = {
  quoteReserve: bigint; tokenReserve: bigint; realQuote: bigint;
  phantom: bigint; feeBps: bigint; threshold: bigint;
  graduated: boolean; readyToGraduate: boolean;
};

const GETTERS = [
  "quoteReserve", "tokenReserve", "realQuoteReserve", "phantomQuote",
  "feeBps", "graduationThreshold", "graduated", "readyToGraduate",
] as const;

const PROBE = "0x00000000000000000000000000000000000c1a4e" as Address;

/**
 * Read curve reserves. With `entryWei`, the reads happen AFTER a simulated buy
 * of that size inside a single eth_simulateV1 — which is what makes a dry-run
 * position value correctly. Without it, a paper position on a curve nobody has
 * bought reads back as -100%, because the ETH it "spent" was never there.
 */
export async function readState(curve: Address, entryWei?: bigint): Promise<CurveState> {
  const calls = GETTERS.map((fn) => ({
    from: PROBE, to: curve, value: "0x0",
    data: encodeFunctionData({ abi: curveAbi, functionName: fn }),
  }));

  let words: bigint[];
  if (entryWei && entryWei > 0n) {
    const buy = {
      from: PROBE, to: curve, value: `0x${entryWei.toString(16)}`,
      data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [entryWei, 0n, PROBE] }),
    };
    const res = (await client.request({
      method: "eth_simulateV1",
      params: [{
        blockStateCalls: [{
          stateOverrides: { [PROBE]: { balance: "0x56bc75e2d63100000" } },
          calls: [buy, ...calls],
        }],
        validation: false, traceTransfers: false,
      }, "latest"],
    } as never)) as Array<{ calls: Array<{ status: string; returnData: `0x${string}` }> }>;
    const out = res[0]?.calls ?? [];
    if (out[0]?.status !== "0x1") throw new Error("simulated entry buy reverted");
    words = out.slice(1).map((c) => BigInt(c.returnData || "0x0"));
  } else {
    words = await Promise.all(
      GETTERS.map((fn) =>
        client.readContract({ address: curve, abi: curveAbi, functionName: fn })
          .then((v) => (typeof v === "boolean" ? (v ? 1n : 0n) : (v as bigint))),
      ),
    );
  }

  const [quoteReserve, tokenReserve, realQuote, phantom, feeBps, threshold, grad, ready] = words as bigint[];
  return {
    quoteReserve: quoteReserve!, tokenReserve: tokenReserve!, realQuote: realQuote!,
    phantom: phantom!, feeBps: feeBps!, threshold: threshold!,
    graduated: grad === 1n, readyToGraduate: ready === 1n,
  };
}

export type Valuation = {
  /** Which market this valuation came from. */
  venue: "curve" | "v4";
  /** Largest token amount the curve will actually accept right now. */
  sellable: bigint;
  /** Net ETH for selling `sellable`, after fee. */
  netWei: bigint;
  /** The same sale BEFORE the venue takes its cut. `netWei` plus `exitFeeWei`. */
  grossWei: bigint;
  /** What leaving costs at this size — the curve's 1%, or V4's pool fee. */
  exitFeeWei: bigint;
  /** Exit fee in bps, so a caller can project a breakeven without a quote. */
  feeBps: number;
  /** True when the curve cannot absorb the whole position. */
  capped: boolean;
  progress: number;
  graduated: boolean;
  readyToGraduate: boolean;
};

/**
 * Exact constant-product valuation — verified to the wei against on-chain
 * quoteSell across the full range, including the revert boundary.
 *
 *   maxSellable = k / phantomQuote - tokenReserve
 *
 * A seller can only ever drain the REAL quote reserve; the phantom reserve is
 * structurally unextractable, which is what caps every exit.
 */
export async function value(
  curve: Address, tokens: bigint, entryWei?: bigint, token?: Address,
): Promise<Valuation> {
  return valueAt(await readState(curve, entryWei), tokens, token);
}

/**
 * `value`, from curve state already read. Hosted shares one read of a curve
 * across every lookup holding it for a few seconds (server/ledgerPayload.ts,
 * public-release B3.5); the arithmetic is the same for every caller.
 */
export async function valueAt(s: CurveState, tokens: bigint, token?: Address): Promise<Valuation> {
  // A bonded curve is drained, so the constant-product maths below values the
  // position at nothing and the manager reads a live holding as a total loss.
  // The market moved to V4; value it there.
  if (s.graduated && token) {
    const v4Value = await valueOnV4(token, tokens);
    if (v4Value !== null) {
      // `lpFee` is in pips (1e-6), so a 3000 pool is 0.30% and 30 bps.
      const feeBps = Math.round(v4Value.lpFee / 100);
      const exitFee = (v4Value.gross * BigInt(feeBps)) / 10_000n;
      return {
        venue: "v4", sellable: tokens,
        netWei: v4Value.gross - exitFee, grossWei: v4Value.gross,
        exitFeeWei: exitFee, feeBps, capped: false,
        progress: 1, graduated: true, readyToGraduate: false,
      };
    }
  }

  const k = s.quoteReserve * s.tokenReserve;

  const cap = s.phantom > 0n ? k / s.phantom - s.tokenReserve : tokens;
  const sellable = tokens <= cap ? tokens : (cap > 0n ? cap : 0n);

  let grossWei = 0n;
  let netWei = 0n;
  if (sellable > 0n) {
    grossWei = s.quoteReserve - k / (s.tokenReserve + sellable);
    netWei = (grossWei * (10_000n - s.feeBps)) / 10_000n;
  }

  return {
    venue: "curve", sellable, netWei, grossWei,
    exitFeeWei: grossWei - netWei, feeBps: Number(s.feeBps),
    capped: sellable < tokens,
    progress: s.threshold > 0n ? Number(s.realQuote) / Number(s.threshold) : 0,
    graduated: s.graduated, readyToGraduate: s.readyToGraduate,
  };
}

export type Pnl = {
  /** ETH that left the wallet for the open part, entry fee included. */
  costWei: bigint;
  /** ETH that actually reached the curve: cost minus entry fee and snipe tax. */
  investedWei: bigint;
  /** What the open part would net today. The headline number. */
  netWei: bigint;
  /** Net minus cost, in wei. Negative at t=0 by exactly the round-trip fee. */
  deltaWei: bigint;
  /** Net P&L as a percentage of cost — what the exit rules are measured on. */
  pnlPct: number;
  /**
   * The market's contribution alone, with both fees removed: how far the curve
   * has moved since the entry landed. Zero at t=0 on an untouched curve.
   */
  priceMovePct: number;
  /** Entry fee plus today's exit fee, as a percentage of cost. */
  feeDragPct: number;
  /** Fees in wei: what has been paid, and what leaving now would cost. */
  entryFeeWei: bigint;
  exitFeeWei: bigint;
  /** Price move needed for `pnlPct` to reach zero. ~2.03% on a 1% curve. */
  breakevenMovePct: number;
  /** Realised so far across partial sells, and its cost basis. */
  realizedWei: bigint;
  realizedCostWei: bigint;
  /** Realised plus unrealised, against the full basis. The lifetime number. */
  totalDeltaWei: bigint;
  totalPnlPct: number;
};

const pct = (a: bigint, b: bigint) => (b === 0n ? 0 : (Number(a) / Number(b)) * 100);

/**
 * Split a position's P&L into the part the market did and the part the venue
 * took.
 *
 * Both fees were always inside the old single number, which made a fresh
 * position read -1.99% on a 1% curve and made that indistinguishable from the
 * price dropping 2%. A stop loss set below the round-trip cost therefore fired
 * on the fee, on entry, every time — which is exactly what the two paper
 * positions in the first positions file did, twelve seconds after opening.
 *
 * The identity, with f = feeBps/10000:
 *
 *   netPnl = (1 + priceMove) * (1 - f)^2 - 1
 *
 * so the fee costs 2f - f^2 up front and breakeven is 1/(1-f)^2 - 1.
 */
export function pnl(p: Position, v: Valuation): Pnl {
  const costWei = BigInt(p.costEth);
  const entryFeeWei = BigInt(p.entryFeeWei);
  // What the curve actually received. Snipe tax is zero protocol-wide today,
  // but it is charged on entry like the fee is, so it belongs on this side.
  const investedWei = costWei - entryFeeWei - BigInt(p.snipeTaxWei);

  const deltaWei = v.netWei - costWei;
  const realizedWei = BigInt(p.realizedWei);
  const realizedCostWei = BigInt(p.realizedCostWei);
  const totalDeltaWei = deltaWei + (realizedWei - realizedCostWei);

  const f = v.feeBps / 10_000;
  return {
    costWei, investedWei, netWei: v.netWei, deltaWei,
    pnlPct: pct(deltaWei, costWei),
    priceMovePct: pct(v.grossWei - investedWei, investedWei),
    feeDragPct: pct(entryFeeWei + v.exitFeeWei, costWei),
    entryFeeWei, exitFeeWei: v.exitFeeWei,
    breakevenMovePct: f < 1 && investedWei > 0n
      ? (Number(costWei) / ((1 - f) * Number(investedWei)) - 1) * 100
      : 0,
    realizedWei, realizedCostWei, totalDeltaWei,
    totalPnlPct: pct(totalDeltaWei, costWei + realizedCostWei),
  };
}

/**
 * Value a bonded holding against its V4 pool.
 *
 * Spot rather than a simulated fill: this runs on the manager's sweep for every
 * open position, and a simulation per position per tick is a request budget
 * this project does not have. Spot ignores price impact, so on a thin pool it
 * reads high — which is why the actual exit re-quotes by simulation before it
 * sets `minOut`. The number here decides *whether* to leave; the number there
 * decides what to accept.
 */
async function valueOnV4(
  token: Address, tokens: bigint,
): Promise<{ gross: bigint; lpFee: number } | null> {
  try {
    const { poolFor, spotValue } = await import("../market/v4.js");
    const pool = await poolFor(token);
    if (!pool || pool.liquidity === 0n) return null;
    // `spotValue` is the raw reserve ratio: no pool fee and no impact. The fee
    // is knowable and constant, so it is applied by the caller; impact is not,
    // which is why the real exit re-quotes by simulation before setting minOut.
    return { gross: spotValue(pool, tokens), lpFee: pool.lpFee };
  } catch {
    return null;
  }
}
