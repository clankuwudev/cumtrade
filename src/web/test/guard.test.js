// The signer's trade check (P4 T2): trade/guard.js, against the same fixture
// chain as sequence.test.js and embedded.test.js. Every step of every fixture
// plan passes; P2e's attacks, and anything else that isn't a cumTrade trade,
// are refused. Nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERMIT2, READ, SEL, UNIVERSAL_ROUTER } from "../public/js/trade/constants.js";
import { Refused, checkTrade } from "../public/js/trade/guard.js";
import { word } from "./support/calldata.js";

const { chain, plans } = JSON.parse(readFileSync(new URL("./fixtures/plans.json", import.meta.url), "utf8"));
const lower = (a) => String(a).toLowerCase();
const NOW = plans[0].plan.preparedAt;
const SIGNER = plans[0].intent.from;
const LOGIN = "0x000000000000000000000000000000000000B0b0";
const ATTACKER = "0x" + "a1".repeat(20);
const CURVE_TOKEN = Object.keys(chain.tokens).find((t) => !chain.tokens[t].graduated);
const V4_TOKEN = Object.keys(chain.tokens).find((t) => chain.tokens[t].graduated);
const CURVE = chain.tokens[CURVE_TOKEN].curve;

/** The chain's RPC for the identity reads only, and a count of what it was asked. */
function rpc() {
  const tokenRow = (a) => chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === lower(a))];
  const curveRow = (a) => Object.entries(chain.tokens).find(([, v]) => lower(v.curve) === lower(a));
  const r = { calls: 0 };
  r.request = async ({ method, params }) => {
    r.calls++;
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBlockByNumber") return { timestamp: `0x${NOW.toString(16)}` };
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const { to, data } = params[0];
    const sel = data.slice(0, 10);
    const t = tokenRow(to), c = curveRow(to);
    if (t && sel === READ.curve) return `0x${word(t.curve)}`;
    if (c && sel === READ.token) return `0x${word(c[0])}`;
    if (c && sel === READ.factory) return `0x${word(chain.factory)}`;
    if (c && sel === READ.graduated) return `0x${word(c[1].graduated ? 1 : 0)}`;
    if (lower(to) === lower(chain.factory) && sel === READ.memeHook) return `0x${word(chain.memeHook)}`;
    if (lower(to) === lower(chain.factory) && sel === READ.getLaunchedToken) {
      const tok = `0x${data.slice(-40)}`, row = tokenRow(tok);
      return row ? `0x${word(tok)}${word(row.curve)}${word(0).repeat(13)}` : `0x${word(0).repeat(15)}`;
    }
    // Anything else, an EOA or an unknown contract, answers nothing.
    return "0x";
  };
  return r;
}
/** The chain's quote for a trade, as quote.js would read it; quote.test.js holds readQuote to real chain bytes. */
const quoted = (out) => async () => out;
const deps = (over = {}) => ({ signer: SIGNER, withdrawTo: LOGIN, request: rpc().request, now: () => NOW, cache: new Map(), quote: quoted(2n), ...over });
const tx = (to, data, value = 0n) => ({ to, data, value });
const refused = async (t, d = deps(), why = /./) => {
  await assert.rejects(checkTrade(t, d), (e) => e instanceof Refused && why.test(e.message) && /Nothing was signed\.$/.test(e.message));
};

test("every step of every fixture plan passes, as its kind", async () => {
  for (const fx of plans) {
    for (const s of fx.plan.steps) {
      const kind = await checkTrade(tx(s.to, s.data, BigInt(s.value)), deps({ quote: quoted(BigInt(fx.plan.quote.expectedOut)) }));
      assert.ok(["approve", "permit2-approve", "curve-buy", "curve-sell", "router-swap"].includes(kind), `${fx.name}: ${s.kind} → ${kind}`);
      assert.equal(kind, s.kind === "erc20-approve" ? "approve" : s.kind, `${fx.name}: ${s.kind}`);
    }
  }
});

test("Withdraw all: a plain send only to the login wallet, and only with value", async () => {
  assert.equal(await checkTrade(tx(LOGIN, "0x", 10n ** 17n), deps()), "withdraw");
  await refused(tx(ATTACKER, "0x", 10n ** 17n), deps(), /only to the wallet you logged in with/);
  await refused(tx(LOGIN, "0x", 10n ** 17n), deps({ withdrawTo: null }), /only to the wallet you logged in with/);
  await refused(tx(LOGIN, "0x", 0n));
  await refused(tx(SIGNER, "0x", 1n), deps({ withdrawTo: SIGNER }));
});

