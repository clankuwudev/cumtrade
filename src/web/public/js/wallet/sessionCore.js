import { start as startEmbedded } from "./embedded.js";
import { projectFor } from "./projects.js";

// ====================================================================== //
// the trading wallet's login                                             //
// ====================================================================== //
//
// Logging in, logging out and the idle lock (public-release W1.2), over
// W1.1's provider and facade (wallet/embedded.js). It writes its page's
// `trading` and `login` (cumOS's `S`), and renders nothing: the chrome
// subscribes with `on`. It imports nothing of either page, so cumOS
// (wallet/session.js) and cumAI (ai/login.js, C5c) run the same session:
// the same marks, the same tabs' channel and the same lock.
//
// - Only an origin with a pinned Coinbase project has a trading wallet. On
//   any other, and on every self page, none of this runs and the page trades
//   from the visitor's own wallet (F2) as before.
// - The SDK loads only on a login, a return from Google or X, or a session
//   this browser remembers (TW10).
// - Every tab of this site shares one clock of input. After 30 minutes with
//   none, the page really signs out of Coinbase (TW7), in every tab, and it
//   waits for a trade that is running in any of them.
// - Storage holds the method used last and the time of the last input, never
//   an address, email or handle.

/** How long without input, in every tab of this site, before the page logs out (TW7). */
export const IDLE_MS = 30 * 60_000;
/** How long the countdown shows before that. */
export const WARN_MS = 60_000;
/** A tab tells the others about its input at most this often. */
export const SHARE_MS = 5_000;
/**
 * An input time this far ahead of this tab's clock still counts, as now.
 * Further ahead, it is not believed: a clock set back would otherwise keep
 * the lock from ever firing.
 */
export const SKEW_MS = 5_000;
const TICK_MS = 1_000;

/** The login method this browser used last. Kept after logout, for the sheet's reminder. */
export const METHOD_KEY = "clank.login";
/** The last input in any tab. Kept only while logged in: this browser's mark of a session. */
export const ACTIVE_KEY = "clank.active";
/** The tabs' channel: input, logins and logouts. */
export const CHANNEL = "clank.session";
/** Held shared by a tab while its trade is in flight. The idle lock takes it exclusively. */
export const TRADE_LOCK = "clank.trading";
export const METHODS = Object.freeze(["google", "x", "wallet"]);
/** What Google or X send back on the address bar. The SDK removes them (W1.1), and the page checks. */
export const OAUTH_PARAMS = Object.freeze(["code", "provider_type", "flow_id", "error", "error_description"]);
/** The input that counts as someone being there. Loading the page is not among it. */
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];

/**
 * @typedef {{ request: (args: { method: string, params?: unknown[] }) => Promise<any> }} Provider
 * @typedef {{
 *   startLogin: (p: "google" | "x") => Promise<void>,
 *   loginWithWallet: (p: Provider) => Promise<string>,
 *   completeLogin: () => Promise<string | null>,
 *   address: () => Promise<string | null>,
 *   logout: () => Promise<void>,
 *   onAuthChange: (cb: (address: string | null) => void) => () => void,
 *   mountExport: (element: any, address: string, onStatus?: (status: string, message?: string) => void) => Promise<() => void>,
 * }} Facade
 * @typedef {{
 *   postMessage: (m: any) => void, close?: () => void,
 *   onmessage: ((e: { data: any }) => void) | null,
 * }} Channel
 * @typedef {{ request: (name: string, options: object, fn: (lock?: any) => Promise<any> | any) => Promise<any> }} Locks
 */

/**
 * The trading wallet's session. Nothing happens until `detect()` and `boot()`,
 * so importing this touches no storage, timer, channel or network.
 *
 * The page passes its state, its acknowledgement and its own-wallet door;
 * every other dependency has a default, and tests pass their own.
 *
 * @param {{
 *   here?: boolean,
 *   start?: () => Promise<{ facade: Facade, provider: Provider }>,
 *   state: { trading: any, login: any },
 *   storage?: () => (Storage | null),
 *   channel?: () => (Channel | null),
 *   locks?: Locks | null,
 *   now?: () => number,
 *   every?: (fn: () => void, ms: number) => (() => void),
 *   watch?: (fn: () => void) => void,
 *   location?: () => ({ href: string, origin: string }),
 *   history?: () => ({ state: any, replaceState: (state: any, title: string, url: string) => void }),
 *   acknowledge: () => Promise<boolean>,
 *   main: { connect: (uuid: string) => Promise<string>, provider: () => (Provider | null) },
 *   idleMs?: number, warnMs?: number,
 * }} d
 */
