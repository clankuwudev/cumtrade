import {
  APPROVE_AHEAD_EXPIRY_S, CHAIN_ID, FACTORIES, MAX_APPROVE_EXPIRY_S, MAX_DEADLINE_S, MAX_GAS, NATIVE, PERMIT2, READ, SEL,
  SETTLE_ALL, SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS, SWAP_EXACT_IN_SINGLE, TAKE_ALL, UNIVERSAL_ROUTER, V4_SWAP,
} from "./constants.js";
import {
  Malformed, addressAt, boolAt, bytesArrayAt, bytesAt, encBytes, encBytesArray, encTuple, hexBody, int24At,
  sizeAt, splitCall, uintAt, word,
} from "./abi.js";

// ====================================================================== //
// the step verifier                                                      //
// ====================================================================== //
//
// A plan from /api/prepare is a list of transactions our server would like the
// visitor's wallet to sign. This checks every one of them against what the
// visitor asked for (the intent), against addresses pinned in this page, and
// against reads made through the visitor's own provider, before any wallet
// opens. The plan's description of itself is never evidence: labels are
// ignored, and the quote is only used to check that the numbers the plan sheet
// will show are the numbers being signed.
//
// Anything that fails is refused, never warned about. A refusal means our API
// is compromised or broken.
//
// What this cannot defend against: a clone site ships its own copy of this
// file. The defence there is the domain, not code. And an API that lies about
// the expected output while keeping the minimum consistent with it gets
// through these rules; quote.js (F3.3) closes that with the page's own quote,
// which the sequence checks after these pass.
//
// Moving ETH between the visitor's own two wallets is checked here too
// (`verifyTransfer`), and so are the trading wallet's approvals ahead of need
// (`verifyApproveAhead`), both at the end of this file.

const lower = (a) => String(a).toLowerCase();
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => isAddress(a) && isAddress(b) && lower(a) === lower(b);
const byte = (n) => n.toString(16).padStart(2, "0");
/** A limit in seconds, in words: "60 minutes", "7 days". */
const span = (s) => (s % 86_400 === 0 ? `${s / 86_400} days` : `${s / 60} minutes`);

class Refused extends Error {
  /** @param {string} rule @param {string} reason */
  constructor(rule, reason) {
    super(reason);
    this.rule = rule;
  }
}

/** @param {unknown} cond @param {string} rule @param {string} reason */
function need(cond, rule, reason) {
  if (!cond) throw new Refused(rule, reason);
}

/** A non-negative decimal integer string, as a bigint. */
function decimal(v, rule, what) {
  need(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v), rule, `${what} is not a whole number: ${JSON.stringify(v)}.`);
  return BigInt(v);
}

/** A canonical JSON-RPC quantity (`0x0`, `0x2f9b8`), as a bigint. */
function quantity(v, rule, what) {
  need(typeof v === "string" && /^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v), rule, `${what} is not a hex quantity: ${JSON.stringify(v)}.`);
  return BigInt(v);
}

/** The bytes must be exactly what encoding the decoded values produces. */
function canonical(actual, expected, what) {
  need(actual === expected, "calldata", `${what} is not canonically encoded, so a contract could read it differently.`);
}

// --------------------------------------------------------------- reads --

/**
 * The reads the verifier needs, made through the visitor's own provider, so a
 * compromised API cannot answer them. Exactly these calls, in three waves:
 * the chain id, the latest block and `token.curve()`; then the curve's
 * `token()`, `factory()` and `graduated()`; then, only if that factory is one
 * we trust, its registry entry for the token and, once graduated, its
 * `memeHook()`.
 *
 * A read that fails throws. That is not a refusal and nothing is sent either
 * way; the caller says the token could not be read.
 *
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} request EIP-1193
 * @param {string} token
 */
