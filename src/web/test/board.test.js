// The board (u-redesign.md, U2 and U3): its sorts both ways, its filter
// chips and their counts, the name filter, the table's rows and its markup,
// and the Columns view: its three lists, its cards and the switch to it.
//
// The sorts are comparators (launches.js COMPARE, and REVERSE for a second
// click on a column head), so a sort is tested by the order it lays a board
// out in. The rows are painted into the stub page and read as markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, rows } from "../public/js/core/store.js";
import {
  COLUMNS, COMPARE, FILTERS, REVERSE, SORTS, SORT_KEY, VIEWS, VIEW_KEY, age, ariaSort, boardCard, boardRow, chipCounts,
  columnsOf, isNew, loadSort, loadView, matchesName, renderLaunches, saveSort, saveView, setBoardView, shownBy, sortBoard,
} from "../public/js/pages/launches.js";
import { VERDICT_NOTE } from "../public/js/core/domain.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const APP_HTML = read("../public/app.html");

const dom = stubDom();

const addr = (i) => "0x" + String(i).padStart(40, "0");
const row = (i, over = {}) => ({
  token: addr(i), curve: addr(900 + i), creator: addr(800 + i),
  symbol: "T" + i, name: "token " + i, status: "ready", band: "CLEAN", score: 4, sellable: true, graduated: false,
  v4: null, fdvEth: 1, raised: 0.03, progress: 0.1, threshold: 4.27642857, holders: 10, devBuyPct: 2, bundlePct: 0,
  tokensPerEth: 6e8, feeBps: 100, priorLaunches: 0, priorDead: 0, findings: [], top10Pct: 40,
  block: 100 + i, launchedAt: 1_700_000_000 + i, ...over,
});

/**
 * A board with every awkward case: ties on each number, a value missing
 * (undefined and null both), a launch still being checked, and graduated
 * tokens that are older than some fresh ones and newer than others.
 */
const BOARD = {
  E: row(11, { status: "analysing", band: undefined, score: undefined, fdvEth: undefined, holders: undefined, progress: undefined }),
  A: row(10, { fdvEth: 2, holders: 20, progress: 0.5, score: 10 }),
  B: row(9, { fdvEth: 5, holders: 20, progress: 0.9, score: 3, band: "CAUTION" }),
  C: row(8, { graduated: true, fdvEth: 30, holders: 200, progress: 0, score: 0, band: "AVOID" }),
  D: row(7, { graduated: true, fdvEth: 80, holders: 150, progress: 0, score: 0 }),
  F: row(6, { fdvEth: 5, holders: null, progress: 0.9, score: 3, band: "HIGH RISK" }),
  G: row(5, { graduated: true, fdvEth: null, holders: 5, progress: 0, score: 0 }),
};
const NAME = new Map(Object.entries(BOARD).map(([k, r]) => [r.token, k]));

/** The board as `sort` lays it out, by letter. */
const laidOut = (sort, dir = 1, list = Object.values(BOARD)) =>
  sortBoard(list, sort, dir).map((r) => NAME.get(r.token)).join(" ");

/** Paint the board into a blank stub page, in a mode, with a view. */
function paintBoard(board, mode = "self", view = {}) {
  dom.reset();
  rows.clear();
  for (const r of board) rows.set(r.token.toLowerCase(), r);
  S.mode = mode;
  S.boardReady = true;
  setBoardView({ f: "all", q: "", sort: "new", dir: 1, layout: "table", col: "new", ...view });
  try { renderLaunches(); } finally { S.mode = "self"; }
  return dom.el("#lrows");
}

// ------------------------------------------------------------- the sorts --

