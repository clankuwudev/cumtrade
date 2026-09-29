// Approvals ahead of need (public-release W3.2, TW6). Right after a buy fills,
// the trading wallet approves the token for the sell it will need, for exactly
// what it holds, so that sell is one transaction. The plan is built in the
// page, checked by the verifier as `approve-ahead`, and run by the sequence.
//
// The fixture chain's scripted wallet stands in for the trading wallet
// (support/fixtureWallet.js). Calldata is checked against viem's encoder,
// which is independent of the page's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { APPROVE_AHEAD_EXPIRY_S, APPROVE_AHEAD_RENEW_S, MAX_GAS, PERMIT2, UNIVERSAL_ROUTER } from "../public/js/trade/constants.js";
import { covered, planApproveAhead, readApproveAhead } from "../public/js/trade/approveAhead.js";
import { readIdentity, verifyApproveAhead, verifyPlan } from "../public/js/trade/verify.js";
import { verifyQuote } from "../public/js/trade/quote.js";
import { createSequence } from "../public/js/trade/sequence.js";
import { calls, recall } from "./support/calldata.js";
import { chain, fixture, fixtureWallet } from "./support/fixtureWallet.js";

const FROM = "0x00000000000000000000000000000000000A11cE";
const CURVE_TOKEN = Object.keys(chain.tokens).find((t) => !chain.tokens[t].graduated);
const V4_TOKEN = Object.keys(chain.tokens).find((t) => chain.tokens[t].graduated);
const CURVE = chain.tokens[CURVE_TOKEN].curve;
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const MAX_UINT256 = 2n ** 256n - 1n;
const NOW = 1_800_000_000;
const HELD = 12_345_678n * 10n ** 18n;
const lower = (a) => String(a).toLowerCase();
const yieldNow = () => new Promise((r) => setImmediate(r));

const approve = (spender, amount) => encodeFunctionData({ abi: calls, functionName: "approve", args: [spender, amount] });
const permit = (token, spender, amount, expiration) =>
  encodeFunctionData({ abi: calls, functionName: "approve", args: [token, spender, amount, expiration] });

/** The fixture chain's wallet, holding `HELD` of every token, with nothing approved. */
function wallet(over = {}) {
  const w = fixtureWallet({ from: FROM, now: NOW });
  w.balance = HELD;
  return Object.assign(w, over);
}

const request = (w) => (args) => w.provider.request(args);
const intentFor = (token) => ({ kind: /** @type {"approve-ahead"} */ ("approve-ahead"), from: FROM, token, symbol: "TKN" });

/** The reads, the plan and the verifier's answer for a token, as the sequence builds them. */
async function built(w, token) {
  const reads = await readApproveAhead(request(w), FROM, token);
  const plan = await planApproveAhead(request(w), intentFor(token), reads);
  return { reads, plan, verdict: verifyApproveAhead(plan, intentFor(token), reads) };
}

// ------------------------------------------------------------ the plans --

test("a curve token: one approval of exactly the balance, to the verified curve", async () => {
  const w = wallet();
  const { plan, verdict } = await built(w, CURVE_TOKEN);
  assert.deepEqual(verdict, { ok: true });
  assert.equal(plan.kind, "approve-ahead");
  assert.equal(plan.venue, "curve");
  assert.equal(plan.steps.length, 1);
  const [s] = plan.steps;
  assert.equal(s.kind, "erc20-approve");
  assert.equal(s.id, "approve-token");
  assert.equal(lower(s.to), lower(CURVE_TOKEN));
  assert.equal(s.data, approve(CURVE, HELD), "approve(curve, balance), byte for byte as viem writes it");
  assert.equal(s.value, "0x0");
  // The wallet's own estimate, with 30% on top.
  assert.equal(BigInt(s.gas), (46_000n * 13n) / 10n);
  assert.deepEqual(w.estimates, [{ from: FROM, to: s.to, data: s.data, value: "0x0" }]);
});

