// About, terms and disclosure, the beta, and the hosted Flow words
// (public-release F5.3).
//
// A hosted page has an About page, reached from a footer link on every page,
// with every section the spec lists. It says plainly that the operator holds
// $CUM, and its contact link leaves no opener or referrer. The beta badge and
// notice are hosted only, the notice's dismissal survives storage that throws,
// and a self page has none of it: no route, no badge, no notice. The hosted
// Flow page names no manager and no bot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stubDom, textOf as tagsOut } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { CONTACT, PROJECT_TOKEN, SITE_DOMAIN, STAGE, TERMS_VERSION } from "../public/js/core/constants.js";
import { ABOUT_SECTIONS, aboutPage, isAboutSection, renderAbout } from "../public/js/pages/about.js";
import { BETA_DISMISSED, dismissBeta, showBeta } from "../public/js/pages/beta.js";
import { renderFlow } from "../public/js/pages/flow.js";
import { go } from "../public/js/router.js";
import { learnHref, learnToc } from "../public/js/pages/learn.js";

/** beta.js again, for a fresh copy of its module state (a query makes it another module). */
const BETA_MODULE = new URL("../public/js/pages/beta.js", import.meta.url).href;

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const APP_HTML = read("../public/app.html");

const dom = stubDom();

/** The words a reader sees, with the typographic entities this page writes read as their characters. */
const textOf = (markup) => tagsOut(markup)
  .replace(/&rsquo;/g, "’").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”")
  .replace(/&mdash;/g, "—").replace(/&middot;/g, "·");
globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = url; } };

/** Run `fn` as a hosted page, and put the mode back after. */
function hosted(fn) {
  S.mode = "hosted";
  try { return fn(); } finally { S.mode = "self"; }
}

/** A localStorage stand-in: a map, or one whose every call throws. */
function storage({ throws = false } = {}) {
  const m = new Map();
  const fail = () => { throw new Error("SecurityError: storage is blocked"); };
  return {
    map: m,
    getItem: throws ? fail : (k) => (m.has(k) ? m.get(k) : null),
    setItem: throws ? fail : (k, v) => { m.set(k, String(v)); },
    removeItem: throws ? fail : (k) => { m.delete(k); },
  };
}

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
const flowSection = APP_HTML.slice(FLOW_AT, APP_HTML.indexOf("</section>", FLOW_AT));

/** One section of the hosted About page, as markup. */
const aboutSection = (id) => hosted(() => aboutPage()).s.match(new RegExp(`<section[^>]*id="about-${id}">[\\s\\S]*?</section>`))[0];

// ------------------------------------------------------------ the page --