test("the sorts are Newest (the default), Market cap, Holders, Closest to graduation and Lowest risk", () => {
  assert.deepEqual(SORTS, ["new", "mcap", "hold", "prog", "score"]);
  for (const s of SORTS) {
    assert.equal(typeof COMPARE[s], "function", s);
    assert.equal(typeof REVERSE[s], "function", s);
  }
  const options = [...APP_HTML.matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [
    ["new", "Newest"], ["mcap", "Market cap"], ["hold", "Holders"],
    ["prog", "Closest to graduation"], ["score", "Lowest risk"],
  ], "the sort menu lists the sorts, in the same order");
  const heads = [...APP_HTML.matchAll(/<th [^>]*data-sort="([a-z]+)" aria-sort="none"><button type="button">([^<]+)<\/button><\/th>/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(heads, [["new", "Age"], ["mcap", "Market cap"], ["prog", "Graduation"], ["hold", "Holders"], ["score", "Verdict"]],
    "each sort is a column head too, a button in its <th>");
});

test("Newest: every launch still on its curve, newest first, then the graduated ones, newest first", () => {
  assert.equal(laidOut("new"), "E A B F C D G");
});

test("Market cap: highest first across the whole board; a tie goes to the newer, a missing cap goes last", () => {
  // B and F are both 5: B is newer. E and G have no cap: after everything that has one, newest first.
  assert.equal(laidOut("mcap"), "D C B F A E G");
});

test("Holders: most first; a tie goes to the newer, and null or undefined goes last", () => {
  // A and B both 20: A is newer. E (undefined) and F (null) have no count.
  assert.equal(laidOut("hold"), "C D A B G E F");
});

test("Closest to graduation: ungraduated by progress, missing last; graduated after, by market cap", () => {
  // B and F both 0.9: B is newer. E has no progress. G has no cap, so it trails D and C.
  assert.equal(laidOut("prog"), "B F A E D C G");
});

test("Lowest risk: scored launches on their curve, then graduated ones, then those still being checked", () => {
  // B and F both 3: B is newer. C, D and G all 0: newest first.
  assert.equal(laidOut("score"), "B F A C D G E");
});

test("each sort the other way turns the value round, and keeps graduated after, missing last, ties to the newer", () => {
  assert.equal(laidOut("new", -1), "F B A E G D C", "oldest first; graduated still after the curve");
  assert.equal(laidOut("mcap", -1), "A B F C D E G", "smallest first; no cap still last");
  assert.equal(laidOut("hold", -1), "G A B D C E F", "fewest first; no count still last");
  assert.equal(laidOut("prog", -1), "A B F E D C G", "least progress first; graduated still after");
  assert.equal(laidOut("score", -1), "A B F C D G E", "highest risk first; still-checking still last");
});

test("a sort gives the same order whatever order the board came in, even when every value ties", () => {
  const same = [row(1), row(2), row(3)].map((r) => ({ ...r, block: 7, launchedAt: 7 }));
  for (const s of SORTS) {
    for (const dir of [1, -1]) {
      const a = sortBoard(same, s, dir).map((r) => r.token);
      const b = sortBoard(same.slice().reverse(), s, dir).map((r) => r.token);
      assert.deepEqual(a, b, `${s} ${dir}`);
    }
  }
});

test("a column head's aria-sort says which way its sort runs; the others say none", () => {
  assert.equal(ariaSort("new", "new", 1), "ascending", "Newest is the Age column, youngest first");
  assert.equal(ariaSort("new", "new", -1), "descending");
  assert.equal(ariaSort("mcap", "mcap", 1), "descending");
  assert.equal(ariaSort("mcap", "mcap", -1), "ascending");
  assert.equal(ariaSort("score", "score", 1), "ascending", "Lowest risk is the Verdict column by ascending score");
  assert.equal(ariaSort("hold", "new", 1), "none");
});

// ---------------------------------------------------- remembering a sort --

/** A stand-in for localStorage. */
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), m };
};

test("the sort is remembered per browser, and read back", () => {
  const store = memory();
  assert.equal(loadSort(() => store), "new", "nothing remembered: Newest");
  saveSort("mcap", () => store);
  assert.equal(store.m.get(SORT_KEY), "mcap");
  assert.equal(loadSort(() => store), "mcap");
  saveSort("nonsense", () => store);
  assert.equal(loadSort(() => store), "mcap", "a value that is not a sort is not written");
  store.m.set(SORT_KEY, "<b>");
  assert.equal(loadSort(() => store), "new", "a stored value that is not a sort reads as Newest");
});

