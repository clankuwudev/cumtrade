// The token page's Trades tab and its chart from every trade
// (x25-batch2-token-page.md, X25b). The page reads /api/trades and
// /api/candles (X25a) and takes live trades from /events; here a stub server
// answers, and the live trades are handed in as /events would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, checked as checkedRows, rows } from "../public/js/core/store.js";
import { checks, loadCandles, loadTape, onTokenTrade, renderToken, setTokenTab, tradeSeries } from "../public/js/pages/token.js";
import { onBoardEvent } from "../public/js/boardEvents.js";

const dom = stubDom();

const TOKEN = "0x00000000000000000000000000000000000070a1";
const OTHER = "0x00000000000000000000000000000000000070b2";
const CURVE = "0x000000000000000000000000000000000000c0e1";
const CREATOR = "0x000000000000000000000000000000000000c4ea";
const BUYER = "0x00000000000000000000000000000000000000b1";
const LAUNCH_BLOCK = 100;
const nowS = () => Math.floor(Date.now() / 1000);

const row = (over = {}) => ({
  token: TOKEN, curve: CURVE, creator: CREATOR,
  symbol: "TKN", name: "token", status: "ready", band: "CAUTION", score: 14, sellable: true, graduated: false, v4: null,
  fdvEth: 2.0, raised: 0.3, progress: 0.25, threshold: 4.2764, holders: 12, devBuyPct: 2, bundlePct: 1.5,
  tokensPerEth: 5e8, feeBps: 100, priorLaunches: 2, priorDead: 1, findings: [], top10Pct: 40,
  block: LAUNCH_BLOCK, launchedAt: nowS() - 600, ...over,
});

let seq = 0;
/** One tape row, as /api/trades and the trade event carry it. */
const trade = (over = {}) => {
  seq++;
  return {
    tx: "0x" + seq.toString(16).padStart(64, "0"), block: 200 + seq, logIndex: 0,
    at: Date.now() - 60_000, atEstimated: false, side: "buy", eth: 0.05, tokens: 19_400_000, price: 2.5e-9,
    trader: BUYER, traderFromEvent: false, ...over,
  };
};

/** A stub server: each path prefix answers with its [status, body]. Returns what was asked. */
function server(routes) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const hit = Object.entries(routes).find(([p]) => u.startsWith(p));
    const [status, body] = hit ? (typeof hit[1] === "function" ? hit[1](u) : hit[1]) : [404, {}];
    return { status, json: async () => body };
  };
  return asked;
}

function fresh(board = [row()]) {
  dom.reset();
  rows.clear();
  checks.clear();
  checkedRows.clear();
  for (const r of board) rows.set(r.token.toLowerCase(), r);
  Object.assign(S, {
    mode: "hosted", cfg: null, stats: { price: { ethUsd: 2000, stale: false } }, boardReady: true, connected: true,
    openToken: null, conn: null, wallet: null, heldFromLedger: null, tradeSide: "buy", customAmount: "", buySize: 0.01,
    hist: { points: [], since: null }, histFor: null, candles: null, tape: null, tapeUnseen: 0,
  });
  setTokenTab("check");
  S.openToken = TOKEN;
}

const page = () => {
  const markup = dom.el("#tokbody").markup;
  return { markup, text: textOf(markup) };
};

const tapeAnswer = (trades, over = {}) => [200, { token: TOKEN, asOfBlock: "999", graduatedAt: null, trades, next: null, ...over }];

