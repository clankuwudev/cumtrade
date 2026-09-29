// The signing sequence (public-release F3.2), against a scripted EIP-1193
// wallet. The plans are B2.3's fixtures and the verifier is the real one, so a
// trade here goes through the same checks it would in the page: prepared,
// verified, confirmed, then sent a step at a time, each only after the one
// before it was mined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";
import { readIdentity, verifyPlan } from "../public/js/trade/verify.js";
import { readQuote, verifyQuote } from "../public/js/trade/quote.js";
import { clampSlippage, createSequence, parseEth } from "../public/js/trade/sequence.js";
import { recall, reswap } from "./support/calldata.js";
import { chain, fixture, fixtureWallet } from "./support/fixtureWallet.js";
const lower = (a) => String(a).toLowerCase();
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x000000000000000000000000000000000000B0b0";
const yieldNow = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------ the wallet --

/** The fixture chain's scripted wallet (support/fixtureWallet.js). */
const wallet = fixtureWallet;

/**
 * A sequence wired to a wallet, a scripted prepare and scripted answers to
 * every question. The page's own quote is scripted too (quote.test.js holds
 * the real one to real chain bytes): by default it agrees with each plan, and
 * `h.own(plan)` can return another figure, or an Error to throw.
 */
function harness(name, over = {}) {
  const fx = fixture(name);
  const w = wallet({ from: fx.intent.from, now: fx.plan.preparedAt });
  const h = {
    fx, w,
    prepared: [], asked: [], updates: [], fills: [], logs: [],
    plans: [fx.plan],
    answer: (ask) => true,
    acknowledged: true,
    /** Every readQuote call: the plan's expected output, the intent and the reads it was given. */
    quotes: [],
    own: null,
  };
  h.seq = createSequence({
    provider: () => w.provider,
    prepare: async (side, body) => {
      h.prepared.push({ side, body });
      const plan = h.plans[Math.min(h.prepared.length - 1, h.plans.length - 1)];
      return typeof plan === "function" ? plan(body) : { status: 200, data: structuredClone(plan) };
    },
    readIdentity, verifyPlan, verifyQuote,
    readQuote: async (request, plan, intent, reads) => {
      h.quotes.push({ expectedOut: plan.quote.expectedOut, intent, reads, request });
      const own = h.own ? h.own(plan) : BigInt(plan.quote.expectedOut);
      if (own instanceof Error) throw own;
      return own;
    },
    acknowledge: async () => h.acknowledged,
    confirm: async (ask) => { h.asked.push(ask.kind); return h.answer(ask); },
    update: (s) => h.updates.push(s.phase),
    afterFill: (fill) => h.fills.push({ ...fill, phaseAtFill: h.seq.state().phase }),
    sleep: yieldNow, pollMs: 1, receiptMs: 5, backgroundMs: 20,
    // These tests re-check before every send, as a trade with a pause does;
    // the one-click tests below pass a clock and the real window.
    freshMs: 0, log: (line) => h.logs.push(line),
    ...over,
  });
  h.logs = h.logs ?? [];
  /** The intent the fixture was prepared from, as the page would pass it. */
  h.input = () => fx.intent.side === "buy"
    ? { side: "buy", from: fx.intent.from, token: fx.intent.token, amountEth: "0.01", slippageBps: fx.intent.slippageBps }
    : { side: "sell", from: fx.intent.from, token: fx.intent.token, tokens: fx.intent.tokens, slippageBps: fx.intent.slippageBps };
  return h;
}

/** Each send that went through happened only after the previous one's receipt was seen. */
function assertSerial(w) {
  for (let i = 1; i < w.sends.length; i++) {
    const sendAt = w.log.indexOf(`sent:${i}`);
    const minedAt = w.log.indexOf(`receipt:${i - 1}`);
    assert.ok(minedAt >= 0 && minedAt < sendAt, `send ${i} came before receipt ${i - 1}`);
  }
}

// ------------------------------------------------------------- the spec --

test("accept all: three sends, each only after the previous receipt", async () => {
  const h = harness("v4 sell with both approvals");
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 3);
  assert.deepEqual(h.w.sends.map((t) => t.to), h.fx.plan.steps.map((s) => s.to));
  assertSerial(h.w);
  assert.deepEqual(out.steps.map((s) => s.status), ["mined", "mined", "mined"]);
  assert.deepEqual(h.asked, ["plan"]);
  assert.equal(h.fills.length, 1);
  assert.equal(h.fills[0].phaseAtFill, "done", "the fill hook (the report, the ledger refresh) sees a finished trade");
  // What was sent is the plan's calldata, from the visitor, with the plan's value and gas.
  h.w.sends.forEach((tx, i) => {
    const s = h.fx.plan.steps[i];
    assert.deepEqual(tx, { from: h.fx.intent.from, to: s.to, data: s.data, value: s.value, gas: s.gas });
  });
});

test("reject at step 2, then resume: step 1 is not sent again", async () => {
  const h = harness("v4 sell with both approvals");
  let rejected = false;
  h.w.onSend = (i) => (i === 1 && !rejected ? (rejected = true, { throw: Object.assign(new Error("User rejected"), { code: 4001 }) }) : {});
  let out = await h.seq.start(h.input());
  assert.equal(out.phase, "rejected");
  assert.equal(out.message, "You rejected step 2.");
  assert.equal(h.w.sends.length, 1);
  assert.ok(h.seq.busy(), "a rejected trade is still this tab's trade");
  out = await h.seq.resume();
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 3);
  assert.equal(h.w.sends.filter((t) => t.to === h.fx.plan.steps[0].to).length, 1, "step 1 once");
  assertSerial(h.w);
});

test("revert at step 3: the flow stops and nothing is reported", async () => {
  const h = harness("v4 sell with both approvals");
  h.w.onSend = (i) => (i === 2 ? { receipt: "revert" } : {});
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "reverted");
  assert.equal(out.message, "Step 3 reverted. Nothing more will be sent.");
  assert.equal(h.fills.length, 0, "afterFill, where the report will be sent, never ran");
  assert.equal(await h.seq.resume().then((s) => s.phase), "reverted", "a revert cannot be resumed");
});

test("receipt timeout at step 1: step 2 is never sent", async () => {
  const h = harness("v4 sell with both approvals");
  h.w.onSend = () => ({ receipt: "never" });
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "timeout");
  assert.equal(h.w.sends.length, 1);
  assert.ok(h.updates.includes("pending"), "it said still pending before giving up");
  assert.equal(out.steps[0].status, "unknown");
  assert.ok(!h.seq.busy());
});

test("chainChanged before step 2: it pauses, and nothing is sent until the chain is back", async () => {
  const h = harness("v4 sell with both approvals");
  h.w.onMined = (i) => { if (i === 0) h.w.chainId = 1; };
  let out = await h.seq.start(h.input());
  assert.equal(out.phase, "paused");
  assert.equal(h.w.sends.length, 1);
  out = await h.seq.resume();
  assert.equal(out.phase, "paused", "still on the wrong chain");
  assert.equal(h.w.sends.length, 1);
  h.w.chainId = 4663;
  out = await h.seq.resume();
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 3);
});

