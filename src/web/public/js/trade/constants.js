// Everything the step verifier trusts, pinned in the page.
//
// None of it comes from our API. A compromised API can propose any
// transaction it likes, and these are what the browser checks it against
// before a wallet opens. `npm run test:constants` checks every value against
// src/core (the chain, the router builders) and against viem's selectors, so
// the page and the server cannot drift apart.

/** Robinhood Chain. */
export const CHAIN_ID = 4663;

/**
 * The chain's public RPC. The trading wallet's reads, receipts and broadcasts
 * go here, straight from the page, and never through our origin (W1.1): a
 * compromised server could otherwise lie to the API and the verifier at once.
 * It answers any origin (checked in the W0 spike).
 */
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/**
 * The trading wallet's fast RPC (the user, 2026-09-23): a browser-only
 * Alchemy app, about five times quicker per read than the public node. Its
 * key is public on purpose, since anyone can read it here; the app's origin
 * allowlist (clankuwu.com, cumtrade.com until the move is done, localhost)
 * and its monthly cap protect it. It is
 * never the server's key. Reads try it first and fall back to PUBLIC_RPC; a
 * send goes to both at once. Like PUBLIC_RPC it is pinned in the release,
 * never taken from our server.
 */
export const FAST_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/alch_oCewHudYZbegVV11Mt9N0";

export const UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Native ETH as a V4 currency. It sorts below every launch token. */
export const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Launch factories whose registry is believed: clank.trade's first, and the
 * second it moved to on 2026-09-22 (public-release B1.5). A token counts only
 * through the one its own curve names, and that factory's hook is the only
 * one a V4 pool may carry.
 */
export const FACTORIES = [
  "0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1",
  "0x798daaa0707c1e538bb5acf0867ac0e1a84cccf2",
];

/** Calls a plan may contain. */
export const SEL = {
  /** ERC20 approve(address,uint256) */
  erc20Approve: "0x095ea7b3",
  /** Permit2 approve(address,address,uint160,uint48) */
  permit2Approve: "0x87517c45",
  /** curve buy(uint256,uint256,address), payable */
  curveBuy: "0x59a87bc1",
  /** curve sell(uint256,uint256,address) */
  curveSell: "0xd04c6983",
  /** Universal Router execute(bytes,bytes[],uint256) */
  execute: "0x3593564c",
};

/** Reads the verifier makes through the visitor's own provider. */
export const READ = {
  /** token curve() */
  curve: "0x7165485d",
  /** curve token() */
  token: "0xfc0c546a",
  /** curve factory() */
  factory: "0xc45a0155",
  /** curve graduated() */
  graduated: "0xe7c2b772",
  /** factory getLaunchedToken(address): a registry struct, token and curve first */
  getLaunchedToken: "0x3cf28b5a",
  /** factory memeHook() */
  memeHook: "0x6651812c",
  // The signing sequence's own reads (F3.2): what a sell holds, and whether an
  // approval step is already covered.
  /** token balanceOf(address) */
  balanceOf: "0x70a08231",
  /** token allowance(address owner, address spender) */
  allowance: "0xdd62ed3e",
  /** Permit2 allowance(address owner, address token, address spender) → (uint160 amount, uint48 expiration, uint48 nonce) */
  permit2Allowance: "0x927da105",
  // The page's own quote (F3.3).
  /** curve quoteBuyFor(address buyer, uint256 amountIn) → 5 words, tokensOut fourth */
  quoteBuyFor: "0x5ed0447d",
  /** curve quoteSell(uint256 tokensIn) → (gross, net, fee) */
  quoteSell: "0xa64190c4",
  /** factory poolManager() */
  poolManager: "0xdc4c90d3",
  /** V4 PoolManager extsload(bytes32 slot) → bytes32 */
  extsload: "0x1e2eaeaf",
};

/** Universal Router command: one V4 swap. */
export const V4_SWAP = 0x10;
/** v4-periphery actions, in the only order a plan may use them. */
export const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f;

/** The slippage range the server clamps to. An intent outside it cannot match a plan. */
export const SLIPPAGE_MIN_BPS = 10, SLIPPAGE_MAX_BPS = 5000;

/** Limits on what a plan may ask a wallet to grant or wait for. */
export const MAX_APPROVE_EXPIRY_S = 3600;
export const MAX_DEADLINE_S = 1800;
export const MAX_GAS = 3_000_000;

// The trading wallet's approvals ahead of need (W3.2, TW6), which amend P3's
// hour for it alone.
/** How long its Permit2 allowance to the router may last: 7 days. */
export const APPROVE_AHEAD_EXPIRY_S = 7 * 86_400;
/** A Permit2 allowance this close to expiring is given again at the next fill or visit: 1 day. */
export const APPROVE_AHEAD_RENEW_S = 86_400;

// The trading wallet's own limits (W1.1), checked in wallet/embedded.js before
// anything is signed.
/** The base fee above which nothing is signed: 10 gwei, about 150 times the fee in September 2026. */
export const MAX_BASE_FEE_WEI = 10_000_000_000n;
/** Sends a minute from one browser, across its tabs. A loop, a bug or a lying API cannot run past it. */
export const MAX_SENDS_PER_MINUTE = 12;

/**
 * How far a plan's expected output may fall short of the page's own figure
 * (F3.3): this, or the visitor's slippage if that is smaller. It covers the
 * price moving between prepare and the page's reads.
 */
export const QUOTE_TOLERANCE_BPS = 100;