test("storage that throws, or is missing, falls back to Newest and never throws", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(loadSort(() => throwing), "new");
  assert.doesNotThrow(() => saveSort("hold", () => throwing));
  const blocked = () => { throw new Error("storage is disabled"); };
  assert.equal(loadSort(blocked), "new");
  assert.doesNotThrow(() => saveSort("hold", blocked));
  assert.equal(loadSort(() => null), "new");
  assert.doesNotThrow(() => saveSort("hold", () => undefined));
});

// -------------------------------------------------------------- the chips --

test("the chips are All, No issues found, Caution, Risky and Graduated, each with its count", () => {
  // The board's own chip row: the console's filter rows are buttons too (U8).
  const lchips = APP_HTML.slice(APP_HTML.indexOf('id="lchips"'), APP_HTML.indexOf("</div>", APP_HTML.indexOf('id="lchips"')));
  const chips = [...lchips.matchAll(/<button class="chip" type="button" data-f="([A-Za-z]+)" aria-pressed="(true|false)">([^<]+)<span class="n"><\/span><\/button>/g)]
    .map((m) => [m[1], m[3], m[2]]);
  assert.deepEqual(chips, [
    ["all", "All", "true"], ["CLEAN", "No issues found", "false"], ["CAUTION", "Caution", "false"],
    ["risky", "Risky", "false"], ["GRAD", "Graduated", "false"],
  ]);
  assert.deepEqual(Object.keys(FILTERS), ["all", "CLEAN", "CAUTION", "risky", "GRAD"]);
});

test("each chip counts exactly the rows its filter shows; a graduated token counts under no band", () => {
  const all = Object.values(BOARD);
  assert.deepEqual(chipCounts(all), { all: 7, CLEAN: 1, CAUTION: 1, risky: 1, GRAD: 3 },
    "C's curve was AVOID, but it is graduated: not risky");
  for (const f of Object.keys(FILTERS)) assert.equal(all.filter((r) => shownBy(f, r)).length, chipCounts(all)[f], f);
  assert.deepEqual(chipCounts([]), { all: 0, CLEAN: 0, CAUTION: 0, risky: 0, GRAD: 0 });
  // A graduated row still being checked is shown as Checking, so it is not counted as graduated yet.
  assert.equal(chipCounts([row(1, { graduated: true, status: "analysing" })]).GRAD, 0);
});

test("Risky shows high risk and avoid, and hides graduated tokens and ones still being checked", () => {
  const avoid = row(1, { band: "AVOID" }), high = row(2, { band: "HIGH RISK" });
  assert.ok(shownBy("risky", avoid) && shownBy("risky", high));
  assert.ok(!shownBy("risky", BOARD.C), "a graduated token whose curve was AVOID");
  assert.ok(!shownBy("risky", BOARD.E), "a launch still being checked");
  assert.ok(shownBy("CLEAN", BOARD.A) && !shownBy("CLEAN", BOARD.D), "No issues found is CLEAN on its curve");
});

test("the name filter matches a symbol, a name, or the start of an address, in any case", () => {
  const r = row(12, { symbol: "CLANK", name: "Clank Cat" });
  assert.ok(matchesName(r, ""));
  assert.ok(matchesName(r, "cla"));
  assert.ok(matchesName(r, " CAT "));
  assert.ok(matchesName(r, "0x00000000"));
  assert.ok(!matchesName(r, "dog"));
  assert.ok(!matchesName(r, "0012"), "a piece of an address that is not its start is not a name");
});

test("the new chips' and heads' words say nothing about a manager, bot, sniper or safety", () => {
  for (const words of ["Graduated", "Market cap", "Holders", "Graduation", "Top 10", "Creator", "Bundle", "Verdict"]) {
    assert.doesNotMatch(words, /manager|bot|sniper|safe/i);
  }
});