test("accountsChanged before step 2: it stops, and only a new prepare can go on", async () => {
  const h = harness("v4 sell with both approvals");
  h.w.onMined = (i) => { if (i === 0) h.w.account = OTHER; };
  let out = await h.seq.start(h.input());
  assert.equal(out.phase, "void");
  assert.equal(h.w.sends.length, 1);
  assert.ok(!h.seq.busy());
  // Even with the account back, the old plan is not resumed.
  h.w.account = h.fx.intent.from;
  assert.equal((await h.seq.resume()).phase, "void", "a void plan cannot be resumed");
  assert.equal(h.w.sends.length, 1);
  out = await h.seq.start(h.input());
  assert.equal(h.prepared.length, 2, "starting again prepares again");
  assert.equal(out.phase, "done", out.message);
});

test("expired before the swap: one new prepare, verified again, and a lower minimum asks again", async () => {
  const h = harness("v4 sell with both approvals");
  const old = h.fx.plan;
  // The server's second answer: the approvals are in place now, so just the
  // swap, at a worse price. minOut must stay 5% under expectedOut, or the
  // verifier would refuse it.
  const expected = (BigInt(old.quote.expectedOut) * 90n) / 100n;
  const minOut = (expected * 9_500n) / 10_000n;
  const swap = structuredClone(old.steps[2]);
  swap.data = reswap(swap.data, (s) => { s.minOut = minOut; s.take[1] = minOut; });
  const fresh = {
    ...structuredClone(old), preparedAt: old.preparedAt + 120, expiresAt: old.preparedAt + 180,
    quote: { ...old.quote, expectedOut: expected.toString(), minOut: minOut.toString() }, steps: [swap],
  };
  h.plans = [old, fresh];
  h.w.onMined = (i) => { if (i === 1) h.w.now = old.expiresAt + 30; };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.prepared.length, 2, "exactly one new prepare");
  assert.deepEqual(h.asked, ["plan", "priceMoved"]);
  assert.equal(h.w.sends.length, 3);
  assert.equal(h.w.sends[2].data, lower(swap.data), "the swap sent is the new plan's");
  assert.deepEqual(out.done.map((s) => s.status), ["mined", "mined"], "the approvals stay on the sheet");
});

test("a refused plan: no wallet send, and no plan sheet", async () => {
  const h = harness("curve buy");
  const bad = fixture("curve buy").plan;
  bad.steps[0].data = recall(bad.steps[0].data, (a) => (a[2] = ATTACKER, a));
  h.plans = [bad];
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "refused");
  assert.equal(out.refusal.rule, "recipient");
  assert.equal(out.refusal.plan, bad.planId, "the refused plan is named, for a report");
  assert.equal(out.plan, null, "but its unverified numbers never reach the sheet");
  assert.match(out.message, /^Refused before your wallet opened: .*Nothing was sent\.$/);
  assert.equal(h.w.log.filter((m) => m === "eth_sendTransaction").length, 0);
  assert.deepEqual(h.asked, []);
});

// ------------------------------------------------------- the amendments --

test("an expired quote's new plan is verified before the visitor is asked about its price", async () => {
  const h = harness("v4 sell with both approvals");
  const old = h.fx.plan;
  const minOut = (BigInt(old.quote.expectedOut) * 90n / 100n * 9_500n) / 10_000n;
  const swap = structuredClone(old.steps[2]);
  // Worse price, and paying out to a pool with someone else's hook.
  swap.data = reswap(swap.data, (s) => { s.minOut = minOut; s.take[1] = minOut; s.key[4] = ATTACKER; });
  h.plans = [old, { ...structuredClone(old), expiresAt: old.expiresAt + 200, steps: [swap],
    quote: { ...old.quote, expectedOut: (BigInt(old.quote.expectedOut) * 90n / 100n).toString(), minOut: minOut.toString() } }];
  h.w.onMined = (i) => { if (i === 1) h.w.now = old.expiresAt + 30; };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "refused");
  assert.equal(out.refusal.rule, "hooks");
  assert.deepEqual(h.asked, ["plan"], "no price question about a plan that failed verification");
  assert.equal(h.w.sends.length, 2);
});

test("the expired path does not ask again when the new minimum is no worse", async () => {
  const h = harness("curve buy");
  const again = { ...fixture("curve buy").plan, preparedAt: h.fx.plan.preparedAt + 100, expiresAt: h.fx.plan.preparedAt + 160 };
  h.plans = [h.fx.plan, again];
  h.w.now = h.fx.plan.expiresAt + 1;
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.prepared.length, 2);
  assert.deepEqual(h.asked, ["plan"]);
});

test("declining a moved price ends the trade with nothing more sent", async () => {
  const h = harness("v4 sell with both approvals");
  const old = h.fx.plan;
  const minOut = (BigInt(old.quote.expectedOut) * 50n / 100n * 9_500n) / 10_000n;
  const swap = structuredClone(old.steps[2]);
  swap.data = reswap(swap.data, (s) => { s.minOut = minOut; s.take[1] = minOut; });
  h.plans = [old, { ...structuredClone(old), expiresAt: old.expiresAt + 200, steps: [swap],
    quote: { ...old.quote, expectedOut: (BigInt(old.quote.expectedOut) * 50n / 100n).toString(), minOut: minOut.toString() } }];
  h.w.onMined = (i) => { if (i === 1) h.w.now = old.expiresAt + 30; };
  h.answer = (ask) => ask.kind !== "priceMoved";
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "cancelled");
  assert.equal(h.w.sends.length, 2);
});

test("an allowance short of the amount is not cover: the approval is sent", async () => {
  const h = harness("curve sell with approval");
  h.w.erc20 = BigInt(h.fx.intent.tokens) - 1n;
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(out.steps.map((s) => s.status), ["mined", "mined"]);
  assert.equal(h.w.sends.length, 2);
});

test("an approval already in place is skipped, and a Permit2 allowance that has expired is not", async () => {
  const h = harness("v4 sell with both approvals");
  const tokens = BigInt(h.fx.intent.tokens);
  h.w.erc20 = tokens;
  h.w.p2 = { amount: tokens, expiration: BigInt(h.w.now - 1) };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(out.steps.map((s) => s.status), ["skipped", "mined", "mined"]);
  assert.equal(h.w.sends.length, 2);
});

test("a capped sell is offered as a new intent, prepared again, and verified", async () => {
  const h = harness("curve sell with approval");
  const capped = { ...fixture("curve sell with approval").plan, warnings: [{ code: "capped", text: "capped" }] };
  h.plans = [capped, h.fx.plan];
  const input = { ...h.input(), tokens: (BigInt(h.fx.intent.tokens) * 3n).toString() };
  const out = await h.seq.start(input);
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(h.asked, ["capped", "plan"]);
  assert.equal(h.prepared[1].body.tokens, h.fx.intent.tokens, "the second prepare asks for what the curve can take");
});

test("declining the capped amount sends nothing", async () => {
  const h = harness("curve sell with approval");
  h.plans = [{ ...h.fx.plan, warnings: [{ code: "capped", text: "capped" }] }];
  h.answer = () => false;
  const out = await h.seq.start({ ...h.input(), tokens: (BigInt(h.fx.intent.tokens) * 3n).toString() });
  assert.equal(out.phase, "cancelled");
  assert.equal(h.w.sends.length, 0);
  assert.equal(h.prepared.length, 1);
});

