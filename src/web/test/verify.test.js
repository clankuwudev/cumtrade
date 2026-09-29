// The step verifier (public-release F3.1). Every plan B2.3 prepared passes it.
// Every way a compromised API could change one is refused, before any wallet
// opens, under the rule aimed at it.
//
// The plans and the fake chain they were prepared against come from
// `npm run test:prepare -- --fixtures`. Mutations are built with viem, an
// encoder independent of the one under test, and the fake provider only
// answers the reads the verifier is allowed to make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toHex } from "viem";
import { MAX_GAS, READ } from "../public/js/trade/constants.js";
import { readIdentity, readTransfer, verifyPlan, verifyTransfer } from "../public/js/trade/verify.js";
import { closeSwap, openSwap, recall, reswap } from "./support/calldata.js";

const { chain, plans } = JSON.parse(readFileSync(new URL("./fixtures/plans.json", import.meta.url), "utf8"));
const fixture = (name) => structuredClone(plans.find((p) => p.name === name));

const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const MAX_UINT256 = 2n ** 256n - 1n;
const lower = (a) => a.toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, "0");

// --------------------------------------------------------- fake provider --

/**
 * An EIP-1193 provider answering from the fixture's chain. It logs every
 * request, and anything outside the verifier's reads (a send included) throws.
 */
function provider({ now, over = {} }) {
  const log = [];
  const curves = Object.fromEntries(Object.entries(chain.tokens).map(([t, v]) => [lower(v.curve), { token: t, ...v }]));
  const factory = over.factory ?? chain.factory;
  const answer = ({ method, params }) => {
    if (method === "eth_chainId") return toHex(over.chainId ?? chain.chainId);
    if (method === "eth_getBlockByNumber") return { number: "0x1", timestamp: toHex(now) };
    if (method !== "eth_call") throw new Error(`the verifier may not call ${method}`);
    const { to, data } = params[0];
    const sel = data.slice(0, 10), at = lower(to);
    const tokenRow = chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === at)];
    if (sel === READ.curve && tokenRow) return `0x${word(tokenRow.curve)}`;
    if (curves[at]) {
      if (sel === READ.token) return `0x${word(over.curveToken ?? curves[at].token)}`;
      if (sel === READ.factory) return `0x${word(factory)}`;
      if (sel === READ.graduated) return `0x${word((over.graduated ?? curves[at].graduated) ? 1 : 0)}`;
    }
    if (at === lower(factory)) {
      if (sel === READ.memeHook) return `0x${word(over.memeHook ?? chain.memeHook)}`;
      if (sel === READ.getLaunchedToken) {
        const asked = `0x${data.slice(-40)}`;
        const row = chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === asked)];
        if (!row || over.unlisted) return `0x${word(0).repeat(15)}`;
        return `0x${word(asked)}${word(over.registryCurve ?? row.curve)}${word(ATTACKER).repeat(2)}${word(0).repeat(10)}${word(1)}`;
      }
    }
    throw new Error(`execution reverted: ${sel} on ${to}`);
  };
  return {
    log,
    request: async (req) => {
      log.push(req.method === "eth_call" ? `eth_call ${req.params[0].data.slice(0, 10)}` : req.method);
      return answer(req);
    },
  };
}

/** A fixture, its intent, and reads made through a fake provider as of `preparedAt`. */
async function setup(name, over = {}) {
  const { plan, intent } = fixture(name);
  const p = provider({ now: plan.preparedAt, over });
  const reads = await readIdentity(p.request, intent.token);
  return { plan, intent, reads, log: p.log };
}

// ----------------------------------------------------------------- passes --

test("the fixtures carry intents with slippage, and a chain to read from", () => {
  assert.equal(plans.length, 4);
  for (const { intent } of plans) assert.equal(intent.slippageBps, 500);
  assert.ok(chain.factory && chain.memeHook && Object.keys(chain.tokens).length === 2);
});

test("the test's own swap encoder reproduces the server's calldata exactly", () => {
  for (const name of ["v4 buy", "v4 sell with both approvals"]) {
    const { plan } = fixture(name);
    const swap = plan.steps.at(-1);
    assert.equal(closeSwap(openSwap(swap.data)), lower(swap.data));
  }
});

for (const { name } of plans) {
  test(`${name}: passes`, async () => {
    const { plan, intent, reads } = await setup(name);
    assert.deepEqual(verifyPlan(plan, intent, reads), { ok: true });
  });
}

test("the reads are exactly the listed calls, and never a send", async () => {
  const curve = await setup("curve buy");
  assert.deepEqual(curve.log.sort(), [
    "eth_call 0x3cf28b5a", "eth_call 0x7165485d", "eth_call 0xc45a0155",
    "eth_call 0xe7c2b772", "eth_call 0xfc0c546a", "eth_chainId", "eth_getBlockByNumber",
  ]);
  const bonded = await setup("v4 buy");
  assert.equal(bonded.log.filter((m) => m === `eth_call ${READ.memeHook}`).length, 1, "the hook is read once graduated");
  assert.equal(bonded.log.length, 8);
  for (const m of [...curve.log, ...bonded.log]) assert.ok(!m.includes("send"), m);
});

