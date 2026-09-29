import {
  encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, concatHex, getAddress,
  type Address, type Hex,
} from "viem";
import { client } from "../lib/client.js";
import { factoryAt, type Factory } from "../chain.js";
import { curveAbi, factoryAbi, tokenAbi } from "../abi.js";

/**
 * Uniswap V4 exit path for graduated tokens.
 *
 * Once a curve bonds, its reserves drain into a V4 pool and the bonding curve
 * stops being a venue. Everything else in this project talks to the curve, so a
 * position still open at graduation used to be stranded — the manager would
 * decide to exit and have nothing to call.
 *
 * Three facts from reconnaissance shape this file.
 *
 * **A V4 swap cannot come from an EOA.** The PoolManager only does work inside
 * an `unlock` callback, so something with code has to sit in the middle. The
 * Universal Router is deployed here, so that is the router; nothing needed to
 * be written and deployed.
 *
 * **Anyone can create a V4 pool for any token.** CABO — the only graduation in
 * the factory's history — has twenty of them, nineteen with arbitrary fees and
 * no hooks, most with no liquidity. Selling into the wrong one is how you hand
 * a position to whoever created it. The factory's `memeHook` is what separates
 * them: it holds only the BEFORE_INITIALIZE permission, so it cannot touch a
 * swap, and its entire job is to make the canonical pool the one nobody else
 * can mint. The key is therefore derived, and then checked against chain state
 * rather than trusted.
 *
 * **The hook does not hook swaps.** With only BEFORE_INITIALIZE set there is no
 * beforeSwap or afterSwap, so a sell here is an ordinary exact-input V4 swap
 * with no hook data and no surprise deltas.
 */

// --- deployed addresses ----------------------------------------------------
// The PoolManager and hook are read from the factory rather than hardcoded,
// because they are the factory's own wiring and it is the authority on them.
// The router and Permit2 are infrastructure and are pinned, with an override.

// getAddress rather than a literal: these are pasted from a block explorer,
// and viem rejects a bad EIP-55 checksum at encode time — which surfaces as a
// confusing failure deep inside building a swap rather than here.
export const UNIVERSAL_ROUTER = getAddress(
  process.env.UNIVERSAL_ROUTER ?? "0x8876789976decbfcbbbe364623c63652db8c0904");
export const PERMIT2 = getAddress(
  process.env.PERMIT2 ?? "0x000000000022d473030f116ddee9f6b43ac78ba3");

/**
 * Pool parameters the factory graduates into, until the chain index has seen
 * the pool (D1.3). Observed on every graduation so far (3 of 3, 2026-09-23).
 * `poolFor` checks the pool is initialised, so a wrong constant reads as no
 * pool, never as selling into an empty one.
 */
const GRAD_FEE = Number(process.env.V4_GRAD_FEE ?? 3000);
const GRAD_TICK_SPACING = Number(process.env.V4_GRAD_TICK_SPACING ?? 200);

/** Native ETH is currency 0 on this pad; every launch token sorts above it. */
export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

const poolManagerAbi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
]);
const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

/** `mapping(PoolId => Pool.State) _pools` lives at slot 6; found by probing. */
const POOLS_SLOT = 6n;

export type PoolKey = {
  currency0: Address; currency1: Address;
  fee: number; tickSpacing: number; hooks: Address;
};

const poolKeyComponents = [
  { type: "address" }, { type: "address" },
  { type: "uint24" }, { type: "int24" }, { type: "address" },
] as const;

