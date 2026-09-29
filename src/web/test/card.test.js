// What a share card says (docs/specs/share-cards.md, C2): the numbers, the
// verdict, clankchan's default reaction, and that every reaction the dialog
// offers is one the server will actually serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  FOOTER, REACTIONS, bigText, defaultArt, fmtEth, fmtMultiple, fmtUsd, historyCandles, ledgerCardRow, ledgerChart,
  recordCard, shortAddress, slug, tradeCard,
} from "../public/js/card/model.js";

const DAY = 86_400_000;
const ADDR = "0x00000000000000000000000000000000000000aa";

const row = (over = {}) => ({
  token: "0x00000000000000000000000000000000000000b1", symbol: "TKN", venue: null,
  first: 10 * DAY, last: 10 * DAY + 3600_000, buys: 1, sells: 1,
  ethSpent: 0.08, ethBack: 0.0284, gas: 0.00002, realised: -0.0516,
  soldNow: 1.3184, heldNow: 0, held: 0,
  bestExit: { eth: 3.1184, at: 28 * DAY, complete: true, swaps: 1 },
  paperhand: 1.29, fumble: 3.09, verdict: "paperhand", ...over,
});
const candles = { candles: [{ t0: 0, t1: 1, o: 1, h: 2, l: 1, c: 2 }], marks: [], best: { at: 28 * DAY, price: 2, eth: 3.1 } };

test("ETH reads with the places its size deserves", () => {
  assert.equal(fmtEth(3.1184), "3.12 ETH");
  assert.equal(fmtEth(0.1532), "0.153 ETH");
  assert.equal(fmtEth(0.02841), "0.0284 ETH");
  assert.equal(fmtEth(12.34), "12.3 ETH");
  assert.equal(fmtEth(-0.1531, true), "−0.153 ETH");
  assert.equal(fmtEth(0.0459, true), "+0.0459 ETH");
});

test("dollars need a price, and are whole", () => {
  assert.equal(fmtUsd(-0.1531, 2700, true), "−$413");
  assert.equal(fmtUsd(1, null), null);
});

test("a multiple reads whole when big, to one place when small", () => {
  assert.equal(fmtMultiple(47.6), "47×");
  assert.equal(fmtMultiple(2.44), "2.4×");
});

test("the short address is the one the dialog warns about", () => {
  assert.equal(shortAddress(ADDR), "0x0000…00aa");
});

test("a paperhand card leads with the multiple", () => {
  const c = tradeCard(row(), candles, ADDR, 2700);
  assert.equal(c.verdict.label, "PAPERHANDED");
  assert.equal(bigText(c.big), "46×");
  assert.match(c.sub, /sold for 0\.0284 ETH · worth 1\.32 ETH now/);
  assert.equal(c.art, "e06-screaming");
  assert.equal(c.chart.best.eth, 3.1);
  assert.equal(c.footer, FOOTER);
});

test("a small paperhand leads with the ETH it left instead", () => {
  const c = tradeCard(row({ soldNow: 0.04, ethBack: 0.03 }), candles, ADDR, null);
  assert.equal(bigText(c.big), "+0.0100 ETH");
  assert.equal(c.art, "e03-crying");
});

test("a fumble card leads with what the top would have paid over the sell", () => {
  const c = tradeCard(row({ verdict: "fumble", soldNow: 0.05, ethBack: 0.1195, bestExit: { eth: 0.3899, at: 25 * DAY } }),
    candles, ADDR, null);
  assert.equal(c.verdict.label, "FUMBLED THE TOP");
  assert.equal(bigText(c.big), "+0.270 ETH");
  assert.match(c.sub, /the top was 0\.390 ETH on/);
  assert.equal(c.art, "e02-hollow");
});

test("a good sell is smug in profit and deadpan at a loss", () => {
  assert.equal(tradeCard(row({ verdict: "good", realised: 0.0241 }), candles, ADDR, null).art, "e05-smug");
  assert.equal(tradeCard(row({ verdict: "good", realised: -0.0007 }), candles, ADDR, null).art, "e07-deadpan");
});

test("the headline counts up from nothing", () => {
  const c = tradeCard(row({ verdict: "good", realised: 0.0241 }), candles, ADDR, null);
  assert.equal(bigText(c.big, 0), "+0.0000 ETH");
  assert.equal(bigText(c.big, 1), "+0.0241 ETH");
});

test("the record card", () => {
  const rec = {
    address: ADDR,
    totals: { positions: 17, spent: 0.8148, back: 0.6668, gas: 0.0052, realised: -0.1531 },
    judged: { paperhanded: 1.49, fumbled: 4.02, worthIfHeld: 1.80 },
    positions: [row({ first: 10 * DAY }), row({ first: 20 * DAY, last: 45 * DAY })],
  };
  const c = recordCard(rec, { candles: [] }, 2700);
  assert.equal(c.kicker, "TRACK RECORD · 17 POSITIONS");
  assert.equal(bigText(c.big), "−0.153 ETH");
  assert.deepEqual(c.stats.map((s) => s.value), ["+1.49 ETH", "+4.02 ETH", "1.80 ETH"]);
  assert.ok(c.stats.every((s) => s.est), "every judged figure is marked est.");
  assert.equal(c.art, "e04-sweating", "down, with more fumbled than lost");
  assert.equal(defaultArt({ kind: "record", net: 0.2, fumbled: 5 }), "e12-laughing");
  assert.equal(defaultArt({ kind: "record", net: -0.2, fumbled: 0.1 }), "e02-hollow");
  assert.equal(slug(c), "clank-uwu-model-track-record");
});

