import {
  getAddress, parseEther, encodeFunctionData, zeroAddress,
  type Address,
} from "viem";
import { client } from "../lib/client.js";
import { FACTORIES, VENUE, genesisFloor, type Factory } from "../chain.js";
import { curveAbi, factoryAbi, tokenAbi, TOKEN_SELECTORS } from "../abi.js";
import { immutable, cached, seed } from "../lib/cache.js";
import { launchOf, launchesByCreator } from "../lib/launchIndex.js";

export type Analysis = Awaited<ReturnType<typeof analyze>>;
/**
 * A wallet holding the token. `firstIn` is what it received in the block it
 * first appears in: for a wallet first seen in the launch block, what it
 * bought there, whatever it has bought or sold since.
 */
export type Holder = { address: Address; balance: bigint; firstBlock: bigint; firstIn: bigint };
export type PriorLaunch = {
  token: Address; curve: Address; block: bigint;
  raised: bigint; graduated: boolean; symbol: string;
};

/** Governance values can change, but not between two reads seconds apart. */
const GOV_TTL = 60_000;
/**
 * A token's own Transfer replay, for one the chain index has not caught up
 * yet (D1.2): a launch seconds old, or a process with no index. Kept just
 * long enough that the board and the sniper looking at the same new launch
 * share one scan.
 */
const HOLDER_TTL = 10_000;

/** Holders from the chain index, where it has them (D1.2). */
type IndexedHolders = (token: string) => {
  holders: { address: string; balance: bigint; firstBlock: bigint; firstIn: bigint }[];
} | null;
let fromIndex: IndexedHolders = () => null;

/**
 * Read holders from the chain index (chainIndex.ts sets this). A token the
 * index has caught up is answered from it with no log scan; any other is
 * scanned as before.
 */
export function useIndexedHolders(fn: IndexedHolders) {
  fromIndex = fn;
}

/**
 * Walk a contract's dispatcher and pull out every 4-byte selector it handles.
 * Every clank token has a unique codehash (constructor immutables are baked
 * in), so the selector SET is what identifies a canonical launch token.
 */
export function selectorsOf(code: `0x${string}`): string[] {
  const b = Buffer.from(code.slice(2), "hex");
  const out = new Set<string>();
  for (let i = 0; i < b.length - 5; ) {
    const op = b[i]!;
    if (op === 0x63) {
      const next = b[i + 5];
      if (next !== undefined && [0x14, 0x81, 0x80, 0x90, 0x11, 0x10].includes(next)) {
        out.add("0x" + b.subarray(i + 1, i + 5).toString("hex"));
      }
      i += 5;
    } else if (op >= 0x60 && op <= 0x7f) {
      i += op - 0x5f + 1;
    } else {
      i += 1;
    }
  }
  return [...out].sort();
}

/**
 * Fixed at deploy: name, symbol, decimals, logo. Never re-read.
 *
 * Not the supply. Tokens from clank.trade's second factory have a working
 * burn(uint256) that lowers it (on the first factory's, burn always reverts),
 * so it is read live with the curve.
 */
function tokenConstants(token: Address) {
  return immutable(`tok:${token.toLowerCase()}`, async () => {
    const T = { address: token, abi: tokenAbi } as const;
    const [name, symbol, decimals, logo] = await Promise.all([
      client.readContract({ ...T, functionName: "name" }),
      client.readContract({ ...T, functionName: "symbol" }),
      client.readContract({ ...T, functionName: "decimals" }),
      client.readContract({ ...T, functionName: "logo" }).catch(() => ""),
    ]);
    return { name, symbol, decimals, logo };
  });
}

/**
 * Curve parameters fixed at launch: fee, graduation threshold, the phantom and
 * virtual reserves, quote asset, wiring. These are the bulk of what a naive
 * implementation re-reads on every refresh.
 */