test("a sell by percentage reads the balance through the wallet and asks for exact tokens", async () => {
  const h = harness("curve sell with approval");
  h.w.balance = BigInt(h.fx.intent.tokens) * 2n;
  const out = await h.seq.start({ side: "sell", from: h.fx.intent.from, token: h.fx.intent.token, pct: 50, slippageBps: 500 });
  assert.equal(h.prepared[0].body.tokens, h.fx.intent.tokens);
  assert.equal(out.phase, "done", out.message);
  const all = harness("curve sell with approval");
  all.w.balance = BigInt(all.fx.intent.tokens);
  await all.seq.start({ side: "sell", from: all.fx.intent.from, token: all.fx.intent.token, pct: 100, slippageBps: 500 });
  assert.equal(all.prepared[0].body.tokens, all.fx.intent.tokens, "100% is the whole balance, not a rounded share");
});

test("a sell of nothing never reaches the server", async () => {
  const h = harness("curve sell with approval");
  h.w.balance = 0n;
  const out = await h.seq.start({ side: "sell", from: h.fx.intent.from, token: h.fx.intent.token, pct: 50, slippageBps: 500 });
  assert.equal(out.phase, "failed");
  assert.equal(out.message, "This wallet holds none of this token.");
  assert.equal(h.prepared.length, 0);
});

test("a buy's amount is exact wei, and the same string goes to the server", async () => {
  assert.equal(parseEth("0.01"), 10n ** 16n);
  assert.equal(parseEth("1"), 10n ** 18n);
  assert.equal(parseEth("0.000000000000000001"), 1n);
  assert.equal(parseEth(" 2.5 "), 25n * 10n ** 17n);
  for (const bad of ["", "1e18", "-1", "0.0000000000000000001", "1.", ".5", "0x10", "1,000"]) {
    assert.throws(() => parseEth(bad), undefined, bad);
  }
  assert.equal(clampSlippage(5), 10);
  assert.equal(clampSlippage(9999), 5000);
  assert.equal(clampSlippage(NaN), 300);
  const h = harness("curve buy");
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.prepared[0].body.amountEth, "0.01");
  assert.equal(out.intent.amountIn, "10000000000000000");
  assert.equal(h.w.sends[0].value, h.fx.plan.steps[0].value, "the ETH sent is the verified plan's");
  assert.equal(BigInt(h.w.sends[0].value), 10n ** 16n);
});

test("one trade per tab: a second start while one is live does nothing", async () => {
  const h = harness("v4 sell with both approvals");
  h.w.onSend = (i) => (i === 1 ? { throw: Object.assign(new Error("rejected"), { code: 4001 }) } : {});
  await h.seq.start(h.input());
  assert.equal(h.seq.state().phase, "rejected");
  const again = await h.seq.start(h.input());
  assert.equal(again.phase, "rejected");
  assert.equal(h.prepared.length, 1);
  h.seq.cancel();
  assert.equal(h.seq.state().phase, "cancelled");
  assert.ok(!h.seq.busy());
});

test("no acknowledgement, no prepare", async () => {
  const h = harness("curve buy");
  h.acknowledged = false;
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "cancelled");
  assert.equal(h.prepared.length, 0);
});

test("declining the plan sheet sends nothing", async () => {
  const h = harness("curve buy");
  h.answer = () => false;
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "cancelled");
  assert.equal(h.w.log.filter((m) => m === "eth_sendTransaction").length, 0);
});

test("a plan that turns bad between steps is refused before the next send", async () => {
  const h = harness("v4 sell with both approvals");
  // After step 1 mines, the factory's registry names another curve for the
  // token. The next verification must refuse before anything else is sent.
  h.w.onMined = (i) => { if (i === 0) h.w.registryCurve = ATTACKER; };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "identity");
  assert.equal(h.w.sends.length, 1);
  assert.match(out.message, /1 step already went through; nothing more will be sent\.$/);
});

test("wallet errors are kept, in words, and can be resumed", async () => {
  for (const [code, want] of [
    [-32002, "Your wallet already has a request open. Check it."],
    [4200, "This wallet cannot do that (eth_sendTransaction)."],
    [-32603, "-32603: boom"],
  ]) {
    const h = harness("curve buy");
    let failed = false;
    h.w.onSend = () => (failed ? {} : (failed = true, { throw: Object.assign(new Error("boom"), { code }) }));
    let out = await h.seq.start(h.input());
    assert.equal(out.phase, "error");
    assert.equal(out.message, want);
    out = await h.seq.resume();
    assert.equal(out.phase, "done", out.message);
    assert.equal(h.w.sends.length, 1);
  }
});

// --------------------------------------------------- the page's own quote --
// F3.3: every plan that arrives is priced by the page, after the verifier.

/** A fixture plan that expects `pct`% of its real output, with a minimum to match. */
function shaded(name, pct) {
  const { plan, intent } = fixture(name);
  const expected = (BigInt(plan.quote.expectedOut) * BigInt(pct)) / 100n;
  const minOut = (expected * BigInt(10_000 - intent.slippageBps)) / 10_000n;
  plan.quote = { ...plan.quote, expectedOut: expected.toString(), minOut: minOut.toString() };
  const swap = plan.steps.at(-1);
  swap.data = swap.kind === "router-swap"
    ? reswap(swap.data, (s) => { s.minOut = minOut; s.take[1] = minOut; })
    : recall(swap.data, (a) => (a[1] = minOut, a));
  return plan;
}

test("a plan expecting less than the page's own quote is refused before the sheet, and nothing is sent", async () => {
  const h = harness("v4 sell with both approvals");
  const truth = BigInt(h.fx.plan.quote.expectedOut);
  h.plans = [shaded("v4 sell with both approvals", 90)];
  h.own = () => truth;
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "quote");
  assert.equal(out.refusal.step, null);
  assert.equal(out.plan, null, "the plan's numbers never reach the sheet");
  assert.match(out.message, /^Refused before your wallet opened: The server expects .* Nothing was sent\.$/);
  assert.deepEqual(h.asked, []);
  assert.equal(h.w.log.filter((m) => m === "eth_sendTransaction").length, 0);
});

test("a price the page cannot work out refuses the plan; it never lets it through", async () => {
  const h = harness("curve buy");
  h.own = () => new Error("the wallet's RPC refused eth_call");
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "refused");
  assert.equal(out.refusal.rule, "quote-read");
  assert.match(out.message, /could not be worked out through your wallet: the wallet's RPC refused eth_call\. Nothing was sent\.$/);
  assert.deepEqual(h.asked, []);
  assert.equal(h.w.sends.length, 0);
});

test("the quote is checked once for a plan, after the verifier, not again before each step", async () => {
  const h = harness("v4 sell with both approvals");
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 3);
  assert.equal(h.quotes.length, 1, "one price check for a three-step plan");
  // It was given the reads the verifier passed, and the wallet's own request.
  const { reads, request, intent } = h.quotes[0];
  assert.equal(lower(reads.tokenCurve), lower(chain.tokens[h.fx.intent.token].curve));
  assert.equal(reads.graduated, true);
  assert.equal(intent.tokens, h.fx.intent.tokens);
  const before = h.w.log.length;
  assert.equal(await request({ method: "eth_chainId" }), "0x1237");
  assert.equal(h.w.log.length, before + 1, "its request goes to the visitor's wallet");
});

test("a plan that fails the verifier is never priced", async () => {
  const h = harness("curve buy");
  const bad = fixture("curve buy").plan;
  bad.steps[0].data = recall(bad.steps[0].data, (a) => (a[2] = ATTACKER, a));
  h.plans = [bad];
  const out = await h.seq.start(h.input());
  assert.equal(out.refusal.rule, "recipient");
  assert.equal(h.quotes.length, 0);
});

