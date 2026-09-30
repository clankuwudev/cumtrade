// cumAI's Picture mode (X15c, from docs/specs/x15-pictures.md): the gateway
// client's picture call against a stub gateway, the bytes it will draw, the
// words for each refusal, when the mode is offered, and the Models tab's
// prices. The drawing is checked in the browser (the spec's X15c notes).
// Nothing here reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PICTURE_MAX_SIDE, PICTURE_PROMPT_CHARS, PICTURE_SIZES, PICTURE_TIMEOUT_MS, createGateway, pictureType, pngSize,
} from "../public/ai/gateway.js";
import { ACTIONS, PICTURE, PICTURE_CODES, SUGGEST_PICTURES, refusal } from "../public/ai/words.js";
import { parsePictureModels } from "../public/ai/models.js";
import { picturesLeft, picturesOffered, picturesPerDay } from "../public/ai/state.js";

const BASE = "https://api.clankuwu.com";
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
/** A PNG's signature and header (IHDR) for a picture `w` by `h`: all the page reads of it. */
const png = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
};
const PNG = png(1536, 1024);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 1, 2, 3, 4, ...new TextEncoder().encode("WEBPVP8 ")]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/** A stub gateway that answers one route, and records what the page sent. */
function stub(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (url !== `${BASE}/v1/images/generations`) throw new TypeError("Failed to fetch");
    return typeof answer === "function" ? answer(init) : answer;
  };
  return { fetch, calls };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const made = (bytes, headers = {}) => json(200, { created: 1790000000, data: [{ b64_json: b64(bytes) }], usage: { cost_usd: 0.0092 } }, headers);

// ---------------------------------------------------------- the call --

test("a picture: one POST of { prompt, size } with the session cookie, nothing else", async () => {
  const s = stub(made(PNG, { "x-cum-free-pictures-left": "1", "x-cum-request-id": "req_1" }));
  const r = await createGateway({ fetch: s.fetch }).picture({ prompt: "a cat", size: "16:9" });
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.url, `${BASE}/v1/images/generations`);
  assert.equal(c.method, "POST");
  assert.equal(c.credentials, "include");
  assert.deepEqual(c.body, { prompt: "a cat", size: "16:9" }, "no model, no quality: the free allowance takes one of each");
  assert.deepEqual(c.headers, { "content-type": "application/json" });
  assert.deepEqual([...r.bytes], [...PNG]);
  assert.equal(r.type, "image/png");
  assert.equal(r.cost, 0.0092);
  assert.equal(r.left, 1);
  assert.equal(r.created, 1790000000);
  assert.equal(r.requestId, "req_1");
});

