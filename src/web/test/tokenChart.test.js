// The candle chart's own rules (tv-candlestick-chart.md, TV2): how a value on
// its axis reads, and which candle size a token opens on. The drawing is
// Lightweight Charts', checked in a browser, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TFS, axisValue, setChartTf, tfFor } from "../public/js/pages/tokenChart.js";

test("a market cap reads as the board's figures do", () => {
  assert.equal(axisValue(9052, "mcap", 2700), "$9.1K");
  assert.equal(axisValue(1_234_567, "mcap", 2700), "$1.23M");
  assert.equal(axisValue(2.5e9, "mcap", 2700), "$2.50B");
  assert.equal(axisValue(512, "mcap", 2700), "$512");
  assert.equal(axisValue(12.345, "mcap", 2700), "$12.35");
  assert.equal(axisValue(0, "mcap", 2700), "$0");
});

test("a price per token keeps four significant digits, and counts long runs of zeros small", () => {
  // $0.000009052: five zeros after the point.
  assert.equal(axisValue(0.000009052, "price", 2700), "$0.0₅9052");
  // Trailing zeros of the four digits go.
  assert.equal(axisValue(0.0000027, "price", 2700), "$0.0₅27");
  // Three zeros or fewer are written out.
  assert.equal(axisValue(0.0001234, "price", 2700), "$0.0001234");
  assert.equal(axisValue(0.01234, "price", 2700), "$0.01234");
  // Rounding up to the next power of ten moves the zero count.
  assert.equal(axisValue(0.0000099996, "price", 2700), "$0.0₄1");
  // A price of a dollar or more reads as money.
  assert.equal(axisValue(3.5, "price", 2700), "$3.50");
  // Twelve zeros: two subscript digits.
  assert.equal(axisValue(1.5e-13, "price", 2700), "$0.0₁₂15");
});

test("with no ETH price, the axis stays in ETH", () => {
  assert.equal(axisValue(3.2, "mcap", null), "3.20 Ξ");
  assert.equal(axisValue(0.0000000031, "price", null), "0.0₈31 Ξ");
});

test("a young token opens on 1s candles, an older one on 1m, until a size is picked", () => {
  const now = Date.now() / 1000;
  assert.equal(tfFor({ launchedAt: now - 5 * 60 }), "1s");
  assert.equal(tfFor({ launchedAt: now - 30 * 60 }), "1m");
  assert.equal(tfFor({ launchedAt: 0 }), "1m");
  setChartTf("5m");
  assert.equal(tfFor({ launchedAt: now - 5 * 60 }), "5m");
  setChartTf("2m"); // not a size: ignored
  assert.equal(tfFor({ launchedAt: now - 5 * 60 }), "5m");
  assert.deepEqual(TFS, ["1s", "15s", "1m", "5m"]);
});

test("a live trade moves the last candle, or starts the next one, once", async () => {
  const T = "0x00000000000000000000000000000000000000c1";
  const MIN = 60_000, T0 = Date.UTC(2026, 8, 29, 8, 0);
  const was = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    asOfBlock: "1000", candles: [{ t: T0, o: 1e-6, h: 2e-6, l: 1e-6, c: 2e-6, v: 1 }],
  }), { status: 200 });
  try {
    const { loadFrames, onCandleTrade, setChartTf } = await import("../public/js/pages/tokenChart.js");
    setChartTf("1m");
    await loadFrames(T, "1m");
    const trade = (block, at, price, eth = 0.5) => ({ token: T, block, at, price, eth });
    // Already in the read: at or before its block.
    assert.equal(onCandleTrade(trade(1000, T0 + 30_000, 9e-6)), false);
    // The same minute: the last candle moves.
    assert.equal(onCandleTrade(trade(1001, T0 + 40_000, 3e-6)), true);
    // The next minute: a new candle, opening at the last close.
    assert.equal(onCandleTrade(trade(1002, T0 + MIN + 5_000, 2.5e-6, 0.25)), true);
    // Older than the last candle, no price, or another token: left to the next read.
    assert.equal(onCandleTrade(trade(1003, T0 + 10_000, 4e-6)), false);
    assert.equal(onCandleTrade(trade(1004, T0 + MIN + 6_000, null)), false);
    assert.equal(onCandleTrade({ ...trade(1005, T0 + MIN + 7_000, 4e-6), token: "0x" + "d".repeat(40) }), false);
    // The candles as the chart now draws them.
    const { candlesNow } = await import("../public/js/pages/tokenChart.js");
    assert.deepEqual(candlesNow(), [
      { t: T0, o: 1e-6, h: 3e-6, l: 1e-6, c: 3e-6, v: 1.5 },
      { t: T0 + MIN, o: 3e-6, h: 3e-6, l: 2.5e-6, c: 2.5e-6, v: 0.25 },
    ]);
  } finally {
    globalThis.fetch = was;
  }
});