test("a graduated token: the ERC20 approval to Permit2, then Permit2's to the router for 7 days", async () => {
  const w = wallet();
  const { plan, verdict } = await built(w, V4_TOKEN);
  assert.deepEqual(verdict, { ok: true });
  assert.equal(plan.venue, "v4");
  assert.deepEqual(plan.steps.map((s) => [s.id, s.kind, lower(s.to)]), [
    ["approve-token", "erc20-approve", lower(V4_TOKEN)],
    ["approve-permit2", "permit2-approve", lower(PERMIT2)],
  ]);
  assert.equal(plan.steps[0].data, approve(PERMIT2, HELD));
  assert.equal(plan.steps[1].data, permit(V4_TOKEN, UNIVERSAL_ROUTER, HELD, NOW + APPROVE_AHEAD_EXPIRY_S));
  assert.equal(APPROVE_AHEAD_EXPIRY_S, 7 * 86_400);
});

test("a big gas estimate is capped at the verifier's limit", async () => {
  const w = wallet({ gasEstimate: BigInt(MAX_GAS) });
  const { plan, verdict } = await built(w, CURVE_TOKEN);
  assert.equal(BigInt(plan.steps[0].gas), BigInt(MAX_GAS));
  assert.deepEqual(verdict, { ok: true });
});

test("covered means no step: the allowances already there, or nothing held", async () => {
  // The curve's allowance reaches the balance.
  let { plan } = await built(wallet({ erc20: HELD }), CURVE_TOKEN);
  assert.deepEqual(plan.steps, []);
  // More than the balance covers it too.
  ({ plan } = await built(wallet({ erc20: HELD * 2n }), CURVE_TOKEN));
  assert.deepEqual(plan.steps, []);
  // Short by one base unit: approved again, for the balance.
  ({ plan } = await built(wallet({ erc20: HELD - 1n }), CURVE_TOKEN));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].data, approve(CURVE, HELD));

  // Graduated: both in place, with more than a day left.
  const later = BigInt(NOW + APPROVE_AHEAD_RENEW_S + 1);
  ({ plan } = await built(wallet({ erc20: HELD, p2: { amount: HELD, expiration: later } }), V4_TOKEN));
  assert.deepEqual(plan.steps, []);
  // Only Permit2's is missing, or only the token's.
  ({ plan } = await built(wallet({ erc20: HELD }), V4_TOKEN));
  assert.deepEqual(plan.steps.map((s) => s.kind), ["permit2-approve"]);
  ({ plan } = await built(wallet({ p2: { amount: HELD, expiration: later } }), V4_TOKEN));
  assert.deepEqual(plan.steps.map((s) => s.kind), ["erc20-approve"]);
  // Nothing held: nothing to approve, and nothing estimated.
  const empty = wallet({ balance: 0n });
  ({ plan } = await built(empty, CURVE_TOKEN));
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(empty.estimates, []);
});

test("a Permit2 allowance within a day of expiring, or already expired, is given again", async () => {
  for (const [expiration, again] of [
    [NOW + APPROVE_AHEAD_RENEW_S + 1, false],
    [NOW + APPROVE_AHEAD_RENEW_S, true],
    [NOW + 60, true],
    [NOW - 1, true],
  ]) {
    const { plan } = await built(wallet({ erc20: HELD, p2: { amount: HELD, expiration: BigInt(expiration) } }), V4_TOKEN);
    assert.equal(plan.steps.length, again ? 1 : 0, `expiring at now + ${expiration - NOW}`);
  }
  assert.equal(APPROVE_AHEAD_RENEW_S, 86_400);
  // The rule itself, by the reads.
  const reads = { balance: 10n, now: NOW, allowance: { erc20: 10n, permit2: { amount: 9n, expiration: NOW + 2 * 86_400 } } };
  assert.equal(covered({ kind: "permit2-approve" }, reads), false, "an amount short of the balance");
  assert.equal(covered({ kind: "erc20-approve" }, reads), true);
  assert.equal(covered({ kind: "permit2-approve" }, { ...reads, allowance: { erc20: 10n, permit2: null } }), false);
});

test("a raised balance is approved again, for the new balance", async () => {
  const w = wallet({ erc20: HELD });
  assert.deepEqual((await built(w, CURVE_TOKEN)).plan.steps, []);
  w.balance = HELD * 3n;
  const { plan, verdict } = await built(w, CURVE_TOKEN);
  assert.deepEqual(verdict, { ok: true });
  assert.equal(plan.steps[0].data, approve(CURVE, HELD * 3n));
});

// ------------------------------------------------------- the verifier --

