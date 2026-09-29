import { CHAIN_ID, PERMIT2, READ, SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from "./constants.js";
import { addressAt, hexBody, splitCall, uintAt, word } from "./abi.js";
import { covered as coveredAhead, planApproveAhead, readApproveAhead } from "./approveAhead.js";
import { readTransfer, verifyApproveAhead, verifyTransfer } from "./verify.js";
import { walletError } from "../wallet/eip6963.js";

// ====================================================================== //
// the signing sequence                                                   //
// ====================================================================== //
//
// The only module that sends a transaction (scripts/check-web.mjs enforces
// it). A trade the visitor asked for is prepared by our server, checked by the
// verifier against what they asked, shown to them in full, and then signed one
// step at a time. Each step is sent only after the previous one's receipt shows
// success. Before every send, the chain, the account, an approval that may
// already be in place, the quote's age and the plan itself are checked again;
// the plan's reads are taken again unless the last check passed under
// `freshMs` ago with nothing sent since (a one-click trade's first step has
// no pause to cover).
//
// It holds no DOM. Everything it talks to arrives in `deps`, so the page wires
// the real API, sheet and wallet, and the tests wire scripted ones.
//
// A plan that has just arrived from the server is also priced by the page
// itself (F3.3, quote.js), after it has passed the verifier and before the
// visitor sees it.
//
// Moving ETH between the visitor's two wallets goes through the same door
// (W2.1, `startTransfer`): a fund from the main wallet to the trading wallet,
// and a withdraw of everything back. The page builds those plans itself, and
// verify.js checks them (`verifyTransfer`) when they are built and again
// before the send. They are imported here rather than passed in, so there is
// no way to wire a transfer without its checks.
//
// The trading wallet signs with no pop-up (W3.1). Every check above still runs
// before each of its sends; only the words and the receipt polling follow the
// signer (`silent`). Whether the visitor is asked to confirm a plan at all is
// the page's `confirm`, which may answer by itself.
//
// After a buy, the trading wallet approves the token for its sell path ahead
// of need (W3.2, `startApproveAhead`): a plan kind with no swap step and no
// question, built in the page (approveAhead.js) and checked by verify.js
// (`verifyApproveAhead`) when it is built and again before each send. Like a
// transfer's, its checks are imported here, not passed in.

/** The checks a sequence cannot run without. */
const CHECKS = ["readIdentity", "verifyPlan", "readQuote", "verifyQuote"];

/** Phases in which a trade is still this tab's trade, and a second one must wait. */
const ACTIVE = new Set(["preparing", "confirming", "running", "signing", "pending", "paused", "rejected", "error"]);
/** Phases Resume continues from, with the plan kept. */
const RESUMABLE = new Set(["paused", "rejected", "error"]);

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const hex = (v) => `0x${v.toString(16)}`;

/** A JSON-RPC quantity from a wallet, as a bigint, or a throw. */
function quantityOf(v, what) {
  if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v)) throw new Error(`${what} is not a hex quantity: ${JSON.stringify(v)}.`);
  return BigInt(v);
}

/** "0.01" as wei, with no floating point anywhere. */
export function parseEth(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!m) throw new Error(`${JSON.stringify(s)} is not an amount of ETH.`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** Slippage as the server will clamp it, so the intent and the plan can agree. */
export const clampSlippage = (bps) =>
  Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(Number.isFinite(bps) ? bps : 300)));

/**
 * `provider` is the wallet that trades. A transfer also needs `main`, the
 * visitor's main wallet (F2's provider): a fund leaves it, and a withdraw goes
 * to it.
 *
 * `silent` says whether `provider` signs with no pop-up: the trading wallet
 * (public-release W3.1). Its sends are then worded as signing, not as a
 * request to confirm in a wallet; its errors are its own sentences; and their
 * receipts are polled every `fastPollMs` for the first `fastForMs`, since the
 * chain makes a block about every quarter of a second. A browser wallet's
 * receipts, looked for through its own RPC, stay at `pollMs`. The main wallet
 * always asks, so a fund is never silent.
 *
 * @param {{
 *   provider: () => ({ request: (args: { method: string, params?: unknown[] }) => Promise<any> } | null),
 *   main?: () => ({ request: (args: { method: string, params?: unknown[] }) => Promise<any> } | null),
 *   silent?: () => boolean,
 *   prepare: (side: "buy" | "sell", body: object) => Promise<{ status: number, data: any }>,
 *   readIdentity: Function, verifyPlan: Function, readQuote: Function, verifyQuote: Function,
 *   acknowledge: () => Promise<boolean>,
 *   confirm: (ask: object) => Promise<boolean>,
 *   update: (state: object) => void,
 *   afterFill?: (fill: object) => void,
 *   afterTransfer?: (fill: object) => void,
 *   afterApproval?: (approval: object) => void,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   clock?: () => number, freshMs?: number, log?: (line: string) => void,
 *   pollMs?: number, fastPollMs?: number, fastForMs?: number, receiptMs?: number, backgroundMs?: number,
 * }} d
 */