export async function readIdentity(request, token) {
  if (!isAddress(token)) throw new Malformed("the token is not an address");
  const call = async (to, data) => hexBody(await request({ method: "eth_call", params: [{ to, data }, "latest"] }));

  const [chainId, block, curveWord] = await Promise.all([
    request({ method: "eth_chainId" }),
    request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
    call(token, READ.curve),
  ]);
  const tokenCurve = addressAt(curveWord, 0);

  const [tokenWord, factoryWord, graduatedWord] = await Promise.all([
    call(tokenCurve, READ.token),
    call(tokenCurve, READ.factory),
    call(tokenCurve, READ.graduated),
  ]);
  const curveFactory = addressAt(factoryWord, 0);
  const graduated = boolAt(graduatedWord, 0);

  let registry = null, memeHook = null;
  const factory = FACTORIES.find((f) => same(f, curveFactory));
  if (factory) {
    const [entry, hook] = await Promise.all([
      call(factory, READ.getLaunchedToken + word(token)),
      graduated ? call(factory, READ.memeHook) : Promise.resolve(null),
    ]);
    // A struct: the token and its curve first, then launch parameters. All
    // zeros, not a revert, for a token the factory never launched.
    registry = { token: addressAt(entry, 0), curve: addressAt(entry, 32) };
    memeHook = hook === null ? null : addressAt(hook, 0);
  }

  return {
    chainId: Number(quantity(chainId, "reads", "eth_chainId")),
    now: Number(quantity(block?.timestamp, "reads", "the latest block's timestamp")),
    tokenCurve, curveToken: addressAt(tokenWord, 0), curveFactory, graduated, registry, memeHook,
  };
}

// ---------------------------------------------------------------- plan --

/** The step kinds each trade may use, in order. Anything else is refused. */
const SEQUENCES = {
  "buy:curve": [["curve-buy"]],
  "buy:v4": [["router-swap"]],
  "sell:curve": [["curve-sell"], ["erc20-approve", "curve-sell"]],
  "sell:v4": [
    ["router-swap"], ["erc20-approve", "router-swap"], ["permit2-approve", "router-swap"],
    ["erc20-approve", "permit2-approve", "router-swap"],
  ],
};

/** The id each kind of step must carry. */
const IDS = {
  "erc20-approve": "approve-token", "permit2-approve": "approve-permit2",
  "curve-buy": "swap", "curve-sell": "swap", "router-swap": "swap",
};

/**
 * Check a prepared plan against the visitor's intent before any wallet opens.
 *
 * @param {any} plan the body of a 200 from /api/prepare
 * @param {{ side: "buy" | "sell", from: string, token: string, amountIn?: string, tokens?: string, slippageBps: number }} intent
 *   what the visitor asked for, in wei (a buy) or token base units (a sell)
 * @param {Awaited<ReturnType<typeof readIdentity>>} reads
 * @returns {{ ok: true } | { ok: false, step: number | null, rule: string, reason: string }}
 */
export function verifyPlan(plan, intent, reads) {
  let step = null;
  try {
    const ctx = checkPlan(plan, intent, reads);
    plan.steps.forEach((s, i) => {
      step = i;
      checkStep(s, ctx);
    });
    return { ok: true };
  } catch (e) {
    // A throw of any kind is a refusal. Nothing that goes wrong in here can
    // skip a check.
    const rule = e instanceof Refused ? e.rule : e instanceof Malformed ? "calldata" : "internal";
    return { ok: false, step, rule, reason: String(e?.message ?? e) };
  }
}

