// The landing (L1 L2): the demo ported under the landing's policy. Its
// markup and stylesheet, and the pure parts of its script (landing/live.js):
// where an old link goes, how the gateway is asked, and what its answer shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLanding } from "../../../scripts/release-page.mjs";
import {
  BOARD_ROWS, FEATURED, GATEWAY, VIEWS, ago, boardRows, bonding, cap, dotColors, fetchBoard, fetchModels, fillCount,
  forwardTarget, maker, summarize, tokenHref, tokens, usd,
} from "../public/landing/live.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const html = readFileSync(`${PUBLIC}landing/index.html`, "utf8");
const css = readFileSync(`${PUBLIC}landing/landing.css`, "utf8");
const js = ["landing.js", "live.js"].map((f) => readFileSync(`${PUBLIC}landing/${f}`, "utf8")).join("\n");
const models = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/gateway-models.json", import.meta.url)), "utf8"));

// ------------------------------------------------------------ the markup --

test("nothing inline: no script, no style attribute, no style element", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handler");
});

test("it loads one module and one stylesheet, its own, and no wallet", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["/landing/landing.js"]);
  assert.deepEqual(sheets, ["/landing/landing.css"]);
  assert.doesNotMatch(html + js, /vendor\/|js\/wallet|wallet\.js/);
  const imports = [...js.matchAll(/\bfrom\s+"([^"]+)"|import\(\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(imports, ["./live.js"], "the module imports its own helpers, nothing else");
});

test("the release can render it: one release slot, and every asset it names is served", () => {
  const sha = "a".repeat(40);
  const { page, assets } = renderLanding(html, sha);
  assert.ok(page.includes(`id="release">${sha}<`));
  for (const a of assets) assert.ok(existsSync(`${PUBLIC}${a}`), a);
  assert.deepEqual([...new Set(assets)].sort(), ["apple-touch-icon.png", "favicon-32.png", "landing/landing.css", "landing/landing.js",
    "landing/cumos-clankchan.webp", "landing/cumos-clankchan.mp4", "landing/sky.webp"].sort());
});

test("its links go to the app's paths, its own sections, or out with noopener", () => {
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/g)].map((m) => [m[1], m[0]]);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [href, tag] of hrefs) {
    if (href.startsWith("#")) assert.ok(ids.has(href.slice(1)), `${href} names a section on the page`);
    else if (href.startsWith("/")) assert.match(href, /^\/(trade|ai)(#\/[a-z/]*)?$/, href);
    else {
      assert.match(href, /^https:\/\/(x\.com\/|t\.me\/clankuwu$)/, href);
      assert.match(tag, /rel="noopener noreferrer"/, href);
    }
  }
  // The terms the gateway's sign-in names (L1 N1) are one click away, at cumTrade's path (P2b).
  assert.ok(hrefs.some(([h]) => h === "/trade#/learn/terms"));
});

test("the new names only: cumAI, not cumAPI, and clankuwu.com, not cumtrade.com (N-D2, N-D1)", () => {
  for (const [name, text] of [["index.html", html], ["landing.css", css], ["the script", js]]) {
    assert.doesNotMatch(text, /cumAPI/, name);
    assert.doesNotMatch(text, /cumtrade/, name);
  }
  assert.match(html, /cumAI/);
  assert.match(html, /https:\/\/api\.clankuwu\.com\/v1/);
});

test("no number the page cannot read live: counts are templates over words, and prices start hidden", () => {
  const tpls = [...html.matchAll(/<(\w+)[^>]*\sdata-count-tpl="([^"]+)"[^>]*>([^<]*)</g)];
  assert.ok(tpls.length >= 2, "model counts retain readable fallbacks");
  for (const [, , tpl, fallback] of tpls) {
    assert.match(tpl, /\{[nm]\}/, tpl);
    assert.doesNotMatch(fallback, /\d/, `its words without the count: "${fallback}"`);
  }
  assert.doesNotMatch(html.replace(/data-count-tpl="[^"]*"/g, ""), /\b17[56]\b/, "no model count written into the page");
  assert.match(html, /<div id="prices" hidden>/);
  assert.doesNotMatch(html, /Free in the playground/, "the free tier is off (X19)");
});

test("companion privacy and agency are scoped to development", () => {
  assert.doesNotMatch(html, /Prompts are never stored|Nothing here can sign/);
  assert.match(html, /prototype saves conversation and memory/);
  assert.match(html, /require their own permissions and release checks/);
});

test("the stylesheet reaches only our own fonts, by relative URL", () => {
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0 && urls.every((u) => /^\.\.\/fonts\/[A-Za-z-]+\.woff2$/.test(u) && existsSync(`${PUBLIC}${u.slice(3)}`)), urls.join());
  assert.doesNotMatch(css, /@import|https?:/);
});

