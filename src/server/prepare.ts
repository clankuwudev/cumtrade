import { randomBytes } from "node:crypto";
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  getAddress, isAddress, parseEther, toHex, type Address, type Hex,
} from "viem";
import { client } from "../core/lib/client.js";
import { FACTORIES } from "../core/chain.js";
import { curveAbi, factoryAbi, tokenAbi } from "../core/abi.js";
import { immutable } from "../core/lib/cache.js";
import {
  approveCall, clampSlippage, curveBuyCall, curveSellCall, minOutForBuy, minOutOf, type Call,
} from "../core/market/curve.js";
import * as v4 from "../core/market/v4.js";
import { rows } from "./board.js";

/**
 * Trades that the visitor's own wallet signs (public-release B2.3).
 *
 * The hosted server holds no key. Asked to buy or sell, it answers with a quote
 * and an ordered list of unsigned transactions, and nothing is stored under a
 * plan: a plan that expires is simply prepared again. Nothing the visitor sends
 * is trusted beyond "this is the address to read balances for", and the client
 * verifies every step against its own intent before a wallet ever opens (F3.1),
 * so nothing here is the last line of defence.
 *
 * A plan is returned only when its whole sequence succeeds in one
 * `eth_simulateV1`, run from the visitor's address with no state overridden,
 * with approvals in effect for the calls after them. A wallet popup for a
 * transaction already known to fail is the worst thing this could show.
 *
 * RPC cost. The quote, balances, allowances, reserves and (once cached) the
 * factory wiring all fold into one multicall, and the simulation is the second
 * request. The exceptions: the first prepare of a token that is not on the
 * board reads its wiring first, and a token that graduated since the board last
 * looked reads its pool in an extra round.
 */

export const CHAIN_ID = 4663;
/** How long a quote is good for. The client prepares again past this. */
const QUOTE_TTL_S = 60;
/** A signed router swap cannot land later than this past the quote's expiry. */
const DEADLINE_SLACK_S = 120;
/** A Permit2 allowance granted for one trade lapses on its own. */
const PERMIT2_EXPIRY_S = 1800;
const GAS_CAP = BigInt(process.env.PREPARE_GAS_CAP ?? 3_000_000);
const PRICE_IMPACT_WARN_BPS = 300;
const NEAR_GRADUATION_PCT = Number(process.env.PREPARE_NEAR_GRADUATION_PCT ?? 95);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** traceTransfers reports native ETH movements against this pseudo-address. */
const NATIVE_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type StepKind = "erc20-approve" | "permit2-approve" | "curve-buy" | "curve-sell" | "router-swap";
export type Step = {
  id: "approve-token" | "approve-permit2" | "swap";
  kind: StepKind;
  to: Address; data: Hex; value: Hex; gas: Hex;
  /** Display only. The client's verifier ignores it. */
  label: string;
};

export type WarningCode =
  | "sell-sim-failed" | "band-avoid" | "price-impact" | "capped"
  | "near-graduation" | "snipe-tax" | "venue-changed" | "quoter-unavailable" | "finishes-curve";

export type Plan = {
  planId: string;
  chainId: typeof CHAIN_ID;
  side: "buy" | "sell";
  venue: "curve" | "v4";
  from: Address; token: Address; symbol: string;
  quote: {
    amountIn: string; expectedOut: string; minOut: string;
    feeWei: string; snipeTaxWei: string; slippageBps: number; priceImpactBps: number;
    /** A curve buy's input the curve takes, and what comes back, when it finishes the curve (V4R D5). */
    usedWei?: string; refundWei?: string;
  };
  preparedAt: number; expiresAt: number;
  steps: Step[];
  warnings: { code: WarningCode; text: string }[];
};

export type ErrorCode =
  | "not-authentic" | "insufficient-funds" | "no-balance" | "no-pool" | "simulation-failed" | "unsupported-pair" | "quote-mismatch";

export type Prepared =
  | { status: 200; body: Plan }
  | { status: 400; body: { error: string } }
  | { status: 422; body: { code: ErrorCode; text: string } };