function curveConstants(curve: Address) {
  return immutable(`curve:${curve.toLowerCase()}`, async () => {
    const C = { address: curve, abi: curveAbi } as const;
    const nil = () => null;
    const [token, factory, creator, pairToken, isNative, feeBps, gradThreshold, launchedAt, phantom, virtualToken] =
      await Promise.all([
        client.readContract({ ...C, functionName: "token" }),
        client.readContract({ ...C, functionName: "factory" }).catch(nil),
        client.readContract({ ...C, functionName: "creator" }).catch(nil),
        client.readContract({ ...C, functionName: "pairToken" }),
        client.readContract({ ...C, functionName: "isNativeQuote" }),
        client.readContract({ ...C, functionName: "feeBps" }),
        client.readContract({ ...C, functionName: "graduationThreshold" }),
        client.readContract({ ...C, functionName: "launchedAt" }),
        client.readContract({ ...C, functionName: "phantomQuote" }),
        client.readContract({ ...C, functionName: "virtualTokenReserve" }).catch(nil),
      ]);
    return { token, factory, creator, pairToken, isNative, feeBps, gradThreshold, launchedAt, phantom, virtualToken };
  });
}

/** Everything that actually moves. Always read fresh, in one multicall. */
/**
 * The curve's live numbers.
 *
 * Two of these are not on every venue's curve (pons-venue.md V2), and each has
 * an exact stand-in rather than a guess:
 *
 *   state()             the lifecycle is graduation, so `graduated` gives the
 *                       same 0-while-trading, 2-once-graduated the interlock
 *                       already reads
 *   realTokenReserve()  the curve's own token balance, which is what it is —
 *                       equal on 10 of 10 clank curves, where both exist
 */
async function curveLive(curve: Address, token: Address) {
  const C = { address: curve, abi: curveAbi } as const;
  const [quote, tokenRes, realQuote, graduated, readyToGrad, snipeStart, snipeSecs] = await Promise.all([
    client.readContract({ ...C, functionName: "quoteReserve" }),
    client.readContract({ ...C, functionName: "tokenReserve" }),
    client.readContract({ ...C, functionName: "realQuoteReserve" }),
    client.readContract({ ...C, functionName: "graduated" }),
    client.readContract({ ...C, functionName: "readyToGraduate" }),
    client.readContract({ ...C, functionName: "snipeTaxStartBps" }),
    client.readContract({ ...C, functionName: "snipeTaxSeconds" }),
  ]);
  const realToken = VENUE.curve.realTokenReserve
    ? await client.readContract({ ...C, functionName: "realTokenReserve" })
    : await client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [curve] });
  const state = VENUE.curve.state
    ? await client.readContract({ ...C, functionName: "state" })
    : (graduated ? 2 : 0);
  return [quote, tokenRes, realQuote, realToken, graduated, readyToGrad, state, snipeStart, snipeSecs] as const;
}

function tokenSelectors(token: Address) {
  return immutable(`code:${token.toLowerCase()}`, async () => {
    const code = await client.getCode({ address: token });
    return code ? selectorsOf(code) : [];
  });
}

/** One listed factory's answer about a token: its registry entry and governance. */
export type FactoryRead = {
  factory: Factory;
  registry: { token: Address; curve: Address };
  owner: Address | null;
  snipeStart: bigint | null;
  maxFee: bigint | null;
};

/**
 * Every listed factory's registry entry for the token, plus its governance
 * state. Owner and snipe-tax defaults are mutable, but only by governance.
 *
 * All of them, not only the one the curve names: they are read in the same
 * wave as the curve, so they fold into the same multicall, and which one
 * decides is chosen afterwards by `ownRegistry`. Reading the curve first would
 * put a round trip in front of every first look, the sniper's included.
 *
 * The registry read is not caught. It answers zeros rather than reverting for
 * a token the factory never launched, so a failure is the RPC or a changed
 * factory, and a verdict without it would have no authenticity check at all.
 */
