import {
  APPROVE_AHEAD_EXPIRY_S, APPROVE_AHEAD_RENEW_S, CHAIN_ID, MAX_GAS, PERMIT2, READ, SEL, UNIVERSAL_ROUTER,
} from "./constants.js";
import { hexBody, uintAt, word } from "./abi.js";
import { readIdentity } from "./verify.js";

// ====================================================================== //
// approvals ahead of need                                                //
// ====================================================================== //
//
// The trading wallet's sell path, approved right after a buy fills, so the
// sell that follows is one transaction (public-release W3.2, TW6). Built here
// in the page, with no server route: the calldata comes from the pinned
// selectors and abi.js's encoder, and every number comes from reads through
// the wallet's own RPC.
//
// - The amount is what the wallet holds, `balanceOf(from)`, never MAX.
// - The spender is the verified curve's, or Permit2 and then the router once
//   the token has graduated. A curve approval is useless after graduation, so
//   the next fill or visit sets up the Permit2 pair.
// - The Permit2 allowance lasts 7 days, and is given again once it is within
//   a day of expiring.
// - Whatever is already covered is left out. Covered by every step means
//   nothing is sent.
//
// verify.js checks the plan (`verifyApproveAhead`) and sequence.js runs it
// (`startApproveAhead`), which both do again before each send. Only the
// trading wallet approves ahead: the main wallet keeps P3's exact, one-hour
// approvals in each sell plan.

/**
 * The reads a plan is built from and checked against, through the wallet's
 * own provider: the verifier's identity reads, then what `from` holds and the
 * allowances already given for the sell path this token trades on now.
 *
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} request EIP-1193
 * @param {string} from
 * @param {string} token
 */
export async function readApproveAhead(request, from, token) {
  const identity = await readIdentity(request, token);
  const call = async (to, data) => hexBody(await request({ method: "eth_call", params: [{ to, data }, "latest"] }));
  const spender = identity.graduated ? PERMIT2 : identity.tokenCurve;
  const [held, erc20, p2] = await Promise.all([
    call(token, READ.balanceOf + word(from)),
    call(token, READ.allowance + word(from) + word(spender)),
    identity.graduated
      ? call(PERMIT2, READ.permit2Allowance + word(from) + word(token) + word(UNIVERSAL_ROUTER))
      : Promise.resolve(null),
  ]);
  return {
    ...identity,
    balance: uintAt(held, 0),
    allowance: {
      erc20: uintAt(erc20, 0),
      permit2: p2 === null ? null : { amount: uintAt(p2, 0, 160), expiration: Number(uintAt(p2, 32, 48)) },
    },
  };
}

/**
 * Whether the allowance a step would give is already in place, by these
 * reads. A Permit2 allowance within a day of expiring does not count.
 *
 * @param {{ kind: string }} step
 * @param {Awaited<ReturnType<typeof readApproveAhead>>} reads
 */
export function covered(step, reads) {
  if (step.kind === "erc20-approve") return reads.allowance.erc20 >= reads.balance;
  const p2 = reads.allowance.permit2;
  return !!p2 && p2.amount >= reads.balance && p2.expiration > reads.now + APPROVE_AHEAD_RENEW_S;
}

/**
 * The plan: the approvals this token's sell path still needs, for exactly
 * what `from` holds. No steps when nothing is held or everything is covered.
 * Each step's gas is the wallet's own estimate, with the server's 30% on top.
 *
 * @param {(args: { method: string, params?: unknown[] }) => Promise<any>} request EIP-1193
 * @param {{ kind: "approve-ahead", from: string, token: string, symbol?: string }} intent
 * @param {Awaited<ReturnType<typeof readApproveAhead>>} reads
 */
export async function planApproveAhead(request, intent, reads) {
  const venue = reads.graduated ? "v4" : "curve";
  const plan = { kind: "approve-ahead", chainId: CHAIN_ID, from: intent.from, token: intent.token, venue, steps: [] };
  if (reads.balance === 0n) return plan;
  const symbol = intent.symbol || "this token";
  const amount = reads.balance;

  const wanted = [];
  if (venue === "curve") {
    wanted.push({
      id: "approve-token", kind: "erc20-approve", label: `Let the curve move ${symbol}`,
      to: intent.token, data: SEL.erc20Approve + word(reads.tokenCurve) + word(amount),
    });
  } else {
    wanted.push({
      id: "approve-token", kind: "erc20-approve", label: `Let Permit2 move ${symbol}`,
      to: intent.token, data: SEL.erc20Approve + word(PERMIT2) + word(amount),
    });
    wanted.push({
      id: "approve-permit2", kind: "permit2-approve", label: "Let the Uniswap router use that allowance for 7 days",
      to: PERMIT2,
      data: SEL.permit2Approve + word(intent.token) + word(UNIVERSAL_ROUTER) + word(amount) + word(reads.now + APPROVE_AHEAD_EXPIRY_S),
    });
  }

  for (const s of wanted) {
    if (covered(s, reads)) continue;
    const estimate = BigInt(await request({
      method: "eth_estimateGas", params: [{ from: intent.from, to: s.to, data: s.data, value: "0x0" }],
    }));
    const padded = (estimate * 13n) / 10n;
    const gas = padded > BigInt(MAX_GAS) ? BigInt(MAX_GAS) : padded;
    plan.steps.push({ ...s, value: "0x0", gas: `0x${gas.toString(16)}` });
  }
  return plan;
}