test("a plan prepared again after expiry is priced too, and a shaded one is refused before the price question", async () => {
  const h = harness("v4 sell with both approvals");
  const old = h.fx.plan;
  const fresh = { ...shaded("v4 sell with both approvals", 90), preparedAt: old.preparedAt + 120, expiresAt: old.preparedAt + 180 };
  fresh.steps = [fresh.steps[2]];
  h.plans = [old, fresh];
  // The chain still gives the original figure: the new plan expects 10% less than it.
  h.own = () => BigInt(old.quote.expectedOut);
  h.w.onMined = (i) => { if (i === 1) h.w.now = old.expiresAt + 30; };
  const out = await h.seq.start(h.input());
  assert.equal(h.quotes.length, 2, "the first plan and the new one");
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "quote");
  assert.deepEqual(h.asked, ["plan"], "no price question about a plan that failed the quote");
  assert.equal(h.w.sends.length, 2, "only the approvals went");
  assert.match(out.message, /2 steps already went through; nothing more will be sent\.$/);
});

test("a capped sell's new plan is priced for the amount the curve can take", async () => {
  const h = harness("curve sell with approval");
  const capped = { ...fixture("curve sell with approval").plan, warnings: [{ code: "capped", text: "capped" }] };
  h.plans = [capped, h.fx.plan];
  const out = await h.seq.start({ ...h.input(), tokens: (BigInt(h.fx.intent.tokens) * 3n).toString() });
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.quotes.length, 1);
  assert.equal(h.quotes[0].intent.tokens, h.fx.intent.tokens);
});

test("with the real readQuote, a curve buy is priced through the wallet, and a shaded one refused", async () => {
  const h = harness("curve buy", { readQuote });
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.log.filter((m) => m === "eth_call").length, 5 + 5 + 1,
    "the identity's five calls twice (at the start and before the send), and one quote");

  const lie = harness("curve buy", { readQuote });
  lie.plans = [shaded("curve buy", 95)];
  const refused = await lie.seq.start(lie.input());
  assert.equal(refused.phase, "refused", refused.message);
  assert.equal(refused.refusal.rule, "quote");
  assert.equal(lie.w.sends.length, 0);
});

test("a sequence cannot be built without every one of its checks", () => {
  const deps = {
    provider: () => null, prepare: async () => ({}), acknowledge: async () => true, confirm: async () => true, update: () => {},
    readIdentity, verifyPlan, readQuote, verifyQuote,
  };
  assert.doesNotThrow(() => createSequence(deps));
  for (const k of ["readIdentity", "verifyPlan", "readQuote", "verifyQuote"]) {
    assert.throws(() => createSequence({ ...deps, [k]: undefined }), new RegExp(`needs ${k}`), k);
  }
});

test("a pending step that mines late carries on, and receipts are only looked for on Robinhood Chain", async () => {
  const h = harness("curve sell with approval");
  const inner = h.w.provider.request;
  let chainPolls = 0, offChainReceiptPolls = 0, receiptPolls = 0;
  h.w.provider = {
    request: async (args) => {
      if (args.method === "eth_sendTransaction") {
        const hash = await inner(args);
        // The visitor wanders to another chain while the first step is pending.
        if (h.w.sends.length === 1) h.w.chainId = 1;
        return hash;
      }
      if (args.method === "eth_chainId" && h.w.chainId === 1 && ++chainPolls === 4) {
        const answer = await inner(args);
        h.w.chainId = 4663;
        return answer;
      }
      if (args.method === "eth_getTransactionReceipt") {
        if (h.w.chainId !== 4663) offChainReceiptPolls++;
        // Mined only after the "still pending" point (receiptMs is 5 polls).
        if (++receiptPolls < 8) return null;
      }
      return inner(args);
    },
  };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.ok(h.updates.includes("pending"), "it said still pending");
  assert.equal(offChainReceiptPolls, 0, "no receipt was looked for on another chain");
  assert.ok(chainPolls >= 4, "it waited on the other chain");
  assert.equal(h.w.sends.length, 2, "and carried on to the swap once the approval mined");
  assertSerial(h.w);
});

// ====================================================================== //
// transfers between the visitor's two wallets (W2.1)                     //
// ====================================================================== //

const MAIN = "0x00000000000000000000000000000000000A11cE";
const TRADING = "0x0000000000000000000000000000000000007Ead";
/** An address the page might remember, or our server might offer. */
const STORED = "0x000000000000000000000000000000000000B0b0";
const BASE_FEE = 50_080_000n; // the live base fee, read 2026-09-22

/**
 * The visitor's two wallets on one fake chain. The main wallet is a browser
 * wallet (F2): each eth_sendTransaction it gets is its pop-up. The trading
 * wallet stands in for W1.1's embedded provider: it answers the same methods
 * from the chain, signs with no pop-up, and, like any node, refuses a send
 * whose value and gas at twice the base fee are more than it holds. A mined
 * send moves its value and pays for the gas it used at the base fee.
 */
function twoWallets() {
  const c = {
    baseFee: BASE_FEE,
    balances: new Map([[lower(MAIN), 2n * 10n ** 18n], [lower(TRADING), 3n * 10n ** 17n]]),
    /** eth_estimateGas's answer: a bigint, a raw answer, an Error, or a function of the call. */
    estimate: 21_000n,
    estimates: [],
    receipts: new Map(), hashes: 0,
  };
  c.balance = (a) => c.balances.get(lower(a)) ?? 0n;
  const make = (who, account) => {
    const w = {
      who, account, chainId: 4663, calls: [], sent: [],
      /** (i, tx) → { throw?, receipt?: "ok" | "revert" | "never" } for this wallet's i-th send. */
      onSend: () => ({}),
    };
    w.count = (method) => w.calls.filter((m) => m === method).length;
    w.provider = {
      async request({ method, params }) {
        w.calls.push(method);
        switch (method) {
          case "eth_chainId": return toHex(w.chainId);
          case "eth_accounts": return w.account ? [w.account] : [];
          case "eth_getBlockByNumber": return { number: "0x1", timestamp: "0x6a9c1d00", baseFeePerGas: toHex(c.baseFee) };
          case "eth_getBalance": return toHex(c.balance(params[0]));
          case "eth_estimateGas": {
            c.estimates.push({ who, call: params[0] });
            const e = typeof c.estimate === "function" ? c.estimate(params[0]) : c.estimate;
            if (e instanceof Error) throw e;
            return typeof e === "bigint" ? toHex(e) : e;
          }
          case "eth_sendTransaction": {
            const tx = params[0];
            assert.equal(lower(tx.from), lower(w.account), `the ${who} wallet was asked to send from another account`);
            const plan = w.onSend(w.sent.length, tx) ?? {};
            if (plan.throw) throw plan.throw;
            if (who === "trading" && BigInt(tx.value) + BigInt(tx.gas) * 2n * c.baseFee > c.balance(tx.from)) {
              throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 });
            }
            w.sent.push(tx);
            const hash = `0x${(++c.hashes).toString(16).padStart(64, "0")}`;
            c.receipts.set(hash, { tx, outcome: plan.receipt ?? "ok", seen: false });
            return hash;
          }
          case "eth_getTransactionReceipt": {
            const r = c.receipts.get(params[0]);
            if (!r || r.outcome === "never") return null;
            if (!r.seen) {
              r.seen = true;
              // A plain transfer uses exactly its estimate, which is its limit.
              const paid = BigInt(r.tx.gas) * c.baseFee, value = r.outcome === "ok" ? BigInt(r.tx.value) : 0n;
              c.balances.set(lower(r.tx.from), c.balance(r.tx.from) - value - paid);
              c.balances.set(lower(r.tx.to), c.balance(r.tx.to) + value);
            }
            return { transactionHash: params[0], status: r.outcome === "ok" ? "0x1" : "0x0", logs: [] };
          }
        }
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
    return w;
  };
  c.main = make("main", MAIN);
  c.trading = make("trading", TRADING);
  return c;
}