const bad = (error: string): Prepared => ({ status: 400, body: { error } });
const refuse = (code: ErrorCode, text: string): Prepared => ({ status: 422, body: { code, text } });

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/**
 * Is this a token a listed factory launched, and which curve is its own?
 *
 * The board is not trusted for this: a row can be an impersonation token the
 * checker banded AVOID. Only a pass is cached, forever, since wiring cannot
 * change. A failure is not cached, so a network error cannot mark a real token
 * as fake for the life of the process.
 *
 * `curveHint` (from the board) lets the curve-side reads join the same wave as
 * the token-side ones. It is verified against the token, never trusted.
 */
function wiring(token: Address, curveHint?: Address): Promise<{ curve: Address; symbol: string; pairToken: Address }> {
  return immutable(`prepare-wiring:${token.toLowerCase()}`, () => readWiring(token, curveHint).catch((e) => {
    // A getter that reverts or returns nothing means the address is not a
    // launch token (or not a contract at all). Anything else is the RPC failing,
    // and must not be reported as a verdict on the token.
    const reverted = e instanceof BaseError && !!e.walk((x) =>
      x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
    throw reverted ? new NotAuthentic() : e;
  }));
}

async function readWiring(token: Address, curveHint?: Address): Promise<{ curve: Address; symbol: string; pairToken: Address }> {
  const T = { address: token, abi: tokenAbi } as const;
  const curveSide = (curve: Address) => Promise.all([
    client.readContract({ address: curve, abi: curveAbi, functionName: "token" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "factory" }),
  ]);
  // Not token.factory(): on the live chain that getter reverts. The curve names
  // its factory. Every listed factory's registry is read in the same wave, and
  // the one the curve names is chosen after (B1.5).
  const [curve, symbol, entries, hinted] = await Promise.all([
    client.readContract({ ...T, functionName: "curve" }),
    client.readContract({ ...T, functionName: "symbol" }),
    Promise.all(FACTORIES.map((f) => client.readContract({
      address: f.address as Address, abi: factoryAbi, functionName: "getLaunchedToken", args: [token],
    }))),
    curveHint ? curveSide(curveHint) : Promise.resolve(null),
  ]);
  const [curveToken, curveFactory] = curveHint && curve.toLowerCase() === curveHint.toLowerCase()
    ? hinted! : await curveSide(curve);

  // The token and its curve must point at each other, the curve must name a
  // listed factory, and THAT factory's own registry must list this token with
  // this curve. A contract can claim any factory; only the registry is the
  // factory speaking, so it is the check an impostor cannot pass. Another
  // listed factory's entry never stands in for it.
  const own = FACTORIES.findIndex((f) => f.address.toLowerCase() === curveFactory.toLowerCase());
  if (own < 0) throw new NotAuthentic();
  const [launched, registeredCurve, , , pairToken] = entries[own]!;
  if (curveToken.toLowerCase() !== token.toLowerCase()
      || launched.toLowerCase() !== token.toLowerCase() || registeredCurve.toLowerCase() !== curve.toLowerCase()) {
    throw new NotAuthentic();
  }
  return { curve, symbol, pairToken };
}

class NotAuthentic extends Error {}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

type SimLog = { address: string; topics: string[]; data: Hex };
type SimCall = { status: Hex; gasUsed?: Hex; logs?: SimLog[]; error?: { message?: string } };

async function simulate(from: Address, calls: Call[]): Promise<SimCall[]> {
  const res = (await client.request({
    method: "eth_simulateV1",
    params: [{
      // No state override: the point is whether THIS wallet can do this now.
      blockStateCalls: [{
        calls: calls.map((c) => ({ from, to: c.to, data: c.data, value: toHex(c.value) })),
      }],
      validation: false,
      traceTransfers: true,
    }, "latest"],
  } as never)) as Array<{ calls: SimCall[] }>;
  return res[0]?.calls ?? [];
}

/** Total of `asset` a simulated call moved to `who`. */
function received(call: SimCall, asset: string, who: Address): bigint {
  const me = `0x${who.slice(2).toLowerCase().padStart(64, "0")}`;
  return (call.logs ?? [])
    .filter((l) => l.address.toLowerCase() === asset.toLowerCase()
      && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === me)
    .reduce((s, l) => s + BigInt(l.data), 0n);
}

/** The first call that reverted, as a sentence, or null. */
function failure(sim: SimCall[], labels: string[]): string | null {
  const i = sim.findIndex((c) => c.status !== "0x1");
  if (sim.length < labels.length) return "the simulation returned fewer results than steps";
  if (i < 0) return null;
  return `${labels[i]} reverted${sim[i]!.error?.message ? `: ${sim[i]!.error!.message}` : ""}`;
}

const gasFor = (c: SimCall | undefined) => {
  const used = c?.gasUsed ? BigInt(c.gasUsed) : GAS_CAP;
  const padded = (used * 13n) / 10n;
  return toHex(padded > GAS_CAP ? GAS_CAP : padded);
};

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** The curve's moving parts, which a quote and its price impact are computed from. */
async function curveState(curve: Address) {
  const C = { address: curve, abi: curveAbi } as const;
  const [quoteReserve, tokenReserve, realQuote, phantom, feeBps, threshold, graduated] = await Promise.all([
    client.readContract({ ...C, functionName: "quoteReserve" }),
    client.readContract({ ...C, functionName: "tokenReserve" }),
    client.readContract({ ...C, functionName: "realQuoteReserve" }),
    client.readContract({ ...C, functionName: "phantomQuote" }),
    client.readContract({ ...C, functionName: "feeBps" }),
    client.readContract({ ...C, functionName: "graduationThreshold" }),
    client.readContract({ ...C, functionName: "graduated" }),
  ]);
  return { quoteReserve, tokenReserve, realQuote, phantom, feeBps, threshold, graduated };
}

const impactBps = (got: bigint, spot: number) =>
  spot > 0 ? Math.max(0, Math.round((1 - Number(got) / spot) * 10_000)) : 0;

type Input = { from: Address; token: Address; slip: number };

function common(body: Record<string, unknown>): Input | Prepared {
  const from = String(body.from ?? "");
  const token = String(body.token ?? "");
  if (!isAddress(from)) return bad("from must be an address");
  if (!isAddress(token)) return bad("token must be an address");
  return { from: getAddress(from), token: getAddress(token), slip: clampSlippage(Number(body.slippageBps)) };
}

function shell(side: "buy" | "sell", venue: "curve" | "v4", input: Input, symbol: string) {
  const preparedAt = Math.floor(Date.now() / 1000);
  return {
    planId: `p_${randomBytes(8).toString("hex")}`,
    chainId: CHAIN_ID, side, venue,
    from: input.from, token: input.token, symbol,
    preparedAt, expiresAt: preparedAt + QUOTE_TTL_S,
  } as const;
}

// ---------------------------------------------------------------------------
// buy
// ---------------------------------------------------------------------------

export async function prepareBuy(body: Record<string, unknown>): Promise<Prepared> {
  const input = common(body);
  if ("status" in input) return input;
  const { from, token, slip } = input;

  let amountIn: bigint;
  try { amountIn = parseEther(String(body.amountEth ?? "")); } catch { return bad("amountEth must be a number of ETH"); }
  if (amountIn <= 0n) return bad("amountEth must be positive");

  const row = rows.get(token.toLowerCase());
  const hint = row?.curve;

  // One wave. The curve-side reads use the board's curve and are thrown away if
  // wiring says the board was wrong.
  const [wired, state, balance, quote, hintedPool] = await Promise.all([
    wiring(token, hint).catch((e) => e as Error),
    hint ? curveState(hint).catch(() => null) : Promise.resolve(null),
    client.getBalance({ address: from }),
    hint
      ? client.readContract({ address: hint, abi: curveAbi, functionName: "quoteBuyFor", args: [from, amountIn] })
          .catch(() => null)
      : Promise.resolve(null),
    row?.graduated ? v4.poolFor(token).catch(() => null) : Promise.resolve(null),
  ]);
  if (wired instanceof NotAuthentic) return refuse("not-authentic", "This is not a token launched by the clank.trade factory.");
  if (wired instanceof Error) throw wired;
  if (BigInt(wired.pairToken) !== 0n) return refuse("unsupported-pair", new v4.UnsupportedPair(wired.pairToken).message);
  const { curve, symbol } = wired;

  if (balance < amountIn) {
    return refuse("insufficient-funds", `This wallet holds ${balance} wei, short of the ${amountIn} wei to spend.`);
  }

  // Without a usable board hint, the state and the quote go out together now.
  const hintOk = !!hint && hint.toLowerCase() === curve.toLowerCase() && state !== null;
  const [fresh, q] = hintOk
    ? [state!, quote]
    : await Promise.all([
        curveState(curve),
        client.readContract({ address: curve, abi: curveAbi, functionName: "quoteBuyFor", args: [from, amountIn] })
          .catch(() => null),
      ]);
  const warnings: Plan["warnings"] = [];
  if (row && !row.graduated && fresh.graduated) {
    warnings.push({ code: "venue-changed", text: "This curve graduated since the board last looked; the buy goes to Uniswap V4." });
  }
  // Only a sell that reverted: a check that could not run is not a warning (current-issues.md #4).
  if (row && row.status === "ready" && row.sellable === false && !fresh.graduated) {
    warnings.push({ code: "sell-sim-failed", text: "The checker's buy-then-sell simulation failed for this token. A position may not be exitable." });
  }
  if (row?.band === "AVOID") {
    warnings.push({ code: "band-avoid", text: "The checker banded this token AVOID." });
  }

  // ---- V4 ----------------------------------------------------------------
  if (fresh.graduated) {
    const pool = hintedPool ?? await v4.poolFor(token);
    if (!pool) return refuse("no-pool", "This token has graduated, but its canonical Uniswap V4 pool was not found.");
    const plan = shell("buy", "v4", input, symbol);
    const deadline = BigInt(plan.expiresAt + DEADLINE_SLACK_S);

    // Simulated with no minimum: the fill IS the quote, and the minimum is taken
    // from it. The real call differs only in that minimum and its deadline.
    const probe = v4.routerCall({ data: v4.buildBuy(pool.key, amountIn, 0n, deadline), value: amountIn });
    // clank.trade's V4 Quoter is read alongside, as a cross-check (V4R D4).
    const [sim, quoted] = await Promise.all([simulate(from, [probe]), v4.quoterOut(pool.key, true, amountIn)]);
    const why = failure(sim, ["the swap"]);
    if (why) return refuse("simulation-failed", why);
    const out = received(sim[0]!, token, from);
    if (out === 0n) return refuse("simulation-failed", "The pool would deliver nothing for this size.");
    const mismatch = v4.quoterDisagrees(out, quoted);
    if (mismatch) return refuse("quote-mismatch", mismatch);
    if (quoted === null) warnings.push({ code: "quoter-unavailable", text: "clank.trade's V4 Quoter did not answer, so this quote is the router's simulated fill alone." });
    const minOut = minOutOf(out, slip);
    const swap = v4.routerCall({ data: v4.buildBuy(pool.key, amountIn, minOut, deadline), value: amountIn });
    const lpFee = BigInt(pool.lpFee);
    const spot = Number((amountIn * (1_000_000n - lpFee)) / 1_000_000n) * pool.tokensPerEth;
    const priceImpactBps = impactBps(out, spot);
    if (priceImpactBps > PRICE_IMPACT_WARN_BPS) {
      warnings.push({ code: "price-impact", text: `This buy moves the pool price about ${(priceImpactBps / 100).toFixed(1)}%.` });
    }
    return {
      status: 200,
      body: {
        ...plan,
        quote: {
          amountIn: amountIn.toString(), expectedOut: out.toString(), minOut: minOut.toString(),
          feeWei: ((amountIn * lpFee) / 1_000_000n).toString(), snipeTaxWei: "0",
          slippageBps: slip, priceImpactBps,
        },
        steps: [step("swap", "router-swap", swap, sim[0], "Buy on Uniswap V4")],
        warnings,
      },
    };
  }

  // ---- curve -------------------------------------------------------------
  if (!q) return refuse("simulation-failed", "The curve would not quote this buy.");
  // (grossUsed, netIn, fee, tokensOut, refund): the fifth word is a refund, not a
  // snipe tax, and the minimum is scaled to what the curve uses (V4R D5).
  const [usedWei, , feeWei, expected, refundWei] = q;
  const minOut = minOutForBuy(expected, slip, amountIn, usedWei);
  const swap = curveBuyCall({ curve, amountIn, minOut, recipient: from });
  const plan = shell("buy", "curve", input, symbol);

  const sim = await simulate(from, [swap]);
  const why = failure(sim, ["the buy"]);
  if (why) return refuse("simulation-failed", why);
  const out = received(sim[0]!, token, from);
  if (out < minOut) return refuse("simulation-failed", `The buy would deliver ${out}, under the minimum of ${minOut}.`);

  if (refundWei > 0n) {
    warnings.push({ code: "finishes-curve", text: `This buy finishes the curve: it uses ${usedWei} of the ${amountIn} wei, and ${refundWei} comes back.` });
  }
  const progressPct = fresh.threshold > 0n ? (Number(fresh.realQuote) / Number(fresh.threshold)) * 100 : 0;
  if (progressPct >= NEAR_GRADUATION_PCT) {
    warnings.push({ code: "near-graduation", text: `The curve is ${progressPct.toFixed(0)}% of the way to graduating to Uniswap V4.` });
  }
  const spot = fresh.quoteReserve > 0n
    ? Number(usedWei - feeWei) * Number(fresh.tokenReserve) / Number(fresh.quoteReserve) : 0;
  const priceImpactBps = impactBps(expected, spot);
  if (priceImpactBps > PRICE_IMPACT_WARN_BPS) {
    warnings.push({ code: "price-impact", text: `This buy moves the curve price about ${(priceImpactBps / 100).toFixed(1)}%.` });
  }

  return {
    status: 200,
    body: {
      ...plan,
      quote: {
        amountIn: amountIn.toString(), expectedOut: expected.toString(), minOut: minOut.toString(),
        feeWei: feeWei.toString(), snipeTaxWei: "0",
        slippageBps: slip, priceImpactBps,
        ...(refundWei > 0n ? { usedWei: usedWei.toString(), refundWei: refundWei.toString() } : {}),
      },
      steps: [step("swap", "curve-buy", swap, sim[0], "Buy on the bonding curve")],
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// sell
// ---------------------------------------------------------------------------

export async function prepareSell(body: Record<string, unknown>): Promise<Prepared> {
  const input = common(body);
  if ("status" in input) return input;
  const { from, token, slip } = input;

  let requested: bigint | null = null;
  let pct: number | null = null;
  if (body.tokens !== undefined) {
    try { requested = BigInt(String(body.tokens)); } catch { return bad("tokens must be an integer amount"); }
    if (requested <= 0n) return bad("tokens must be positive");
  } else if (body.pct !== undefined) {
    pct = Number(body.pct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return bad("pct must be between 0 and 100");
  } else {
    return bad("give tokens or pct");
  }

  const row = rows.get(token.toLowerCase());
  const hint = row?.curve;
  const [wired, state, balance, curveAllowance, v4Allowances, hintedPool] = await Promise.all([
    wiring(token, hint).catch((e) => e as Error),
    hint ? curveState(hint).catch(() => null) : Promise.resolve(null),
    client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [from] }),
    hint
      ? client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [from, hint] })
      : Promise.resolve(null),
    v4.allowances(from, token),
    row?.graduated ? v4.poolFor(token).catch(() => null) : Promise.resolve(null),
  ]);
  if (wired instanceof NotAuthentic) return refuse("not-authentic", "This is not a token launched by the clank.trade factory.");
  if (wired instanceof Error) throw wired;
  if (BigInt(wired.pairToken) !== 0n) return refuse("unsupported-pair", new v4.UnsupportedPair(wired.pairToken).message);
  const { curve, symbol } = wired;

  if (balance === 0n) return refuse("no-balance", "This wallet holds none of this token.");
  let tokens = requested ?? (balance * BigInt(Math.round(pct! * 100))) / 10_000n;
  if (tokens > balance) {
    return refuse("no-balance", `This wallet holds ${balance}, less than the ${tokens} asked to sell.`);
  }
  if (tokens <= 0n) return bad("that percentage of this balance rounds to nothing");

  // Without a usable board hint, the state and the curve allowance go out together now.
  const hintOk = !!hint && hint.toLowerCase() === curve.toLowerCase() && state !== null && curveAllowance !== null;
  const [fresh, allowance] = hintOk
    ? [state!, curveAllowance!]
    : await Promise.all([
        curveState(curve),
        client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [from, curve] }),
      ]);
  const warnings: Plan["warnings"] = [];
  if (row && !row.graduated && fresh.graduated) {
    warnings.push({ code: "venue-changed", text: "This curve graduated since the board last looked; the sell goes to Uniswap V4." });
  }

  // ---- V4 ----------------------------------------------------------------
  if (fresh.graduated) {
    const pool = hintedPool ?? await v4.poolFor(token);
    if (!pool) return refuse("no-pool", "This token has graduated, but its canonical Uniswap V4 pool was not found.");
    const plan = shell("sell", "v4", input, symbol);
    const deadline = BigInt(plan.expiresAt + DEADLINE_SLACK_S);
    // Exact amounts and a short expiry: a stranger's wallet should not keep a
    // standing allowance from a site it used once (public-release P3).
    const [erc20Approve, permit2Approve] = v4.approvalCalls(token, tokens, {
      erc20Amount: tokens, expiration: BigInt(plan.preparedAt + PERMIT2_EXPIRY_S),
    });
    const approvals: { id: Step["id"]; kind: StepKind; call: Call; label: string }[] = [];
    if (v4Allowances.erc20 < tokens) {
      approvals.push({ id: "approve-token", kind: "erc20-approve", call: erc20Approve!, label: `Let Permit2 move ${symbol}` });
    }
    if (v4Allowances.permit2Amount < tokens || v4Allowances.permit2Expiration <= plan.preparedAt) {
      approvals.push({ id: "approve-permit2", kind: "permit2-approve", call: permit2Approve!, label: "Let the Uniswap router use that allowance" });
    }

    const probe = v4.routerCall({ data: v4.buildSell(pool.key, tokens, 0n, deadline), value: 0n });
    const labels = [...approvals.map((a) => a.label), "the swap"];
    const [sim, quoted] = await Promise.all([
      simulate(from, [...approvals.map((a) => a.call), probe]),
      v4.quoterOut(pool.key, false, tokens),
    ]);
    const why = failure(sim, labels);
    if (why) return refuse("simulation-failed", why);
    const out = received(sim[sim.length - 1]!, NATIVE_LOG, from);
    if (out === 0n) return refuse("simulation-failed", "The pool would pay nothing for this size.");
    const mismatch = v4.quoterDisagrees(out, quoted);
    if (mismatch) return refuse("quote-mismatch", mismatch);
    if (quoted === null) warnings.push({ code: "quoter-unavailable", text: "clank.trade's V4 Quoter did not answer, so this quote is the router's simulated fill alone." });
    const minOut = minOutOf(out, slip);
    const swap = v4.routerCall({ data: v4.buildSell(pool.key, tokens, minOut, deadline), value: 0n });
    const lpFee = BigInt(pool.lpFee);
    const spot = pool.tokensPerEth > 0
      ? (Number(tokens) / pool.tokensPerEth) * (1 - pool.lpFee / 1_000_000) : 0;
    const priceImpactBps = impactBps(out, spot);
    if (priceImpactBps > PRICE_IMPACT_WARN_BPS) {
      warnings.push({ code: "price-impact", text: `This sell moves the pool price about ${(priceImpactBps / 100).toFixed(1)}%.` });
    }
    return {
      status: 200,
      body: {
        ...plan,
        quote: {
          amountIn: tokens.toString(), expectedOut: out.toString(), minOut: minOut.toString(),
          feeWei: (lpFee > 0n ? (out * lpFee) / (1_000_000n - lpFee) : 0n).toString(), snipeTaxWei: "0",
          slippageBps: slip, priceImpactBps,
        },
        steps: [
          ...approvals.map((a, i) => step(a.id, a.kind, a.call, sim[i], a.label)),
          step("swap", "router-swap", swap, sim[sim.length - 1], "Sell on Uniswap V4"),
        ],
        warnings,
      },
    };
  }

  // ---- curve -------------------------------------------------------------
  // The sell is priced from reserves, which is exact against the curve's own
  // quoteSell (see value() in core/positions/valuation.ts). A seller can only drain
  // the real reserve, never the phantom one, so a large sell is capped.
  const k = fresh.quoteReserve * fresh.tokenReserve;
  const cap = fresh.phantom > 0n ? k / fresh.phantom - fresh.tokenReserve : tokens;
  if (cap <= 0n) return refuse("simulation-failed", "The curve has no real reserve to sell into yet.");
  if (tokens > cap) {
    warnings.push({ code: "capped", text: `The curve can only absorb ${cap} of the ${tokens} asked; the sell was reduced.` });
    tokens = cap;
  }
  const gross = fresh.quoteReserve - k / (fresh.tokenReserve + tokens);
  const expected = (gross * (10_000n - fresh.feeBps)) / 10_000n;
  const feeWei = gross - expected;
  const minOut = minOutOf(expected, slip);
  const plan = shell("sell", "curve", input, symbol);

  const approve = allowance < tokens
    ? { id: "approve-token" as const, kind: "erc20-approve" as const, call: approveCall({ token, spender: curve, amount: tokens }), label: `Let the curve move ${symbol}` }
    : null;
  const swap = curveSellCall({ curve, tokens, minOut, recipient: from });

  const labels = [...(approve ? [approve.label] : []), "the sell"];
  const sim = await simulate(from, [...(approve ? [approve.call] : []), swap]);
  const why = failure(sim, labels);
  if (why) return refuse("simulation-failed", why);
  const out = received(sim[sim.length - 1]!, NATIVE_LOG, from);
  if (out < minOut) return refuse("simulation-failed", `The sell would pay ${out}, under the minimum of ${minOut}.`);

  const spot = fresh.tokenReserve > 0n
    ? Number(tokens) * Number(fresh.quoteReserve) / Number(fresh.tokenReserve) * (1 - Number(fresh.feeBps) / 10_000) : 0;
  const priceImpactBps = impactBps(expected, spot);
  if (priceImpactBps > PRICE_IMPACT_WARN_BPS) {
    warnings.push({ code: "price-impact", text: `This sell moves the curve price about ${(priceImpactBps / 100).toFixed(1)}%.` });
  }

  return {
    status: 200,
    body: {
      ...plan,
      quote: {
        amountIn: tokens.toString(), expectedOut: expected.toString(), minOut: minOut.toString(),
        feeWei: feeWei.toString(), snipeTaxWei: "0", slippageBps: slip, priceImpactBps,
      },
      steps: [
        ...(approve ? [step(approve.id, approve.kind, approve.call, sim[0], approve.label)] : []),
        step("swap", "curve-sell", swap, sim[sim.length - 1], "Sell on the bonding curve"),
      ],
      warnings,
    },
  };
}

function step(id: Step["id"], kind: StepKind, call: Call, sim: SimCall | undefined, label: string): Step {
  return { id, kind, to: call.to, data: call.data, value: toHex(call.value), gas: gasFor(sim), label };
}