function checkPlan(plan, intent, reads) {
  need(plan && typeof plan === "object" && Array.isArray(plan.steps), "plan", "The server's answer is not a plan.");

  // What the visitor asked for, which the page assembled itself.
  need(intent && (intent.side === "buy" || intent.side === "sell"), "intent", "The trade is neither a buy nor a sell.");
  need(isAddress(intent.from) && isAddress(intent.token), "intent", "The wallet or token is not an address.");
  const side = intent.side;
  const amount = decimal(side === "buy" ? intent.amountIn : intent.tokens, "intent", "The amount asked for");
  need(amount > 0n, "intent", "The amount asked for is zero.");
  const slip = intent.slippageBps;
  need(Number.isInteger(slip) && slip >= SLIPPAGE_MIN_BPS && slip <= SLIPPAGE_MAX_BPS, "intent",
    `Slippage must be between ${SLIPPAGE_MIN_BPS} and ${SLIPPAGE_MAX_BPS} bps.`);
  need(reads && Number.isSafeInteger(reads.now) && reads.now > 0, "reads", "The chain's time was not read.");

  // Which chain. Reads from any other chain prove nothing about this one.
  need(plan.chainId === CHAIN_ID, "chain", `The plan is for chain ${plan.chainId}, not Robinhood Chain (${CHAIN_ID}).`);
  need(reads.chainId === CHAIN_ID, "chain", `Your wallet is on chain ${reads.chainId}, not Robinhood Chain (${CHAIN_ID}).`);

  // Who, what, which way.
  need(plan.side === side, "side", `The plan is a ${plan.side}, and you asked to ${side}.`);
  need(same(plan.from, intent.from), "from", `The plan is for wallet ${plan.from}, not ${intent.from}.`);
  need(same(plan.token, intent.token), "token", `The plan trades ${plan.token}, not ${intent.token}.`);

  const token = intent.token;
  const { curve, venue } = identity(plan, token, reads, "trades");

  // The numbers the plan sheet will show have to be the ones signed below.
  const q = plan.quote && typeof plan.quote === "object" ? plan.quote : {};
  const quoted = decimal(q.amountIn, "amount", "The quoted amount");
  need(quoted === amount, "amount", `The plan quotes ${quoted}, not the ${amount} you asked for.`);
  need(q.slippageBps === slip, "slippage", `The plan allows ${q.slippageBps} bps of slippage, not your ${slip}.`);
  const expected = decimal(q.expectedOut, "min-out", "The expected output");
  const minOut = decimal(q.minOut, "min-out", "The minimum output");
  need(minOut > 0n, "min-out", "The plan accepts receiving nothing.");
  need(minOut === (expected * BigInt(10_000 - slip)) / 10_000n, "min-out",
    `The plan's minimum ${minOut} is not ${slip / 100}% under its expected ${expected}.`);

  const kinds = plan.steps.map((s) => (s && typeof s === "object" ? s.kind : null));
  need(SEQUENCES[`${side}:${venue}`].some((seq) => JSON.stringify(seq) === JSON.stringify(kinds)), "sequence",
    `A ${venue === "v4" ? "Uniswap V4" : "curve"} ${side} cannot be the steps ${kinds.join(", ") || "(none)"}.`);

  return {
    side, from: intent.from, token, curve, venue, amount, minOut, now: reads.now, hook: reads.memeHook,
    expiry: MAX_APPROVE_EXPIRY_S, amountIs: "being sold",
  };
}

/**
 * Is this token a clank.trade launch, which curve is its own, and does the
 * plan use the venue the curve says it trades on? Every answer here came
 * through the visitor's provider.
 */
function identity(plan, token, reads, verb) {
  const curve = reads.tokenCurve;
  need(isAddress(curve) && same(reads.curveToken, token), "identity",
    `The token's curve ${curve} says its token is ${reads.curveToken}.`);
  need(FACTORIES.some((f) => same(f, reads.curveFactory)), "identity",
    `The token's curve names factory ${reads.curveFactory}, which is not a clank.trade factory.`);
  need(reads.registry && same(reads.registry.token, token) && same(reads.registry.curve, curve), "identity",
    `The factory's registry does not list ${token} with curve ${curve}.`);

  const venue = reads.graduated ? "v4" : "curve";
  need(plan.venue === venue, "venue",
    `The plan ${verb} on ${plan.venue}, but the curve ${reads.graduated ? "has graduated to Uniswap V4" : "has not graduated"}.`);
  if (venue === "v4") need(isAddress(reads.memeHook), "reads", "The factory's pool hook was not read.");
  return { curve, venue };
}

// --------------------------------------------------------------- steps --

function checkStep(s, c) {
  need(s.id === IDS[s.kind], "step", `A ${s.kind} step cannot be "${s.id}".`);
  const gas = quantity(s.gas, "gas", "The gas limit");
  need(gas > 0n && gas <= BigInt(MAX_GAS), "gas", `The gas limit ${gas} is outside 1 to ${MAX_GAS}.`);
  const value = quantity(s.value, "value", "The ETH value");
  const want = s.id === "swap" && c.side === "buy" ? c.amount : 0n;
  need(value === want, "value", want === 0n
    ? `The step sends ${value} wei of ETH. Only a buy may send ETH.`
    : `The buy sends ${value} wei, not the ${want} you asked to spend.`);
  STEPS[s.kind](s, c);
}

