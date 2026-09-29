// The token page (u-redesign.md, U4): one page for a token on the board and
// for any address that is not, which runs the deep check there. The Checker's
// numbers moved here with it (this file was checker.test.js).
//
// A checked token may be on the board or not (older than the backfill, or any
// address pasted in). Off the board the check's own `stats` come first,
// because they are from the same analysis as the findings; the board row
// fills only what the check could not say. Anything neither knows reads "—",
// never 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, checked as checkedRows, rowFor, rows } from "../public/js/core/store.js";
import { checkGates, checkRow, checks, renderToken, runCheck, setTokenTab, statsFor } from "../public/js/pages/token.js";

const dom = stubDom();

const TOKEN = "0x00000000000000000000000000000000000070a1";
const CURVE = "0x000000000000000000000000000000000000c0e1";
const CREATOR = "0x000000000000000000000000000000000000c4ea";
const now = () => Math.floor(Date.now() / 1000);

const row = (over = {}) => ({
  token: TOKEN, curve: CURVE, creator: CREATOR,
  symbol: "TKN", name: "token", status: "ready", band: "CAUTION", score: 14, sellable: true, graduated: false, v4: null,
  fdvEth: 1.6, raised: 0.03, progress: 0.25, threshold: 4.2764, holders: 12, devBuyPct: 2, bundlePct: 1.5,
  tokensPerEth: 6e8, feeBps: 100, priorLaunches: 2, priorDead: 1, findings: [], top10Pct: 40,
  block: 100, launchedAt: now() - 600, ...over,
});

/** A `/api/check` answer's `stats`, as src/server/checkStats.ts builds it. */
const stats = (over = {}) => ({
  curve: CURVE, creator: CREATOR,
  launchedAt: now() - 3 * 3600, launchBlock: 90, holders: 37,
  devBuyPct: 20.71, creatorPct: 20.71, bundlePct: 0, top10Pct: 71.2,
  priorLaunches: 0, priorDead: 0,
  raised: 1.2, threshold: 4.2764, progress: 0.2806, fdvEth: 3.1, tokensPerEth: 3.2e8,
  feeBps: 100, sellable: true, graduated: false, readyToGraduate: false, v4: null, ...over,
});

const check = (over = {}) => ({
  token: TOKEN, symbol: "TKN", name: "token", band: "CAUTION", score: 14,
  findings: [{ severity: "high", title: "Creator holds a large position",
    detail: "Creator holds 20.71% of circulating supply and can sell into the curve at any time." }],
  ...over,
});

function fresh(mode, board = []) {
  dom.reset();
  rows.clear();
  checks.clear();
  checkedRows.clear();
  for (const r of board) rows.set(r.token.toLowerCase(), r);
  Object.assign(S, {
    mode, cfg: null, stats: { price: { ethUsd: 2000, stale: false } }, boardReady: true,
    openToken: null, conn: null, wallet: null, heldFromLedger: null, tradeSide: "buy", customAmount: "", buySize: 0.01,
    hist: { points: [], since: null }, histFor: null,
  });
  setTokenTab("check");
  S.openToken = TOKEN;
}

/** A server that answers /api/check with `body` (and `status`), remembering what was asked. */
function server(body, status = 200, asked = []) {
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { status, json: async () => body };
  };
  return asked;
}

const page = () => {
  const markup = dom.el("#tokbody").markup;
  return { markup, text: textOf(markup) };
};

/** Check an address not on the board, as the page does, and return what a reader sees. */
async function checked(c, mode = "hosted", board = []) {
  fresh(mode, board);
  server(c);
  await runCheck(TOKEN);
  return page();
}

/** The figure under the chart with this label, and the line under it. */
const figOf = (markup, label) => {
  const m = markup.match(new RegExp(`<span class="lb">${label}</span>\\s*<b[^>]*>([^<]*)</b>\\s*<small>([^<]*)</small>`));
  return m ? { value: m[1], line: textOf(m[2]) } : null;
};
/** The market cap, and the figure at the chart's top right (Raised, or Migrated at). */
const mcOf = (markup) => markup.match(/<span class="mc">([^<]*)<\/span>/)[1];
const rightOf = (markup, label) => {
  const m = markup.match(new RegExp(`<div class="tk">${label}</div>\\s*<b>([^<]*)</b>`));
  return m ? m[1] : null;
};

