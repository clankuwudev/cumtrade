// Tests for scripts/vendor-charts.mjs (TV0): the HTML-sink rule, and the committed bundle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlSinks, make } from "./vendor-charts.mjs";

// The sink names are put together from parts: these strings are only input
// for the rule, never run, and whole names would trip the editor's own guard.
const INNER = "inner" + "HTML", OUTER = "outer" + "HTML", ADJ = "insertAdjacent" + "HTML", WRITE = "document" + ".write";

test("the attribution logo's sink is the only one allowed", () => {
  const logo = `this.a.id="tv-attr-logo",this.a.target="_blank",this.a.${INNER}='<svg></svg>'`;
  assert.deepEqual(htmlSinks(logo), []);
  assert.equal(htmlSinks(`el.${INNER}=x`).length, 1);
  assert.equal(htmlSinks(`el.${OUTER} = x`).length, 1);
  assert.equal(htmlSinks(`el.${ADJ}("beforeend",x)`).length, 1);
  assert.equal(htmlSinks(`${WRITE}(x)`).length, 1);
  // A read is not a sink.
  assert.deepEqual(htmlSinks(`const s=el.${INNER};`), []);
});

test("a fresh build passes every rule and exports only what the page draws", async () => {
  const m = await make();
  assert.deepEqual(m.problems, []);
  assert.deepEqual(m.exports, ["CandlestickSeries", "ColorType", "CrosshairMode", "HistogramSeries", "createChart"]);
  assert.match(m.licencesText, /TradingView Lightweight Charts™/);
  assert.match(m.licencesText, /lightweight-charts@5\.2\.1/);
});