const STEPS = {
  "erc20-approve"(s, c) {
    need(same(s.to, c.token), "to", `An approval must be sent to the token ${c.token}, not ${s.to}.`);
    const { selector, args } = splitCall(s.data);
    need(selector === SEL.erc20Approve, "selector", `The approval calls ${selector}, not approve(address,uint256).`);
    const spender = addressAt(args, 0), amount = uintAt(args, 32);
    canonical(args, word(spender) + word(amount), "The approval");
    const allowed = c.venue === "curve" ? c.curve : PERMIT2;
    need(same(spender, allowed), "spender",
      `The approval lets ${spender} move your tokens, not ${c.venue === "curve" ? "this token's curve" : "Permit2"}.`);
    need(amount === c.amount, "amount", `The approval is for ${amount}, not exactly the ${c.amount} ${c.amountIs}.`);
  },

  "permit2-approve"(s, c) {
    need(same(s.to, PERMIT2), "to", `A Permit2 approval must be sent to Permit2, not ${s.to}.`);
    const { selector, args } = splitCall(s.data);
    need(selector === SEL.permit2Approve, "selector", `The Permit2 step calls ${selector}, not approve(address,address,uint160,uint48).`);
    const token = addressAt(args, 0), spender = addressAt(args, 32);
    const amount = uintAt(args, 64, 160), expiration = uintAt(args, 96, 48);
    canonical(args, word(token) + word(spender) + word(amount) + word(expiration), "The Permit2 approval");
    need(same(token, c.token), "token", `The Permit2 approval is for token ${token}, not ${c.token}.`);
    need(same(spender, UNIVERSAL_ROUTER), "spender", `The Permit2 approval lets ${spender} spend, not the Uniswap router.`);
    need(amount === c.amount, "amount", `The Permit2 approval is for ${amount}, not exactly the ${c.amount} ${c.amountIs}.`);
    need(expiration <= BigInt(c.now + c.expiry), "expiry",
      `The Permit2 approval lasts until ${expiration}, more than ${span(c.expiry)} from now.`);
  },

  "curve-buy"(s, c) { curveTrade(s, c, SEL.curveBuy, "buy"); },
  "curve-sell"(s, c) { curveTrade(s, c, SEL.curveSell, "sell"); },

  "router-swap"(s, c) {
    need(same(s.to, UNIVERSAL_ROUTER), "to", `A swap must be sent to the Uniswap router, not ${s.to}.`);
    const { selector, args } = splitCall(s.data);
    need(selector === SEL.execute, "selector", `The swap calls ${selector}, not execute(bytes,bytes[],uint256).`);
    const commands = bytesAt(args, 0), inputs = bytesArrayAt(args, 32), deadline = uintAt(args, 64);
    canonical(args, encTuple([{ tail: encBytes(commands) }, { tail: encBytesArray(inputs) }, { head: word(deadline) }]), "The router call");
    need(commands === byte(V4_SWAP) && inputs.length === 1, "commands",
      `The router is asked to run commands 0x${commands} with ${inputs.length} input(s), not exactly one V4 swap.`);
    need(deadline <= BigInt(c.now + MAX_DEADLINE_S), "deadline",
      `The swap's deadline ${deadline} is more than ${MAX_DEADLINE_S / 60} minutes from now.`);

    const input = inputs[0];
    const actions = bytesAt(input, 0), params = bytesArrayAt(input, 32);
    canonical(input, encTuple([{ tail: encBytes(actions) }, { tail: encBytesArray(params) }]), "The V4 input");
    need(actions === [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].map(byte).join("") && params.length === 3, "actions",
      `The V4 actions are 0x${actions} with ${params.length} parameter(s), not swap, settle all, take all.`);
    const [swap, settle, take] = params;

    // ExactInputSingleParams: the pool key, the direction, the amounts, and
    // hook data, behind one leading offset.
    const at = sizeAt(swap, 0);
    const currency0 = addressAt(swap, at), currency1 = addressAt(swap, at + 32);
    const fee = uintAt(swap, at + 64, 24), tickSpacing = int24At(swap, at + 96), hooks = addressAt(swap, at + 128);
    const zeroForOne = boolAt(swap, at + 160);
    const amountIn = uintAt(swap, at + 192, 128), amountOutMinimum = uintAt(swap, at + 224, 128);
    const hookData = bytesAt(swap, at + 256, at);
    canonical(swap, encTuple([{
      tail: encTuple([
        { head: [currency0, currency1, fee, tickSpacing, hooks, zeroForOne ? 1n : 0n, amountIn, amountOutMinimum].map(word).join("") },
        { tail: encBytes(hookData) },
      ]),
    }]), "The swap parameters");

    // The fee and tick spacing are not checked: only the factory can
    // initialise a pool carrying its hook, so the hook is the pool's identity.
    need(same(currency0, NATIVE) && same(currency1, c.token), "pool",
      `The swap's pool trades ${currency0} for ${currency1}, not ETH for ${c.token}.`);
    need(same(hooks, c.hook), "hooks",
      `The pool's hook is ${hooks}, not the factory's ${c.hook}, so it is not the pool this token graduated into.`);
    need(zeroForOne === (c.side === "buy"), "direction",
      `The swap goes ${zeroForOne ? "from ETH to the token" : "from the token to ETH"}, and you asked to ${c.side}.`);
    need(amountIn === c.amount, "amount", `The swap puts in ${amountIn}, not the ${c.amount} you asked for.`);
    need(amountOutMinimum === c.minOut, "min-out", `The swap accepts ${amountOutMinimum}, not the quoted minimum ${c.minOut}.`);
    need(hookData === "", "hook-data", "The swap passes data to the pool's hook.");

    const [paid, received] = c.side === "buy" ? [NATIVE, c.token] : [c.token, NATIVE];
    const settleCurrency = addressAt(settle, 0), settleAmount = uintAt(settle, 32);
    canonical(settle, word(settleCurrency) + word(settleAmount), "The settle parameters");
    need(same(settleCurrency, paid) && settleAmount === c.amount, "settle",
      `The swap settles ${settleAmount} of ${settleCurrency}, not ${c.amount} of ${paid}.`);
    const takeCurrency = addressAt(take, 0), takeAmount = uintAt(take, 32);
    canonical(take, word(takeCurrency) + word(takeAmount), "The take parameters");
    need(same(takeCurrency, received) && takeAmount === c.minOut, "take",
      `The swap takes at least ${takeAmount} of ${takeCurrency}, not ${c.minOut} of ${received}.`);
  },
};

