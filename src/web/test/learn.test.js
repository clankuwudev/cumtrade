// Learn (u-redesign.md, U6): How it works and About under one docs layout.
//
// One page with a table of contents on the left: Learn → How it works, then
// About's own sections, grouped About and Legal. What can be held here: the
// contents are About's sections, in its order and with its labels; every
// entry's address lands on its page and section; the router lights the
// entry the address names; a self page, which has no About, gets no
// contents; the markup puts the contents and both pages in one layout; and
// no link on the site still says #/about (the router keeps taking it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { ABOUT_HREF } from "../public/js/core/domain.js";
import { PROJECT_TOKEN } from "../public/js/core/constants.js";
import { aboutPage, aboutSections } from "../public/js/pages/about.js";
import { HOW_IT_WORKS, learnGroups, learnHref, learnToc, renderLearn } from "../public/js/pages/learn.js";
import { go, resolve } from "../public/js/router.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const APP_HTML = read("../public/app.html");
const APP_CSS = read("../public/app.css");

const dom = stubDom();
globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = url; } };

/** Run `fn` as a hosted page, and put the mode back after. */
function hosted(fn) {
  S.mode = "hosted";
  try { return fn(); } finally { S.mode = "self"; }
}

/** The entry an element's markup lights, if any. */
const lit = (markup) => [...markup.matchAll(/data-sec="([a-z-]+)" aria-current="location"/g)].map((m) => m[1]);

// ------------------------------------------------------------ contents --

test("the contents: Learn, then About's own sections under About, Developers and Legal, in its order", () => {
  const groups = hosted(() => learnGroups()).map((g) => [g.title, g.items.map((s) => s.label)]);
  assert.deepEqual(groups, [
    ["Learn", ["How it works"]],
    ["About", ["About", "Beta", "Not advice", "clank.trade", PROJECT_TOKEN.symbol, "Verdicts", "Moderation", "Trust",
      "Official site", "Source"]],
    ["Developers", ["Data API", "AI API"]],
    ["Legal", ["Terms", "Privacy"]],
  ]);
  // Nothing of About's left out or added: its sections, in its order. The one
  // entry that is not About's is cumAI's API docs, on their own page (L1 L4).
  const items = hosted(() => learnGroups()).flatMap((g) => g.items);
  assert.deepEqual(items.filter((s) => !s.href).map((s) => s.id), [HOW_IT_WORKS, ...aboutSections().map((s) => s.id)]);
  assert.deepEqual(items.filter((s) => s.href).map((s) => [s.id, s.href]), [["ai-api", "/ai#/docs"]]);
  assert.match(hosted(() => learnToc("what")).s, /<a href="\/ai#\/docs" data-sec="ai-api">AI API<\/a>/);
  assert.equal(textOf(hosted(() => learnToc("what")).s),
    "Learn How it works About About Beta Not advice clank.trade $CUM Verdicts Moderation Trust Official site Source Developers Data API AI API Legal Terms Privacy");
});

test("every entry's address lands on its page and section", () => {
  assert.equal(learnHref(HOW_IT_WORKS), "#/learn/how-it-works");
  assert.equal(learnHref("what"), "#/learn", "About is the page's top");
  for (const { items } of hosted(() => learnGroups())) {
    for (const { id } of items) {
      const { page, arg } = resolve(learnHref(id).slice(2), "hosted");
      if (id === HOW_IT_WORKS) assert.deepEqual([page, arg], ["flow", ""]);
      else assert.deepEqual([page, arg], ["about", id === "what" ? "" : id], id);
    }
  }
});