// U6: the page is Learn's, one long page; its contents are Learn's table of
// contents beside it (#/learn/<id>), not the chips it used to carry.
test("a hosted About page draws every section, in order, each its own link", () => {
  const markup = hosted(() => aboutPage()).s;
  const ids = [...markup.matchAll(/<section class="card cardpad about[^"]*" id="about-([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, ABOUT_SECTIONS.map((s) => s.id));
  // The spec's list: what this is, affiliation, not advice, how verdicts are
  // made, the conflict, moderation, the trust model, privacy, the terms, the
  // source; and the beta (the user, 2026-09-23).
  for (const id of ["what", "beta", "advice", "affiliation", "cum", "verdicts", "moderation", "trust",
    "official", "source", "terms", "privacy"]) assert.ok(ids.includes(id), id);
  const toc = hosted(() => learnToc("what")).s;
  for (const id of ids) {
    assert.ok(toc.includes(`<a href="${learnHref(id)}" data-sec="${id}"`), `the contents link to ${id}`);
    assert.ok(isAboutSection(id));
  }
  assert.doesNotMatch(markup, /abouttoc|#\/about\//, "no contents of its own, and no old addresses");
  assert.equal(isAboutSection("nope"), false);
});

test("it says plainly that the operator holds $CUM, and gives its address", () => {
  const words = textOf(aboutSection("cum"));
  assert.equal(PROJECT_TOKEN.symbol, "$CUM");
  assert.match(words, /We hold \$CUM, this project’s token on clank\.trade\./);
  assert.ok(words.includes(PROJECT_TOKEN.address), "the address is on the page");
  assert.match(words, /may hold tokens that appear on this board/);
});

test("the contact is @0xzer0ai on X, from the constant, in a link with no opener or referrer", () => {
  assert.deepEqual(CONTACT, { label: "@0xzer0ai on X", href: "https://x.com/0xzer0ai" });
  const markup = hosted(() => aboutPage()).s;
  const links = [...markup.matchAll(/<a [^>]*href="https:\/\/x\.com\/0xzer0ai"[^>]*>([^<]*)<\/a>/g)];
  assert.ok(links.length >= 2, "in the beta section and elsewhere");
  for (const [a, text] of links) {
    assert.match(a, / rel="noopener noreferrer"/);
    assert.match(a, / target="_blank"/);
    assert.equal(text, "@0xzer0ai on X");
  }
  assert.match(textOf(aboutSection("beta")), /To report a problem, write to @0xzer0ai on X/);
  // Every link that leaves the site leaves nothing behind it.
  for (const [a] of markup.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) assert.match(a, / rel="noopener noreferrer"/, a);
});

test("the page names the one official domain, not a placeholder", () => {
  assert.equal(SITE_DOMAIN, "clankuwu.com");
  const markup = hosted(() => aboutPage()).s;
  assert.match(markup, /<code class="mo">https:\/\/clankuwu\.com<\/code>/);
  assert.ok(!/cumtrade/.test(markup), "the old domain is gone from the page");
  assert.ok(!/&lt;domain&gt;|<domain>/.test(markup), "no placeholder left");
});

test("the beta section, the verdicts, moderation, privacy and the terms say what they must", () => {
  const words = textOf(hosted(() => aboutPage()).s);
  assert.equal(STAGE, "Beta");
  assert.match(words, /This is beta software/);
  assert.match(words, /Keep only trading money in your trading wallet/);
  assert.match(words, /Not affiliated with clank\.trade/);
  assert.match(words, /Not financial advice/);
  assert.match(words, /“No issues found” means only that these checks found nothing wrong/);
  assert.match(words, /src\/core\/checker\/rules\.ts/);
  assert.match(words, /Hiding never touches a verdict/);
  assert.match(words, /No cookies from us on this site, no analytics, no ads and no trackers\. Signing in to cumAI is the one exception, below\./);
  assert.match(words, /at most five files of 50 MB/);
  assert.match(words, /Terms of use/);
  assert.match(words, /Smart-contract wallets/);
  assert.match(words, /MIT licence/);
});

test("cumAI's terms and privacy, as the user approved them (stage C, C1 at f9cdcd0; C6; X15d)", () => {
  const markup = hosted(() => aboutPage()).s;
  const words = textOf(markup);
  // The terms: the opening line with cumAI and the age line, item 7, and the cumAI group, 10 to 18.
  assert.match(words, /By using this site, or by signing in to cumAI, you agree to these terms\. If you do not agree, do not use it\. You must be old enough to agree to these terms where you live\./);
  assert.match(words, /Uniswap, clank\.trade, and the AI model suppliers and makers behind cumAI, are other companies’ services/);
  assert.match(markup, /<h3>cumAI<\/h3>\s*<ol start="10">/);
  const group = markup.slice(markup.indexOf('<ol start="10">'), markup.indexOf("</ol>", markup.indexOf('<ol start="10">')));
  assert.equal((group.match(/<li>/g) ?? []).length, 9, "items 10 to 18");
  for (const line of [
    /not by us or by clankchan\. They can be wrong, out of date, made up or offensive\./,
    /No answer is financial, investment, legal or tax advice, and nothing a model says is a reason to buy, sell or hold any token\./,
    /cumAI is not our support\. It cannot see your account, your wallets or your trades\./,
    /Never paste a recovery phrase, private key, password or API key\. cumAI refuses text that looks like a recovery phrase, but that check can miss one\./,
    /a key or wallet that keeps sending them is paused for a while/,
    /Using several wallets to take more than one allowance is not allowed\./,
    // X15d, approved by the user ("approve"): item 15's first sentence, and item 18.
    /The free playground gives each signed-in wallet a small allowance a day and a few free pictures, while the day’s shared budget lasts\./,
    /cumAI can make pictures\. A picture is made by another company’s model and can be wrong, odd or unlike what you asked for\. Every picture is checked, with its prompt, against a content policy before you see it; one that breaks it is withheld, and still counts against your allowance or balance, because it was made\. You are responsible for what you ask for and for what you do with a picture: don’t use one to pass yourself off as a real person or a company, as a token’s official art, or to break anyone’s rights\./,
    /The status we show is measured, not promised\./,
    /It names this site, and the version of these terms you accept\. When the terms change, you’re asked to sign in again to accept the new ones\./,
  ]) assert.match(words, line);
  // The version the page shows is the one the trading wallet signs (C-D2), and the gateway's (C7):
  // were they to differ, the facade would refuse every trading-wallet sign-in.
  assert.equal(TERMS_VERSION, "2026-09-26");
  // The gateway's source is not in the published repository: there the pin above stands alone.
  if (existsSync(new URL("../../gateway/signin.ts", import.meta.url))) {
    const gateway = read("../../gateway/signin.ts").match(/export const TERMS_VERSION = "([^"]+)";/)?.[1];
    assert.equal(TERMS_VERSION, gateway, "the site's terms version is the gateway's");
  }
  assert.match(markup, new RegExp(`<p class="mo">Version ${TERMS_VERSION}</p>`));
  // Privacy: the cookie, the records, the prompts, the chain read, the IP, the chat; and the last line.
  for (const line of [
    /Signing in sets one cookie, on api\.clankuwu\.com only\. It holds a random token, can’t be read by any page’s scripts, and lasts 12 hours or until you sign out\./,
    /Never your prompts, the answers or the pictures\./,
    /Pictures: your prompt goes to the supplier and the model’s maker, as above\. The finished picture comes back through our server, is checked by the same classifier together with its prompt, and is passed straight to you\. We don’t keep it\. The supplier keeps its copy for about a day\./,
    /to the model’s supplier and on to the company that makes the model\. Each prompt is also checked by a content classifier run by OpenAI, through the same supplier\./,
    /reads that wallet’s transaction count and balance on Robinhood Chain, which are public anyway/,
    /no IP, no query string, no headers, so no key and no cookie/,
    /Your chat lives only in the page\. A reload or a closed tab loses it\./,
    /Cloudflare, Coinbase, Google, X, your browser wallet, and the AI model suppliers and makers, handle your data under their own privacy policies\./,
    // P1e (P-D5): the site goes through Cloudflare; cumAI's API does not.
    /Cloudflare: pages and the site’s data pass through Cloudflare on the way to you, which handles them under its own privacy policy\. It sees your IP address and which pages you open\. cumAI’s API, api\.clankuwu\.com ?, does not go through it\./,
  ]) assert.match(words, line);
  assert.ok(markup.indexOf("<h3>cumAI</h3>", markup.indexOf('id="about-privacy"')) < markup.indexOf("<h3>On the chain</h3>"), "before On the chain");
  assert.doesNotMatch(markup, /APIMart|No account with us/, "the supplier stays unnamed (C1), and an account now exists for a signed-in wallet");
});

test("the trust model follows whether this origin has a trading wallet", () => {
  const saved = S.login.here;
  try {
    S.login.here = true;
    const tw = textOf(aboutSection("trust"));
    assert.match(tw, /trading wallet for you from Coinbase/);
    assert.match(tw, /After 30 minutes with no activity/);
    assert.match(tw, /at most 12 transactions a minute/);
    S.login.here = false;
    const own = textOf(aboutSection("trust"));
    assert.match(own, /You trade from your own browser wallet/);
    assert.doesNotMatch(own, /trading wallet for you/);
  } finally {
    S.login.here = saved;
  }
});

test("renderAbout paints a hosted page and nothing on a self page", () => {
  dom.reset();
  renderAbout();
  assert.equal(dom.el("#aboutbody").markup, "", "self: nothing drawn");
  dom.reset();
  hosted(() => renderAbout("terms"));
  assert.match(dom.el("#aboutbody").markup, /id="about-terms"/);
});

// ------------------------------------------------------------- routing --

// U1 moved About under Learn (#/learn…); an #/about link still lands, and the
// address bar says where. A self page has no About: its Learn is the Flow.
test("#/about is a hosted page, now at #/learn; a self page has no such route and lands on the Flow", () => {
  dom.reset();
  globalThis.location.hash = "#/about";
  go("about", false);
  assert.equal(dom.el("#shell").dataset.page, "flow");
  assert.equal(globalThis.location.hash, "#/learn/how-it-works", "the link stops saying about");
  assert.equal(dom.el("#aboutbody").markup, "");

  dom.reset();
  globalThis.location.hash = "#/about/privacy";
  hosted(() => go("about/privacy", false));
  assert.equal(dom.el("#shell").dataset.page, "about");
  assert.equal(globalThis.location.hash, "#/learn/privacy");
  assert.match(dom.el("#aboutbody").markup, /id="about-privacy"/);
});

test("every hosted page has the footer links, to sections that exist", () => {
  const foot = APP_HTML.match(/<footer class="relfoot" data-hosted-only>[\s\S]*?<\/footer>/)?.[0];
  assert.ok(foot, "one hosted footer");
  // After every page's section, so it is under all of them.
  assert.ok(APP_HTML.indexOf(foot) > APP_HTML.lastIndexOf("</section>"));
  // Under Learn since U1 (#/learn, #/learn/terms); the router still takes #/about.
  const links = [...foot.matchAll(/<a href="#\/learn(?:\/([a-z]+))?">([^<]+)<\/a>/g)].map((m) => [m[1] ?? "", m[2]]);
  assert.deepEqual(links, [["", "About"], ["terms", "Terms"], ["privacy", "Privacy"]]);
  for (const [id] of links) if (id) assert.ok(isAboutSection(id), id);
  assert.match(foot, /<span class="mo" id="release">local<\/span>/, "the release slot is unchanged");
  assert.match(APP_HTML, /<section class="pg" id="pg-about" data-hosted-only>/);
});

// ------------------------------------------------------------ the beta --

test("the badge and the notice are hosted only, hidden in the markup, and the notice says the user's words", () => {
  assert.match(APP_HTML, /<span class="stage" id="stagebadge" data-hosted-only hidden><\/span>/, "its text comes from STAGE");
  const bar = APP_HTML.match(/<div class="sysoff betabar" id="betabar" role="note" data-hosted-only hidden>[\s\S]*?<\/div>/)?.[0];
  assert.ok(bar);
  assert.equal(textOf(bar), "Beta: new software, expect bugs. Keep only trading money in your trading wallet. About the beta Dismiss");
  // Straight to Learn since U6 (#/about/beta still lands there).
  assert.match(bar, /<a href="#\/learn\/beta">/);
  assert.ok(isAboutSection("beta"));
});

test("showBeta does nothing on a self page", () => {
  dom.reset();
  globalThis.localStorage = storage();
  dom.el("#stagebadge").hidden = true;
  dom.el("#betabar").hidden = true;
  showBeta();
  assert.equal(dom.el("#stagebadge").hidden, true);
  assert.equal(dom.el("#stagebadge").textContent, "");
  assert.equal(dom.el("#betabar").hidden, true);
});

test("a hosted page shows the badge and the notice, and remembers a dismissal", () => {
  dom.reset();
  const store = storage();
  globalThis.localStorage = store;
  hosted(() => showBeta());
  assert.equal(dom.el("#stagebadge").textContent, STAGE);
  assert.equal(dom.el("#stagebadge").hidden, false);
  assert.equal(dom.el("#betabar").hidden, false);
  assert.equal(typeof dom.el("#betaclose").onclick, "function");

  dom.el("#betaclose").onclick();
  assert.equal(dom.el("#betabar").hidden, true);
  assert.equal(store.map.get(BETA_DISMISSED), "1");

  // A later page load in the same browser.
  dom.reset();
  hosted(() => showBeta());
  assert.equal(dom.el("#betabar").hidden, true);
  assert.equal(dom.el("#stagebadge").hidden, false, "the badge stays");
});

test("with storage that throws, the notice shows, closes, and stays closed for the page load", async () => {
  // A fresh copy of the module, so no earlier dismissal carries over.
  const beta = await import(BETA_MODULE + "?blocked");
  dom.reset();
  globalThis.localStorage = storage({ throws: true });
  hosted(() => beta.showBeta());
  assert.equal(dom.el("#betabar").hidden, false);
  beta.dismissBeta();
  assert.equal(dom.el("#betabar").hidden, true);
  hosted(() => beta.showBeta());
  assert.equal(dom.el("#betabar").hidden, true, "a second showBeta (the config's) does not bring it back");

  // No localStorage at all reads the same way.
  const bare = await import(BETA_MODULE + "?absent");
  delete globalThis.localStorage;
  dom.reset();
  hosted(() => bare.showBeta());
  assert.equal(dom.el("#betabar").hidden, false);
  bare.dismissBeta();
  assert.equal(dom.el("#betabar").hidden, true);
});

test("dismissBeta with no notice on the page does not throw", () => {
  dom.reset();
  globalThis.localStorage = storage();
  assert.doesNotThrow(() => dismissBeta());
});

// ------------------------------------------------------------ the Flow --

/** The console's words the hosted Flow page must not use. */
const CONSOLE_WORDS = /\bmanager\b|\bbots?\b|\bsnipers?\b|dry[- ]run|EXIT_BEFORE|\bguard\b|\bstop\b/i;

test("the hosted Flow page names no manager and no bot", () => {
  const hostedFlow = textOf(without(flowSection, "data-self-only"));
  assert.doesNotMatch(hostedFlow, CONSOLE_WORDS);
  assert.match(hostedFlow, /Close to graduation/);

  dom.reset();
  hosted(() => renderFlow());
  for (const id of ["#fl-feenote", "#fl-gradnote", "#fl-caption", "#fl-thr", "#flh-thr2", "#flhp-thr2"]) {
    assert.doesNotMatch(dom.el(id).textContent, CONSOLE_WORDS, id);
  }
  assert.match(dom.el("#fl-feenote").textContent, /charged on the way in and again on the way out/);
});

test("the console's Flow page keeps its own words", () => {
  const selfFlow = textOf(without(flowSection, "data-hosted-only"));
  assert.match(selfFlow, /every exit the manager makes/);
  assert.match(selfFlow, /Where the manager takes you/);
  assert.match(selfFlow, /Why the guard, not graduation/);
  assert.doesNotMatch(selfFlow, /Close to graduation/);
  assert.doesNotMatch(selfFlow, /Both shape what a sell can get/, "the hosted intro is hosted only");

  dom.reset();
  renderFlow();
  assert.match(dom.el("#fl-feenote").textContent, /dry-run entry/);
});
