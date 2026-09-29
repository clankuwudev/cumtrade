// The trading wallet's login, logout and idle lock (public-release W1.2).
//
// Each tab is a session over W1.1's real start() and provider, and a scripted
// facade standing in for Coinbase's SDK as W1.1 found it behaves: each tab's
// SDK keeps its session in its own memory, restores it from the one stored
// refresh token only when it starts, finishes a Google or X return inside
// init, and hears nothing from other tabs. The tabs share one storage, one
// BroadcastChannel and one set of Web Locks, as a browser's tabs do, and one
// fake clock. Nothing leaves the process: the facade holds no key and calls no
// one, and the chain's RPC is a stub. Every address is made up.
import { test } from "node:test";
import { FAST_RPC, PUBLIC_RPC } from "../public/js/trade/constants.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { S } from "../public/js/core/store.js";
import { SENDS_KEY, start } from "../public/js/wallet/embedded.js";
import {
  ACTIVE_KEY, IDLE_MS, METHOD_KEY, OAUTH_PARAMS, SHARE_MS, SKEW_MS, TRADE_LOCK, WARN_MS, createSession,
} from "../public/js/wallet/session.js";
import { walletError } from "../public/js/wallet/eip6963.js";
import { stubDom, textOf } from "./support/stubdom.js";

const ORIGIN = "https://staging.clank.example";
/** A made-up project ID, shaped like the portal's. Not anyone's project. */
const FAKE_PROJECT = "00000000-0000-4000-8000-000000000002";
const PROJECTS = [{ name: "staging", origin: ORIGIN, projectId: FAKE_PROJECT }];
/** The trading wallet each way of logging in gives, in this made-up project. */
const TW = {
  google: "0x0000000000000000000000000000000000006006",
  x: "0x000000000000000000000000000000000000000A",
  wallet: "0x000000000000000000000000000000000000Ca11",
};
/** The visitor's own wallet (F2), for a wallet login. */
const MAIN = "0x00000000000000000000000000000000000A11cE";
const T0 = 1_789_600_000_000;
const MIN = 60_000;

const settle = () => new Promise((r) => setImmediate(r));
const settleAll = async (n = 8) => { for (let i = 0; i < n; i++) await settle(); };
const err = (code, message) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------ doubles --

