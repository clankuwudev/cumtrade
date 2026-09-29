// The Traders page and a Portfolio's rank (x29-leaderboard.md, X29b). The
// page reads /api/leaders (X29a) and /healthz for how far the index is
// behind; here a stub server answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { CONTACT } from "../public/js/core/constants.js";
import {
  forgetLeaders, loadRank, openTraders, rankLine, rankText, retryTraders, setTradersWindow,
} from "../public/js/pages/traders.js";
import { openLookup } from "../public/js/pages/positionsLookup.js";

const dom = stubDom();
globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = url; } };

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

const leader = (over = {}) => ({
  rank: 1, address: A, realizedPnlEth: 0.682, realizedEth: 2.914, costEth: 2.232, gasEth: 0.00052,
  closed: 25, wins: 14, winRate: 0.56, unknownProceeds: 0, paperhandRate: 0.2, paperhandOf: 25,
  lastClosedAt: Date.now() - 3 * 3_600_000, ...over,
});
const answer = (rowsOf, over = {}) => [200, {
  window: "7d", asOfBlock: "999", builtAt: Date.now() - 20_000, traders: 420, eligible: rowsOf.length, minClosed: 5,
  pnl: "after fees, before gas", rows: rowsOf, ...over,
}];

const standing = (w7, all, over = {}) => ({
  address: A, asOfBlock: "999", builtAt: Date.now(),
  windows: [
    { window: "7d", rank: w7.rank, closed: w7.closed, minClosed: 5 },
    { window: "30d", rank: all.rank, closed: all.closed, minClosed: 5 },
    { window: "all", rank: all.rank, closed: all.closed, minClosed: 5 },
  ], ...over,
});

/** A stub server: each path prefix answers with its [status, body]. Returns what was asked. */
function server(routes) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const hit = Object.entries(routes).find(([p]) => u.startsWith(p));
    const [status, body] = hit ? (typeof hit[1] === "function" ? hit[1](u) : hit[1]) : [404, {}];
    return { status, json: async () => body, headers: { get: () => null } };
  };
  return asked;
}

function fresh() {
  dom.reset();
  forgetLeaders();
  Object.assign(S, { mode: "hosted", leaders: { window: "7d", state: "idle", data: null }, rank: null, indexLag: null });
}

const page = () => {
  const markup = dom.el("#trpage").markup;
  return { markup, text: textOf(markup) };
};
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/** The ranked rows (not the head row): each is a link, so it carries an href. */
const rowsOf = (markup) => markup.split(/<a class="trr[^"]*" role="row"/).slice(1);

// ------------------------------------------------------------- the page --

test("opening the page reads 7 days, and shows Loading until it answers", async () => {
  fresh();
  let answerNow;
  const asked = server({
    "/api/leaders": () => answerNow,
    "/healthz": [200, { followerLagBlocks: 20 }],
  });
  answerNow = answer([leader()]);
  const p = openTraders();
  assert.match(page().text, /Loading traders…/);
  await p; await tick();
  assert.ok(asked.includes("/api/leaders?window=7d&limit=100"), asked.join(" "));
  assert.match(page().markup, /role="table" aria-label="Traders ranked by realised P&amp;L, 7 days"/);
  assert.match(page().markup, /data-traders-window="7d" aria-pressed="true"/);
  assert.match(page().markup, /data-traders-window="all" aria-pressed="false"/);
});

test("over the table: how many are ranked, in which window, of how many traded, and when", async () => {
  fresh();
  server({ "/api/leaders": answer([leader(), leader({ rank: 2, address: B })], { eligible: 36 }) });
  await openTraders(); await tick();
  assert.match(page().text, /36 traders with at least 5 closed positions in the last 7 days ?, of 420 who traded · as of 20 seconds ago/);
});