// ------------------------------------------------------------ off board --

for (const mode of ["self", "hosted"]) {
  test(`${mode}: a token not on the board shows the check's own numbers`, async () => {
    const { markup, text } = await checked(check({ stats: stats() }), mode);

    assert.equal(mcOf(markup), "$6.2K");
    assert.match(text, /28\.1% to graduation/);
    assert.equal(rightOf(markup, "Raised"), "$2.4K");
    assert.deepEqual(figOf(markup, "Holders"), { value: "37", line: "top 10 hold 71%" });
    assert.deepEqual(figOf(markup, "Creator buy"), { value: "20.7%", line: "first launch · holds 20.7% now" });
    assert.equal(figOf(markup, "Launch bundle").value, "0.0%");
    // Per Ξ after the curve's 1% fee, and the spot price beside it.
    assert.deepEqual(figOf(markup, "Per Ξ"), { value: "316.80M", line: "after the 1.00% fee, before impact · spot 320.00M" });
    assert.match(text, /3h 0m old/);
    // The marker says what it is in each mode.
    const guard = mode === "hosted" ? "Close to graduation at" : "Guard at";
    assert.match(text, new RegExp(`${guard} 4\\.0626 Ξ`));
    assert.match(markup, /<u style="left:95%"><\/u>/);
    assert.match(markup, /style="width:28\.1%"/);
  });

  test(`${mode}: the creator figures agree with the finding that quotes them`, async () => {
    const { markup, text } = await checked(check({ stats: stats() }), mode);
    const quoted = text.match(/Creator holds (\d+\.\d+)% of circulating supply/)[1];
    assert.match(figOf(markup, "Creator buy").line, new RegExp(`holds ${(+quoted).toFixed(1)}% now`));
    // "Creator buy" is the launch-block buy, a different measure with its own label.
    assert.ok(figOf(markup, "Creator buy").value);
  });

  test(`${mode}: what nothing knows reads "—", never 0`, async () => {
    // A check answer with no stats (an older server), for a token not on the board.
    const { markup, text } = await checked(check(), mode);

    // The ring's initials, the symbol and name, the address, no age, the band and its risk.
    assert.match(text, /^← Board TK TKN token 0x0000…70a1 age — Caution Risk 14 of 100/);
    assert.equal(mcOf(markup), "—");
    assert.equal(rightOf(markup, "Raised"), "—");
    assert.match(text, /— to graduation/);
    for (const label of ["Holders", "Creator buy", "Launch bundle", "Per Ξ"]) {
      assert.equal(figOf(markup, label).value, "—", label);
    }
    assert.equal(figOf(markup, "Holders").line, "top 10 hold —");
    assert.equal(figOf(markup, "Creator buy").line, "prior launches —");
    assert.doesNotMatch(text, /\$0\b|0\.0%|first launch|holds .* now/);
    assert.match(markup, /style="width:0\.0%"/);
  });

  test(`${mode}: a graduated token says it trades on Uniswap V4`, async () => {
    const { markup, text } = await checked(check({
      stats: stats({ graduated: true, progress: 1, raised: 0, fdvEth: null, tokensPerEth: null }),
    }), mode);

    assert.match(markup, /<span class="bd GRAD">Graduated<\/span>/);
    assert.match(text, /Market cap · V4 — Bonded/);
    assert.match(text, /Completed the curve trading on Uniswap V4/);
    assert.equal(rightOf(markup, "Migrated at"), "4.2764 Ξ");
    assert.equal(rightOf(markup, "Raised"), null, "a drained curve's raise is not shown");
    assert.deepEqual(figOf(markup, "Per Ξ"), { value: "—", line: "no V4 pool found, so no price to quote" });
    assert.doesNotMatch(markup, /<u style/, "no graduation marker once graduated");
    // With no pool there is nowhere to trade, and the panel says so.
    assert.match(text, /No pool found/);
    assert.doesNotMatch(markup, /data-buy|data-sell|data-tsheet/);
  });
}

// ------------------------------------------------------- the check runs --