export const poolId = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters(poolKeyComponents,
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

type Wiring = { factory: Factory; poolManager: Address; hook: Address };

/** Each factory's pool manager and hook, read once: they are its immutables. */
const wiringCache = new Map<string, Promise<Wiring>>();
/** Each token's factory, read once: a curve cannot change its factory. */
const factoryCache = new Map<string, Promise<Factory | null>>();

/**
 * The listed factory that launched `token`, or null.
 *
 * The hook is per factory: clank.trade's second factory graduates into a pool
 * carrying a different memeHook from the first's (B1.5), so a pool key built
 * with the wrong one names a pool nobody made. The token's curve names its
 * factory; an unlisted one has no canonical pool here at all.
 */
function factoryOf(token: Address): Promise<Factory | null> {
  const key = token.toLowerCase();
  let hit = factoryCache.get(key);
  if (!hit) {
    hit = (async () => {
      const curve = await client.readContract({ address: token, abi: tokenAbi, functionName: "curve" }) as Address;
      const named = await client.readContract({ address: curve, abi: curveAbi, functionName: "factory" }) as Address;
      return factoryAt(named) ?? null;
    })();
    // A failed read is the RPC, not an answer: forget it so the next call asks again.
    hit.catch(() => factoryCache.delete(key));
    factoryCache.set(key, hit);
  }
  return hit;
}

function wiring(factory: Factory): Promise<Wiring> {
  const key = factory.address.toLowerCase();
  let hit = wiringCache.get(key);
  if (!hit) {
    const F = { address: factory.address as Address, abi: factoryAbi } as const;
    hit = Promise.all([
      client.readContract({ ...F, functionName: "poolManager" }),
      client.readContract({ ...F, functionName: "memeHook" }),
    ]).then(([pm, hk]) => ({ factory, poolManager: pm as Address, hook: hk as Address }));
    hit.catch(() => wiringCache.delete(key));
    wiringCache.set(key, hit);
  }
  return hit;
}

export type PoolState = {
  key: PoolKey; id: Hex;
  sqrtPriceX96: bigint; tick: number; lpFee: number; liquidity: bigint;
  /** Tokens per 1 ETH at spot, ignoring fees and price impact. */
  tokensPerEth: number;
};

/** Read slot0 + liquidity straight out of the PoolManager. */
async function readState(poolManager: Address, key: PoolKey): Promise<PoolState | null> {
  const id = poolId(key);
  const base = BigInt(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT])));

  const M = { address: poolManager, abi: poolManagerAbi } as const;
  const [slot0Raw, liqRaw] = await Promise.all([
    client.readContract({ ...M, functionName: "extsload", args: [`0x${base.toString(16).padStart(64, "0")}` as Hex] }),
    client.readContract({ ...M, functionName: "extsload", args: [`0x${(base + 3n).toString(16).padStart(64, "0")}` as Hex] }),
  ]);

  const v = BigInt(slot0Raw as Hex);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  if (sqrtPriceX96 === 0n) return null; // never initialised

  const tick = Number(BigInt.asIntN(24, (v >> 160n) & ((1n << 24n) - 1n)));
  const lpFee = Number((v >> 208n) & ((1n << 24n) - 1n));

  // price = (sqrtPriceX96 / 2^96)^2 is amount1 per amount0 — token per ETH,
  // since the token is always currency1 here. Done in floating point on
  // purpose: this feeds a display and a sanity check, never a trade size.
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return {
    key, id, sqrtPriceX96, tick, lpFee,
    liquidity: BigInt(liqRaw as Hex),
    tokensPerEth: ratio * ratio,
  };
}

/**
 * What a launch trades against, and the pool it graduates into: its factory's
 * own record (`getLaunchedToken`), as clank.trade's developer docs build the
 * pool key (V4R D2). Immutable once launched, so read once per token.
 */
export type LaunchRecord = { pairToken: Address; poolFee: number; tickSpacing: number };
const recordCache = new Map<string, Promise<LaunchRecord | null>>();

export function launchRecord(token: Address): Promise<LaunchRecord | null> {
  const key = token.toLowerCase();
  let hit = recordCache.get(key);
  if (!hit) {
    hit = (async () => {
      const factory = await factoryOf(token);
      if (!factory) return null;
      const r = await client.readContract({
        address: factory.address as Address, abi: factoryAbi, functionName: "getLaunchedToken", args: [token],
      });
      // An address the factory never launched reads as zeros, not a revert.
      if (!r[14] || r[0].toLowerCase() !== key) return null;
      return { pairToken: r[4], poolFee: r[6], tickSpacing: r[7] };
    })();
    hit.catch(() => recordCache.delete(key));
    recordCache.set(key, hit);
  }
  return hit;
}

