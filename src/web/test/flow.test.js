// The Flow page's story (public-release F5.8).
//
// A visitor opens Flow and reads, above the curve cards: the edge we give
// them, why we exist, what we do with a trade from launch to sell, what it is
// built on, and what we control and what we cannot. The console shows the
// same story, word for word, under one line of its own. Held here:
//   - the order, and that the console adds only its one line;
//   - the edge is the headline and runs through it;
//   - no word promises anything or names the console's machinery;
//   - every number is a constant the code runs on, not typed twice;
//   - where a trade signs follows the origin, as About's trust section does,
//     and the honest line agrees with About's word for word;
//   - each drawing has a phone drawing with the same words and colours;
//   - the curve cards below still say what they said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubDom, textOf as tagsOut } from "./support/stubdom.js";
import { S, rows } from "../public/js/core/store.js";
import { PROJECT_TOKEN } from "../public/js/core/constants.js";
import { BANDS } from "../public/js/core/domain.js";
import { CHAIN_ID, MAX_SENDS_PER_MINUTE } from "../public/js/trade/constants.js";
import { IDLE_MS } from "../public/js/wallet/session.js";
import { renderFlow, storyWallet } from "../public/js/pages/flow.js";
import { aboutPage, isAboutSection } from "../public/js/pages/about.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const APP_HTML = read("../public/app.html");
const APP_CSS = read("../public/app.css");

const dom = stubDom();

/** The words a reader sees, with the typographic entities this page writes read as their characters. */
const textOf = (markup) => tagsOut(markup)
  .replace(/&rsquo;/g, "’").replace(/&mdash;/g, "—").replace(/&rsaquo;/g, "›");

