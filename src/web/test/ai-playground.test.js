// cumAI's playground plumbing (stage C, C4 to C5c; X20 A4, A8, A9, A12): the
// words for every refusal, the gateway client against a stub gateway, the
// history trim, the two wallets as signers, the login through cumOS's own
// session, and the playground's pure state.
// The drawing is checked in the browser (C5's notes). Nothing here reaches
// the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TERMS_VERSION } from "../public/js/core/constants.js";
import { ACTIONS, KNOWN_CODES, refusal, tooLong, utcTime } from "../public/ai/words.js";
import {
  CALL_TIMEOUT_MS, GatewayRefusal, HISTORY_BYTES, createGateway, eventData, sizeOf, trimHistory,
} from "../public/ai/gateway.js";
import { discoverOwn, ownAccount, ownSigner, toHex, tradingSigner } from "../public/ai/wallets.js";
import { NO_CHAIN, acknowledgeHere, createLogin, ownDoor, startHere } from "../public/ai/login.js";
import { ACTIVE_KEY, CHANNEL, createSession as createCore } from "../public/js/wallet/sessionCore.js";
import { TRADING_ACK } from "../public/ai/words.js";
import { addCall, dollars, emptySession, kb, looksLikePhrase, playState, replyParts, short } from "../public/ai/state.js";

const BASE = "https://api.clankuwu.com";