test("each row: rank, the address to its Portfolio, P&L with its sign and colour, closed, win rate, paperhand, last closed", async () => {
  fresh();
  server({
    "/api/leaders": answer([
      leader(),
      leader({ rank: 2, address: B, realizedPnlEth: -0.0123, wins: 1, closed: 5, winRate: 0.2, unknownProceeds: 3,
        paperhandRate: null, paperhandOf: 0 }),
    ]),
  });
  S.stats = { price: { ethUsd: 2000, stale: false } };
  await openTraders(); await tick();
  const [r1, r2] = rowsOf(page().markup);
  assert.match(r1, new RegExp(`^ href="#/portfolio/${A}" title="Open ${A}’s Portfolio">`), "the whole row opens its Portfolio");
  assert.match(r1, /<span class="c-rank" role="cell"><span class="rk">1<\/span>/);
  assert.match(r1, /class="mo grn">\+0\.6820 Ξ<\/b><small>\+\$1\.4K<\/small>/, "a gain is green, with its sign, and in dollars");
  assert.match(r1, /title="After fees, before gas\. Gas: 0\.00052 Ξ"/);
  assert.match(textOf(r1), /Closed 25/);
  assert.match(r1, /title="14 of 25 made money"><span class="k">Win rate <\/span><i class="mbar g" aria-hidden="true"><i style="width:56%"><\/i><\/i><span class="pv">56%<\/span>/);
  assert.match(r1, /title="Of 25 sells priced now, 5 would fetch at least 10% more today than they got"><i class="mbar a"[^>]*><i style="width:20%"><\/i><\/i><span class="pv">20%<\/span></);
  assert.match(textOf(r1), /20% 3h 0m ago/);
  assert.match(r2, /class="mo red">−0\.0123 Ξ<\/b><small>−\$[0-9.]+<\/small>/, "a loss is red, in dollars too");
  assert.match(r2, /class="unk" title="3 more positions left the wallet without a curve sale[^"]*not counted">\+3</, "unknown proceeds are counted, and say why");
  assert.match(r2, /title="No sell of these could be priced now">—</, "no priced sell reads —");
  S.stats = null;
});

test("the first three ranks are marked, and without an ETH price there is no dollar figure", async () => {
  fresh();
  S.stats = null;
  server({ "/api/leaders": answer([1, 2, 3, 4].map((rank) => leader({ rank, address: "0x" + String(rank).padStart(40, "0") }))) });
  await openTraders(); await tick();
  const rs = rowsOf(page().markup);
  assert.equal(rs.length, 4);
  assert.match(page().markup, /<a class="trr top1" role="row"/);
  assert.match(page().markup, /<a class="trr top2" role="row"/);
  assert.match(page().markup, /<a class="trr top3" role="row"/);
  assert.match(page().markup, /<a class="trr" role="row" href="#\/portfolio\/0x0{39}4"/, "the fourth is not");
  assert.doesNotMatch(page().markup, /<small>/);
});

