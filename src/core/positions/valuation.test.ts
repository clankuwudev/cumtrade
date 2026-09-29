/**
 * Fee-aware P&L verification.
 *
 * The reference case is a real round trip on Robinhood Chain, not a model: a
 * third party's direct buy and sell of the same tokens on one curve, the pair
 * recorded in fixtures/ledger-direct.json (BUY_TX and SELL_TX below).
 *
 * 0.073088541707994045 ETH in (the transaction's value), curve fee
 * 730885417079941 wei, 44860377.031962976185831306 tokens out; then the same
 * tokens back for a gross 72357656290914104 wei, fee 723576562909142, net
 * 71634079728004962. The gross is exactly what the buy put into the curve, to
 * the wei, so the curve was where the buy had left it: the market contributed
 * nothing and every wei of the difference is fee. The numbers below are the
 * two recorded events, and the first check reads them back from the fixture.
 *
 *   npx tsx src/core/positions/valuation.test.ts
 */
import { readFileSync } from "node:fs";
import { pnl, roundTripDragPct, breakevenMovePct, type Valuation } from "./valuation.js";
import type { Position } from "./accounting.js";
import { BUY_TOPIC, SELL_TOPIC } from "./attribution.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}` +
    (detail ? `  \x1b[90m${detail}\x1b[0m` : ""));
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const BUY_TX = "0x120e1b43de75fafc6a5157a90ac8bb42eab4d34d89f1c77e0941b59760f081ec";
const SELL_TX = "0x9004374aea5b33b0c8c93389da0b5dbae7413227c9cc90cc189ceaaf4f59a993";
const COST = 73_088_541_707_994_045n;     // msg.value, and the Buy event's ETH in
const ENTRY_FEE = 730_885_417_079_941n;   // the Buy event's fee
const TOKENS = 44_860_377_031_962_976_185_831_306n;
const NET = 71_634_079_728_004_962n;      // the Sell event's ETH out
const EXIT_FEE = 723_576_562_909_142n;    // the Sell event's fee
const GROSS = NET + EXIT_FEE;             // what quoteSell()[0] reads
const INVESTED = COST - ENTRY_FEE;