/** A stub gateway: answers by path, and records every call as the page made it. */
function stub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const path = url.slice(BASE.length);
    const r = routes[path];
    if (!r) throw new TypeError("Failed to fetch");
    // A fresh body each time: the same route may answer twice.
    return typeof r === "function" ? r(init) : r.clone();
  };
  return { fetch, calls };
}
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const error = (status, code, message, extra = {}, headers = {}) => json(status, { error: { message, type: "x", code, ...extra } }, headers);
/** A streamed answer, delivered in exactly these chunks. */
const sse = (chunks, headers = {}) => new Response(new ReadableStream({
  start(c) {
    for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
    c.close();
  },
}), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

// ---------------------------------------------------------------- words --

test("every refusal in A9's table, and C2's preview, is one sentence with its action", () => {
  const want = {
    not_signed_in: ["Sign in again: your session ended.", ACTIONS.SIGN_IN],
    terms_changed: ["Sign in again: your session ended.", ACTIONS.SIGN_IN],
    // The user's mockup (AP, 2026-09-30), under the title "This wallet isn't eligible yet".
    free_tier_not_eligible: ["Free use requires a sent transaction or a small ETH balance on Robinhood Chain.", ACTIONS.ADD_ETH],
    free_tier_ip_limit: ["Your network has started its 10 new free accounts today. Wallets already signed up still work.", null],
    free_allowance_used: ["Today's free use is spent, or this conversation is too long for what is left.", ACTIONS.NEW_CHAT],
    free_tier_limit: ["This conversation is too long for the free playground.", ACTIONS.NEW_CHAT],
    looks_like_recovery_phrase: ["That looked like a recovery phrase, so it was not sent. Never share one.", null],
    free_tier_off: ["The playground is paused.", null],
    free_tier_preview: ["The playground is in a private preview. It opens to everyone soon.", null],
    free_tier_unavailable: ["The playground can't answer right now. Try again shortly.", ACTIONS.RETRY],
    chain_unavailable: ["The playground can't answer right now. Try again shortly.", ACTIONS.RETRY],
    network: ["The playground can't answer right now. Try again shortly.", ACTIONS.RETRY],
  };
  for (const [code, [say, action]] of Object.entries(want)) {
    const r = refusal({ code });
    assert.equal(r.say, say, code);
    assert.equal(r.action, action, code);
  }
});

test("a refusal says when it clears, from the gateway's own fields", () => {
  assert.equal(refusal({ code: "free_tier_exhausted", extra: { opens_at: "2026-09-25T14:00:00.000Z" } }).say,
    "The free playground is busy. More opens at 14:00 UTC.");
  assert.equal(refusal({ code: "free_tier_exhausted" }).say, "The free playground is busy. More opens within the hour.");
  assert.equal(refusal({ code: "free_allowance_used", extra: { resets_at: "2026-09-26T00:00:00.000Z" } }).when, "00:00 UTC");
  assert.equal(refusal({ code: "free_tier_ip_limit", extra: { resets_at: "nonsense" } }).when, null);
  assert.equal(utcTime(undefined), null);
});

test("content_blocked and key_cooling_down keep the gateway's words; an unknown code never shows raw", () => {
  assert.deepEqual(refusal({ code: "content_blocked", message: "blocked by moderation (request r1)" }),
    { say: "blocked by moderation (request r1)", action: null, when: null });
  const odd = refusal({ code: "some_new_code", message: "free_tier_whatever" });
  assert.equal(odd.say, "The playground can't answer right now. Try again shortly.");
  assert.equal(odd.action, ACTIONS.RETRY);
  assert.equal(refusal(null).action, ACTIONS.RETRY);
});

test("the words claim nothing the shared free account breaks, and name no code or supplier", () => {
  for (const code of KNOWN_CODES) {
    const { say } = refusal({ code, message: "The request was blocked by moderation." });
    assert.doesNotMatch(say, /paid keys|APIMart|OpenRouter|_/i, code);
    assert.match(say, /^[A-Z].*[.]$/, code);
  }
  assert.equal(tooLong(7200, HISTORY_BYTES), "This message is 7.2 KB, and the free playground takes 6.5 KB. Shorten it.");
});

// ------------------------------------------------------------ the client --

test("status and whoami: simple GETs with the session cookie, nothing else", async () => {
  const s = stub({
    "/v1/free": json(200, { on: false, preview: true, model: "gpt-4.1-nano" }),
    "/v1/account": json(401, { error: { code: "not_signed_in", message: "sign in" } }),
  });
  const g = createGateway({ fetch: s.fetch });
  assert.deepEqual(await g.status(), { on: false, preview: true, model: "gpt-4.1-nano" });
  assert.equal(await g.whoami(), null, "signed out is null, not a refusal");
  for (const c of s.calls) {
    assert.equal(c.method, "GET");
    assert.equal(c.credentials, "include");
    assert.equal(c.headers, undefined, "no custom header, so no preflight");
    assert.equal(c.body, undefined);
    assert.ok(c.signal instanceof AbortSignal, "it times out");
  }
  assert.deepEqual(s.calls.map((c) => c.url), [`${BASE}/v1/free`, `${BASE}/v1/account`]);
  assert.equal(CALL_TIMEOUT_MS, 15_000);
});

test("sign-in: the gateway's message, signed as given, then the cookie's call; sign-out ends it", async () => {
  const message = "clankuwu.com wants you to sign in with your Ethereum account:\n0xAbC";
  const s = stub({
    "/v1/auth/challenge": json(200, { message, expires_at: "x", contract_wallet: false }),
    "/v1/auth/sign-in": json(200, { address: "0xAbC", can_call: false, session_expires_at: "y" }),
    "/v1/auth/sign-out": new Response(null, { status: 204 }),
  });
  const g = createGateway({ fetch: s.fetch });
  const signed = [];
  const got = await g.signIn({ address: "0xAbC", sign: async (m) => { signed.push(m); return "0xsig"; } });
  assert.deepEqual(signed, [message]);
  assert.deepEqual(got, { address: "0xAbC", can_call: false, session_expires_at: "y" });
  assert.deepEqual(s.calls[0].body, { address: "0xAbC", action: "sign-in" }, "only ever a sign-in, never a key mint");
  assert.deepEqual(s.calls[1].body, { message, signature: "0xsig" });
  assert.ok(s.calls.every((c) => c.method === "POST" && c.credentials === "include"));
  assert.equal(await g.signOut(), undefined);
  assert.equal(s.calls[2].url, `${BASE}/v1/auth/sign-out`);
});

test("sign-in refusals: the gateway's code, a wallet that declines, and the facade's own refusal", async () => {
  const g = createGateway({ fetch: stub({
    "/v1/auth/challenge": json(200, { message: "m" }),
    "/v1/auth/sign-in": error(401, "sign_in_failed", "the signature does not match"),
  }).fetch });
  await assert.rejects(g.signIn({ address: "0x1", sign: async () => "0xsig" }), (e) => e instanceof GatewayRefusal && e.code === "sign_in_failed");
  await assert.rejects(g.signIn({ address: "0x1", sign: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); } }),
    (e) => e.code === "wallet_declined");
  await assert.rejects(g.signIn({ address: "0x1", sign: async () => { throw new GatewayRefusal("wallet_refused", "Refused: x"); } }),
    (e) => e.code === "wallet_refused");
  const bad = createGateway({ fetch: stub({ "/v1/auth/challenge": error(400, "bad_address", "address must be a 0x address") }).fetch });
  await assert.rejects(bad.signIn({ address: "nope", sign: async () => "0x" }), (e) => e.code === "bad_address" && e.status === 400);
});