/**
 * A sequence wired to both wallets, with no server: `prepare` records any call
 * and fails, and every question is scripted. `h.answer(ask)` may change the
 * world while the visitor is reading the confirmation, before the send.
 */
function transferHarness(over = {}) {
  const c = twoWallets();
  const h = {
    c, main: c.main, trading: c.trading,
    asked: [], asks: [], updates: [], fills: [], transfers: [], prepared: [], acknowledged: 0,
    answer: (ask) => true,
    mainProvider: () => c.main.provider, tradingProvider: () => c.trading.provider,
  };
  h.seq = createSequence({
    provider: () => h.tradingProvider(),
    main: () => h.mainProvider(),
    prepare: async (side, body) => { h.prepared.push({ side, body }); return { status: 503, data: { error: "no server here" } }; },
    readIdentity, verifyPlan, readQuote, verifyQuote,
    acknowledge: async () => { h.acknowledged++; return true; },
    confirm: async (ask) => { h.asked.push(ask.kind); h.asks.push(ask); return h.answer(ask); },
    update: (s) => h.updates.push(s.phase),
    afterFill: (fill) => h.fills.push(fill),
    afterTransfer: (fill) => h.transfers.push({ ...fill, phaseAtFill: h.seq.state().phase }),
    sleep: yieldNow, pollMs: 1, receiptMs: 5, backgroundMs: 20,
    ...over,
  });
  /** Every send either wallet made. */
  h.sends = () => [...c.main.sent, ...c.trading.sent];
  return h;
}

test("fund: exactly the typed wei, from the main wallet's pop-up to the trading wallet's own address, and no server", async () => {
  const h = transferHarness();
  // The estimate is not 21,000 here: an L1 data cost, when the parent chain
  // charges one, is part of it. The plan must carry the estimate.
  h.c.estimate = 27_512n;
  const out = await h.seq.startTransfer({ kind: "fund", amountEth: "0.05" });
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(h.main.sent, [{ from: MAIN, to: TRADING, data: "0x", value: toHex(5n * 10n ** 16n), gas: toHex(27_512n) }]);
  assert.equal(h.trading.count("eth_sendTransaction"), 0, "the trading wallet sends nothing for a fund");
  assert.deepEqual(h.c.estimates, [{ who: "main", call: { from: MAIN, to: TRADING, value: toHex(5n * 10n ** 16n), data: "0x" } }],
    "the gas was estimated by the sending wallet, for this very transfer");
  assert.equal(h.c.balance(TRADING), 3n * 10n ** 17n + 5n * 10n ** 16n, "the trading wallet got exactly the typed amount");
  assert.deepEqual(h.prepared, [], "no server call");
  assert.equal(h.acknowledged, 0, "the trading-wallet warning is shown at login (W1.2), not here");
  assert.deepEqual(h.asked, ["transfer"]);
  assert.equal(h.asks[0].intent.to, TRADING, "the confirmation names the trading wallet's own address");
  assert.equal(h.asks[0].intent.amountWei, (5n * 10n ** 16n).toString());
  assert.equal(h.fills.length, 0, "a transfer is not a trade's fill");
  assert.equal(h.transfers.length, 1);
  assert.equal(h.transfers[0].phaseAtFill, "done");
  assert.ok(!h.seq.busy());

  // A tiny amount stays exact, with no floating point anywhere.
  const tiny = transferHarness();
  await tiny.seq.startTransfer({ kind: "fund", amountEth: "0.000000000000000001" });
  assert.equal(tiny.main.sent[0].value, "0x1");
});

test("withdraw: the balance less its gas at twice the base fee, to the main wallet's own address, with no pop-up", async () => {
  const h = transferHarness();
  // A main wallet that is a contract costs more than 21,000 to pay.
  h.c.estimate = 34_120n;
  const balance = h.c.balance(TRADING);
  const reserve = 34_120n * 2n * BASE_FEE;
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "done", out.message);
  assert.deepEqual(h.trading.sent, [{ from: TRADING, to: MAIN, data: "0x", value: toHex(balance - reserve), gas: toHex(34_120n) }]);
  assert.equal(h.main.count("eth_sendTransaction"), 0, "the main wallet opens nothing for a withdraw");
  assert.deepEqual(h.c.estimates, [{ who: "trading", call: { from: TRADING, to: MAIN, value: toHex(balance), data: "0x" } }],
    "estimated by the trading wallet, with the whole balance as the value");
  assert.equal(out.plan.steps[0].maxFeePerGas, toHex(2n * BASE_FEE));
  // What stays behind is at most the reserve: here, the half of it the gas did not use.
  const left = h.c.balance(TRADING);
  assert.ok(left >= 0n && left <= reserve, `${left} left, reserve ${reserve}`);
  assert.equal(left, 34_120n * BASE_FEE);
  assert.equal(h.c.balance(MAIN), 2n * 10n ** 18n + balance - reserve);
  assert.deepEqual(h.prepared, []);
  assert.equal(h.transfers.length, 1);
});

test("Withdraw all goes only where the main wallet points when the button is pressed, and never to a given address", async () => {
  // The main wallet moved to another account since the page last looked. The
  // withdraw goes to the account it gives now, and the confirmation says so.
  const h = transferHarness();
  h.main.account = STORED;
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.trading.sent[0].to, STORED);
  assert.equal(h.asks[0].intent.to, STORED);

  // An address handed in, typed, remembered or served, is refused outright,
  // before any wallet is asked anything.
  for (const input of [
    { kind: "withdraw", to: STORED }, { kind: "withdraw", from: STORED },
    { kind: "fund", amountEth: "0.01", to: STORED }, { kind: "withdraw", to: MAIN },
  ]) {
    const g = transferHarness();
    const r = await g.seq.startTransfer(input);
    assert.equal(r.phase, "failed", JSON.stringify(input));
    assert.match(r.message, /takes no address/);
    assert.equal(g.main.calls.length + g.trading.calls.length, 0, "no wallet was asked anything");
  }
});

test("a mid-withdraw account switch in the main wallet voids it, and nothing is sent", async () => {
  const h = transferHarness();
  h.answer = () => { h.main.account = STORED; return true; };
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "void", out.message);
  assert.equal(h.sends().length, 0);
  assert.ok(!h.seq.busy());
  h.main.account = MAIN;
  assert.equal((await h.seq.resume()).phase, "void", "a void transfer cannot be resumed");
  assert.equal(h.sends().length, 0);
  // Pressing again reads the wallets again.
  h.answer = () => true;
  assert.equal((await h.seq.startTransfer({ kind: "withdraw" })).phase, "done");
  assert.equal(h.trading.sent[0].to, MAIN);
});