console.log("\nThe reference round trip\n");
{
  type Log = { topics: string[]; data: string; transactionHash: string };
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/ledger-direct.json", import.meta.url), "utf8")) as { logs: Log[] };
  const word = (l: Log, i: number) => BigInt(`0x${l.data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  const buy = recorded.logs.find((l) => l.topics[0] === BUY_TOPIC)!;
  const sell = recorded.logs.find((l) => l.topics[0] === SELL_TOPIC)!;
  ok("the buy is the recorded Buy event: ETH in, tokens out, fee",
    buy.transactionHash === BUY_TX && word(buy, 0) === COST && word(buy, 1) === TOKENS && word(buy, 2) === ENTRY_FEE);
  ok("the sell is the recorded Sell event: the same tokens in, ETH out, fee",
    sell.transactionHash === SELL_TX && word(sell, 0) === TOKENS && word(sell, 1) === NET && word(sell, 2) === EXIT_FEE);
  ok("the sell's gross is what the buy put into the curve, to the wei", GROSS === INVESTED, `${GROSS} vs ${INVESTED}`);
}

const position = (over: Partial<Position> = {}): Position => ({
  token: "0x0306d56171c91eb10a7cf71f83459898abcb59a9",
  curve: "0xee8e657a16cb12d1965b9dafba86b9b585e555af",
  symbol: "TEST", source: "auto",
  costEth: COST.toString(), tokens: TOKENS.toString(),
  feeBps: 100, entryFeeWei: ENTRY_FEE.toString(), snipeTaxWei: "0",
  realizedWei: "0", realizedCostWei: "0", realizedEntryFeeWei: "0",
  exitFeeWei: "0", soldTokens: "0", gasWei: "0",
  openedAt: Date.now(), openTx: null, peakValueWei: "0", dryRun: false,
  ...over,
});

const valuation = (over: Partial<Valuation> = {}): Valuation => ({
  venue: "curve", sellable: TOKENS, netWei: NET, grossWei: GROSS,
  exitFeeWei: EXIT_FEE, feeBps: 100, capped: false,
  progress: 0.001, graduated: false, readyToGraduate: false,
  ...over,
});

console.log("\nFee-aware P&L\n");

const m = pnl(position(), valuation());

ok("net P&L reproduces the observed round trip",
  m.netWei - m.costWei === -1_454_461_979_989_083n,
  `${m.deltaWei} wei`);
ok("net P&L is -1.99%, not -2%", near(m.pnlPct, -1.99, 1e-9), `${m.pnlPct}%`);
ok("invested = cost less the entry fee",
  m.investedWei === 72_357_656_290_914_104n, `${m.investedWei} wei`);
ok("price move is ~zero — the curve was where the buy left it",
  Math.abs(m.priceMovePct) < 1e-10, `${m.priceMovePct}%`);
ok("fee drag is the full 1.99%", near(m.feeDragPct, 1.99, 1e-9), `${m.feeDragPct}%`);
ok("breakeven needs +2.0304%, not +2%",
  near(m.breakevenMovePct, 2.030405, 1e-5), `+${m.breakevenMovePct}%`);

// netPnl = (1 + priceMove) * (1 - f)^2 - 1, the identity the split rests on.
const f = 0.01;
for (const move of [-50, -10, 0, 2.030405, 25, 100]) {
  const gross = (INVESTED * BigInt(Math.round((1 + move / 100) * 1e12))) / 10n ** 12n;
  const exitFee = (gross * 100n) / 10_000n;
  const p = pnl(position(), valuation({ grossWei: gross, exitFeeWei: exitFee, netWei: gross - exitFee }));
  const want = ((1 + move / 100) * (1 - f) * (1 - f) - 1) * 100;
  ok(`identity holds at a ${move >= 0 ? "+" : ""}${move}% move`,
    near(p.pnlPct, want, 1e-6), `pnl ${p.pnlPct.toFixed(6)}% vs ${want.toFixed(6)}%`);
}

const be = pnl(position(), (() => {
  const gross = (INVESTED * 1_020_304_050n) / 1_000_000_000n;
  const exitFee = (gross * 100n) / 10_000n;
  return valuation({ grossWei: gross, exitFeeWei: exitFee, netWei: gross - exitFee });
})());
ok("at the breakeven move, net P&L is ~0", Math.abs(be.pnlPct) < 1e-4, `${be.pnlPct}%`);

console.log("\nPartial exits\n");

// Half sold at 2x the entry: basis follows the tokens, so the open half still
// reads against its own cost rather than against the whole original position.
const half = pnl(
  position({
    costEth: (COST / 2n).toString(),
    tokens: (TOKENS / 2n).toString(),
    entryFeeWei: (ENTRY_FEE / 2n).toString(),
    realizedWei: (NET * 2n).toString(),
    realizedCostWei: (COST / 2n).toString(),
    soldTokens: (TOKENS / 2n).toString(),
  }),
  valuation({ grossWei: GROSS / 2n, exitFeeWei: EXIT_FEE / 2n, netWei: NET / 2n }),
);
ok("open half is valued against the half of the basis that is still open",
  near(half.pnlPct, -1.99, 1e-6), `${half.pnlPct}%`);
ok("realised and unrealised combine into one lifetime number",
  half.totalDeltaWei === (NET * 2n - COST / 2n) + (NET / 2n - COST / 2n),
  `${half.totalDeltaWei} wei`);

console.log("\nStandalone helpers\n");

ok("roundTripDragPct(100) is 1.99", near(roundTripDragPct(100), 1.99), `${roundTripDragPct(100)}`);
ok("breakevenMovePct(100) is 2.0304",
  near(breakevenMovePct(100), 2.030405, 1e-5), `${breakevenMovePct(100)}`);
ok("a 30 bps V4 pool costs 0.5991% round trip",
  near(roundTripDragPct(30), 0.5991), `${roundTripDragPct(30)}`);

console.log(`\n${failures === 0 ? "\x1b[32mall passed\x1b[0m" : `\x1b[31m${failures} failed\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