test("the landing's own files are only types a release serves, flat in landing/", () => {
  const files = readdirSync(`${PUBLIC}landing`);
  for (const f of files) assert.match(f, /^[a-z0-9_-]+\.(html|css|js|webp|png|mp4)$/, f);
  assert.ok(!files.includes("index.htm"));
});

// ------------------------------------------------------ old links (N-D7) --

test("an app route in the hash goes to the app; anything else stays", () => {
  assert.equal(forwardTarget("#/token/0x0000000000000000000000000000000000000001"), "/trade#/token/0x0000000000000000000000000000000000000001");
  assert.equal(forwardTarget("#/learn/terms?version=2026-09-23"), "/trade#/learn/terms?version=2026-09-23");
  assert.equal(forwardTarget("#/"), "/trade#/");
  assert.equal(forwardTarget("#/ai"), "/ai");
  assert.equal(forwardTarget("#/ai/models"), "/ai");
  assert.equal(forwardTarget("#/aim"), "/trade#/aim", "only the AI route itself");
  for (const h of ["", "#", "#roadmap", "#top", "#terminal", undefined, null]) assert.equal(forwardTarget(h), null, String(h));
});

// ------------------------------------------------------------ the count --

test("the gateway is asked with a CORS simple request: no credentials, no header of ours", async () => {
  const calls = [];
  const fake = (status, body) => async (url, init) => { calls.push([url, init]); return { status, json: async () => body }; };
  assert.deepEqual(await fetchModels(fake(200, models)), models);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.clankuwu.com/v1/models");
  assert.deepEqual(calls[0][1], { credentials: "omit" }, "no headers, no method, nothing that asks for a preflight");
  assert.equal(GATEWAY, "https://api.clankuwu.com");
});

test("a refusal, a failure or a non-JSON answer is null, never a throw", async () => {
  assert.equal(await fetchModels(async () => ({ status: 429, json: async () => ({}) })), null);
  assert.equal(await fetchModels(async () => ({ status: 404, json: async () => ({}) })), null);
  assert.equal(await fetchModels(async () => { throw new TypeError("Failed to fetch"); }), null);
  assert.equal(await fetchModels(async () => ({ status: 200, json: async () => { throw new SyntaxError("x"); } })), null);
});

test("the live list (captured 2026-09-24): its count, and the featured rows in order", () => {
  const live = summarize(models);
  assert.equal(live.count, models.data.length);
  assert.deepEqual(live.featured.map((f) => f.id), FEATURED);
  const sonnet = live.featured[0];
  assert.equal(sonnet.maker, "Anthropic");
  assert.equal(typeof sonnet.input, "number");
  assert.ok(live.featured.every((f) => f.context === null || Number.isSafeInteger(f.context)));
});

test("only well-formed entries count, and anything else is no count at all", () => {
  const ok = (id, extra = {}) => ({ id, pricing: { input_usd_per_million: 1, output_usd_per_million: 2 }, ...extra });
  const live = summarize({ object: "list", data: [ok("gpt-5"), ok("<img src=x onerror=alert(1)>"), ok("a b"),
    { id: "claude-x", pricing: { input_usd_per_million: "1", output_usd_per_million: 2 } }, { id: 5 }, null, ok("x".repeat(129))] });
  assert.equal(live.count, 1);
  assert.deepEqual(live.featured.map((f) => f.id), ["gpt-5"]);
  for (const body of [null, {}, { object: "list" }, { object: "list", data: [] }, { data: [ok("gpt-5")] }, "list"]) {
    assert.equal(summarize(body), null, JSON.stringify(body));
  }
});

test("the words the counts fill, and the demo's number formats", () => {
  assert.equal(fillCount("{n} models", 176), "176 models");
  assert.equal(fillCount("or {m} others", 176), "or 175 others");
  assert.equal(usd(2.85), "$2.85");
  assert.equal(usd(0.19), "$0.190");
  assert.equal(usd(0.05), "$0.0500");
  assert.equal(tokens(1_000_000), "1M");
  assert.equal(tokens(200_000), "200K");
  assert.equal(tokens(null), "—");
  assert.equal(maker("gpt-4.1-nano"), "OpenAI");
  assert.equal(maker("qwen3.8-max"), "Qwen");
  assert.equal(maker("unknown-model"), "Other");
});

// ------------------------------------------- L2b: the user's six changes --

