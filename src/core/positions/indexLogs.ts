import type { Address, Hex } from "viem";
import type { TradeRow } from "../lib/indexStore.js";
import { BUY_TOPIC, SELL_TOPIC, TRANSFER_TOPIC, type RawLog } from "./attribution.js";

/**
 * The chain index's rows as the events `attribute` reads (attribution.ts):
 * each trade as the Buy or Sell it was read from, and each trade's `movers`
 * as the Transfers out of them in its transaction, which is what tells a
 * router sell from a stranger's. The ledger (`buildFromIndex`) and the
 * holders route (X27a) both read trades this way, so both book the same ones.
 */

export const pad32 = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
export const word32 = (v: bigint) => v.toString(16).padStart(64, "0");

/** A trade row as its Buy or Sell event. */
export const tradeLog = (t: TradeRow): RawLog => ({
  address: t.curve as Address,
  topics: [t.kind === "buy" ? BUY_TOPIC : SELL_TOPIC, pad32(t.caller), pad32(t.recipient)],
  data: `0x${word32(t.amountIn)}${word32(t.amountOut)}${word32(t.fee)}${word32(t.snipeTax)}` as Hex,
  transactionHash: t.tx as Hex, blockNumber: t.block, logIndex: t.logIndex,
});

/** The Transfers out of each trade's movers, for the trades of one transaction. */
export const movedLogs = (tx: string, inTx: TradeRow[]): RawLog[] => inTx.flatMap((t) => t.movers.map((m) => ({
  address: t.token as Address, topics: [TRANSFER_TOPIC, pad32(m)], data: "0x" as Hex,
  transactionHash: tx as Hex, blockNumber: t.block, logIndex: 0,
})));