// ---------------------------------------------------------------- the rows --

test("the table paints one row per launch, in the sort's order, keyed and linked by token", () => {
  const body = paintBoard(Object.values(BOARD), "self", { sort: "mcap" });
  const painted = body.appended.map((el) => el.markup.match(/data-token="([^"]+)"/)[1]);
  assert.deepEqual(painted.map((t) => NAME.get(t)).join(" "), laidOut("mcap"));
  for (const el of body.appended) {
    assert.match(el.markup, /<tr class="link" data-token="0x[0-9a-f]{40}" data-b="[A-Z]+" tabindex="0">/, "a row opens its token page, and Tab reaches it");
  }
});

test("a chip and the name filter leave only the rows they match; nothing matching says so, with a way back", () => {
  let body = paintBoard(Object.values(BOARD), "self", { f: "GRAD" });
  assert.equal(body.appended.length, 3);
  body = paintBoard(Object.values(BOARD), "self", { q: "T10" });
  assert.equal(body.appended.length, 1);
  body = paintBoard(Object.values(BOARD), "self", { q: "nothing like it" });
  assert.equal(body.appended.length, 0);
  assert.match(textOf(body.markup), /No launches match .* Show all 7/);
  assert.match(body.markup, /data-bclear/);
});

test("before the first data the table shows skeleton rows; an empty board says so", () => {
  dom.reset();
  rows.clear();
  S.boardReady = false;
  renderLaunches();
  assert.equal((dom.el("#lrows").markup.match(/<tr class="bskel"/g) || []).length, 8);
  S.boardReady = true;
  renderLaunches();
  assert.match(textOf(dom.el("#lrows").markup), /Nothing on the board yet/);
});

test("a row: symbol and name, NEW, can't sell, age, market cap, graduation, holders, top 10, creator, bundle, verdict, Buy", () => {
  const now = Date.now();
  const r = row(20, { symbol: "DIH", name: "Dih", sellable: false, launchedAt: Math.floor(now / 1000) - 180, top10Pct: 12.5, devBuyPct: 11, bundlePct: 4.5 });
  const m = boardRow(r, true).s;
  const text = textOf(m);
  assert.match(m, /<span class="bsym">DIH<\/span><span class="ltag new"[^>]*>New<\/span><span class="ltag nosell" title="The sell simulation reverted — this cannot be exited">Can’t sell<\/span>/);
  assert.match(m, /<span class="bname">Dih<\/span>/);
  assert.match(text, /\b3m\b/);
  assert.match(m, /class="num c-top t2">12\.5%/);
  assert.match(m, /class="num c-dev t2"><span class="red">11\.0%/, "over the creator limit: red");
  assert.match(m, /class="num c-bun t2"><span class="amb">4\.5%/, "near the bundle limit: amber");
  assert.match(m, /<td class="c-vd"><span class="bd band CLEAN" title="Risk 4 of 100">No issues found<\/span><\/td>/);
  assert.match(m, /data-buy="0x0000000000000000000000000000000000000020"/, "Buy is the trade bar's own button");
});

test("a graduated row says Graduated, with what it migrated at, in its graduation cell", () => {
  const m = boardRow(row(21, { graduated: true, fdvEth: 30 }), false).s;
  assert.match(m, /<span class="ltag grad" title="Migrated at 4\.2764 Ξ — trading on Uniswap V4">Graduated<\/span>/);
  assert.match(m, /<span class="bd band GRAD" [^>]*>Graduated<\/span>/);
});

test("New: the newest launch always, and any other that landed in the last hour", () => {
  const now = 1_800_000_000_000;
  const old = row(1, { launchedAt: now / 1000 - 5 * 3600 });
  const fresh = row(2, { launchedAt: now / 1000 - 1800 });
  assert.ok(isNew(old, old, now), "the newest, however old");
  assert.ok(!isNew(old, fresh, now));
  assert.ok(isNew(fresh, old, now));
});