export function createSequence(d) {
  // A page wired without one of its checks fails when it loads, not quietly
  // when someone trades.
  for (const k of CHECKS) if (typeof d[k] !== "function") throw new Error(`The signing sequence needs ${k}.`);
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const POLL = d.pollMs ?? 1000;
  const FAST_POLL = d.fastPollMs ?? 250;
  const FAST_FOR = d.fastForMs ?? 10_000;
  const RECEIPT = d.receiptMs ?? 90_000;
  const BACKGROUND = d.backgroundMs ?? 600_000;
  const silent = () => (d.silent ? d.silent() === true : false);
  const clock = d.clock ?? (() => Date.now());
  // A check that passed this recently stands in for the one before the send.
  const FRESH = d.freshMs ?? 2000;
  const log = d.log ?? ((line) => globalThis.console?.info(line));
  const afterFill = d.afterFill ?? (() => {});
  const afterTransfer = d.afterTransfer ?? (() => {});
  const afterApproval = d.afterApproval ?? (() => {});

  /** @type {any} */
  let st = null;

  // How long each part of a trade took, logged once when it ends, so a slow
  // trade says where its time went (2026-09-23).
  let timing = null;
  const lap = (name) => { if (timing) timing.laps.push([name, clock()]); };
  const ENDS = new Set(["done", "failed", "refused", "reverted", "error", "cancelled", "void", "rejected", "paused"]);
  function report(phase) {
    const t = timing;
    timing = null;
    let at = t.start;
    const parts = t.laps.map(([name, when]) => { const ms = when - at; at = when; return `${name} ${ms} ms`; });
    log(`[trade] ${t.what}: ${parts.join(" · ")} · total ${((clock() - t.start) / 1000).toFixed(1)} s (${phase})`);
  }

  const set = (patch) => {
    st = { ...st, ...patch };
    if (timing && ENDS.has(patch.phase)) report(patch.phase);
    d.update(st);
    return st;
  };
  const mark = (i, patch) => {
    const steps = st.steps.slice();
    steps[i] = { ...steps[i], ...patch };
    set({ steps });
  };

  const req = (method, params) => {
    const p = d.provider();
    if (!p) throw new Error("No wallet is connected.");
    return p.request(params ? { method, params } : { method });
  };
  const request = (args) => req(args.method, args.params);
  const call = async (to, data) => hexBody(await req("eth_call", [{ to, data }, "latest"]));
  const chainTime = async () => Number(BigInt((await req("eth_getBlockByNumber", ["latest", false])).timestamp));
  /**
   * Whether the plan passed its check under FRESH ms ago with nothing sent
   * since: between two steps the chain has moved on, so it is read again.
   */
  const fresh = () => !!(st && st.checked && st.checked.step === st.at && clock() - st.checked.at < FRESH);
  /** The chain's time: the fresh check's block, moved on by the seconds since, or a new read. */
  const chainNow = async () => fresh()
    ? st.checked.reads.now + Math.ceil((clock() - st.checked.at) / 1000)
    : chainTime();

  // ------------------------------------------------------------- start --

  /**
   * Trade what the visitor asked for. `input` is `{ side, from, token,
   * amountEth }` for a buy, or `{ side, from, token, tokens | pct }` for a
   * sell, plus `slippageBps`. Refuses while another trade in this tab is live.
   */
  async function start(input) {
    if (busy()) return st;
    // Busy from here, so a second click cannot start another trade, but nothing
    // is shown until the acknowledgement has been answered.
    st = { phase: "preparing", intent: null, plan: null, steps: [], done: [], at: 0, message: "", refusal: null, fill: null };
    timing = { what: String(input?.side ?? "trade"), start: clock(), laps: [] };
    if (!(await d.acknowledge())) return set({ phase: "cancelled", message: "Nothing was sent." });
    let intent;
    try {
      intent = await buildIntent(input);
    } catch (e) {
      return set({ phase: "failed", message: e.message });
    }
    return prepareAndConfirm(intent);
  }

  async function buildIntent(input) {
    const side = input.side;
    if (side !== "buy" && side !== "sell") throw new Error("A trade is a buy or a sell.");
    const base = { side, from: input.from, token: input.token, slippageBps: clampSlippage(input.slippageBps) };
    if (side === "buy") {
      const wei = parseEth(input.amountEth);
      if (wei <= 0n) throw new Error("Choose an amount to buy.");
      return { ...base, amountEth: String(input.amountEth).trim(), amountIn: wei.toString() };
    }
    let tokens;
    if (input.tokens !== undefined) {
      tokens = BigInt(input.tokens);
    } else {
      const pct = Number(input.pct);
      if (!(pct > 0 && pct <= 100)) throw new Error("Choose how much to sell.");
      const balance = uintAt(await call(input.token, READ.balanceOf + word(input.from)), 0);
      if (balance === 0n) throw new Error("This wallet holds none of this token.");
      tokens = pct === 100 ? balance : (balance * BigInt(Math.round(pct * 100))) / 10_000n;
    }
    if (tokens <= 0n) throw new Error("That rounds to nothing to sell.");
    return { ...base, tokens: tokens.toString() };
  }

  const bodyOf = (intent) => intent.side === "buy"
    ? { from: intent.from, token: intent.token, amountEth: intent.amountEth, slippageBps: intent.slippageBps }
    : { from: intent.from, token: intent.token, tokens: intent.tokens, slippageBps: intent.slippageBps };

  /** POST /api/prepare, and the plan or a sentence for why not. */
  async function fetchPlan(intent) {
    let r;
    try {
      r = await d.prepare(intent.side, bodyOf(intent));
    } catch (e) {
      return { error: `Could not reach the server: ${e.message}` };
    }
    if (r.status !== 200) {
      const why = r.data && (r.data.text || r.data.error);
      return { error: why ? String(why) : `The server answered ${r.status}.` };
    }
    return { plan: r.data };
  }

  /**
   * Read the token through the visitor's wallet and verify the plan against
   * the intent. A plan that has just arrived (`priced`) is then checked
   * against the page's own quote too. Null means the trade has stopped, and
   * the state says why.
   */
  async function check(plan, intent, priced = false, pending = null) {
    let reads;
    st = { ...st, checked: null };
    try {
      reads = await (pending ?? d.readIdentity(request, intent.token));
    } catch (e) {
      set({ phase: "failed", message: `Could not read this token through your wallet: ${e.message}` });
      return null;
    }
    let v = d.verifyPlan(plan, intent, reads);
    // Only after the verifier has passed it: the quote prices the curve and
    // the pool that the verified plan names.
    if (v.ok && priced) { lap("check"); v = await price(plan, intent, reads); lap("price"); }
    if (v.ok) {
      st = { ...st, checked: { at: clock(), step: st.at ?? 0, reads } };
      return reads;
    }
    const sent = st.done.filter((s) => s.status === "mined").length + st.steps.filter((s) => s.status === "mined").length;
    // The trading wallet has no pop-up to open.
    const before = silent() ? "Refused before anything was signed" : "Refused before your wallet opened";
    set({
      phase: "refused",
      // The refused plan stays out of the state, so the sheet never shows its
      // unverified numbers; its id goes with the refusal, for a report.
      refusal: { plan: plan && plan.planId, step: v.step, rule: v.rule, reason: v.reason },
      message: sent === 0
        ? `${before}: ${v.reason} Nothing was sent.`
        : `Refused before the next step: ${v.reason} ${plural(sent, "step")} already went through; nothing more will be sent.`,
    });
    return null;
  }

  /**
   * The plan's expected output against the page's own figure (F3.3). A figure
   * the page cannot work out refuses the plan; it never lets it through.
   */
  async function price(plan, intent, reads) {
    let own;
    try {
      own = await d.readQuote(request, plan, intent, reads);
    } catch (e) {
      return {
        ok: false, step: null, rule: "quote-read",
        reason: `This trade's price could not be worked out through your wallet: ${e?.message ?? e}.`,
      };
    }
    return d.verifyQuote(plan, intent, own);
  }

  async function prepareAndConfirm(intent) {
    set({ phase: "preparing", intent, message: "Preparing the trade…" });
    // The token's reads need only its address, so they run while the server
    // prepares the plan, not after it.
    const identity = Promise.resolve().then(() => d.readIdentity(request, intent.token));
    identity.catch(() => {});
    const got = await fetchPlan(intent);
    lap("prepare");
    if (got.error) return set({ phase: "failed", message: got.error });
    const plan = got.plan;

    // The curve could not take the whole sell. Offer what it can take as a new
    // intent; the verifier never accepts less than was asked.
    const q = plan && plan.quote;
    if (intent.side === "sell" && q && /^\d+$/.test(String(q.amountIn)) &&
        Array.isArray(plan.warnings) && plan.warnings.some((w) => w && w.code === "capped")) {
      const can = BigInt(q.amountIn);
      if (can > 0n && can < BigInt(intent.tokens)) {
        set({ phase: "confirming", plan, message: "" });
        const ok = await d.confirm({ kind: "capped", intent, plan, can: can.toString(), asked: intent.tokens });
        if (!ok) return set({ phase: "cancelled", message: "Nothing was sent." });
        return prepareAndConfirm({ ...intent, tokens: can.toString() });
      }
    }

    if (!(await check(plan, intent, true, identity))) return st;
    set({ phase: "confirming", plan, steps: plan.steps.map(asStep), at: 0, message: "" });
    if (!(await d.confirm({ kind: "plan", intent, plan }))) return set({ phase: "cancelled", message: "Nothing was sent." });
    return run();
  }

  const asStep = (s) => ({ id: s.id, kind: s.kind, label: s.label, status: "waiting", hash: null });

  // --------------------------------------------------------------- run --

  async function run() {
    set({ phase: "running", message: "" });
    try {
      while (st.at < st.steps.length) {
        const i = st.at;
        const step = st.plan.steps[i];
        const n = st.steps.length;

        // 1. The chain.
        if (Number(await req("eth_chainId")) !== CHAIN_ID) {
          return set({ phase: "paused", message: "Your wallet changed network. Switch back to Robinhood Chain to continue." });
        }
        // 2. The account the plan was prepared for.
        const accounts = await req("eth_accounts");
        if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== st.intent.from.toLowerCase()) {
          return set({
            phase: "void",
            message: `Your wallet changed account. This trade was prepared for ${st.intent.from}, so nothing more will be sent. Start again.`,
          });
        }
        // 3. An approval that is already in place is not asked for again.
        if ((step.kind === "erc20-approve" || step.kind === "permit2-approve") && await covered(step)) {
          mark(i, { status: "skipped" });
          set({ at: i + 1 });
          continue;
        }
        // 4. A stale quote is prepared again before the swap. Just after a
        // check, its block's time stands in for another read of the chain.
        if (step.id === "swap" && await chainNow() > st.plan.expiresAt) {
          const again = await reprepare();
          if (again !== true) return again;
          continue;
        }
        // 5. The whole plan, verified again against fresh reads, unless it
        // passed a moment ago: a one-click trade has no pause to cover.
        if (!fresh() && !(await check(st.plan, st.intent))) return st;
        lap("check");

        // 6. Send. The words follow the signer: the trading wallet asks no one.
        const quiet = silent();
        mark(i, { status: "signing" });
        set({ phase: "signing", message: quiet ? `Signing step ${i + 1} of ${n}…` : `Confirm step ${i + 1} of ${n} in your wallet.` });
        let hash;
        try {
          hash = await req("eth_sendTransaction", [{
            from: st.intent.from, to: step.to, data: step.data, value: step.value, gas: step.gas,
          }]);
        } catch (e) {
          mark(i, { status: "waiting" });
          return walletFailure(e, i, `step ${i + 1}`, quiet);
        }
        lap(`send ${i + 1}`);
        mark(i, { status: "pending", hash });
        set({ phase: "running", message: `Waiting for step ${i + 1} of ${n} to be mined.` });

        // 7. Its receipt.
        const receipt = await receiptFor(hash, i, req, `Step ${i + 1}`, quiet);
        lap(`mined ${i + 1}`);
        if (!receipt) return st;
        if (receipt.status !== "0x1") {
          mark(i, { status: "reverted" });
          return set({ phase: "reverted", message: `Step ${i + 1} reverted. Nothing more will be sent.` });
        }
        mark(i, { status: "mined" });
        set({ at: i + 1, phase: "running" });

        if (step.id === "swap") {
          const fill = { intent: st.intent, plan: st.plan, hash, receipt };
          // The fill hook may start an approval ahead (W3.2), which becomes
          // this tab's state; the trade still ends as done.
          const done = set({ phase: "done", fill, message: "Done." });
          afterFill(fill);
          return done;
        }
      }
      return set({ phase: "error", message: "The plan ended without a swap." });
    } catch (e) {
      // A read that failed mid-trade. Nothing unconfirmed was sent; the plan is kept.
      return set({ phase: "error", message: `Could not reach your wallet's network: ${e.message}` });
    }
  }

  /** Does the allowance this approval step would grant already exist? */
  async function covered(step) {
    const { args } = splitCall(step.data);
    const need = BigInt(st.intent.tokens);
    if (step.kind === "erc20-approve") {
      const spender = addressAt(args, 0);
      return uintAt(await call(step.to, READ.allowance + word(st.intent.from) + word(spender)), 0) >= need;
    }
    const token = addressAt(args, 0), spender = addressAt(args, 32);
    const out = await call(PERMIT2, READ.permit2Allowance + word(st.intent.from) + word(token) + word(spender));
    const amount = uintAt(out, 0, 160), expiration = uintAt(out, 32, 48);
    // An expired allowance covers nothing.
    return amount >= need && Number(expiration) > await chainTime();
  }

  /** The quote expired before the swap: prepare the same intent again. */
  async function reprepare() {
    const old = st.plan;
    set({ phase: "preparing", message: "The quote expired. Preparing it again…" });
    const got = await fetchPlan(st.intent);
    if (got.error) return set({ phase: "failed", message: got.error });
    const plan = got.plan;
    if (!(await check(plan, st.intent, true))) return st;
    const was = BigInt(old.quote.minOut), now = BigInt(plan.quote.minOut);
    if (now < was) {
      set({ phase: "confirming", message: "" });
      const ok = await d.confirm({ kind: "priceMoved", intent: st.intent, plan, was: was.toString(), now: now.toString() });
      if (!ok) return set({ phase: "cancelled", message: "The price moved and you declined. Nothing more was sent." });
    }
    // Steps already finished stay on the sheet; the new plan's steps replace the rest.
    const finished = st.steps.filter((s) => s.status === "mined" || s.status === "skipped");
    set({ plan, done: [...st.done, ...finished], steps: plan.steps.map(asStep), at: 0, phase: "running" });
    return true;
  }

  /**
   * Poll for a receipt, only while the wallet is on Robinhood Chain. After
   * `receiptMs` the sheet says "still pending"; after `backgroundMs` the trade
   * ends. Nothing further is sent either way. A transfer passes the wallet
   * that sent it, and its own name for the step. A silent signer's receipts
   * are polled fast at first (`fastPollMs` for `fastForMs`); both limits
   * count the same time slept between polls either way.
   */
  async function receiptFor(hash, i, ask = req, what = `Step ${i + 1}`, fast = false) {
    let waited = 0;
    while (waited < BACKGROUND) {
      if (waited >= RECEIPT && st.phase !== "pending") {
        set({ phase: "pending", message: `${what} is still pending. Nothing further will be sent until it is mined.` });
      }
      let onChain = false;
      try { onChain = Number(await ask("eth_chainId")) === CHAIN_ID; } catch { /* ask again next time */ }
      if (onChain) {
        try {
          const receipt = await ask("eth_getTransactionReceipt", [hash]);
          if (receipt && receipt.status) {
            if (st.phase === "pending") set({ phase: "running", message: "" });
            return receipt;
          }
        } catch { /* ask again next time */ }
      }
      const ms = fast && waited < FAST_FOR ? FAST_POLL : POLL;
      await sleep(ms);
      waited += ms;
    }
    mark(i, { status: "unknown" });
    set({ phase: "timeout", message: `${what} was not mined within ${Math.round(BACKGROUND / 60_000)} minutes. Check your wallet. Nothing more will be sent.` });
    return null;
  }

  /**
   * A send that did not happen, in words. A browser wallet's error is worded
   * by F2's `walletError`. The trading wallet's (W1.1's provider) already is a
   * sentence of its own, such as "Too many transactions in a minute. Nothing
   * was sent.", which a code like 4100 would otherwise turn into "This wallet
   * cannot do that".
   */
  function walletFailure(e, i, what = `step ${i + 1}`, quiet = false) {
    const code = e && typeof e.code === "number" ? e.code : null;
    if (code === 4001) return set({ phase: "rejected", message: `You rejected ${what}.` });
    return set({ phase: "error", message: sendError(e, quiet) });
  }

  /** A failed send's words: the trading wallet's own sentence, or F2's for a browser wallet. */
  const sendError = (e, quiet) =>
    (quiet && e && typeof e.message === "string" && e.message ? e.message : walletError(e, "eth_sendTransaction"));

  // ---------------------------------------------------------- transfers --
  // W2.1. The same states and errors as a trade. A fund is sent by the main
  // wallet, so it opens that wallet's pop-up; a withdraw is sent by the
  // trading wallet, which signs without one.

  /** The two wallets, as the page has them now. */
  const walletsNow = () => ({ main: d.main ? d.main() : null, trading: d.provider() });
  /** An EIP-1193 request function for one wallet. */
  const asker = (p) => (args) => p.request(args);
  /** The same, called as `ask(method, params)`, for the receipt poll. */
  const poller = (p) => (method, params) => p.request(params ? { method, params } : { method });

  /**
   * Move ETH between the visitor's wallets. `input` is `{ kind: "fund",
   * amountEth }`, the typed amount from the main wallet to the trading
   * wallet, or `{ kind: "withdraw" }`, everything the trading wallet holds
   * less its gas, to the main wallet. Neither takes an address. Both come
   * from the wallets themselves, read now, when the button is pressed (TW4),
   * and again before the send. Refuses while a trade or transfer in this tab
   * is live.
   */
  async function startTransfer(input) {
    if (busy()) return st;
    st = {
      phase: "preparing", transfer: true, intent: null, plan: null, steps: [], done: [], at: 0,
      message: "", refusal: null, fill: null,
    };
    let intent, reads, plan;
    try {
      let sender;
      ({ intent, reads, sender } = await transferIntent(input));
      set({ intent, message: intent.kind === "fund" ? "Preparing the transfer…" : "Preparing the withdrawal…" });
      plan = await planTransfer(intent, reads, sender);
    } catch (e) {
      return set({ phase: "failed", message: e.message });
    }
    const v = verifyTransfer(plan, intent, reads);
    if (!v.ok) return refuseTransfer(v);
    set({ phase: "confirming", plan, steps: plan.steps.map(asStep), at: 0, message: "" });
    if (!(await d.confirm({ kind: "transfer", intent, plan }))) return set({ phase: "cancelled", message: "Nothing was sent." });
    return runTransfer();
  }

  /** What the visitor asked for, with both addresses as their wallets give them now. */
  async function transferIntent(input) {
    const kind = input && input.kind;
    if (kind !== "fund" && kind !== "withdraw") throw new Error("A transfer is a fund or a withdraw.");
    // Never an address from the caller: not typed, not stored, not served (TW4).
    if (input.to !== undefined || input.from !== undefined) {
      throw new Error("A transfer takes no address. Where the ETH comes from and goes to is read from your wallets.");
    }
    let amountWei = 0n;
    if (kind === "fund") {
      amountWei = parseEth(input.amountEth);
      if (amountWei <= 0n) throw new Error("Enter an amount of ETH to fund.");
    }
    const { main, trading } = walletsNow();
    if (!main) throw new Error(kind === "fund" ? "Connect the wallet to fund from first." : "Connect your main wallet first. Withdraw all goes only to it.");
    if (!trading) throw new Error("Log in to your trading wallet first.");
    let reads;
    try {
      reads = await readTransfer(kind, asker(main), asker(trading));
    } catch (e) {
      throw new Error(`Could not read your wallets: ${e.message}`);
    }
    if (!reads.main.account) throw new Error(kind === "fund" ? "Connect the wallet to fund from first." : "Connect your main wallet first. Withdraw all goes only to it.");
    if (!reads.trading.account) throw new Error("Log in to your trading wallet first.");
    // The main wallet sends a fund, and vouches for its address on this chain
    // for a withdraw: either way it must be on Robinhood Chain.
    if (reads.main.chainId !== CHAIN_ID) throw new Error("Switch your main wallet to Robinhood Chain first.");
    if (kind === "withdraw" && reads.trading.chainId !== CHAIN_ID) {
      throw new Error(`Your trading wallet answered for chain ${reads.trading.chainId}, not Robinhood Chain.`);
    }
    const intent = kind === "fund"
      ? { kind, from: reads.main.account, to: reads.trading.account, amountEth: String(input.amountEth).trim(), amountWei: amountWei.toString() }
      : { kind, from: reads.trading.account, to: reads.main.account };
    return { intent, reads, sender: kind === "fund" ? main : trading };
  }

  /**
   * The one step, built here with no server. The gas is the sending wallet's
   * `eth_estimateGas` for this very transfer: on this chain it carries the L1
   * data cost when there is one, and a main wallet that is a contract costs
   * more than 21,000 to pay, so 21,000 is never assumed. A withdraw keeps that
   * gas times twice the base fee back for its fee, and sends the rest.
   */
  async function planTransfer(intent, reads, sender) {
    const fund = intent.kind === "fund";
    const value = fund ? BigInt(intent.amountWei) : reads.balance;
    let gas;
    try {
      gas = quantityOf(await sender.request({
        method: "eth_estimateGas", params: [{ from: intent.from, to: intent.to, value: hex(value), data: "0x" }],
      }), "The gas estimate");
    } catch (e) {
      throw new Error(`Could not work out the gas for this ${fund ? "transfer" : "withdrawal"}: ${walletError(e, "eth_estimateGas")}`);
    }
    const step = {
      id: "transfer", kind: intent.kind, label: fund ? "Fund your trading wallet" : "Withdraw to your main wallet",
      to: intent.to, data: "0x", value: hex(value), gas: hex(gas),
    };
    if (!fund) {
      const maxFeePerGas = 2n * reads.baseFee;
      const reserve = gas * maxFeePerGas;
      if (reads.balance <= reserve) {
        throw new Error(`There is nothing to withdraw: the ${reads.balance} wei here does not cover the ${reserve} wei kept back for gas.`);
      }
      step.value = hex(reads.balance - reserve);
      step.maxFeePerGas = hex(maxFeePerGas);
    }
    return { kind: intent.kind, chainId: CHAIN_ID, from: intent.from, steps: [step] };
  }

  /** A transfer plan the verifier refused. Its numbers stay out of the state. */
  function refuseTransfer(v) {
    return set({
      phase: "refused",
      refusal: { plan: null, step: v.step, rule: v.rule, reason: v.reason },
      message: `Refused before anything was signed: ${v.reason} Nothing was sent.`,
    });
  }

  /** Check the world again, verify again, send the one step, and wait for it. */
  async function runTransfer() {
    set({ phase: "running", message: "" });
    const intent = st.intent, plan = st.plan, step = plan.steps[0];
    const fund = intent.kind === "fund";
    const what = fund ? "the transfer" : "the withdrawal";
    try {
      const { main, trading } = walletsNow();
      if (!main || !trading) {
        return set({ phase: "void", message: `A wallet disconnected, so nothing was sent. Start ${what} again.` });
      }
      const reads = await readTransfer(intent.kind, asker(main), asker(trading));
      // 1. The main wallet's chain. Paused, like a trade, until it is back.
      //    (The trading wallet has no network to switch: one that answers
      //    for another chain is refused by the verifier below.)
      if (reads.main.chainId !== CHAIN_ID) {
        return set({ phase: "paused", message: "Your main wallet changed network. Switch it back to Robinhood Chain to continue." });
      }
      // 2. The accounts the visitor was shown. Either wallet changing account
      //    voids the transfer: the ETH would leave from, or go to, another one.
      const [mainWas, tradingWas] = fund ? [intent.from, intent.to] : [intent.to, intent.from];
      if (!sameAddress(reads.main.account, mainWas) || !sameAddress(reads.trading.account, tradingWas)) {
        return set({
          phase: "void",
          message: `A wallet changed account. This was prepared from ${intent.from} to ${intent.to}, so nothing will be sent. Start again.`,
        });
      }
      // 3. The plan, against those fresh reads.
      const v = verifyTransfer(plan, intent, reads);
      if (!v.ok) return refuseTransfer(v);

      // 4. Send, from the wallet that holds the ETH. Only the trading
      //    wallet can be silent: the main wallet always asks.
      const sender = fund ? main : trading;
      const quiet = !fund && silent();
      mark(0, { status: "signing" });
      set({ phase: "signing", message: fund ? "Confirm the transfer in your wallet." : "Signing the withdrawal…" });
      let hash;
      try {
        hash = await sender.request({
          method: "eth_sendTransaction",
          params: [{ from: intent.from, to: step.to, data: step.data, value: step.value, gas: step.gas }],
        });
      } catch (e) {
        mark(0, { status: "waiting" });
        return walletFailure(e, 0, what, quiet);
      }
      mark(0, { status: "pending", hash });
      set({ phase: "running", message: `Waiting for ${what} to be mined.` });

      // 5. Its receipt, from the wallet that sent it.
      const receipt = await receiptFor(hash, 0, poller(sender), fund ? "The transfer" : "The withdrawal", quiet);
      if (!receipt) return st;
      if (receipt.status !== "0x1") {
        mark(0, { status: "reverted" });
        return set({ phase: "reverted", message: `${fund ? "The transfer" : "The withdrawal"} reverted. Nothing more will be sent.` });
      }
      mark(0, { status: "mined" });
      const fill = { intent, plan, hash, receipt };
      set({ at: 1, phase: "done", fill, message: "Done." });
      afterTransfer(fill);
      return st;
    } catch (e) {
      // A read that failed. Nothing unconfirmed was sent; the plan is kept.
      return set({ phase: "error", message: `Could not reach your wallets: ${e.message}` });
    }
  }

  // ---------------------------------------------------- approve ahead --
  // W3.2. The trading wallet's approvals for the sell a token will need, for
  // exactly what it holds, run like a trade's steps but with no swap and no
  // question: nothing here asks the visitor anything. A failure of any kind
  // ends it, and the sell plan then includes the approval, as before. None of
  // its states is one Resume continues from, so it never holds the tab.

  /**
   * Approve `token`'s sell path ahead of need, for `from`, the wallet that
   * trades. `symbol` names it in the steps' labels. Refuses while a trade in
   * this tab is live. Ends as done with nothing sent when it is covered.
   *
   * @param {{ from: string, token: string, symbol?: string }} input
   */
  async function startApproveAhead(input) {
    if (busy()) return st;
    const intent = { kind: /** @type {"approve-ahead"} */ ("approve-ahead"), from: input.from, token: input.token, symbol: input.symbol };
    st = {
      phase: "preparing", ahead: true, intent, plan: null, steps: [], done: [], at: 0,
      message: "", refusal: null, fill: null,
    };
    // Busy from here, which the page shows: a trade clicked now waits for it.
    d.update(st);
    let reads, plan;
    try {
      reads = await readApproveAhead(request, intent.from, intent.token);
      plan = await planApproveAhead(request, intent, reads);
    } catch (e) {
      return set({ phase: "failed", message: `Could not read what this wallet has approved: ${e.message}` });
    }
    if (!plan.steps.length) return set({ phase: "done", plan, message: "Already approved. Nothing was sent." });
    const v = verifyApproveAhead(plan, intent, reads);
    if (!v.ok) return refuseAhead(v);
    set({ plan, steps: plan.steps.map(asStep) });
    return runApproveAhead();
  }

  /** An approval the verifier refused. Its numbers stay out of the state. */
  function refuseAhead(v) {
    return set({
      phase: "refused",
      plan: null,
      refusal: { plan: null, step: v.step, rule: v.rule, reason: v.reason },
      message: `Refused before anything was signed: ${v.reason} Nothing more was sent.`,
    });
  }

  /** Check the world again before each step, skip what is covered, send, and wait. */
  async function runApproveAhead() {
    set({ phase: "running", message: "" });
    const intent = st.intent, plan = st.plan, n = st.steps.length;
    try {
      while (st.at < n) {
        const i = st.at, step = plan.steps[i];
        // 1. The chain and the account. The trading wallet has no network to
        //    switch, and a changed account means this is someone else's plan.
        if (Number(await req("eth_chainId")) !== CHAIN_ID) {
          return set({ phase: "failed", message: "The wallet answered for another chain. Nothing more was sent." });
        }
        const accounts = await req("eth_accounts");
        if (!Array.isArray(accounts) || !sameAddress(accounts[0], intent.from)) {
          return set({ phase: "void", message: "The wallet changed account. Nothing more was sent." });
        }
        // 2. Fresh reads: an allowance another tab has given since is not given again.
        const reads = await readApproveAhead(request, intent.from, intent.token);
        if (coveredAhead(step, reads)) {
          mark(i, { status: "skipped" });
          set({ at: i + 1 });
          continue;
        }
        // 3. The whole plan, against those reads: the balance may have moved.
        const v = verifyApproveAhead(plan, intent, reads);
        if (!v.ok) return refuseAhead(v);

        // 4. Send.
        const quiet = silent();
        mark(i, { status: "signing" });
        set({ phase: "signing", message: quiet ? `Signing approval ${i + 1} of ${n}…` : `Confirm approval ${i + 1} of ${n} in your wallet.` });
        let hash;
        try {
          hash = await req("eth_sendTransaction", [{
            from: intent.from, to: step.to, data: step.data, value: step.value, gas: step.gas,
          }]);
        } catch (e) {
          mark(i, { status: "waiting" });
          return set({ phase: "failed", message: sendError(e, quiet) });
        }
        mark(i, { status: "pending", hash });
        set({ phase: "running", message: `Waiting for approval ${i + 1} of ${n} to be mined.` });

        // 5. Its receipt.
        const receipt = await receiptFor(hash, i, req, `Approval ${i + 1}`, quiet);
        if (!receipt) return st;
        if (receipt.status !== "0x1") {
          mark(i, { status: "reverted" });
          return set({ phase: "reverted", message: `Approval ${i + 1} reverted. Nothing more will be sent.` });
        }
        mark(i, { status: "mined" });
        set({ at: i + 1, phase: "running" });
        afterApproval({ intent, plan, step, hash, receipt });
      }
      return set({ phase: "done", message: "Done." });
    } catch (e) {
      // A read that failed. Nothing unconfirmed was sent.
      return set({ phase: "failed", message: `Could not reach the wallet's network: ${e.message}` });
    }
  }

  // ------------------------------------------------------------ control --

  /** Continue a paused, rejected or failed step, from its first check. */
  async function resume() {
    if (!st || !RESUMABLE.has(st.phase)) return st;
    return st.transfer ? runTransfer() : run();
  }

  /** Give up on a trade that is waiting on the visitor. Nothing more is sent. */
  function cancel() {
    if (!st || !RESUMABLE.has(st.phase)) return st;
    return set({ phase: "cancelled", message: "Nothing more was sent." });
  }

  function busy() {
    return !!st && ACTIVE.has(st.phase);
  }

  return { start, startTransfer, startApproveAhead, resume, cancel, busy, state: () => st };
}