test("the reads carry the chain's time and the registry's answer", async () => {
  const { plan, reads } = await setup("v4 sell with both approvals");
  assert.equal(reads.now, plan.preparedAt);
  assert.equal(reads.chainId, 4663);
  assert.equal(reads.graduated, true);
  assert.equal(lower(reads.registry.curve), lower(chain.tokens[plan.token].curve));
  assert.equal(lower(reads.memeHook), lower(chain.memeHook));
});

test("the limits are inclusive: an hour's expiry, a 30-minute deadline and 3M gas pass", async () => {
  const sell = await setup("v4 sell with both approvals");
  sell.plan.steps[0].gas = toHex(3_000_000);
  sell.plan.steps[1].data = recall(sell.plan.steps[1].data, (a) => (a[3] = sell.reads.now + 3600, a));
  sell.plan.steps[2].data = reswap(sell.plan.steps[2].data, (s) => (s.deadline = BigInt(sell.reads.now + 1800)));
  assert.deepEqual(verifyPlan(sell.plan, sell.intent, sell.reads), { ok: true });
});

// ---------------------------------------------------------------- refusals --

/**
 * Each case changes one thing. `edit` gets the plan, the intent and the reads;
 * `over` changes what the fake chain answers. The refusal must name `rule`, at
 * step `step` (null for the plan as a whole).
 */
