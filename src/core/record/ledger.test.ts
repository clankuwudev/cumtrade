/**
 * The track record's arithmetic — docs/specs/track-record.md, T1.
 *
 * Pure. Every address and amount is made up.
 *
 *   npm run test:record
 */
import { build, classify, markSharedBlocks, totals, tradingFlows, type Leg, type TxRow } from "./ledger.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const E = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const ROUTER = "0x0000000000000000000000000000000000000f00";

let block = 100;
const leg = (dir: "in" | "out", token: string, raw: bigint, symbol = "TKN"): Leg =>
  ({ dir, token, symbol, raw: raw.toString(), decimals: 18 });
const tx = (o: Partial<TxRow> & { legs?: Leg[] }): TxRow => ({
  hash: `0x${(block).toString(16).padStart(64, "0")}`, block: block++, at: block * 1000, mine: true, to: ROUTER,
  ethOut: "0", ethIn: "0", gas: "1000", sharedBlock: false, legs: [], ...o,
});

console.log("\nwhat each transaction is");
ok("tokens in, ETH out: buy", classify(tx({ ethOut: String(E), legs: [leg("in", A, 5n)] })) === "buy");
ok("tokens out, ETH back: sell", classify(tx({ ethIn: String(E), legs: [leg("out", A, 5n)] })) === "sell");
ok("tokens out, nothing back: sent", classify(tx({ legs: [leg("out", A, 5n)] })) === "sent");
ok("tokens in and out: swap", classify(tx({ legs: [leg("in", A, 5n), leg("out", B, 1n)] })) === "swap");
ok("someone else's tx with tokens: received", classify(tx({ mine: false, legs: [leg("in", A, 5n)] })) === "received");
ok("someone else's tx with ETH: eth-in", classify(tx({ mine: false, ethIn: String(E) })) === "eth-in");
ok("ETH sent, nothing back: eth-out", classify(tx({ ethOut: String(E) })) === "eth-out");
ok("nothing moved: other (an approval)", classify(tx({ to: A })) === "other");

console.log("\none position, bought twice and sold");
{
  const r = build([
    tx({ ethOut: String(2n * E), legs: [leg("in", A, 1000n)], gas: "10" }),
    // A buy the venue refunded part of: what it cost is what left, less what came back.
    tx({ ethOut: String(3n * E), ethIn: String(E), legs: [leg("in", A, 500n)], gas: "10" }),
    tx({ ethIn: String(5n * E), legs: [leg("out", A, 1500n)], gas: "10" }),
  ]);
  const p = r.positions[0]!;
  ok("one position", r.positions.length === 1);
  ok("spent counts the refund", p.ethSpent === String(4n * E), p.ethSpent);
  ok("back is what the sell returned", p.ethBack === String(5n * E));
  ok("gas is every leg's", p.gas === "30");
  ok("realised = back - spent - gas", p.realised === String(E - 30n), p.realised);
  ok("nothing held", p.held === "0");
  ok("two buys and a sell counted", p.buys === 2 && p.sells === 1);
  ok("the last sell's block is kept", p.lastSellBlock === block - 1);
}

console.log("\nan approval's gas");
{
  block = 200;
  const r = build([
    tx({ to: A, gas: "7" }),
    tx({ ethOut: String(E), legs: [leg("in", A, 10n)], gas: "1" }),
    tx({ to: C, gas: "5" }),
  ]);
  ok("goes to the token it approved, when that is a position", r.positions[0]!.gas === "8", r.positions[0]!.gas);
  ok("is overhead otherwise", r.flows.overheadGas === "5", r.flows.overheadGas);
}

console.log("\none transaction, two tokens");
{
  const r = build([tx({ ethOut: String(2n * E), gas: "20", legs: [leg("in", A, 1n, "AAA"), leg("in", B, 1n, "BBB")] })]);
  ok("each gets half the ETH", r.positions.every((p) => p.ethSpent === String(E)));
  ok("and half the gas", r.positions.every((p) => p.gas === "10"));
  ok("and says it was split", r.positions.every((p) => p.split));
}