test("your own wallet: its row is marked You, and its rank is said over the table", async () => {
  fresh();
  const saved = { conn: S.conn, trading: S.trading, login: S.login };
  try {
    Object.assign(S, { conn: { address: B, chainId: 4663, balanceWei: "0" }, trading: null, login: { ...S.login, here: false } });
    server({
      "/api/leaders?address=": [200, standing({ rank: 2, closed: 5 }, { rank: 9, closed: 12 }, { address: B })],
      "/api/leaders?window=": answer([leader(), leader({ rank: 2, address: B })]),
    });
    await openTraders(); await tick(6);
    const [r1, r2] = rowsOf(page().markup);
    assert.doesNotMatch(r1, /ltag you/);
    assert.match(page().markup, /<a class="trr top2 me" role="row"/);
    assert.match(r2, /<span class="ltag you">You<\/span>/);
    assert.match(page().text, /You #2 over 7 days · #9 all time/);
    assert.ok(page().markup.includes(`<p class="tryou"><span class="ltag you">You</span> <a href="#/portfolio/${B}">`),
      "your rank links to your Portfolio");
  } finally {
    Object.assign(S, saved);
  }
});

test("under the table: past P&L only, not advice; before gas; and how to be taken off", async () => {
  fresh();
  server({ "/api/leaders": answer([leader()]) });
  await openTraders(); await tick();
  const { markup, text } = page();
  assert.match(text, /Past P&L on this venue’s curves only, from the chain, for each address alone\. Automated, not advice\./);
  assert.match(text, /P&L is after fees, before gas\./);
  assert.match(text, /A \+N beside Closed is positions that left the wallet without a curve sale/);
  assert.match(text, /Some addresses are not ranked\. To take yours off, write to /);
  assert.ok(markup.includes(`<a href="${CONTACT.href}" target="_blank" rel="noopener noreferrer">${CONTACT.label}</a>`));
  assert.doesNotMatch(text, /\bsafe\b|\binsider|\bsmart money|\bcopy (this|them)|\bfollow\b/i, "no word that invites copying");
});

test("the window switch reads that window, lights it, and says it; all time says no window", async () => {
  fresh();
  const asked = server({
    "/api/leaders?window=7d": answer([leader()]),
    "/api/leaders?window=30d": answer([leader({ realizedPnlEth: 0.9 })], { window: "30d", eligible: 42, traders: 518 }),
    "/api/leaders?window=all": answer([leader()], { window: "all", eligible: 42, traders: 518 }),
  });
  await openTraders(); await tick();
  await setTradersWindow("30d"); await tick();
  assert.ok(asked.includes("/api/leaders?window=30d&limit=100"));
  assert.match(page().markup, /data-traders-window="30d" aria-pressed="true"/);
  assert.match(page().text, /42 traders with at least 5 closed positions in the last 30 days ?, of 518 who traded/);
  assert.match(page().markup, /\+0\.9000 Ξ/);
  await setTradersWindow("all"); await tick();
  assert.match(page().text, /42 traders with at least 5 closed positions ?, of 518 who traded/);
  // Back to 7 days: the answer in hand, not asked again inside the minute.
  const before = asked.filter((u) => u.includes("window=7d")).length;
  await setTradersWindow("7d"); await tick();
  assert.equal(asked.filter((u) => u.includes("window=7d")).length, before);
  assert.match(page().markup, /data-traders-window="7d" aria-pressed="true"/);
  await setTradersWindow("1d");
  assert.match(page().markup, /data-traders-window="7d" aria-pressed="true"/, "an unknown window changes nothing");
});

test("empty, not indexed, and an error with Try again", async () => {
  fresh();
  server({ "/api/leaders": answer([], { eligible: 0 }) });
  await openTraders(); await tick();
  assert.match(page().text, /0 traders with at least 5 closed positions in the last 7 days ?, of 420 who traded/);
  assert.match(page().text, /Nobody has 5 closed positions in the last 7 days yet\./);
  assert.doesNotMatch(page().markup, /role="table"/, "the list is never padded");

  fresh();
  server({ "/api/leaders": [404, { error: "not indexed", indexed: false }] });
  await openTraders(); await tick();
  assert.match(page().text, /Not indexed yet The index has not read the chain’s trades yet\./);

  fresh();
  let status = 500;
  server({ "/api/leaders": () => (status === 500 ? [500, {}] : answer([leader()])) });
  await openTraders(); await tick();
  assert.match(page().markup, /Could not load the traders\.[\s\S]*data-traders-retry>Try again</);
  status = 200;
  await retryTraders(); await tick();
  assert.equal(rowsOf(page().markup).length, 1);
});

test("the as-of line when the index is more than a minute behind", async () => {
  fresh();
  server({ "/api/leaders": answer([leader()]), "/healthz": [200, { followerLagBlocks: 1_800 }] });
  await openTraders(); await tick(5);
  assert.match(page().text, /As of 3m ago: the index is behind the chain, and catches up by itself\./);
});

test("the page is hosted only, and in the top bar and the phone's bar after Portfolio", () => {
  const APP_HTML = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
  assert.match(APP_HTML, /<section class="pg" id="pg-traders" data-hosted-only>\s*<div class="page trpage" id="trpage"><\/div>/);
  const top = APP_HTML.slice(APP_HTML.indexOf('<nav class="tnav"'));
  assert.match(top, /data-nav="portfolio" data-self-only>Positions<\/a>\s*<a href="#\/traders" data-nav="traders" data-hosted-only>Traders<\/a>\s*<a href="#\/learn/);
});

test("on a phone: rank, address and P&L on one line, closed and win rate under, the rest hidden", () => {
  const PHONE = readFileSync(new URL("../public/phone.css", import.meta.url), "utf8");
  const at = PHONE.indexOf(".trrhd { display: none }");
  assert.ok(at > 0, "the head row goes");
  const block = PHONE.slice(at, PHONE.indexOf(".trhead .trwin", at));
  for (const [cls, col, row] of [["rank", "1", 1], ["who", "2", 1], ["pnl", "3", 1], ["closed", "2", 2], ["win", "3", 2]]) {
    assert.match(block, new RegExp(`\\.trr \\.c-${cls} \\{ grid-column: ${col}; grid-row: ${row}`), cls);
  }
  assert.match(block, /\.trr \.c-paper, \.trr \.c-last \{ display: none \}/);
  assert.match(block, /\.trr \.k \{ display: inline \}/, "the labels show where the head row does not");
});

// ------------------------------------------------------- a Portfolio's rank --


test("a Portfolio's rank, in each case", () => {
  assert.equal(rankText(standing({ rank: 7, closed: 9 }, { rank: 12, closed: 20 })), "#7 over 7 days · #12 all time");
  assert.equal(rankText(standing({ rank: null, closed: 2 }, { rank: 12, closed: 20 })), "#12 all time");
  assert.equal(rankText(standing({ rank: null, closed: 3 }, { rank: null, closed: 3 })), "5 closed positions to be ranked · 3 so far",
    "below the floor");
  assert.equal(rankText(standing({ rank: null, closed: null }, { rank: null, closed: null })), "", "not ranked at all: nothing");
  assert.equal(rankText(standing({ rank: null, closed: 0 }, { rank: null, closed: 0 })), "", "nothing closed: nothing");
  assert.equal(rankText(null), "");
});

test("the Portfolio reads its address's rank and shows it under the heading, linking to Traders", async () => {
  dom.reset();
  const asked = server({
    "/api/leaders?address=": [200, standing({ rank: 7, closed: 9 }, { rank: 12, closed: 20 })],
    "/api/ledger": [200, { address: A, asOfBlock: "999", builtAt: Date.now(), partial: false, omittedTokens: [], open: [], closed: [],
      totals: { realizedEth: 0, realizedPnlEth: 0, openValueEth: 0, openCostEth: 0, excluded: 0 } }],
  });
  const saved = { mode: S.mode, conn: S.conn, trading: S.trading, lookup: S.lookup, rank: S.rank };
  try {
    Object.assign(S, { mode: "hosted", conn: null, trading: null, rank: null,
      lookup: { address: null, state: "idle", data: null, error: null, startedAt: 0, attempt: 0 } });
    openLookup(A);
    await tick(6);
    assert.ok(asked.includes(`/api/leaders?address=${A}`), asked.join(" "));
    assert.match(dom.el("#plsub").markup, /<a class="pfrank" href="#\/traders"[^>]*>#7 over 7 days · #12 all time<\/a>/);
    // Not ranked at all: nothing is said.
    S.rank = { for: A, data: standing({ rank: null, closed: null }, { rank: null, closed: null }), at: Date.now() };
    assert.equal(rankLine(A), "");
    // Another address's rank is never shown on this one.
    S.rank = { for: B, data: standing({ rank: 1, closed: 9 }, { rank: 1, closed: 9 }), at: Date.now() };
    assert.equal(rankLine(A), "");
  } finally {
    Object.assign(S, saved);
  }
});

test("a rank is read once a minute per address, and a failed read shows nothing", async () => {
  let calls = 0;
  server({ "/api/leaders?address=": () => { calls++; return [500, {}]; } });
  S.rank = null;
  let done = 0;
  await loadRank(A, () => done++);
  await loadRank(A, () => done++);
  assert.equal(calls, 1);
  assert.equal(done, 2);
  assert.equal(rankLine(A), "");
});