const refusals = [
  // --- the spec's list -----------------------------------------------------
  ["an unknown `to`", "curve buy", 0, "to", ({ plan }) => { plan.steps[0].to = ATTACKER; }],
  ["the wrong selector", "curve sell with approval", 1, "selector", ({ plan }) => {
    plan.steps[1].data = `0x59a87bc1${plan.steps[1].data.slice(10)}`;
  }],
  ["an approval to a spender not listed", "curve sell with approval", 0, "spender", ({ plan }) => {
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[0] = ATTACKER, a));
  }],
  ["an unlimited approval", "curve sell with approval", 0, "amount", ({ plan }) => {
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[1] = MAX_UINT256, a));
  }],
  ["an unlimited approval to Permit2", "v4 sell with both approvals", 0, "amount", ({ plan }) => {
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[1] = MAX_UINT256, a));
  }],
  ["ETH sent with a sell", "curve sell with approval", 1, "value", ({ plan }) => { plan.steps[1].value = "0x1"; }],
  ["ETH sent with an approval", "v4 sell with both approvals", 0, "value", ({ plan }) => { plan.steps[0].value = "0x1"; }],
  ["a buy paying out to someone else", "curve buy", 0, "recipient", ({ plan }) => {
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[2] = ATTACKER, a));
  }],
  ["a sell paying out to someone else", "curve sell with approval", 1, "recipient", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[2] = ATTACKER, a));
  }],
  ["a Permit2 expiry an hour and a second away", "v4 sell with both approvals", 1, "expiry", ({ plan, reads }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[3] = reads.now + 3601, a));
  }],
  ["a second router command", "v4 sell with both approvals", 2, "commands", ({ plan }) => {
    plan.steps[2].data = reswap(plan.steps[2].data, (s) => { s.commands = "0x1010"; s.moreInputs = ["0x"]; });
  }],
  ["a different router command", "v4 buy", 0, "commands", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.commands = "0x0b"; });
  }],
  ["reordered actions", "v4 buy", 0, "actions", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.actions = "0x0f0c06"; });
  }],
  ["the pool's hook is not the factory's", "v4 buy", 0, "hooks", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.key[4] = ATTACKER; });
  }],
  ["the direction flipped", "v4 buy", 0, "direction", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.zeroForOne = false; });
  }],
  ["a deadline too far away", "v4 buy", 0, "deadline", ({ plan, reads }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.deadline = BigInt(reads.now + 1801); });
  }],
  ["an amount other than the intent's", "curve buy", null, "amount", ({ intent }) => {
    intent.amountIn = (BigInt(intent.amountIn) + 1n).toString();
  }],
  ["a calldata amount other than the quote's", "curve sell with approval", 1, "amount", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[0] = a[0] - 1n, a));
  }],
  ["a swap amount other than the intent's", "v4 sell with both approvals", 2, "amount", ({ plan }) => {
    plan.steps[2].data = reswap(plan.steps[2].data, (s) => { s.amountIn += 1n; });
  }],
  ["a token other than the intent's", "curve buy", null, "token", ({ plan }) => { plan.token = ATTACKER; }],
  ["chainId 1 in the plan", "curve buy", null, "chain", ({ plan }) => { plan.chainId = 1; }],
  ["a wallet on chain 1", "v4 buy", null, "chain", () => {}, { chainId: 1 }],
  ["calldata truncated mid-argument", "v4 sell with both approvals", 2, "calldata", ({ plan }) => {
    plan.steps[2].data = plan.steps[2].data.slice(0, 2 + 2 * 300);
  }],
  ["an offset pointing past the end", "v4 buy", 0, "calldata", ({ plan }) => {
    const d = plan.steps[0].data;
    plan.steps[0].data = `${d.slice(0, 10)}${word(0xffff)}${d.slice(74)}`;
  }],

  // --- added before building ----------------------------------------------
  ["a signed minimum under the quoted one", "curve sell with approval", 1, "min-out", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[1] = 1n, a));
  }],
  ["a router minimum under the quoted one", "v4 buy", 0, "min-out", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.minOut = 1n; });
  }],
  ["a quote whose minimum is not the slippage under its expected output", "curve buy", null, "min-out", ({ plan }) => {
    plan.quote.minOut = "1";
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[1] = 1n, a));
  }],
  ["a quote that accepts nothing", "curve buy", null, "min-out", ({ plan }) => { plan.quote.minOut = "0"; }],
  ["slippage other than the visitor's", "curve buy", null, "slippage", ({ intent }) => { intent.slippageBps = 300; }],
  ["a capped sell smaller than asked", "curve sell with approval", null, "amount", ({ intent }) => {
    intent.tokens = (BigInt(intent.tokens) * 2n).toString();
  }],
  ["settling more than the amount", "v4 sell with both approvals", 2, "settle", ({ plan }) => {
    plan.steps[2].data = reswap(plan.steps[2].data, (s) => { s.settle[1] += 1n; });
  }],
  ["taking a different currency", "v4 buy", 0, "take", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.take[0] = ATTACKER; });
  }],
  ["data passed to the hook", "v4 buy", 0, "hook-data", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.hookData = "0x01"; });
  }],
  ["a pool for another token", "v4 sell with both approvals", 2, "pool", ({ plan }) => {
    plan.steps[2].data = reswap(plan.steps[2].data, (s) => { s.key[1] = ATTACKER; });
  }],
  ["a fourth action", "v4 buy", 0, "actions", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.actions = "0x060c0f0f"; s.moreParams = [s.moreParams[0] ?? "0x"]; });
  }],
  ["trailing bytes after a curve call", "curve buy", 0, "calldata", ({ plan }) => { plan.steps[0].data += "00"; }],
  ["trailing bytes after a router call", "v4 buy", 0, "calldata", ({ plan }) => {
    plan.steps[0].data += "00".repeat(32);
  }],
  ["dirty high bits in an address", "curve buy", 0, "calldata", ({ plan }) => {
    const d = plan.steps[0].data;
    plan.steps[0].data = `${d.slice(0, 10 + 128)}ff${d.slice(10 + 130)}`;
  }],
  ["dynamic data in a non-canonical order", "v4 buy", 0, "calldata", ({ plan }) => {
    // The same commands, inputs and deadline, with the two tails swapped and
    // the offsets fixed up. Every value decodes the same; the layout is not
    // the one encoding produces.
    const args = plan.steps[0].data.slice(10);
    const cmdAt = Number(BigInt(`0x${args.slice(0, 64)}`)), inAt = Number(BigInt(`0x${args.slice(64, 128)}`));
    const commands = args.slice(cmdAt * 2, inAt * 2), inputs = args.slice(inAt * 2);
    plan.steps[0].data = `0x3593564c${word(96 + inputs.length / 2)}${word(96)}${args.slice(128, 192)}${inputs}${commands}`;
  }],
  ["a step id that does not match its kind", "curve sell with approval", 0, "step", ({ plan }) => { plan.steps[0].id = "swap"; }],
  ["an approval before a buy", "curve buy", null, "sequence", ({ plan }) => {
    plan.steps.unshift({ ...fixture("curve sell with approval").plan.steps[0] });
  }],
  ["a sell with no swap", "v4 sell with both approvals", null, "sequence", ({ plan }) => { plan.steps.pop(); }],
  ["a Permit2 approval on a curve sell", "curve sell with approval", null, "sequence", ({ plan }) => {
    plan.steps.splice(1, 0, fixture("v4 sell with both approvals").plan.steps[1]);
  }],
  ["a gas limit over the cap", "curve buy", 0, "gas", ({ plan }) => { plan.steps[0].gas = toHex(3_000_001); }],
  ["no gas", "curve buy", 0, "gas", ({ plan }) => { plan.steps[0].gas = "0x0"; }],
  ["a value that is not a canonical quantity", "curve buy", 0, "value", ({ plan }) => {
    plan.steps[0].value = `0x00${plan.steps[0].value.slice(2)}`;
  }],
  ["a curve plan for a graduated token", "curve buy", null, "venue", () => {}, { graduated: true }],
  ["a V4 plan for a token still on its curve", "v4 buy", null, "venue", () => {}, { graduated: false }],
  ["a registry that lists another curve", "curve buy", null, "identity", () => {}, { registryCurve: ATTACKER }],
  ["a token the registry never listed", "v4 sell with both approvals", null, "identity", () => {}, { unlisted: true }],
  ["a curve that names another token", "curve buy", null, "identity", () => {}, { curveToken: ATTACKER }],
  ["a curve that names another factory", "curve buy", null, "identity", () => {}, { factory: ATTACKER }],
  ["a plan for another wallet", "curve buy", null, "from", ({ plan }) => { plan.from = ATTACKER; }],
  ["a sell plan for a buy", "curve buy", null, "side", ({ plan }) => { plan.side = "sell"; }],
  ["no plan at all", "curve buy", null, "plan", ({ plan }) => { delete plan.steps; }],

  // --- one case per check, so none can be switched off unnoticed ----------
  ["a trade that is neither buy nor sell", "curve buy", null, "intent", ({ intent }) => {
    // With an amount under both names, so only the side check can catch it.
    intent.side = "short";
    intent.tokens = intent.amountIn;
  }],
  ["an intent wallet that is not an address", "curve buy", null, "intent", ({ intent }) => { intent.from = "0x1234"; }],
  ["an intent for nothing", "curve buy", null, "intent", ({ intent }) => { intent.amountIn = "0"; }],
  ["an intent amount that is not a decimal string", "curve buy", null, "intent", ({ intent }) => {
    intent.amountIn = Number(intent.amountIn);
  }],
  ["a quoted amount with padding BigInt would forgive", "curve buy", null, "amount", ({ plan }) => {
    plan.quote.amountIn = ` ${plan.quote.amountIn}`;
  }],
  ["slippage outside what the server allows", "curve buy", null, "intent", ({ intent }) => { intent.slippageBps = 500.5; }],
  ["reads with no time", "curve buy", null, "reads", ({ reads }) => { delete reads.now; }],
  ["reads naming an unlisted factory beside a registry entry", "curve buy", null, "identity", ({ reads }) => {
    reads.curveFactory = ATTACKER;
  }],
  ["V4 reads without the hook", "v4 buy", null, "reads", ({ reads }) => { reads.memeHook = null; }],
  ["a plan expecting and accepting nothing", "curve buy", null, "min-out", ({ plan }) => {
    plan.quote.expectedOut = "0";
    plan.quote.minOut = "0";
    plan.steps[0].data = recall(plan.steps[0].data, (a) => (a[1] = 0n, a));
  }],
  ["an approval sent somewhere other than the token", "curve sell with approval", 0, "to", ({ plan }) => {
    plan.steps[0].to = ATTACKER;
  }],
  ["an approval that calls something else", "curve sell with approval", 0, "selector", ({ plan }) => {
    plan.steps[0].data = `0xa9059cbb${plan.steps[0].data.slice(10)}`;
  }],
  ["trailing bytes after an approval", "curve sell with approval", 0, "calldata", ({ plan }) => { plan.steps[0].data += "00"; }],
  ["a Permit2 step sent somewhere other than Permit2", "v4 sell with both approvals", 1, "to", ({ plan }) => {
    plan.steps[1].to = ATTACKER;
  }],
  ["a Permit2 step that calls something else", "v4 sell with both approvals", 1, "selector", ({ plan }) => {
    plan.steps[1].data = `0x095ea7b3${plan.steps[1].data.slice(10)}`;
  }],
  ["trailing bytes after a Permit2 approval", "v4 sell with both approvals", 1, "calldata", ({ plan }) => {
    plan.steps[1].data += "00";
  }],
  ["a Permit2 approval for another token", "v4 sell with both approvals", 1, "token", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[0] = ATTACKER, a));
  }],
  ["a Permit2 approval for another spender", "v4 sell with both approvals", 1, "spender", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[1] = ATTACKER, a));
  }],
  ["a Permit2 approval for more than the sell", "v4 sell with both approvals", 1, "amount", ({ plan }) => {
    plan.steps[1].data = recall(plan.steps[1].data, (a) => (a[2] = (1n << 160n) - 1n, a));
  }],
  ["a swap sent somewhere other than the router", "v4 buy", 0, "to", ({ plan }) => { plan.steps[0].to = ATTACKER; }],
  ["a swap that calls something else", "v4 buy", 0, "selector", ({ plan }) => {
    plan.steps[0].data = `0x24856bc3${plan.steps[0].data.slice(10)}`;
  }],
  ["trailing bytes inside the V4 input", "v4 buy", 0, "calldata", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.pad = { input: "00".repeat(32) }; });
  }],
  ["trailing bytes inside the swap parameters", "v4 sell with both approvals", 2, "calldata", ({ plan }) => {
    plan.steps[2].data = reswap(plan.steps[2].data, (s) => { s.pad = { swap: "00".repeat(32) }; });
  }],
  ["trailing bytes inside the settle parameters", "v4 buy", 0, "calldata", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.pad = { settle: "00".repeat(32) }; });
  }],
  ["a tick spacing that is not sign-extended", "v4 buy", 0, "calldata", ({ plan }) => {
    // tickSpacing is the fourth word of the pool key, inside the swap
    // parameters. Rewrite that one word in place, as an unsigned 24-bit -200.
    const s = openSwap(plan.steps[0].data);
    s.key[3] = -200;
    const data = closeSwap(s);
    const clean = word(BigInt.asUintN(256, -200n)), dirty = word(BigInt.asUintN(24, -200n));
    assert.equal(data.split(clean).length, 2, "the tick spacing word is unique");
    plan.steps[0].data = data.replace(clean, dirty);
  }],
  ["trailing bytes inside the take parameters", "v4 buy", 0, "calldata", ({ plan }) => {
    plan.steps[0].data = reswap(plan.steps[0].data, (s) => { s.pad = { take: "00".repeat(32) }; });
  }],
];

