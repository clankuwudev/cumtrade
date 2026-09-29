// cumAI's own page at /ai, as the demo's console (stage C, C5; C-D8, C-D9,
// C-D11; L1 L4b; X20 A10, A11): the model list, the Models tab's view, and
// what the page says. Only what is live is said to be; the Next and Roadmap
// panels stay hidden (C-D9); every id from the gateway is set as text;
// nothing is inline, since the page's policy allows none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLanding } from "../../../scripts/release-page.mjs";
import {
  GATEWAY, QUICK, TABS, fetchModels, hitIn, modelView, paletteModels, parseModels, scale, tabOf, thousandCalls,
} from "../public/ai/models.js";
import { FACES, HOST, PLAY, SUGGEST, XCUM_NOTE } from "../public/ai/words.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const page = readFileSync(`${PUBLIC}ai/index.html`, "utf8");
const css = readFileSync(`${PUBLIC}ai/ai.css`, "utf8");
const MODULES = readdirSync(`${PUBLIC}ai`).filter((f) => f.endsWith(".js"));
const js = MODULES.map((f) => readFileSync(`${PUBLIC}ai/${f}`, "utf8")).join("\n");
const APP = readFileSync(`${PUBLIC}app.html`, "utf8");
const live = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/gateway-models.json", import.meta.url)), "utf8"));
const words = (m) => m.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ------------------------------------------------------------- the list --

test("the model list is a CORS simple request to the gateway, and a failure is null", async () => {
  const calls = [];
  const got = await fetchModels(async (url, init) => { calls.push([url, init]); return { status: 200, json: async () => live }; });
  assert.deepEqual(calls, [["https://api.clankuwu.com/v1/models", { credentials: "omit" }]]);
  assert.equal(GATEWAY, "https://api.clankuwu.com");
  assert.equal(got.length, live.data.length);
  for (const bad of [async () => ({ status: 429, json: async () => ({}) }), async () => { throw new TypeError("x"); },
    async () => ({ status: 200, json: async () => ({ object: "list", data: [] }) })]) {
    assert.equal(await fetchModels(bad), null);
  }
});

test("each model: its maker, prices, and sizes only where published; a malformed id is dropped", () => {
  const rows = parseModels(live);
  const sonnet = rows.find((r) => r.id === "claude-sonnet-5");
  assert.equal(sonnet.maker, "Anthropic");
  assert.equal(typeof sonnet.in, "number");
  assert.ok(rows.every((r) => r.ctx === null || Number.isSafeInteger(r.ctx)));
  const one = (id) => ({ id, pricing: { input_usd_per_million: 1, output_usd_per_million: 2 }, context_length: null, max_output_tokens: -5 });
  const parsed = parseModels({ object: "list", data: [one("gpt-5"), one("<img src=x onerror=alert(1)>"), one("a b")] });
  assert.deepEqual(parsed.map((r) => r.id), ["gpt-5"]);
  assert.equal(parsed[0].max, null, "a size that is not a positive integer is not published");
  assert.equal(parseModels({ data: [] }), null);
});

test("the view: a quick filter, a maker and a search, sorted, with unpublished sizes last; bars on one scale", () => {
  const rows = parseModels(live);
  const byId = modelView(rows);
  assert.ok(byId.every((r, i) => i === 0 || byId[i - 1].id.localeCompare(r.id) <= 0));
  assert.ok(modelView(rows, { fam: "Anthropic" }).every((r) => r.maker === "Anthropic"));
  assert.ok(modelView(rows, { q: "SONNET" }).every((r) => r.id.includes("sonnet")), "search ignores case");
  assert.ok(modelView(rows, { quick: "Cheapest" }).every((r) => r.in + r.out <= 1));
  const byCtx = modelView(rows, { sortKey: "ctx", sortDir: -1 });
  const firstNull = byCtx.findIndex((r) => r.ctx === null);
  assert.ok(firstNull === -1 || byCtx.slice(firstNull).every((r) => r.ctx === null), "no context length sorts last either way");
  assert.deepEqual(Object.keys(QUICK), ["All", "Popular", "Cheapest", "Long context", "Reasoning", "Code"]);
  assert.equal(thousandCalls({ in: 2, out: 10 }), 7, "1,000 × (1,000 in at $2/M + 500 out at $10/M)");
  const { pct } = scale(rows);
  assert.match(pct(rows[0].in), /^\d+%$/);
});

