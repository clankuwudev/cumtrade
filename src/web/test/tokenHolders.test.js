// The token page's Holders tab (x25-batch2-token-page.md, X27b). The page
// reads /api/holders (X27a) and /healthz for how far the index is behind;
// here a stub server answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, checked as checkedRows, rows } from "../public/js/core/store.js";
import { checks, loadHolders, onTokenTrade, renderToken, setTokenTab } from "../public/js/pages/token.js";

const dom = stubDom();

const TOKEN = "0x00000000000000000000000000000000000070a1";
const CURVE = "0x000000000000000000000000000000000000c0e1";
const CREATOR = "0x000000000000000000000000000000000000c4ea";
const POOL = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const nowS = () => Math.floor(Date.now() / 1000);

const row = (over = {}) => ({
  token: TOKEN, curve: CURVE, creator: CREATOR,
  symbol: "TKN", name: "token", status: "ready", band: "CAUTION", score: 14, sellable: true, graduated: false, v4: null,
  fdvEth: 2.0, raised: 0.3, progress: 0.25, threshold: 4.2764, holders: 12, devBuyPct: 2, bundlePct: 1.5,
  tokensPerEth: 5e8, feeBps: 100, priorLaunches: 2, priorDead: 1, findings: [], top10Pct: 40,
  block: 100, launchedAt: nowS() - 600, ...over,
});

const holder = (over = {}) => ({
  address: A, balance: 20_000_000, pct: 2, firstAt: Date.now() - 5 * 60_000, firstIn: 20_000_000,
  roles: [], ethIn: 0.05, ethOut: 0, nowEth: 0.04, pnlEth: -0.01, ...over,
});
const answer = (rowsOf, over = {}) => [200, {
  token: TOKEN, asOfBlock: "999", supply: 1e9, holders: 37, top10Pct: 27.4, graduatedAt: null, pnl: "before gas",
  rows: rowsOf, ...over,
}];

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

function fresh(board = [row()], mode = "hosted") {
  dom.reset();
  rows.clear();
  checks.clear();
  checkedRows.clear();
  for (const r of board) rows.set(r.token.toLowerCase(), r);
  Object.assign(S, {
    mode, cfg: null, stats: { price: { ethUsd: 2000, stale: false } }, boardReady: true, connected: true,
    openToken: null, conn: null, wallet: null, heldFromLedger: null, tradeSide: "buy", customAmount: "", buySize: 0.01,
    hist: { points: [], since: null }, histFor: null, candles: null, tape: null, tapeUnseen: 0, holders: null, indexLag: null,
  });
  setTokenTab("check");
  S.openToken = TOKEN;
}