export function createSession(d) {
  if (!d?.state || typeof d.acknowledge !== "function" || !d.main) {
    throw new Error("A session needs its page's state, acknowledgement and wallet.");
  }
  const state = d.state;
  const now = d.now ?? (() => Date.now());
  const idleMs = d.idleMs ?? IDLE_MS;
  const warnMs = d.warnMs ?? WARN_MS;
  const loc = d.location ?? (() => globalThis.location);
  const hist = d.history ?? (() => globalThis.history);
  const locks = () => ("locks" in d ? d.locks : globalThis.navigator?.locks ?? null);
  const acknowledge = d.acknowledge;
  const main = d.main;
  const startWallet = d.start ?? (() => startEmbedded());
  const every = d.every ?? ((fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); });
  const watch = d.watch ?? ((fn) => {
    for (const ev of INPUT_EVENTS) document.addEventListener(ev, fn, { capture: true, passive: true });
  });

  /** @type {Promise<{ facade: Facade, provider: Provider }> | null} */
  let started = null;
  /** @type {{ facade: Facade, provider: Provider } | null} */
  let wallet = null;
  /** @type {Channel | null} */
  let chan = null;
  let booted = false;
  let stopTick = null;
  /** The newest input known, in any tab. */
  let lastActive = 0;
  /** This tab's own newest input, and when it last told the others. */
  let ownInput = 0;
  let sharedAt = 0;
  /** The idle lock has asked for TRADE_LOCK and not finished. */
  let firing = false;
  /** Releases this tab's shared hold on TRADE_LOCK while a trade is in flight. */
  let hold = null;
  let inFlight = false;
  /**
   * This tab wrote the mark since it logged in. Only then does a missing mark
   * mean another tab logged out: storage that reads but will not write (a
   * full quota, some private windows) must not sign out every second.
   */
  let markWritten = false;
  const listeners = new Set();

  const emit = (type, detail) => { for (const fn of listeners) fn(type, detail); };
  const change = () => emit("change");
  const setLogin = (patch) => { state.login = { ...state.login, ...patch }; };
  const phase = (p) => { if (state.login.phase !== p) { setLogin({ phase: p }); change(); } };
  const lower = (a) => String(a).toLowerCase();

  // ----------------------------------------------------------- storage --

  const store = () => { try { return d.storage ? d.storage() : globalThis.localStorage ?? null; } catch { return null; } };
  const read = (k) => { const s = store(); if (!s) return null; try { return s.getItem(k); } catch { return null; } };
  const write = (k, v) => {
    const s = store();
    if (!s) return false;
    try { s.setItem(k, v); return true; } catch { return false; /* full or blocked: this tab still counts */ }
  };
  const remove = (k) => { const s = store(); if (s) try { s.removeItem(k); } catch { /* nothing to remove */ } };

  /** The mark's time, null when there is none, and 0 when it is garbage (so, old). */
  function mark() {
    const v = read(ACTIVE_KEY);
    if (v === null) return null;
    const at = Number(v);
    return Number.isFinite(at) ? at : 0;
  }

  /** The method this browser used last, or null. */
  function lastMethod() {
    const m = read(METHOD_KEY);
    return METHODS.includes(m) ? m : null;
  }

  /**
   * Take up an input time, from another tab or the mark, if it is newer than
   * the last one known. One a little ahead of this tab's clock counts as now;
   * one further ahead is not believed.
   */
  function seen(at) {
    const t = now();
    if (!Number.isFinite(at) || at > t + SKEW_MS || at <= lastActive) return false;
    lastActive = Math.min(at, t);
    return true;
  }

  // ----------------------------------------------------------- channel --

  function post(m) {
    if (!chan) return;
    try { chan.postMessage(m); } catch { /* a closed channel: this tab is going away */ }
  }

  function receive(e) {
    const m = e && e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "active") {
      if (seen(m.at)) settleCountdown();
    } else if (m.type === "out") {
      void signOut(typeof m.reason === "string" ? m.reason : "ended", { tell: false, elsewhere: true });
    } else if (m.type === "in") {
      // Another tab logged in. A tab that has not loaded the SDK yet takes the
      // session up when it loads it. One that has cannot: the SDK reads the
      // stored session only when it starts, and the facade cannot ask again.
      // (A logged-in tab has always started it.)
      if (!started) void restore(null);
    }
  }

  // ------------------------------------------------------------ starting --

  /** Load and start the SDK once. A failure can be tried again. */
  function ensure() {
    if (!started) {
      started = startWallet().then((w) => {
        wallet = w;
        w.facade.onAuthChange((address) => heard(address));
        return w;
      });
      started.catch(() => { started = null; });
    }
    return started;
  }

  /** The SDK says who is logged in, in this tab: at each token refresh, and when the session ends. */
  function heard(address) {
    if (address) {
      // Another address than the one shown: show the SDK's.
      if (state.trading && lower(state.trading.address) !== lower(address)) adopt(address, state.trading.method);
      return;
    }
    // The SDK ended the session in this tab: a failed refresh, or a logout.
    if (state.trading) void signOut("ended");
  }

  /** Show a logged-in trading wallet, remember how, and keep the mark from the last input. */
  function adopt(address, method) {
    state.trading = { address, method, balanceWei: null };
    if (method) write(METHOD_KEY, method);
    markWritten = write(ACTIVE_KEY, String(lastActive));
    change();
    void refreshBalance();
  }

  /**
   * Which origin this is: set `S.login.here` from the pinned map. Called only
   * on a hosted page, before its first render.
   */
  function detect() {
    const here = typeof d.here === "boolean" ? d.here : projectFor(loc()?.origin) !== null;
    setLogin({ here });
    return here;
  }

  /**
   * Start the session on a hosted page. On an origin with no trading wallet
   * this does nothing at all. Otherwise it listens for input and for the
   * other tabs, and loads the SDK only for a returning login or a remembered
   * session. A remembered session older than the idle limit is signed out.
   */
  async function boot() {
    if (booted) return;
    booted = true;
    if (!detect()) { change(); return; }
    try {
      chan = d.channel ? d.channel() : typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    } catch { chan = null; }
    if (chan) chan.onmessage = receive;
    stopTick = every(tick, TICK_MS);
    watch(input);
    const back = returning();
    const at = mark();
    if (back) {
      await restore(back);
    } else if (at !== null) {
      // Loading the page is not input: the clock runs from the last input in
      // any tab, including one closed since. A mark from the future is not
      // believed either.
      if (now() - at >= idleMs || at > now() + SKEW_MS) await expire();
      else await restore(null);
    }
    change();
  }

  /** A return from Google or X on the address bar: `{ provider }`, or null. */
  function returning() {
    let url;
    try { url = new URL(loc().href); } catch { return null; }
    const p = url.searchParams;
    const done = p.get("code") && p.get("provider_type") && p.get("flow_id");
    if (!done && !p.has("error") && !p.has("error_description")) return null;
    return { provider: p.get("provider_type") };
  }

  /** Remove whatever the SDK left of a return from Google or X, keeping the rest of the address. */
  function cleanAddressBar() {
    let url;
    try { url = new URL(loc().href); } catch { return; }
    let dirty = false;
    for (const k of OAUTH_PARAMS) if (url.searchParams.has(k)) { url.searchParams.delete(k); dirty = true; }
    if (!dirty) return;
    try { hist().replaceState(hist().state, "", url.toString()); } catch { /* nothing else to do */ }
  }

  /** Drop the `#/…` route, so that Google or X send the visitor back to the bare page. */
  function dropRoute() {
    let url;
    try { url = new URL(loc().href); } catch { return; }
    url.hash = "";
    try { hist().replaceState(hist().state, "", url.toString()); } catch { /* the return may land on a route */ }
  }

  /**
   * Take up the session the SDK has: after a return from Google or X, a
   * remembered session, or another tab's login.
   *
   * @param {{ provider: string | null } | null} back
   */
  async function restore(back) {
    phase("restoring");
    let address = null;
    let failed = null;
    let answered = false;
    try {
      const w = await ensure();
      try {
        address = await w.facade.completeLogin();
      } catch (e) {
        // A failed return can still leave a session this browser had: show
        // it, or the lock would not run for it.
        failed = e;
        address = await w.facade.address().catch(() => null);
      }
      answered = true;
    } catch (e) {
      failed = e;
    }
    cleanAddressBar();
    phase("idle");
    if (address) {
      if (back) {
        // Logging in is input.
        seen(now());
        adopt(address, METHODS.includes(back.provider) ? back.provider : lastMethod());
        post({ type: "in" });
      } else {
        // A remembered session, or another tab's: its clock runs from the
        // mark, or from now when there is none to believe (another tab's
        // login is input).
        if (!seen(mark())) seen(now());
        adopt(address, lastMethod());
      }
    }
    // With no session found, the mark stays: it ages out like any other, and
    // a live session in another tab keeps its own. Only a logout removes it.
    if (failed && back) emit("error", `The login did not complete. ${failed.message ?? failed}`);
    else if (failed && !answered) emit("error", `Could not load the trading wallet. ${failed.message ?? failed}`);
  }

  /** At load, a remembered session past the idle limit: sign it out of Coinbase too. */
  async function expire() {
    remove(ACTIVE_KEY);
    phase("leaving");
    try {
      const w = await ensure();
      await w.facade.logout();
    } catch { /* the refresh token went with the logout request, or there was none */ }
    phase("idle");
    post({ type: "out", reason: "idle" });
    emit("out", { reason: "idle", elsewhere: false });
  }

  // -------------------------------------------------------------- login --

  /**
   * Log in with Google, X or the visitor's own wallet. The acknowledgement
   * comes first, once per browser. Google and X leave the page, so this
   * resolves only if they could not. A wallet login connects that wallet
   * through F2, then it signs one message.
   *
   * @param {"google" | "x" | "wallet"} method
   * @param {{ uuid?: string }} [opts] the wallet to log in with
   * @returns {Promise<string | null>} the trading address, or null
   */
  async function login(method, opts = {}) {
    if (!state.login.here) throw new Error("There is no trading wallet on this site.");
    if (!METHODS.includes(method)) throw new Error("Log in with Google, X or a wallet.");
    if (state.trading) return state.trading.address;
    if (state.login.phase !== "idle") return null;
    if (method === "wallet" && !opts.uuid) throw new Error("Pick a wallet to log in with.");
    if (!(await acknowledge())) return null;
    input();

    if (method === "wallet") {
      phase("signing");
      try {
        // The SDK loads while the wallet asks to connect.
        const loading = ensure();
        loading.catch(() => {});
        await main.connect(opts.uuid);
        const w = await loading;
        // A session this tab had not heard of, from another tab: take it up.
        const already = await w.facade.address();
        const address = already ?? await w.facade.loginWithWallet(main.provider());
        phase("idle");
        adopt(address, already ? lastMethod() : "wallet");
        post({ type: "in" });
        return address;
      } finally {
        phase("idle");
      }
    }

    phase("redirecting");
    try {
      const w = await ensure();
      const already = await w.facade.address();
      if (already) {
        phase("idle");
        adopt(already, lastMethod());
        post({ type: "in" });
        return already;
      }
      dropRoute();
      await w.facade.startLogin(method);
      return null;
    } catch (e) {
      phase("idle");
      throw e;
    }
  }

  // ------------------------------------------------------------- logout --

  /**
   * Sign out: clear what the page shows and the mark first, so it never
   * shows a session that is ending, tell the other tabs, then sign this
   * tab's SDK out of Coinbase.
   *
   * @param {string} reason "user", "idle" or "ended"
   * @param {{ tell?: boolean, elsewhere?: boolean }} [o] `tell`: post it to the other tabs
   */
  async function signOut(reason, { tell = true, elsewhere = false } = {}) {
    const had = !!state.trading;
    state.trading = null;
    remove(ACTIVE_KEY);
    setLogin({ countdown: null, waiting: false });
    if (tell) post({ type: "out", reason });
    change();
    if (started) {
      phase("leaving");
      try {
        const w = await started;
        await w.facade.logout();
      } catch { /* the SDK clears its own state even when Coinbase cannot be reached */ }
      phase("idle");
    }
    if (had) emit("out", { reason, elsewhere });
  }

  /** The chip's Log out. */
  const logout = () => signOut("user");

  // -------------------------------------------------------- the idle lock --

  /** Input in this tab: the page's input listeners call this, on every event. */
  function input() {
    const t = now();
    ownInput = t;
    if (t > lastActive) { lastActive = t; settleCountdown(); }
    if (t - sharedAt >= SHARE_MS) share(t);
  }

  /** Tell the other tabs about this tab's newest input. */
  function share(t) {
    sharedAt = t;
    post({ type: "active", at: ownInput });
  }

  /** Keep the mark as new as the newest input this tab knows of, from any tab, at most every 5 s. */
  function syncMark() {
    if (lastActive - (mark() ?? 0) >= SHARE_MS) write(ACTIVE_KEY, String(lastActive));
  }

  /** There has been input: hide the countdown, and stop waiting to lock. Nothing repaints otherwise. */
  function settleCountdown() {
    if (state.login.countdown === null && !state.login.waiting) return;
    setLogin({ countdown: null, waiting: false });
    change();
  }

  /** Once a second: share input, show the countdown, and lock when it is due. */
  function tick() {
    const t = now();
    if (sharedAt < ownInput && t - sharedAt >= SHARE_MS) share(t);
    if (!state.trading) return;
    const at = mark();
    if (at !== null) seen(at);
    // Another tab logged out, and its message was missed (a frozen tab, say).
    if (markWritten && at === null) {
      void signOut(t - lastActive >= idleMs ? "idle" : "ended", { tell: false, elsewhere: true });
      return;
    }
    syncMark();
    const idle = t - lastActive;
    if (idle >= idleMs) { lock(); return; }
    const countdown = idle >= idleMs - warnMs ? Math.ceil((idleMs - idle) / 1000) : null;
    if (countdown !== state.login.countdown) { setLogin({ countdown }); change(); }
  }

  /**
   * The lock is due. It takes TRADE_LOCK exclusively, so it waits for every
   * trade in flight in every tab, then checks again: input meanwhile cancels
   * it. The first tab to get it that still finds the mark logs out and tells
   * the others; a tab after it finds the mark gone and signs out only its own
   * SDK.
   */
  function lock() {
    // Still asking a second on: it waits for a trade.
    if (firing) {
      if (!state.login.waiting) { setLogin({ waiting: true }); change(); }
      return;
    }
    const l = locks();
    if (!l || typeof l.request !== "function") {
      // No Web Locks: this tab's own trade is all it can see, and the
      // trading wallet signs nothing in such a browser anyway (W1.1).
      if (inFlight) { if (!state.login.waiting) { setLogin({ waiting: true }); change(); } return; }
      firing = true;
      void due().finally(() => { firing = false; });
      return;
    }
    firing = true;
    Promise.resolve(l.request(TRADE_LOCK, { mode: "exclusive" }, due))
      .catch(() => {})
      .finally(() => { firing = false; });
  }

  async function due() {
    if (!state.trading || now() - lastActive < idleMs) return;
    // The mark gone means another tab got here first and told everyone.
    if (markWritten && mark() === null) await signOut("idle", { tell: false, elsewhere: true });
    else await signOut("idle");
  }

  /**
   * Whether this tab's trade is in flight: preparing, running, signing or
   * pending. While it is, the tab holds TRADE_LOCK shared, and the lock waits.
   *
   * @param {boolean} on
   */
  function tradeRunning(on) {
    inFlight = !!on;
    if (!state.login.here) return;
    const l = locks();
    if (on && !hold && l && typeof l.request === "function") {
      let release;
      const held = new Promise((r) => { release = r; });
      hold = release;
      Promise.resolve(l.request(TRADE_LOCK, { mode: "shared" }, () => held)).catch(() => {});
    } else if (!on && hold) {
      hold();
      hold = null;
    }
  }

  // ----------------------------------------------------------- balance --

  /** Read the trading wallet's ETH balance through its own provider (the public RPC). A late answer for another address is dropped. */
  async function refreshBalance() {
    const t = state.trading;
    if (!t) return;
    const address = t.address;
    let wei;
    try {
      wei = BigInt(await wallet.provider.request({ method: "eth_getBalance", params: [address, "latest"] }));
    } catch { return; /* the next refresh will try again */ }
    const cur = state.trading;
    if (!cur || lower(cur.address) !== lower(address) || wei < 0n) return;
    state.trading = { ...cur, balanceWei: wei };
    change();
  }

  // ------------------------------------------------------------ backup --

  /**
   * Mount Coinbase's key-export button in `element` (W4), for the logged-in
   * trading wallet and no other: the page never passes an address, and the
   * facade refuses any but the logged-in one anyway. The key is copied from
   * Coinbase's frame and never reaches this page. Resolves to the function
   * that removes the frame.
   *
   * @param {any} element
   * @param {(status: string, message?: string) => void} onStatus
   */
  async function mountExport(element, onStatus) {
    const t = state.trading;
    if (!t || !wallet) throw new Error("Log in to back up your key.");
    return wallet.facade.mountExport(element, t.address, onStatus);
  }

  return {
    detect, boot, login, logout, refreshBalance, tradeRunning, lastMethod, mountExport,
    /** "Stay logged in": input, as any click is. */
    stay: input,
    input,
    /** The trading wallet's provider for the sequence, only while logged in. */
    provider: () => (state.trading && wallet ? wallet.provider : null),
    /** Its facade, only while logged in: cumAI signs its sign-in through it, and nothing else (C3, C5c). */
    facade: () => (state.trading && wallet ? wallet.facade : null),
    /** Hear "change", "out" ({ reason, elsewhere }), and "error" (a sentence). */
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** For tests: stop the timer and close the channel. */
    dispose() {
      if (stopTick) stopTick();
      if (chan && chan.close) chan.close();
      chan = null;
    },
  };
}