test("a trading wallet that logs out or changes account before the send voids the transfer", async () => {
  for (const [kind, change] of [["fund", null], ["fund", STORED], ["withdraw", null], ["withdraw", STORED]]) {
    const h = transferHarness();
    h.answer = () => { h.trading.account = change; return true; };
    const out = await h.seq.startTransfer(kind === "fund" ? { kind, amountEth: "0.01" } : { kind });
    assert.equal(out.phase, "void", `${kind} → ${change}: ${out.message}`);
    assert.equal(h.sends().length, 0);
  }
  // And a main wallet that disconnects altogether.
  const h = transferHarness();
  h.answer = () => { h.mainProvider = () => null; return true; };
  assert.equal((await h.seq.startTransfer({ kind: "fund", amountEth: "0.01" })).phase, "void");
  assert.equal(h.sends().length, 0);
});

test("a main wallet that changes network pauses the transfer, and it goes on once it is back", async () => {
  for (const kind of ["fund", "withdraw"]) {
    const h = transferHarness();
    h.answer = () => { h.main.chainId = 1; return true; };
    let out = await h.seq.startTransfer(kind === "fund" ? { kind, amountEth: "0.01" } : { kind });
    assert.equal(out.phase, "paused", out.message);
    assert.ok(h.seq.busy());
    out = await h.seq.resume();
    assert.equal(out.phase, "paused", "still on the wrong network");
    assert.equal(h.sends().length, 0);
    h.main.chainId = 4663;
    out = await h.seq.resume();
    assert.equal(out.phase, "done", out.message);
    assert.equal(h.sends().length, 1);
  }
});

test("a trading wallet that answers for another chain before the send is refused, not paused", async () => {
  const h = transferHarness();
  h.answer = () => { h.trading.chainId = 1; return true; };
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "chain");
  assert.equal(h.sends().length, 0);
  assert.ok(!h.seq.busy());
});

test("a fund's receipt is looked for through the main wallet, and only on Robinhood Chain", async () => {
  const h = transferHarness();
  let offChain = 0, back = 0;
  const inner = h.main.provider.request;
  h.main.provider = {
    request: async (args) => {
      if (args.method === "eth_sendTransaction") {
        const hash = await inner(args);
        h.main.chainId = 1; // the visitor wanders off while it is pending
        return hash;
      }
      if (args.method === "eth_getTransactionReceipt" && h.main.chainId !== 4663) offChain++;
      if (args.method === "eth_chainId" && h.main.chainId === 1 && ++back === 3) {
        const answer = await inner(args);
        h.main.chainId = 4663;
        return answer;
      }
      return inner(args);
    },
  };
  const out = await h.seq.startTransfer({ kind: "fund", amountEth: "0.01" });
  assert.equal(out.phase, "done", out.message);
  assert.equal(offChain, 0);
  assert.equal(h.trading.count("eth_getTransactionReceipt"), 0, "the trading wallet never sent it");
  assert.ok(h.main.count("eth_getTransactionReceipt") >= 1);
});

test("the base fee rising, or the balance falling, before the send refuses the old withdraw", async () => {
  const fee = transferHarness();
  fee.answer = () => { fee.c.baseFee *= 3n; return true; };
  let out = await fee.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "fee");
  assert.equal(out.refusal.step, 0);
  assert.match(out.message, /^Refused before anything was signed: .* Nothing was sent\.$/);
  assert.equal(fee.sends().length, 0);

  const fell = transferHarness();
  fell.answer = () => { fell.c.balances.set(lower(TRADING), fell.c.balance(TRADING) - 1n); return true; };
  out = await fell.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.refusal.rule, "reserve");
  assert.equal(fell.sends().length, 0);
});

test("nothing to withdraw: a balance the reserve would take is not sent, and one wei over it is", async () => {
  const reserve = 21_000n * 2n * BASE_FEE;
  for (const [balance, sent] of [[0n, null], [reserve, null], [reserve + 1n, 1n]]) {
    const h = transferHarness();
    h.c.balances.set(lower(TRADING), balance);
    const out = await h.seq.startTransfer({ kind: "withdraw" });
    if (sent === null) {
      assert.equal(out.phase, "failed", `${balance}: ${out.message}`);
      assert.match(out.message, /^There is nothing to withdraw/);
      assert.deepEqual(h.asked, [], "no confirmation for nothing");
      assert.equal(h.sends().length, 0);
    } else {
      assert.equal(out.phase, "done", out.message);
      assert.equal(BigInt(h.trading.sent[0].value), sent);
    }
  }
});

test("a transfer waits for both wallets, on Robinhood Chain, before anything is built", async () => {
  const cases = [
    ["no main wallet", "fund", (h) => { h.mainProvider = () => null; }, /^Connect the wallet to fund from first\.$/],
    ["no main wallet", "withdraw", (h) => { h.mainProvider = () => null; }, /^Connect your main wallet first\. Withdraw all goes only to it\.$/],
    ["a main wallet with no account", "withdraw", (h) => { h.main.account = null; }, /^Connect your main wallet first/],
    ["a main wallet with no account", "fund", (h) => { h.main.account = null; }, /^Connect the wallet to fund from first/],
    ["no trading wallet", "fund", (h) => { h.tradingProvider = () => null; }, /^Log in to your trading wallet first\.$/],
    ["a logged-out trading wallet", "withdraw", (h) => { h.trading.account = null; }, /^Log in to your trading wallet first\.$/],
    ["a main wallet on chain 1", "fund", (h) => { h.main.chainId = 1; }, /^Switch your main wallet to Robinhood Chain first\.$/],
    ["a main wallet on chain 1", "withdraw", (h) => { h.main.chainId = 1; }, /^Switch your main wallet to Robinhood Chain first\.$/],
    ["a trading wallet on chain 1", "withdraw", (h) => { h.trading.chainId = 1; }, /^Your trading wallet answered for chain 1/],
    ["a wallet read that fails", "withdraw", (h) => {
      h.trading.provider = { request: async () => { throw new Error("the RPC is down"); } };
    }, /^Could not read your wallets: the RPC is down$/],
  ];
  for (const [what, kind, arrange, message] of cases) {
    const h = transferHarness();
    arrange(h);
    const out = await h.seq.startTransfer(kind === "fund" ? { kind, amountEth: "0.01" } : { kind });
    assert.equal(out.phase, "failed", `${what} (${kind}): ${out.message}`);
    assert.match(out.message, message, `${what} (${kind})`);
    assert.equal(h.c.estimates.length, 0, `${what} (${kind}): nothing was estimated`);
    assert.equal(h.sends().length, 0);
    assert.ok(!h.seq.busy());
  }
});

test("a fund's amount is exact and positive, and a transfer is a fund or a withdraw", async () => {
  for (const [input, message] of [
    [{ kind: "fund", amountEth: "0" }, /^Enter an amount of ETH to fund\.$/],
    [{ kind: "fund", amountEth: "1e-3" }, /is not an amount of ETH/],
    [{ kind: "fund" }, /is not an amount of ETH/],
    [{ kind: "swap" }, /^A transfer is a fund or a withdraw\.$/],
    [null, /^A transfer is a fund or a withdraw\.$/],
  ]) {
    const h = transferHarness();
    const out = await h.seq.startTransfer(input);
    assert.equal(out.phase, "failed", JSON.stringify(input));
    assert.match(out.message, message);
    assert.equal(h.main.calls.length + h.trading.calls.length, 0);
  }
});