const page = () => {
  const markup = dom.el("#tokbody").markup;
  return { markup, text: textOf(markup) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const rowsOf = (markup) => markup.split('class="thr" role="row"').slice(1);

test("the Holders tab sits between Trades and Addresses, and reads the holders when opened", async () => {
  fresh();
  const asked = server({ "/api/holders": answer([holder()]), "/healthz": [200, { followerLagBlocks: 20 }] });
  renderToken();
  const ids = [...page().markup.matchAll(/data-ttab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["check", "trades", "holders", "addr", "pos"]);
  setTokenTab("holders");
  assert.match(page().text, /Loading holders…/);
  await tick(); await tick();
  assert.ok(asked.includes(`/api/holders?token=${TOKEN}&limit=50`), asked.join(" "));
  assert.match(page().markup, /role="table" aria-label="Holders of TKN"/);
});

test("over the table: how many hold it, the top 10's share, and that values are estimates before gas", async () => {
  fresh();
  server({ "/api/holders": answer([holder()]) });
  await loadHolders(TOKEN);
  setTokenTab("holders"); await tick(); await tick();
  const { markup, text } = page();
  assert.match(text, /37 holders · top 10 hold 27\.4% · values at spot, estimated · P&L before gas/);
  assert.match(markup, /role="columnheader">P&amp;L est\.</, "the column says it is an estimate");
  assert.match(markup, /title="Estimate: sold at spot, before price impact, fees and gas"/);
  assert.match(text, /The largest 1 of 37\./);
});

test("each role has its tag, with what it means and no more", async () => {
  fresh();
  server({
    "/api/holders": answer([
      holder({ address: CREATOR, roles: ["creator", "launch-block"], pnlEth: 0.02 }),
      holder({ address: A, roles: ["received"], ethIn: 0, nowEth: 0.03, pnlEth: 0.03 }),
      holder({ address: B, roles: [] }),
    ]),
  });
  setTokenTab("holders"); await tick(); await tick();
  const r = rowsOf(page().markup);
  assert.match(r[0], /<span class="ltag amb" title="The address that launched this token">creator<\/span>/);
  assert.match(r[0], /<span class="ltag lb" title="First held this token in the block it launched in">launch block<\/span>/);
  assert.match(r[0], /class="grn">\+0\.0200 Ξ</, "a gain is green, with its sign");
  assert.match(r[1], /ltag lb" title="Holds this token with no curve buy of its own\. That says nothing about who sent it">received</,
    "received says it is only a fact");
  assert.match(r[1], /\+0\.0300 Ξ/, "a received-only holder's P&L is what it is worth");
  assert.doesNotMatch(r[2], /ltag/, "an ordinary holder has no tag");
  assert.match(r[2], /class="red">−0\.0100 Ξ</, "a loss is red");
  assert.match(r[2], new RegExp(`href="#/portfolio/${B}"`), "each holder links to their Portfolio");
  assert.doesNotMatch(page().text, /insider|team|sniper|operator/i);
});

test("a graduated token: the pool is tagged and has no P&L, and the note says what is missing", async () => {
  fresh([row({ graduated: true, v4: { poolId: "0x1", liquidity: "1", lpFee: 0 } })]);
  server({
    "/api/holders": answer([
      holder({ address: POOL, pct: 16, roles: ["pool"], ethIn: null, ethOut: null, nowEth: null, pnlEth: null }),
      holder(),
    ], { graduatedAt: Date.UTC(2026, 8, 22, 12) }),
  });
  setTokenTab("holders"); await tick(); await tick();
  const { markup, text } = page();
  const pool = rowsOf(markup)[0];
  assert.match(pool, /ltag grad" title="The Uniswap V4 pool’s side of the market, not a position">pool</);
  assert.match(pool, /title="The pool holds liquidity, not a position"><span class="t3">—<\/span>/);
  assert.doesNotMatch(pool, /#\/portfolio\//, "the pool links to the explorer, not a Portfolio");
  assert.match(text, /P&L counts curve trades only: sells on Uniswap since Sep 22 are not here yet, so they still count as held\./);
});

test("no price: value and P&L read —, and the rest stands", async () => {
  fresh();
  server({ "/api/holders": answer([holder({ nowEth: null, pnlEth: null })]) });
  setTokenTab("holders"); await tick(); await tick();
  const r = rowsOf(page().markup)[0];
  assert.equal((r.match(/<span class="t3">—<\/span>/g) || []).length, 2);
  assert.match(r, /2\.00%/);
});

test("not indexed, an error, and nobody holding it yet each say so", async () => {
  fresh();
  server({ "/api/holders": [404, { indexed: false }] });
  setTokenTab("holders"); await tick(); await tick();
  assert.match(page().text, /Not indexed yet/);
  assert.doesNotMatch(page().text, /Nobody holds/);

  fresh();
  server({ "/api/holders": [502, {}] });
  setTokenTab("holders"); await tick(); await tick();
  assert.match(page().markup, /Could not load the holders\.[\s\S]*data-holders-retry/);

  fresh();
  server({ "/api/holders": answer([], { holders: 0, top10Pct: 0 }) });
  setTokenTab("holders"); await tick(); await tick();
  assert.match(page().text, /Nobody holds TKN outside its curve yet\./);
});

test("the 'as of' line shows only when the index is more than a minute behind", async () => {
  fresh();
  server({ "/api/holders": answer([holder()]), "/healthz": [200, { followerLagBlocks: 1500 }] });
  setTokenTab("holders"); await tick(); await tick(); await tick();
  assert.match(page().text, /As of 2m ago: the index is behind the chain, and catches up by itself\./);

  fresh();
  server({ "/api/holders": answer([holder()]), "/healthz": [200, { followerLagBlocks: 20 }] });
  setTokenTab("holders"); await tick(); await tick(); await tick();
  assert.doesNotMatch(page().text, /As of/);

  // A page with no /healthz (self) shows no line.
  fresh([row()], "self");
  server({ "/api/holders": answer([holder()]) });
  setTokenTab("holders"); await tick(); await tick(); await tick();
  assert.doesNotMatch(page().text, /As of/);
});

test("a live trade reads the holders again while the tab is open, not more than every 5 s", async () => {
  fresh();
  const asked = server({ "/api/holders": answer([holder()]) });
  setTokenTab("holders"); await tick(); await tick();
  const holdersAsked = () => asked.filter((u) => u.startsWith("/api/holders")).length;
  const first = holdersAsked();
  const trade = { token: TOKEN, tx: "0x1", block: 500, logIndex: 0, at: Date.now(), atEstimated: true, side: "buy", eth: 0.01, tokens: 1, price: 1e-8, trader: A, traderFromEvent: true };
  onTokenTrade(trade);
  onTokenTrade({ ...trade, tx: "0x2" });
  await tick();
  assert.equal(holdersAsked(), first, "opened just now: not read again within 5 s");
  setTokenTab("check");
  onTokenTrade({ ...trade, tx: "0x3" });
  assert.equal(holdersAsked(), first, "a closed tab reads nothing");
});

test("on a phone a holder is one line, the address, % and P&L, with its roles under the address", () => {
  const css = readFileSync(new URL("../public/phone.css", import.meta.url), "utf8");
  assert.match(css, /\.thr \.c-rank, \.thr \.c-first, \.thr \.c-now \{ display: none \}/);
  assert.match(css, /\.thr \.c-who \{ flex-direction: column; align-items: flex-start; gap: 5px; padding: 0 \}/);
  assert.match(css, /\.thrhd \{ display: none \}/);
});
