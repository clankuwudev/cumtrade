// The phone layout (public-release F5.7).
//
// Almost all of it is phone.css, which no unit test can lay out. What can be
// held here is the structure that keeps it safe to change:
//   - every rule in phone.css is inside a max-width query of 980px or less,
//     so nothing in it can reach the desktop layout;
//   - the script's idea of "a phone" is the stylesheet's;
//   - the tab bar and the top bar's nav list the same pages, and each tab
//     can be marked as the current page (U1: the sidebar became the top bar);
//   - the Flow page's live values reach both of its drawings;
//   - the chart's width and readout follow the phone query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom } from "./support/stubdom.js";
import { PHONE_QUERY, chartWidth, isPhone, onPhoneChange, tipLeft } from "../public/js/core/layout.js";
import { renderFlow } from "../public/js/pages/flow.js";
import { S } from "../public/js/core/store.js";
import { navOf, resolve } from "../public/js/router.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const PHONE_CSS = read("../public/phone.css");
const APP_CSS = read("../public/app.css");
const APP_HTML = read("../public/app.html");

const dom = stubDom();

// -------------------------------------------------------- phone.css --

/**
 * Every style rule in a stylesheet, with the at-rules it sits inside.
 * Enough of a parser for this file: comments out, then braces.
 *
 * @returns {{ selector: string, body: string, within: string[] }[]}
 */
function rulesOf(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      stack.push({ prelude: src.slice(start, i).trim(), open: i + 1 });
      start = i + 1;
    } else if (src[i] === "}") {
      const top = stack.pop();
      assert.ok(top, `an unmatched } at ${i}`);
      if (!top.prelude.startsWith("@")) {
        rules.push({ selector: top.prelude, body: src.slice(top.open, i).trim(), within: stack.map((s) => s.prelude) });
      }
      start = i + 1;
    }
  }
  assert.equal(stack.length, 0, "every { is closed");
  return rules;
}

/** Does this @media prelude only ever match at 980px wide or less? */
const narrowOnly = (prelude) => {
  const m = prelude.match(/^@media\s+(.+)$/s);
  if (!m) return false;
  // A comma is "or": each query must carry its own max-width.
  return m[1].split(",").every((q) => {
    const w = q.match(/\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/);
    return w !== null && Number(w[1]) <= 980 && !/\bnot\b/.test(q);
  });
};

test("every rule in phone.css is inside a max-width query of 980px or less", () => {
  const rules = rulesOf(PHONE_CSS);
  assert.ok(rules.length > 50, `parsed ${rules.length} rules`);
  const loose = rules.filter((r) => !r.within.some(narrowOnly));
  assert.deepEqual(loose.map((r) => r.selector), [], "rules that could apply to the desktop layout");
});

test("the check itself: a rule outside a query, or in a wide or open one, is caught", () => {
  const caught = (css) => rulesOf(css).some((r) => !r.within.some(narrowOnly));
  assert.ok(caught(".a { color: red }"));
  assert.ok(caught("@media (max-width: 1100px) { .a { color: red } }"));
  assert.ok(caught("@media (max-width: 680px), (pointer: coarse) { .a { color: red } }"), "the second query has no width");
  assert.ok(caught("@supports (height: 100dvh) { .a { min-height: 100dvh } }"));
  assert.ok(caught("@media not all and (max-width: 680px) { .a { color: red } }"));
  assert.ok(!caught("@media (max-width: 980px) { @supports (height: 100dvh) { .a { min-height: 100dvh } } }"));
  assert.ok(!caught("@media (max-width: 680px), (max-width: 980px) and (pointer: coarse) { .a { color: red } }"));
});