/** `markup` with every element carrying `attr` taken out, children and all. */
function without(markup, attr) {
  let out = markup;
  for (;;) {
    const open = out.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\s${attr}\\b[^>]*>`, "i"));
    if (!open) return out;
    const tag = open[1].toLowerCase();
    const from = open.index + open[0].length;
    let depth = 1, end = -1;
    for (const m of out.slice(from).matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi"))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { end = from + m.index + m[0].length; break; }
    }
    assert.ok(end > 0, `<${tag}> closes`);
    out = out.slice(0, open.index) + out.slice(end);
  }
}

const FLOW_AT = APP_HTML.indexOf('<section class="pg" id="pg-flow">');
const FLOW = APP_HTML.slice(FLOW_AT, APP_HTML.indexOf("</section>", FLOW_AT));
const CURVE_HEADING = '<h2 class="sthd">How a clank.trade curve works</h2>';
const CURVE_AT = FLOW.indexOf(CURVE_HEADING);
/** The story: everything on Flow above the curve cards' heading. */
const STORY = FLOW.slice(0, CURVE_AT);
/** The curve cards, with their heading and intro. */
const CURVE = FLOW.slice(CURVE_AT);

/** The story as each reader gets it: the mode, and the wallet a trade signs with. */
const storyFor = ({ mode, wallet }) =>
  without(without(STORY, mode === "hosted" ? "data-self-only" : "data-hosted-only"), wallet === "trading" ? "data-own" : "data-tw");
const READERS = [
  { mode: "hosted", wallet: "trading" }, { mode: "hosted", wallet: "own" },
  { mode: "self", wallet: "trading" }, { mode: "self", wallet: "own" },
];

const SECTIONS = ["Why we exist", "What we do, from launch to sell", "What it is built on",
  "What we control, and what we cannot"];

/** The wide drawings in the story, and their phone drawings, in order. */
const drawingsIn = (markup) => ({
  wide: [...markup.matchAll(/<svg width="100%" viewBox="0 0 1120 [\s\S]*?<\/svg>/g)].map((m) => m[0]),
  phone: [...markup.matchAll(/<div class="flowphone"[^>]*>[\s\S]*?<\/div>/g)].map((m) => m[0]),
});

/** Run `fn` as a hosted page (with or without a trading wallet on this origin), and put things back after. */
function hosted(here, fn) {
  const saved = S.login.here;
  S.mode = "hosted";
  S.login.here = here;
  try { return fn(); } finally { S.mode = "self"; S.login.here = saved; }
}

// ------------------------------------------------------------ the order --

test("the story opens Flow, above the curve cards, in both modes", () => {
  assert.ok(CURVE_AT > 0, "the curve cards have their heading");
  const at = (s) => FLOW.indexOf(s);
  const order = [
    at("This is what the web app&rsquo;s visitors read"),
    at("<h1>Your edge on clank.trade</h1>"),
    ...SECTIONS.map((s) => at(`<h2 class="sthd">${s.replace("&", "&amp;")}</h2>`)),
    CURVE_AT,
    at("What a sell can draw from"),
    at("What happens at"),
  ];
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the spec's order");
  // One heading for the page, and it is the story's.
  assert.equal([...FLOW.matchAll(/<h1\b/g)].length, 1);
  // Nothing in the story is one mode's, but the console's one line.
  assert.doesNotMatch(STORY, /data-hosted-only/);
  assert.equal([...STORY.matchAll(/data-self-only/g)].length, 1);
});

test("the console adds only its one line, and a hosted page does not have it", () => {
  assert.match(STORY, /<p class="storyfor" data-self-only>This is what the web app&rsquo;s visitors read<\/p>/);
  const self = textOf(storyFor({ mode: "self", wallet: "trading" }));
  const pub = textOf(storyFor({ mode: "hosted", wallet: "trading" }));
  assert.ok(self.startsWith("This is what the web app’s visitors read Your edge on clank.trade"), self.slice(0, 80));
  assert.doesNotMatch(pub, /visitors read/);
  assert.equal(self, "This is what the web app’s visitors read " + pub, "otherwise word for word");
});

// ------------------------------------------------------------- the edge --

test("the edge is the headline, and runs through the story", () => {
  const words = textOf(storyFor({ mode: "hosted", wallet: "trading" }));
  const heading = STORY.match(/<h1>([^<]*)<\/h1>/)[1];
  assert.match(heading, /\bedge\b/i);
  assert.match(words, /Your edge on clank\.trade Faster, checked and better informed\. Faster .+ Checked .+ Better informed /);
  // Why we exist ends on it.
  assert.match(words, /We exist to give you an edge: [^.]+\. What we do, from launch to sell/);
});

test("the pipeline tags the steps the edge comes from, in both of its drawings", () => {
  const { wide, phone } = drawingsIn(STORY);
  const tagged = (svg) => [...svg.matchAll(/>EDGE<\/text>\s*<circle[^>]*\/>\s*<text[^>]*>\d+<\/text>\s*<text[^>]*>([^<]+)<\/text>/g)]
    .map((m) => m[1]);
  for (const svg of [wide[0], phone[0]]) {
    assert.deepEqual(tagged(without(svg, "data-own")), ["Checked", "Checked again", "Signed", "Sell approved ahead"]);
    // With the visitor's own wallet, the wallet asks each time: no edge in signing or in the sell.
    assert.deepEqual(tagged(without(svg, "data-tw")), ["Checked", "Checked again"]);
  }
  assert.match(STORY, /<span class="lgtag">EDGE<\/span>Where your edge comes from/);
});

// ------------------------------------------------------------ the words --

/** What the story must never say: a promise, or the console's machinery. */
const BANNED = /\bmanager\b|\bbots?\b|\bsnipers?\b|\bsafe|\bguarantee|\bprofit\b|\bguard\b|\bstop\b|dry[- ]run|\brisk[- ]free\b/i;

test("no word in the story promises anything or names the console's machinery, for any reader", () => {
  for (const reader of READERS) assert.doesNotMatch(textOf(storyFor(reader)), BANNED, JSON.stringify(reader));
  // Nor in the attributes a reader may be read aloud.
  for (const [, v] of STORY.matchAll(/\s(?:title|aria-label|alt)="([^"]*)"/g)) assert.doesNotMatch(v, BANNED);
});

test("every number in the story is a constant the code runs on, written by renderFlow", () => {
  // The markup holds none: the step numbers are the drawing's, and V4 is a name.
  for (const reader of READERS) {
    const words = textOf(storyFor(reader).replace(/<text[^>]*>\d{1,2}<\/text>/g, "")).replace(/\bV4\b/g, "");
    assert.doesNotMatch(words, /\d/, JSON.stringify(reader));
    assert.ok(!words.includes(PROJECT_TOKEN.symbol), "the token's symbol comes from PROJECT_TOKEN");
  }

  dom.reset();
  renderFlow();
  const idle = String(Math.round(IDLE_MS / 60_000));
  const expected = {
    bands: String(Object.keys(BANDS).length),
    chain: String(CHAIN_ID),
    idle,
    sends: String(MAX_SENDS_PER_MINUTE),
    cum: PROJECT_TOKEN.symbol,
    cumlink: PROJECT_TOKEN.symbol,
  };
  assert.deepEqual(expected, { bands: "4", chain: "4663", idle: "30", sends: "12", cum: "$CUM", cumlink: "$CUM" });
  const wide = [...STORY.matchAll(/id="fs-([a-z]+)"/g)].map((m) => m[1]).sort();
  const phone = [...STORY.matchAll(/id="fsp-([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(wide, Object.keys(expected).sort(), "every value in the story is one of these");
  assert.deepEqual(phone, ["bands"]);
  for (const [name, text] of Object.entries(expected)) assert.equal(dom.el("#fs-" + name).textContent, text, name);
  assert.equal(dom.el("#fsp-bands").textContent, expected.bands);
});

// ------------------------------------------------------ where it signs --

test("which wallet the story signs with follows the origin, as About's trust section does", () => {
  dom.reset();
  renderFlow();
  assert.equal(dom.el("#pg-flow").dataset.wallet, "trading", "the console tells the web app's story");
  assert.equal(storyWallet(), "trading");
  dom.reset();
  hosted(true, () => renderFlow());
  assert.equal(dom.el("#pg-flow").dataset.wallet, "trading");
  dom.reset();
  hosted(false, () => renderFlow());
  assert.equal(dom.el("#pg-flow").dataset.wallet, "own");
  // The page hides the other wallet's words by that mark alone.
  assert.match(APP_CSS, /#pg-flow\[data-wallet="own"\] \[data-tw\],\n#pg-flow:not\(\[data-wallet="own"\]\) \[data-own\]\{display:none\}/);
  // Unmarked, the markup reads as the trading wallet's (the default above).
  assert.doesNotMatch(STORY, /id="pg-flow"[^>]*data-wallet/);

  const own = textOf(storyFor({ mode: "hosted", wallet: "own" }));
  assert.doesNotMatch(own, /trading wallet|no wallet pop-up|no pop-up|Coinbase|approved ahead/i,
    "an origin with no trading wallet is not promised one");
  const tw = textOf(storyFor({ mode: "hosted", wallet: "trading" }));
  assert.match(tw, /Coinbase’s embedded wallet/);
  assert.match(tw, /Signed by your trading wallet, with no pop-up/);
});

test("the honest line is in amber, links to About › Trust, and says what About says", () => {
  const lines = [...STORY.matchAll(/<p class="honest" data-(tw|own)>([\s\S]*?)<\/p>/g)];
  assert.deepEqual(lines.map((m) => m[1]), ["tw", "own"]);
  // The links go straight to Learn since U6; #/about/… still lands there.
  for (const [, , body] of lines) assert.match(body, /<a class="storylink" href="#\/learn\/trust">About &rsaquo; Trust<\/a>$/);
  assert.match(APP_CSS, /\.honest\{[^}]*background:rgba\(255,179,64,\.1\);border:1px solid rgba\(255,179,64,\.35\)\}/);
  assert.match(APP_CSS, /\.honest b\{color:var\(--amb\)/);

  const tw = textOf(lines[0][2]), own = textOf(lines[1][2]);
  const TW = "Whoever controls the code this page runs can move what is in your trading wallet while you are logged in";
  const OWN = "Whoever controls the code this page runs could show you a different plan";
  assert.match(tw, new RegExp(`^${TW}, and that includes us\\. That is why the trading wallet is for trading money only\\.`));
  assert.match(own, new RegExp(`^${OWN}, and that includes us\\.`));
  // About's trust section says the same, for the same origin.
  const trust = (here) => textOf(hosted(here, () => aboutPage()).s.match(/<section[^>]*id="about-trust">[\s\S]*?<\/section>/)[0]);
  assert.ok(trust(true).includes(TW), "About, with a trading wallet");
  assert.ok(trust(false).includes(OWN), "About, with the visitor's own wallet");
});

test("the story says we hold $CUM, from PROJECT_TOKEN, and links to About's sections that exist", () => {
  assert.match(STORY, /<p class="storycum">We hold <b id="fs-cum">&mdash;<\/b>, this project&rsquo;s token on clank\.trade/);
  assert.match(STORY, /<a class="storylink" href="#\/learn\/cum">About &rsaquo; <span id="fs-cumlink">&mdash;<\/span><\/a>/);
  const links = [...STORY.matchAll(/href="#\/learn\/([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), ["cum", "source", "trust"]);
  for (const id of links) assert.ok(isAboutSection(id), id);
  // Every link in the story is one of those: nothing leaves the site from here.
  assert.equal([...STORY.matchAll(/<a\s/g)].length, links.length);
  // The console has no About page, so there they read as words.
  assert.match(APP_CSS, /body:not\(\[data-mode=hosted\]\) \.storylink\{pointer-events:none;/);
});

// ------------------------------------------------------------ drawings --

test("each drawing in the story has a phone drawing, with the same words for each wallet", () => {
  const { wide, phone } = drawingsIn(STORY);
  assert.equal(wide.length, 2, "what we do, and what we control");
  assert.equal(phone.length, 2);
  for (let i = 0; i < wide.length; i++) {
    assert.match(phone[i], /^<div class="flowphone" hidden>/, "hidden unless phone.css shows it");
    for (const v of ["data-tw", "data-own"]) {
      assert.equal(textOf(without(phone[i], v)), textOf(without(wide[i], v)), `drawing ${i + 1}, without ${v}`);
    }
  }
  // Each wide drawing is a card's own child, so phone.css hides it on a phone.
  for (const svg of wide) assert.ok(STORY.includes("\n" + " ".repeat(10) + svg.split("\n")[0]), "indented as a .flowcard child");
});

test("the story's drawings bring no colour the curve drawings do not already use", () => {
  const colours = (m) => new Set([...m.matchAll(/#[0-9a-f]{3,8}\b|rgba\([^)]*\)/gi)].map((x) => x[0].toLowerCase()));
  const known = colours(CURVE);
  const fresh = [...colours(STORY)].filter((c) => !known.has(c));
  assert.deepEqual(fresh, []);
});

test("the Flow page runs no script of its own", () => {
  assert.doesNotMatch(FLOW, /<script/i);
  assert.doesNotMatch(FLOW, /\son[a-z]+\s*=/i);
});

// ------------------------------------------------------- the curve cards --

test("the curve cards below the story still say what they said, in both modes", () => {
  // Their intro, legends and cards, each mode's.
  const selfCurve = textOf(without(CURVE, "data-hosted-only"));
  const pubCurve = textOf(without(CURVE, "data-self-only"));
  assert.match(selfCurve, /^How a clank\.trade curve works Where the money actually goes on a clank\.trade curve, and the two places it stops\. Both of these shape every exit the manager makes/);
  assert.match(pubCurve, /^How a clank\.trade curve works Where the money actually goes on a clank\.trade curve, and the two places it stops\. Both shape what a sell can get/);
  for (const words of ["What a sell can draw from", "The ceiling, exactly", "The fee, both ways"]) {
    assert.ok(selfCurve.includes(words) && pubCurve.includes(words), words);
  }

  // A frozen board, drawn by renderFlow: the values the cards show.
  const frozen = (mode) => {
    dom.reset();
    rows.clear();
    rows.set("0x1", { token: "0x1", symbol: "TKN", status: "ready", graduated: false, raised: 1.2345, phantomEth: 1.68,
      threshold: 4.2764, feeBps: 100 });
    rows.set("0x2", { token: "0x2", symbol: "OLD", status: "ready", graduated: true, raised: 4.3, phantomEth: 1.68,
      threshold: 4.2764, feeBps: 100 });
    Object.assign(S, {
      cfg: { sizing: [{ key: "SNIPE_AMOUNT_ETH", value: "0.02" }], exits: [{ key: "EXIT_BEFORE_GRADUATION_PCT", value: "90" }] },
      buySize: 0.05,
      positions: { open: [], closed: [] },
    });
    const run = () => renderFlow();
    if (mode === "hosted") hosted(true, run); else run();
    const ids = ["caption", "real", "phantom", "buy", "thr", "thr2", "guardpct", "guard", "gradnote", "guardcost",
      "feein", "feeout", "feenote"];
    return Object.fromEntries(ids.map((id) => [id, dom.el("#fl-" + id).textContent]));
  };
  try {
    const self = frozen("self");
    assert.equal(self.real, dom.el("#flp-real").textContent);
    assert.deepEqual(Object.keys(self).filter((k) => self[k] === ""), [], "every card value is written");
    assert.match(self.caption, /^TKN — a curve that has raised /);
    assert.equal(self.guardpct, "90%");
    assert.equal(self.feein, "100 bps");
    assert.equal(self.gradnote, "1 launch has graduated — the migration is observable");
    assert.match(self.feenote, /dry-run entry/);
    const pub = frozen("hosted");
    assert.equal(pub.caption, self.caption);
    assert.doesNotMatch(pub.feenote, /dry-run/);
  } finally {
    rows.clear();
    Object.assign(S, { cfg: null, buySize: 0.01 });
  }
});