/** localStorage, shared by the tabs, recording every write. */
function memoryStorage() {
  const m = new Map();
  const writes = [];
  return {
    writes,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { writes.push([k, String(v)]); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

/** Web Locks as a browser grants them: shared holders together, exclusive alone, in request order. */
function webLocks() {
  const queues = new Map();
  const pump = (name) => {
    const q = queues.get(name);
    while (q.waiting.length) {
      const next = q.waiting[0];
      const free = next.mode === "shared" ? q.held.every((h) => h.mode === "shared") : q.held.length === 0;
      if (!free) break;
      q.waiting.shift();
      const h = { mode: next.mode };
      q.held.push(h);
      Promise.resolve()
        .then(() => next.fn({ name, mode: next.mode }))
        .then(next.resolve, next.reject)
        .finally(() => { q.held.splice(q.held.indexOf(h), 1); pump(name); });
    }
  };
  const asked = [];
  return {
    request(name, options, fn) {
      asked.push([name, options.mode ?? "exclusive"]);
      if (!queues.has(name)) queues.set(name, { held: [], waiting: [] });
      return new Promise((resolve, reject) => {
        queues.get(name).waiting.push({ mode: options.mode ?? "exclusive", fn, resolve, reject });
        pump(name);
      });
    },
    held: (name) => (queues.get(name)?.held ?? []).map((h) => h.mode),
    /** How many times `name` was asked for in `mode`. */
    asked: (name, mode) => asked.filter(([n, m]) => n === name && m === mode).length,
  };
}

/** Coinbase's side: the one stored refresh token's session, and the OAuth flow the SDK waits for. */
function coinbase() {
  return { stored: null, pending: null, revoked: 0 };
}

/**
 * One tab's SDK, behind the facade's nine functions. Its session lives in its
 * own memory (`me`). At init it restores the stored session and finishes a
 * Google or X return, removing the parameters as the SDK does (unless `leaves`
 * is set, as when its first refresh throws).
 */
function facade(cb, tab) {
  const f = {
    me: null, calls: [], logins: [], signedOut: 0, listeners: new Set(),
    leaves: false, initFails: false, oauthError: null, hangLogout: null,
    async init({ projectId }) {
      f.calls.push("init");
      assert.equal(projectId, FAKE_PROJECT);
      if (f.initFails) throw new Error("Could not reach Coinbase.");
      if (cb.stored) f.me = cb.stored.address;
      const url = new URL(tab.href);
      const p = new URLSearchParams(url.search);
      const failed = p.has("error") || p.has("error_description");
      const back = (p.get("code") && p.get("provider_type") && p.get("flow_id")) || failed;
      if (!back) return;
      if (!f.leaves) {
        for (const k of OAUTH_PARAMS) url.searchParams.delete(k);
        tab.history.replaceState(tab.history.state, "", url.toString());
      }
      if (failed) f.oauthError = p.get("error_description") ?? p.get("error");
      else if (p.get("flow_id") !== cb.pending) f.oauthError = "OAuth flow could not be verified. Please try signing in again.";
      else {
        cb.stored = { address: TW[p.get("provider_type")] };
        f.me = cb.stored.address;
      }
    },
    async startLogin(provider) {
      f.calls.push("startLogin");
      if (f.startFails) throw new Error("Could not open Google.");
      f.logins.push(provider);
      cb.pending = "flow-1";
    },
    async loginWithWallet(eip1193) {
      f.calls.push("loginWithWallet");
      if (!eip1193) throw new Error("No wallet to sign in with.");
      const [account] = await eip1193.request({ method: "eth_requestAccounts" });
      await eip1193.request({ method: "personal_sign", params: ["0x73696e", account] });
      cb.stored = { address: TW.wallet };
      f.me = TW.wallet;
      for (const fn of f.listeners) fn(f.me);
      return f.me;
    },
    async completeLogin() {
      f.calls.push("completeLogin");
      if (f.oauthError) throw new Error(f.oauthError);
      return f.me;
    },
    async address() { f.calls.push("address"); return f.me; },
    async logout() {
      f.calls.push("logout");
      if (f.hangLogout) await f.hangLogout;
      if (!f.me) return;
      cb.stored = null;
      cb.revoked++;
      f.signedOut++;
      f.me = null;
      for (const fn of f.listeners) fn(null);
    },
    onAuthChange(fn) { f.listeners.add(fn); return () => f.listeners.delete(fn); },
    async signTransaction() { throw new Error("nothing is signed in these tests"); },
    /** The SDK ends the session by itself: its refresh failed. */
    end() {
      cb.stored = null;
      f.me = null;
      for (const fn of f.listeners) fn(null);
    },
    /** The SDK refreshes its token, and reports who is logged in: the same user, or (`address`) another. */
    refreshed(address = f.me) {
      f.me = address;
      for (const fn of f.listeners) fn(address);
    },
  };
  return f;
}

/** F2's wallet, as the session reaches it: connect(uuid), then its provider. */
function mainWallet() {
  const m = {
    connected: null, calls: [], rejectSign: false,
    provider: {
      async request({ method }) {
        m.calls.push(method);
        if (method === "eth_requestAccounts") return [MAIN];
        if (method === "personal_sign") {
          if (m.rejectSign) throw err(4001, "User rejected the request.");
          return `0x${"ab".repeat(65)}`;
        }
        throw err(4200, `unsupported ${method}`);
      },
    },
  };
  return {
    m,
    async connect(uuid) { m.calls.push("connect"); m.connected = uuid; return MAIN; },
    provider: () => (m.connected ? m.provider : null),
  };
}

/** A browser: shared storage, channel, locks, Coinbase, the visitor's own wallet, a clock and the chain's RPC. */
function browser() {
  const b = {
    cb: coinbase(), storage: memoryStorage(), locks: webLocks(), main: mainWallet(),
    clock: { t: T0, ticks: new Set() }, posts: [], chans: new Set(), drop: false,
    balances: new Map(), rpcCalls: [], holdBalance: null,
  };
  b.open = () => {
    const ch = {
      onmessage: null,
      postMessage(m) {
        b.posts.push(structuredClone(m));
        if (b.drop) return;
        for (const other of b.chans) {
          if (other === ch) continue;
          const data = structuredClone(m);
          setImmediate(() => other.onmessage && other.onmessage({ data }));
        }
      },
      close() { b.chans.delete(ch); },
    };
    b.chans.add(ch);
    return ch;
  };
  // The chain's public RPC: the only thing the session reads through the provider is a balance.
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    b.rpcCalls.push({ url: String(url), method, params });
    if (method === "eth_getBalance" && b.holdBalance) await b.holdBalance;
    const result = method === "eth_getBalance" ? `0x${(b.balances.get(String(params[0]).toLowerCase()) ?? 0n).toString(16)}` : null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  return b;
}

/** One tab of `b` at `href`. `here: "map"` lets the committed map decide, as on the page. */
function openTab(b, { href = `${ORIGIN}/#/launches`, here = true, ack = true, locks = b.locks, storage } = {}) {
  const tb = { href, ack, acks: 0, events: [], loads: 0, input: null, replaced: [] };
  tb.location = { get href() { return tb.href; }, get origin() { return new URL(tb.href).origin; } };
  tb.history = {
    state: null,
    replaceState(state, _title, url) { tb.replaced.push(url); tb.href = new URL(url, tb.href).toString(); tb.history.state = state; },
  };
  tb.f = facade(b.cb, tb);
  tb.state = { trading: null, login: { here: false, phase: "idle", countdown: null, waiting: false } };
  tb.s = createSession({
    ...(here === "map" ? {} : { here }),
    state: tb.state,
    start: () => { tb.loads++; return start({ origin: tb.location.origin, projects: PROJECTS, load: async () => tb.f }); },
    storage: storage ?? (() => b.storage),
    channel: () => b.open(),
    locks,
    now: () => b.clock.t,
    every: (fn) => { b.clock.ticks.add(fn); return () => b.clock.ticks.delete(fn); },
    watch: (fn) => { tb.input = fn; },
    location: () => tb.location,
    history: () => tb.history,
    acknowledge: async () => { tb.acks++; return tb.ack; },
    main: b.main,
  });
  tb.changes = 0;
  tb.s.on((type, detail) => { if (type === "change") tb.changes++; else tb.events.push([type, detail]); });
  return tb;
}

/** Move the clock on a second at a time, running every tab's timer, as a browser would. */
async function advance(b, ms) {
  const end = b.clock.t + ms;
  while (b.clock.t < end) {
    b.clock.t = Math.min(end, b.clock.t + 1_000);
    for (const fn of [...b.clock.ticks]) fn();
    await settle();
  }
  await settleAll();
}

const outs = (b) => b.posts.filter((m) => m.type === "out");
const outEvents = (tb) => tb.events.filter(([type]) => type === "out").map(([, d]) => d);

/** Two tabs of one browser, both logged in with a wallet at T0. */
async function twoTabs() {
  const b = browser();
  const a = openTab(b), c = openTab(b);
  await a.s.boot();
  await c.s.boot();
  await a.s.login("wallet", { uuid: "mm" });
  await settleAll();
  assert.equal(c.state.trading?.address, TW.wallet, "the other tab took the login up");
  return { b, a, c };
}

// --------------------------------------------------------- the origin --

test("an origin with no pinned project: nothing loads, listens or ticks, and there is no login", async () => {
  const b = browser();
  // Even with a mark and a returning login on the address bar.
  b.storage.setItem(ACTIVE_KEY, String(T0));
  const tb = openTab(b, { here: "map", href: "https://clank.example/?code=c&provider_type=google&flow_id=f#/home" });
  await tb.s.boot();
  assert.equal(tb.state.login.here, false);
  assert.equal(tb.loads, 0, "the SDK is never fetched");
  assert.equal(b.clock.ticks.size, 0, "no timer");
  assert.equal(tb.input, null, "no input listeners");
  assert.equal(b.chans.size, 0, "no channel");
  assert.equal(tb.href, "https://clank.example/?code=c&provider_type=google&flow_id=f#/home", "the address bar is not touched");
  await assert.rejects(tb.s.login("google"), /no trading wallet on this site/);
  assert.equal(tb.acks, 0);
  assert.equal(tb.s.provider(), null);
});

test("the committed map pins no origin yet, so every hosted page keeps trading from the visitor's own wallet", () => {
  for (const origin of [ORIGIN, "http://localhost:8787", "http://127.0.0.1:8787", "https://clank.example"]) {
    const state = { trading: null, login: { here: true, phase: "idle", countdown: null, waiting: false } };
    assert.equal(createSession({ state, location: () => ({ href: `${origin}/`, origin }) }).detect(), false, origin);
    assert.equal(state.login.here, false);
  }
  assert.equal(S.login.here, false, "and the page's state starts without one");
  assert.equal(S.trading, null);
});

// --------------------------------------------------------- the logins --

for (const method of ["google", "x"]) {
  test(`${method}: the acknowledgement, then the SDK, then the route is dropped and the page leaves`, async () => {
    const b = browser();
    const tb = openTab(b, { href: `${ORIGIN}/?ref=board#/token/0x00000000000000000000000000000000000070a1` });
    await tb.s.boot();
    assert.equal(tb.loads, 0, "nothing loads before a login");
    assert.equal(await tb.s.login(method), null);
    assert.equal(tb.acks, 1);
    assert.equal(tb.loads, 1);
    assert.deepEqual(tb.f.calls, ["init", "address", "startLogin"]);
    assert.deepEqual(tb.f.logins, [method]);
    // Coinbase sends the visitor back to location.href: the bare page, with
    // nothing after a hash for the SDK or the router to trip on.
    assert.equal(tb.href, `${ORIGIN}/?ref=board`);
    assert.equal(tb.state.login.phase, "redirecting");
    assert.equal(tb.state.trading, null);
    assert.equal(b.storage.getItem(METHOD_KEY), null, "the method is remembered once the login completes");
  });
}

test("a declined acknowledgement loads nothing and leaves nothing", async () => {
  const b = browser();
  const tb = openTab(b, { ack: false });
  await tb.s.boot();
  for (const [method, opts] of [["google"], ["x"], ["wallet", { uuid: "mm" }]]) {
    assert.equal(await tb.s.login(method, opts), null);
  }
  assert.equal(tb.acks, 3);
  assert.equal(tb.loads, 0);
  assert.equal(b.main.m.connected, null, "no wallet was asked to connect");
  assert.equal(tb.href, `${ORIGIN}/#/launches`);
  assert.deepEqual(b.storage.dump(), {});
});

test("the return from Google: the SDK finishes it in init, the session is taken up, and the method is remembered", async () => {
  const b = browser();
  b.cb.pending = "flow-1";
  b.balances.set(TW.google.toLowerCase(), 5n * 10n ** 16n);
  const tb = openTab(b, { href: `${ORIGIN}/?code=c0de&provider_type=google&flow_id=flow-1` });
  const other = openTab(b);
  await other.s.boot();
  await tb.s.boot();
  await settleAll();
  assert.equal(tb.loads, 1, "a returning login loads the SDK");
  assert.deepEqual(tb.state.trading, { address: TW.google, method: "google", balanceWei: 5n * 10n ** 16n });
  assert.equal(tb.href, `${ORIGIN}/`, "the parameters are gone");
  assert.deepEqual(tb.replaced, [`${ORIGIN}/`], "removed once, by the SDK");
  assert.equal(b.storage.getItem(METHOD_KEY), "google");
  assert.equal(b.storage.getItem(ACTIVE_KEY), String(T0), "the login is input");
  assert.ok(b.posts.some((m) => m.type === "in"), "the other tabs are told");
  assert.equal(other.state.trading?.address, TW.google, "and a tab without the SDK takes it up");
  // The balance came straight from the chain (the fast RPC answered), for the trading address.
  assert.ok(b.rpcCalls.every((c) => c.url === FAST_RPC), b.rpcCalls.map((c) => c.url).join(" "));
  assert.deepEqual(b.rpcCalls[0].params, [TW.google, "latest"]);
});

test("the return from X, when the SDK left the parameters: the page removes them, and keeps the rest of the address", async () => {
  const b = browser();
  b.cb.pending = "flow-1";
  const tb = openTab(b, { href: `${ORIGIN}/?ref=board&code=c0de&provider_type=x&flow_id=flow-1#/launches` });
  tb.f.leaves = true;
  await tb.s.boot();
  assert.equal(tb.state.trading.address, TW.x);
  assert.equal(tb.state.trading.method, "x");
  assert.equal(tb.href, `${ORIGIN}/?ref=board#/launches`);
  for (const k of OAUTH_PARAMS) assert.ok(!new URL(tb.href).searchParams.has(k), k);
  // The login was input: the clock runs from it.
  await advance(b, IDLE_MS - WARN_MS);
  assert.equal(tb.state.trading?.address, TW.x);
  assert.equal(tb.state.login.countdown, 60);
});

test("a return that failed: the reason is said, the address bar is cleaned, and nothing is logged in", async () => {
  const cases = [
    ["Google said no", `${ORIGIN}/?error=access_denied&error_description=The+user+said+no#/home`, (f) => { f.leaves = true; }, /did not complete\. The user said no/],
    ["an error alone", `${ORIGIN}/?error=access_denied#/home`, (f) => { f.leaves = true; }, /did not complete\. access_denied/],
    ["a description alone", `${ORIGIN}/?error_description=Cancelled#/home`, (f) => { f.leaves = true; }, /did not complete\. Cancelled/],
    ["a flow the SDK cannot verify", `${ORIGIN}/?code=c0de&provider_type=google&flow_id=another#/home`, () => {}, /could not be verified/],
    ["the SDK could not start", `${ORIGIN}/?code=c0de&provider_type=google&flow_id=flow-1#/home`, (f) => { f.initFails = true; }, /did not complete\. Could not reach Coinbase/],
  ];
  for (const [why, href, set, reason] of cases) {
    const b = browser();
    b.cb.pending = "flow-1";
    const tb = openTab(b, { href });
    set(tb.f);
    await tb.s.boot();
    assert.equal(tb.state.trading, null, why);
    assert.equal(tb.state.login.phase, "idle", why);
    assert.equal(tb.href, `${ORIGIN}/#/home`, why);
    const errors = tb.events.filter(([t]) => t === "error").map(([, m]) => m);
    assert.equal(errors.length, 1, why);
    assert.match(errors[0], reason, why);
    assert.equal(b.storage.getItem(ACTIVE_KEY), null, `${why}: no session mark`);
    assert.ok(!b.posts.some((m) => m.type === "in"), why);
  }
});

test("a wallet login: F2 connects the picked wallet, which signs one message; the trading wallet is Coinbase's", async () => {
  const b = browser();
  b.balances.set(TW.wallet.toLowerCase(), 0n);
  const tb = openTab(b);
  await tb.s.boot();
  await assert.rejects(tb.s.login("wallet", {}), /Pick a wallet/);
  assert.equal(tb.acks, 0, "refused before anything is asked");
  assert.equal(await tb.s.login("wallet", { uuid: "mm" }), TW.wallet);
  await settleAll();
  assert.equal(tb.acks, 1);
  assert.equal(b.main.m.connected, "mm", "F2's connect, so it is the main wallet too");
  assert.deepEqual(b.main.m.calls, ["connect", "eth_requestAccounts", "personal_sign"], "one signature, no transaction");
  assert.deepEqual(tb.f.calls, ["init", "address", "loginWithWallet"]);
  assert.deepEqual(tb.state.trading, { address: TW.wallet, method: "wallet", balanceWei: 0n });
  assert.notEqual(tb.state.trading.address, MAIN, "the main wallet never trades here");
  assert.equal(b.storage.getItem(METHOD_KEY), "wallet");
  assert.ok(b.posts.some((m) => m.type === "in"));
});

test("a wallet login the visitor rejects leaves nothing logged in, and says so in words", async () => {
  const b = browser();
  b.main.m.rejectSign = true;
  const tb = openTab(b);
  await tb.s.boot();
  const e = await tb.s.login("wallet", { uuid: "mm" }).then(() => null, (x) => x);
  assert.equal(walletError(e), "You rejected the request in your wallet.");
  assert.equal(tb.state.trading, null);
  assert.equal(tb.state.login.phase, "idle");
  assert.equal(b.storage.getItem(ACTIVE_KEY), null);
  assert.equal(b.cb.stored, null);
});

test("a login while another tab's session exists takes that session up, and asks Google nothing", async () => {
  const b = browser();
  b.cb.stored = { address: TW.x };
  b.storage.setItem(METHOD_KEY, "x");
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.loads, 0, "no mark, so nothing was loaded at boot");
  assert.equal(await tb.s.login("google"), TW.x);
  assert.deepEqual(tb.f.logins, []);
  assert.deepEqual({ ...tb.state.trading, balanceWei: null }, { address: TW.x, method: "x", balanceWei: null });
  assert.equal(tb.href, `${ORIGIN}/#/launches`, "the page did not leave");
});

test("a wallet login while another tab's session exists takes that session up, and the wallet signs nothing", async () => {
  const b = browser();
  b.cb.stored = { address: TW.google };
  b.storage.setItem(METHOD_KEY, "google");
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(await tb.s.login("wallet", { uuid: "mm" }), TW.google);
  assert.deepEqual(b.main.m.calls, ["connect"], "connected as the main wallet, and asked to sign nothing");
  assert.ok(!tb.f.calls.includes("loginWithWallet"));
  assert.equal(tb.state.trading.method, "google");
});

test("part of a return on the address bar is not one: nothing loads, and nothing is removed", async () => {
  for (const q of ["?code=abc", "?code=abc&provider_type=google", "?provider_type=x&flow_id=f", "?flow_id=f"]) {
    const b = browser();
    const tb = openTab(b, { href: `${ORIGIN}/${q}#/home` });
    await tb.s.boot();
    assert.equal(tb.loads, 0, q);
    assert.equal(tb.href, `${ORIGIN}/${q}#/home`, q);
  }
});

test("a failed return does not hide a session this browser still has, so the lock runs for it", async () => {
  const b = browser();
  b.cb.stored = { address: TW.x };
  b.storage.setItem(METHOD_KEY, "x");
  const tb = openTab(b, { href: `${ORIGIN}/?error=access_denied#/home` });
  await tb.s.boot();
  assert.equal(tb.state.trading?.address, TW.x);
  assert.equal(tb.events.filter(([t]) => t === "error").length, 1);
  await advance(b, IDLE_MS);
  assert.equal(tb.state.trading, null);
});

test("one login at a time, only the three ways, and none while logged in", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  await assert.rejects(tb.s.login(/** @type {any} */ ("github")), /Google, X or a wallet/);
  assert.equal(tb.acks, 0);
  assert.equal(tb.loads, 0);
  await tb.s.login("google");
  assert.equal(tb.state.login.phase, "redirecting");
  assert.equal(await tb.s.login("x"), null, "Google is under way");
  assert.deepEqual(tb.f.logins, ["google"]);
  assert.equal(tb.acks, 1);
  const c = openTab(b);
  await c.s.boot();
  await c.s.login("wallet", { uuid: "mm" });
  const acks = c.acks;
  assert.equal(await c.s.login("x"), TW.wallet, "already logged in: the address, and nothing asked");
  assert.equal(c.acks, acks);
  assert.ok(!c.f.calls.includes("startLogin"));
});

test("a login that could not start can be tried again", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  tb.f.initFails = true;
  await assert.rejects(tb.s.login("google"), /Could not reach Coinbase/);
  assert.equal(tb.state.login.phase, "idle");
  tb.f.initFails = false;
  tb.f.startFails = true;
  await assert.rejects(tb.s.login("google"), /Could not open Google/);
  assert.equal(tb.state.login.phase, "idle");
  assert.equal(tb.loads, 2, "the SDK is started again after a failed start");
  tb.f.startFails = false;
  await tb.s.login("google");
  assert.deepEqual(tb.f.logins, ["google"]);
  assert.equal(tb.loads, 2, "and not again once it started");
});