test("a gas estimate that fails, or answers junk, stops before anything is signed", async () => {
  for (const estimate of [
    Object.assign(new Error("insufficient funds for transfer"), { code: -32000 }), "21000", "0x", undefined,
  ]) {
    const h = transferHarness();
    h.c.estimate = () => estimate;
    const out = await h.seq.startTransfer({ kind: "fund", amountEth: "5" });
    assert.equal(out.phase, "failed", String(estimate));
    assert.match(out.message, /^Could not work out the gas for this transfer: /);
    assert.deepEqual(h.asked, []);
    assert.equal(h.sends().length, 0);
  }
});

test("a plan the page built that the verifier refuses is never confirmed or sent", async () => {
  // An estimate over the gas cap (a main wallet whose code runs wild).
  const gas = transferHarness();
  gas.c.estimate = 3_000_001n;
  let out = await gas.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "refused", out.message);
  assert.equal(out.refusal.rule, "gas");
  assert.equal(out.plan, null, "the refused plan's numbers stay out of the state");
  assert.deepEqual(gas.asked, []);
  assert.equal(gas.sends().length, 0);
  // The main wallet and the trading wallet giving the same address.
  const one = transferHarness();
  one.main.account = TRADING;
  out = await one.seq.startTransfer({ kind: "fund", amountEth: "0.01" });
  assert.equal(out.refusal.rule, "same-wallet");
  assert.equal(one.sends().length, 0);
});

test("declining the confirmation sends nothing", async () => {
  const h = transferHarness();
  h.answer = () => false;
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "cancelled");
  assert.equal(out.message, "Nothing was sent.");
  assert.equal(h.sends().length, 0);
});

test("transfer wallet errors are kept, in words, and can be resumed", async () => {
  const h = transferHarness();
  let rejected = false;
  h.main.onSend = () => (rejected ? {} : (rejected = true, { throw: Object.assign(new Error("User rejected"), { code: 4001 }) }));
  let out = await h.seq.startTransfer({ kind: "fund", amountEth: "0.01" });
  assert.equal(out.phase, "rejected");
  assert.equal(out.message, "You rejected the transfer.");
  assert.equal(out.steps[0].status, "waiting");
  out = await h.seq.resume();
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.main.sent.length, 1);

  const w = transferHarness();
  let failed = false;
  w.trading.onSend = () => (failed ? {} : (failed = true, { throw: Object.assign(new Error("boom"), { code: -32603 }) }));
  out = await w.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "error");
  assert.equal(out.message, "-32603: boom");
  out = await w.seq.resume();
  assert.equal(out.phase, "done", out.message);
  assert.equal(w.trading.sent.length, 1);
});

test("a reverted withdraw stops, and one never mined times out", async () => {
  const r = transferHarness();
  r.trading.onSend = () => ({ receipt: "revert" });
  let out = await r.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "reverted");
  assert.equal(out.message, "The withdrawal reverted. Nothing more will be sent.");
  assert.equal(r.transfers.length, 0);
  assert.equal((await r.seq.resume()).phase, "reverted");

  const t = transferHarness();
  t.trading.onSend = () => ({ receipt: "never" });
  out = await t.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "timeout");
  assert.ok(t.updates.includes("pending"));
  assert.equal(out.steps[0].status, "unknown");
  assert.equal(t.transfers.length, 0);
});

test("one at a time: a transfer and a trade share the tab", async () => {
  const h = transferHarness();
  let during;
  h.answer = async () => {
    during = {
      transfer: await h.seq.startTransfer({ kind: "fund", amountEth: "1" }),
      trade: await h.seq.start({ side: "buy", from: TRADING, token: ATTACKER, amountEth: "0.01", slippageBps: 500 }),
    };
    return true;
  };
  const out = await h.seq.startTransfer({ kind: "withdraw" });
  assert.equal(out.phase, "done", out.message);
  assert.equal(during.transfer.intent.kind, "withdraw", "the second transfer was not started");
  assert.equal(during.trade.intent.kind, "withdraw", "nor was the trade");
  assert.equal(h.c.estimates.length, 1);
  assert.deepEqual(h.prepared, []);
  assert.equal(h.acknowledged, 0);
  assert.equal(h.sends().length, 1);
  // Once it is over, the next can start.
  assert.equal((await h.seq.startTransfer({ kind: "fund", amountEth: "0.01" })).phase, "done");
});

// ====================================================================== //
// the trading wallet signs with no pop-up (W3.1)                         //
// ====================================================================== //

test("a silent signer's sends are worded as signing, and a browser wallet's still ask to confirm", async () => {
  for (const [silent, want, never] of [
    [true, /^Signing step 1 of 1…$/, /in your wallet/],
    [false, /^Confirm step 1 of 1 in your wallet\.$/, /^Signing/],
  ]) {
    const seen = [];
    const h = harness("curve buy", { silent: () => silent, update: (s) => seen.push([s.phase, s.message]) });
    const out = await h.seq.start(h.input());
    assert.equal(out.phase, "done", out.message);
    const signing = [...new Set(seen.filter(([p]) => p === "signing").map(([, m]) => m))];
    assert.equal(signing.length, 1);
    assert.match(signing[0], want);
    assert.ok(!seen.some(([, m]) => never.test(m)), `silent ${silent}: ${seen.map(([, m]) => m).join(" | ")}`);
  }
  // A plan of several steps counts them.
  const messages = [];
  const h = harness("v4 sell with both approvals", { silent: () => true, update: (s) => { if (s.phase === "signing") messages.push(s.message); } });
  assert.equal((await h.seq.start(h.input())).phase, "done");
  assert.deepEqual([...new Set(messages)], ["Signing step 1 of 3…", "Signing step 2 of 3…", "Signing step 3 of 3…"]);
});

test("a silent signer's refusal is its own sentence, and a browser wallet's is worded as before", async () => {
  const refusal = Object.assign(new Error("Log in to trade. Nothing was signed."), { code: 4100 });
  for (const [silent, want] of [[true, "Log in to trade. Nothing was signed."], [false, "This wallet cannot do that (eth_sendTransaction)."]]) {
    const h = harness("curve buy", { silent: () => silent });
    let failed = false;
    h.w.onSend = () => (failed ? {} : (failed = true, { throw: refusal }));
    let out = await h.seq.start(h.input());
    assert.equal(out.phase, "error");
    assert.equal(out.message, want);
    assert.equal(h.w.sends.length, 0);
    out = await h.seq.resume();
    assert.equal(out.phase, "done", out.message);
    assert.equal(h.w.sends.length, 1);
  }
  // A silent signer's error with no words of its own still gets F2's.
  const h = harness("curve buy", { silent: () => true });
  h.w.onSend = () => ({ throw: Object.assign(new Error(""), { code: -32603 }) });
  assert.equal((await h.seq.start(h.input())).message, "-32603: Error");
  // A user rejection is one whatever the signer.
  const r = harness("curve buy", { silent: () => true });
  r.w.onSend = () => ({ throw: Object.assign(new Error("User rejected"), { code: 4001 }) });
  const out = await r.seq.start(r.input());
  assert.equal(out.phase, "rejected");
  assert.equal(out.message, "You rejected step 1.");
});