/** A built plan for a token, a change to it, and the verifier's answer. */
async function refusal(token, edit, overReads = (r) => r) {
  const w = wallet();
  const { reads, plan } = await built(w, token);
  const intent = intentFor(token);
  edit(plan, intent);
  return verifyApproveAhead(plan, intent, overReads(reads));
}

test("refused: MAX, anything but the balance, and a wrong spender, for each approval", async () => {
  const cases = [
    ["curve: MAX", CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[1] = MAX_UINT256, a)); }, "amount"],
    ["curve: one more than held", CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[1] = HELD + 1n, a)); }, "amount"],
    ["curve: one less than held", CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[1] = HELD - 1n, a)); }, "amount"],
    ["curve: an attacker as spender", CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[0] = ATTACKER, a)); }, "spender"],
    ["curve: Permit2 as spender", CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[0] = PERMIT2, a)); }, "spender"],
    ["v4: the token's approval for MAX", V4_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[1] = MAX_UINT256, a)); }, "amount"],
    ["v4: the token approved to the curve", V4_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[0] = chain.tokens[V4_TOKEN].curve, a)); }, "spender"],
    ["v4: Permit2 for the max uint160", V4_TOKEN, (p) => { p.steps[1].data = recall(p.steps[1].data, (a) => (a[2] = 2n ** 160n - 1n, a)); }, "amount"],
    ["v4: Permit2 for one more than held", V4_TOKEN, (p) => { p.steps[1].data = recall(p.steps[1].data, (a) => (a[2] = HELD + 1n, a)); }, "amount"],
    ["v4: Permit2 to an attacker", V4_TOKEN, (p) => { p.steps[1].data = recall(p.steps[1].data, (a) => (a[1] = ATTACKER, a)); }, "spender"],
    ["v4: Permit2 for another token", V4_TOKEN, (p) => { p.steps[1].data = recall(p.steps[1].data, (a) => (a[0] = CURVE_TOKEN, a)); }, "token"],
  ];
  for (const [what, token, edit, rule] of cases) {
    const v = await refusal(token, edit);
    assert.equal(v.ok, false, what);
    assert.equal(v.rule, rule, `${what}: ${v.reason}`);
  }
  // The words for an amount name what is held, not a sale.
  const v = await refusal(CURVE_TOKEN, (p) => { p.steps[0].data = recall(p.steps[0].data, (a) => (a[1] = MAX_UINT256, a)); });
  assert.match(v.reason, /^The approval is for \d+, not exactly the \d+ held\.$/);
});

test("refused: a Permit2 expiry over 7 days; exactly 7 days passes", async () => {
  const at = (s) => (p) => { p.steps[1].data = recall(p.steps[1].data, (a) => (a[3] = NOW + s, a)); };
  let v = await refusal(V4_TOKEN, at(APPROVE_AHEAD_EXPIRY_S + 1));
  assert.equal(v.rule, "expiry");
  assert.match(v.reason, /more than 7 days from now\.$/);
  v = await refusal(V4_TOKEN, at(2 ** 48 - 1 - NOW));
  assert.equal(v.rule, "expiry");
  assert.deepEqual(await refusal(V4_TOKEN, at(APPROVE_AHEAD_EXPIRY_S)), { ok: true });
});

test("refused: the balance, as read, is the only amount; a balance that moved since the build refuses the plan", async () => {
  let v = await refusal(CURVE_TOKEN, () => {}, (r) => ({ ...r, balance: HELD + 1n }));
  assert.equal(v.rule, "amount");
  v = await refusal(CURVE_TOKEN, () => {}, (r) => ({ ...r, balance: 0n }));
  assert.equal(v.rule, "amount");
  assert.match(v.reason, /holds none of this token/);
  v = await refusal(CURVE_TOKEN, () => {}, (r) => ({ ...r, balance: undefined }));
  assert.equal(v.rule, "reads");
});