test("the router lights the entry the address names", () => {
  const toc = () => dom.el("#learntoc").markup;
  for (const [spec, entry, at] of [
    ["learn/how-it-works", HOW_IT_WORKS, "#/learn/how-it-works"],
    ["flow", HOW_IT_WORKS, "#/learn/how-it-works"],
    ["learn", "what", "#/learn"],
    ["learn/terms", "terms", "#/learn/terms"],
    ["learn/cum", "cum", "#/learn/cum"],
    ["about/privacy", "privacy", "#/learn/privacy"],
    ["about/trust", "trust", "#/learn/trust"],
    ["learn/nope", "what", "#/learn/nope"],
  ]) {
    dom.reset();
    globalThis.location.hash = "#/" + spec;
    hosted(() => go(spec, false));
    assert.deepEqual(lit(toc()), [entry], spec);
    assert.equal(globalThis.location.hash, at, spec);
  }
  // About's section is drawn, and the contents beside it.
  assert.match(dom.el("#aboutbody").markup, /id="about-trust"/);
});

test("a self page has no contents: its Learn is How it works alone", () => {
  dom.reset();
  dom.el("#learntoc").markup = "stale";
  globalThis.location.hash = "#/learn";
  go("learn", false);
  assert.equal(dom.el("#shell").dataset.page, "flow");
  assert.equal(dom.el("#learntoc").markup, "");
  dom.reset();
  renderLearn("flow");
  assert.equal(dom.el("#learntoc").markup, "");
});

// ------------------------------------------------------------- markup --

test("one layout holds the contents, How it works and About, the contents hosted only", () => {
  const at = APP_HTML.indexOf('<div class="learn">');
  const end = APP_HTML.indexOf("</div><!-- .learn -->");
  assert.ok(at > 0 && end > at);
  const learn = APP_HTML.slice(at, end);
  const order = ['<nav class="toc" id="learntoc" aria-label="Learn" data-hosted-only></nav>',
    '<section class="pg" id="pg-flow">', '<section class="pg" id="pg-about" data-hosted-only>'].map((s) => learn.indexOf(s));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // No other page inside it.
  assert.equal([...learn.matchAll(/<section class="pg"/g)].length, 2);
  // How it works may run to its drawings' width; About reads at a measure.
  assert.match(learn, /<section class="pg" id="pg-flow">\n {6}<div class="page doc wide">/);
  assert.match(learn, /<div class="page doc" id="aboutbody"><\/div>/);
  // Sticky on a desktop, one row that scrolls sideways under 960.
  assert.match(APP_CSS, /\.toc\{position:sticky;/);
  assert.match(APP_CSS, /@media \(max-width:960px\)\{\n {2}\.learn\{grid-template-columns:minmax\(0,1fr\)[^}]*\}\n {2}\.toc\{[^}]*flex-direction:row;overflow-x:auto/);
  // Shown only on its two pages.
  assert.match(APP_CSS, /\.learn\{display:none;/);
  assert.match(APP_CSS, /#shell\[data-page=flow\] \.learn,#shell\[data-page=about\] \.learn\{display:grid\}/);
});

test("no link on the site says #/about any more: they go straight to Learn", () => {
  assert.doesNotMatch(APP_HTML, /href="#\/about/);
  assert.doesNotMatch(hosted(() => aboutPage()).s, /href="#\/about/);
  // The verdict note leads to About's Verdicts section.
  assert.deepEqual(resolve(ABOUT_HREF.slice(2), "hosted"), { page: "about", arg: "verdicts" });
  // Old links still land (U1's redirects).
  assert.deepEqual(resolve("about/verdicts", "hosted"), { page: "about", arg: "verdicts" });
  assert.deepEqual(resolve("flow", "hosted"), { page: "flow", arg: "" });
});

test("How it works takes the pill row from 1180 down, so its drawings keep the width; About keeps its side contents (U8)", () => {
  const m = APP_CSS.match(/@media \(max-width:1180px\)\{\n {2}#shell\[data-page=flow\] \.learn\{grid-template-columns:minmax\(0,1fr\)[^}]*\}\n {2}#shell\[data-page=flow\] \.toc\{[^}]*flex-direction:row;overflow-x:auto[^}]*\}([^@]*)\}/);
  assert.ok(m, "the flow page's own block");
  assert.doesNotMatch(m[0], /data-page=about/);
});