/**
 * A launch paired with an ERC-20 rather than native ETH (V4R D3). The factory
 * supports them; cumTrade trades them only once the user switches pair tokens
 * on (phase 2), and until then declines them, with this reason, everywhere.
 */
export class UnsupportedPair extends Error {
  constructor(readonly pairToken: Address) {
    super(`Paired with an ERC-20 (${pairToken}): cumTrade trades ETH-paired launches only.`);
    this.name = "UnsupportedPair";
  }
}

/** Pool keys the chain index has seen for a token (D1.3), set by chainIndex.ts. */
type IndexedPools = (token: string) => { fee: number; tickSpacing: number; hooks: string; currency0: string; currency1: string }[];
let indexedPools: IndexedPools = () => [];

/** Read pool keys from the chain index. */
export function useIndexedPools(fn: IndexedPools) {
  indexedPools = fn;
}

/**
 * The canonical pool for a graduated token, or null.
 *
 * The key is the one the chain index saw initialised when the factory made
 * the pool (D1.3), carrying the factory's own hook: anyone can initialise a
 * pool for any token, but only the factory can with that hook. Before the
 * index has it (not graduated yet, or no index in this process), the key the
 * factory graduates into. Either way it is checked against chain state, so a
 * key nobody initialised reads as no pool.
 *
 * This replaced a scan of every Initialize from the factory's genesis when
 * the expected key was empty, which ran on every refresh (D1.0 cached it;
 * D1.3 retired it).
 */
export async function poolFor(token: Address): Promise<PoolState | null> {
  const factory = await factoryOf(token);
  if (!factory) return null;
  const [{ poolManager, hook }, record] = await Promise.all([wiring(factory), launchRecord(token)]);
  // The pair, fee and tick spacing are the launch's own (V4R D2). A token its
  // factory has no record of has no canonical pool.
  if (!record) return null;
  if (record.pairToken.toLowerCase() !== NATIVE) throw new UnsupportedPair(record.pairToken);
  const t = token.toLowerCase();
  // Currencies sort by address; native ETH is zero, so it is always currency0.
  const key: PoolKey = {
    currency0: NATIVE, currency1: token,
    fee: record.poolFee || GRAD_FEE, tickSpacing: record.tickSpacing || GRAD_TICK_SPACING, hooks: hook,
  };
  // The pool the chain index saw the factory initialise must be this one.
  const known = indexedPools(t).find((k) =>
    k.hooks.toLowerCase() === hook.toLowerCase() && k.currency0.toLowerCase() === NATIVE && k.currency1.toLowerCase() === t);
  if (known && (known.fee !== key.fee || known.tickSpacing !== key.tickSpacing)) {
    throw new Error(`the indexed pool (fee ${known.fee}, spacing ${known.tickSpacing}) is not the factory's record `
      + `(fee ${key.fee}, spacing ${key.tickSpacing})`);
  }
  return readState(poolManager, key);
}

// --- swap encoding ---------------------------------------------------------

/** Universal Router command. */
const V4_SWAP = 0x10;
/** v4-periphery Actions. */
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f;

/**
 * Robinhood's Universal Router reads the exact-input-single tuple with a
 * `minHopPriceX36` before `hookData` (developer.clank.trade, Trade after
 * graduation; V4R). The generic V4 tuple, without it, is read shifted by one
 * word: it only ever worked because native ETH is currency0 and its zero
 * address made the misread hook data empty. It is 0 here, as in the docs;
 * `amountOutMinimum` is the trade's protection (V4R D1).
 */
const exactInSingleComponents = [{
  type: "tuple",
  components: [
    { type: "tuple", components: [...poolKeyComponents] },
    { type: "bool" },     // zeroForOne
    { type: "uint128" },  // amountIn
    { type: "uint128" },  // amountOutMinimum
    { type: "uint256" },  // minHopPriceX36
    { type: "bytes" },    // hookData
  ],
}] as const;
/** No per-hop price floor (V4R D1). */
export const MIN_HOP_PRICE_X36 = 0n;