test("the picture's bytes must be an image by their first bytes; anything else is unreachable", async () => {
  assert.equal(pictureType(PNG), "image/png");
  assert.equal(pictureType(JPEG), "image/jpeg");
  assert.equal(pictureType(WEBP), "image/webp");
  for (const bad of [new Uint8Array(0), new TextEncoder().encode("<svg onload=alert(1)>"), new TextEncoder().encode("<html>"), PNG.subarray(0, 7)]) {
    assert.equal(pictureType(bad), null);
  }
  for (const body of [
    { data: [{ b64_json: b64(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")) }] },
    { data: [{ b64_json: "not base64!" }] },
    // A PNG too large to decode safely, one with no size, and one cut short of its header.
    { data: [{ b64_json: b64(png(PICTURE_MAX_SIDE + 1, 512)) }] },
    { data: [{ b64_json: b64(png(512, 60_000)) }] },
    { data: [{ b64_json: b64(png(0, 512)) }] },
    { data: [{ b64_json: b64(PNG.subarray(0, 20)) }] },
    { data: [{ url: "https://supplier.example/pic.png" }] },
    { data: [] },
    {},
  ]) {
    const s = stub(json(200, body));
    await assert.rejects(createGateway({ fetch: s.fetch }).picture({ prompt: "x", size: "1:1" }), (e) => e.code === "network", JSON.stringify(body));
  }
});

test("a picture's refusal carries the pictures left, from its header, when it is a count", async () => {
  const s = stub(json(502, { error: { message: "the provider could not make this picture. It counts toward today's free pictures. (request req_2)", type: "x", code: "picture_failed" } },
    { "x-cum-free-pictures-left": "0", "x-cum-request-id": "req_2" }));
  await assert.rejects(createGateway({ fetch: s.fetch }).picture({ prompt: "x", size: "1:1" }),
    (e) => e.code === "picture_failed" && e.extra.pictures_left === 0 && /counts toward today's free pictures/.test(e.message));
  for (const bad of ["-1", "1.5", "lots", "99999", ""]) {
    const b = stub(json(502, { error: { code: "picture_failed", message: "m" } }, { "x-cum-free-pictures-left": bad }));
    await assert.rejects(createGateway({ fetch: b.fetch }).picture({ prompt: "x", size: "1:1" }), (e) => e.extra.pictures_left === undefined, bad);
  }
});

test("a failure that counted shows so, and never offers a Try again that can only be refused", () => {
  const pg = readFileSync(`${PUBLIC}ai/playground.js`, "utf8");
  const make = pg.slice(pg.indexOf("async function makePicture("), pg.indexOf("// ---------------------------------------------------------- sign-in --"));
  assert.match(make, /if \(before !== null && after < before\) refused\.extra\.counted = true;/, "a fall in the count means it counted");
  assert.match(make, /said\.action === ACTIONS\.RETRY_PICTURE && picsLeft\(\) === 0 \? \{ \.\.\.said, action: null \} : said/);
  assert.match(pg, /r\.action === ACTIONS\.RETRY_PICTURE \? "Try again \(uses a picture\)"/, "the button says what it costs");
});

test("a refusal carries the gateway's code and fields; the cost and left fall back to the headers", async () => {
  const s = stub(json(429, { error: { message: "today's 2 free pictures are used; more at 00:00 UTC", type: "x", code: "free_allowance_used" } }, { "retry-after": "60" }));
  await assert.rejects(createGateway({ fetch: s.fetch }).picture({ prompt: "x", size: "1:1" }),
    (e) => e.code === "free_allowance_used" && e.status === 429 && e.extra.retry_after_seconds === 60);
  const h = stub(json(200, { data: [{ b64_json: b64(JPEG) }] }, { "x-cum-cost-usd": "0.0085", "x-cum-free-pictures-left": "nope" }));
  const r = await createGateway({ fetch: h.fetch }).picture({ prompt: "x", size: "1:1" });
  assert.equal(r.cost, 0.0085);
  assert.equal(r.left, null, "a left count that isn't a whole number is not shown");
  assert.equal(r.type, "image/jpeg");
});

test("a picture waits past the 15 s of other calls, up to the page's own 3 minutes", async () => {
  assert.equal(PICTURE_TIMEOUT_MS, 180_000);
  let signal;
  const s = stub((init) => { signal = init.signal; return made(PNG); });
  await createGateway({ fetch: s.fetch, timeoutMs: 1 }).picture({ prompt: "x", size: "1:1" });
  await new Promise((res) => setTimeout(res, 5));
  assert.ok(signal && !signal.aborted, "not the short call timeout");
  const gw = readFileSync(`${PUBLIC}ai/gateway.js`, "utf8");
  assert.match(gw, /new GatewayRefusal\("upstream_timeout", "the picture was not ready in time"\)/, "past the page's limit it reads as the gateway's timeout");
});

test("the shapes and the prompt limit are the gateway's", () => {
  assert.deepEqual(PICTURE_SIZES, ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"]);
  assert.equal(PICTURE_PROMPT_CHARS, 4_000);
  // The gateway's source is not in the published repository: there the pins above stand alone.
  const source = fileURLToPath(new URL("../../gateway/pictures.ts", import.meta.url));
  if (!existsSync(source)) return;
  const gw = readFileSync(source, "utf8");
  assert.match(gw, /const RATIOS = new Set\(\["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"\]\);/);
  assert.match(gw, /export const PROMPT_MAX_CHARS = 4_000;/);
});

// ---------------------------------------------------------------- words --

test("Picture mode's refusals: one sentence each, with Try again only where trying again can help", () => {
  const say = (code, extra = {}) => refusal({ code, extra }, { picture: true, perDay: 2 });
  assert.deepEqual(say("free_allowance_used"), { say: "Today's 2 free pictures are used. More at 00:00 UTC.", action: null, when: null });
  assert.deepEqual(say("picture_withheld"), { say: "The picture was withheld by the content check. It still counts toward today's pictures.", action: null, when: null });
  const FAILURES = ["picture_failed", "upstream_timeout", "upstream_error", "upstream_unavailable", "model_unavailable", "moderation_unavailable", "free_tier_unavailable", "something_new"];
  for (const code of FAILURES) {
    assert.deepEqual(say(code), { say: "The picture couldn't be made this time.", action: ACTIONS.RETRY, when: null }, code);
  }
  // The X15 red team: a free failure counts toward the day's pictures, so failures can't be farmed.
  // The gateway's sentence says so, or the page saw the pictures left fall; then Try again says what it costs.
  const COUNTED = { say: "The picture couldn't be made. It still counts toward today's pictures.", action: ACTIONS.RETRY_PICTURE, when: null };
  for (const code of FAILURES) {
    assert.deepEqual(refusal({ code, message: "the provider could not make this picture. It counts toward today's free pictures. (request req_1)" }, { picture: true }), COUNTED, code);
    assert.deepEqual(say(code, { counted: true }), COUNTED, `${code}, seen by the count`);
  }
  assert.deepEqual(say("network"), { say: "The answer didn't arrive, so the picture may still count toward today's pictures.", action: ACTIONS.RETRY_PICTURE, when: null });
  assert.deepEqual(say("pictures_failing", { retry_after_seconds: 1500 }),
    { say: "Several pictures failed within the hour, so pictures are paused. Try again in about 25 minutes.", action: null, when: null });
  assert.equal(say("pictures_failing", { retry_after_seconds: 50 }).say, "Several pictures failed within the hour, so pictures are paused. Try again in about 1 minute.");
  assert.equal(say("pictures_failing").say, "Several pictures failed within the hour, so pictures are paused. Try again later.");
  assert.deepEqual(say("pictures_busy"), { say: "Pictures are busy right now, and nothing was counted. Try again in a minute.", action: ACTIONS.RETRY, when: null });
  assert.equal(say("rate_limited").say, "A free call is already running. Wait for it to finish.");
  assert.equal(say("free_pictures_off").say, "Free pictures are paused.");
  // Chat's words where a code means the same for a picture.
  assert.deepEqual(say("not_signed_in"), refusal({ code: "not_signed_in" }));
  assert.deepEqual(say("free_tier_preview"), refusal({ code: "free_tier_preview" }));
  assert.equal(refusal({ code: "content_blocked", message: "The prompt was refused by the content policy." }, { picture: true }).say,
    "The prompt was refused by the content policy.", "the gateway's own words, as in chat");
  // And chat keeps its own.
  assert.equal(refusal({ code: "free_allowance_used" }).say, "Today's free use is spent, or this conversation is too long for what is left.");
  assert.ok(PICTURE_CODES.includes("picture_withheld"));
  for (const code of PICTURE_CODES) {
    const r = say(code);
    assert.match(r.say, /^[A-Z].*\.$/, code);
    assert.doesNotMatch(r.say, /APIMart|_/, `${code}: no supplier and no raw code`);
  }
});

test("Picture mode's words: the label under the box, the count, and starting points with no real people or tokens", () => {
  assert.equal(PICTURE.label, "Pictures are made by a model and can be wrong or odd. Checked before you see them. Not kept.");
  assert.equal(PICTURE.left(1, 2), "1 of 2 pictures left today · resets 00:00 UTC");
  assert.equal(PICTURE.progress, "Making your picture… usually under a minute");
  assert.equal(PICTURE.tooLong(4321, 4000), "This prompt is 4,321 characters, and a picture takes 4,000. Shorten it.");
  assert.doesNotMatch(SUGGEST_PICTURES.join(" "), /token|coin|logo|\$|elon|trump|musk|portrait of/i);
});

// ------------------------------------------------------------- offered --

test("the mode is offered only when /v1/free names pictures, on, with a model", () => {
  assert.equal(picturesOffered(null), null);
  assert.equal(picturesOffered({ on: true, model: "gpt-4.1-nano" }), null, "no pictures: chat only, as before X15c");
  assert.equal(picturesOffered({ pictures: { on: false, model: "gpt-image-2" } }), null, "off for this visitor (a preview)");
  assert.equal(picturesOffered({ pictures: { on: true, model: "" } }), null);
  const p = { on: true, model: "gpt-image-2", tier: "1K", per_day: 2, left_today: 1, open: true };
  assert.equal(picturesOffered({ pictures: p }), p);
});

test("a PNG's size is read from its header; the page draws none wider or taller than 8,192", () => {
  assert.deepEqual(pngSize(png(1536, 1024)), { width: 1536, height: 1024 });
  assert.equal(pngSize(PNG.subarray(0, 23)), null);
  const noHeader = png(10, 10);
  noHeader.set([0, 0, 0, 0], 12);
  assert.equal(pngSize(noHeader), null);
  assert.equal(PICTURE_MAX_SIDE, 8192);
});

test("what is left and the day's allowance are shown only when they can be so", () => {
  assert.equal(picturesPerDay({ per_day: 2 }), 2);
  for (const per_day of [0, -1, 1.5, 101, "2", null, undefined]) assert.equal(picturesPerDay({ per_day }), 2, String(per_day));
  assert.equal(picturesLeft({ per_day: 2, left_today: 0 }), 0);
  assert.equal(picturesLeft({ per_day: 2, left_today: 2 }), 2);
  for (const left_today of [-1, 3, 1.5, 1e9, "1", null, undefined]) {
    assert.equal(picturesLeft({ per_day: 2, left_today }), null, String(left_today));
  }
});

// ------------------------------------------------------------ the page --

test("a picture is checked before it goes, drawn only from a blob: URL of checked bytes, and let go with its thread", () => {
  const pg = readFileSync(`${PUBLIC}ai/playground.js`, "utf8");
  const make = pg.slice(pg.indexOf("async function makePicture("), pg.indexOf("// ---------------------------------------------------------- sign-in --"));
  const call = make.indexOf("gateway.picture(");
  assert.ok(call > 0);
  assert.ok(make.indexOf("looksLikePhrase(prompt)") > 0 && make.indexOf("looksLikePhrase(prompt)") < call, "a recovery phrase is stopped first (F12)");
  assert.ok(make.indexOf("prompt.length > PICTURE_PROMPT_CHARS") > 0 && make.indexOf("prompt.length > PICTURE_PROMPT_CHARS") < call, "an over-long prompt is stopped first");
  assert.match(make, /gateway\.picture\(\{ prompt, size: ratio, signal: left \}\)/);
  assert.match(make, /URL\.createObjectURL\(new Blob\(\[r\.bytes\], \{ type: r\.type \}\)\)/, "the page's own URL for the checked bytes");
  assert.match(make, /img\.src = url;/);
  assert.doesNotMatch(make, /b64_json|data:image/, "never a data: URL or the raw answer");
  assert.match(make, /download="\$\{`cumai-\$\{stamp\(\)\}\.\$\{ext\}`\}"/, "Download saves it under a name of ours");
  // The name's time is the page's own: a malformed `created` once threw after the picture was drawn,
  // showing a made picture as a failure whose Retry spent another.
  assert.match(pg, /const stamp = \(\) => new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(make, /r\.created/);
  const clear = pg.slice(pg.indexOf("function clearPictures("), pg.indexOf("function draw()"));
  assert.match(clear, /for \(const u of S\.urls\) URL\.revokeObjectURL\(u\);/);
  assert.match(pg, /if \(before === "in" && S\.state !== "in"\) \{\s*S\.history = \[\];\s*for \(const u of S\.urls\) URL\.revokeObjectURL\(u\);/, "leaving the playground lets them go too");
  // The shape sent is one of the list, whatever the button says; one call at a time, chat or picture;
  // a draft goes where the mode is when it is sent, and the switch is locked while anything runs.
  assert.match(pg, /if \(busy\(\) \|\| !PICTURE_SIZES\.includes\(ratio\.dataset\.pgRatio\)\) return;\s*S\.ratio = ratio\.dataset\.pgRatio;/);
  assert.match(make, /if \(!th \|\| !p \|\| busy\(\)\) return;/);
  assert.match(pg, /const th = \$\("#pg-thread", root\);\s*if \(!th \|\| busy\(\)\) return;/, "no chat while a picture is being made");
  assert.match(pg, /void \(picMode\(\) \? makePicture\(text\) : send\(text\)\);/);
  assert.match(pg, /if \(mode\) \{\s*if \(busy\(\)\) return;/);
  assert.ok(make.indexOf("S.making = new AbortController();") < make.indexOf("await "), "busy before the first wait: a double press sends once");
  // A refusal's words, the gateway's own included, are drawn as text.
  const note = pg.slice(pg.indexOf("function notice("), pg.indexOf("function centerNote("));
  assert.match(note, /<b>\$\{r\.title \?\? "Not sent"\}<\/b><p>\$\{r\.say\}/, "its title, then its sentence (AP)");
  // No Stop for a picture: once asked for it is made and counts.
  assert.match(pg, /if \(S\.making\) return;\s*if \(S\.streaming\) \{/);
});

test("the page's policy draws images from itself and blob: only", () => {
  const http = readFileSync(fileURLToPath(new URL("../../server/http.ts", import.meta.url)), "utf8");
  const ai = http.slice(http.indexOf("export const AI_PAGE_POLICY"), http.indexOf('].join("; ");', http.indexOf("export const AI_PAGE_POLICY")));
  assert.match(ai, /"img-src 'self' blob:",/);
  assert.doesNotMatch(ai, /img-src[^"]*(data:|https:)/);
});

// ------------------------------------------------------------ the models --

test("the Models tab's picture prices: per picture, by size, from /v1/images/models", () => {
  const rows = parsePictureModels({
    object: "list",
    data: [
      { id: "gpt-image-2", object: "model", owned_by: "cumlabs", kind: "image", pricing: { "1K": 0.0085, "2K": 0.014, "4K": 0.03 } },
      { id: "seedream-5", object: "model", kind: "image", pricing: { default: 0.03 } },
      { id: "bad id!", pricing: { default: 1 } },
      { id: "no-price", pricing: { default: -1, "<b>": 1 } },
      { id: "no-pricing" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.id, r.tiers]), [
    ["gpt-image-2", [["1K", 0.0085], ["2K", 0.014], ["4K", 0.03]]],
    ["seedream-5", [["default", 0.03]]],
  ]);
  assert.equal(rows[0].maker, "OpenAI");
  assert.equal(parsePictureModels({ object: "list", data: [] }), null);
  assert.equal(parsePictureModels({ error: { code: "not_found" } }), null);
  const ai = readFileSync(`${PUBLIC}ai/ai.js`, "utf8");
  assert.match(ai, /if \(snap\.free\?\.pictures && S\.pics === undefined\) \{/, "asked for only once /v1/free names pictures: no 404 while they're off");
  // The inspector follows the mode: in Picture mode, the picture model and today's pictures, not chat's dollars.
  const insp = ai.slice(ai.indexOf("function inspPlay("), ai.indexOf("/** A model's state"));
  assert.match(insp, /const pic = p\?\.state === "in" && p\.mode === "picture" \? picturesOffered\(p\.free\) : null;/);
  assert.match(insp, /card\("Today's pictures", "coin", html`<b class="cai-big num">\$\{`\$\{left\} of \$\{picturesPerDay\(pic\)\} left`\}<\/b>/, "pictures left, as one figure (AP)");
  assert.match(insp, /const left = picturesLeft\(pic\) \?\? picturesPerDay\(pic\);/);
  const index = readFileSync(`${PUBLIC}ai/index.html`, "utf8");
  assert.match(index, /<section class="ai-pics" id="ai-pics" aria-labelledby="ai-pics-h" hidden>/, "hidden until there is a list");
});