test("a refusal carries its fields and its retry-after; an unreachable gateway is 'network'", async () => {
  const g = createGateway({ fetch: stub({
    "/v1/free": error(429, "free_tier_exhausted", "busy", { opens_at: "2026-09-25T14:00:00.000Z" }, { "retry-after": "120" }),
  }).fetch });
  await assert.rejects(g.status(), (e) => e.code === "free_tier_exhausted" && e.extra.opens_at === "2026-09-25T14:00:00.000Z"
    && e.extra.retry_after_seconds === 120 && refusal(e).say === "The free playground is busy. More opens at 14:00 UTC.");
  await assert.rejects(g.whoami(), (e) => e.code === "network");
  const html = createGateway({ fetch: async () => new Response("<html>502</html>", { status: 502 }) });
  await assert.rejects(html.status(), (e) => e.code === "http_502" && refusal(e).action === ACTIONS.RETRY);
});

test("chat: one streamed POST; the reply arrives in pieces, split anywhere, with its cost", async () => {
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "lo <b>there</b>" } }] })}`,
    ": a comment line",
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.00003 } })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  // Chunks cut through the middle of events and of a multi-byte character.
  const bytes = new TextEncoder().encode(events.replace("there", "thé"));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(new TextDecoder("latin1").decode(bytes.slice(i, i + 7)));
  const s = stub({ "/v1/chat/completions": () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
  }), { status: 200, headers: { "x-cum-request-id": "req-1" } }) });
  const g = createGateway({ fetch: s.fetch });
  const heard = [];
  const out = await g.chat([{ role: "user", content: "hi" }], { model: "gpt-4.1-nano", onDelta: (p, so) => heard.push([p, so]) });
  assert.deepEqual(out, { text: "Hello <b>thé</b>", cost: 0.00003, tokens: 12, requestId: "req-1", stopped: false });
  assert.equal(heard.at(-1)[1], "Hello <b>thé</b>", "the text arrives as it came: markup stays text for the page to set as text");
  assert.deepEqual(s.calls[0].body, { model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(s.calls[0].credentials, "include");
  assert.ok(chunks.length > 5);
});

test("chat: a refusal before the stream, an error inside it, and Stop", async () => {
  const pre = createGateway({ fetch: stub({ "/v1/chat/completions": error(403, "free_tier_preview", "private preview") }).fetch });
  await assert.rejects(pre.chat([{ role: "user", content: "hi" }], { model: "m" }), (e) => e.code === "free_tier_preview");

  const mid = createGateway({ fetch: stub({ "/v1/chat/completions": () => sse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`,
    `data: ${JSON.stringify({ error: { message: "the provider stopped sending (request r)", type: "gateway_error", code: "upstream_timeout" } })}\n\n`,
  ]) }).fetch });
  await assert.rejects(mid.chat([{ role: "user", content: "hi" }], { model: "m" }),
    (e) => e.code === "upstream_timeout" && refusal(e).action === ACTIONS.RETRY);

  const ac = new AbortController();
  const slow = createGateway({ fetch: async (_u, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}\n\n`));
      init.signal.addEventListener("abort", () => c.error(new DOMException("stopped", "AbortError")));
    },
  }), { status: 200 }) });
  const run = slow.chat([{ role: "user", content: "hi" }], { model: "m", signal: ac.signal, onDelta: () => ac.abort() });
  assert.deepEqual(await run, { text: "half", cost: null, tokens: null, requestId: null, stopped: true });

  const early = new AbortController();
  early.abort();
  const never = createGateway({ fetch: async (_u, init) => { init.signal.throwIfAborted(); return new Response(null); } });
  assert.deepEqual(await never.chat([{ role: "user", content: "hi" }], { model: "m", signal: early.signal }),
    { text: "", cost: null, tokens: null, requestId: null, stopped: true });
});

test("server-sent events: data lines joined, comments and non-JSON skipped", () => {
  assert.equal(eventData("data: [DONE]"), "[DONE]");
  assert.deepEqual(eventData('data: {"a":1}'), { a: 1 });
  assert.equal(eventData(": ping"), null);
  assert.equal(eventData("data: not json"), null);
  assert.deepEqual(eventData('event: x\r\ndata:{"b":2}'), { b: 2 });
});

// --------------------------------------------------------------- history --

test("the history sent: the newest turns that fit in 6,500 bytes, as the gateway counts them", () => {
  assert.equal(HISTORY_BYTES, 6_500);
  // Each message its own, so the newest can't pass for the oldest.
  const m = (i, n) => ({ role: i % 2 ? "assistant" : "user", content: `#${i} `.padEnd(n, "x") });
  assert.equal(sizeOf([{ role: "user", content: "hi" }]), new TextEncoder().encode('[{"role":"user","content":"hi"}]').length + 8);
  const long = Array.from({ length: 30 }, (_, i) => m(i, 400));
  const { messages, tooLong: over } = trimHistory(long);
  assert.equal(over, null);
  assert.ok(sizeOf(messages) <= HISTORY_BYTES && messages.length < long.length);
  assert.deepEqual(messages, long.slice(-messages.length), "the newest, in order");
  assert.ok(sizeOf(long.slice(-messages.length - 1)) > HISTORY_BYTES, "as many as fit, not fewer");
  // With the gateway's 599-byte system prompt and its fixed 64, a full history stays under its 8,000.
  assert.ok(HISTORY_BYTES + 599 + 8 + 64 + 1 < 8_000);
  const one = trimHistory([m(0, 7_000)]);
  assert.deepEqual(one.messages, []);
  assert.ok(one.tooLong > HISTORY_BYTES);
  assert.deepEqual(trimHistory([]), { messages: [], tooLong: null });
});