test("an address not on the board runs the deep check on its page, then draws the answer", async () => {
  fresh("hosted");
  let answer = () => {};
  const asked = [];
  globalThis.fetch = (url) => {
    asked.push(String(url));
    return new Promise((resolve) => { answer = () => resolve({ status: 200, json: async () => check({ stats: stats() }) }); });
  };
  renderToken();
  assert.deepEqual(asked, ["/api/check?addr=" + TOKEN]);
  assert.match(page().text, /Checking… 0x0000…70a1 Running the deep check on 0x0+70a1 … this takes a second/);
  // Drawn again while it runs (the board ticking): no second check.
  renderToken();
  assert.equal(asked.length, 1);
  answer();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(page().text, /TKN token .* Caution Risk 14 of 100/);
  // Until the board's row arrives there is nothing to trade against, and the panel says why.
  assert.match(page().markup, /<button class="bigbtn" type="button" disabled>Waiting for the board to list it<\/button>/);
  assert.doesNotMatch(page().markup, /data-buy|data-tsheet/);
});

// ------------------------------------- hosted, off the board (B5.1b) --
// Hosted's check leaves the token off the shared board and says so
// (`onBoard: false`); the page trades it from the check's own answer.

const CHECKED_AT = new Date(2026, 8, 23, 14, 5, 9).getTime();
const offBoard = (over = {}) => check({ stats: stats(), onBoard: false, checkedAt: CHECKED_AT, ...over });
const wallet = () => ({ address: "0x00000000000000000000000000000000000000aa", chainId: 4663, balanceWei: 10n ** 18n });

test("hosted, off the board: the check's answer is a row to trade from", async () => {
  fresh("hosted");
  S.conn = wallet();
  server(offBoard());
  await runCheck(TOKEN);
  const { markup, text } = page();
  // A Buy that can be pressed, for the size picked, and a phone bar.
  assert.match(markup, /<button class="bigbtn[^"]*" data-buy="0x0+70a1" data-amount-eth="0\.01"\s*title=""\s*>Buy 0\.01 Ξ<\/button>/);
  assert.match(markup, /data-tsheet="buy"/);
  assert.doesNotMatch(text, /Waiting for the board/);
  // Its price is the check's, and the panel says whose and when.
  assert.match(text, /Price from the check at 14:05:09\. The trade is quoted fresh when you press Buy\./);
  assert.match(text, /No price history Not on the board, so no price history is kept for this token\./);
  assert.match(text, /Figures from the check at 14:05:09, not updated live/);
  assert.match(text, /Checked at 14:05:09/, "the server's time, not the page's");
  // The figures are still the check's own, unknowns as "—".
  assert.equal(mcOf(markup), "$6.2K");
  // A series kept from when it was on the board measures no change now.
  S.hist = { points: [[1, 1, 0.1], [2, 3, 0.2]], since: 1 };
  S.histFor = TOKEN;
  renderToken();
  assert.match(page().markup, /<span class="chg t3"\s*>—<\/span>/);
  // What the trade code looks up finds it.
  const r = rowFor(TOKEN.toUpperCase().replace("0X", "0x"));
  assert.equal(r.curve, CURVE);
  assert.equal(r.feeBps, 100);
  assert.equal(r.fromCheck, CHECKED_AT);
  assert.equal(rows.size, 0, "nothing was put on the board");
});

test("hosted, off the board: a bonded token trades on its V4 pool from the check", async () => {
  fresh("hosted");
  S.conn = wallet();
  const v4 = { poolId: "0x01", liquidity: "5", lpFee: 10000 };
  server(offBoard({ stats: stats({ graduated: true, progress: 1, raised: 0, fdvEth: 5, tokensPerEth: 2e8, v4 }) }));
  await runCheck(TOKEN);
  const { markup, text } = page();
  assert.match(text, /Trading on Uniswap V4 · 1\.00% pool fee/);
  assert.match(markup, /data-buy="0x0+70a1"/);
  assert.equal(mcOf(markup), "$10.0K");
});

test("hosted, off the board: the sell side says the price is the check's too", async () => {
  fresh("hosted");
  S.conn = wallet();
  server(offBoard());
  await runCheck(TOKEN);
  S.tradeSide = "sell";
  renderToken();
  assert.match(page().text, /The trade is quoted fresh when you press Sell\./);
});

test("hosted, off the board: a board row that arrives later takes over", async () => {
  fresh("hosted");
  S.conn = wallet();
  server(offBoard());
  await runCheck(TOKEN);
  rows.set(TOKEN, row());
  renderToken();
  const { text } = page();
  assert.equal(rowFor(TOKEN), rows.get(TOKEN));
  assert.doesNotMatch(text, /Price from the check|no price history is kept/);
  assert.equal(figOf(page().markup, "Holders").value, "12", "the board's figures");
});