/**
 * Calldata for selling `amountIn` of the token into the pool for native ETH.
 *
 * The token is currency1, so selling it is a 1 -> 0 swap: `zeroForOne` is
 * false. SETTLE_ALL pays the token in (the router pulls it through Permit2)
 * and TAKE_ALL collects the ETH, with `minOut` enforced by the router rather
 * than by us checking afterwards.
 */
export function buildSell(key: PoolKey, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const actions = concatHex([
    `0x${SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, "0")}`,
    `0x${SETTLE_ALL.toString(16).padStart(2, "0")}`,
    `0x${TAKE_ALL.toString(16).padStart(2, "0")}`,
  ] as Hex[]);

  const swapParam = encodeAbiParameters(exactInSingleComponents, [[
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    false, amountIn, minOut, MIN_HOP_PRICE_X36, "0x",
  ]] as never);

  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }], [key.currency1, amountIn]);
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }], [key.currency0, minOut]);

  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settle, take]]);

  return encodeFunctionData({
    abi: routerAbi,
    functionName: "execute",
    args: [`0x${V4_SWAP.toString(16).padStart(2, "0")}` as Hex, [v4Input], deadline],
  });
}

/**
 * Calldata for buying the token with native ETH — the mirror of buildSell.
 *
 * Present because "bonded tokens work" is not just an exit: a graduated token
 * that can be sold but not bought is still a token the board cannot act on, and
 * the encoding is the same swap in the other direction. ETH is currency0, so
 * this is a 0 -> 1 swap and the router is called with `value`.
 */
export function buildBuy(key: PoolKey, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const actions = concatHex([
    `0x${SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, "0")}`,
    `0x${SETTLE_ALL.toString(16).padStart(2, "0")}`,
    `0x${TAKE_ALL.toString(16).padStart(2, "0")}`,
  ] as Hex[]);

  const swapParam = encodeAbiParameters(exactInSingleComponents, [[
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    true, amountIn, minOut, MIN_HOP_PRICE_X36, "0x",
  ]] as never);

  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }], [key.currency0, amountIn]);
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }], [key.currency1, minOut]);

  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settle, take]]);

  return encodeFunctionData({
    abi: routerAbi,
    functionName: "execute",
    args: [`0x${V4_SWAP.toString(16).padStart(2, "0")}` as Hex, [v4Input], deadline],
  });
}

/**
 * The two approvals the Universal Router needs before it can pull a token.
 *
 * The defaults are what the bot has always sent: an unlimited approval of the
 * token to Permit2, and a Permit2 allowance of `amount` that never expires. A
 * hosted plan passes an exact `erc20Amount` and a short `expiration` instead,
 * because a stranger's wallet should not keep a standing allowance from a site
 * it used once.
 */
export function approvalCalls(
  token: Address, amount: bigint,
  opts: { erc20Amount?: bigint; expiration?: bigint } = {},
) {
  const MAX_UINT160 = (1n << 160n) - 1n;
  const FAR_FUTURE = 2n ** 48n - 1n;
  return [
    {
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: tokenAbi, functionName: "approve", args: [PERMIT2, opts.erc20Amount ?? 2n ** 256n - 1n],
      }),
      label: "approve permit2",
    },
    {
      to: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: permit2Abi, functionName: "approve",
        args: [token, UNIVERSAL_ROUTER, amount > MAX_UINT160 ? MAX_UINT160 : amount, Number(opts.expiration ?? FAR_FUTURE)],
      }),
      label: "permit2 approve router",
    },
  ];
}

/**
 * A router swap as an unsigned call. There is no recipient to pass: TAKE_ALL
 * pays whoever calls the router, which is the signer, so a swap can only ever
 * pay out to the wallet that signs it.
 */
export function routerCall(p: { data: Hex; value: bigint }) {
  return { to: UNIVERSAL_ROUTER, data: p.data, value: p.value };
}