test("booting twice starts one clock and one channel", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  await tb.s.boot();
  assert.equal(b.clock.ticks.size, 1);
  assert.equal(b.chans.size, 1);
});

test("the SDK's token refresh, naming the same wallet, changes nothing; naming another, the page shows that one", async () => {
  const { b, a } = await twoTabs();
  const changes = a.changes;
  a.f.refreshed();
  await settleAll();
  assert.equal(a.state.trading?.address, TW.wallet);
  assert.equal(outs(b).length, 0, "a refresh is not a logout");
  assert.equal(a.changes, changes, "nothing to repaint");
  a.f.refreshed(TW.x);
  await settleAll();
  assert.equal(a.state.trading.address, TW.x);
  assert.equal(a.state.trading.method, "wallet", "the way in is the same");
});

// ------------------------------------------------------------ reloads --

test("a reload takes up a remembered session, and its clock runs from the last input, not the load", async () => {
  const b = browser();
  b.cb.stored = { address: TW.google };
  b.storage.setItem(METHOD_KEY, "google");
  b.storage.setItem(ACTIVE_KEY, String(T0 - 10 * MIN));
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.loads, 1);
  assert.equal(tb.state.trading.address, TW.google);
  assert.equal(tb.state.trading.method, "google");
  assert.equal(b.storage.getItem(ACTIVE_KEY), String(T0 - 10 * MIN), "loading is not input");
  await advance(b, 19 * MIN - 1_000);
  assert.equal(tb.state.login.countdown, null);
  await advance(b, 1_000);
  assert.equal(tb.state.login.countdown, 60, "29 minutes after the last input, not after the load");
});