function factoryState(token: Address): Promise<FactoryRead[]> {
  const nil = () => null;
  return cached(`factory:${token.toLowerCase()}`, GOV_TTL, () => Promise.all(FACTORIES.map(async (factory) => {
    const F = { address: factory.address as Address, abi: factoryAbi } as const;
    const [[listedToken, listedCurve], owner, snipeStart, maxFee] = await Promise.all([
      client.readContract({ ...F, functionName: "getLaunchedToken", args: [token] }),
      client.readContract({ ...F, functionName: "owner" }).catch(nil),
      client.readContract({ ...F, functionName: "snipeTaxStartBps" }).catch(nil),
      client.readContract({ ...F, functionName: "MAX_CURVE_FEE_BPS" }).catch(nil),
    ]);
    return { factory, registry: { token: listedToken, curve: listedCurve }, owner, snipeStart, maxFee };
  })));
}

/**
 * Does the factory's registry list this token with this curve? A contract can
 * claim any factory; the registry is the factory's own answer, so it is the
 * one check a fake token with a fake curve cannot pass.
 */
export function registryNames(registry: { token: Address; curve: Address }, token: Address, curve: Address) {
  return registry.token.toLowerCase() === token.toLowerCase()
    && registry.curve.toLowerCase() === curve.toLowerCase();
}

const NO_ENTRY = { token: zeroAddress, curve: zeroAddress } as { token: Address; curve: Address };

/**
 * Which factory's registry decides, and whether it lists this token with this
 * curve (public-release B1.5).
 *
 * Only the factory the curve names can register it, and only if that factory
 * is listed. Another listed factory's entry never counts: a curve that names
 * factory B is not made genuine by factory A having launched the token. So a
 * curve naming an unlisted factory, or a listed one whose registry does not
 * name this pairing, is not registered.
 *
 * The entry reported is the curve's own factory's. When the curve names no
 * listed factory, it is whichever listed registry names the token, so the
 * finding can say which curve is the real one.
 */
export function ownRegistry(reads: readonly FactoryRead[], curveFactory: string | null, token: Address, curve: Address) {
  const own = curveFactory
    ? reads.find((r) => r.factory.address.toLowerCase() === curveFactory.toLowerCase())
    : undefined;
  if (own) return { own, registry: own.registry, registered: registryNames(own.registry, token, curve) };
  const named = reads.find((r) => r.registry.token.toLowerCase() === token.toLowerCase());
  return { own, registry: named?.registry ?? NO_ENTRY, registered: false };
}

export type AnalyzeOpts = {
  /** Deep mode also scans the creator's prior launches (now served from the index). */
  deep?: boolean;
};