test("an answer that names the token on the board, or has no stats, makes no checked row", () => {
  assert.equal(checkRow(check({ stats: stats(), onBoard: true, checkedAt: CHECKED_AT })), null);
  assert.equal(checkRow(check({ onBoard: false, checkedAt: CHECKED_AT })), null, "an answer without stats cannot trade");
  assert.equal(checkRow(check({ stats: stats() })), null, "self's answer says nothing about the board");
});

test("hosted: a re-check that finds the token on the board drops its checked row", async () => {
  fresh("hosted");
  server(offBoard());
  await runCheck(TOKEN);
  assert.ok(checkedRows.has(TOKEN));
  server(check({ stats: stats(), onBoard: true, checkedAt: CHECKED_AT + 1000 }));
  await runCheck(TOKEN);
  assert.ok(!checkedRows.has(TOKEN));
});

test("self: a checked token still waits for its board row", async () => {
  fresh("self");
  server(check({ stats: stats() }));
  await runCheck(TOKEN);
  assert.match(page().markup, /Waiting for the board to list it/);
  assert.equal(checkedRows.size, 0);
  assert.equal(rowFor(TOKEN), null);
});

test("a curve's address is its token's page", async () => {
  fresh("hosted", [row()]);
  S.openToken = CURVE;
  renderToken();
  assert.equal(S.openToken, TOKEN);
  assert.match(page().text, /TKN token/);
  // Off the board, the check names the token, and the page becomes its.
  fresh("hosted");
  S.openToken = CURVE;
  server(check({ stats: stats() }));
  await runCheck(CURVE);
  assert.equal(S.openToken, TOKEN);
  assert.equal(checks.get(TOKEN).state, "done");
  assert.match(page().text, /TKN token/);
});

test("an address the check cannot read says so, offers to check again, and offers no trade", async () => {
  fresh("hosted");
  server({ error: "execution reverted" }, 500);
  await runCheck(TOKEN);
  const { markup, text } = page();
  assert.match(text, /Check failed 0x0000…70a1 Explorer ↗ The check could not read this address\. execution reverted\. Nothing here can be traded/);
  assert.match(markup, /data-recheck="0x0+70a1">Check again<\/button>/);
  assert.doesNotMatch(markup, /data-buy|data-sell|data-tsheet/);
  assert.doesNotMatch(text, /checker/i, "nothing points to a Checker page");
});

test("Re-check runs in place: the page stays, says it is running, then when it ran", async () => {
  fresh("hosted", [row()]);
  renderToken();
  assert.match(page().markup, /class="trecheck" data-recheck="0x0+70a1"[^>]*>\s*<span aria-hidden="true">↻<\/span><span class="trw"> Re-check<\/span><\/button>/);
  let answer = () => {};
  globalThis.fetch = () => new Promise((resolve) => { answer = () => resolve({ status: 200, json: async () => check({ stats: stats() }) }); });
  const running = runCheck(TOKEN);
  let { markup, text } = page();
  assert.match(text, /Risk 14 of 100/, "the token is still shown");
  assert.match(text, /Running the check again… this takes a second\./);
  assert.match(markup, /class="trecheck" data-recheck="0x0+70a1"[^>]*\sdisabled>/);
  answer();
  await running;
  ({ markup, text } = page());
  assert.match(text, /Checked at \d\d:\d\d:\d\d/);
  // The board's row stays the page's figures; the check adds what only it knows.
  assert.equal(figOf(markup, "Holders").value, "12");
  assert.equal(figOf(markup, "Creator buy").line, "1 of 2 prior launches died · holds 20.7% now");
});