/**
 * Both allowances a V4 sell depends on, read together so they fold into one
 * multicall. A plan includes only the approval steps these show are missing.
 */
export async function allowances(owner: Address, token: Address) {
  const [erc20, p2] = await Promise.all([
    client.readContract({
      address: token, abi: tokenAbi, functionName: "allowance", args: [owner, PERMIT2],
    }) as Promise<bigint>,
    client.readContract({
      address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [owner, token, UNIVERSAL_ROUTER],
    }) as Promise<readonly [bigint, number, number]>,
  ]);
  return { erc20, permit2Amount: p2[0], permit2Expiration: p2[1] };
}

/** Whether both approvals are already in place, so a sell is a single send. */
export async function approvalsReady(owner: Address, token: Address, amount: bigint): Promise<boolean> {
  try {
    const [erc20, p2] = await Promise.all([
      client.readContract({
        address: token, abi: tokenAbi, functionName: "allowance", args: [owner, PERMIT2],
      }) as Promise<bigint>,
      client.readContract({
        address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [owner, token, UNIVERSAL_ROUTER],
      }) as Promise<readonly [bigint, number, number]>,
    ]);
    const now = Math.floor(Date.now() / 1000);
    return erc20 >= amount && p2[0] >= amount && p2[1] > now;
  } catch {
    return false;
  }
}

// --- the official Quoter ---------------------------------------------------

/**
 * clank.trade's V4 Quoter on Robinhood Chain (developer.clank.trade, Contracts;
 * V4R D4). It answers an exact-input quote through eth_call. It cross-checks
 * the router simulation below, which stays the quote: the simulation is the
 * real fill, through the very calldata that will be sent.
 */