test("a silent signer's refusal says nothing was signed, not that a wallet did not open", async () => {
  for (const [silent, want] of [[true, /^Refused before anything was signed: .*Nothing was sent\.$/], [false, /^Refused before your wallet opened: /]]) {
    const h = harness("curve buy", { silent: () => silent });
    const bad = fixture("curve buy").plan;
    bad.steps[0].data = recall(bad.steps[0].data, (a) => (a[2] = ATTACKER, a));
    h.plans = [bad];
    const out = await h.seq.start(h.input());
    assert.equal(out.phase, "refused");
    assert.match(out.message, want);
    assert.equal(h.w.sends.length, 0);
  }
});

/**
 * Every sleep between receipt polls, for a send that never mines, with the
 * page's own limits: 90 s to "still pending" and 10 minutes to give up.
 */
async function pollsFor(over, run) {
  const slept = [];
  let pendingAt = null;
  const h = harness("curve buy", {
    pollMs: 1000, receiptMs: 90_000, backgroundMs: 600_000,
    sleep: async (ms) => { slept.push(ms); await yieldNow(); },
    update: (s) => { if (s.phase === "pending" && pendingAt === null) pendingAt = slept.reduce((a, b) => a + b, 0); },
    ...over,
  });
  h.w.onSend = () => ({ receipt: "never" });
  const out = await (run ? run(h) : h.seq.start(h.input()));
  return { out, slept, pendingAt, total: slept.reduce((a, b) => a + b, 0) };
}

test("a silent signer's receipts are polled every 250 ms for 10 s, then every second, and the limits are unchanged", async () => {
  const fast = await pollsFor({ silent: () => true });
  assert.equal(fast.out.phase, "timeout");
  assert.deepEqual(fast.slept.slice(0, 40), Array(40).fill(250), "40 polls in the first 10 s");
  assert.ok(fast.slept.slice(40).every((ms) => ms === 1000), "then every second");
  assert.equal(fast.slept.length, 40 + 590);
  assert.equal(fast.pendingAt, 90_000, "still pending at 90 s");
  assert.equal(fast.total, 600_000, "given up at 10 minutes");
  assert.match(fast.out.message, /not mined within 10 minutes/);

  // A browser wallet's receipts, through its own RPC, stay at one a second.
  const slow = await pollsFor({ silent: () => false });
  assert.equal(slow.out.phase, "timeout");
  assert.ok(slow.slept.every((ms) => ms === 1000));
  assert.equal(slow.slept.length, 600);
  assert.equal(slow.pendingAt, 90_000);
  assert.equal(slow.total, 600_000);

  // Without the option, nothing changes.
  const none = await pollsFor({});
  assert.ok(none.slept.every((ms) => ms === 1000));
  assert.equal(none.slept.length, 600);

  // A receipt already there is not waited for at all.
  const at = await pollsFor({ silent: () => true }, (h) => { h.w.onSend = () => ({}); return h.seq.start(h.input()); });
  assert.equal(at.out.phase, "done");
  assert.deepEqual(at.slept, []);
});

test("a fund's receipt, looked for through the main wallet, is never polled fast; a withdraw's is", async () => {
  for (const [kind, first] of [["fund", 1000], ["withdraw", 250]]) {
    const slept = [];
    const h = transferHarness({
      silent: () => true, pollMs: 1000, receiptMs: 90_000, backgroundMs: 600_000,
      sleep: async (ms) => { slept.push(ms); await yieldNow(); },
    });
    (kind === "fund" ? h.main : h.trading).onSend = () => ({ receipt: "never" });
    const out = await h.seq.startTransfer(kind === "fund" ? { kind, amountEth: "0.01" } : { kind });
    assert.equal(out.phase, "timeout", `${kind}: ${out.message}`);
    assert.equal(slept[0], first, kind);
    assert.equal(slept.reduce((a, b) => a + b, 0), 600_000);
  }
});

test("a withdraw's error from the trading wallet is its own sentence; a fund's from the main wallet is F2's", async () => {
  const refusal = Object.assign(new Error("Too many transactions in a minute. Nothing was sent."), { code: -32005 });
  const w = transferHarness({ silent: () => true });
  w.trading.onSend = () => ({ throw: refusal });
  assert.equal((await w.seq.startTransfer({ kind: "withdraw" })).message, "Too many transactions in a minute. Nothing was sent.");
  const f = transferHarness({ silent: () => true });
  f.main.onSend = () => ({ throw: refusal });
  assert.equal((await f.seq.startTransfer({ kind: "fund", amountEth: "0.01" })).message,
    "-32005: Too many transactions in a minute. Nothing was sent.");
});

// ------------------------------------------------ one click, fast (2026-09-23) --

/** A clock the test moves: `ms` is read on every call. */
const clockAt = (start = 1_000_000) => { const c = { ms: start, now: () => c.ms }; return c; };

test("one click: the token's reads run alongside the prepare, and a fresh check is not taken again before the send", async () => {
  const clock = clockAt();
  // The server takes a while; the wallet's reads should already be under way when it answers.
  let readsWhenPlanArrived = -1;
  const h = harness("curve buy", {
    readQuote, freshMs: 2000, clock: clock.now,
    prepare: async () => {
      for (let i = 0; i < 20; i++) await yieldNow();
      readsWhenPlanArrived = h.w.log.filter((m) => m === "eth_call").length;
      return { status: 200, data: structuredClone(h.fx.plan) };
    },
  });
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.ok(readsWhenPlanArrived > 0, `the token was being read while the server prepared (${readsWhenPlanArrived})`);
  assert.equal(h.w.log.filter((m) => m === "eth_call").length, 5 + 1,
    "the identity's five calls once, and one quote: nothing was sent since the check");
  assert.equal(h.w.log.filter((m) => m === "eth_getBlockByNumber").length, 1,
    "the chain's time came from the check's own block");
});

test("one click: a check older than the window, or a pause on the sheet, is read again before the send", async () => {
  const clock = clockAt();
  const h = harness("curve buy", { readQuote, freshMs: 2000, clock: clock.now });
  // The visitor pauses on the sheet for three seconds.
  h.answer = () => { clock.ms += 3000; return true; };
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.log.filter((m) => m === "eth_call").length, 5 + 5 + 1, "read again: the check was stale");
});

test("between two steps the plan is always read again, however fast the first was mined", async () => {
  const clock = clockAt();
  const h = harness("curve sell with approval", { freshMs: 60_000, clock: clock.now });
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.w.sends.length, 2);
  // The token's reads between the approval's receipt and the swap's send.
  const between = h.w.log.slice(h.w.log.indexOf("receipt:0"), h.w.log.indexOf("sent:1"));
  assert.ok(between.filter((m) => m === "eth_call").length >= 5,
    `the identity was read again before the swap: ${between.join(" ")}`);
});

test("each trade logs one line of where its time went", async () => {
  const clock = clockAt();
  const h = harness("curve buy", { freshMs: 2000, clock: clock.now });
  const out = await h.seq.start(h.input());
  assert.equal(out.phase, "done", out.message);
  assert.equal(h.logs.length, 1, h.logs.join(" / "));
  assert.match(h.logs[0], /^\[trade\] buy: prepare \d+ ms · check \d+ ms · price \d+ ms · check \d+ ms · send 1 \d+ ms · mined 1 \d+ ms · total [\d.]+ s \(done\)$/);
});