const board = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/landing-board.json", import.meta.url)), "utf8"));
/** A section of the markup, from its opening tag to the next section's. */
const section = (id) => {
  const i = html.indexOf(`id="${id}"`);
  assert.ok(i > 0, id);
  const end = html.indexOf("<section", i);
  return html.slice(i, end > 0 ? end : undefined);
};
const textIn = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("1. the strip is the five the user kept: OpenRouter with no Soon tag, and no Vultr or Backblaze", () => {
  const strip = html.slice(html.indexOf('<ul class="logos">'), html.indexOf("</ul>", html.indexOf('<ul class="logos">')));
  const names = [...strip.matchAll(/aria-label="([^"]+)"|<span>([^<]+)<\/span><\/li>/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(names, ["Coinbase", "Robinhood Chain", "Alchemy", "Cloudflare", "OpenRouter"]);
  // No Soon tag in the strip itself (cumOS's card may be Soon: the user, 2026-09-27).
  assert.doesNotMatch(strip, /class="soon"|>Soon</);
  assert.doesNotMatch(html, /Vultr|Backblaze/);
  // On a phone the strip is an even two-column grid, and the hero's footer drops its separators.
  assert.match(css, /@media \(max-width:560px\)\{[^}]*\.builtwith[\s\S]*?\.logos\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.hero-foot \.sep\{display:none\}/);
});

test("2. the wordmark is clankchan's face, the app's own mark, in the nav and the footer", () => {
  const marks = [...html.matchAll(/<img class="brand-mark" src="([^"]+)" alt="" width="26" height="26">/g)].map((m) => m[1]);
  assert.deepEqual(marks, ["/apple-touch-icon.png", "/apple-touch-icon.png"]);
  assert.doesNotMatch(html, /<span class="brand-mark"/);
});

test("trading promotion is removed while existing-user access remains", () => {
  assert.doesNotMatch(html, /id="board"|id="terminal"|Open cumTrade|Launch cumTrade|Trading terminal/);
  assert.match(html, /href="\/trade">Existing cumTrade users/);
  const landingScript = readFileSync(`${PUBLIC}landing/landing.js`, "utf8");
  assert.doesNotMatch(landingScript, /fetchBoard|board-state|mini-rows|#particles/);
});

test("3. its script reads the site's own board, sets everything as text, and shows no creator's logo", () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write/);
  assert.doesNotMatch(js, /\/api\/logo|ipfs|\.logo\b/);
  assert.match(js, /fetchImpl\("\/api\/launches"\)/);
  assert.match(js, /fetchImpl\("\/api\/stats"\)/);
});

test("3. the board asks our own origin for two things, and a failure is null", async () => {
  const calls = [];
  const ok = (body) => ({ status: 200, json: async () => body });
  const got = await fetchBoard(async (url, init) => { calls.push([url, init]); return url === "/api/launches" ? ok(board.launches) : ok({ price: { ethUsd: 2667.4, stale: false } }); });
  assert.deepEqual(calls, [["/api/launches", undefined], ["/api/stats", undefined]]);
  assert.equal(got.ethUsd, 2667.4);
  assert.equal(got.launches.length, board.launches.length);
  assert.equal((await fetchBoard(async (url) => (url === "/api/launches" ? ok(board.launches) : ok({ price: { ethUsd: 2667, stale: true } })))).ethUsd, null, "a stale price is no price");
  assert.equal(await fetchBoard(async () => ({ status: 429, json: async () => [] })), null);
  assert.equal(await fetchBoard(async () => { throw new TypeError("Failed to fetch"); }), null);
  assert.equal(await fetchBoard(async () => ok({ not: "a list" })), null);
});

test("3. each view: New newest first, Bonding by progress and never graduated, Graduated by size", () => {
  const now = 1790240000;
  const fresh = boardRows(board.launches, board.ethUsd, "new", now);
  assert.equal(fresh.length, BOARD_ROWS);
  assert.ok(fresh.every((r, i) => i === 0 || fresh[i - 1].launchedAt >= r.launchedAt));
  const bond = boardRows(board.launches, board.ethUsd, "bonding", now);
  assert.ok(bond.length > 0 && bond.every((r, i) => !r.graduated && (i === 0 || bond[i - 1].progress >= r.progress)));
  const grad = boardRows(board.launches, board.ethUsd, "grad", now);
  assert.equal(grad.length, board.launches.filter((r) => r.graduated).length);
  assert.ok(grad.every((r, i) => r.graduated && (i === 0 || grad[i - 1].fdvEth >= r.fdvEth)));
  // A graduated token never shows under Bonding, however far along it reads.
  const done = { token: `0x${"b".repeat(40)}`, symbol: "DONE", name: "", launchedAt: now, fdvEth: 9, progress: 1, holders: 9, graduated: true, status: "ready" };
  assert.ok(!boardRows([...board.launches, done], board.ethUsd, "bonding", now).some((r) => r.token === done.token));
  assert.ok(boardRows([...board.launches, done], board.ethUsd, "grad", now).some((r) => r.token === done.token));
  const one = board.launches.find((r) => r.token === fresh[0].token);
  assert.equal(fresh[0].mcapUsd, one.fdvEth * board.ethUsd);
  assert.equal(boardRows(board.launches, null, "new", now)[0].mcapUsd, null, "no price, no market cap");
});