export async function analyze(input: Address, opts: AnalyzeOpts = {}) {
  const deep = opts.deep ?? true;
  const addr = getAddress(input);

  // Accept either the token or the curve address as input.
  let token = addr;
  let curve: Address;
  try {
    curve = await immutable(`link:${addr.toLowerCase()}`, () =>
      client.readContract({ address: addr, abi: tokenAbi, functionName: "curve" }));
  } catch {
    token = await client.readContract({ address: addr, abi: curveAbi, functionName: "token" });
    curve = addr;
  }

  // One wave: constants come from cache after the first look, live values and
  // the bytecode profile fold into a single multicall.
  const [tk, cv, live, sels, fac, launch, totalSupply] = await Promise.all([
    tokenConstants(token),
    curveConstants(curve),
    curveLive(curve, token),
    tokenSelectors(token),
    factoryState(token),
    launchOf(token),
    client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
  ]);

  const [quoteReserve, tokenReserve, realQuote, realToken, graduated, readyToGrad, state, snipeStart, snipeSecs] = live;
  // Not every venue's curve names its creator (Pons' reverts). The factory's
  // own Launch event does, and the index already holds it. Without either
  // there is no dev-buy or bundle analysis to do, and judging a launch whose
  // creator is unknown would quietly read every creator rule as "not the
  // creator" — so this refuses instead.
  const creator = cv.creator ?? launch?.creator;
  if (!creator) {
    throw new Error(
      `no creator for ${token}: ${VENUE.label}'s curve does not expose creator() and the launch index has no record of it`);
  }
  const launchBlock = launch?.block ?? 0n;

  const canonical = new Set<string>(TOKEN_SELECTORS);
  const missing = [...canonical].filter((s) => !sels.includes(s));
  const extra = sels.filter((s) => !canonical.has(s) && s !== "0x4e487b71");

  // Judged against the factory the curve names, and only a listed one.
  const reg = ownRegistry(fac, cv.factory, token, curve);

  const [sim, holders, creatorLaunches] = await Promise.all([
    simulateRoundTrip(curve, token, parseEther("0.01")),
    // No launch block known: this token's own factory cannot have launched it
    // before it existed, so its genesis floors the scan.
    holderSet(token, curve, launchBlock > 0n ? launchBlock : (reg.own?.factory.genesisBlock ?? genesisFloor())),
    deep ? priorLaunches(creator, token) : Promise.resolve([] as PriorLaunch[]),
  ]);

  return {
    token, curve,
    name: tk.name, symbol: tk.symbol, decimals: tk.decimals,
    totalSupply, logo: tk.logo,
    curveToken: cv.token, curveFactory: cv.factory, creator,
    quoteReserve, tokenReserve, realQuote, realToken,
    virtualToken: cv.virtualToken, phantom: cv.phantom,
    gradThreshold: cv.gradThreshold, graduated, readyToGrad, state,
    launchedAt: cv.launchedAt, feeBps: cv.feeBps,
    snipeStart, snipeSecs, isNative: cv.isNative, pairToken: cv.pairToken,
    registry: reg.registry, registered: reg.registered,
    // Governance of the token's own factory. A curve that names no listed
    // factory has none of ours to report.
    factoryOwner: reg.own?.owner ?? null,
    factorySnipeStart: reg.own?.snipeStart ?? null, maxCurveFee: reg.own?.maxFee ?? null,
    sels, missing, extra, sim, launchBlock, holders, creatorLaunches, deep,
  };
}

/**
 * The creator's other launches, and how each one ended. The launch list comes
 * from the shared index (no scan); only the per-curve status is read, and that
 * folds into one multicall.
 */
async function priorLaunches(creator: Address, exclude: Address): Promise<PriorLaunch[]> {
  const prior = (await launchesByCreator(creator, exclude)).slice(-10);
  if (prior.length === 0) return [];
  return Promise.all(
    prior.map(async (l) => ({
      token: l.token, curve: l.curve, block: l.block,
      raised: await client.readContract({
        address: l.curve, abi: curveAbi, functionName: "realQuoteReserve",
      }).catch(() => 0n),
      graduated: await client.readContract({
        address: l.curve, abi: curveAbi, functionName: "graduated",
      }).catch(() => false),
      symbol: await tokenConstants(l.token).then((t) => t.symbol).catch(() => "?"),
    })),
  );
}

/** Custom errors seen on these curves, by 4-byte signature. */
const KNOWN_ERRORS: Record<string, string> = {
  "0x3d5b7999": "InsufficientRealReserve()",
};

export type SimCall = { status: `0x${string}`; returnData: `0x${string}`; error?: { message?: string } };

/**
 * Prove the token is genuinely sellable with an ATOMIC buy -> approve -> sell
 * round trip via eth_simulateV1, where state carries across calls. A plain
 * eth_call cannot do this: the buy would not persist, so the sell reverts with
 * InsufficientRealReserve on any curve that has not raised yet.
 *
 * The quote and the simulation are read at one block (current-issues.md #4).
 * The sell is of the quoted amount; at a later block, a buy by anyone in
 * between leaves the probe short, and selling even 1 wei more than it holds
 * reverts, which read as "can't sell" on busy tokens that could be sold.
 *
 * Only a sell or approve that reverts after a good buy says the token cannot
 * be sold. A check that could not run (the node failing, the quote or the buy
 * reverting) says nothing either way: it is `unknown`, kept for a short while
 * so the next check tries again.
 */