test("the gates have one set of words, and fail on what they always failed on", () => {
  const labels = (t) => checkGates(t).map((g) => `${g.label}:${g.ok ? "ok" : "no"}`).join(" ");
  assert.equal(labels({ findings: [], sellable: true }), "Sellable:ok Factory wiring:ok Canonical selectors:ok");
  assert.equal(labels({ findings: [], sellable: false }), "Sellable:no Factory wiring:ok Canonical selectors:ok",
    "the sell simulation said no");
  assert.equal(labels({ findings: [], sellable: false, graduated: true }), "Sellable:ok Factory wiring:ok Canonical selectors:ok",
    "a graduated token's settled curve is not a failed simulation");
  const crit = (title) => ({ findings: [{ severity: "critical", title }], sellable: null });
  assert.match(labels(crit("Sell simulation reverted")), /^Sellable:no/);
  assert.match(labels(crit("Not registered with the factory")), /Factory wiring:no/);
  assert.match(labels(crit("Non-canonical selector set")), /Canonical selectors:no/);
  assert.equal(labels({ findings: [{ severity: "high", title: "Sell tax is high" }] }),
    "Sellable:ok Factory wiring:ok Canonical selectors:ok", "only a critical finding fails a gate");
  // And they are drawn on the check tab.
  fresh("self", [row()]);
  renderToken();
  assert.match(page().text, /Sellable Factory wiring Canonical selectors/);
});

test("a sell check that could not run is not known: no cross, no Can't sell, no risky buy", () => {
  // current-issues.md #4: sellable null is the check not running, never a failed sell.
  assert.equal(checkGates({ findings: [], sellable: null })[0].ok, null, "neither a tick nor a cross");
  fresh("hosted", [row({ sellable: null, findings: [{ severity: "medium", title: "Sell check did not run", detail: "timeout" }] })]);
  renderToken();
  const { markup, text } = page();
  assert.match(markup, /<span class="gate unk" title="The sell check could not run; it runs again on the next check"><span class="tick"><\/span>Sellable\?<\/span>/);
  assert.doesNotMatch(markup, /Can’t sell/);
  assert.doesNotMatch(markup, /class="bigbtn risky"|class="btn risky"/);
  assert.doesNotMatch(text, /The sell simulation reverted/);
  // A sell that reverted still says so.
  fresh("hosted", [row({ sellable: false })]);
  renderToken();
  assert.match(page().markup, /Can’t sell/);
  assert.match(page().markup, /class="btn risky" data-tsheet="buy"/);
});

test("the tabs: the addresses with copy, and your position's empty state", () => {
  fresh("hosted", [row()]);
  setTokenTab("addr");
  const { markup, text } = page();
  assert.match(markup, /role="tab" id="tt-addr" data-ttab="addr"\s*aria-selected="true"/);
  for (const a of [TOKEN, CURVE, CREATOR]) assert.match(markup, new RegExp(`data-copy="${a}"`));
  assert.match(text, /Launched block 100 · 10m ago/);
  assert.match(markup, /href="https:\/\/robinhoodchain\.blockscout\.com\/address\/0x0+70a1"/);
  assert.match(markup, /href="https:\/\/clank\.trade\/token\/0x0+70a1"/);
  setTokenTab("pos");
  assert.match(page().text, /Connect a wallet to see what you hold of TKN\./);
  setTokenTab("check");
});

test("on a phone the panel is a bar: Buy at the size, and Sell", () => {
  fresh("hosted", [row()]);
  renderToken();
  const { markup } = page();
  assert.match(markup, /<div class="tbar"[^>]*>\s*<button type="button" class="btn buy" data-tsheet="buy">Buy 0\.01 Ξ<\/button>\s*<button type="button" class="btn sell" data-tsheet="sell">Sell<\/button>/);
  fresh("hosted", [row({ sellable: false })]);
  renderToken();
  assert.match(page().markup, /class="btn risky" data-tsheet="buy"/, "a token that failed a gate is red there too");
});

