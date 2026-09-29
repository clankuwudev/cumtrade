// The frame (u-redesign.md, U1): the top bar, the routes and their
// redirects, search as the checker, and the buy size in the bar.
//
// The top bar replaced the sidebar. What can be held here: every old address
// still lands on its page and the address bar says the new one; search finds
// board tokens and sends an address that is not on the board to the check;
// a typed buy size is only ever a plain decimal; the quick buy's controls
// are in the bar's popover and the bar's button says the size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { HOW_IT_WORKS, addressOf, go, navOf, resolve } from "../public/js/router.js";
import { SEARCH_LIMIT, searchResults } from "../public/js/pages/search.js";
import { customSize } from "../public/js/frame.js";
import { BUY_PRESETS, renderQuickBuy } from "../public/js/trade.js";

const APP_HTML = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");

const dom = stubDom();
globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = url; } };

// ------------------------------------------------------------- routes --

/** Where an address lands in a mode: the page, and the address bar after. */
const lands = (spec, mode) => {
  const { page, arg } = resolve(spec, mode);
  return [page, addressOf(page, page === "token" || page === "about" || (page === "positions" && mode === "hosted") ? arg : "")];
};

const A = "0x00000000000000000000000000000000000070a1";

test("the new addresses: the board at #/, then #/portfolio, #/learn, a token", () => {
  for (const mode of ["hosted", "self"]) {
    assert.deepEqual(lands("", mode), ["launches", "#/"]);
    assert.deepEqual(lands("token/" + A, mode), ["token", "#/token/" + A]);
    assert.deepEqual(lands("learn/" + HOW_IT_WORKS, mode), ["flow", "#/learn/how-it-works"]);
    // The Checker is no page since U4: search is the checker, and a checked address is its token's page.
    assert.deepEqual(lands("checker", mode), ["launches", "#/"]);
    assert.equal(resolve("checker", mode).search, true, "#/checker opens the board with search open");
    assert.deepEqual(lands("checker/" + A, mode), ["token", "#/token/" + A]);
    assert.ok(!resolve("checker/" + A, mode).search);
  }
  assert.deepEqual(lands("portfolio", "hosted"), ["positions", "#/portfolio"]);
  assert.deepEqual(lands("portfolio/" + A, "hosted"), ["positions", "#/portfolio/" + A]);
  assert.deepEqual(lands("learn", "hosted"), ["about", "#/learn"]);
  assert.deepEqual(lands("learn/terms", "hosted"), ["about", "#/learn/terms"]);
  // The Traders page is hosted only (x29-leaderboard.md, L2): the console lands on the board.
  assert.deepEqual(lands("traders", "hosted"), ["traders", "#/traders"]);
  assert.deepEqual(lands("traders", "self"), ["launches", "#/"]);
});

test("every old address lands somewhere sensible, under its new address", () => {
  const hosted = {
    "home": ["launches", "#/"], "launches": ["launches", "#/"],
    "positions": ["positions", "#/portfolio"], ["positions/" + A]: ["positions", "#/portfolio/" + A],
    "flow": ["flow", "#/learn/how-it-works"], "about": ["about", "#/learn"], "about/privacy": ["about", "#/learn/privacy"],
    ["checker/" + A]: ["token", "#/token/" + A], "checker": ["launches", "#/"], "sniper": ["launches", "#/"], "activity": ["launches", "#/"],
    "nope": ["launches", "#/"],
  };
  for (const [from, to] of Object.entries(hosted)) assert.deepEqual(lands(from, "hosted"), to, "hosted #/" + from);
  // The console keeps its own pages, and has no About: its Learn is the Flow.
  const self = {
    "home": ["launches", "#/"], "positions": ["positions", "#/portfolio"], "sniper": ["sniper", "#/sniper"],
    "activity": ["activity", "#/activity"], "about": ["flow", "#/learn/how-it-works"], "learn": ["flow", "#/learn/how-it-works"],
    "learn/terms": ["flow", "#/learn/how-it-works"], "flow": ["flow", "#/learn/how-it-works"],
  };
  for (const [from, to] of Object.entries(self)) assert.deepEqual(lands(from, "self"), to, "self #/" + from);
});

test("the nav lights Board on the board and a token, Portfolio, Learn on Flow and About, and the console's own", () => {
  assert.equal(navOf("launches"), "board");
  assert.equal(navOf("token"), "board");
  assert.equal(navOf("positions"), "portfolio");
  assert.equal(navOf("traders"), "traders");
  assert.equal(navOf("flow"), "learn");
  assert.equal(navOf("about"), "learn");
  assert.equal(navOf("sniper"), "sniper");
  assert.equal(navOf("activity"), "activity");
  assert.equal(navOf("checker"), "", "the Checker is no page and no nav item: search is the checker");
});

test("an old link corrects the address bar without a new history entry; a push sets it", () => {
  const saved = S.mode;
  try {
    S.mode = "hosted";
    dom.reset();
    globalThis.location.hash = "#/launches";
    go("launches", false);
    assert.equal(dom.el("#shell").dataset.page, "launches");
    assert.equal(globalThis.location.hash, "#/");
    globalThis.location.hash = "#/flow";
    go("flow", false);
    assert.equal(dom.el("#shell").dataset.page, "flow");
    assert.equal(globalThis.location.hash, "#/learn/how-it-works");
    globalThis.location.hash = "";
    go("", false);
    assert.equal(globalThis.location.hash, "", "no address at all is left alone");
    go("portfolio", true);
    assert.equal(globalThis.location.hash, "#/portfolio");
  } finally {
    S.mode = saved;
  }
});

// ------------------------------------------------------------- search --

const row = (token, symbol, name, fdvEth, over = {}) =>
  ({ token, curve: "0xc" + token.slice(3), symbol, name, fdvEth, status: "ready", band: "CLEAN", ...over });