test("age is the fewest characters: seconds, minutes, hours, then days", () => {
  const now = 1_800_000_000_000, at = (s) => now / 1000 - s;
  assert.equal(age(at(47), now), "47s");
  assert.equal(age(at(14 * 60), now), "14m");
  assert.equal(age(at(5 * 3600 + 59 * 60), now), "5h");
  assert.equal(age(at(3 * 86400 + 60), now), "3d");
  // A row still being read has no launch time: a dash, not 20720d (current-issues.md #6).
  for (const none of [0, null, undefined, "", -5]) assert.equal(age(none, now), "—", String(none));
});

test("a row repainted with nothing changed is the same element, so it keeps focus and hover", () => {
  const board = [row(30), row(31)];
  const first = paintBoard(board).appended.slice();
  // Same data again, into a fresh page: the rows come from the cache, not a new parse.
  const again = paintBoard(board).appended;
  assert.equal(again[0], first[0]);
  assert.equal(again[1], first[1]);
  const changed = paintBoard([row(30, { holders: 99 }), row(31)]).appended;
  assert.notEqual(changed.find((el) => /0{38}30"/.test(el.markup)), first.find((el) => /0{38}30"/.test(el.markup)));
});

test("the board's CSS: the head sticks under the top bar; the box clips rather than scrolls, so the stickiness is the page's", () => {
  const css = read("../public/app.css");
  assert.match(css, /\.btable th\{top:58px/);
  assert.match(css, /\.bbox\{[^}]*overflow:clip\}/);
  const phone = read("../public/phone.css");
  assert.match(phone, /\.btable thead \{ display: none \}/, "the phone's rows have no head");
});

test("Home is gone: the board is the front page, and nothing of Home's is left in the page or the client", () => {
  assert.match(APP_HTML, /<section class="pg on" id="pg-launches"/, "the board is the page shown first");
  for (const gone of ['id="pg-home"', 'id="hero-status"', 'id="home-', 'id="lstats"', 'id="spot"', 'id="lgrid"', 'id="lsorts"']) {
    assert.ok(!APP_HTML.includes(gone), gone);
  }
  assert.throws(() => read("../public/js/pages/home.js"), /ENOENT/);
});

// ------------------------------------------------------ the Columns view --

/** Each column of a board, by letter. */
const columnsBy = (list) => Object.fromEntries(Object.entries(columnsOf(list)).map(([k, v]) => [k, v.map((r) => NAME.get(r.token)).join(" ")]));