test("the Checker is gone: no page, no form, no way to it but search", () => {
  const html = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
  for (const gone of ['id="pg-checker"', 'id="ckres"', 'id="ckinput"', 'id="ckgo"', "#/checker"]) {
    assert.ok(!html.includes(gone), gone);
  }
  const js = readFileSync(new URL("../public/js/pages/token.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /into the checker|go\("checker/i);
});

// ------------------------------------------------- the figures' sources --

test("on the board: the row fills what the check does not carry", () => {
  const st = statsFor(check(), row());
  assert.equal(st.fdvEth, 1.6);
  assert.equal(st.raised, 0.03);
  assert.equal(st.holders, 12);
  assert.equal(st.devBuyPct, 2);
  assert.equal(st.bundlePct, 1.5);
  assert.equal(st.priorLaunches, 2);
  assert.equal(st.priorDead, 1);
  // The board has no "holds now" figure; only the check's analysis does.
  assert.equal(st.creatorPct, null);
  assert.equal(st.top10Pct, 40);
});

test("the check's numbers win, so they match its findings", () => {
  const st = statsFor(check({ stats: stats() }), row({ devBuyPct: 2, holders: 12 }));
  assert.equal(st.devBuyPct, 20.71);
  assert.equal(st.holders, 37);
});

test("a figure the check says it does not know stays unknown", () => {
  // No launch block, so nobody can be said to have bought in it.
  const st = statsFor(check({ stats: stats({ devBuyPct: null, bundlePct: null, launchBlock: null }) }),
    row({ devBuyPct: 0, bundlePct: 0 }));
  assert.equal(st.devBuyPct, null);
  assert.equal(st.bundlePct, null);
  assert.equal(st.block, null);
  assert.equal(st.creatorPct, 20.71);
});

test("a bonded token's market cap comes from the row's V4 read", () => {
  const v4 = { poolId: "0x01", liquidity: "1", lpFee: 3000 };
  const st = statsFor(check({ stats: stats({ graduated: true, progress: 1, raised: 0, fdvEth: null, tokensPerEth: null }) }),
    row({ graduated: true, progress: 0, raised: 0, v4, fdvEth: 12, tokensPerEth: 8.3e7 }));
  assert.equal(st.fdvEth, 12);
  assert.equal(st.tokensPerEth, 8.3e7);
  assert.deepEqual(st.v4, v4);
});

test("a bonded row with no pool found has no price to lend", () => {
  const st = statsFor(check({ stats: stats({ graduated: true, fdvEth: null, tokensPerEth: null }) }),
    row({ graduated: true, v4: null, fdvEth: 12 }));
  assert.equal(st.fdvEth, null);
  assert.equal(st.tokensPerEth, null);
});

test("a row still being checked lends nothing", () => {
  const st = statsFor(check(), row({ status: "analysing", holders: 0, devBuyPct: 0 }));
  assert.equal(st.holders, null);
  assert.equal(st.devBuyPct, null);
  assert.equal(st.fdvEth, null);
});

// -------------------------------------------------------------- wording --

test("hosted: the page names no manager, bot or sniper, and calls nothing safe", async () => {
  const { text } = await checked(check({ stats: stats() }), "hosted");
  assert.match(text, /Creator buy/);
  assert.doesNotMatch(text, /\bmanager\b|\bbot\b|\bsniper\b|\bsafe/i);
  fresh("hosted", [row()]);
  renderToken();
  assert.doesNotMatch(page().text, /\bmanager\b|\bbot\b|\bsniper\b|\bsafe/i);
});

// ------------------------------------------------------ the chart (U8) --

test("the chart's labels and last point are page text over the drawing, which alone is stretched", () => {
  fresh("hosted", [row()]);
  const t0 = now() - 600;
  S.hist = { points: [[t0, 1.2, 0.02], [t0 + 300, 1.4, 0.025], [t0 + 600, 1.6, 0.03]], since: t0 };
  S.histFor = TOKEN.toLowerCase();
  renderToken();
  const { markup } = page();
  const at = markup.indexOf('<svg viewBox="0 0 600 200"');
  assert.ok(at > 0, "the chart, drawn 600 wide");
  const svg = markup.slice(at, markup.indexOf("</svg>", at));
  assert.match(svg, /preserveAspectRatio="none"/);
  assert.doesNotMatch(svg, /<text|<circle/, "no text or dot inside the stretched drawing");
  assert.equal([...svg.matchAll(/<line class="gridline"[^>]*vector-effect="non-scaling-stroke"/g)].length, 3);
  assert.match(svg, /<line class="crosshair" id="chairline"[^>]*vector-effect="non-scaling-stroke"/);
  const after = markup.slice(markup.indexOf("</svg>", at), markup.indexOf('id="charttip"'));
  assert.equal([...after.matchAll(/<span class="axlb" style="top:(\d+(\.\d)?)px">\$[^<]+<\/span>/g)].length, 3);
  // The last point: at the right edge, as a share of the width, and in pixels down.
  assert.match(after, /<span class="chartdot " style="left:100\.00%;top:\d+(\.\d)?px" aria-hidden="true"><\/span>/);
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  assert.match(css, /\.chartwrap \.axlb\{position:absolute;/);
  assert.match(css, /\.chartwrap span\.chartdot\{position:absolute;/);
});