console.log("\ntwo of the wallet's transactions in one block");
{
  const rows = markSharedBlocks([
    tx({ block: 500, ethOut: String(E), legs: [leg("in", A, 1n)] }),
    tx({ block: 500, ethIn: String(E), legs: [leg("out", B, 1n)] }),
    tx({ block: 501, ethOut: String(E), legs: [leg("in", C, 1n)] }),
    // Someone else's transaction in a block of ours does not make it shared.
    tx({ block: 501, mine: false, legs: [leg("in", C, 1n)] }),
  ]);
  ok("both are marked", rows[0]!.sharedBlock && rows[1]!.sharedBlock);
  ok("the block alone is not", !rows[2]!.sharedBlock);
  const r = build(rows);
  const t = totals(r.positions);
  ok("the rows say so", r.positions.filter((p) => p.sharedBlock).length === 1);
  ok("totals leave them out and count them", t.leftOut === 1 && t.positions === 1, JSON.stringify(t));
}

console.log("\nwhat is not a position");
{
  block = 700;
  const r = build([
    tx({ mine: false, legs: [leg("in", A, 50n, "DROP")] }),
    tx({ mine: false, legs: [leg("in", B, 9n, "STABLE")] }),
    tx({ ethIn: String(3n * E), legs: [leg("out", B, 9n, "STABLE")], gas: "4" }),
    tx({ ethOut: String(2n * E), gas: "6" }),
    tx({ mine: false, ethIn: String(E) }),
    tx({ legs: [leg("in", C, 1n), leg("out", A, 1n)], gas: "3" }),
  ]);
  ok("no positions: nothing was bought", r.positions.length === 0);
  ok("received tokens are listed", r.received.length === 2 && r.received[0]!.held === "50");
  ok("received then sold is a conversion, with its ETH", r.flows.soldReceived.count === 1 &&
    r.flows.soldReceived.wei === String(3n * E));
  ok("ETH sent with nothing back is counted", r.flows.ethOut.count === 1 && r.flows.ethOut.wei === String(2n * E));
  ok("ETH that arrived is counted", r.flows.ethIn.count === 1 && r.flows.ethIn.wei === String(E));
  ok("a swap is counted", r.flows.swaps === 1);
  ok("their gas is overhead", r.flows.overheadGas === "13", r.flows.overheadGas);
}

console.log("\ntokens given away");
{
  block = 900;
  const r = build([
    tx({ ethOut: String(E), legs: [leg("in", A, 100n)] }),
    tx({ legs: [leg("out", A, 40n)] }),
  ]);
  const p = r.positions[0]!;
  ok("are not sold", p.sold === "0" && p.sells === 0);
  ok("but are no longer held", p.held === "60" && p.sent === "40");
}

console.log("\nthe running total the record card draws");
{
  block = 1100;
  const rows = [
    tx({ to: A, gas: "7" }),
    tx({ ethOut: String(2n * E), legs: [leg("in", A, 1000n)], gas: "10" }),
    tx({ ethOut: String(3n * E), ethIn: String(E), legs: [leg("in", A, 500n)], gas: "10" }),
    tx({ mine: false, ethIn: String(9n * E) }),
    tx({ ethOut: String(E), gas: "5" }),
    tx({ ethIn: String(5n * E), legs: [leg("out", A, 1500n)], gas: "10" }),
    tx({ mine: false, legs: [leg("in", B, 9n, "STABLE")] }),
    tx({ ethIn: String(3n * E), legs: [leg("out", B, 9n, "STABLE")], gas: "4" }),
  ];
  const flows = tradingFlows(rows);
  const sum = flows.reduce((a, f) => a + f.wei, 0n);
  ok("ends exactly on the record's net", sum === BigInt(totals(build(rows).positions).realised),
    `${sum} vs ${totals(build(rows).positions).realised}`);
  ok("leaves out ETH that arrived, a bridge send and a received token's sale", flows.length === 4, String(flows.length));
  ok("a buy is a step down, a sell a step up", flows[1]!.wei < 0n && flows[3]!.wei > 0n);
}

console.log(failures === 0
  ? "\n\x1b[32mall ledger checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