// Both modes serve the reactions (P3), from web/public/art/, which a release
// serves under /v/<sha>/art/.
const PUBLIC_ROUTES = new URL("../../server/routes/public.ts", import.meta.url);
test("every reaction the dialog offers is one the server serves, and its picture is in the tree", () => {
  const routes = readFileSync(PUBLIC_ROUTES, "utf8");
  const allowed = routes.match(/export const ART_ALLOWED = new Set\(\[([\s\S]*?)\]\)/)[1];
  for (const [name] of REACTIONS) {
    assert.ok(allowed.includes(`"${name}"`), `${name} is not served`);
    assert.ok(existsSync(new URL(`../public/art/${name}.webp`, import.meta.url)), `${name}.webp is missing`);
  }
  assert.equal((allowed.match(/"e\d\d-[a-z]+"/g) ?? []).length, REACTIONS.length);
});

// ---- the hosted Portfolio's card (p-sell-verdict.md, P3) ----

const E = 10n ** 18n;
/** A closed /api/ledger position: 0.02 ETH for 1M tokens, sold for 0.03 ETH, worth 2.4 ETH today. */
const ledgerPos = (over = {}) => ({
  token: "0x00000000000000000000000000000000000000c1", symbol: "AGI", openedAt: 10 * DAY,
  costEth: "0", tokens: "0", realizedCostWei: String(E / 50n), realizedWei: String((3n * E) / 100n),
  soldTokens: String(1_000_000n * E), confidence: "exact",
  closed: { at: 10 * DAY + 3600_000, reason: "sold", proceedsEth: String((3n * E) / 100n), tokensSold: String(1_000_000n * E), tx: null },
  sellVerdict: "paperhand", soldNowEth: 2.4, ...over,
});

test("a ledger position becomes the track record's row: the sell, what went in for it, no best exit", () => {
  const r = ledgerCardRow(ledgerPos());
  assert.equal(r.verdict, "paperhand");
  assert.equal(r.ethSpent, 0.02);
  assert.equal(r.ethBack, 0.03);
  assert.ok(Math.abs(r.realised - 0.01) < 1e-12);
  assert.equal(r.soldNow, 2.4);
  assert.equal(r.bestExit, null);
  assert.equal(r.venue, "clank");
  assert.equal(r.last - r.first, 3600_000);
  const c = tradeCard(r, ledgerChart(ledgerPos(), null, 11 * DAY), ADDR, 2700);
  assert.equal(c.verdict.label, "PAPERHANDED");
  assert.equal(bigText(c.big), "80×");
  assert.match(c.sub, /sold for 0\.0300 ETH · worth 2\.40 ETH now/);
  assert.equal(c.kicker, "AGI · CLANK.TRADE");
  assert.equal(c.chart.best, null, "no fumble star on hosted");
});

test("a good sell and one that cannot be priced read as the track record's do", () => {
  const good = tradeCard(ledgerCardRow(ledgerPos({ sellVerdict: "good", soldNowEth: 0.01 })), { candles: [], marks: [] }, ADDR, null);
  assert.equal(good.verdict.label, "GOOD SELL");
  assert.match(good.sub, /^\+50\.0% · sold for 0\.0300 ETH · worth 0\.0100 ETH now$/);
  const unpriced = tradeCard(ledgerCardRow(ledgerPos({ sellVerdict: "unpriced", soldNowEth: null })), { candles: [], marks: [] }, ADDR, null);
  assert.equal(unpriced.verdict.label, "CLOSED");
  assert.doesNotMatch(unpriced.sub, /worth/);
});

test("the buy and the sell are marked at their prices, per token", () => {
  const { marks } = ledgerChart(ledgerPos(), null);
  assert.deepEqual(marks.map((m) => m.kind), ["buy", "sell"]);
  assert.ok(Math.abs(marks[0].price - 0.02 / 1e6) < 1e-15);
  assert.ok(Math.abs(marks[1].price - 0.03 / 1e6) < 1e-15);
  // A partly sold open position: bought is what is held plus what was sold, and there is no close.
  const open = ledgerChart(ledgerPos({ closed: undefined, tokens: String(1_000_000n * E), costEth: String(E / 50n) }), null);
  assert.deepEqual(open.marks.map((m) => m.kind), ["buy"]);
  assert.ok(Math.abs(open.marks[0].price - 0.04 / 2e6) < 1e-15);
});

test("the chart is drawn only where the site's history reaches back to the buy", () => {
  const t = (ms) => Math.round(ms / 1000);
  const open = 10 * DAY, now = 11 * DAY;
  // Market caps in ETH, which is price × 1e9 tokens.
  const covering = { points: [[t(open - 60_000), 20, 1], [t(open + 3600_000), 30, 1], [t(now - 60_000), 2400, 1]] };
  const drawn = ledgerChart(ledgerPos(), covering, now);
  assert.ok(drawn.candles.length > 0 && drawn.candles.length <= 48);
  assert.ok(Math.abs(drawn.candles[drawn.candles.length - 1].c - 2400 / 1e9) < 1e-18, "the last close is today's price");
  assert.ok(drawn.candles.every((c) => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)));
  const late = { points: [[t(open + 3600_000), 30, 1], [t(now - 60_000), 2400, 1]] };
  assert.equal(ledgerChart(ledgerPos(), late, now).candles.length, 0, "starts after the buy: no partial chart");
  assert.equal(ledgerChart(ledgerPos(), { points: [] }, now).candles.length, 0);
});

test("candles carry the last close across a quiet stretch", () => {
  const cs = historyCandles([[0, 1e9, 0], [10, 3e9, 0]], 0, 20_000, 4);
  assert.deepEqual(cs.map((c) => c.c), [1, 1, 3, 3]);
  assert.equal(cs[2].o, 1, "opens where the last closed, so the gap shows as a move");
});