const PROBE = "0x00000000000000000000000000000000000c1a4e" as Address;
const PROBE_BALANCE = "0x56bc75e2d63100000"; // 100 ETH
/** Round trips per eth_simulateV1 request (3 calls each). */
const SIM_CHUNK = 8;
const SIM_TTL = 90_000;
/** How long a check that could not run is kept: the next one soon tries again. */
export const SIM_UNKNOWN_TTL = 10_000;

export type SimResult = ReturnType<typeof simFail> | ReturnType<typeof simUnknown> | {
  ok: true; amountIn: bigint; tokensOut: bigint; bought: bigint; quoteOut: bigint;
  roundTripBps: number; sellBlocked: false; unknown: false; error: null;
};

/** The sell (or its approve) reverted after a good buy: this cannot be sold. */
function simFail(amountIn: bigint, error: string, tokensOut = 0n) {
  return {
    ok: false as const, amountIn, tokensOut, bought: 0n, quoteOut: 0n,
    roundTripBps: 0, sellBlocked: true as const, unknown: false as const, error,
  };
}

/** The check could not run, so whether it can be sold is not known. */
function simUnknown(amountIn: bigint, error: string, tokensOut = 0n) {
  return {
    ok: false as const, amountIn, tokensOut, bought: 0n, quoteOut: 0n,
    roundTripBps: 0, sellBlocked: false as const, unknown: true as const, error,
  };
}

/** The three calls that prove one token is sellable. */
function roundTripCalls(curve: Address, token: Address, amountIn: bigint, tokensOut: bigint) {
  return [
    {
      from: PROBE, to: curve, value: `0x${amountIn.toString(16)}`,
      data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [amountIn, 0n, PROBE] }),
    },
    {
      from: PROBE, to: token, value: "0x0",
      data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [curve, 2n ** 256n - 1n] }),
    },
    {
      from: PROBE, to: curve, value: "0x0",
      data: encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [tokensOut, 0n, PROBE] }),
    },
  ];
}

export function readTriple(amountIn: bigint, tokensOut: bigint, triple: SimCall[]): SimResult {
  const [buyCall, approveCall, sellCall] = triple;
  // No buy, nothing to sell: the sell was never tried.
  if (!buyCall || buyCall.status !== "0x1") return simUnknown(amountIn, `buy reverted: ${reason(buyCall)}`, tokensOut);
  if (!approveCall || approveCall.status !== "0x1") return simFail(amountIn, `approve reverted: ${reason(approveCall)}`, tokensOut);
  if (!sellCall || sellCall.status !== "0x1") {
    return simFail(amountIn, `SELL REVERTED after a successful buy: ${reason(sellCall)}`, tokensOut);
  }
  const quoteOut = BigInt(sellCall.returnData);
  return {
    ok: true, amountIn, tokensOut,
    bought: BigInt(buyCall.returnData), quoteOut,
    roundTripBps: amountIn > 0n ? Number((quoteOut * 10_000n) / amountIn) : 0,
    sellBlocked: false, unknown: false, error: null,
  };
}

/** The three chain reads a sell check makes, so a test can make them without a chain. */
export type SimIo = {
  blockNumber: () => Promise<bigint>;
  /** `quoteBuy(amountIn)`'s tokens out, at `block`. */
  quoteBuy: (curve: Address, amountIn: bigint, block: bigint) => Promise<bigint>;
  simulate: (calls: object[], block: bigint) => Promise<SimCall[]>;
};

const chainIo: SimIo = {
  blockNumber: () => client.getBlockNumber(),
  quoteBuy: async (curve, amountIn, block) => (await client.readContract({
    address: curve, abi: curveAbi, functionName: "quoteBuy", args: [amountIn], blockNumber: block,
  }))[3],
  simulate: async (calls, block) => {
    const res = (await client.request({
      method: "eth_simulateV1",
      params: [{
        blockStateCalls: [{
          stateOverrides: { [PROBE]: { balance: PROBE_BALANCE } },
          calls,
        }],
        validation: false,
        traceTransfers: false,
      }, `0x${block.toString(16)}`],
    } as never)) as Array<{ calls: SimCall[] }>;
    return res[0]?.calls ?? [];
  },
};

