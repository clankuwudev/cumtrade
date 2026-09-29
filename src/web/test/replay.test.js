// What a trade replay shows (docs/specs/trade-replay.md, V2). Made-up trade:
// four buys of 0.02 ETH, one sell for 0.0284 ETH, then the token runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMELINE, fmtMoney, money, phaseAt, replayModel, story, times, verdictLine } from "../public/js/card/replayModel.js";

const H = 3600_000, DAY = 24 * H;
const T0 = Date.UTC(2026, 7, 17, 17);
const c = (i, o, h, l, cl) => ({ t0: T0 + i * H, t1: T0 + (i + 1) * H, o, h, l, c: cl });
const reply = {
  segments: {
    before: [c(-1, 2e-7, 2e-7, 2e-7, 2e-7)],
    holding: [c(0, 2e-7, 3e-7, 1.5e-7, 1.5e-7), c(1, 1.5e-7, 1.6e-7, 0.7e-7, 0.72e-7)],
    after: [c(2, 0.72e-7, 5e-7, 0.7e-7, 4e-7), c(40, 4e-7, 1e-5, 4e-7, 3.9e-6)],
  },
  fills: [
    { kind: "buy", at: T0 + 60_000, eth: 0.04, tokens: 200_000, price: 2e-7, usd: 76 },
    { kind: "buy", at: T0 + 120_000, eth: 0.04, tokens: 200_000, price: 2e-7, usd: 76 },
    { kind: "sell", at: T0 + H + 1800_000, eth: 0.0284, tokens: 400_000, price: 0.71e-7, usd: 54 },
  ],
  gasEth: 0.00002,
  best: { at: T0 + 40 * H, eth: 3.1184, usd: 7661, price: 1e-5 },
  soldNow: 1.5,
  heldNow: 0,
  usdNow: 2700,
  usdDay: { "2026-08-17": 1900, "2026-08-18": 1950, "2026-08-19": 2000 },
};
const row = {
  token: "0x00000000000000000000000000000000000000b1", symbol: "TKN", venue: null, verdict: "paperhand",
  first: T0, last: T0 + H, soldNow: 1.5, heldNow: 0, realised: -0.05162, ethBack: 0.0284,
};
const ADDR = "0x00000000000000000000000000000000000000aa";

test("dollars and multiples read the way the video shows them", () => {
  assert.equal(money(2204.4, true), "+$2,204");
  assert.equal(money(-98.7, true), "−$99");
  assert.equal(money(12_345), "$12.3K");
  assert.equal(money(254_000), "$254K");
  assert.equal(times(54.48), "54×");
  assert.equal(times(0.72), "0.7×");
  assert.equal(fmtMoney(null, 0.0516, true), "+0.0516 ETH", "no day's price: ETH");
});

test("the entry, the exit and the realised P&L, in dollars of each trade's day", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  assert.equal(m.w, 1080); assert.equal(m.h, 1920);
  assert.equal(m.entry.count, 2);
  assert.equal(m.entry.usd, 152);
  assert.equal(m.exit.usd, 54);
  assert.ok(Math.abs(m.realised.usd - (54 - 152 - 0.00002 * 1900)) < 1e-9, String(m.realised.usd));
  assert.ok(Math.abs(m.realised.eth - (0.0284 - 0.08 - 0.00002)) < 1e-12);
  assert.equal(m.holdStart, 1); assert.equal(m.holdEnd, 2); assert.equal(m.afterStart, 3);
  assert.equal(m.fills[2].index, 2, "the sell falls in the second held candle");
});

test("live P&L is what is held at the close, plus what came back, less what went in", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  const first = m.live[1];
  assert.ok(Math.abs(first.eth - (400_000 * 1.5e-7 - 0.08)) < 1e-12, String(first.eth));
  assert.ok(Math.abs(first.usd - first.eth * 1900) < 1e-9);
  assert.ok(Math.abs(first.multiple - 0.75) < 1e-12, "close over the average entry");
  const last = m.live[2];
  assert.ok(Math.abs(last.eth - (0.0284 - 0.08)) < 1e-12, "after the sell only the ETH back counts");
  assert.equal(m.live[0], null, "no P&L before the first buy");
});

test("if you held lands on the track record's estimate at today's candle", () => {
  const m = replayModel(row, reply, ADDR, "1:1");
  const today = m.ifHeld[m.candles.length - 1];
  assert.ok(Math.abs(today.eth - 1.5) < 1e-12, String(today.eth));
  assert.ok(Math.abs(today.usd - 1.5 * 2700) < 1e-9, "today at today's price");
  assert.ok(Math.abs(m.now.multiple - 1.5 / 0.0284) < 1e-9);
  assert.equal(m.missed, true);
});

test("the verdict line says what happened", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  assert.deepEqual(verdictLine(m), { text: "PAPERHANDED · 52× SINCE", color: "#ffb340" });
  assert.equal(verdictLine({ ...m, verdict: "fumble" }).text, "FUMBLED THE TOP");
  assert.equal(verdictLine({ ...m, holding: true }).text, "STILL HOLDING");
});