// --------------------------------------------------------------- wallets --

test("the trading wallet signs the gateway's sign-in with the terms this site shows", async () => {
  const asked = [];
  const facade = {
    address: async () => "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd",
    signGatewayMessage: async (m, o) => { asked.push([m, o]); return "0xsig"; },
  };
  const signer = await tradingSigner(facade);
  assert.equal(signer.kind, "trading");
  assert.equal(signer.address, "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd");
  assert.equal(await signer.sign("the message"), "0xsig");
  assert.deepEqual(asked, [["the message", { termsVersion: TERMS_VERSION }]]);
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await tradingSigner({ address: async () => null }), null, "no one logged in: no signer");
  const refusing = await tradingSigner({ address: async () => "0x1", signGatewayMessage: async () => { throw new Error("Refused: line 13 is not the gateway's sign-in. Nothing was signed."); } });
  await assert.rejects(refusing.sign("m"), (e) => e instanceof GatewayRefusal && e.code === "wallet_refused");
});

test("nothing in ai/ imports Coinbase's SDK: only login.js reaches the wallet, through cumOS's session and wallet/embedded.js", () => {
  const dir = fileURLToPath(new URL("../public/ai/", import.meta.url));
  const imports = readdirSync(dir).filter((f) => f.endsWith(".js")).flatMap((f) =>
    [...readFileSync(`${dir}${f}`, "utf8").matchAll(/\b(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)].map((m) => [f, m[1]]));
  assert.ok(imports.length > 5);
  assert.deepEqual(imports.filter(([, spec]) => /vendor|wallet\.js$/.test(spec)), [], "no module here imports the vendored SDK");
  assert.deepEqual(imports.filter(([, spec]) => spec.includes("/wallet/")).sort(),
    [["login.js", "../js/wallet/embedded.js"], ["login.js", "../js/wallet/sessionCore.js"]]);
});

test("the visitor's own wallet signs with personal_sign, its message as utf-8 hex", async () => {
  const asked = [];
  const provider = { request: async (r) => { asked.push(r); return "0xown"; } };
  const signer = ownSigner(provider, "0xabc");
  assert.equal(signer.kind, "own");
  assert.equal(await signer.sign("hé\n"), "0xown");
  assert.deepEqual(asked, [{ method: "personal_sign", params: ["0x68c3a90a", "0xabc"] }]);
  assert.equal(toHex(""), "0x");
});

test("cumAI logs in through cumOS's own session: the same marks and channel, and cumOS's parts only in cumOS", () => {
  const session = readFileSync(fileURLToPath(new URL("../public/js/wallet/session.js", import.meta.url)), "utf8");
  const core = readFileSync(fileURLToPath(new URL("../public/js/wallet/sessionCore.js", import.meta.url)), "utf8");
  assert.match(session, /from "\.\/sessionCore\.js"/, "cumOS's session is the shared one, with its own parts");
  assert.match(session, /state: S, acknowledge: acknowledgeTrading, main: \{ connect, provider: mainProvider \}, \.\.\.d,/,
    "cumOS keeps its own state, acknowledgement and wallet door");
  assert.doesNotMatch(core, /core\/store\.js|acknowledge\.js|eip6963\.js/, "the shared session imports nothing of cumOS's page");
  assert.equal(ACTIVE_KEY, "clank.active");
  assert.equal(CHANNEL, "clank.session");
  assert.throws(() => createCore({}), /state, acknowledgement and wallet/, "a page passes its own parts");
  const { session: s, state } = createLogin({ wallets: () => [] });
  assert.deepEqual(state, { trading: null, login: { here: false, phase: "idle", countdown: null, waiting: false } });
  for (const fn of ["boot", "login", "logout", "facade", "on"]) assert.equal(typeof s[fn], "function", fn);
  assert.equal(s.facade(), null, "no facade until logged in");
});

test("on cumAI the trading wallet has no chain: it reads and sends nothing, and keeps its facade", async () => {
  const facade = { id: "f" };
  const w = await startHere(async () => ({ facade, provider: { request: async () => "0xbalance" } }));
  assert.equal(w.facade, facade);
  assert.equal(w.provider, NO_CHAIN);
  for (const method of ["eth_getBalance", "eth_sendTransaction", "eth_sendRawTransaction", "personal_sign"]) {
    await assert.rejects(w.provider.request({ method, params: [] }), (e) => e.code === 4200, method);
  }
});

test("a login with the visitor's own wallet goes through the one they picked, by its id", async () => {
  const provider = { request: async () => ["0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd"] };
  const door = ownDoor(() => [{ uuid: "a", provider }]);
  assert.equal(door.provider(), null);
  assert.equal(await door.connect("a"), "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd");
  assert.equal(door.provider(), provider);
  await assert.rejects(door.connect("gone"), /isn't in this browser/);
});

test("the acknowledgement before a first login is cumOS's, word for word and under its key: asked once for both pages", async () => {
  const ack = readFileSync(fileURLToPath(new URL("../public/js/trade/acknowledge.js", import.meta.url)), "utf8");
  const warning = ack.match(/export const TRADING_WARNING = ([\s\S]*?);/)[1];
  assert.equal(TRADING_ACK.body, [...warning.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(""));
  assert.match(ack, new RegExp(`acknowledgeTrading = acknowledgement\\("${TRADING_ACK.key.replace(/\./g, "\\.")}", "${TRADING_ACK.title}", TRADING_WARNING\\)`));
  const given = { getItem: (k) => (k === "clank.ack.tw" ? "1" : null) };
  assert.equal(await acknowledgeHere({ storage: () => given })(), true, "accepted on cumOS: not asked again here");
});

test("the visitor's own wallets are found through EIP-6963, by name, and asked for one account", async () => {
  const target = new EventTarget();
  const provider = { request: async () => ["0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd"] };
  target.addEventListener("eip6963:requestProvider", () => {
    for (const detail of [{ info: { uuid: "a", name: "Wallet <b>A</b>", icon: "data:image/svg+xml,x" }, provider },
      { info: { uuid: "a", name: "Again" }, provider }, { info: { uuid: "b" }, provider }, { info: { name: "no id" }, provider }, { info: { uuid: "c" } }]) {
      target.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail }));
    }
  });
  const found = await discoverOwn(20, target);
  assert.deepEqual(found.map((w) => [w.uuid, w.name]), [["a", "Again"], ["b", "Wallet"]], "one per wallet; nameless is 'Wallet'; no provider, no id: left out");
  assert.ok(found.every((w) => !("icon" in w)), "no icon: the page's policy allows no data: image");
  assert.equal(await ownAccount(provider), "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd");
  await assert.rejects(ownAccount({ request: async () => ["not an address"] }));
  await assert.rejects(ownAccount({ request: async () => [] }));
});