test("refused: every other shape an approval ahead cannot have", async () => {
  const swap = fixture("curve sell with approval").plan.steps[1];
  const cases = [
    ["another kind of plan", CURVE_TOKEN, (p) => { p.kind = "sell"; }, "kind"],
    ["an intent of another kind", CURVE_TOKEN, (p, i) => { i.kind = "sell"; }, "intent"],
    ["another chain", CURVE_TOKEN, (p) => { p.chainId = 1; }, "chain"],
    ["another wallet", CURVE_TOKEN, (p) => { p.from = ATTACKER; }, "from"],
    ["another token", CURVE_TOKEN, (p) => { p.token = V4_TOKEN; }, "token"],
    ["the wrong venue", CURVE_TOKEN, (p) => { p.venue = "v4"; }, "venue"],
    ["a swap after the approval", CURVE_TOKEN, (p) => { p.steps.push(swap); }, "sequence"],
    ["a swap alone", CURVE_TOKEN, (p) => { p.steps = [swap]; }, "sequence"],
    ["no steps", CURVE_TOKEN, (p) => { p.steps = []; }, "sequence"],
    ["the approvals out of order", V4_TOKEN, (p) => { p.steps.reverse(); }, "sequence"],
    ["a Permit2 step for a curve token", CURVE_TOKEN, (p) => { p.steps[0].kind = "permit2-approve"; p.steps[0].id = "approve-permit2"; }, "sequence"],
    ["a step id that is not its kind's", CURVE_TOKEN, (p) => { p.steps[0].id = "swap"; }, "step"],
    ["ETH sent with it", CURVE_TOKEN, (p) => { p.steps[0].value = "0x1"; }, "value"],
    ["no gas limit", CURVE_TOKEN, (p) => { p.steps[0].gas = "0x0"; }, "gas"],
    ["a gas limit over the cap", CURVE_TOKEN, (p) => { p.steps[0].gas = `0x${(MAX_GAS + 1).toString(16)}`; }, "gas"],
    ["sent to another contract", CURVE_TOKEN, (p) => { p.steps[0].to = ATTACKER; }, "to"],
    ["another call", CURVE_TOKEN, (p) => { p.steps[0].data = "0xa9059cbb" + p.steps[0].data.slice(10); }, "selector"],
    ["trailing bytes", CURVE_TOKEN, (p) => { p.steps[0].data += "00"; }, "calldata"],
    ["Permit2's step sent elsewhere", V4_TOKEN, (p) => { p.steps[1].to = ATTACKER; }, "to"],
  ];
  for (const [what, token, edit, rule] of cases) {
    const v = await refusal(token, edit);
    assert.equal(v.ok, false, what);
    assert.equal(v.rule, rule, `${what}: ${v.reason}`);
  }
});

test("refused: a token the factory did not launch, or a curve that is not its own", async () => {
  const w = wallet({ registryCurve: ATTACKER });
  const { plan, reads } = await built(w, CURVE_TOKEN);
  const v = verifyApproveAhead(plan, intentFor(CURVE_TOKEN), reads);
  assert.equal(v.rule, "identity");
  // The builder asked about the curve the token names, which is not the registry's.
  assert.equal(plan.steps[0].data, approve(CURVE, HELD));
});

test("the trade rules are unchanged: a sell's approvals are still exact, and Permit2's lasts at most an hour", async () => {
  const f = fixture("v4 sell with both approvals");
  const w = fixtureWallet({ from: f.intent.from, now: f.plan.preparedAt });
  const identity = await readIdentity(request(w), f.intent.token);
  assert.deepEqual(verifyPlan(f.plan, f.intent, identity), { ok: true });
  const late = structuredClone(f.plan);
  late.steps[1].data = recall(late.steps[1].data, (a) => (a[3] = f.plan.preparedAt + 3601, a));
  const v = verifyPlan(late, f.intent, identity);
  assert.equal(v.rule, "expiry");
  assert.match(v.reason, /more than 60 minutes from now\.$/);
  const max = structuredClone(f.plan);
  max.steps[0].data = recall(max.steps[0].data, (a) => (a[1] = MAX_UINT256, a));
  assert.match(verifyPlan(max, f.intent, identity).reason, /not exactly the \d+ being sold\.$/);
});

// ------------------------------------------------------- the sequence --

/**
 * A sequence wired to the fixture wallet as the trading wallet: silent, with
 * a scripted prepare for trades, and a record of every state and approval.
 * The page's own quote agrees with each plan (quote.test.js holds the real
 * one to real chain bytes).
 */