/** What a check says of a token's sell: true, false, or null when it could not run. */
export const sellableOf = (r: SimResult): boolean | null => (r.ok ? true : r.unknown ? null : false);

/** Keep a result: a check that could not run for a short while only. */
const keepSim = (curve: Address, r: SimResult) =>
  seed(`sim:${curve.toLowerCase()}`, r, r.unknown ? SIM_UNKNOWN_TTL : SIM_TTL);

/** One token's round trip, the quote and the simulation at one block. */
export async function roundTrip(io: SimIo, curve: Address, token: Address, amountIn: bigint): Promise<SimResult> {
  let block: bigint;
  try {
    block = await io.blockNumber();
  } catch (e) {
    return simUnknown(amountIn, `could not read the block: ${describe(e)}`);
  }
  let tokensOut: bigint;
  try {
    tokensOut = await io.quoteBuy(curve, amountIn, block);
  } catch (e) {
    return simUnknown(amountIn, `quoteBuy reverted: ${describe(e)}`);
  }
  try {
    return readTriple(amountIn, tokensOut, await io.simulate(roundTripCalls(curve, token, amountIn, tokensOut), block));
  } catch (e) {
    return simUnknown(amountIn, `eth_simulateV1 failed: ${describe(e)}`, tokensOut);
  }
}

/**
 * Prove many tokens sellable in one request.
 *
 * Distinct curves never touch each other's state, so N independent round trips
 * can share a single eth_simulateV1 sequence — 3N calls in one request instead
 * of N requests. Results are seeded into the same cache simulateRoundTrip
 * reads, so analyse() just finds them warm.
 */
export async function prefetchSims(
  entries: Array<{ token: Address; curve: Address }>,
  amountIn = parseEther("0.01"),
  io: SimIo = chainIo,
): Promise<void> {
  for (let i = 0; i < entries.length; i += SIM_CHUNK) {
    const chunk = entries.slice(i, i + SIM_CHUNK);
    // One block for the chunk's quotes and its simulation (current-issues.md #4).
    let block: bigint;
    try { block = await io.blockNumber(); } catch { continue; /* each token is checked on its own */ }
    const quotes = await Promise.all(chunk.map((e) => io.quoteBuy(e.curve, amountIn, block).catch(() => null)));
    const usable = chunk
      .map((e, j) => ({ ...e, tokensOut: quotes[j] }))
      .filter((e): e is typeof e & { tokensOut: bigint } => e.tokensOut !== null && e.tokensOut !== undefined);
    if (usable.length === 0) continue;

    try {
      const out = await io.simulate(usable.flatMap((e) => roundTripCalls(e.curve, e.token, amountIn, e.tokensOut)), block);
      usable.forEach((e, j) => keepSim(e.curve, readTriple(amountIn, e.tokensOut, out.slice(j * 3, j * 3 + 3))));
    } catch { /* fall back to per-token simulation */ }
  }
}

async function simulateRoundTrip(curve: Address, token: Address, amountIn: bigint): Promise<SimResult> {
  const r = await cached(`sim:${curve.toLowerCase()}`, SIM_TTL, () => roundTrip(chainIo, curve, token, amountIn));
  // Kept for its own time: a check that could not run is tried again soon.
  if (r.unknown) keepSim(curve, r);
  return r;
}

function reason(call: SimCall | undefined): string {
  if (!call) return "no result";
  const sig = call.returnData?.slice(0, 10);
  if (sig && KNOWN_ERRORS[sig]) return KNOWN_ERRORS[sig]!;
  return call.error?.message ?? call.returnData ?? "unknown";
}

function describe(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return String(err.shortMessage ?? err.message ?? e).slice(0, 160);
}

