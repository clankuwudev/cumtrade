// The project docs (PD, docs/specs/pd-project-docs.md): one page at /docs
// that explains the project. Its markup, its stylesheet and its module, under
// the same rules as the landing, and the words the user approved: the facts
// from their sources, and the tokenomics spec's public rules (G2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLanding } from "../../../scripts/release-page.mjs";
import { COMMUNITY, CONTACT, PROJECT_TOKEN } from "../public/js/core/constants.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const html = readFileSync(`${PUBLIC}docs/index.html`, "utf8");
const css = readFileSync(`${PUBLIC}docs/docs.css`, "utf8");
const js = readFileSync(`${PUBLIC}docs/docs.js`, "utf8");
const landing = readFileSync(`${PUBLIC}landing/index.html`, "utf8");
/** What a reader reads: the body's text, tags and the script left out. */
const text = html.slice(html.indexOf("<body>")).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** One section's markup, by its id. */
const section = (id) => {
  const at = html.indexOf(`<section class="doc" id="${id}"`);
  assert.ok(at >= 0, `section #${id}`);
  return html.slice(at, html.indexOf("</section>", at));
};

// ------------------------------------------------------------ the markup --

test("nothing inline: no script, no style attribute, no style element, no handler", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test("it loads one module and one stylesheet, its own, and no wallet", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["/docs/docs.js"]);
  assert.deepEqual(sheets, ["/docs/docs.css"]);
  assert.doesNotMatch(html + js, /vendor\/|js\/wallet|wallet\.js/);
  const imports = [...js.matchAll(/\bfrom\s+"([^"]+)"|import\(\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(imports, ["../landing/live.js"], "the landing's count helpers, nothing else");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/, "everything is set as text");
});

test("the release can render it: one release slot, and every asset it names is served", () => {
  const sha = "b".repeat(40);
  const { page, assets } = renderLanding(html, sha, "docs/index.html");
  assert.ok(page.includes(`id="release">${sha}<`));
  for (const a of assets) assert.ok(existsSync(`${PUBLIC}${a}`), a);
  assert.deepEqual([...new Set(assets)].sort(), ["apple-touch-icon.png", "docs/docs.css", "docs/docs.js", "favicon-32.png"]);
});

test("the stylesheet reaches only our own fonts, by relative URL, and nothing outside", () => {
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length === 3 && urls.every((u) => /^\.\.\/fonts\/[A-Za-z-]+\.woff2$/.test(u)), urls.join(", "));
  assert.doesNotMatch(css, /https?:|@import|googleapis|gstatic/);
});