const hex = (i) => "0x" + String(i).padStart(40, "0");
const BOARD = [
  row(hex(1), "DIH", "Dih", 0.5), row(hex(2), "AGI", "Artificial", 600), row(hex(3), "CABO", "Cabo", 90),
  row(hex(4), "AGIX", "Another", 20), row(hex(5), "XAGI", "agi fork", 900),
];

test("search with nothing typed lists the board's largest by market cap", () => {
  const r = searchResults("", BOARD);
  assert.equal(r.heading, "Top by market cap");
  assert.deepEqual(r.items.map((i) => i.row.symbol), ["XAGI", "AGI", "CABO", "AGIX", "DIH"]);
  const many = Array.from({ length: 20 }, (_, i) => row(hex(100 + i), "T" + i, "t", i));
  assert.equal(searchResults("", many).items.length, SEARCH_LIMIT);
});

test("search matches a symbol or a name, a symbol's start first, then by market cap", () => {
  const r = searchResults("agi", BOARD);
  assert.equal(r.heading, "Tokens");
  assert.deepEqual(r.items.map((i) => i.row.symbol), ["AGI", "AGIX", "XAGI"]);
  assert.deepEqual(searchResults("cabo", BOARD).items.map((i) => i.row.symbol), ["CABO"]);
  assert.deepEqual(searchResults("zzz", BOARD).items, []);
});

test("a pasted address on the board is its token; one that is not goes to the check", () => {
  const on = searchResults(" " + hex(3).toUpperCase().replace("0X", "0x") + " ", BOARD);
  assert.equal(on.heading, "On the board");
  assert.equal(on.items[0].row.symbol, "CABO");
  const byCurve = searchResults("0xc" + hex(3).slice(3), BOARD);
  assert.equal(byCurve.items[0].row.symbol, "CABO", "its curve's address finds it too");
  const off = searchResults(hex(77), BOARD);
  assert.equal(off.heading, "Not on the board");
  assert.deepEqual(off.items, [{ check: hex(77) }]);
});

// ------------------------------------------------------------ buy size --

test("a typed buy size is a plain decimal above zero, or nothing", () => {
  assert.equal(customSize("0.015"), 0.015);
  assert.equal(customSize(" .5 "), 0.5);
  assert.equal(customSize("0,03"), 0.03, "a decimal comma reads as a point");
  for (const bad of ["", "0", "0.0", "-1", "abc", "1e-3", "0x10", "1.2.3", "0.0000001", "1."]) {
    assert.equal(customSize(bad), null, JSON.stringify(bad));
  }
});

test("the quick buy draws into the top bar: the button says the size, the presets say which is on", () => {
  const saved = S.buySize;
  try {
    dom.reset();
    S.buySize = BUY_PRESETS[1];
    renderQuickBuy();
    assert.equal(dom.el("#sizelbl").textContent, `${BUY_PRESETS[1]} Ξ`);
    assert.match(dom.el("#qsizes").markup, new RegExp(`data-size="${BUY_PRESETS[1]}"\\s+aria-pressed="true"`));
    assert.equal(dom.el("#qcustom").value, "", "a preset leaves the custom field empty");
    S.buySize = 0.015;
    renderQuickBuy();
    assert.equal(dom.el("#sizelbl").textContent, "0.015 Ξ");
    assert.equal(dom.el("#qcustom").value, "0.015", "a size that is no preset is the custom one");
    assert.doesNotMatch(dom.el("#qsizes").markup, /aria-pressed="true"/);
  } finally {
    S.buySize = saved;
  }
});

// ------------------------------------------------------------ markup --

test("the top bar: no sidebar, no old search box, no block number; one popover holds the quick buy", () => {
  for (const gone of ['<aside class="side">', 'id="find"', 'id="findgo"', 'id="blockpill"', 'id="nav-launches"']) {
    assert.ok(!APP_HTML.includes(gone), gone);
  }
  const top = APP_HTML.slice(APP_HTML.indexOf('<header class="top"'), APP_HTML.indexOf("</header>"));
  for (const id of ["opensearch", "livepill", "pricepill", "sizebtn", "sizepop", "qsizes", "qslip", "qnote", "qrevrow", "whoami", "tw", "conn"]) {
    assert.ok(top.includes(`id="${id}"`), `#${id} is in the top bar`);
  }
  assert.match(top, /<button class="tchip" type="button" id="sizebtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="sizepop"/);
  assert.match(top, /<div class="pop" id="sizepop" role="dialog" aria-label="Quick buy size" hidden>/);
  // The wallet button's words, as the chips had them.
  assert.match(top, /<b id="twname">Log in<\/b>/);
  assert.match(top, /<b id="connname">Connect wallet<\/b>/);
  // The console's switches are in their strip, marked self only.
  const strip = APP_HTML.slice(APP_HTML.indexOf('<div class="selfstrip" data-self-only>'));
  assert.ok(strip.indexOf('id="syssw"') > 0 && strip.indexOf('id="armcard"') > 0 && strip.indexOf('id="armsw"') > 0);
});

test("the top bar gives way rather than run past the window (U8)", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // Search shrinks, and only then the wallet button.
  assert.match(css, /\.tsearch\{flex:0 10000 auto;min-width:36px\}/);
  assert.match(css, /\.top \.whoami\{flex:0 1 auto;min-width:0\}/);
  // At 980 and under the name beside the mark and the size's "Buy" go.
  assert.match(css, /@media \(max-width:980px\)\{\n {2}\.logo \.lname b,\.tchip \.lbl\{display:none\}/);
  // A short page keeps its scrollbar's room, so the bar does not jump.
  assert.match(css, /html\{scrollbar-gutter:stable\}/);
});