/** buy(uint256 amountIn, uint256 minOut, address to) and sell with the same shape. */
function curveTrade(s, c, sel, name) {
  need(same(s.to, c.curve), "to", `The ${name} is sent to ${s.to}, not this token's curve ${c.curve}.`);
  const { selector, args } = splitCall(s.data);
  need(selector === sel, "selector", `The ${name} calls ${selector}, not the curve's ${name}.`);
  const amount = uintAt(args, 0), minOut = uintAt(args, 32), recipient = addressAt(args, 64);
  canonical(args, word(amount) + word(minOut) + word(recipient), `The ${name}`);
  need(amount === c.amount, "amount", `The ${name} is for ${amount}, not the ${c.amount} you asked for.`);
  need(minOut === c.minOut, "min-out", `The ${name} accepts ${minOut}, not the quoted minimum ${c.minOut}.`);
  need(same(recipient, c.from), "recipient", `The ${name} pays ${recipient}, not your wallet ${c.from}.`);
}

// ====================================================================== //
// transfers between the visitor's two wallets (W2.1)                     //
// ====================================================================== //
//
// A fund moves ETH from the main wallet (F2, the one they already use) to
// their trading wallet (W1.1). A withdraw moves everything the trading wallet
// holds, less its gas, back to the main wallet. The page builds both plans
// itself and asks no server, and they are still checked here, the same way as
// a trade: against what the visitor asked for, and against the wallets' own
// answers, read just now.
//
// Where the ETH goes is never an input. It is the receiving wallet's own
// `eth_accounts[0]`: never a typed address, and never one from storage or our
// server (TW4). A plan whose destination is anything else is refused.

/** Which wallet sends each kind of transfer, and which receives it. */
const TRANSFERS = {
  fund: { sender: "main", receiver: "trading" },
  withdraw: { sender: "trading", receiver: "main" },
};