test("3. only well-formed rows show, and a creator's text is trimmed", () => {
  const good = { token: `0x${"a".repeat(40)}`, symbol: "  A  B  ", name: "x".repeat(80), launchedAt: 100, fdvEth: 1, progress: 1.7, holders: 3.4, graduated: false, status: "ready" };
  const rows = boardRows([good, { ...good, token: "0x123" }, { ...good, fdvEth: "1" }, null, { ...good, graduated: "no" },
    // Still being read, or failed: no name and no launch time yet (current-issues.md #6).
    { ...good, token: `0x${"c".repeat(40)}`, status: "analysing", name: "", launchedAt: 0 },
    { ...good, token: `0x${"d".repeat(40)}`, status: "error", name: "", launchedAt: 0 },
    { ...good, token: `0x${"e".repeat(40)}`, launchedAt: 0 },
    // Failed, whatever else it carries.
    { ...good, token: `0x${"f".repeat(40)}`, status: "error" }], 2000, "new", 160);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "A B");
  assert.equal(rows[0].name.length, 32);
  assert.equal(rows[0].progress, 1);
  assert.equal(rows[0].holders, 3);
  assert.equal(rows[0].age, 60);
  assert.deepEqual(boardRows("nope", 1, "new", 0), []);
});

test("3. the board's words and numbers", () => {
  assert.deepEqual([45, 420, 7200, 3 * 86_400].map(ago), ["45s", "7m", "2h", "3d"]);
  assert.deepEqual([950, 42_000, 1_250_000, null].map(cap), ["$950", "$42.0K", "$1.25M", "—"]);
  assert.equal(bonding({ graduated: false, progress: 0.426 }), "42%");
  assert.equal(bonding({ graduated: true, progress: 1 }), "Graduated");
  const a = `0x${"12ab".repeat(10)}`;
  assert.deepEqual(dotColors(a), dotColors(a), "the same dot every time");
  assert.equal(tokenHref(a), `/trade#/token/${a}`);
});

test("development stages are labeled and obsolete token economics are absent", () => {
  const road = section("roadmap");
  const words = textIn(road);
  for (const label of ["Working locally", "Being developed", "The longer view"]) assert.ok(words.includes(label));
  assert.doesNotMatch(html, /buys it and burns it|pays back your token|any clank.trade token|\bAPY\b|\bAPR\b/);
  const ecosystem = textIn(section("ecosystem"));
  assert.match(ecosystem, /xCUM — planned AI service credits/);
  assert.match(ecosystem, /xCUM is separate from \$CUM/);
});

test("no public creation flow or unsupported private-key import is offered", () => {
  assert.doesNotMatch(textIn(html), /Create now|Try cumOS|Join the waitlist|private key/i);
  assert.match(html, /Public companion access is not available yet/);
  assert.match(html, /href="\/trade#\/learn\/privacy"/);
});

test("cumOS leads the ecosystem direction; cumAI is the usable main action", () => {
  const hero = section("h-hero");
  assert.match(hero, /cumOS/);
  assert.match(hero, /clank.trade ecosystem/);
  assert.match(hero, /href="\/ai">Open cumAI/);
  assert.match(html, /id="cumos"/);
  assert.match(html, /cumOS in development/);
  assert.doesNotMatch(hero, /cumTrade/);
});

test("clankchan video is local, silent, labeled, and has a motion control and poster", () => {
  const video = html.match(/<video\b[^>]*>/)[0];
  assert.match(video, /muted loop playsinline preload="none"/);
  assert.match(video, /poster="\/landing\/cumos-clankchan.webp"/);
  assert.doesNotMatch(video, /autoplay/);
  assert.match(html, /src="\/landing\/cumos-clankchan.mp4" type="video\/mp4"/);
  assert.match(html, /Avatar animation preview/);
  assert.match(html, /aria-controls="cumos-video"/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /IntersectionObserver/);
});