function harness(over = {}) {
  const w = wallet(over.wallet);
  const h = { w, states: [], approvals: [], fills: [], plans: [], prepared: [] };
  h.seq = createSequence({
    provider: () => w.provider,
    silent: () => true,
    prepare: async (side, body) => {
      h.prepared.push(body);
      return { status: 200, data: structuredClone(h.plans.shift()) };
    },
    readIdentity, verifyPlan, verifyQuote,
    readQuote: async (_request, plan) => BigInt(plan.quote.expectedOut),
    acknowledge: async () => true,
    confirm: async () => true,
    update: (s) => h.states.push(s),
    afterFill: (f) => h.fills.push(f),
    afterApproval: (a) => h.approvals.push(a),
    sleep: yieldNow, pollMs: 1, fastPollMs: 1, receiptMs: 5, backgroundMs: 20,
    ...over.seq,
  });
  return h;
}

test("run: a curve approval is sent, mined and reported, and silently worded", async () => {
  const h = harness();
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN, symbol: "TKN" });
  assert.equal(out.phase, "done", out.message);
  assert.equal(out.ahead, true);
  assert.equal(h.w.sends.length, 1);
  assert.deepEqual(h.w.sends[0], { from: FROM, to: CURVE_TOKEN, data: approve(CURVE, HELD), value: "0x0", gas: `0x${((46_000n * 13n) / 10n).toString(16)}` });
  assert.equal(h.w.erc20, HELD, "the allowance is now the balance");
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].hash, `0x${"0".repeat(63)}1`);
  assert.equal(h.approvals[0].step.label, "Let the curve move TKN");
  assert.ok(h.states.some((s) => s.message === "Signing approval 1 of 1…"));
  assert.ok(!h.states.some((s) => /in your wallet/.test(s.message)));
  assert.ok(!h.seq.busy());
});

test("run: a graduated token's two approvals go one after the other, each only after the last is mined", async () => {
  const h = harness();
  const out = await h.seq.startApproveAhead({ from: FROM, token: V4_TOKEN });
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 2);
  assert.ok(h.w.log.indexOf("receipt:0") < h.w.log.indexOf("sent:1"));
  assert.equal(h.w.p2.amount, HELD);
  assert.equal(h.w.p2.expiration, BigInt(NOW + APPROVE_AHEAD_EXPIRY_S));
  assert.equal(h.approvals.length, 2);
});

test("run: covered sends nothing, and says so", async () => {
  const h = harness({ wallet: { erc20: HELD } });
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "done");
  assert.match(out.message, /Already approved\. Nothing was sent\./);
  assert.equal(h.w.log.filter((m) => m === "eth_sendTransaction").length, 0);
  assert.deepEqual(h.approvals, []);
});

test("run: an allowance given since the plan was built (another tab) is skipped, not given again", async () => {
  const h = harness();
  // Just before the send's own checks, another tab's approval lands.
  let calls = 0;
  const inner = h.w.provider.request;
  h.w.provider.request = async (args) => {
    if (args.method === "eth_accounts" && ++calls === 1) h.w.erc20 = HELD;
    return inner(args);
  };
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 0);
  assert.deepEqual(out.steps.map((s) => s.status), ["skipped"]);
});

test("run: a balance that moved before the send is refused, and nothing is sent", async () => {
  const h = harness();
  const inner = h.w.provider.request;
  h.w.provider.request = async (args) => {
    if (args.method === "eth_accounts") h.w.balance = HELD * 2n;
    return inner(args);
  };
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "refused");
  assert.equal(out.refusal.rule, "amount");
  assert.match(out.message, /^Refused before anything was signed: /);
  assert.equal(h.w.sends.length, 0);
  assert.ok(!h.seq.busy());
});

test("run: a plan refused when it is built never starts: no step is shown, and nothing more is asked", async () => {
  const h = harness({ wallet: { registryCurve: ATTACKER } });
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "refused");
  assert.equal(out.refusal.rule, "identity");
  assert.equal(out.plan, null, "the refused plan's numbers stay out of the state");
  assert.deepEqual(out.steps, []);
  assert.ok(!h.states.some((s) => s.phase === "running"));
  assert.ok(!h.w.log.includes("eth_accounts"), "refused before the send's own checks");
  assert.equal(h.w.sends.length, 0);
});

