/**
 * Which bonding-curve trades belong to a wallet.
 *
 * The curve's events carry two indexed addresses, and they are not the same
 * thing. Verified by simulating a buy and a sell on a live curve with the
 * sender and recipient set to different addresses:
 *
 *   topic1 = msg.sender  — whoever called the curve
 *   topic2 = recipient   — the `to` argument: tokens on a buy, ETH on a sell
 *
 * A trade made directly from a wallet has both set to that wallet, which is
 * why filtering on topic1 alone looked correct for as long as every trade was
 * direct. A trade routed through a contract has the router in topic1, so
 * topic1 credits it to the router and the wallet that actually traded sees
 * nothing.
 *
 * Swapping to topic2 alone is not the fix either. Anyone can call
 * `buy(…, to = someoneElse)` or `sell(…, to = someoneElse)`, so topic2 by
 * itself would book a stranger's purchase into your cost basis and let a
 * stranger's sale shrink your position. Each side therefore needs evidence
 * that the wallet really was the one trading:
 *
 *   buy   the tokens came to `owner` (topic2) AND `owner` paid for them —
 *         either it called the curve (topic1) or it sent the transaction
 *   sell  `owner` called the curve with its own tokens (topic1), OR the ETH came
 *         to `owner` (topic2) AND the same transaction moved that token out of
 *         `owner` — which is what a router sell looks like
 *
 * Kept pure so it can be tested against synthetic and simulated logs without
 * touching the chain. The caller supplies transaction context from receipts.
 */
import type { Address, Hex } from "viem";

export const BUY_TOPIC =
  "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455" as Hex;
export const SELL_TOPIC =
  "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df" as Hex;
/** ERC20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

export type RawLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex | bigint;
  logIndex: Hex | number;
};

/** What a receipt says about the transaction a trade happened in. */
export type TxContext = { from: Address; logs: RawLog[] };

export type Trade = {
  kind: "buy" | "sell";
  curve: Address;
  tx: Hex;
  block: bigint;
  logIndex: number;
  /** buy: ETH in. sell: tokens in. */
  amountIn: bigint;
  /** buy: tokens out. sell: ETH out, net of fee. */
  amountOut: bigint;
  fee: bigint;
  snipeTax: bigint;
};

const pad = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const topicIs = (topic: Hex | undefined, a: Address) => same(topic, pad(a));
const word = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"}`);
const asBig = (v: Hex | bigint) => (typeof v === "bigint" ? v : BigInt(v));
const asNum = (v: Hex | number) => (typeof v === "number" ? v : Number(BigInt(v)));

/**
 * The `eth_getLogs` topic filters to fetch for `owner`.
 *
 * Their union is deliberately a superset of what `attribute` keeps: an RPC
 * filter can only match an address, not ask who paid, so it fetches every
 * event naming `owner` in a relevant position and `attribute` decides.
 *
 * Two filters, not three: a topic position can list alternatives, so tokens
 * delivered to `owner` (a Buy) and proceeds delivered to `owner` (a Sell) are
 * one query. Every query is a request to a node that refuses volume.
 */
export function logFilters(owner: Address): (Hex | Hex[] | null)[][] {
  const o = pad(owner);
  return [
    [[BUY_TOPIC, SELL_TOPIC], null, o], // tokens or proceeds delivered to owner
    [SELL_TOPIC, o],                    // owner sold
  ];
}

export function attribute(
  owner: Address,
  logs: RawLog[],
  ctx: (tx: Hex) => TxContext | undefined,
  tokenOf: (curve: Address) => Address | undefined,
): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];

  for (const l of logs) {
    const kind = same(l.topics[0], BUY_TOPIC) ? "buy"
      : same(l.topics[0], SELL_TOPIC) ? "sell" : null;
    if (!kind) continue;

    // The same event can come back from more than one filter — a direct trade
    // matches both sell filters. One event is one trade.
    const key = `${l.transactionHash.toLowerCase()}:${asNum(l.logIndex)}`;
    if (seen.has(key)) continue;

    const caller = topicIs(l.topics[1], owner);
    const recipient = topicIs(l.topics[2], owner);
    let mine = false;

    if (kind === "buy") {
      if (recipient) mine = caller || same(ctx(l.transactionHash)?.from, owner);
    } else if (caller) {
      mine = true;
    } else if (recipient) {
      const token = tokenOf(l.address);
      const c = ctx(l.transactionHash);
      mine = !!token && !!c && c.logs.some((t) =>
        same(t.address, token) && same(t.topics[0], TRANSFER_TOPIC) && topicIs(t.topics[1], owner));
    }
    if (!mine) continue;

    seen.add(key);
    out.push({
      kind, curve: l.address, tx: l.transactionHash,
      block: asBig(l.blockNumber), logIndex: asNum(l.logIndex),
      amountIn: word(l.data, 0), amountOut: word(l.data, 1),
      fee: word(l.data, 2), snipeTax: word(l.data, 3),
    });
  }

  // Order is the whole correctness story downstream: a sell replayed before
  // its buy finds no position and silently does nothing.
  out.sort((a, b) => (a.block === b.block
    ? a.logIndex - b.logIndex
    : a.block < b.block ? -1 : 1));
  return out;
}