/** The one step a transfer is. */
const TRANSFER_STEP = "transfer";

/**
 * The reads a transfer is checked against, each made through the wallet that
 * knows the answer. Exactly these calls:
 * - a fund: the main wallet's chain and account, and the trading wallet's
 *   account (3);
 * - a withdraw: the trading wallet's chain, account and latest block (for the
 *   base fee), the main wallet's chain and account, and then the trading
 *   wallet's balance (6).
 *
 * An empty account list (logged out, or disconnected) gives a null account;
 * that is an answer, not a failure. A read that fails throws, and nothing is
 * sent either way.
 *
 * @param {"fund" | "withdraw"} kind
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} main the main wallet's EIP-1193 request
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} trading the trading wallet's
 * @returns {Promise<{
 *   kind: "fund" | "withdraw",
 *   main: { chainId: number, account: string | null },
 *   trading: { chainId: number | null, account: string | null },
 *   balance: bigint | null, baseFee: bigint | null,
 * }>}
 */
export async function readTransfer(kind, main, trading) {
  if (!TRANSFERS[kind]) throw new Error(`${JSON.stringify(kind)} is not a transfer.`);
  const first = (list) => (Array.isArray(list) && isAddress(list[0]) ? list[0] : null);
  const chain = (v, who) => Number(quantity(v, "reads", `${who}'s eth_chainId`));

  if (kind === "fund") {
    const [mainChain, mainAccounts, tradingAccounts] = await Promise.all([
      main({ method: "eth_chainId" }),
      main({ method: "eth_accounts" }),
      trading({ method: "eth_accounts" }),
    ]);
    return {
      kind,
      main: { chainId: chain(mainChain, "the main wallet"), account: first(mainAccounts) },
      trading: { chainId: null, account: first(tradingAccounts) },
      balance: null, baseFee: null,
    };
  }

  const [tradingChain, tradingAccounts, block, mainChain, mainAccounts] = await Promise.all([
    trading({ method: "eth_chainId" }),
    trading({ method: "eth_accounts" }),
    trading({ method: "eth_getBlockByNumber", params: ["latest", false] }),
    main({ method: "eth_chainId" }),
    main({ method: "eth_accounts" }),
  ]);
  const account = first(tradingAccounts);
  const baseFee = quantity(block?.baseFeePerGas, "reads", "the latest block's base fee");
  const balance = account === null ? null
    : quantity(await trading({ method: "eth_getBalance", params: [account, "latest"] }), "reads", "the trading wallet's balance");
  return {
    kind,
    main: { chainId: chain(mainChain, "the main wallet"), account: first(mainAccounts) },
    trading: { chainId: chain(tradingChain, "the trading wallet"), account },
    balance, baseFee,
  };
}

/**
 * Check a transfer plan the page built, before anything is signed.
 *
 * @param {any} plan `{ kind, chainId, from, steps: [{ id: "transfer", kind, to, data, value, gas, maxFeePerGas? }] }`
 * @param {{ kind: "fund" | "withdraw", from: string, to: string, amountWei?: string }} intent
 *   what the visitor asked for, with both addresses as their wallets gave them when they pressed the button
 * @param {Awaited<ReturnType<typeof readTransfer>>} reads the wallets' answers now
 * @returns {{ ok: true } | { ok: false, step: number | null, rule: string, reason: string }}
 */
export function verifyTransfer(plan, intent, reads) {
  let step = null;
  try {
    const ctx = checkTransferPlan(plan, intent, reads);
    step = 0;
    checkTransferStep(plan.steps[0], ctx);
    return { ok: true };
  } catch (e) {
    const rule = e instanceof Refused ? e.rule : "internal";
    return { ok: false, step, rule, reason: String(e?.message ?? e) };
  }
}