for (const [what, name, step, rule, edit, over] of refusals) {
  test(`refuses ${what}`, async () => {
    const ctx = await setup(name, over);
    edit(ctx);
    const out = verifyPlan(ctx.plan, ctx.intent, ctx.reads);
    assert.equal(out.ok, false, `passed: ${what}`);
    assert.equal(out.rule, rule, `${what}: ${out.reason}`);
    assert.equal(out.step, step, `${what}: ${out.reason}`);
    assert.ok(out.reason.length > 0);
  });
}

test("every truncation of every step is refused, and none throws", async () => {
  let cuts = 0, expected = 0;
  for (const { name } of plans) {
    const base = await setup(name);
    base.plan.steps.forEach((s, i) => {
      expected += (s.data.length - 2) / 2;
      for (let len = 2; len < s.data.length; len += 2) {
        const plan = structuredClone(base.plan);
        plan.steps[i].data = s.data.slice(0, len);
        const out = verifyPlan(plan, base.intent, base.reads);
        assert.equal(out.ok, false, `${name} step ${i} cut to ${(len - 2) / 2} bytes passed`);
        assert.equal(out.step, i);
        assert.ok(["calldata", "selector"].includes(out.rule), `${name} step ${i} at ${len}: ${out.rule} ${out.reason}`);
        cuts++;
      }
    });
  }
  assert.equal(cuts, expected, "one cut per byte of calldata");
});