type RawLog = { topics: `0x${string}`[]; data: `0x${string}`; blockNumber: `0x${string}` };

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Reduce raw Transfer logs for one token into its live holder set. */
function foldTransfers(logs: RawLog[], curve: Address) {
  const firstSeen = new Map<string, bigint>();
  const firstIn = new Map<string, bigint>();
  for (const log of logs) {
    const from = `0x${log.topics[1]?.slice(26) ?? ""}`;
    const to = `0x${log.topics[2]?.slice(26) ?? ""}`;
    const block = BigInt(log.blockNumber);
    for (const a of [from, to]) {
      if (a.length !== 42) continue;
      const k = a.toLowerCase();
      if (k === "0x0000000000000000000000000000000000000000") continue;
      if (k === curve.toLowerCase()) continue;
      if (!firstSeen.has(k)) firstSeen.set(k, block);
    }
    // Tokens received in the block the receiver first appears in.
    const k = to.toLowerCase();
    if (firstSeen.get(k) === block && log.data && log.data !== "0x") {
      firstIn.set(k, (firstIn.get(k) ?? 0n) + BigInt(log.data.slice(0, 66)));
    }
  }
  return { firstSeen, firstIn };
}

async function balancesOf(
  token: Address, { firstSeen, firstIn }: { firstSeen: Map<string, bigint>; firstIn: Map<string, bigint> },
): Promise<Holder[]> {
  const list = [...firstSeen.keys()] as Address[];
  if (list.length === 0) return [];
  // Folded into a single Multicall3 aggregate3 by the client.
  const balances = await Promise.all(
    list.map((a) =>
      client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [a] })
        .catch(() => 0n),
    ),
  );
  return list
    .map((address, i) => ({
      address: getAddress(address),
      balance: balances[i]!,
      firstBlock: firstSeen.get(address.toLowerCase()) ?? 0n,
      firstIn: firstIn.get(address.toLowerCase()) ?? 0n,
    }))
    .filter((h) => h.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

/**
 * The node refused a scan for matching too many logs: the public node caps it
 * at 10,000; Alchemy (PAYG) at 10,000 past 5,000 blocks, with HTTP 400 and
 * "Log response size exceeded" (D1.0).
 */
const tooManyLogs = (e: unknown) =>
  /exceeds limit|more than \d+ results|too many (logs|results)|response size exceeded/i
    .test(`${(e as { details?: string })?.details ?? ""} ${(e as Error)?.message ?? ""}`);

/**
 * Transfer logs from `fromBlock` to the head, split into smaller block ranges
 * whenever the node says a range matched too many. A busy token (graduated,
 * trading on V4) passes 10,000 transfers, and one scan of it is refused.
 * Logs come back in block order, which `foldTransfers` relies on.
 */
async function transferLogs<T extends RawLog>(address: Address | Address[], fromBlock: bigint): Promise<T[]> {
  const head = await client.getBlockNumber();
  const scan = async (from: bigint, to: bigint): Promise<T[]> => {
    try {
      return (await client.request({
        method: "eth_getLogs",
        params: [{ address, topics: [TRANSFER_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      } as never)) as T[];
    } catch (e) {
      if (!tooManyLogs(e) || to <= from) throw e;
      const mid = from + (to - from) / 2n;
      return [...await scan(from, mid), ...await scan(mid + 1n, to)];
    }
  };
  return scan(fromBlock, head);
}

async function holderSet(token: Address, curve: Address, fromBlock: bigint): Promise<Holder[]> {
  const indexed = fromIndex(token);
  if (indexed) {
    return indexed.holders.map((h) => ({
      address: getAddress(h.address), balance: h.balance, firstBlock: h.firstBlock, firstIn: h.firstIn,
    }));
  }
  return cached(`holders:${token.toLowerCase()}`, HOLDER_TTL, async () => {
    const logs = await transferLogs(token, fromBlock > 0n ? fromBlock : genesisFloor());
    return balancesOf(token, foldTransfers(logs, curve));
  });
}