function checkTransferPlan(plan, intent, reads) {
  need(plan && typeof plan === "object" && Array.isArray(plan.steps), "plan", "The transfer is not a plan.");

  // What the visitor asked for.
  const roles = intent && typeof intent === "object" ? TRANSFERS[intent.kind] : undefined;
  need(roles, "intent", "A transfer is a fund or a withdraw.");
  need(isAddress(intent.from) && isAddress(intent.to), "intent", "The transfer's wallets are not addresses.");
  let amount = null;
  if (intent.kind === "fund") {
    amount = decimal(intent.amountWei, "intent", "The amount to fund");
    need(amount > 0n, "intent", "The amount to fund is zero.");
  }
  need(reads && typeof reads === "object" && reads.main && reads.trading, "reads", "The wallets were not read.");
  if (intent.kind === "withdraw") {
    need(typeof reads.balance === "bigint" && typeof reads.baseFee === "bigint", "reads",
      "The trading wallet's balance and the base fee were not read.");
  }
  const sender = reads[roles.sender], receiver = reads[roles.receiver];

  need(plan.kind === intent.kind, "kind", `The plan is a ${plan.kind}, and you asked to ${intent.kind}.`);

  // Which chain. A transfer on any other chain would not arrive on this one.
  need(plan.chainId === CHAIN_ID, "chain", `The plan is for chain ${plan.chainId}, not Robinhood Chain (${CHAIN_ID}).`);
  need(sender.chainId === CHAIN_ID, "chain",
    `The ${roles.sender} wallet is on chain ${sender.chainId}, not Robinhood Chain (${CHAIN_ID}).`);
  // A withdraw pays an address the main wallet gave. Only a wallet working on
  // this chain vouches for an address here: a contract wallet deployed on one
  // chain alone has the same address, and no owner, on every other.
  if (intent.kind === "withdraw") {
    need(reads.main.chainId === CHAIN_ID, "chain",
      `Your main wallet is on chain ${reads.main.chainId}, not Robinhood Chain (${CHAIN_ID}), so it cannot vouch for its address here.`);
  }

  // Who sends: the wallet that holds the ETH, as it answers now, and as it
  // answered when the button was pressed.
  need(same(plan.from, sender.account) && same(plan.from, intent.from), "from",
    `The plan sends from ${plan.from}, but the ${roles.sender} wallet is ${sender.account}.`);
  need(!same(sender.account, receiver.account), "same-wallet",
    "Your main wallet and your trading wallet are the same address, so this would move nothing.");

  const kinds = plan.steps.map((s) => (s && typeof s === "object" ? s.kind : null));
  need(kinds.length === 1 && kinds[0] === intent.kind, "sequence",
    `A ${intent.kind} is one step, not ${kinds.join(", ") || "(none)"}.`);

  return { kind: intent.kind, receiver: receiver.account, to: intent.to, receiverRole: roles.receiver, amount, reads };
}

function checkTransferStep(s, c) {
  need(s.id === TRANSFER_STEP, "step", `A ${c.kind} step cannot be "${s.id}".`);
  // Where the ETH goes: the receiving wallet's own account, read now, and the
  // one the visitor was shown. Nothing typed, stored or served can get here.
  need(same(s.to, c.receiver) && same(s.to, c.to), "to",
    `The ${c.kind} goes to ${s.to}, not your ${c.receiverRole} wallet ${c.receiver}.`);
  need(s.data === "0x", "data", `A ${c.kind} carries no call, and this one carries ${String(s.data).slice(0, 10)}….`);
  const gas = quantity(s.gas, "gas", "The gas limit");
  need(gas > 0n && gas <= BigInt(MAX_GAS), "gas", `The gas limit ${gas} is outside 1 to ${MAX_GAS}.`);
  const value = quantity(s.value, "value", "The ETH value");

  if (c.kind === "fund") {
    need(value === c.amount, "value", `The fund sends ${value} wei, not the ${c.amount} you typed.`);
    return;
  }

  need(value > 0n, "value", "The withdraw sends nothing.");
  // The trading wallet caps its fee at twice the base fee when it signs
  // (W1.1). The reserve must assume at least that, or the balance cannot pay
  // for the gas it reserves.
  const fee = quantity(s.maxFeePerGas, "fee", "The fee cap");
  need(fee >= 2n * c.reads.baseFee, "fee",
    `The withdraw reserves gas at ${fee} wei, under twice the base fee (${c.reads.baseFee}) the trading wallet will pay up to.`);
  need(value + gas * fee <= c.reads.balance, "reserve",
    `The withdraw sends ${value} wei and keeps ${gas * fee} for its gas, more than the ${c.reads.balance} the trading wallet holds.`);
}