test("garbage in every field is refused, never thrown", async () => {
  const junk = [undefined, null, 0, "", "0x", "0xzz", {}, [], "0x" + "00".repeat(4)];
  for (const { name } of plans) {
    const base = await setup(name);
    for (const field of ["to", "data", "value", "gas", "kind", "id"]) {
      for (const j of junk) {
        const plan = structuredClone(base.plan);
        plan.steps[0][field] = j;
        const out = verifyPlan(plan, base.intent, base.reads);
        assert.equal(out.ok, false, `${name} ${field}=${JSON.stringify(j)} passed`);
        assert.notEqual(out.rule, "internal", `${name} ${field}=${JSON.stringify(j)}: ${out.reason}`);
      }
    }
    for (const j of junk) {
      assert.equal(verifyPlan(base.plan, j, base.reads).ok, false);
      assert.equal(verifyPlan(j, base.intent, base.reads).ok, false);
      assert.equal(verifyPlan(base.plan, base.intent, j).ok, false);
    }
  }
});

// ====================================================================== //
// transfers between the visitor's two wallets (W2.1)                     //
// ====================================================================== //
// A fund goes from the main wallet to the trading wallet's own address, for
// exactly the typed wei. A withdraw goes from the trading wallet to the main
// wallet's own address, for its balance less its gas. The addresses are the
// wallets' own answers; nothing typed, stored or served can stand in for them.

const MAIN = "0x00000000000000000000000000000000000A11cE";
const TRADING = "0x0000000000000000000000000000000000007Ead";
/** An address the page might have kept in storage, or our server might offer. */
const STORED = "0x000000000000000000000000000000000000B0b0";
const BASE_FEE = 50_080_000n; // the live base fee, read 2026-09-22
const GAS = 21_000n; // the live estimate for a plain transfer, the same day
const FUND_WEI = 5n * 10n ** 16n;
const BALANCE = 10n ** 18n;

/**
 * The two wallets, answering only the reads a transfer may make. Each call is
 * logged with the wallet it went to, and anything else (a send included)
 * throws.
 */
function wallets(over = {}) {
  const o = { mainChain: 4663, tradingChain: 4663, main: MAIN, trading: TRADING, balance: BALANCE, baseFee: BASE_FEE, ...over };
  const log = [];
  const wallet = (who, answer) => async (req) => {
    log.push(`${who} ${req.method}`);
    return answer(req);
  };
  return {
    log,
    main: wallet("main", ({ method }) => {
      if (method === "eth_chainId") return toHex(o.mainChain);
      if (method === "eth_accounts") return o.main ? [o.main] : [];
      throw new Error(`a transfer may not ask the main wallet for ${method}`);
    }),
    trading: wallet("trading", ({ method, params }) => {
      if (method === "eth_chainId") return toHex(o.tradingChain);
      if (method === "eth_accounts") return o.trading ? [o.trading] : [];
      if (method === "eth_getBlockByNumber") {
        return { number: "0x1", timestamp: "0x6a9c1d00", ...(o.noBaseFee ? {} : { baseFeePerGas: toHex(o.baseFee) }) };
      }
      if (method === "eth_getBalance") {
        assert.equal(params[0], o.trading, "the balance read is the trading wallet's own");
        assert.equal(params[1], "latest");
        return toHex(o.balance);
      }
      throw new Error(`a transfer may not ask the trading wallet for ${method}`);
    }),
  };
}