test("without a mark or a returning login, a reload loads nothing, even if Coinbase still has a session", async () => {
  const b = browser();
  b.cb.stored = { address: TW.google };
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.loads, 0);
  assert.equal(tb.state.trading, null);
});

test("a mark 30 minutes old logs out at load: the SDK loads only to sign out", async () => {
  for (const mark of [String(T0 - IDLE_MS), String(T0 - 3 * IDLE_MS), "garbage", ""]) {
    const b = browser();
    b.cb.stored = { address: TW.google };
    b.storage.setItem(METHOD_KEY, "google");
    b.storage.setItem(ACTIVE_KEY, mark);
    const tb = openTab(b);
    await tb.s.boot();
    assert.equal(tb.loads, 1, mark);
    assert.equal(tb.state.trading, null, mark);
    assert.equal(tb.f.signedOut, 1, `${mark}: signed out of Coinbase, not just hidden`);
    assert.equal(b.cb.stored, null, mark);
    assert.equal(b.storage.getItem(ACTIVE_KEY), null, mark);
    assert.equal(b.storage.getItem(METHOD_KEY), "google", "the method stays for the sheet's reminder");
    assert.deepEqual(outEvents(tb), [{ reason: "idle", elsewhere: false }], mark);
    assert.deepEqual(outs(b), [{ type: "out", reason: "idle" }], mark);
  }
  // One millisecond younger is still a session.
  const b = browser();
  b.cb.stored = { address: TW.google };
  b.storage.setItem(ACTIVE_KEY, String(T0 - IDLE_MS + 1));
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.state.trading.address, TW.google);
});

test("a mark from the future is not believed: the page signs out at load", async () => {
  const b = browser();
  b.cb.stored = { address: TW.google };
  b.storage.setItem(ACTIVE_KEY, String(T0 + 24 * 60 * MIN));
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.state.trading, null);
  assert.equal(tb.f.signedOut, 1);
  // A little ahead, as another tab's clock a moment on, counts as now.
  const b2 = browser();
  b2.cb.stored = { address: TW.google };
  b2.storage.setItem(ACTIVE_KEY, String(T0 + SKEW_MS));
  const ok = openTab(b2);
  await ok.s.boot();
  assert.equal(ok.state.trading?.address, TW.google);
  await advance(b2, IDLE_MS);
  assert.equal(ok.state.trading, null, "and its clock ran from now, not from the future");
});

test("while logged in, a mark or a message from the future cannot hold the lock off", async () => {
  const { b, a, c } = await twoTabs();
  b.storage.setItem(ACTIVE_KEY, String(T0 + 24 * 60 * MIN));
  b.open().postMessage({ type: "active", at: T0 + 24 * 60 * MIN });
  await advance(b, IDLE_MS);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
});

test("a remembered method this page never wrote is not believed, and a session without one writes none", async () => {
  const b = browser();
  b.cb.stored = { address: TW.google };
  b.storage.setItem(ACTIVE_KEY, String(T0 - MIN));
  b.storage.setItem(METHOD_KEY, "evil");
  const before = b.storage.writes.length;
  const tb = openTab(b);
  assert.equal(tb.s.lastMethod(), null);
  await tb.s.boot();
  assert.equal(tb.state.trading.address, TW.google);
  assert.equal(tb.state.trading.method, null);
  assert.ok(!b.storage.writes.slice(before).some(([k]) => k === METHOD_KEY));
});

test("a remembered session whose SDK cannot load says so, and keeps the mark for the next load", async () => {
  const b = browser();
  b.storage.setItem(ACTIVE_KEY, String(T0 - MIN));
  const tb = openTab(b);
  tb.f.initFails = true;
  await tb.s.boot();
  assert.equal(tb.state.trading, null);
  const errors = tb.events.filter(([t]) => t === "error").map(([, m]) => m);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not load the trading wallet/);
  assert.equal(b.storage.getItem(ACTIVE_KEY), String(T0 - MIN));
});

test("a mark with no session behind it stays until it ages out, and then the next load clears it", async () => {
  const b = browser();
  b.storage.setItem(ACTIVE_KEY, String(T0 - MIN));
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.state.trading, null);
  assert.equal(b.storage.getItem(ACTIVE_KEY), String(T0 - MIN), "a live session in another tab may own it");
  await advance(b, 5 * MIN);
  tb.input();
  await advance(b, SHARE_MS);
  assert.equal(b.storage.getItem(ACTIVE_KEY), String(T0 - MIN), "a logged-out tab never renews it");
  await advance(b, IDLE_MS - WARN_MS + 30_000);
  assert.equal(tb.state.login.countdown, null, "and shows no countdown");
  b.clock.t = T0 - MIN + IDLE_MS;
  const later = openTab(b);
  await later.s.boot();
  assert.equal(b.storage.getItem(ACTIVE_KEY), null);
});