test("the script's phone query is the stylesheet's phone block", () => {
  const blocks = [...PHONE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@media\s+([^{]+)\{/g)].map((m) => m[1].trim());
  assert.ok(blocks.includes(PHONE_QUERY), `${PHONE_QUERY} among ${JSON.stringify(blocks)}`);
  // The block that shows the tab bar is that one.
  const tabbar = rulesOf(PHONE_CSS).filter((r) => /(^|,)\s*\.tabbar\s*(,|$)/.test(r.selector) && /display:\s*flex/.test(r.body));
  assert.equal(tabbar.length, 1);
  assert.deepEqual(tabbar[0].within, [`@media ${PHONE_QUERY}`]);
});

test("phone.css brings no colour of its own: every colour is one of app.css's tokens", () => {
  const body = PHONE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(body.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [], []);
  // Hyphens too: the redesign's tokens (U0) are named --sp-4, --r-lg and so on.
  const tokens = new Set([...APP_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const [, name] of body.matchAll(/var\((--[a-z0-9-]+)\)/g)) assert.ok(tokens.has(name), name);
});

// --------------------------------------------------------- the tab bar --
// Since U1 the pages are the top bar's nav, and on a phone the tab bar's:
// Board, Portfolio, Search, Learn, and the console's own pages after them.

/** The `<a data-nav>` links in a stretch of markup: where each goes, what it lights, and its mode mark. */
const linksIn = (markup) => [...markup.matchAll(/<a href="(#\/[^"]*|\/ai)" data-nav="([a-z]+)"( data-(?:self|hosted)-only)?>/g)]
  .map((m) => ({ href: m[1], nav: m[2], only: (m[3] ?? "").trim() }));

const topnavAt = APP_HTML.indexOf('<nav class="tnav"');
const topnav = APP_HTML.slice(topnavAt, APP_HTML.indexOf("</nav>", topnavAt));
const tabbarAt = APP_HTML.indexOf('<nav class="tabbar"');
const tabbar = APP_HTML.slice(tabbarAt, APP_HTML.indexOf("</nav>", tabbarAt));

test("the tab bar lists the top bar's pages, in order, with the same mode marks", () => {
  assert.ok(topnavAt > 0, "app.html has the top bar's nav");
  assert.ok(tabbarAt > 0, "app.html has the tab bar");
  assert.ok(!APP_HTML.includes('<aside class="side">'), "no sidebar");
  const nav = linksIn(topnav), tabs = linksIn(tabbar);
  assert.ok(nav.length >= 5);
  assert.deepEqual(tabs, nav);
});

test("a hosted page has six tabs: Board, Portfolio, Traders, Search, Learn, cumAI (x29-leaderboard.md, L2; L1 L3)", () => {
  const hostedTabs = [...tabbar.matchAll(/<(a href="(?:#\/[^"]*|\/ai)" data-nav="([a-z]+)"|button type="button" data-search)( data-(?:self|hosted)-only)?[^>]*>(?:<svg[\s\S]*?<\/svg>)([^<]+)/g)]
    .filter((m) => m[3] !== " data-self-only").map((m) => m[4]);
  assert.deepEqual(hostedTabs, ["Board", "Portfolio", "Traders", "Search", "Learn", "cumAI"]);
  // At 375 px, less the bar's 6 px each side and 2 px between tabs, each is
  // still well over the 44 px touch floor.
  assert.ok((375 - 12 - 2 * (hostedTabs.length - 1)) / hostedTabs.length >= 44);
  // Each tab's address lands on the page whose nav item it is, in its mode.
  // cumAI's is another page (L4b): it leaves, hosted only.
  for (const t of linksIn(tabbar)) {
    const mode = t.only === "data-self-only" ? "self" : "hosted";
    if (!t.href.startsWith("#/")) {
      assert.deepEqual([t.href, t.nav, t.only], ["/ai", "ai", "data-hosted-only"]);
      continue;
    }
    assert.equal(navOf(resolve(t.href.slice(2), mode).page), t.nav, `${t.href} lights ${t.nav}`);
  }
});

test("the tab bar is hidden unless phone.css shows it", () => {
  // If the stylesheet fails to load, the page is the desktop's top bar rather
  // than a stray list of links.
  assert.match(tabbar, /^<nav class="tabbar" id="tabbar" aria-label="Pages" hidden>/);
  assert.ok(APP_HTML.lastIndexOf("</nav>") < APP_HTML.indexOf('<div id="toasts">'), "inside the shell, before it closes");
  assert.match(APP_HTML, /<link rel="stylesheet" href="\/app\.css">\r?\n<link rel="stylesheet" href="\/phone\.css">/, "phone.css loads after app.css");
  assert.match(APP_HTML, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/,
    "viewport-fit=cover, or iOS reports no safe-area insets");
});

// ------------------------------------------------------------- Flow --

test("every value in a Flow drawing is in both drawings, and renderFlow writes both", () => {
  const wide = new Set([...APP_HTML.matchAll(/id="fl-([a-z0-9]+)"/g)].map((m) => m[1]));
  const phone = [...APP_HTML.matchAll(/id="flp-([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(phone.sort(), ["buy", "guard", "guardpct", "phantom", "real", "thr2"]);
  for (const name of phone) assert.ok(wide.has(name), `#fl-${name} exists`);

  dom.reset();
  renderFlow();
  for (const name of phone) {
    const a = dom.el("#fl-" + name).textContent, b = dom.el("#flp-" + name).textContent;
    assert.ok(a !== "", `#fl-${name} was written`);
    assert.equal(b, a, `#flp-${name} says what #fl-${name} says`);
  }
});

test("the phone drawings are hidden unless phone.css shows them", () => {
  // Five: the story's two, what we do and what we control (F5.8), in both
  // modes; the ceiling; and the graduation drawing twice, the console's and a
  // hosted page's (F5.3), each marked for its mode.
  const wrappers = [...APP_HTML.matchAll(/<div class="flowphone"( data-(?:self|hosted)-only)?( hidden)?>/g)];
  assert.deepEqual(wrappers.map((m) => m[1] ?? ""), ["", "", "", " data-self-only", " data-hosted-only"]);
  assert.ok(wrappers.every((m) => m[2] === " hidden"));
});

test("every value in the hosted graduation drawing is in both of its drawings, and renderFlow writes both", () => {
  const wide = [...APP_HTML.matchAll(/id="flh-([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  const phone = [...APP_HTML.matchAll(/id="flhp-([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(wide, ["thr2"]);
  assert.deepEqual(phone, wide);

  dom.reset();
  S.mode = "hosted";
  try {
    renderFlow();
  } finally {
    S.mode = "self";
  }
  for (const name of wide) {
    const a = dom.el("#flh-" + name).textContent, b = dom.el("#flhp-" + name).textContent;
    assert.ok(a !== "", `#flh-${name} was written`);
    assert.equal(b, a, `#flhp-${name} says what #flh-${name} says`);
  }
});

// ---------------------------------------------------- core/layout.js --

test("isPhone reads the phone query, and is false with no window", () => {
  const saved = globalThis.matchMedia;
  try {
    delete globalThis.matchMedia;
    assert.equal(isPhone(), false);
    const asked = [];
    globalThis.matchMedia = (q) => { asked.push(q); return { matches: true, addEventListener() {} }; };
    assert.equal(isPhone(), true);
    globalThis.matchMedia = (q) => { asked.push(q); return { matches: false, addEventListener() {} }; };
    assert.equal(isPhone(), false);
    assert.deepEqual(asked, [PHONE_QUERY, PHONE_QUERY]);
  } finally {
    if (saved) globalThis.matchMedia = saved; else delete globalThis.matchMedia;
  }
});

test("onPhoneChange calls back when the page crosses the breakpoint", () => {
  const saved = globalThis.matchMedia;
  try {
    delete globalThis.matchMedia;
    onPhoneChange(() => assert.fail("no window, no listener"));
    let listener = null, asked = null;
    globalThis.matchMedia = (q) => ({ matches: false, addEventListener: (type, fn) => { asked = [q, type]; listener = fn; } });
    const seen = [];
    onPhoneChange((phone) => seen.push(phone));
    assert.deepEqual(asked, [PHONE_QUERY, "change"]);
    listener({ matches: true });
    listener({ matches: false });
    assert.deepEqual(seen, [true, false]);
  } finally {
    if (saved) globalThis.matchMedia = saved; else delete globalThis.matchMedia;
  }
});

test("the chart is drawn 600 wide on a desktop, as before, and 340 on a phone", () => {
  assert.equal(chartWidth(false), 600);
  assert.equal(chartWidth(true), 340);
});

test("the readout stays inside the chart's box", () => {
  // A 300px box and a 100px readout, centred on the pointer where it fits.
  assert.equal(tipLeft(150, 300, 100), 150);
  assert.equal(tipLeft(10, 300, 100), 50, "near the left edge it moves right");
  assert.equal(tipLeft(295, 300, 100), 250, "near the right edge it moves left");
  assert.equal(tipLeft(-20, 300, 100), 50);
  assert.equal(tipLeft(400, 300, 100), 250);
  assert.equal(tipLeft(20, 80, 120), 40, "wider than the box: centred on it");
});

test("the plan sheet's step rows: the step, its tx and its status on one line, its words under them (U8)", () => {
  const css = PHONE_CSS.replace(/\r\n/g, "\n");
  assert.match(css, /\.plansheet \.wrow:has\(> \.pill\) \{\n\s+display: grid;[^}]*grid-template-areas: "k \. tx st" "v v v v"/);
  assert.match(css, /\.plansheet \.wrow:has\(> \.pill\) > \.pill \{ grid-area: st; margin-left: 0 !important \}/);
});
