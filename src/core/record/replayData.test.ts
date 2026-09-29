/**
 * A position's trade replay from the chain index (p-sell-verdict.md, P4a).
 * Pure; every address, trade and price is made up.
 *
 *   npm run test:record
 */
import type { ReceiptRow, TradeRow } from "../lib/indexStore.js";
import { LEAD_MS, replayData } from "./replayData.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

const E = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const ROUTER = "0x00000000000000000000000000000000000000cc";
const TOKEN = "0x00000000000000000000000000000000000000c1";
const CURVE = "0x00000000000000000000000000000000000000d1";
const H = 3600_000;
const T0 = Date.UTC(2026, 8, 16, 0); // the launch, at block 1000
/** Ten blocks a second, as the chain runs. */
const blockAt = (ms: number) => 1000 + Math.round((ms - T0) / 100);

const trades: TradeRow[] = [];
const receipts = new Map<string, ReceiptRow>();
let n = 0;
/**
 * A curve trade at `ms`: `eth` in (buy) or out (sell) for `tokens`, for `who`.
 * `caller` is the curve's caller: a router when one sold for `who`, though
 * `who` still sent the transaction and paid its gas.
 */
function trade(ms: number, kind: "buy" | "sell", eth: number, tokens: number, who: string, caller = who, gas = 0.00001) {
  const tx = `0x${(++n).toString(16).padStart(64, "0")}`;
  const w = BigInt(Math.round(eth * 1e18)), t = BigInt(Math.round(tokens)) * E;
  const fee = w / 100n;
  trades.push({
    tx, logIndex: 0, block: BigInt(blockAt(ms)), curve: CURVE, token: TOKEN, kind,
    caller, recipient: who,
    amountIn: kind === "buy" ? w : t, amountOut: kind === "buy" ? t : w, fee, snipeTax: 0n, movers: [],
  });
  receipts.set(tx, { tx, sender: who, gas: BigInt(Math.round(gas * 1e18)), block: BigInt(blockAt(ms)), time: BigInt(Math.round(ms / 1000)) });
}

// Someone else trades from the launch; I buy twice, sell through a router,
// buy again later and sell again: two positions in one token.
trade(T0 + 60_000, "buy", 0.5, 20_000_000, OTHER);
trade(T0 + 20 * H, "buy", 0.02, 1_000_000, ME);
trade(T0 + 20 * H + 600_000, "buy", 0.02, 900_000, ME);
trade(T0 + 22 * H, "buy", 0.3, 10_000_000, OTHER);
trade(T0 + 30 * H, "sell", 0.05, 1_900_000, ME, ROUTER);
trade(T0 + 40 * H, "buy", 1, 20_000_000, OTHER);
trade(T0 + 50 * H, "buy", 0.1, 1_000_000, ME);
trade(T0 + 60 * H, "sell", 0.2, 1_000_000, ME);
// A receipt the index has not fetched yet: its time comes from the blocks around it.
trades.push({ ...trades[3]!, tx: "0xmissing", logIndex: 1, block: BigInt(blockAt(T0 + 25 * H)) });

const NOW = T0 + 100 * H;
const base = {
  address: ME, token: TOKEN, trades, receipts, graduatedBlock: null, toBlock: 99_999n, now: NOW, usdNow: 2700,
  usdDay: { "2026-09-16": 2500, "2026-09-17": 2600 } as Record<string, number>,
};

console.log("\nthe first position");
{
  const r = replayData({ ...base, opened: T0 + 20 * H, closed: T0 + 30 * H })!;
  ok("its own three fills, not the stranger's or the later position's",
    r.fills.map((f) => f.kind).join() === "buy,buy,sell", r.fills.map((f) => `${f.kind}@${(f.at - T0) / H}h`).join(" "));
  const [b1, , s] = r.fills;
  ok("a buy is the ETH paid for the tokens got", b1!.eth === 0.02 && b1!.tokens === 1_000_000 && near(b1!.price!, 0.02 / 1e6));
  ok("a sell through a router is still mine: ETH got for tokens given", s!.eth === 0.05 && s!.tokens === 1_900_000);
  ok("dollars on each trade's day", b1!.usd === 0.02 * 2500 && s!.usd === 0.05 * 2600, `${b1!.usd} ${s!.usd}`);
  ok("gas for each transaction I sent, the router's sell included", near(r.gasEth, 0.00003), String(r.gasEth));
  ok("before: from the lead or the launch, up to the first buy",
    r.segments.before.length > 0 && r.segments.before[0]!.t0 === T0 + 20 * H - LEAD_MS
      && r.segments.before[r.segments.before.length - 1]!.t1 <= T0 + 20 * H);
  ok("holding runs from the first buy to the last sell",
    r.segments.holding[0]!.t0 === T0 + 20 * H && r.segments.holding[r.segments.holding.length - 1]!.t1 >= T0 + 30 * H);
  const after = r.segments.after;
  ok("after runs from the sell to now, and carries every later trade",
    after.length === 24 && after[after.length - 1]!.t1 >= NOW && after.some((c) => c.h >= 0.2 * 0.99 / 1e6));
  ok("today's figures and no best exit", r.usdNow === 2700 && r.best === null && r.graduatedAt === null && r.asOfBlock === "99999");
}

console.log("\nthe second position, and what there is not");
{
  const r = replayData({ ...base, opened: T0 + 50 * H, closed: T0 + 60 * H })!;
  ok("only the later buy and sell", r.fills.length === 2 && r.fills[0]!.at === T0 + 50 * H);
  ok("a day with no price leaves the dollars out, never a guess", r.fills.every((f) => f.usd === null));
  ok("a window with none of my trades: null",
    replayData({ ...base, opened: T0 + 70 * H, closed: T0 + 80 * H }) === null);
  ok("someone else's address: null", replayData({ ...base, address: "0x" + "e".repeat(40), opened: T0, closed: null }) === null);
  const open = replayData({ ...base, opened: T0 + 50 * H, closed: null })!;
  ok("still open: the window runs to now", open.fills.length === 2);
}

console.log("\na graduated token");
{
  const grad = T0 + 70 * H;
  const r = replayData({ ...base, opened: T0 + 20 * H, closed: T0 + 30 * H, graduatedBlock: BigInt(blockAt(grad)) })!;
  ok("graduation's time, from the blocks around it", Math.abs(r.graduatedAt! - grad) < 1000, String((r.graduatedAt! - T0) / H));
  const after = r.segments.after;
  ok("the chart stops at graduation, not now", after[after.length - 1]!.t1 <= grad + 1000 + (grad - T0 - 30 * H) / 24);
}

console.log(failures === 0
  ? "\n\x1b[32mall replay data checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