// ------------------------------------------------------------ logouts --

test("logging out clears the page and the mark first, tells the other tabs, then signs this tab's SDK out", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  await tb.s.login("wallet", { uuid: "mm" });
  b.storage.setItem(SENDS_KEY, JSON.stringify([T0]));
  const provider = tb.s.provider();
  assert.ok(provider);
  let release;
  tb.f.hangLogout = new Promise((r) => { release = r; });
  const leaving = tb.s.logout();
  // Before Coinbase has answered, nothing shows the session.
  assert.equal(tb.state.trading, null);
  assert.equal(tb.state.login.phase, "leaving");
  assert.equal(tb.s.provider(), null);
  assert.equal(b.storage.getItem(ACTIVE_KEY), null);
  assert.deepEqual(outs(b), [{ type: "out", reason: "user" }]);
  release();
  await leaving;
  assert.equal(tb.state.login.phase, "idle");
  assert.equal(tb.f.signedOut, 1);
  assert.equal(b.cb.stored, null, "the stored session is gone: a reload restores nothing");
  assert.equal(b.storage.getItem(METHOD_KEY), "wallet", "the method stays");
  assert.equal(b.storage.getItem(SENDS_KEY), JSON.stringify([T0]), "the rate guard is not reset by logging out");
  assert.deepEqual(outEvents(tb), [{ reason: "user", elsewhere: false }]);
  // The old provider cannot trade either: W1.1's provider asks the facade.
  assert.deepEqual(await provider.request({ method: "eth_accounts" }), []);
  // And a reload restores nothing.
  const again = openTab(b);
  await again.s.boot();
  assert.equal(again.loads, 0);
  assert.equal(again.state.trading, null);
});

test("logging out in one tab clears the other, and each tab signs out its own SDK", async () => {
  const { b, a, c } = await twoTabs();
  await a.s.logout();
  await settleAll();
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
  assert.equal(c.s.provider(), null);
  assert.equal(a.f.signedOut, 1);
  assert.equal(c.f.signedOut, 1, "the other tab's SDK held the session in its own memory, and let it go");
  assert.deepEqual(outs(b), [{ type: "out", reason: "user" }], "told once, and not echoed");
  assert.deepEqual(outEvents(c), [{ reason: "user", elsewhere: true }]);
});

test("the SDK ending a session in one tab signs out every tab", async () => {
  const { b, a, c } = await twoTabs();
  a.f.end();
  await settleAll();
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
  assert.equal(c.f.signedOut, 1);
  assert.deepEqual(outs(b), [{ type: "out", reason: "ended" }]);
  assert.deepEqual(outEvents(a), [{ reason: "ended", elsewhere: false }]);
});

test("a tab that missed the logout message signs out when it finds the mark gone", async () => {
  const { b, a, c } = await twoTabs();
  b.drop = true;
  await a.s.logout();
  assert.equal(c.state.trading?.address, TW.wallet, "the message was lost");
  await advance(b, 1_000);
  assert.equal(c.state.trading, null);
  assert.equal(c.f.signedOut, 1);
  assert.deepEqual(outEvents(c), [{ reason: "ended", elsewhere: true }]);
  assert.equal(outs(b).length, 1, "and it tells no one: the tab that logged out did");
});

test("garbage on the channel changes nothing, and the lock still fires after it", async () => {
  const { b, a, c } = await twoTabs();
  const raw = b.open();
  for (const m of [null, 42, "out", {}, { type: "active" }, { type: "active", at: "soon" }, { type: "active", at: null }, { type: "nonsense" }]) {
    raw.postMessage(m);
  }
  await settleAll();
  assert.equal(a.state.trading?.address, TW.wallet);
  assert.equal(c.state.trading?.address, TW.wallet);
  await advance(b, IDLE_MS);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
});

test("a logout message with no reason reads as ended", async () => {
  const { b, a } = await twoTabs();
  b.open().postMessage({ type: "out", reason: 7 });
  await settleAll();
  assert.equal(a.state.trading, null);
  assert.deepEqual(outEvents(a), [{ reason: "ended", elsewhere: true }]);
});

test("an older input time, from the mark or another tab, does not wind the clock back", async () => {
  const { b, a } = await twoTabs();
  await advance(b, 10 * MIN);
  a.input();
  b.storage.setItem(ACTIVE_KEY, String(T0));
  b.open().postMessage({ type: "active", at: T0 });
  await advance(b, 25 * MIN);
  assert.equal(a.state.trading?.address, TW.wallet, "30 minutes from the old time have passed, but not from the input");
  assert.equal(a.state.login.countdown, null);
});

test("Stay logged in, in a lone tab, keeps it logged in", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  await tb.s.login("wallet", { uuid: "mm" });
  await advance(b, IDLE_MS - 30_000);
  assert.equal(tb.state.login.countdown, 30);
  tb.s.stay();
  assert.equal(tb.state.login.countdown, null);
  await advance(b, IDLE_MS - 1_000);
  assert.equal(tb.state.trading?.address, TW.wallet);
  await advance(b, 1_000);
  assert.equal(tb.state.trading, null);
});

test("a tab that takes up another's login without storage starts its clock now, not at zero", async () => {
  const blocked = () => { throw new Error("blocked"); };
  const b = browser();
  const c = openTab(b, { storage: blocked });
  await c.s.boot();
  await advance(b, 10_000);
  // Another tab logged in, and its input never reached this one.
  b.cb.stored = { address: TW.wallet };
  b.open().postMessage({ type: "in" });
  await settleAll();
  assert.equal(c.state.trading?.address, TW.wallet);
  await advance(b, MIN);
  assert.equal(c.state.trading?.address, TW.wallet, "not locked at once");
  await advance(b, IDLE_MS - MIN);
  assert.equal(c.state.trading, null, "but 30 minutes on");
});

test("without storage, garbage on the channel cannot stop the lock either", async () => {
  const blocked = () => { throw new Error("blocked"); };
  const b = browser();
  const a = openTab(b, { storage: blocked }), c = openTab(b, { storage: blocked });
  await a.s.boot();
  await c.s.boot();
  await a.s.login("wallet", { uuid: "mm" });
  await settleAll();
  assert.equal(c.state.trading?.address, TW.wallet);
  b.open().postMessage({ type: "active", at: "soon" });
  await advance(b, IDLE_MS);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
});

test("a tab frozen through the lock, whose message was lost, signs out when it wakes, as idle", async () => {
  const { b, a, c } = await twoTabs();
  b.drop = true;
  const [, cTick] = [...b.clock.ticks];
  b.clock.ticks.delete(cTick);
  await advance(b, IDLE_MS);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading?.address, TW.wallet, "frozen, it heard nothing");
  b.clock.ticks.add(cTick);
  await advance(b, 1_000);
  assert.equal(c.state.trading, null);
  assert.deepEqual(outEvents(c), [{ reason: "idle", elsewhere: true }]);
  assert.equal(c.f.signedOut, 1);
});

test("without the channel, input still reaches every tab through the mark", async () => {
  const { b, a, c } = await twoTabs();
  b.drop = true;
  await advance(b, 20 * MIN);
  c.input();
  await advance(b, 20 * MIN);
  assert.equal(a.state.trading?.address, TW.wallet, "c's input reached a through the mark");
  await advance(b, 10 * MIN);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
});