test("the palette's models: matched on id or maker, never a group's name; live first, down last; the match marked", () => {
  const rows = [
    { id: "gpt-5", maker: "OpenAI" }, { id: "gpt-4.1-nano", maker: "OpenAI" }, { id: "claude-sonnet-5", maker: "Anthropic" },
    { id: "deepseek-v4-pro", maker: "DeepSeek" }, { id: "gemini-3-pro-preview", maker: "Google" },
  ];
  const states = { "gpt-5": "down", "gpt-4.1-nano": "live", "claude-sonnet-5": "degraded", "gemini-3-pro-preview": "live" };
  const stateOf = (id) => states[id] ?? null;
  assert.deepEqual(paletteModels(rows, stateOf, "model"), [], "\"model\" is the group's name, not a model's: nothing");
  assert.deepEqual(paletteModels(rows, stateOf, "GPT").map((m) => [m.row.id, m.state, m.hit]),
    [["gpt-4.1-nano", "live", [0, 3]], ["gpt-5", "down", [0, 3]]], "any case; live before down");
  assert.deepEqual(paletteModels(rows, stateOf, "openai").map((m) => [m.row.id, m.hit]), [["gpt-4.1-nano", null], ["gpt-5", null]],
    "by maker too, with nothing to mark in the id");
  assert.deepEqual(paletteModels(rows, stateOf).map((m) => m.state), ["live", "live", "degraded", "unknown", "down"],
    "no query: every model, live first, the unmeasured as unknown, down last");
  assert.equal(paletteModels(rows, stateOf, "", 2).length, 2);
  assert.deepEqual(paletteModels(rows, stateOf, "pro").map((m) => m.row.id), ["gemini-3-pro-preview", "deepseek-v4-pro"]);
  assert.deepEqual(hitIn("claude-sonnet-5", "SONNET"), [7, 13]);
  assert.equal(hitIn("x", ""), null);
});

test("its tabs are its own hash: the Build group, #/playground first; the old #/models and #/docs still land", () => {
  assert.deepEqual(TABS, ["playground", "models", "docs", "status"]);
  for (const [h, want] of [["", "playground"], ["#/", "playground"], ["#/playground", "playground"], ["#/models", "models"], ["#/docs", "docs"], ["#/status", "status"],
    ["#/docs?x=1", "docs"], ["#/xcum", "playground"], ["#/account", "playground"], ["#/lock", "playground"]]) {
    assert.equal(tabOf(h), want, h);
  }
});

// ------------------------------------------------------------ the page --

