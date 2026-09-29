// The hosted Positions page (public-release F1.2): a lookup of any address,
// drawn from /api/ledger. The answer below is a real one, from a scratch
// hosted server for a third-party address (fixtures/ledger-routed.json);
// the capped and proceeds-unknown cases are that answer edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S, rows } from "../public/js/core/store.js";
import { stubDom, textOf } from "./support/stubdom.js";
import {
  READ_AFTER_TRADE_MS, SELL_HOW, STALE_MS, afterPageTrade, confidenceBadge, createLookup, isAddress, lookUpMine, lookupDetail,
  lookupOpenRow, lookupRow, lookupStats, lookupStatus, openLookup, partialBanner, rereadFor, sellPill, shareKey,
} from "../public/js/pages/positionsLookup.js";
import { go } from "../public/js/router.js";

const ANSWER = JSON.parse(readFileSync(new URL("./fixtures/ledger-routed.json", import.meta.url), "utf8"));
const A = ANSWER.address;
const clone = () => JSON.parse(JSON.stringify(ANSWER));
const MANAGER_WORDS = /Next rule|Stop|Take profit|Trailing|Exiting|Manual|Paper|sniper/i;

/** A lookup engine on fake timers, with the answers queued by the test. */
function rig(answers) {
  const timers = [];
  const asked = [];
  let renders = 0;
  const l = createLookup({
    fetch: async (a) => { asked.push(a); return answers.shift(); },
    render: () => { renders++; },
    now: () => 1_000,
    after: (ms, fn) => { const t = { ms, fn, kind: "after" }; timers.push(t); return t; },
    every: (ms, fn) => { const t = { ms, fn, kind: "every" }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  return { l, timers, asked, renders: () => renders };
}
const fresh = () => { S.lookup = { address: null, state: "idle", data: null, error: null, startedAt: 0, attempt: 0 }; };

test("Use my wallet asks for the trading wallet's login where there is one, and never the wallet picker", () => {
  const saved = { login: S.login, trading: S.trading, conn: S.conn };
  const asked = [];
  const connect = () => asked.push("connect"), logIn = () => asked.push("login");
  try {
    S.trading = null;
    S.conn = { address: A };
    S.login = { ...S.login, here: true };
    lookUpMine(connect, logIn);
    assert.deepEqual(asked, ["login"], "a connected browser wallet is not the one looked up");
    S.login = { ...S.login, here: false };
    S.conn = null;
    lookUpMine(connect, logIn);
    assert.deepEqual(asked, ["login", "connect"], "no trading wallet here: the picker, as before");
  } finally {
    Object.assign(S, saved);
  }
});

test("an address is 0x and 40 hex digits", () => {
  assert.ok(isAddress(A));
  assert.ok(isAddress("  " + A + " "));
  for (const bad of ["", "0x", A.slice(0, 41), A + "0", "0x" + "g".repeat(40), null, undefined]) assert.ok(!isAddress(bad));
});

test("a lookup reads /api/ledger once and shows the answer", async () => {
  fresh();
  const r = rig([{ status: 200, data: ANSWER }]);
  await r.l.start(A);
  assert.deepEqual(r.asked, [A]);
  assert.equal(S.lookup.state, "ok");
  assert.equal(S.lookup.data.open.length, 2);
  assert.equal(r.timers.length, 0, "the loading tick stops");
});

test("while it runs, it says it is rebuilding, and counts the seconds", async () => {
  fresh();
  let release;
  const l = createLookup({
    fetch: () => new Promise((res) => { release = res; }),
    render: () => {}, now: () => 5_000, every: () => 0, after: () => 0, cancel: () => {},
  });
  const p = l.start(A);
  assert.equal(S.lookup.state, "loading");
  assert.match(lookupStatus(S.lookup, 12_400).s, /Rebuilding from chain… 7s/);
  release({ status: 200, data: ANSWER });
  await p;
});

test("not an address: said, and nothing is asked", async () => {
  fresh();
  const r = rig([]);
  await r.l.start("0x1234");
  assert.equal(r.asked.length, 0);
  assert.equal(S.lookup.error.kind, "bad");
  assert.match(lookupStatus(S.lookup).s, /not an address/);
});

test("400, 429 and 503 each get their own message", async () => {
  const cases = [
    [{ status: 400, data: { error: "bad address" } }, /not an address/],
    [{ status: 429, data: { error: "rate-limited" }, retryAfter: 42 }, /Too many lookups from your network\. Try again in 42s/],
    [{ status: 502, data: {} }, /Could not read the chain/],
  ];
  for (const [answer, want] of cases) {
    fresh();
    const r = rig([answer]);
    await r.l.start(A);
    assert.equal(S.lookup.state, "error");
    assert.match(S.lookup.error.text, want);
  }
  // 503: the server kept what it read, so the page tries again on its own.
  fresh();
  const r = rig([{ status: 503, data: { retryAfter: 30 }, retryAfter: 30 }]);
  await r.l.start(A);
  assert.equal(S.lookup.state, "waiting");
  assert.match(S.lookup.error.text, /busy\. Trying again in 30s — what was read so far is kept/);
  const retry = r.timers.find((t) => t.kind === "after");
  assert.equal(retry.ms, 30_000);
});

test("a busy node is tried again, five times at most, and then it says so", async () => {
  fresh();
  const busy = () => ({ status: 503, data: {}, retryAfter: 2 });
  const r = rig([busy(), busy(), busy(), busy(), busy(), busy(), { status: 200, data: ANSWER }]);
  await r.l.start(A);
  for (let i = 0; i < 5; i++) {
    const t = r.timers.find((x) => x.kind === "after");
    assert.ok(t, `retry ${i + 1} is scheduled`);
    r.timers.splice(r.timers.indexOf(t), 1);
    t.fn();
    await new Promise((res) => setImmediate(res)); // the retry's own request lands
    assert.equal(S.lookup.attempt, i + 1);
  }
  assert.equal(r.asked.length, 6);
  assert.equal(S.lookup.state, "error");
  assert.match(S.lookup.error.text, /still busy/);
  assert.ok(!r.timers.some((x) => x.kind === "after"), "no seventh attempt");
});

test("a newer lookup wins over an older one still out", async () => {
  fresh();
  const resolvers = [];
  const l = createLookup({
    fetch: () => new Promise((res) => resolvers.push(res)),
    render: () => {}, every: () => 0, after: () => 0, cancel: () => {},
  });
  const first = l.start(A);
  const other = "0x" + "b".repeat(40);
  const second = l.start(other);
  resolvers[1]({ status: 200, data: { ...ANSWER, address: other } });
  await second;
  resolvers[0]({ status: 200, data: ANSWER });
  await first;
  assert.equal(S.lookup.address, other);
  assert.equal(S.lookup.data.address, other);
});

// U5: an open position is a table row, and what its card showed besides
// (break even, sellable, the fees, the entry tx) opens under it with Fees.
const lookupCard = (p) => lookupOpenRow(p, null, true);

test("an open card: the numbers, breakeven where the rule was, and nothing a manager decides", () => {
  for (const p of ANSWER.open) {
    const card = lookupCard(p).s;
    // What a visitor reads: the text, not the markup's attributes.
    assert.doesNotMatch(card.replace(/<[^>]*>/g, " "), MANAGER_WORDS);
    assert.match(card, /To break even<\/i>/);
    assert.match(card, /Entry tx/);
    assert.match(card, new RegExp(p.symbol));
  }
});

test("a position the chain cannot fully account for is badged, with a reason to hover", () => {
  const p = { ...ANSWER.open[0], confidence: "size-adjusted" };
  const card = lookupCard(p).s;
  assert.match(card, /size from chain/);
  assert.match(card, /title="The wallet holds a different amount/);
  assert.equal(confidenceBadge("exact"), "");
  assert.equal(lookupCard(ANSWER.open[0]).s.includes("proceeds unknown"), false);
});

test("a position that could not be valued is shown at cost, not at zero", () => {
  const card = lookupCard({ ...ANSWER.open[0], valued: false, nowEth: 0, pnlPct: 0 }).s;
  assert.match(card, /Could not be valued just now/);
  assert.doesNotMatch(card, /−100/);
});

test("a closed row with unknown proceeds shows no proceeds and no P&L, and says what happened", () => {
  const p = { ...ANSWER.closed[0], confidence: "proceeds-unknown",
    closed: { ...ANSWER.closed[0].closed, reason: "left the wallet without a curve sell — proceeds unknown", proceedsEth: "0", tx: null } };
  const row = lookupRow(p).s;
  assert.match(row, /proceeds unknown/);
  assert.match(row, /Left the wallet without a curve sale/);
  // Proceeds, P&L and Your sell: nothing to compare against (p-sell-verdict.md, P2).
  assert.equal((row.match(/>—</g) || []).length, 3);
  const normal = lookupRow(ANSWER.closed[0]).s;
  assert.match(normal, /Sold/);
  assert.doesNotMatch(normal, /reconstructed/);
});

// ---- "Your sell" (p-sell-verdict.md, P2) ----

test("a closed row carries the call on its sell: the pill, what it is worth today, the figures to hover", () => {
  const base = ANSWER.closed[0];
  const cases = [
    ["paperhand", 1.5, "Paperhand", /pill a/],
    ["good", 0.001, "Good sell", /pill g/],
    ["unpriced", null, "No price", /pill n/],
  ];
  for (const [sellVerdict, soldNowEth, label, cls] of cases) {
    const row = lookupRow({ ...base, sellVerdict, soldNowEth }).s;
    assert.match(row, /class="c-sell"/);
    assert.match(row, new RegExp(">" + label + "<"));
    assert.match(row, cls);
    if (soldNowEth === null) assert.doesNotMatch(row, /worth .* today</, "nothing to show as worth");
    else {
      assert.match(row, /<small>worth .+ today<\/small>/);
      assert.match(row, /title="What was sold [^"]* — sold for [^"]+, worth [^"]+ today"/);
    }
    // Any address, so the words never say "you".
    assert.doesNotMatch(row.match(/class="pill[^>]*title="([^"]*)"/)?.[1] ?? "", /\byou\b/i);
  }
});

test("proceeds unknown, or a server without the call: a dash, never a guess", () => {
  const unknown = lookupRow({ ...ANSWER.closed[0], confidence: "proceeds-unknown", sellVerdict: null, soldNowEth: null }).s;
  assert.match(unknown, /title="What its sells got is unknown/);
  assert.doesNotMatch(unknown, /class="pill/);
  const old = lookupRow(ANSWER.closed[0]).s; // the fixture predates P1
  assert.match(old, /class="c-sell"/);
  assert.doesNotMatch(old, /class="pill/);
  assert.equal(sellPill({ sellVerdict: "holding" }).s.includes("pill"), false);
});

test("an open position shows its call only once it has sold some, as a tag and in its detail", () => {
  const open = ANSWER.open[0];
  const unsold = { ...open, soldTokens: "0", sellVerdict: "holding", soldNowEth: null };
  assert.doesNotMatch(lookupOpenRow(unsold).s, /Paperhand|Good sell|Your sell/);
  assert.doesNotMatch(lookupDetail(unsold).s, /Your sell/);
  const part = { ...open, soldTokens: "1000", realizedWei: "10000000000000000", sellVerdict: "paperhand", soldNowEth: 0.5 };
  assert.match(lookupOpenRow(part).s, /<span class="ltag amb" title="Part sold\. What was sold would fetch more/);
  assert.match(lookupDetail(part).s, /<i>Your sell<\/i><b><span class="pill a"/);
  assert.match(lookupDetail(part).s, /<i>Sold, worth today<\/i>/);
  const good = { ...part, sellVerdict: "good", soldNowEth: 0.001 };
  assert.match(lookupOpenRow(good).s, /<span class="ltag grn"[^>]*>Good sell</);
});

test("Share sits beside a sell's call, keyed by token and opening, and only where there is a sell", () => {
  const base = ANSWER.closed[0];
  for (const sellVerdict of ["paperhand", "good", "unpriced"]) {
    const row = lookupRow({ ...base, sellVerdict, soldNowEth: sellVerdict === "unpriced" ? null : 1 }).s;
    assert.ok(row.includes(`data-share="${shareKey(base)}"`), sellVerdict);
  }
  assert.doesNotMatch(lookupRow({ ...base, sellVerdict: null, soldNowEth: null }).s, /data-share=/, "proceeds unknown");
  assert.doesNotMatch(lookupRow(base).s, /data-share=/, "a server without the call");
  // Two closed positions in one token are two cards.
  assert.notEqual(shareKey(base), shareKey({ ...base, openedAt: base.openedAt + 1 }));
  const part = { ...ANSWER.open[0], soldTokens: "1000", sellVerdict: "paperhand", soldNowEth: 0.5 };
  assert.match(lookupDetail(part).s, /data-share="/);
  assert.doesNotMatch(lookupOpenRow(part).s, /data-share="/, "on an open row it is in the detail, not the crowded row");
  assert.doesNotMatch(lookupDetail({ ...part, soldTokens: "0", sellVerdict: "holding" }).s, /data-share="/);
});

test("the totals footnote counts what was left out", () => {
  const d = clone();
  d.totals.excluded = 2;
  assert.match(lookupStats(d).s, /2 excluded, proceeds unknown/);
  assert.doesNotMatch(lookupStats(ANSWER).s, /excluded/);
});

test("a capped ledger says so, and names what it left out", () => {
  assert.equal(partialBanner(ANSWER), "");
  const d = clone();
  d.partial = true;
  d.omittedTokens = [{ token: "0x" + "1".repeat(40), symbol: "OLD", txs: 31 }, { token: "0x" + "2".repeat(40), symbol: "", txs: 1 }];
  const b = partialBanner(d).s;
  assert.match(b, /only its most recently active tokens are shown, each in full/);
  assert.match(b, /OLD \(31 transactions\)/);
  assert.match(b, /0x2222…2222 \(1 transaction\)/);
});

// ------------------------------------------------------------ U5: the page --
// #/portfolio is your own wallet's positions at once; #/portfolio/0x… is any
// address, read only and said to be someone else's (u-redesign.md, U5).

const APP_HTML = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const dom = stubDom();
globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = url; } };
const OTHER = "0x" + "c".repeat(40);

/** The page drawn with this wallet and this answer already in hand, so nothing is asked. */
function page({ conn = null, here = false, trading = null, answer = ANSWER, route = "" } = {}) {
  dom.reset();
  S.mode = "hosted";
  S.conn = conn;
  S.trading = trading;
  S.login = { ...S.login, here };
  S.lastFill = null;
  S.lookup = { address: answer ? answer.address : null, state: answer ? "ok" : "idle", data: answer, error: null, startedAt: 0, attempt: 0, readAt: Date.now() };
  openLookup(route);
  return { sub: dom.el("#plsub").markup, body: dom.el("#plbody").markup };
}

const keep = () => ({ conn: S.conn, login: S.login, trading: S.trading, mode: S.mode, lookup: S.lookup, lastFill: S.lastFill });

test("the Closed table's heading says Your sell, with how the call is made, and never Verdict", () => {
  const saved = keep();
  try {
    const d = clone();
    d.closed = d.closed.map((p) => ({ ...p, sellVerdict: "paperhand", soldNowEth: 1 }));
    const { body } = page({ answer: d, route: A });
    assert.ok(body.includes(`<th class="c-sell" title="${SELL_HOW}">Your sell</th>`));
    const closed = body.slice(body.indexOf("pfclosed"));
    const closedHead = closed.slice(0, closed.indexOf("</thead>"));
    assert.doesNotMatch(closedHead, /Verdict/);
    assert.equal((body.match(/>Verdict</g) || []).length, 1, "the Checker's Verdict, once, on Open");
    assert.equal((body.match(/>Paperhand</g) || []).length, d.closed.length);
  } finally {
    Object.assign(S, saved);
  }
});

test("logged out, your own page is the login and the lookup field", () => {
  const saved = keep();
  try {
    let v = page({ answer: null });
    assert.match(textOf(v.body), /^Log in to see your positions/);
    assert.match(v.body, /<button class="btn pri" type="button" data-lookup-login>Connect wallet<\/button>/);
    assert.match(v.body, /class="pfslot"/, "the lookup field is moved in beside it");
    assert.doesNotMatch(v.body, /class="kpi"/);
    // An origin with a trading wallet logs in, as the top bar's button does.
    v = page({ answer: null, here: true });
    assert.match(v.body, /data-lookup-login>Log in<\/button>/);
    // The last address looked up is not shown as yours.
    v = page({ answer: ANSWER });
    assert.match(textOf(v.body), /^Log in to see your positions/);
  } finally {
    Object.assign(S, saved);
  }
});

test("with a wallet, your own positions at once: its address as a copy chip, the four figures, the tables and your sells", () => {
  const saved = keep();
  const [p0, p1] = ANSWER.open;
  try {
    rows.clear();
    rows.set(p0.token.toLowerCase(), { token: p0.token, symbol: p0.symbol, status: "ready", band: "CLEAN", score: 10, progress: 0.3, logo: true });
    const v = page({ conn: { address: A, chainId: 4663, balanceWei: 10n ** 16n } });
    assert.match(textOf(v.sub), /^Your wallet 0xf74c…b2ce/);
    assert.match(v.sub, new RegExp(`data-copy="${A}"`));
    assert.doesNotMatch(v.sub, /not your wallet/);
    for (const k of ["Open value", "Unrealised", "Realised", "Fees paid"]) {
      assert.match(v.body, new RegExp(`<div class="kpi"><small>${k}</small>`));
    }
    assert.match(v.body, /<h2>Open<\/h2>/);
    assert.match(v.body, /<h2>Closed<\/h2>/);
    for (const h of ["Token", "Held", "Cost", "Value", "P&amp;L", "Graduation", "Verdict", "Proceeds", "Held for", "What happened"]) {
      assert.match(v.body, new RegExp(`>${h}</th>`));
    }
    // Your sells are the board's 50% and All, on a token the board lists; one it does not is its page.
    assert.match(v.body, new RegExp(`data-sell="${p0.token}" data-pct="50"`));
    assert.match(v.body, new RegExp(`data-sell="${p0.token}" data-pct="100"`));
    assert.doesNotMatch(v.body, new RegExp(`data-sell="${p1.token}"`));
    assert.match(v.body, new RegExp(`<a class="btn sm" href="#/token/${p1.token}"`));
    // Each token links to its page; the board's verdict where it has one.
    assert.match(v.body, new RegExp(`<a class="bsym pfsym" href="#/token/${p0.token}">${p0.symbol}</a>`));
    assert.match(v.body, /class="bd band CLEAN"/);
    // #/portfolio/<your own address> is still your own.
    assert.match(textOf(page({ conn: { address: A, chainId: 4663, balanceWei: 1n }, route: A }).sub), /^Your wallet/);
  } finally {
    rows.clear();
    Object.assign(S, saved);
  }
});

test("the trading wallet is yours where this origin has one, not a connected browser wallet", () => {
  const saved = keep();
  try {
    const v = page({ here: true, conn: { address: OTHER, chainId: 4663, balanceWei: 1n }, trading: { address: A, balanceWei: 1n } });
    assert.match(textOf(v.sub), /^Your trading wallet 0xf74c…b2ce/);
  } finally {
    Object.assign(S, saved);
  }
});

test("another address is read only, says so, and leads back to your own", () => {
  const saved = keep();
  try {
    const v = page({ conn: { address: OTHER, chainId: 4663, balanceWei: 10n ** 16n }, route: A });
    assert.match(textOf(v.sub), /^Viewing 0xf74c…b2ce — not your wallet ← Your positions$/);
    assert.match(v.sub, /data-go="portfolio"/);
    assert.doesNotMatch(v.body, /data-sell=/, "no sells on someone else's address");
    assert.doesNotMatch(v.body, /aria-label="Sell"/);
    assert.match(v.body, /class="kpi"/);
    // Logged out too.
    assert.match(textOf(page({ route: A }).sub), /not your wallet/);
  } finally {
    Object.assign(S, saved);
  }
});

test("an address with nothing, and one that is not an address, say so", () => {
  const saved = keep();
  try {
    const none = { ...clone(), address: OTHER, open: [], closed: [], asOfBlock: 123 };
    let v = page({ answer: none, route: OTHER });
    assert.match(textOf(v.body), /^No positions The chain shows no curve buy or sale on clank\.trade by 0xcccc…cccc, up to block 123\.$/);
    dom.reset();
    S.lookup = { address: "0x1234", state: "error", data: null, startedAt: 0, attempt: 0,
      error: { kind: "bad", text: "That is not an address. Paste one that starts with 0x and has 40 characters after it." } };
    S.lookup.state = "waiting"; // drawn as it stands, not read again
    openLookup("0x1234");
    v = { sub: dom.el("#plsub").markup, body: dom.el("#plbody").markup };
    assert.match(textOf(v.sub), /^Not an address ← Your positions$/);
    assert.match(textOf(v.body), /That is not an address/);
  } finally {
    Object.assign(S, saved);
  }
});

test("#/portfolio is your own page: it does not bring back the last address looked up", () => {
  const saved = keep();
  try {
    dom.reset();
    S.mode = "hosted";
    S.conn = null;
    S.lookup = { ...S.lookup, address: A, state: "ok", data: ANSWER };
    go("portfolio", true);
    assert.equal(globalThis.location.hash, "#/portfolio");
    go("portfolio/" + A, true);
    assert.equal(globalThis.location.hash, "#/portfolio/" + A);
  } finally {
    Object.assign(S, saved);
  }
});

test("the page's words: Portfolio, the lookup field, and the manual-exit line word for word", () => {
  const at = APP_HTML.indexOf('id="plookup"');
  const markup = APP_HTML.slice(at, APP_HTML.indexOf("data-self-only", at));
  assert.match(markup, /<h1>Portfolio<\/h1>/);
  assert.match(markup, /<form class="field pfq" id="plform" role="search">/);
  assert.match(markup, /placeholder="Look up another address, 0x…"/);
  assert.match(markup, /<b>Exits are manual\. Nothing here sells for you\.<\/b>/);
});

// ------------------------------------------- U8: after a sell from the page --

test("a fresh lookup asks for the newest blocks, and its retries do too", async () => {
  fresh();
  const asked = [];
  const timers = [];
  const l = createLookup({
    fetch: async (a, f) => { asked.push(f); return asked.length === 1 ? { status: 503, data: {}, retryAfter: 1 } : { status: 200, data: ANSWER }; },
    render: () => {}, now: () => 1_000,
    after: (ms, fn) => { const t = { ms, fn, kind: "after" }; timers.push(t); return t; },
    every: () => ({}), cancel: () => {},
  });
  await l.start(A, 0, true);
  timers.find((t) => t.kind === "after").fn();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(asked, [true, true]);
  await l.start(A);
  assert.equal(asked[2], false, "a plain lookup is not fresh");
});

test("a sell from the Portfolio that fills reads your own page again, fresh; nothing else does", async () => {
  const saved = keep();
  const savedFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { status: 200, headers: { get: () => null }, json: async () => ANSWER };
  };
  const timers = [];
  const after = (ms, fn) => timers.push({ ms, fn });
  const fire = async () => { for (const t of timers.splice(0)) t.fn(); await new Promise((res) => setImmediate(res)); };
  try {
    page({ conn: { address: A, chainId: 4663, balanceWei: 1n } });
    dom.el("#shell").dataset.page = "positions";
    // Filled: read again at 5s and 35s, fresh, keeping the rows shown meanwhile.
    afterPageTrade({ phase: "done" }, after);
    assert.deepEqual(timers.map((t) => t.ms), READ_AFTER_TRADE_MS);
    assert.deepEqual(READ_AFTER_TRADE_MS, [5_000, 35_000]);
    await fire();
    assert.equal(urls.length, 2);
    for (const u of urls) assert.equal(u, "/api/ledger?address=" + A + "&fresh=1");
    assert.equal(S.lookup.state, "ok");
    // A trade that did not fill, cancelled, or was refused: nothing.
    for (const phase of ["cancelled", "refused", "failed", "paused"]) afterPageTrade({ phase }, after);
    afterPageTrade(undefined, after);
    assert.equal(timers.length, 0);
    // Someone else's address, read only: nothing.
    page({ conn: { address: A, chainId: 4663, balanceWei: 1n }, route: OTHER, answer: { ...ANSWER, address: OTHER } });
    afterPageTrade({ phase: "done" }, after);
    assert.equal(timers.length, 0);
    // Your own again, but the page was left before the reading was due.
    page({ conn: { address: A, chainId: 4663, balanceWei: 1n } });
    afterPageTrade({ phase: "done" }, after);
    dom.el("#shell").dataset.page = "launches";
    urls.length = 0;
    await fire();
    assert.equal(urls.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(S, saved);
  }
});

test("an answer in hand is read again on opening: fresh after a trade of that address, plain once a minute old", () => {
  const ok = { address: A, state: "ok", readAt: 10_000 };
  const lo = A.toLowerCase();
  assert.equal(rereadFor(A, ok, null, 10_000 + STALE_MS), null, "a minute old exactly: drawn as it is");
  assert.equal(rereadFor(A, ok, null, 10_001 + STALE_MS), "stale");
  assert.equal(rereadFor(A, ok, { address: lo, at: 10_500 }, 11_000), "fresh", "a buy on a token page since the read");
  assert.equal(rereadFor(A, ok, { address: lo, at: 9_000 }, 11_000), null, "a fill before the read is in it");
  assert.equal(rereadFor(A, ok, { address: lo, at: 10_000 }, 11_000), null, "and one in the same millisecond");
  assert.equal(rereadFor(A, ok, { address: OTHER, at: 10_500 }, 11_000), null, "another address's trade");
  assert.equal(rereadFor(OTHER, ok, null, 10_001 + STALE_MS), null, "a different address is a new lookup, not this");
  for (const state of ["loading", "waiting", "error", "idle"]) {
    assert.equal(rereadFor(A, { ...ok, state }, { address: lo, at: 10_500 }, 10_001 + STALE_MS), null, state);
  }
  assert.equal(STALE_MS, 60_000);
});

test("your own page opened again after a buy elsewhere reads the ledger, fresh, keeping the rows meanwhile", async () => {
  const saved = keep();
  const savedFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { status: 200, headers: { get: () => null }, json: async () => ANSWER };
  };
  try {
    page({ conn: { address: A, chainId: 4663, balanceWei: 1n } });
    assert.equal(urls.length, 0, "just read: drawn as it is");
    // Read 5s ago; a buy filled on a token page 4s ago; then the Portfolio is opened.
    S.lookup = { ...S.lookup, readAt: Date.now() - 5_000 };
    S.lastFill = { address: A.toLowerCase(), at: Date.now() - 4_000 };
    const opened = openLookup("");
    assert.equal(S.lookup.state, "loading");
    assert.equal(S.lookup.data, ANSWER, "the rows it had stay shown while it is read");
    await opened;
    assert.deepEqual(urls, ["/api/ledger?address=" + A + "&fresh=1"]);
    assert.equal(S.lookup.state, "ok");
    // Opened again at once: nothing more.
    await openLookup("");
    assert.equal(urls.length, 1);
    // Over a minute on, with no trade since: read again, not fresh.
    S.lastFill = null;
    S.lookup = { ...S.lookup, readAt: Date.now() - STALE_MS - 1 };
    await openLookup("");
    assert.deepEqual(urls.slice(1), ["/api/ledger?address=" + A]);
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(S, saved);
  }
});

test("a fill stamps the address that traded, for the Portfolio", () => {
  const TRADE = readFileSync(new URL("../public/js/trade.js", import.meta.url), "utf8");
  const afterFill = TRADE.slice(TRADE.indexOf("afterFill: (fill) =>"), TRADE.indexOf("afterApproval:"));
  assert.match(afterFill, /S\.lastFill = \{ address: String\(intent\.from\)\.toLowerCase\(\), at: Date\.now\(\) \};/);
});

test("main.js hands a Portfolio sell's end to the page", () => {
  const MAIN = readFileSync(new URL("../public/js/main.js", import.meta.url), "utf8");
  assert.match(MAIN, /if \(sell\.closest\("#plookup"\)\) void Promise\.resolve\(run\)\.then\(afterPageTrade/);
});