/** The cards painted into a column of the stub page, by letter. */
const cardsIn = (id) => dom.el("#lcl-" + id).appended.map((el) => NAME.get(el.markup.match(/data-token="([^"]+)"/)[1])).join(" ");

test("the columns are New, Closest to graduation and Graduated, in that order, each with a header, a count and a line", () => {
  assert.deepEqual(COLUMNS.map((c) => [c.id, c.title]), [["new", "New"], ["near", "Closest to graduation"], ["grad", "Graduated"]]);
  const heads = [...APP_HTML.matchAll(/<section class="bcol" data-col="([a-z]+)" aria-labelledby="lch-\1">\s*<header class="bchd"><h2 id="lch-\1">([^<]+)<\/h2><i class="bcn" id="lcn-\1"><\/i>\s*<span[^>]*>([^<]+)<\/span><\/header>\s*<div class="bclist" id="lcl-\1"><\/div>/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(heads, [
    ["new", "New", "Newest first, on their curve"],
    ["near", "Closest to graduation", "Furthest first"],
    ["grad", "Graduated", "On Uniswap V4, by market cap"],
  ]);
});

test("New: every launch still on its curve, newest first, a launch still being checked included", () => {
  assert.equal(columnsBy(Object.values(BOARD)).new, "E A B F");
});

test("Closest to graduation: the same launches, furthest along first; a tie to the newer, no progress last", () => {
  assert.equal(columnsBy(Object.values(BOARD)).near, "B F A E");
});

test("Graduated: only graduated tokens, highest market cap first, a missing cap last", () => {
  assert.equal(columnsBy(Object.values(BOARD)).grad, "D C G");
  // A graduated token still being checked is not known to be graduated yet, as the Graduated chip has it.
  const pending = row(40, { graduated: true, status: "analysing" });
  assert.deepEqual(columnsOf([pending]).grad, []);
  assert.deepEqual(columnsOf([pending]).new, [pending]);
});

test("the columns keep their own order whatever the board's sort, and in whatever order the board came", () => {
  const all = Object.values(BOARD);
  const want = columnsBy(all);
  for (const s of SORTS) {
    for (const dir of [1, -1]) assert.deepEqual(columnsBy(sortBoard(all, s, dir)), want, `${s} ${dir}`);
  }
  assert.deepEqual(columnsBy(all.slice().reverse()), want);
});

test("the chips and the name filter narrow every column", () => {
  const all = Object.values(BOARD);
  const by = (f, q = "") => columnsBy(all.filter((r) => shownBy(f, r) && matchesName(r, q)));
  assert.deepEqual(by("risky"), { new: "F", near: "F", grad: "" }, "Risky: only risky ones in each; a graduated token is never risky");
  assert.deepEqual(by("GRAD"), { new: "", near: "", grad: "D C G" });
  assert.deepEqual(by("CAUTION"), { new: "B", near: "B", grad: "" });
  assert.deepEqual(by("all", "T8"), { new: "", near: "", grad: "C" });
});

test("the view is Table unless this browser remembered Columns; a bad value or failing storage gives Table", () => {
  assert.deepEqual(VIEWS, ["table", "cols"]);
  const store = memory();
  assert.equal(loadView(() => store), "table", "nothing remembered: Table");
  saveView("cols", () => store);
  assert.equal(store.m.get(VIEW_KEY), "cols");
  assert.equal(loadView(() => store), "cols");
  saveView("grid", () => store);
  assert.equal(store.m.get(VIEW_KEY), "cols", "a value that is not a view is not written");
  store.m.set(VIEW_KEY, "<b>");
  assert.equal(loadView(() => store), "table");
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(loadView(() => throwing), "table");
  assert.doesNotThrow(() => saveView("cols", () => throwing));
  assert.equal(loadView(() => { throw new Error("storage is disabled"); }), "table");
  assert.notEqual(VIEW_KEY, SORT_KEY);
});

test("the switch is in the heading, Table pressed first; the sort gives way to a line in Columns", () => {
  assert.match(APP_HTML, /<div class="seg sm" id="lview" role="group" aria-label="View">\s*<button type="button" data-v="table" aria-pressed="true">Table<\/button>\s*<button type="button" data-v="cols" aria-pressed="false">Columns<\/button>\s*<\/div>/);
  const head = APP_HTML.slice(APP_HTML.indexOf('<div class="phead bhead">'), APP_HTML.indexOf('<div class="bbox"'));
  assert.match(head, /id="lview"/, "the switch is on the heading's side, with the note");
  assert.match(head, /id="lnote"/);
  assert.match(APP_HTML, /<span class="bsortnote" id="lsortnote">Each column keeps its own order<\/span>/);
  const css = read("../public/app.css");
  assert.match(css, /\.bbox\[data-view=cols\] \.bsort\{display:none\}/);
  assert.match(css, /\.bbox\[data-view=cols\] \.bsortnote\{display:inline\}/);
});

test("in Columns the table is hidden and not drawn; each column gets its cards and its count", () => {
  paintBoard(Object.values(BOARD), "self", { layout: "cols", sort: "mcap" });
  assert.equal(dom.el("#lbox").dataset.view, "cols");
  assert.equal(dom.el("#ltable").hidden, true);
  assert.equal(dom.el("#lcols").hidden, false);
  assert.equal(dom.el("#lrows").appended.length, 0, "the table is not drawn while hidden");
  assert.equal(cardsIn("new"), "E A B F");
  assert.equal(cardsIn("near"), "B F A E");
  assert.equal(cardsIn("grad"), "D C G", "the table's sort does not reach a column");
  assert.deepEqual(["new", "near", "grad"].map((c) => dom.el("#lcn-" + c).textContent), ["4", "4", "3"]);
  for (const el of dom.el("#lcl-new").appended) {
    assert.match(el.markup, /^<div class="bmini link" data-token="0x[0-9a-f]{40}" data-b="[A-Z]+" tabindex="0">/, "a card opens its token page, and Tab reaches it");
  }

  paintBoard(Object.values(BOARD), "self", { layout: "table" });
  assert.equal(dom.el("#lbox").dataset.view, "table");
  assert.equal(dom.el("#ltable").hidden, false);
  assert.equal(dom.el("#lcols").hidden, true);
  assert.equal(dom.el("#lrows").appended.length, 7);
  assert.equal(dom.el("#lcl-new").appended.length, 0, "the columns are not drawn while hidden");
});

test("a column the filter empties says so; nothing matching at all says it once, with a way back", () => {
  paintBoard(Object.values(BOARD), "self", { layout: "cols", f: "risky" });
  assert.equal(cardsIn("new"), "F");
  assert.equal(dom.el("#lcn-grad").textContent, "0");
  assert.match(textOf(dom.el("#lcl-grad").markup), /^Nothing graduated in this filter$/);
  assert.equal(dom.el("#lcols").dataset.empty, "");

  paintBoard([BOARD.A], "self", { layout: "cols" });
  assert.match(textOf(dom.el("#lcl-grad").markup), /^Nothing graduated yet$/);

  paintBoard(Object.values(BOARD), "self", { layout: "cols", q: "nothing like it" });
  assert.equal(dom.el("#lcols").dataset.empty, "1");
  assert.match(textOf(dom.el("#lcempty").markup), /No launches match .* Show all 7/);
  assert.match(dom.el("#lcempty").markup, /data-bclear/);
});

test("before the first data the columns show skeleton cards; an empty board says so once", () => {
  dom.reset();
  rows.clear();
  S.boardReady = false;
  setBoardView({ f: "all", q: "", layout: "cols" });
  renderLaunches();
  for (const c of ["new", "near", "grad"]) {
    assert.equal((dom.el("#lcl-" + c).markup.match(/<div class="bmini bskel"/g) || []).length, 6, c);
  }
  S.boardReady = true;
  renderLaunches();
  assert.equal(dom.el("#lcols").dataset.empty, "1");
  assert.match(textOf(dom.el("#lcempty").markup), /Nothing on the board yet/);
  setBoardView({ layout: "table" });
});

test("a card: face, symbol and name with NEW, market cap, age, holders, graduation, the row's verdict badge, Buy", () => {
  const now = Date.now();
  const r = row(50, { symbol: "DIH", name: "Dih", sellable: false, fdvEth: 1, holders: 1, progress: 0.123, launchedAt: Math.floor(now / 1000) - 180 });
  const m = boardCard(r, true).s;
  const text = textOf(m);
  assert.match(m, /class="ringwrap"/);
  assert.match(m, /<span class="bsym">DIH<\/span><span class="ltag new"[^>]*>New<\/span><span class="ltag nosell" title="The sell simulation reverted — this cannot be exited">Can’t sell<\/span>/);
  assert.match(m, /<span class="bname">Dih<\/span>/);
  assert.match(m, /<b class="bmc">[^<]+<\/b>/, "the market cap");
  assert.match(text, /\b3m 1 holder 12\.3% to graduation\b/);
  assert.match(m, /<span class="bd band CLEAN" title="Risk 4 of 100">No issues found<\/span>/);
  assert.match(m, /data-buy="0x0000000000000000000000000000000000000050"/, "Buy is the trade bar's own button");
  assert.match(textOf(boardCard(row(51, { holders: 20 }), false).s), /\b20 holders\b/);
  assert.match(textOf(boardCard(row(52, { holders: null }), false).s), /— holders/);

  // The badge is the table's, word for word and tooltip for tooltip, in both modes.
  const badge = (x) => x.match(/<span class="bd band [^"]+" title="[^"]*">[^<]+<\/span>/)[0];
  for (const mode of ["self", "hosted"]) {
    S.mode = mode;
    try {
      for (const x of Object.values(BOARD)) assert.equal(badge(boardCard(x, false).s), badge(boardRow(x, false).s), `${mode} ${x.symbol}`);
      if (mode === "hosted") assert.match(badge(boardCard(BOARD.A, false).s), new RegExp(`title="Risk 10 of 100 · ${VERDICT_NOTE}"`));
    } finally { S.mode = "self"; }
  }
});

test("a graduated card says graduated, with what it migrated at; one still being checked shows no graduation", () => {
  const m = boardCard(row(53, { graduated: true, fdvEth: 30 }), false).s;
  assert.match(m, /<span title="Migrated at 4\.2764 Ξ — trading on Uniswap V4">graduated<\/span>/);
  assert.match(m, /<span class="bd band GRAD" [^>]*>Graduated<\/span>/);
  const checking = boardCard(BOARD.E, false).s;
  assert.doesNotMatch(textOf(checking), /graduat/);
  assert.match(checking, /<span class="bd band SCAN" title="analysing…">Checking<\/span>/);
  assert.doesNotMatch(checking, /data-buy/, "no trade bar until the check is done, as a row");
});

test("a card repainted with nothing changed is the same element; a launch in two columns is two elements", () => {
  const board = [row(60), row(61)];
  paintBoard(board, "self", { layout: "cols" });
  const first = { new: dom.el("#lcl-new").appended.slice(), near: dom.el("#lcl-near").appended.slice() };
  assert.notEqual(first.new[0], first.near.find((el) => el.markup === first.new[0].markup), "each column has its own");
  paintBoard(board, "self", { layout: "cols" });
  assert.equal(dom.el("#lcl-new").appended[0], first.new[0]);
  assert.equal(dom.el("#lcl-near").appended[0], first.near[0]);
  // A price tick on one launch rebuilds its two cards and nothing else.
  paintBoard([row(60, { fdvEth: 9 }), row(61)], "self", { layout: "cols" });
  const is60 = (el) => /0{38}60"/.test(el.markup);
  for (const c of ["new", "near"]) {
    const again = dom.el("#lcl-" + c).appended;
    assert.notEqual(again.find(is60), first[c].find(is60), c);
    assert.equal(again.find((el) => !is60(el)), first[c].find((el) => !is60(el)), c);
  }
});

test("the Columns CSS: three lists side by side, each scrolling on its own; tabs below 960px, one list at a time", () => {
  const css = read("../public/app.css");
  assert.match(css, /\.bcgrid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.bcol\{[^}]*height:calc\(100vh - 250px\)/);
  assert.match(css, /\.bclist\{[^}]*overflow-y:auto/);
  const narrow = css.slice(css.indexOf("@media (max-width:960px){"));
  assert.match(narrow, /\.bcols \.bctabs\{display:grid/);
  assert.match(narrow, /\.bcols\[data-col=near\] \.bcol:not\(\[data-col=near\]\)/);
  assert.match(narrow, /\.bclist\{overflow:visible\}/, "on a phone the page scrolls, not the list");
  assert.match(APP_HTML, /<div class="seg full bctabs" id="lctabs" role="group" aria-label="Column">/);
});

test("a Columns card keeps its symbol whole: the name is what gives way (U8)", () => {
  const css = read("../public/app.css");
  assert.match(css, /\.bmini \.btnm b\{flex:0 0 auto;min-width:0;max-width:100%\}/);
  assert.match(css, /\.bmini \.bsym\{max-width:none;min-width:0;white-space:nowrap\}/);
  assert.match(css, /\.bmini \.bname\{flex:1 1 0;min-width:0;/);
});