test("a login is taken up by a tab that has not loaded the SDK, and not by one that has", async () => {
  const b = browser();
  // A tab that loaded the SDK and found no session: its SDK will not look again.
  b.storage.setItem(ACTIVE_KEY, String(T0 - MIN));
  const loaded = openTab(b);
  await loaded.s.boot();
  assert.equal(loaded.loads, 1);
  b.storage.removeItem(ACTIVE_KEY);
  const fresh = openTab(b);
  await fresh.s.boot();
  assert.equal(fresh.loads, 0);
  const a = openTab(b);
  await a.s.boot();
  await a.s.login("wallet", { uuid: "mm" });
  await settleAll();
  assert.equal(fresh.state.trading?.address, TW.wallet);
  assert.equal(fresh.loads, 1);
  assert.equal(loaded.state.trading, null, "it shows Log in until it reloads or logs in");
  assert.equal(loaded.loads, 1);
  assert.equal(loaded.f.calls.filter((x) => x === "completeLogin").length, 1, "and does not ask its SDK again");
  // A tab already logged in is not asked either, when another logs in.
  b.open().postMessage({ type: "in" });
  await settleAll();
  assert.equal(a.f.calls.filter((x) => x === "completeLogin").length, 0);
  assert.equal(fresh.f.calls.filter((x) => x === "completeLogin").length, 1);
});

// ------------------------------------------------------- the idle lock --

test("the idle lock: a countdown at 29 minutes in every tab, then one logout for all of them", async () => {
  assert.equal(IDLE_MS, 30 * MIN);
  assert.equal(WARN_MS, MIN);
  const { b, a, c } = await twoTabs();
  await advance(b, IDLE_MS - WARN_MS - 1_000);
  assert.equal(a.state.login.countdown, null);
  assert.equal(c.state.login.countdown, null);
  await advance(b, 1_000);
  assert.equal(a.state.login.countdown, 60);
  assert.equal(c.state.login.countdown, 60);
  // A tick between seconds rounds up: 59.5 s left still reads 1:00.
  b.clock.t += 500;
  for (const fn of [...b.clock.ticks]) fn();
  assert.equal(a.state.login.countdown, 60);
  await advance(b, 59_000);
  assert.equal(a.state.login.countdown, 1);
  assert.equal(a.state.trading?.address, TW.wallet, "not yet");
  await advance(b, 1_000);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
  assert.deepEqual(outs(b), [{ type: "out", reason: "idle" }], "decided once");
  assert.equal(a.f.signedOut + c.f.signedOut, 2, "and each tab's SDK signed out once");
  assert.equal(a.f.signedOut, 1);
  assert.equal(b.cb.stored, null);
  assert.equal(b.storage.getItem(ACTIVE_KEY), null);
  for (const tb of [a, c]) {
    assert.deepEqual(outEvents(tb).map((o) => o.reason), ["idle"]);
    assert.equal(tb.state.login.countdown, null);
  }
});

test("input in either tab resets both, and Stay logged in hides the countdown everywhere", async () => {
  const { b, a, c } = await twoTabs();
  await advance(b, 20 * MIN);
  c.input();
  await advance(b, 20 * MIN);
  assert.equal(a.state.trading?.address, TW.wallet, "the other tab's input counted here");
  assert.equal(a.state.login.countdown, null);
  await advance(b, 9 * MIN);
  assert.equal(a.state.login.countdown, 60);
  assert.equal(c.state.login.countdown, 60);
  a.s.stay();
  await settleAll();
  assert.equal(a.state.login.countdown, null);
  assert.equal(c.state.login.countdown, null);
  await advance(b, IDLE_MS - 1_000);
  assert.equal(c.state.trading?.address, TW.wallet);
  await advance(b, 1_000);
  assert.equal(c.state.trading, null);
  assert.equal(a.state.trading, null);
  assert.equal(outs(b).length, 1);
});

test("the mark is written at most every 5 s, nothing is posted without input, and input with no countdown repaints nothing", async () => {
  const { b, a } = await twoTabs();
  const marks = () => b.storage.writes.filter(([k]) => k === ACTIVE_KEY).length;
  const actives = () => b.posts.filter((m) => m.type === "active").length;
  await advance(b, 10_000);
  const [m0, p0] = [marks(), actives()];
  await advance(b, 5 * MIN);
  assert.equal(marks(), m0, "no input, no writes");
  assert.equal(actives(), p0, "and no posts");
  const changes = a.changes;
  for (let i = 0; i < 50; i++) { a.input(); b.clock.t += 100; }
  assert.equal(a.changes, changes, "no countdown to hide, so nothing repaints");
  await advance(b, MIN);
  assert.ok(marks() - m0 >= 1 && marks() - m0 <= 2, `written ${marks() - m0} times for 5 s of input`);
});

test("input is shared at most every 5 s, and the last of it is never lost", async () => {
  const { b, a, c } = await twoTabs();
  await advance(b, 10_000);
  const actives = () => b.posts.filter((m) => m.type === "active");
  const before = actives().length;
  for (let i = 0; i < 20; i++) { a.input(); b.clock.t += 100; }
  assert.equal(actives().length - before, 1, "the first input goes at once");
  const last = b.clock.t - 100;
  await advance(b, SHARE_MS);
  assert.equal(actives().length - before, 2, "and the newest follows");
  assert.equal(actives().at(-1).at, last);
  const mark = Number(b.storage.getItem(ACTIVE_KEY));
  assert.ok(last - mark < SHARE_MS && mark <= last, `the mark follows it, within ${SHARE_MS} ms: ${last - mark}`);
  // The other tab's clock moved with it.
  await advance(b, IDLE_MS - WARN_MS - SHARE_MS - 2_000);
  assert.equal(c.state.login.countdown, null);
});

test("the lock waits for a trade running in another tab, then logs out", async () => {
  const { b, a, c } = await twoTabs();
  c.s.tradeRunning(true);
  await settleAll();
  assert.deepEqual(b.locks.held(TRADE_LOCK), ["shared"]);
  await advance(b, IDLE_MS + 5_000);
  assert.equal(a.state.trading?.address, TW.wallet, "it waits");
  assert.equal(a.state.login.waiting, true);
  assert.equal(c.state.login.waiting, true);
  assert.equal(outs(b).length, 0);
  assert.equal(b.locks.asked(TRADE_LOCK, "exclusive"), 2, "one request a tab, however long it waits");
  c.s.tradeRunning(false);
  await settleAll();
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
  assert.deepEqual(outs(b), [{ type: "out", reason: "idle" }]);
  assert.equal(a.state.login.waiting, false);
});

test("the lock waits for this tab's own trade", async () => {
  const { b, a, c } = await twoTabs();
  a.s.tradeRunning(true);
  a.s.tradeRunning(true); // a second report holds nothing more
  await advance(b, IDLE_MS + 3_000);
  assert.equal(a.state.trading?.address, TW.wallet);
  assert.equal(a.state.login.waiting, true);
  a.s.tradeRunning(false);
  await settleAll();
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
  assert.deepEqual(b.locks.held(TRADE_LOCK), []);
});

test("input while the lock waits for a trade cancels it", async () => {
  const { b, a, c } = await twoTabs();
  c.s.tradeRunning(true);
  await advance(b, IDLE_MS + 2_000);
  assert.equal(a.state.login.waiting, true);
  c.input();
  await settleAll();
  assert.equal(a.state.login.waiting, false);
  assert.equal(c.state.login.waiting, false);
  c.s.tradeRunning(false);
  await settleAll();
  assert.equal(a.state.trading?.address, TW.wallet, "still logged in");
  assert.equal(c.state.trading?.address, TW.wallet);
  assert.equal(outs(b).length, 0);
  // And the lock is not spent: 30 more idle minutes still log out.
  await advance(b, IDLE_MS);
  assert.equal(a.state.trading, null);
  assert.equal(c.state.trading, null);
});