test("a position still held has no exit and nothing missed", () => {
  const held = replayModel({ ...row, verdict: "holding" },
    { ...reply, fills: reply.fills.filter((f) => f.kind === "buy"), segments: { ...reply.segments, after: [] } }, ADDR, "9:16");
  assert.equal(held.exit, null);
  assert.equal(held.missed, false);
  assert.equal(held.holding, true);
});

test("the timeline runs entry, movement, exit, what was missed, the result, then holds", () => {
  assert.equal(phaseAt(0.2).name, "intro");
  assert.equal(phaseAt(1.0).name, "entry");
  assert.equal(phaseAt(4.0).name, "move");
  assert.equal(phaseAt(6.5).name, "exit");
  assert.equal(phaseAt(8.0).name, "missed");
  assert.equal(phaseAt(10.0).name, "result");
  assert.equal(phaseAt(TIMELINE.total).name, "hold");
});

// ---- hosted (p-sell-verdict.md, P4b) ----

test("the video says you only on your own wallet", () => {
  const mine = replayModel(row, reply, ADDR, "9:16");
  assert.deepEqual(mine.words, { sold: "YOU SOLD HERE", held: "IF YOU HELD", got: "YOU GOT", since: "SINCE YOU SOLD" },
    "self's default is unchanged");
  const theirs = replayModel(row, reply, ADDR, "9:16", false);
  assert.deepEqual(theirs.words, { sold: "SOLD HERE", held: "IF HELD", got: "GOT", since: "SINCE THE SELL" });
  for (const w of Object.values(theirs.words)) assert.doesNotMatch(w, /\bYOU\b/);
});

test("a graduated token's line is not scaled to today; the move since is one step", () => {
  const plain = replayModel(row, reply, ADDR, "9:16");
  const grad = replayModel(row, { ...reply, graduatedAt: T0 + 41 * H }, ADDR, "9:16");
  const last = grad.candles[grad.candles.length - 1];
  const sold = 400_000;
  assert.ok(Math.abs(grad.ifHeld[grad.ifHeld.length - 1].eth - sold * last.c) < 1e-12, "the curve's own last value");
  assert.notEqual(plain.ifHeld[plain.ifHeld.length - 1].eth, grad.ifHeld[grad.ifHeld.length - 1].eth);
  assert.deepEqual(grad.graduation, { at: T0 + 41 * H, eth: sold * last.c, index: grad.candles.length - 1, nowPrice: 1.5 / sold },
    "the step goes to today's price per token of what was sold");
  assert.equal(grad.now.eth, 1.5, "today's value is still the ledger's");
  assert.equal(plain.graduation, null);
});

test("a hosted ledger row and /api/replay's reply make the same video", async () => {
  const { ledgerCardRow } = await import("../public/js/card/model.js");
  const E = 10n ** 18n;
  const p = {
    token: row.token, symbol: "AGI", openedAt: T0, costEth: "0", tokens: "0",
    realizedCostWei: String(8n * E / 100n), realizedWei: String(284n * E / 10000n), soldTokens: String(400_000n * E),
    confidence: "exact", closed: { at: T0 + H, reason: "sold", proceedsEth: "0", tokensSold: "0", tx: null },
    sellVerdict: "paperhand", soldNowEth: 1.5,
  };
  const m = replayModel(ledgerCardRow(p), { ...reply, best: null, graduatedAt: null }, ADDR, "1:1", false);
  assert.equal(m.w, 1080); assert.equal(m.h, 1080);
  assert.equal(m.symbol, "AGI"); assert.equal(m.venue, "clank.trade");
  assert.equal(m.verdict, "paperhand");
  assert.ok(m.missed && m.now.eth === 1.5 && Math.abs(m.now.multiple - 1.5 / 0.0284) < 1e-9);
  assert.equal(m.best, null, "no fumble star on hosted");
  assert.equal(m.words.held, "IF HELD");
});

// ---- the polish (p-sell-verdict.md, P4c) ----

test("a paperhand's result leads with the story: how many times over, since the sell", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  const st = story(m);
  assert.ok(Math.abs(st.multiple - 1.5 / 0.0284) < 1e-9);
  assert.equal(st.since, "SINCE YOU SOLD");
  assert.equal(st.now, money(1.5 * 2700));
  assert.equal(story(replayModel(row, reply, ADDR, "9:16", false)).since, "SINCE THE SELL");
  assert.equal(story({ ...m, verdict: "good" }), null, "a good sell leads with its P&L");
  assert.equal(story({ ...m, now: null }), null);
  assert.equal(story({ ...m, now: { ...m.now, multiple: 0.8 } }), null, "worth less now is no story");
});

test("a few cents either way is $0, never −$0", () => {
  assert.equal(money(-0.3, true), "$0");
  assert.equal(money(0.4, true), "$0");
  assert.equal(money(-0.6, true), "−$1");
});