export const V4_QUOTER = getAddress(
  process.env.V4_QUOTER ?? "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
/** How far the simulated fill and the Quoter may differ: the page's own quote tolerance, 1%. */
export const QUOTER_TOLERANCE_BPS = 100n;

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** The Quoter's output for this swap, or null when it does not answer. */
export async function quoterOut(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await client.simulateContract({
      address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return result[0];
  } catch {
    return null;
  }
}

/**
 * Why a simulated fill cannot be trusted against the Quoter, or null. A Quoter
 * that did not answer is not a disagreement: a quote must never be what
 * strands a position someone is trying to leave, so the caller warns instead.
 */
export function quoterDisagrees(simOut: bigint, quoted: bigint | null): string | null {
  if (quoted === null || quoted === 0n) return null;
  const diff = simOut > quoted ? simOut - quoted : quoted - simOut;
  if (diff * 10_000n <= quoted * QUOTER_TOLERANCE_BPS) return null;
  return `The router's simulated fill (${simOut}) and clank.trade's V4 Quoter (${quoted}) differ by more than `
    + `${Number(QUOTER_TOLERANCE_BPS) / 100}%, so neither is trusted.`;
}

// --- quoting ---------------------------------------------------------------

/** traceTransfers reports native ETH movements against this pseudo-address. */
const NATIVE_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type SimLog = { address: string; topics: string[]; data: Hex };
type SimCall = { status: Hex; logs?: SimLog[]; error?: { message?: string } };

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const topicAddr = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

/** Total of `asset` moved to (or from) `who` in one simulated call. */
function moved(call: SimCall, asset: string, who: Address, incoming: boolean): bigint {
  const me = topicAddr(who);
  return (call.logs ?? [])
    .filter((l) => l.address.toLowerCase() === asset.toLowerCase()
      && l.topics[0] === TRANSFER_TOPIC
      && (incoming ? l.topics[2] : l.topics[1])?.toLowerCase() === me)
    .reduce((s, l) => s + BigInt(l.data), 0n);
}

async function simulate(from: Address, calls: object[]): Promise<SimCall[]> {
  const res = (await client.request({
    method: "eth_simulateV1",
    params: [{
      // Gas only. The token balance is deliberately not overridden: the point
      // of a quote is what this wallet can actually sell right now.
      blockStateCalls: [{ stateOverrides: { [from]: { balance: "0x56bc75e2d63100000" } }, calls }],
      validation: false,
      traceTransfers: true,
    }, "latest"],
  } as never)) as Array<{ calls: SimCall[] }>;
  return res[0]?.calls ?? [];
}

export type Quote =
  | { ok: true; out: bigint; pool: PoolState; approvalsNeeded: boolean }
  | { ok: false; error: string; pool: PoolState | null };

/**
 * Quote a sell by simulating the transaction that would actually be sent.
 *
 * Reimplementing V4's tick maths in TypeScript to predict a fill would be a
 * second implementation, wrong in exactly the cases that matter: a thin pool,
 * a large size, a tick boundary. `eth_simulateV1` runs the real router against
 * real state, so what comes back is the fill, fees and price impact included.
 * clank.trade's V4 Quoter, read alongside, must agree (V4R D4).
 *
 * The approvals are included in the simulated sequence so the number does not
 * depend on whether they happen to be in place yet.
 */
export async function quoteSell(owner: Address, token: Address, amountIn: bigint): Promise<Quote> {
  const pool = await poolFor(token);
  if (!pool) return { ok: false, error: "no canonical V4 pool for this token", pool: null };
  if (pool.liquidity === 0n) return { ok: false, error: "the V4 pool has no liquidity", pool };
  if (amountIn <= 0n) return { ok: false, error: "nothing to sell", pool };

  const approvals = approvalCalls(token, amountIn)
    .map((c) => ({ from: owner, to: c.to, value: "0x0", data: c.data }));
  const [seq, quoted] = await Promise.all([
    simulate(owner, [
      ...approvals,
      { from: owner, to: UNIVERSAL_ROUTER, value: "0x0", data: buildSell(pool.key, amountIn, 0n, deadline()) },
    ]),
    quoterOut(pool.key, false, amountIn),
  ]);

  const swap = seq[seq.length - 1];
  if (!swap || swap.status !== "0x1") {
    return { ok: false, pool, error: swap?.error?.message ?? "the swap reverted in simulation" };
  }
  const out = moved(swap, NATIVE_LOG, owner, true);
  const mismatch = quoterDisagrees(out, quoted);
  if (mismatch) return { ok: false, pool, error: mismatch };
  return { ok: true, pool, out, approvalsNeeded: !(await approvalsReady(owner, token, amountIn)) };
}

/** Quote a buy the same way. ETH in, tokens out. */
export async function quoteBuy(owner: Address, token: Address, ethIn: bigint): Promise<Quote> {
  const pool = await poolFor(token);
  if (!pool) return { ok: false, error: "no canonical V4 pool for this token", pool: null };
  if (pool.liquidity === 0n) return { ok: false, error: "the V4 pool has no liquidity", pool };

  const [seq, quoted] = await Promise.all([
    simulate(owner, [{
      from: owner, to: UNIVERSAL_ROUTER, value: `0x${ethIn.toString(16)}`,
      data: buildBuy(pool.key, ethIn, 0n, deadline()),
    }]),
    quoterOut(pool.key, true, ethIn),
  ]);
  const swap = seq[0];
  if (!swap || swap.status !== "0x1") {
    return { ok: false, pool, error: swap?.error?.message ?? "the swap reverted in simulation" };
  }
  const out = moved(swap, token, owner, true);
  const mismatch = quoterDisagrees(out, quoted);
  if (mismatch) return { ok: false, pool, error: mismatch };
  return { ok: true, pool, out, approvalsNeeded: false };
}

/**
 * Value a holding at spot, without simulating.
 *
 * For dry-run positions, which hold no tokens for a simulation to move. It
 * ignores price impact and the LP fee, so it reads high on any size that
 * matters — callers that can simulate should, and this is labelled as an
 * estimate wherever it reaches the screen.
 */
export function spotValue(pool: PoolState, tokens: bigint): bigint {
  if (pool.tokensPerEth <= 0) return 0n;
  return BigInt(Math.floor(Number(tokens) / pool.tokensPerEth));
}