// ====================================================================== //
// approvals ahead of need (W3.2)                                         //
// ====================================================================== //
//
// Right after a buy fills, the trading wallet approves the token for the sell
// it will need, so that sell is one transaction (TW6, which amends P3 for the
// trading wallet only). The page builds the plan itself (approveAhead.js), and
// it is checked here with the trade's own step rules, apart from two numbers:
// - the amount is exactly what the wallet holds, `balanceOf(from)` read just
//   now through the RPC: never MAX, and never anything else;
// - the Permit2 allowance may last up to 7 days, not P3's hour, which would
//   lapse before most exits.
// The spenders are the trade's: the verified curve for a curve token, or
// Permit2 and then the Uniswap router once it has graduated.

/** The steps an approval ahead may be, by venue. There is never a swap. */
const AHEAD_SEQUENCES = {
  curve: [["erc20-approve"]],
  v4: [["erc20-approve"], ["permit2-approve"], ["erc20-approve", "permit2-approve"]],
};

/**
 * Check an approval-ahead plan the page built, before anything is signed.
 *
 * @param {any} plan `{ kind: "approve-ahead", chainId, from, token, venue, steps }`
 * @param {{ kind: "approve-ahead", from: string, token: string }} intent the wallet that trades, and the token it holds
 * @param {Awaited<ReturnType<typeof readIdentity>> & { balance: bigint }} reads the identity reads and
 *   `balanceOf(from)`, made just now through the RPC
 * @returns {{ ok: true } | { ok: false, step: number | null, rule: string, reason: string }}
 */
export function verifyApproveAhead(plan, intent, reads) {
  let step = null;
  try {
    const ctx = checkAheadPlan(plan, intent, reads);
    plan.steps.forEach((s, i) => {
      step = i;
      checkStep(s, ctx);
    });
    return { ok: true };
  } catch (e) {
    const rule = e instanceof Refused ? e.rule : e instanceof Malformed ? "calldata" : "internal";
    return { ok: false, step, rule, reason: String(e?.message ?? e) };
  }
}

function checkAheadPlan(plan, intent, reads) {
  need(plan && typeof plan === "object" && Array.isArray(plan.steps), "plan", "The approval is not a plan.");
  need(intent && intent.kind === "approve-ahead", "intent", "This is not an approval ahead of need.");
  need(isAddress(intent.from) && isAddress(intent.token), "intent", "The wallet or token is not an address.");
  need(reads && Number.isSafeInteger(reads.now) && reads.now > 0, "reads", "The chain's time was not read.");
  need(typeof reads.balance === "bigint", "reads", "What the wallet holds was not read.");

  need(plan.kind === "approve-ahead", "kind", `The plan is a ${plan.kind}, not an approval ahead of need.`);
  need(plan.chainId === CHAIN_ID, "chain", `The plan is for chain ${plan.chainId}, not Robinhood Chain (${CHAIN_ID}).`);
  need(reads.chainId === CHAIN_ID, "chain", `Your wallet is on chain ${reads.chainId}, not Robinhood Chain (${CHAIN_ID}).`);
  need(same(plan.from, intent.from), "from", `The plan is for wallet ${plan.from}, not ${intent.from}.`);
  need(same(plan.token, intent.token), "token", `The plan approves ${plan.token}, not ${intent.token}.`);

  const token = intent.token;
  const { curve, venue } = identity(plan, token, reads, "approves");
  need(reads.balance > 0n, "amount", "This wallet holds none of this token, so there is nothing to approve.");

  const kinds = plan.steps.map((s) => (s && typeof s === "object" ? s.kind : null));
  need(AHEAD_SEQUENCES[venue].some((seq) => JSON.stringify(seq) === JSON.stringify(kinds)), "sequence",
    `An approval ahead for a ${venue === "v4" ? "Uniswap V4" : "curve"} sell cannot be the steps ${kinds.join(", ") || "(none)"}.`);

  // No step is a swap, so none may send ETH, and none has a minimum.
  return {
    side: "approve", from: intent.from, token, curve, venue, amount: reads.balance, minOut: null, now: reads.now,
    hook: reads.memeHook, expiry: APPROVE_AHEAD_EXPIRY_S, amountIs: "held",
  };
}