test("run: every failure ends it, and never holds the tab for a Resume", async () => {
  // The wallet refuses the send.
  let h = harness();
  h.w.onSend = () => ({ throw: Object.assign(new Error("Too many transactions in a minute. Nothing was sent."), { code: -32005 }) });
  let out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "failed");
  assert.equal(out.message, "Too many transactions in a minute. Nothing was sent.");
  assert.ok(!h.seq.busy());
  // A rejection is a failure too: there is no sheet to resume it from.
  h = harness();
  h.w.onSend = () => ({ throw: Object.assign(new Error("User rejected"), { code: 4001 }) });
  out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "failed");
  assert.ok(!h.seq.busy());
  // It reverts.
  h = harness();
  h.w.onSend = () => ({ receipt: "revert" });
  out = await h.seq.startApproveAhead({ from: FROM, token: V4_TOKEN });
  assert.equal(out.phase, "reverted");
  assert.equal(h.w.sends.length, 1, "nothing after a revert");
  // The account changes.
  h = harness();
  h.w.account = ATTACKER;
  out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "void");
  assert.equal(h.w.sends.length, 0);
  // A read fails before there is a plan.
  h = harness({ wallet: { gasEstimate: null } });
  h.w.provider.request = async () => { throw new Error("offline"); };
  out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "failed");
  assert.equal(out.plan, null);
  // It never mines.
  h = harness();
  h.w.onSend = () => ({ receipt: "never" });
  out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "timeout");
  assert.ok(!h.seq.busy());
});

test("run: a silent signer's approval receipts are polled every 250 ms at first", async () => {
  const slept = [];
  const h = harness({ seq: { fastPollMs: 250, pollMs: 1000, receiptMs: 90_000, backgroundMs: 600_000,
    sleep: async (ms) => { slept.push(ms); await yieldNow(); } } });
  let polls = 0;
  h.w.onSend = () => ({ receipt: "never" });
  const inner = h.w.provider.request;
  h.w.provider.request = async (args) => {
    if (args.method === "eth_getTransactionReceipt" && ++polls === 5) {
      h.w.receipts.get(args.params[0]).outcome = "ok";
    }
    return inner(args);
  };
  const out = await h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(slept, [250, 250, 250, 250]);
});

test("one at a time: an approval ahead waits for nothing and refuses while a trade runs; a trade refuses while it runs", async () => {
  const h = harness();
  h.w.onSend = () => ({ receipt: "never" });
  const f = fixture("curve buy");
  h.plans = [f.plan];
  const running = h.seq.startApproveAhead({ from: FROM, token: CURVE_TOKEN });
  await yieldNow();
  assert.ok(h.seq.busy());
  const trade = await h.seq.start({ side: "buy", from: FROM, token: CURVE_TOKEN, amountEth: "0.01", slippageBps: f.intent.slippageBps });
  assert.equal(trade.ahead, true, "the trade was refused: the state is still the approval's");
  assert.deepEqual(h.prepared, []);
  await running;
});

test("a sell after the approval is one step: the plan's own approval is already covered", async () => {
  const f = fixture("curve sell with approval");
  const h = harness({ wallet: { balance: BigInt(f.intent.tokens) } });
  const ahead = await h.seq.startApproveAhead({ from: f.intent.from, token: f.intent.token });
  assert.equal(ahead.phase, "done", ahead.message);
  assert.equal(h.w.sends.length, 1);
  h.w.now = f.plan.preparedAt;
  h.plans = [f.plan];
  const out = await h.seq.start({ side: "sell", from: f.intent.from, token: f.intent.token, tokens: f.intent.tokens, slippageBps: f.intent.slippageBps });
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(out.steps.map((s) => s.status), ["skipped", "mined"]);
  assert.equal(h.w.sends.length, 2, "the approval ahead, then only the sell");
  assert.equal(h.w.sends[1].data, f.plan.steps[1].data);
});

test("a graduated sell after the approvals is one step", async () => {
  const f = fixture("v4 sell with both approvals");
  const h = harness({ wallet: { balance: BigInt(f.intent.tokens) } });
  h.w.now = f.plan.preparedAt;
  const ahead = await h.seq.startApproveAhead({ from: f.intent.from, token: f.intent.token });
  assert.equal(ahead.phase, "done", ahead.message);
  assert.equal(h.w.sends.length, 2);
  h.plans = [f.plan];
  const out = await h.seq.start({ side: "sell", from: f.intent.from, token: f.intent.token, tokens: f.intent.tokens, slippageBps: f.intent.slippageBps });
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(out.steps.map((s) => s.status), ["skipped", "skipped", "mined"]);
  assert.equal(h.w.sends.length, 3);
});