// -------------------------------------------------------------- the state --

test("the playground's state, from /v1/free and /v1/account", () => {
  const acct = { address: "0x1" };
  assert.equal(playState(undefined, null), "loading");
  assert.equal(playState(null, null), "down");
  assert.equal(playState({ on: false, model: "m" }, null), "off");
  assert.equal(playState({ on: false, model: "m" }, acct), "off", "off is off, signed in or not");
  assert.equal(playState({ on: true, model: "m" }, null), "out");
  assert.equal(playState({ on: true, model: "m" }, acct), "out", "signed in under older terms: no allowance is said, so sign in again");
  assert.equal(playState({ on: true, model: "m", left_usd: 0.0087 }, acct), "in");
  assert.equal(playState({ on: false, preview: true }, null), "preview");
  assert.equal(playState({ on: false, preview: true }, acct), "preview-denied");
  assert.equal(playState({ on: true, preview: true, left_usd: 0.01 }, acct), "in", "a listed wallet in a preview chats");
});

test("a recovery phrase never leaves the browser; a sentence does", () => {
  const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  assert.equal(looksLikePhrase(phrase), true);
  assert.equal(looksLikePhrase(`  ${phrase.replace(/ /g, "\n")}  `), true, "however it is spaced");
  assert.equal(looksLikePhrase(`${phrase} actor act action actress adapt add addict address adjust admit adult advance`), true, "24 words");
  assert.equal(looksLikePhrase(phrase.split(" ").slice(0, 11).join(" ")), false, "11 words is not a phrase");
  assert.equal(looksLikePhrase("What does an ERC-20 approve actually allow me to do with my own tokens today"), false);
  assert.equal(looksLikePhrase("explain what a bonding curve is and how the price moves when people buy it now"), false, "13 words");
});