test("each trade in flight holds the lock, one after another; an origin with no trading wallet holds nothing", async () => {
  const { b, a } = await twoTabs();
  a.s.tradeRunning(true);
  a.s.tradeRunning(false);
  await settleAll();
  assert.deepEqual(b.locks.held(TRADE_LOCK), []);
  a.s.tradeRunning(true);
  await settleAll();
  assert.deepEqual(b.locks.held(TRADE_LOCK), ["shared"], "the second trade holds it too");
  a.s.tradeRunning(false);
  await settleAll();
  const none = openTab(b, { here: "map", href: "https://clank.example/" });
  await none.s.boot();
  const asked = b.locks.asked(TRADE_LOCK, "shared");
  none.s.tradeRunning(true);
  assert.equal(b.locks.asked(TRADE_LOCK, "shared"), asked, "F2's trades take no lock");
});

test("a browser without Web Locks: the lock waits for this tab's trade, and still fires", async () => {
  const b = browser();
  const tb = openTab(b, { locks: null });
  await tb.s.boot();
  await tb.s.login("wallet", { uuid: "mm" });
  tb.s.tradeRunning(true);
  await advance(b, IDLE_MS + 2_000);
  assert.equal(tb.state.trading?.address, TW.wallet);
  assert.equal(tb.state.login.waiting, true);
  tb.s.tradeRunning(false);
  await advance(b, 1_000);
  assert.equal(tb.state.trading, null);
  assert.equal(tb.f.signedOut, 1);
});

test("without storage, a session works in its tab, and the lock still fires", async () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const readOnly = { getItem: () => null, setItem() { throw new Error("QuotaExceededError"); }, removeItem() {} };
  for (const [why, storage] of [["no storage", () => { throw new Error("no storage"); }], ["blocked", () => blocked], ["writes refused", () => readOnly]]) {
    const b = browser();
    const tb = openTab(b, { storage });
    await tb.s.boot();
    await tb.s.login("wallet", { uuid: "mm" });
    await advance(b, 10 * MIN);
    assert.equal(tb.state.trading?.address, TW.wallet, `${why}: a missing mark is not a logout elsewhere`);
    await advance(b, IDLE_MS - 10 * MIN);
    assert.equal(tb.state.trading, null, why);
    assert.equal(tb.f.signedOut, 1, why);
    assert.deepEqual(outs(b), [{ type: "out", reason: "idle" }], `${why}: and the other tabs are told`);
  }
});

// ------------------------------------------------------------ storage --

test("no address, email or handle is written to storage: only the method and the time of the last input", async () => {
  const b = browser();
  b.cb.pending = "flow-1";
  const back = openTab(b, { href: `${ORIGIN}/?code=c0de&provider_type=google&flow_id=flow-1` });
  await back.s.boot();
  await back.s.logout();
  const tb = openTab(b);
  await tb.s.boot();
  await tb.s.login("wallet", { uuid: "mm" });
  tb.input();
  await advance(b, IDLE_MS + 2_000);
  assert.equal(tb.state.trading, null);
  assert.ok(b.storage.writes.length >= 4);
  for (const [k, v] of b.storage.writes) {
    assert.ok([METHOD_KEY, ACTIVE_KEY].includes(k), k);
    assert.match(v, /^(google|x|wallet|\d+)$/, `${k}=${v}`);
    assert.doesNotMatch(v, /0x|@/i);
  }
});

// ------------------------------------------------ the page's own state --

test("a balance that lands after logout, or for another address, is dropped", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  await tb.s.login("wallet", { uuid: "mm" });
  await settleAll();
  let release;
  b.holdBalance = new Promise((r) => { release = r; });
  b.balances.set(TW.wallet.toLowerCase(), 7n);
  const late = tb.s.refreshBalance();
  await tb.s.logout();
  release();
  await late;
  assert.equal(tb.state.trading, null, "the page never shows a wallet whose session has ended");
});

test("a balance for a wallet no longer shown, or below zero, is dropped", async () => {
  const { b, a } = await twoTabs();
  let release;
  b.holdBalance = new Promise((r) => { release = r; });
  b.balances.set(TW.wallet.toLowerCase(), 7n);
  const late = a.s.refreshBalance();
  b.holdBalance = null;
  a.f.refreshed(TW.x);
  await settleAll();
  release();
  await late;
  assert.equal(a.state.trading.address, TW.x);
  assert.equal(a.state.trading.balanceWei, 0n, "the new wallet's own balance, not the old one's 7 wei");
  globalThis.fetch = async (_url, init) => ({
    ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: -5 }),
  });
  a.state.trading = { ...a.state.trading, balanceWei: null };
  await a.s.refreshBalance();
  assert.equal(a.state.trading.balanceWei, null);
});

test("the session's provider is W1.1's, only while logged in, and it reads from the public RPC", async () => {
  const b = browser();
  const tb = openTab(b);
  await tb.s.boot();
  assert.equal(tb.s.provider(), null);
  await tb.s.refreshBalance();
  assert.equal(b.rpcCalls.length, 0, "logged out, there is no balance to read");
  await tb.s.login("wallet", { uuid: "mm" });
  const p = tb.s.provider();
  assert.deepEqual(await p.request({ method: "eth_accounts" }), [TW.wallet]);
  assert.equal(await p.request({ method: "eth_chainId" }), "0x1237", "answered by the provider itself: it signs only for 4663");
  await p.request({ method: "eth_call", params: [{ to: TW.wallet, data: "0x" }, "latest"] });
  assert.ok(b.rpcCalls.length > 0 && b.rpcCalls.every((c) => c.url === FAST_RPC || c.url === PUBLIC_RPC));
  const e = await p.request({ method: "personal_sign", params: [] }).then(() => null, (x) => x);
  assert.equal(e.code, 4200, "the trading wallet signs no messages for the page");
});

// ------------------------------------------------------------- the chrome --

const JS = (rel) => fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url));

test("a self page never reads the map or starts the session: main.js calls them on a hosted page only", () => {
  const file = JS("main.js");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (n, guards) => {
    if (ts.isIfStatement(n)) {
      const cond = n.expression.getText(sf);
      visit(n.expression, guards);
      visit(n.thenStatement, [...guards, cond]);
      if (n.elseStatement) visit(n.elseStatement, [...guards, `!(${cond})`]);
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (["session.detect", "startTradingWallet", "startWallet"].includes(callee)) calls.push({ callee, guards });
    }
    ts.forEachChild(n, (c) => visit(c, guards));
  };
  visit(sf, []);
  assert.deepEqual(calls.map((c) => c.callee).sort(), ["session.detect", "session.detect", "startTradingWallet", "startWallet"]);
  for (const c of calls) {
    assert.ok(c.guards.some((g) => /mode === "hosted"/.test(g) && !g.startsWith("!")), `${c.callee} runs only under a hosted guard: ${c.guards.join(" / ")}`);
  }
});