test("a page of its own: its module and stylesheets, no cumOS chrome, nothing inline", () => {
  assert.deepEqual([...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]), ["/ai/ai.js"]);
  assert.deepEqual([...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ["/landing/landing.css", "/ai/ai.css"]);
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>|\sstyle=|<style|\son[a-z]+=/i);
  assert.doesNotMatch(page, /vendor\/|wallet\.js|id="shell"|class="tnav"|id="tabbar"/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write/);
  assert.doesNotMatch(js, /style="/, "a template writes no inline style: the policy allows none");
  assert.match(js, /style\.setProperty\("--w"/, "the bars' widths go through CSSOM");
  assert.doesNotMatch(css, /@import|https?:|url\(/);
  for (const f of readdirSync(`${PUBLIC}ai`)) assert.match(f, /^[a-z0-9_-]+\.(html|css|js)$/, f);
});

test("what the page's modules import: each other, the site's dom and landing helpers, and the wallet only through embedded.js", () => {
  const imports = new Set(MODULES.flatMap((f) => [...readFileSync(`${PUBLIC}ai/${f}`, "utf8").matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1])));
  const allowed = new Set(["../js/core/dom.js", "../landing/live.js", "../js/core/constants.js", "../js/wallet/embedded.js", "../js/wallet/sessionCore.js",
    ...MODULES.map((f) => `./${f}`)]);
  for (const spec of imports) assert.ok(allowed.has(spec), spec);
});

test("the release can render it, and serves every asset it names; every face she shows is in the release", () => {
  const sha = "b".repeat(40);
  const { page: out, assets } = renderLanding(page, sha, "ai/index.html");
  assert.ok(out.includes(`id="release">${sha}<`));
  for (const a of assets) assert.ok(existsSync(`${PUBLIC}${a}`), a);
  assert.deepEqual([...new Set(assets)].sort(), ["ai/ai.css", "ai/ai.js", "apple-touch-icon.png", "art/e10-sleepy.webp",
    "favicon-32.png", "landing/landing.css"].sort());
  // ai.js loads the others beside itself (../art/), as /v/<sha>/art/ in a release.
  for (const [file] of Object.values(FACES)) assert.ok(existsSync(`${PUBLIC}art/${file}.webp`), file);
  assert.match(js, /new URL\(`\.\.\/art\/\$\{FACES\[f\]\[0\]\}\.webp`, import\.meta\.url\)/);
});

test("its links go home, to cumTrade and its terms and data API, or to its own tabs", () => {
  for (const [tag, href] of page.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    assert.match(href, /^(\/|\/trade|\/trade#\/learn\/(api|terms)|#\/(playground|models|docs|status)|https:\/\/t\.me\/clankuwu)$/, href);
    // The community's Telegram group opens with no opener and no referrer.
    if (href.startsWith("https:")) assert.match(tag, /target="_blank" rel="noopener noreferrer"/, href);
  }
  assert.match(page, /<a class="cai-chip link" href="\/"/, "a link back to the landing (C-D8)");
  // Our logo in the top bar, as on the landing (the user: "use our logo"), beside "cumAI by cumLabs".
  assert.match(page, /<a class="cai-brand"[^>]*><img class="cai-mark" src="\/apple-touch-icon\.png" alt="" width="24" height="24"><b class="nm">cumAI<\/b><small>by <span class="nm">cumLabs<\/span><\/small><\/a>/);
  assert.doesNotMatch(page, /▚/);
});

test("the Build group only: Playground, Models, Docs, Status. The Next and Roadmap panels stay hidden (C-D9)", () => {
  const tabs = [...page.matchAll(/<a href="([^"]+)" data-ai-tab="([a-z]+)"><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tabs, [["#/playground", "playground", "Playground"], ["#/models", "models", "Models"], ["#/docs", "docs", "Docs"], ["#/status", "status", "Status"]]);
  assert.equal([...page.matchAll(/data-ai-panel="([a-z]+)"/g)].map((m) => m[1]).join(), "playground,models,status,docs");
  assert.doesNotMatch(page, /Keys &amp; balance|Reserves|Power a token|Lock &amp; earn|OpenRouter|Supplier 1|data-ai-tab="(account|reserves|tokens|xcum|lock)"/);
  assert.doesNotMatch(page + js, /Example data|example data|demo-state/, "no example data and no demo switches (C-D10)");
});

test("only the gateway and the playground's state are said to be live; nothing unbuilt is on the page (the user: \"go trim.\")", () => {
  const status = page.match(/<div class="cai-side-status"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(status, /gateway<b id="st-gateway">…<\/b>/, "the gateway's line is read, not written in");
  assert.match(status, /playground<b id="st-play">…<\/b>/);
  assert.match(status, /paid keys<b>next<\/b>/);
  assert.doesNotMatch(page, /xCUM<b>roadmap|cai-chip lav|tokenized inference|Index endpoints|ai-rtag">Roadmap/i, "no xCUM chip, no roadmap rows, no unbuilt endpoints");
  assert.doesNotMatch(js, /xcumBlock|xnote\(/, "the xCUM note isn't repeated in the inspector or the playground");
  // The impostor warning stays, once, in the Models panel.
  assert.equal(XCUM_NOTE, "There is no xCUM token yet. When there is, its one real address will be posted on this page. Any token called xCUM today is not ours.");
  assert.equal((words(page).match(/There is no xCUM token yet\. When there is, its one real address will be posted on this page\. Any token called xCUM today is not ours\./g) ?? []).length, 1);
  assert.match(page, /Authentication <span class="ai-pill-next">Keys arrive with deposits<\/span>/);
});

test("the new names and host: cumAI, api.clankuwu.com, owned_by cumlabs; no model count written in", () => {
  assert.doesNotMatch(page + js, /cumAPI|cumtrade/);
  const bases = [...page.matchAll(/https:\/\/api\.[a-z]+\.com\/v1/g)].map((m) => m[0]);
  assert.ok(bases.length >= 4 && bases.every((b) => b === "https://api.clankuwu.com/v1"), bases.join());
  assert.match(page, /"owned_by"<\/span>: <span class="s">"cumlabs"/);
  assert.doesNotMatch(words(page.replace(/data-ai-count="[^"]*"/g, "")), /\b17[56]\b/, "the count is read live");
  for (const [, tpl, fallback] of page.matchAll(/data-ai-count="([^"]+)">([^<]+)</g)) {
    assert.match(tpl, /\{n\}/);
    assert.doesNotMatch(fallback, /\d/);
  }
});

test("Docs say what the gateway does (TI Build's check of src/gateway at 9d69d2c, 2026-09-24)", () => {
  const w = words(page);
  for (const code of ["bad_request", "content_blocked", "looks_like_recovery_phrase", "upstream_rejected", "missing_key", "malformed_key",
    "unknown_key", "key_revoked", "insufficient_balance", "refused", "unknown_model", "unpriced_model", "model_not_capped", "body_too_large",
    "key_cooling_down", "rate_limited", "upstream_rate_limited", "upstream_error", "model_unavailable", "upstream_unavailable",
    "price_book_stale", "moderation_unavailable", "upstream_timeout"]) assert.match(page, new RegExp(`<code>${code}</code>`), code);
  assert.match(w, /retry-after On a 429: seconds to wait before trying again\./);
  assert.doesNotMatch(w, /On a 429 or 503/);
  assert.match(w, /x-cum-balance-usd On keyed calls: your balance after this call\./);
  assert.doesNotMatch(w, /Model list 120/);
  assert.match(w, /120 a minute per client address, in bursts of up to 30, across every route/);
  assert.match(w, /At most 4 at once per key/);
  assert.match(w, /up to 8,000 tokens in and 1,024 out/);
  assert.match(w, /"output_cap": "honoured" , your cap holds/);
  assert.match(w, /"held_at_model_limit" , the model's own limit holds whatever you ask/);
  assert.match(page, /<span class="s">"output_cap"<\/span>: <span class="s">"honoured"<\/span>/);
});

// -------------------------------------------------------------- the host --

test("clankchan hosts: every line is fixed words about the page, never a model's answer (C-D5)", () => {
  for (const [name, make] of Object.entries(HOST)) {
    const [f, line] = make("gpt-4.1-nano", "$0.00002");
    assert.ok(FACES[f], `${name}: a face she has`);
    assert.match(line, /^[A-Z0-9$a-z].*[.]$/, name);
  }
  // The page calls her only by a line's name, with the model's id, a cost, a count or what is left: never a reply's text.
  const ARGS = new Set(["model()", "dollars(r.cost ?? NaN)", "dollars(S.free?.left_usd)", "rows.length", "S.rows.length", "r.id", "usd(r.out)", 'kind === "own"',
    "c.down", "c.degraded", "picsLeft() ?? perDay()", "p.model"]);
  /** Each call's arguments, split at the commas outside any brackets. */
  const argsOf = (src, fn) => [...src.matchAll(new RegExp(`\\b${fn}\\(`, "g"))].map((m) => {
    const args = [];
    let depth = 1, from = m.index + m[0].length, i = from;
    for (; i < src.length && depth; i++) {
      if ("([{".includes(src[i])) depth++;
      else if (")]}".includes(src[i])) depth--;
      if ((src[i] === "," && depth === 1) || depth === 0) { args.push(src.slice(from, i).trim()); from = i + 1; }
    }
    return args;
  });
  const calls = argsOf(js, "host").filter(([name]) => name !== "name");
  assert.ok(calls.length >= 18, String(calls.length));
  for (const [name, ...rest] of calls) {
    assert.match(name, /^"[a-zA-Z]+"$/, name);
    assert.ok(Object.hasOwn(HOST, name.slice(1, -1)), name);
    for (const arg of rest) assert.ok(ARGS.has(arg), `${name}: ${arg}`);
  }
});

test("the playground's own words: the warning above the box, the label under it, starting points that ask no advice", () => {
  assert.equal(PLAY.warn.join(" "), "Never paste a recovery phrase or private key into a chat, or into any site you don't fully trust. Whoever has it has the wallet.");
  assert.equal(PLAY.under, "Not financial advice, and not cumLabs support. It knows nothing live about prices. Answers can be wrong. Chats are not saved.");
  assert.equal(PLAY.outTitle, "Sign in to chat free.");
  assert.equal(PLAY.offTitle, "The playground opens soon.");
  assert.doesNotMatch(SUGGEST.join(" "), /buy|sell|price of|launch|pump|invest/i);
});

test("the playground checks before it sends, logs in only through cumOS's session, and sets replies as text", () => {
  const pg = readFileSync(`${PUBLIC}ai/playground.js`, "utf8");
  const send = pg.slice(pg.indexOf("async function send("), pg.indexOf("function newChat("));
  const call = send.indexOf("gateway.chat(");
  assert.ok(call > 0);
  assert.ok(send.indexOf("looksLikePhrase(text)") > 0 && send.indexOf("looksLikePhrase(text)") < call, "a recovery phrase is stopped first (F12)");
  assert.ok(send.indexOf("trimHistory(next)") > 0 && send.indexOf("trimHistory(next)") < call, "the history is trimmed first (A8)");
  assert.match(send, /gateway\.chat\(fit\.messages,/, "what is sent is the trimmed history");
  // C5c: the trading wallet is the session's, and its login is the session's, as on cumOS.
  const sync = pg.slice(pg.indexOf("async function syncTrading("), pg.indexOf("async function tradingOut("));
  assert.match(sync, /login\.session\.facade\(\)/, "the trading wallet comes from the session");
  assert.match(pg, /login\.session\.login\(method,/);
  assert.match(pg, /login\.session\.logout\(\)/, "signing out of cumAI with the trading wallet logs it out, as cumOS's Log out");
  assert.doesNotMatch(js, /startLogin|completeLogin|loginWithWallet/, "no module here calls the facade's login: the session does");
  const login = readFileSync(`${PUBLIC}ai/login.js`, "utf8");
  assert.match(login, /start: \(\) => startHere\(\)/, "the session starts the wallet with no chain");
  assert.match(login, /acknowledge: acknowledgeHere\(\)/, "the first login is acknowledged here as on cumOS");
  // After Google or X: carry on only on their return to a login this tab began.
  assert.match(pg, /return !!\(p\.get\("code"\) && p\.get\("flow_id"\)\);/);
  assert.match(pg, /function returned\(\) \{\s*if \(!cameBack\) return false;/);
  // A logout of the trading wallet, here or in any tab, ends a cumAI sign-in made with it.
  const out = pg.slice(pg.indexOf("async function tradingOut("), pg.indexOf("let seenSession"));
  assert.match(out, /same\(S\.account\.address, S\.lastTrading\)[\s\S]*gateway\.signOut\(\)/);
  // The composer (polished at the user's "also polish this"): the warning above the box, the label under it (A8, C-D4).
  assert.match(pg, /<p class="cai-warn" role="note">[\s\S]*?<div class="cai-box">[\s\S]*?<button class="cai-send" type="submit" id="pg-send" disabled>Send<\/button>[\s\S]*?<p class="cai-under" id="pg-under">\$\{PLAY\.under\}<\/p>/);
  // The thread (polished at the user's "polish this also"): one quiet line under a reply, Copy on each, Retry on the newest only.
  const meta = pg.slice(pg.indexOf("function meta("), pg.indexOf("function setBusy("));
  assert.match(meta, /\.join\(" · "\)/, "tokens, cost and time on one line");
  assert.match(meta, /for \(const b of \$\$\("\[data-pg=retry-reply\]", root\)\) if \(!el\.contains\(b\)\) b\.remove\(\);/, "Retry on the newest reply only");
  assert.doesNotMatch(pg, /\btok"|class="\$\{amber/, "no chips, and no cost drawn as a warning");
  const reply = pg.slice(pg.indexOf("function paintReply("), pg.indexOf("function meta("));
  assert.match(reply, /n\.textContent = p\.text;/, "a reply is text (A8)");
});

test("the app keeps none of it: cumAI is linked, as another page", () => {
  assert.doesNotMatch(APP, /id="pg-ai"|class="aipage"|data-ai-tab/);
  assert.match(APP, /<a href="\/ai" data-nav="ai" data-hosted-only>cumAI<\/a>/);
});