test("replies: prose and code, as text; figures as a free call's size", () => {
  assert.deepEqual(replyParts("Hi <b>x</b>\n```js\nconsole.log(1)\n```\nbye"), [
    { code: false, text: "Hi <b>x</b>\n" }, { code: true, text: "console.log(1)" }, { code: false, text: "\nbye" }]);
  assert.deepEqual(replyParts("```\nraw\n```"), [{ code: true, text: "raw" }]);
  assert.deepEqual(replyParts("open ```python\nstill streaming"), [{ code: false, text: "open " }, { code: true, text: "still streaming" }]);
  assert.deepEqual(replyParts(""), []);
  assert.equal(dollars(0.00003), "$0.00003");
  assert.equal(dollars(0.0000543), "$0.000054", "two significant figures");
  assert.equal(dollars(0.000004), "<$0.00001", "below a hundred-thousandth, said as less than one");
  assert.equal(dollars(0.0087), "$0.0087");
  assert.equal(dollars(0.01), "$0.01");
  assert.equal(dollars(0), "$0");
  assert.equal(dollars(NaN), "—");
  assert.equal(dollars(undefined), "—");
  assert.equal(kb(812), "812 B");
  assert.equal(kb(6500), "6.5 KB");
  assert.equal(short("0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd"), "0xAbCd…AbCd");
  const s = addCall(addCall(emptySession(), { tokens: 96, cost: 0.00003 }), { tokens: 10, cost: NaN });
  assert.deepEqual(s, { calls: 2, tokens: 106, cost: 0.00003 });
});