/**
 * A fund of 0.05 ETH as the page builds it, and its intent, when the wallets
 * answer as `wallets()` does; then the wallets' reads as `over` has them now.
 */
async function fundCase(over) {
  const w = wallets(over);
  const reads = await readTransfer("fund", w.main, w.trading);
  const intent = { kind: "fund", from: MAIN, to: TRADING, amountEth: "0.05", amountWei: FUND_WEI.toString() };
  const plan = {
    kind: "fund", chainId: 4663, from: MAIN,
    steps: [{ id: "transfer", kind: "fund", label: "Fund your trading wallet", to: TRADING, data: "0x", value: toHex(FUND_WEI), gas: toHex(GAS) }],
  };
  return { plan, intent, reads, log: w.log };
}

/**
 * Withdraw all as the page builds it from a balance of 1 ETH at the live base
 * fee: the balance, less the gas at twice the base fee. Then the reads as
 * `over` has them now.
 */
async function withdrawCase(over) {
  const w = wallets(over);
  const reads = await readTransfer("withdraw", w.main, w.trading);
  const fee = 2n * BASE_FEE;
  const intent = { kind: "withdraw", from: TRADING, to: MAIN };
  const plan = {
    kind: "withdraw", chainId: 4663, from: TRADING,
    steps: [{
      id: "transfer", kind: "withdraw", label: "Withdraw to your main wallet", to: MAIN, data: "0x",
      value: toHex(BALANCE - GAS * fee), gas: toHex(GAS), maxFeePerGas: toHex(fee),
    }],
  };
  return { plan, intent, reads, log: w.log };
}
const CASES = { fund: fundCase, withdraw: withdrawCase };

test("transfers: a fund and a withdraw, as the page builds them, pass", async () => {
  for (const make of [fundCase, withdrawCase]) {
    const { plan, intent, reads } = await make();
    assert.deepEqual(verifyTransfer(plan, intent, reads), { ok: true }, plan.kind);
  }
});

test("transfers: the reads are exactly the listed calls, each through the wallet that knows, and never a send", async () => {
  const fund = await fundCase();
  assert.deepEqual(fund.log.sort(), ["main eth_accounts", "main eth_chainId", "trading eth_accounts"]);
  assert.deepEqual(fund.reads, {
    kind: "fund", main: { chainId: 4663, account: MAIN }, trading: { chainId: null, account: TRADING }, balance: null, baseFee: null,
  });
  const out = await withdrawCase();
  assert.deepEqual(out.log.sort(), [
    "main eth_accounts", "main eth_chainId",
    "trading eth_accounts", "trading eth_chainId", "trading eth_getBalance", "trading eth_getBlockByNumber",
  ]);
  assert.deepEqual(out.reads, {
    kind: "withdraw", main: { chainId: 4663, account: MAIN }, trading: { chainId: 4663, account: TRADING },
    balance: 10n ** 18n, baseFee: BASE_FEE,
  });
});

test("transfers: a wallet with no account reads as null; a read that fails or answers junk throws", async () => {
  const out = await withdrawCase({ trading: null });
  assert.equal(out.reads.trading.account, null);
  assert.equal(out.reads.balance, null, "no balance is read for no account");
  assert.ok(!out.log.includes("trading eth_getBalance"));
  assert.equal((await fundCase({ main: null })).reads.main.account, null);
  assert.equal((await fundCase({ main: "0x1234" })).reads.main.account, null, "an account that is not an address is none");

  const w = wallets();
  const failing = async () => { throw new Error("the RPC is down"); };
  await assert.rejects(readTransfer("withdraw", w.main, failing), /the RPC is down/);
  await assert.rejects(readTransfer("fund", failing, w.trading), /the RPC is down/);
  await assert.rejects(readTransfer("swap", w.main, w.trading), /"swap" is not a transfer/);
  const junk = wallets({ mainChain: "0x" });
  await assert.rejects(readTransfer("fund", async (r) => (r.method === "eth_chainId" ? "4663" : junk.main(r)), w.trading),
    /eth_chainId is not a hex quantity/);
  await assert.rejects(readTransfer("withdraw", w.main, wallets({ noBaseFee: true }).trading), /base fee/);
  await assert.rejects(readTransfer("withdraw", w.main, async (r) => (r.method === "eth_getBalance" ? "1e18" : w.trading(r))),
    /balance is not a hex quantity/);
});

test("transfers: the limits are inclusive: the whole balance less the reserve, twice the base fee, and MAX_GAS pass", async () => {
  const at = await withdrawCase();
  const s = at.plan.steps[0];
  // Exactly the balance less gas × fee: nothing over, nothing kept back beyond the reserve.
  assert.equal(BigInt(s.value) + BigInt(s.gas) * BigInt(s.maxFeePerGas), at.reads.balance);
  // A higher gas limit and fee cap still pass while the reserve still fits.
  const big = await withdrawCase();
  const b = big.plan.steps[0];
  b.gas = toHex(MAX_GAS);
  b.maxFeePerGas = toHex(3n * BASE_FEE);
  b.value = toHex(big.reads.balance - BigInt(MAX_GAS) * 3n * BASE_FEE);
  assert.deepEqual(verifyTransfer(big.plan, big.intent, big.reads), { ok: true });
  const fund = await fundCase();
  fund.plan.steps[0].gas = toHex(MAX_GAS);
  assert.deepEqual(verifyTransfer(fund.plan, fund.intent, fund.reads), { ok: true });
});