test("its links go to the site's pages, its own sections, or out with noopener", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const landingIds = new Set([...landing.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [tag, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    if (href.startsWith("#")) assert.ok(ids.has(href.slice(1)), `${href} names a section here`);
    else if (href.startsWith("/#")) assert.ok(landingIds.has(href.slice(2)), `${href} names a section of the homepage`);
    else if (href.startsWith("/")) assert.match(href, /^\/(|docs|ai(#\/(models|status|docs))?|trade(#\/learn\/(terms|privacy|api))?)$/, href);
    else {
      assert.match(href, /^https:\/\/(t\.me\/clankuwu|x\.com\/(clankuwumodel|0xzer0ai)|robinhoodchain\.blockscout\.com\/token\/0x[0-9a-f]{40}|clank\.trade\/token\/0x[0-9a-f]{40})$/, href);
      assert.match(tag, /target="_blank" rel="noopener noreferrer"/, href);
    }
  }
});

test("the nav is the homepage's, with Docs the page it is on", () => {
  const nav = html.match(/<nav class="nav-links"[^>]*>(.*?)<\/nav>/)[1];
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]),
    [["/#cumai", "cumAI"], ["/#cumos", "cumOS"], ["/#tokens", "Tokens"], ["/docs", "Docs"]]);
  assert.match(nav, /<a href="\/docs" aria-current="page">Docs<\/a>/);
});

test("the contents: every section once, in order, the same in the rail and the phone menu", () => {
  const order = ["overview", "cumai", "cumos", "agents", "cum", "xcum", "loop", "airdrops", "status", "faq", "safety"];
  assert.deepEqual([...html.matchAll(/<section class="doc" id="([a-z]+)"/g)].map((m) => m[1]), order);
  const rail = html.slice(html.indexOf('<aside class="toc"'), html.indexOf("</aside>"));
  const menu = html.slice(html.indexOf('<details class="toc-m"'), html.indexOf("</details>"));
  const anchors = (s) => [...s.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(anchors(rail), order);
  assert.deepEqual(anchors(menu), order);
});

// ------------------------------------------------------------- the words --

test("the facts, from their sources: free tier, contract, chain, supply, links", () => {
  assert.match(text, /GPT-4\.1 nano, up to 8,000 tokens in and 1,024 out per reply\./, "/v1/free, 2026-09-30");
  assert.match(section("cumai"), /<dt>Pictures<\/dt><dd>2 a day\.<\/dd>/);
  assert.ok(html.toLowerCase().includes(PROJECT_TOKEN.address.toLowerCase()), "the official $CUM contract");
  assert.match(text, /Robinhood Chain \(chain ID 4663\)/);
  assert.match(text, /1,000,000,000 at launch\. It only goes down, by burns\./);
  assert.ok(html.includes(`href="${COMMUNITY.href}"`) && html.includes(`href="${CONTACT.href}"`), "the site's own contact links");
  // The official X accounts (the user, 2026-09-30): the project's, and @0xzer0ai.
  assert.match(section("safety"), /<dt>X<\/dt><dd><a href="https:\/\/x\.com\/clankuwumodel"[^>]*>@clankuwumodel<\/a> and <a href="https:\/\/x\.com\/0xzer0ai"[^>]*>@0xzer0ai<\/a><\/dd>/);
  assert.match(html, /<span data-count-tpl="\{n\} models">Models<\/span> from OpenAI, Anthropic, Google/, "the count is live, over words");
});

test("the token rules the user decided, in the words the page uses", () => {
  // $CUM's use (D1) and the published minimum (O9).
  assert.match(text, /Wallets holding at least \$20 of \$CUM when a snapshot is taken/);
  // xCUM is the AI credit balance itself: each request burns what it spends.
  assert.match(section("xcum"), /xCUM is your AI credit balance, on-chain\./);
  assert.match(section("xcum"), /Each request spends xCUM at the model's price, and the xCUM it spends is burned\./);
  assert.match(text, /There is no xCUM token yet\./);
  // Other clank.trade tokens pay directly (D7a); $CUM does not (O17).
  assert.match(text, /skip xCUM and pay for AI directly with another token launched on clank\.trade/);
  assert.match(text, /\$CUM itself can't pay/);
  // cumOS: a subscription plus metered AI, no prices.
  assert.match(text, /a subscription that hosts your companion, plus the AI it uses/);
});

test("anything not live is labelled, and the agents are planned with their numbers left out", () => {
  for (const id of ["agents", "airdrops"]) assert.match(section(id), /<span class="chip plan">Planned<\/span>/, id);
  for (const id of ["cumos", "xcum"]) assert.match(section(id), /<span class="chip dev">In development<\/span>/, id);
  const agents = section("agents");
  assert.match(agents, /The shares aren't set yet\./);
  assert.match(agents, /It isn't set yet\./);
  assert.match(agents, /Nobody's private memories or chats are ever part of an agent someone else can use or buy\./);
});

test("public copy rules (tokenomics G2): no percentages, returns, dates or hype, and no old names", () => {
  assert.doesNotMatch(text, /\d\s?%/, "no percentages");
  assert.doesNotMatch(text, /\b(APR|APY|yield|passive income|guarantee[ds]?|moon|100x|to the moon)\b/i);
  assert.doesNotMatch(text, /\bearn(s|ed|ing)?\b/i, "no 'earn'");
  assert.ok(text.includes("Updated September 30, 2026"), "the page says when it was written");
  assert.doesNotMatch(text.replace("Updated September 30, 2026", ""),
    /\b(Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|20\d\d)\b/,
    "no dates beyond the page's own 'Updated' line");
  assert.doesNotMatch(text, /turned? (it |xCUM )?into|activat|added to your/i, "xCUM is the balance, not turned into one");
  assert.doesNotMatch(html, /clankchan/i);
  assert.doesNotMatch(text, /subject to change/i);
});
