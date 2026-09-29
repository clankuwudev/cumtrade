// The share videos' soundtrack (docs/specs/trade-replay.md, V4): that every
// sound lands on the beat the picture draws it on. The synthesis itself needs
// Web Audio, so it is checked in the browser; this checks the score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEATS, MOTION_MS, cardCandleTimes } from "../public/js/card/draw.js";
import { tradeCard } from "../public/js/card/model.js";
import { replayCandleTimes } from "../public/js/card/replay.js";
import { TIMELINE, replayModel } from "../public/js/card/replayModel.js";
import { cardScore, replayScore, stingerFor } from "../public/js/card/sound.js";

const H = 3600_000;
const T0 = Date.UTC(2026, 7, 17, 17);
const c = (i, o, h, l, cl) => ({ t0: T0 + i * H, t1: T0 + (i + 1) * H, o, h, l, c: cl });
const reply = {
  segments: {
    before: [c(-1, 2e-7, 2e-7, 2e-7, 2e-7)],
    holding: [c(0, 2e-7, 3e-7, 1.5e-7, 1.5e-7), c(1, 1.5e-7, 1.6e-7, 0.7e-7, 0.72e-7)],
    after: [c(2, 0.72e-7, 5e-7, 0.7e-7, 4e-7), c(40, 4e-7, 1e-5, 4e-7, 3.9e-6)],
  },
  fills: [
    { kind: "buy", at: T0 + 60_000, eth: 0.08, tokens: 400_000, price: 2e-7, usd: 152 },
    { kind: "sell", at: T0 + H + 1800_000, eth: 0.0284, tokens: 400_000, price: 0.71e-7, usd: 54 },
  ],
  gasEth: 0.00002,
  best: { at: T0 + 40 * H, eth: 3.1184, usd: 7661, price: 1e-5 },
  soldNow: 1.5, heldNow: 0, usdNow: 2700,
  usdDay: { "2026-08-17": 1900, "2026-08-18": 1950 },
};
const row = {
  token: "0x00000000000000000000000000000000000000b1", symbol: "TKN", venue: null, verdict: "paperhand",
  first: T0, last: T0 + H, soldNow: 1.5, heldNow: 0, realised: -0.0516, ethBack: 0.0284,
};
const ADDR = "0x00000000000000000000000000000000000000aa";

const within = (t, [a, b]) => t >= a && t <= b;
const of = (score, kind) => score.cues.filter((q) => q.kind === kind);

test("each replay candle starts to sound when it starts to show", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  const ts = replayCandleTimes(m);
  assert.equal(ts.length, m.candles.length);
  assert.ok(ts.every((t) => t !== null && t >= 0 && t <= TIMELINE.end), JSON.stringify(ts));
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], `candle ${i} shows before candle ${i - 1}`);
});

test("the replay's cues sit in their phases", () => {
  const m = replayModel(row, reply, ADDR, "9:16");
  const s = replayScore(m);
  assert.equal(s.seconds, TIMELINE.total);
  assert.ok(s.cues.every((q) => q.t >= 0 && q.t + (q.dur ?? 0) <= TIMELINE.total), "every cue ends before the video does");
  assert.equal(of(s, "ping").length, 3);
  assert.ok(of(s, "ping").every((q) => within(q.t, TIMELINE.entry)));
  assert.ok(within(of(s, "press")[0].t, TIMELINE.entry));

  // A blip for every candle that appears once the price starts to move. The
  // entry's candle appears during the entry, which the BUY press marks, and
  // the one before it is scenery. The ones after the sell are ghosts, as
  // they are drawn.
  const ts = replayCandleTimes(m);
  const blips = of(s, "blip");
  assert.equal(ts[1] < TIMELINE.move[0], true, "the fixture's entry candle shows during the entry");
  assert.equal(blips.length, 3);
  assert.deepEqual(blips.map((q) => q.t), ts.slice(2));
  assert.deepEqual(blips.map((q) => q.ghost), [false, true, true]);
  assert.ok(blips.every((q) => Number.isInteger(q.semi) && q.semi >= 0 && q.semi <= 19));
  assert.equal(blips[2].semi, 19, "the highest close is the highest note");
  assert.deepEqual(blips.map((q) => q.up), [false, true, true]);

  assert.ok(within(of(s, "cash")[0].t, TIMELINE.exit), "the sell rings the till");
  assert.ok(within(of(s, "riser")[0].t, TIMELINE.missed), "what was missed rises");
  assert.ok(within(of(s, "impact")[0].t, TIMELINE.result));
  assert.ok(of(s, "tick").every((q) => within(q.t, TIMELINE.result)), "the number counts up in the result");
  const [st] = of(s, "stinger");
  assert.ok(within(st.t, TIMELINE.result));
  assert.equal(st.verdict, "paperhand");
});

test("a position still held gets no till, no riser, and the holding stinger", () => {
  const held = { ...reply, fills: [reply.fills[0]], segments: { ...reply.segments, after: [] }, best: null };
  const m = replayModel({ ...row, verdict: null, soldNow: null, heldNow: 0.05 }, held, ADDR, "1:1");
  const s = replayScore(m);
  assert.equal(of(s, "cash").length, 0);
  assert.equal(of(s, "riser").length, 0);
  assert.equal(of(s, "stinger")[0].verdict, "holding");
});

test("the stinger follows the verdict, and the P&L when there is none", () => {
  assert.equal(stingerFor("fumble", false, -1), "fumble");
  assert.equal(stingerFor("good", false, 1), "good");
  assert.equal(stingerFor("paperhand", false, 1), "paperhand");
  assert.equal(stingerFor(null, true, 0), "holding");
  assert.equal(stingerFor(null, false, 0.01), "good");
  assert.equal(stingerFor(null, false, -0.01), "paperhand");
});

test("the card's cues sit on its beats, and 48 candles do not buzz", () => {
  const candles = Array.from({ length: 48 }, (_, i) => ({ t0: i, t1: i + 1, o: 1 + i, h: 2 + i, l: 1 + i, c: 2 + i }));
  const card = tradeCard(
    { token: "0x00000000000000000000000000000000000000b1", symbol: "TKN", venue: null, first: 0, last: H, buys: 1, sells: 1,
      ethSpent: 0.08, ethBack: 0.0284, gas: 0.00002, realised: -0.0516, soldNow: 1.3, heldNow: 0, held: 0,
      bestExit: { eth: 3.1, at: 2 * H, complete: true, swaps: 1 }, paperhand: 1.29, fumble: 3.09, verdict: "fumble" },
    { candles, marks: [], best: null }, ADDR, 2000);
  const s = cardScore(card, 8000);
  const at = (f) => (f * MOTION_MS) / 1000;
  assert.equal(s.seconds, 8);
  const blips = of(s, "blip");
  assert.ok(blips.length > 0 && blips.length <= 24, String(blips.length));
  const times = cardCandleTimes(48);
  assert.ok(blips.every((q) => times.includes(q.t)), "a blip is a candle appearing");
  assert.ok(blips.every((q) => within(q.t, [at(BEATS.candles[0]), at(BEATS.candles[1])])));
  assert.ok(of(s, "tick").every((q) => within(q.t, [at(BEATS.count[0]), at(BEATS.count[1])])));
  assert.equal(of(s, "impact")[0].t, at(BEATS.verdict[0]));
  assert.equal(of(s, "stinger")[0].verdict, "fumble");
  assert.ok(s.cues.every((q) => q.t + (q.dur ?? 0) <= s.seconds));
});
