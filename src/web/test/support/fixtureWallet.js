// A scripted EIP-1193 wallet on B2.3's fixture chain, for tests that run real
// trades: the signing sequence (sequence.test.js) and the page that wires it
// (trade.test.js). Moved here from sequence.test.js unchanged, apart from what
// the page's tests need: the chain's time may be a function, the curve's quote
// may be changed, and it estimates gas, for the approvals the page builds
// itself (approveAhead.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toHex } from "viem";
import { READ } from "../../public/js/trade/constants.js";
import { word } from "./calldata.js";

export const { chain, plans } = JSON.parse(readFileSync(new URL("../fixtures/plans.json", import.meta.url), "utf8"));

/** A copy of one fixture: `{ name, intent, plan }`. */
export const fixture = (name) => {
  const f = plans.find((p) => p.name === name);
  assert.ok(f, `no fixture named ${name}`);
  return structuredClone(f);
};

const lower = (a) => String(a).toLowerCase();

/**
 * A wallet on the fixture chain. It answers the verifier's reads, balances,
 * allowances and the chain's time, records every send, and mines each one
 * unless a test says otherwise. Mining an approval sets the allowance it
 * grants, so a later check sees it in place.
 *
 * @param {{ from: string, now: number }} o
 */
export function fixtureWallet({ from, now }) {
  const w = {
    chainId: 4663, account: from,
    /** The latest block's timestamp: a number, or a function called at each read. */
    now: /** @type {number | (() => number)} */ (now),
    balance: 50_000_000n * 10n ** 18n,
    erc20: 0n, p2: { amount: 0n, expiration: 0n },
    /** When set, the factory's registry names this curve for the token instead. */
    registryCurve: null,
    /** The curve's quoteBuyFor tokensOut for an amount in. The fixture chain's curve delivers 394M tokens per ETH (prepare.test.ts). */
    quote: (amountIn) => amountIn * 394_000_000n,
    /** The curve's quoteSell net ETH for tokens in, at the rate of the "curve sell with approval" fixture. */
    sellQuote: (tokens) => (tokens * 48_292_682_926_829_268n) / (20_000_000n * 10n ** 18n),
    /** What eth_estimateGas answers, and every transaction it was asked about. */
    gasEstimate: 46_000n, estimates: [],
    sends: [], log: [], receipts: new Map(),
    /** (i, tx) → { throw?, receipt?: "ok" | "revert" | "never", before?() } for the i-th send (0-based). */
    onSend: () => ({}),
    /** Called before each receipt poll that finds one, with the step's send index. */
    onMined: () => {},
  };
  const time = () => (typeof w.now === "function" ? w.now() : w.now);
  const curves = Object.fromEntries(Object.entries(chain.tokens).map(([t, v]) => [lower(v.curve), { token: t, ...v }]));
  const tokenRow = (a) => chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === lower(a))];
  const answerCall = ({ to, data }) => {
    const sel = data.slice(0, 10), at = lower(to), row = tokenRow(to);
    if (sel === READ.curve && row) return `0x${word(row.curve)}`;
    if (sel === READ.balanceOf && row) return `0x${word(w.balance)}`;
    if (sel === READ.allowance && row) return `0x${word(w.erc20)}`;
    if (sel === READ.permit2Allowance) return `0x${word(w.p2.amount)}${word(w.p2.expiration)}${word(0)}`;
    if (curves[at]) {
      if (sel === READ.token) return `0x${word(curves[at].token)}`;
      if (sel === READ.factory) return `0x${word(chain.factory)}`;
      if (sel === READ.graduated) return `0x${word(curves[at].graduated ? 1 : 0)}`;
      if (sel === READ.quoteBuyFor && !curves[at].graduated) {
        const amountIn = BigInt(`0x${data.slice(-64)}`);
        return `0x${[amountIn, (amountIn * 99n) / 100n, amountIn / 100n, w.quote(amountIn), 0n].map(word).join("")}`;
      }
      if (sel === READ.quoteSell && !curves[at].graduated) {
        const net = w.sellQuote(BigInt(`0x${data.slice(-64)}`));
        return `0x${[net + net / 99n, net, net / 99n].map(word).join("")}`;
      }
    }
    if (at === lower(chain.factory)) {
      if (sel === READ.memeHook) return `0x${word(chain.memeHook)}`;
      if (sel === READ.getLaunchedToken) {
        const r = tokenRow(`0x${data.slice(-40)}`);
        return r ? `0x${word(`0x${data.slice(-40)}`)}${word(w.registryCurve ?? r.curve)}${word(0).repeat(13)}` : `0x${word(0).repeat(15)}`;
      }
    }
    throw Object.assign(new Error(`execution reverted: ${sel} on ${to}`), { code: 3 });
  };
  const grant = (tx) => {
    const sel = tx.data.slice(0, 10), args = tx.data.slice(10);
    if (sel === "0x095ea7b3") w.erc20 = BigInt(`0x${args.slice(64, 128)}`);
    if (sel === "0x87517c45") w.p2 = { amount: BigInt(`0x${args.slice(128, 192)}`), expiration: BigInt(`0x${args.slice(192, 256)}`) };
  };
  w.provider = {
    async request({ method, params }) {
      w.log.push(method);
      switch (method) {
        case "eth_chainId": return toHex(w.chainId);
        case "eth_accounts": return [w.account];
        case "eth_getBlockByNumber": return { number: "0x1", timestamp: toHex(time()) };
        case "eth_call": return answerCall(params[0]);
        case "eth_estimateGas": w.estimates.push(params[0]); return toHex(w.gasEstimate);
        case "eth_sendTransaction": {
          const i = w.sends.length;
          const tx = params[0];
          const plan = w.onSend(i, tx) ?? {};
          if (plan.throw) throw plan.throw;
          w.sends.push(tx);
          w.log.push(`sent:${i}`);
          const hash = `0x${(i + 1).toString(16).padStart(64, "0")}`;
          w.receipts.set(hash, { i, tx, outcome: plan.receipt ?? "ok", seen: false });
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const r = w.receipts.get(params[0]);
          if (!r || r.outcome === "never") return null;
          if (!r.seen) {
            r.seen = true;
            if (r.outcome === "ok") grant(r.tx);
            w.onMined(r.i);
          }
          w.log.push(`receipt:${r.i}`);
          return { transactionHash: params[0], status: r.outcome === "ok" ? "0x1" : "0x0", logs: [] };
        }
      }
      throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
    },
  };
  return w;
}