/**
 * Each case changes one thing, as in the trade table above. `kind` picks the
 * base case; `over` changes what the wallets answer.
 */
const transferRefusals = [
  // --- the spec's list -----------------------------------------------------
  ["a withdraw to another destination", "withdraw", 0, "to", ({ plan }) => { plan.steps[0].to = ATTACKER; }],
  ["a withdraw to another destination the visitor was shown", "withdraw", 0, "to", ({ plan, intent }) => {
    plan.steps[0].to = ATTACKER;
    intent.to = ATTACKER;
  }],
  ["a withdraw to a destination from storage or the API", "withdraw", 0, "to", ({ plan, intent }) => {
    // Built consistently from a remembered address, while the main wallet
    // says something else now.
    plan.steps[0].to = STORED;
    intent.to = STORED;
  }],
  ["a withdraw whose destination is the wallet's, but not the one the visitor was shown", "withdraw", 0, "to", ({ intent }) => {
    intent.to = STORED;
  }],
  ["a fund to a trading address from storage or the API", "fund", 0, "to", ({ plan, intent }) => {
    plan.steps[0].to = STORED;
    intent.to = STORED;
  }],
  ["a fund to someone else", "fund", 0, "to", ({ plan }) => { plan.steps[0].to = ATTACKER; }],
  ["a fund back to the main wallet itself", "fund", 0, "to", ({ plan }) => { plan.steps[0].to = MAIN; }],
  ["a fund while the trading wallet is logged out", "fund", 0, "to", () => {}, { trading: null }],
  ["a fund to a trading wallet that has changed account", "fund", 0, "to", () => {}, { trading: STORED }],
  ["a fund one wei over the typed amount", "fund", 0, "value", ({ plan }) => { plan.steps[0].value = toHex(FUND_WEI + 1n); }],
  ["a fund one wei under the typed amount", "fund", 0, "value", ({ plan }) => { plan.steps[0].value = toHex(FUND_WEI - 1n); }],
  ["a withdraw one wei over the balance less its gas", "withdraw", 0, "reserve", ({ plan }) => {
    plan.steps[0].value = toHex(BigInt(plan.steps[0].value) + 1n);
  }],
  ["a withdraw of the whole balance", "withdraw", 0, "reserve", ({ plan, reads }) => { plan.steps[0].value = toHex(reads.balance); }],
  ["a withdraw with a higher gas limit and no less value", "withdraw", 0, "reserve", ({ plan }) => {
    plan.steps[0].gas = toHex(GAS + 1n);
  }],
  ["a withdraw from a balance that has fallen", "withdraw", 0, "reserve", () => {}, { balance: BALANCE - 1n }],
  ["a fund carrying a call", "fund", 0, "data", ({ plan }) => { plan.steps[0].data = "0x00"; }],
  ["a withdraw carrying an ERC20 transfer", "withdraw", 0, "data", ({ plan }) => {
    plan.steps[0].data = `0xa9059cbb${word(ATTACKER)}${word(1)}`;
  }],
  ["a withdraw with empty data spelled another way", "withdraw", 0, "data", ({ plan }) => { plan.steps[0].data = ""; }],

  // --- one case per check, so none can be switched off unnoticed ----------
  ["no plan at all", "fund", null, "plan", ({ plan }) => { delete plan.steps; }],
  ["a transfer that is neither a fund nor a withdraw", "fund", null, "intent", ({ intent }) => { intent.kind = "swap"; }],
  ["an intent with a destination that is not an address", "withdraw", null, "intent", ({ intent }) => { intent.to = "0x1234"; }],
  ["an intent with a sender that is not an address", "fund", null, "intent", ({ intent }) => { intent.from = undefined; }],
  ["a fund of nothing", "fund", null, "intent", ({ intent }) => { intent.amountWei = "0"; }],
  ["a fund amount that is not a decimal string", "fund", null, "intent", ({ intent }) => { intent.amountWei = Number(FUND_WEI); }],
  ["no reads", "fund", null, "reads", ({ ctx }) => { ctx.reads = null; }],
  ["a withdraw with no balance read", "withdraw", null, "reads", ({ reads }) => { reads.balance = null; }],
  ["a withdraw with no base fee read", "withdraw", null, "reads", ({ reads }) => { reads.baseFee = Number(BASE_FEE); }],
  ["a withdraw plan for a fund", "fund", null, "kind", ({ plan }) => { plan.kind = "withdraw"; }],
  ["a plan for chain 1", "withdraw", null, "chain", ({ plan }) => { plan.chainId = 1; }],
  ["a fund from a main wallet on chain 1", "fund", null, "chain", () => {}, { mainChain: 1 }],
  ["a withdraw from a trading wallet on chain 1", "withdraw", null, "chain", () => {}, { tradingChain: 1 }],
  ["a withdraw to a main wallet on chain 1", "withdraw", null, "chain", () => {}, { mainChain: 1 }],
  ["a fund from someone else's wallet", "fund", null, "from", ({ plan }) => { plan.from = ATTACKER; }],
  ["a withdraw from the main wallet", "withdraw", null, "from", ({ plan }) => { plan.from = MAIN; }],
  ["a withdraw from a trading wallet that has changed account", "withdraw", null, "from", () => {}, { trading: STORED }],
  ["a fund from the main wallet it reads now, not the one it was pressed from", "fund", null, "from", ({ intent }) => {
    intent.from = STORED;
  }],
  ["a main wallet and a trading wallet that are the same address", "fund", null, "same-wallet", ({ plan, intent }) => {
    plan.from = TRADING;
    intent.from = TRADING;
  }, { main: TRADING }],
  ["two steps", "withdraw", null, "sequence", ({ plan }) => { plan.steps.push(structuredClone(plan.steps[0])); }],
  ["no steps", "fund", null, "sequence", ({ plan }) => { plan.steps = []; }],
  ["a withdraw step in a fund", "fund", null, "sequence", ({ plan }) => { plan.steps[0].kind = "withdraw"; }],
  ["a step that is not a transfer", "fund", 0, "step", ({ plan }) => { plan.steps[0].id = "swap"; }],
  ["no gas", "fund", 0, "gas", ({ plan }) => { plan.steps[0].gas = "0x0"; }],
  ["a gas limit over the cap", "fund", 0, "gas", ({ plan }) => { plan.steps[0].gas = toHex(MAX_GAS + 1); }],
  ["a gas limit that is not a canonical quantity", "withdraw", 0, "gas", ({ plan }) => { plan.steps[0].gas = "0x05208"; }],
  ["a value that is not a canonical quantity", "fund", 0, "value", ({ plan }) => {
    plan.steps[0].value = `0x0${plan.steps[0].value.slice(2)}`;
  }],
  ["a withdraw of nothing", "withdraw", 0, "value", ({ plan }) => { plan.steps[0].value = "0x0"; }],
  ["a withdraw with no fee cap", "withdraw", 0, "fee", ({ plan }) => { delete plan.steps[0].maxFeePerGas; }],
  ["a withdraw whose fee cap is one wei under twice the base fee", "withdraw", 0, "fee", ({ plan }) => {
    // With the value it would then allow, so only the fee rule can catch it.
    plan.steps[0].maxFeePerGas = toHex(2n * BASE_FEE - 1n);
  }],
  ["a withdraw after the base fee rose", "withdraw", 0, "fee", () => {}, { baseFee: 2n * BASE_FEE }],
];