test("P2e's attacks are refused", async () => {
  const pad = (a) => lower(a).slice(2).padStart(64, "0");
  const MAX = "f".repeat(64);
  await refused(tx(ATTACKER, "0xdeadbeef", 5n * 10n ** 18n), deps(), /not one of cumTrade's trades/);
  await refused(tx(ATTACKER, "0x00", 5n * 10n ** 18n), deps(), /not a function call|not one of/);
  await refused(tx(CURVE_TOKEN, `0xa9059cbb${pad(ATTACKER)}${MAX}`), deps(), /0xa9059cbb/);
  await refused(tx(CURVE_TOKEN, `0x23b872dd${pad(SIGNER)}${pad(ATTACKER)}${MAX}`), deps(), /0x23b872dd/);
  await refused(tx(CURVE_TOKEN, `${SEL.erc20Approve}${pad(ATTACKER)}${MAX}`), deps(), /not Permit2, the router or this token's curve/);
});

test("a buy or sell on a contract the factory didn't launch, or paying anyone else, is refused", async () => {
  const buy = (to, recipient, amount = 10n ** 16n) => tx(to, `${SEL.curveBuy}${word(amount)}${word(1)}${word(recipient)}`, amount);
  assert.equal(await checkTrade(buy(CURVE, SIGNER), deps()), "curve-buy");
  await refused(buy(ATTACKER, SIGNER), deps(), /not a clank\.trade launch|could not be checked|not what a trade looks like/);
  await refused(buy(CURVE, ATTACKER), deps(), /pays .*not this wallet/);
  await refused(tx(CURVE, `${SEL.curveBuy}${word(10n ** 16n)}${word(1)}${word(SIGNER)}`, 10n ** 17n), deps(), /buy's ETH/);
  await refused(tx(CURVE, `${SEL.curveSell}${word(10n ** 18n)}${word(1)}${word(SIGNER)}`, 1n), deps(), /sell carries ETH/);
});

const depsFor = deps;

test("the router: another command, other actions, or a pool that isn't the token's own are refused", async () => {
  const fx = plans.find((p) => p.name === "v4 buy");
  const swap = fx.plan.steps.find((s) => s.kind === "router-swap");
  const v = BigInt(swap.value);
  const deps = (over = {}) => depsFor({ quote: quoted(BigInt(fx.plan.quote.expectedOut)), ...over });
  assert.equal(await checkTrade(tx(swap.to, swap.data, v), deps()), "router-swap");
  // commands is the first dynamic argument: its length word, then 0x10 padded.
  const tail = swap.data.slice(10);
  const commandsAt = 2 * Number(BigInt(`0x${tail.slice(0, 64)}`));
  const withCommand = (c) => `${swap.data.slice(0, 10)}${tail.slice(0, commandsAt + 64)}${c.padEnd(64, "0")}${tail.slice(commandsAt + 128)}`;
  await refused(tx(swap.to, withCommand("0b"), v), deps(), /commands 0x0b/);
  await refused(tx(swap.to, withCommand("11"), v), deps(), /commands 0x11/);
  const actions = swap.data.indexOf("060c0f");
  assert.ok(actions > 0);
  await refused(tx(swap.to, `${swap.data.slice(0, actions)}060c0e${swap.data.slice(actions + 6)}`, v), deps(), /V4 actions/);
  await refused(tx(ATTACKER, swap.data, v), deps(), /execute goes to the Uniswap router/);
  // The same swap with another hook: a pool the attacker made for the token.
  const hook = lower(chain.memeHook).slice(2);
  const i = swap.data.toLowerCase().indexOf(hook);
  await refused(tx(swap.to, `${swap.data.slice(0, i)}${"99".repeat(20)}${swap.data.slice(i + 40)}`, v), deps(), /not the one this token graduated into/);
  await refused(tx(swap.to, swap.data, v + 1n), deps(), /ETH is not what it puts in/);
});

test("approvals: Permit2 and the router pass; Permit2's own approve only for the router, within a week", async () => {
  assert.equal(await checkTrade(tx(V4_TOKEN, `${SEL.erc20Approve}${word(PERMIT2)}${word(5)}`), deps()), "approve");
  assert.equal(await checkTrade(tx(V4_TOKEN, `${SEL.erc20Approve}${word(UNIVERSAL_ROUTER)}${word(5)}`), deps()), "approve");
  assert.equal(await checkTrade(tx(CURVE_TOKEN, `${SEL.erc20Approve}${word(CURVE)}${word(5)}`), deps()), "approve");
  await refused(tx(CURVE_TOKEN, `${SEL.erc20Approve}${word(PERMIT2)}${word(5)}`, 1n), deps(), /carries no ETH/);
  const p2 = (spender, exp) => tx(PERMIT2, `${SEL.permit2Approve}${word(V4_TOKEN)}${word(spender)}${word(5)}${word(exp)}`);
  assert.equal(await checkTrade(p2(UNIVERSAL_ROUTER, NOW + 3600), deps()), "permit2-approve");
  await refused(p2(ATTACKER, NOW + 3600), deps(), /not the Uniswap router/);
  await refused(p2(UNIVERSAL_ROUTER, NOW + 8 * 86_400), deps(), /more than a week/);
});

test("data that isn't encoded the one canonical way is refused", async () => {
  const dirty = `${SEL.erc20Approve}${"ff".repeat(12)}${lower(PERMIT2).slice(2)}${word(5)}`;
  await refused(tx(CURVE_TOKEN, dirty), deps(), /not encoded the one way|not what a trade looks like/);
});

test("a graduated token's reads are kept for the session; a curve token's are read again", async () => {
  const r = rpc();
  const d = deps({ request: r.request });
  const swap = plans.find((p) => p.name === "v4 buy").plan.steps.find((s) => s.kind === "router-swap");
  d.quote = quoted(BigInt(plans.find((p) => p.name === "v4 buy").plan.quote.expectedOut));
  await checkTrade(tx(swap.to, swap.data, BigInt(swap.value)), d);
  const first = r.calls;
  await checkTrade(tx(swap.to, swap.data, BigInt(swap.value)), d);
  assert.equal(r.calls, first, "the second swap read nothing");
});

// ---- P2e re-review of 123c81f (TI Build) ----------------------------------

test("an approval is signed only on a clank.trade token, and a Permit2 approval only for one (finding 4)", async () => {
  await refused(tx(ATTACKER, `${SEL.erc20Approve}${word(PERMIT2)}${word(5)}`), deps(), /not a clank\.trade launch|could not be checked|not what a trade looks like/);
  await refused(tx(ATTACKER, `${SEL.erc20Approve}${word(UNIVERSAL_ROUTER)}${word(5)}`), deps(), /not a clank\.trade launch|could not be checked|not what a trade looks like/);
  await refused(tx(PERMIT2, `${SEL.permit2Approve}${word(ATTACKER)}${word(UNIVERSAL_ROUTER)}${word(5)}${word(NOW + 3600)}`), deps(),
    /not a clank\.trade launch|could not be checked|not what a trade looks like/);
});

test("every trade has a minimum out, no lower than the chain's own quote less the widest slippage (finding 2)", async () => {
  const buy = (minOut) => tx(CURVE, `${SEL.curveBuy}${word(10n ** 16n)}${word(minOut)}${word(SIGNER)}`, 10n ** 16n);
  const sell = (minOut) => tx(CURVE, `${SEL.curveSell}${word(10n ** 18n)}${word(minOut)}${word(SIGNER)}`, 0n);
  const q = quoted(1000n);
  await refused(buy(0n), deps({ quote: q }), /more than 50% under the chain's own price/);
  await refused(sell(0n), deps({ quote: q }), /more than 50% under the chain's own price/);
  await refused(buy(499n), deps({ quote: q }), /more than 50% under/);
  assert.equal(await checkTrade(buy(500n), deps({ quote: q })), "curve-buy", "exactly at the widest slippage");
  await refused(buy(500n), deps({ quote: quoted(0n) }), /prices this buy at nothing/);

  const fx = plans.find((p) => p.name === "v4 buy");
  const swap = fx.plan.steps.find((s) => s.kind === "router-swap");
  const v = BigInt(swap.value), min = BigInt(fx.plan.quote.minOut);
  // The chain now says twenty times as much: the plan's minimum is far under it.
  await refused(tx(swap.to, swap.data, v), deps({ quote: quoted(20n * BigInt(fx.plan.quote.expectedOut)) }), /more than 50% under/);
  // A pool the chain can't price (no such key, or no liquidity).
  await refused(tx(swap.to, swap.data, v), deps({ quote: quoted(0n) }), /prices this buy at nothing/);
  // TAKE_ALL's amount must be the swap's own minimum: the take is the last word pair.
  const w = word(min), i = swap.data.lastIndexOf(w);
  assert.ok(i > 0);
  const taken = `${swap.data.slice(0, i)}${word(min + 1n)}${swap.data.slice(i + 64)}`;
  await refused(tx(swap.to, taken, v), deps({ quote: quoted(BigInt(fx.plan.quote.expectedOut)) }), /takes a different minimum/);
});

test("a curve trade on a token that has graduated is refused", async () => {
  const graduated = chain.tokens[V4_TOKEN].curve;
  await refused(tx(graduated, `${SEL.curveBuy}${word(10n ** 16n)}${word(1)}${word(SIGNER)}`, 10n ** 16n), deps(), /left its curve/);
});