test("the tabs are in the order the user chose, The check first", () => {
  fresh();
  renderToken();
  const ids = [...page().markup.matchAll(/data-ttab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["check", "trades", "holders", "addr", "pos"]);
  assert.match(page().markup, /id="tt-check" data-ttab="check"\s*aria-selected="true"/);
});

test("the Trades tab: loading, then the trades, newest first", async () => {
  fresh();
  let answer;
  const asked = server({ "/api/trades": () => answer, "/api/candles": [404, {}] });
  const gate = new Promise((r) => { answer = null; setTimeout(r, 0); });
  answer = tapeAnswer([trade({ block: 300, side: "sell", eth: 0.021, tokens: 8_350_000 }), trade({ block: 250 })]);
  const loading = loadTape(TOKEN);
  setTokenTab("trades");
  assert.match(page().text, /Loading trades…/);
  await loading; await gate;
  assert.ok(asked.some((u) => u === `/api/trades?token=${TOKEN}&limit=50`), asked.join(" "));
  const { markup, text } = page();
  assert.match(markup, /role="table" aria-label="Trades in TKN"/);
  const sides = [...markup.matchAll(/class="c-side (grn|red)" role="cell">(BUY|SELL)</g)].map((m) => m[2]);
  assert.deepEqual(sides, ["SELL", "BUY"], "newest first");
  assert.match(text, /0\.0210 Ξ/);
  assert.match(text, /8\.35M/);
  assert.match(text, /1m ago/);
  assert.match(markup, new RegExp(`href="#/portfolio/${BUYER}"`), "the trader links to their Portfolio");
  assert.doesNotMatch(markup, /data-tape-more/, "no more to load");
});

test("the Trades tab: not indexed yet says so, and never 'nothing'", async () => {
  fresh();
  server({ "/api/trades": [404, { error: "not indexed", indexed: false }] });
  setTokenTab("trades");
  await new Promise((r) => setTimeout(r, 0));
  const { text } = page();
  assert.match(text, /Not indexed yet/);
  assert.doesNotMatch(text, /No trades/);
});

test("the Trades tab: empty, an error with Try again, and Load more", async () => {
  fresh();
  server({ "/api/trades": tapeAnswer([]) });
  await loadTape(TOKEN);
  setTokenTab("trades");
  assert.match(page().text, /No trades in TKN yet\./);

  // Opening the tab asks; a failure offers Try again.
  fresh();
  const failed = server({ "/api/trades": [502, {}] });
  setTokenTab("trades");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(failed.filter((u) => u.startsWith("/api/trades")).length, 1);
  assert.match(page().markup, /Could not load the trades\.[\s\S]*data-tape-retry/);

  fresh();
  const asked = server({
    "/api/trades": (u) => (u.includes("before=") ? tapeAnswer([trade({ block: 210 })]) : tapeAnswer([trade({ block: 260 })], { next: "260:0" })),
  });
  await loadTape(TOKEN);
  setTokenTab("trades");
  assert.match(page().markup, /data-tape-more[^>]*>Load more</);
  await loadTape(TOKEN, "260:0");
  assert.ok(asked.some((u) => u.endsWith("&before=260%3A0")), asked.join(" "));
  assert.equal([...page().markup.matchAll(/class="ttr" role="row"/g)].length, 2, "the next page adds to the first");
});

test("the Trades tab: estimated times read 'just now', and the creator and launch-block buyers are tagged", async () => {
  fresh();
  server({
    "/api/trades": tapeAnswer([
      trade({ block: 400, atEstimated: true, at: Date.now() - 3_000, traderFromEvent: true }),
      trade({ block: LAUNCH_BLOCK, trader: CREATOR }),
      trade({ block: LAUNCH_BLOCK, trader: BUYER }),
    ]),
  });
  await loadTape(TOKEN);
  setTokenTab("trades");
  const { markup } = page();
  assert.match(markup, /title="Its block’s time is not read yet">just now</);
  const rowsOf = markup.split('class="ttr" role="row"').slice(1);
  assert.match(rowsOf[0], /ltag lb">launch block</, "a launch-block buyer is tagged on a later trade too");
  assert.match(rowsOf.find((r) => r.includes(CREATOR)), /ltag amb">creator</);
});

test("the Trades tab: a graduated token says the rest is on Uniswap", async () => {
  fresh([row({ graduated: true, v4: { poolId: "0x1", liquidity: "1", lpFee: 0 } })]);
  const at = Date.UTC(2026, 8, 22, 12);
  server({ "/api/trades": tapeAnswer([trade()], { graduatedAt: at }) });
  await loadTape(TOKEN);
  setTokenTab("trades");
  assert.match(page().text, /Trading on Uniswap since Sep 22\. Those trades are not here yet\./);
});

test("a live trade for this token goes to the top; one for another token does not", async () => {
  fresh();
  server({ "/api/trades": tapeAnswer([trade({ block: 250 })]) });
  await loadTape(TOKEN);
  setTokenTab("trades");
  const live = trade({ block: 500, side: "sell", eth: 0.0777 });
  onBoardEvent("trade", { token: TOKEN.toUpperCase().replace("0X", "0x"), ...live });
  onBoardEvent("trade", { token: OTHER, ...trade({ block: 600, eth: 0.0999 }) });
  onTokenTrade({ token: TOKEN, ...live });
  renderToken();
  const { markup, text } = page();
  assert.equal(S.tape.trades.length, 2, "the other token's is not kept, and the same trade twice is kept once");
  assert.match(markup.split('class="ttr" role="row"')[1], /0\.0777 Ξ/, "the live one is on top");
  assert.doesNotMatch(text, /0\.0999/);
  assert.doesNotMatch(markup, /id="tt-trades"[^>]*>Trades<span class="n">/, "no count while the tab is open");
});

test("while the Trades tab is closed, live trades count on it, and opening it clears the count", async () => {
  fresh();
  server({ "/api/trades": tapeAnswer([]) });
  renderToken();
  onTokenTrade({ token: TOKEN, ...trade() });
  onTokenTrade({ token: TOKEN, ...trade() });
  onTokenTrade({ token: OTHER, ...trade() });
  renderToken();
  assert.match(page().markup, /id="tt-trades"[^>]*>Trades<span class="n">2<\/span>/);
  setTokenTab("trades");
  assert.equal(S.tapeUnseen, 0);
  await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(page().markup, /Trades<span class="n">/);
});

test("the chart's note says where its line comes from", async () => {
  // Candles for a curve token: every trade since launch, ending on the board's live price.
  fresh();
  const t0 = Date.now() - 600_000;
  const candles = [
    { t0, t1: t0 + 300_000, o: 1.5e-9, h: 1.9e-9, l: 1.5e-9, c: 1.8e-9 },
    { t0: t0 + 300_000, t1: t0 + 600_000, o: 1.8e-9, h: 1.98e-9, l: 1.8e-9, c: 1.98e-9 },
  ];
  server({ "/api/candles": [200, { token: TOKEN, asOfBlock: "999", supply: 1e9, from: t0, to: t0 + 599_999, graduatedAt: null, candles }] });
  await loadCandles(TOKEN);
  renderToken();
  assert.match(page().text, /From every trade since launch/);
  const pts = tradeSeries(rows.get(TOKEN), t0 + 600_000);
  assert.deepEqual(pts.map((p) => +p[1].toFixed(3)), [1.5, 1.8, 1.98, 2], "closes × a billion, from the first open");
  assert.equal(pts[pts.length - 1][3], "live", "the last point is the board's live price");
  assert.equal(pts[pts.length - 1][1], 2.0);
  assert.match(page().text, /\+33\.3%/, "the move is measured from the launch's first price");

  // Not indexed: the sampled line and its own note.
  fresh();
  server({ "/api/candles": [404, { indexed: false }] });
  await loadCandles(TOKEN);
  S.hist = { points: [[nowS() - 60, 1.9, 0.2], [nowS(), 2.0, 0.3]], since: nowS() - 60, sampledOn: "trades", sampledMs: 120000 };
  S.histFor = TOKEN;
  renderToken();
  assert.match(page().text, /Recorded at each trade since \d\d:\d\d — not full trade history/);

  // Graduated: the V4 note, and no candles asked for.
  fresh([row({ graduated: true, v4: { poolId: "0x1", liquidity: "1", lpFee: 0 } })]);
  const asked = server({ "/api/candles": [200, { candles }] });
  await loadCandles(TOKEN);
  renderToken();
  assert.equal(asked.length, 0);
  assert.match(page().text, /Live price from the Uniswap V4 pool/);
});