for (const [what, kind, step, rule, edit, over] of transferRefusals) {
  test(`transfers: refuses ${what}`, async () => {
    const ctx = await CASES[kind](over);
    edit({ ...ctx, ctx });
    const out = verifyTransfer(ctx.plan, ctx.intent, ctx.reads);
    assert.equal(out.ok, false, `passed: ${what}`);
    assert.equal(out.rule, rule, `${what}: ${out.reason}`);
    assert.equal(out.step, step, `${what}: ${out.reason}`);
    assert.ok(out.reason.length > 0);
  });
}

test("transfers: garbage in every field is refused, never thrown", async () => {
  const junk = [undefined, null, 0, "", "0x", "0xzz", {}, [], "0x" + "00".repeat(4)];
  for (const make of [fundCase, withdrawCase]) {
    const base = await make();
    for (const field of ["to", "data", "value", "gas", "kind", "id", "maxFeePerGas"]) {
      for (const j of junk) {
        if (field === "data" && j === "0x") continue; // the one right answer
        if (field === "maxFeePerGas" && base.plan.kind === "fund") continue; // a fund carries none; the main wallet sets its fee
        const plan = structuredClone(base.plan);
        plan.steps[0][field] = j;
        const out = verifyTransfer(plan, base.intent, base.reads);
        assert.equal(out.ok, false, `${plan.kind} ${field}=${JSON.stringify(j)} passed`);
        assert.notEqual(out.rule, "internal", `${plan.kind} ${field}=${JSON.stringify(j)}: ${out.reason}`);
      }
    }
    for (const j of junk) {
      for (const out of [
        verifyTransfer(base.plan, j, base.reads), verifyTransfer(j, base.intent, base.reads), verifyTransfer(base.plan, base.intent, j),
        verifyTransfer(base.plan, base.intent, { ...base.reads, main: j }), verifyTransfer({ ...base.plan, steps: [j] }, base.intent, base.reads),
      ]) {
        assert.equal(out.ok, false);
        assert.notEqual(out.rule, "internal", out.reason);
      }
    }
  }
});

test("transfers: a trade plan is not a transfer, and a transfer plan is not a trade", async () => {
  const { plan, intent, reads } = await setup("curve buy");
  const fund = await fundCase();
  assert.equal(verifyTransfer(plan, fund.intent, fund.reads).ok, false);
  assert.equal(verifyPlan(fund.plan, intent, reads).ok, false);
});