test("the new chrome is hosted only, and hidden until the page shows it", () => {
  const page = readFileSync(fileURLToPath(new URL("../public/app.html", import.meta.url)), "utf8");
  for (const id of ["tw", "twlock"]) {
    // The trading wallet's chip is the top bar's wallet button since U1: a button.
    const tag = page.match(new RegExp(`<(?:div|button)[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, id);
    assert.match(tag[0], /data-hosted-only/, id);
    assert.match(tag[0], /\shidden[\s>]/, id);
  }
  const css = readFileSync(fileURLToPath(new URL("../public/app.css", import.meta.url)), "utf8");
  assert.match(css, /\.whoami\[hidden\]\{display:none\}/);
});

test("the chip and the lock's banner, in every state", async () => {
  const dom = stubDom();
  const { renderShell } = await import("../public/js/pages/shell.js");
  const saved = { mode: S.mode, login: S.login, trading: S.trading, conn: S.conn };
  const show = (login, trading) => {
    dom.reset();
    S.mode = "hosted";
    S.conn = null;
    S.login = { here: true, phase: "idle", countdown: null, waiting: false, ...login };
    S.trading = trading;
    renderShell();
    return {
      hidden: dom.el("#tw").hidden, name: dom.el("#twname").textContent, addr: dom.el("#twaddr").textContent,
      lk: dom.el("#twlk").textContent, title: dom.el("#tw").title,
      banner: dom.el("#twlock").hidden ? null : textOf(dom.el("#twlockmsg").markup),
    };
  };
  const tw = (over = {}) => ({ address: TW.google, method: "google", balanceWei: 10n ** 16n, ...over });
  try {
    assert.equal(show({ here: false }, null).hidden, true, "no trading wallet on this origin");
    assert.deepEqual(show({}, null), { hidden: false, name: "Log in", addr: "Trade in one click", lk: "", title: "Log in to trade", banner: null });
    assert.equal(show({ phase: "restoring" }, null).name, "Logging in…");
    assert.equal(show({ phase: "redirecting" }, null).name, "Leaving to log in…");
    assert.equal(show({ phase: "signing" }, null).name, "Sign in your wallet");
    assert.equal(show({ phase: "leaving" }, null).name, "Logging out…");
    assert.deepEqual(show({}, tw({ balanceWei: null })), {
      hidden: false, name: "…", addr: "0x0000…6006", lk: "", title: `Trading wallet · Google · ${TW.google}`, banner: null,
    });
    assert.equal(show({}, tw()).name, "0.0100 Ξ");
    assert.equal(show({ phase: "leaving" }, tw()).name, "Logging out…");
    assert.equal(show({}, tw({ balanceWei: 0n })).name, "0.0000 Ξ");
    assert.equal(show({}, tw({ method: "wallet" })).title, `Trading wallet · Wallet · ${TW.google}`);
    const counting = show({ countdown: 42 }, tw());
    assert.equal(counting.lk, "0:42");
    assert.equal(counting.banner, "Logging out in 0:42. No activity for 29 minutes.");
    assert.equal(show({ countdown: 60 }, tw()).banner, "Logging out in 1:00. No activity for 29 minutes.");
    assert.equal(show({ waiting: true }, tw()).banner, "Logging out after the trade in progress. No activity for 30 minutes.");
    assert.equal(show({ countdown: 42 }, null).banner, null, "no banner without a session");
    assert.equal(show({ here: false, countdown: 42 }, tw()).banner, null, "nor with no trading wallet here");
    // Where there is a trading wallet, the visitor's own wallet has no chip
    // (W2.2): the panel asks for it at Fund or Withdraw all. Connected or not.
    show({}, null);
    assert.equal(dom.el("#conn").hidden, true);
    assert.equal(dom.el("#connname").textContent, "", "nothing drawn into it");
    S.conn = { info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" }, address: TW.wallet, chainId: 4663, balanceWei: 0n };
    renderShell();
    assert.equal(dom.el("#conn").hidden, true, "a wallet login's wallet too");
    S.conn = null;
    // An origin with no trading wallet keeps it, as F2 built it.
    show({ here: false }, null);
    assert.equal(dom.el("#conn").hidden, false);
    assert.equal(dom.el("#conn").title, "Connect the wallet you trade from");
    assert.equal(dom.el("#connname").textContent, "Connect wallet");
    // The quick-buy note follows the trading wallet, not the visitor's own.
    show({}, null);
    assert.equal(dom.el("#qnote").textContent, "not logged in");
    show({}, tw({ balanceWei: null }));
    assert.equal(dom.el("#qnote").textContent, "…");
    show({}, tw({ balanceWei: 12n * 10n ** 15n }));
    assert.equal(dom.el("#qnote").textContent, "0.012 Ξ");
    // A self page draws none of it.
    dom.reset();
    S.mode = "self";
    S.login = { here: true, phase: "idle", countdown: 5, waiting: false };
    renderShell();
    assert.equal(dom.el("#twname").textContent, "", "untouched");
    assert.equal(dom.el("#twlock").hidden, undefined, "untouched");
  } finally {
    Object.assign(S, saved);
  }
});

test("the chip opens the login sheet when logged out, and its menu when logged in; nothing mid-login or with no trading wallet", async () => {
  stubDom();
  // Modals query their own buttons; each selector gets its own element here.
  const make = document.createElement;
  document.createElement = () => {
    const el = make();
    const found = new Map();
    el.querySelector = (sel) => { if (!found.has(sel)) found.set(sel, make()); return found.get(sel); };
    el.querySelectorAll = () => [];
    el.q = (sel) => el.querySelector(sel);
    return el;
  };
  const body = { appended: [], appendChild(el) { body.appended.push(el); return el; } };
  Object.assign(document, { body });
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const { twPanel } = await import("../public/js/pages/shell.js");
  const saved = { mode: S.mode, login: S.login, trading: S.trading };
  const open = (login, trading) => {
    body.appended.length = 0;
    S.mode = "hosted";
    S.login = { here: true, phase: "idle", countdown: null, waiting: false, ...login };
    S.trading = trading;
    twPanel();
    return body.appended[0] ?? null;
  };
  try {
    assert.equal(open({ here: false }, null), null);
    for (const phase of ["restoring", "redirecting", "signing", "leaving"]) assert.equal(open({ phase }, null), null, phase);

    const first = open({}, null).markup;
    // One sheet family (U7): a named dialog, its head with the ✕, the three ways in as option buttons.
    assert.match(first, /^<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="login-title" tabindex="-1">\s*<div class="sheethd"><h3 id="login-title">Log in to trade<\/h3><button class="sheetx"/);
    assert.match(first, /<button class="wpick more" type="button" data-pick-wallet>/);
    let sheet = textOf(first);
    for (const words of ["Log in to trade", "Continue with Google", "Continue with X", "Continue with a wallet",
      "Don't log in on a shared or public computer.", "Logging out here does not log you out of Google or X."]) {
      assert.ok(sheet.includes(words), words);
    }
    assert.doesNotMatch(sheet, /last logged in/, "no reminder before any login");
    store.set(METHOD_KEY, "x");
    const back = open({}, null);
    assert.match(textOf(back.markup), /This browser last logged in with X\. Each way of logging in has its own wallet\./);
    // "Continue with a wallet" shows F2's list: none found in this test.
    back.q("[data-pick-wallet]").onclick();
    sheet = textOf(back.markup);
    assert.match(sheet, /No browser wallet was found/);
    assert.doesNotMatch(sheet, /Continue with Google/);

    const menu = open({}, { address: TW.google, method: "google", balanceWei: 10n ** 16n });
    const words = textOf(menu.markup);
    assert.match(words, /Your trading wallet/);
    assert.match(words, /Login Google/);
    assert.ok(words.includes(TW.google));
    assert.match(words, /0\.0100 Ξ/);
    assert.match(words, /Log out/);
    assert.match(words, /After 30 minutes with no activity, this page logs you out\./);
    // "Back up key" (W4) closes the menu and opens the backup sheet, at any time.
    assert.match(words, /Back up key/);
    menu.q("[data-backup]").onclick();
    const backupSheet = body.appended[body.appended.length - 1];
    assert.notEqual(backupSheet, menu);
    assert.match(textOf(backupSheet.markup), /Back up your key|Export your key/);
    backupSheet.q("[data-x]").onclick();
  } finally {
    Object.assign(S, saved);
  }
});
