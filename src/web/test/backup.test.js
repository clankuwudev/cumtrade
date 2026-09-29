// The required backup at setup (public-release W4).
//
// Three layers, as the page has them: the confirmations per address
// (wallet/backup.js), one sheet's flow with no DOM, and the sheet itself on a
// stub page (pages/backup.js), mounted through W1.2's real session over W1.1's
// real start() and a scripted facade. The facade's export frame stands in for
// Coinbase's: it holds a made-up key, puts it on its own clipboard when its
// button is pressed, and tells the page only its status words. Nothing leaves
// the process, and every address and key here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { keccak256 as viemKeccak } from "viem";
import { S } from "../public/js/core/store.js";
import { start } from "../public/js/wallet/embedded.js";
import { createSession } from "../public/js/wallet/session.js";
import { BACKUP_PREFIX, backup as pageBackup, backupKey, createBackup, createBackupFlow } from "../public/js/wallet/backup.js";
import { betaLine, domainLine } from "../public/js/wallet/words.js";
import { stubDom, textOf } from "./support/stubdom.js";

const A = "0x0000000000000000000000000000000000006006";
const B = "0x000000000000000000000000000000000000000A";
/** A made-up private key, held only by the scripted frame. */
const KEY = `0x${"5e".repeat(32)}`;
const ORIGIN = "https://staging.clank.example";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** localStorage, recording every write. `fail` makes a method throw. */
function memoryStorage() {
  const m = new Map();
  const s = {
    writes: [], fail: new Set(),
    getItem(k) { if (s.fail.has("get")) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (s.fail.has("set")) throw new Error("QuotaExceededError"); s.writes.push([k, String(v)]); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
  return s;
}

// ================================================== the confirmations --

test("blocked until confirmed, then confirmed for that address alone, in any case", () => {
  const storage = memoryStorage();
  const b = createBackup({ storage: () => storage });
  assert.equal(b.confirmed(A), false);
  b.confirm(A);
  assert.equal(b.confirmed(A), true);
  assert.equal(b.confirmed(A.toLowerCase()), true);
  assert.equal(b.confirmed(B), false, "kept per address: another login's wallet still asks");
  b.confirm(B.toLowerCase());
  assert.equal(b.confirmed(B), true);
});

test("storage holds a hash of the address, never the address, and a new page load finds it", () => {
  const storage = memoryStorage();
  createBackup({ storage: () => storage }).confirm(A);
  const want = BACKUP_PREFIX + viemKeccak(/** @type {`0x${string}`} */ (A.toLowerCase())).slice(2);
  assert.deepEqual(storage.writes, [[want, "1"]], "the key is keccak256 of the address's 20 bytes");
  assert.equal(backupKey(A), want);
  assert.equal(backupKey(A.toLowerCase()), want);
  for (const [k, v] of storage.writes) {
    assert.doesNotMatch(k + v, new RegExp(A.slice(2), "i"), "no address in storage");
  }
  const nextLoad = createBackup({ storage: () => storage });
  assert.equal(nextLoad.confirmed(A), true, "the next page load finds it");
  assert.equal(nextLoad.confirmed(B), false);
});

test("only the value 1 counts, and a key for another address never does", () => {
  const storage = memoryStorage();
  const b = createBackup({ storage: () => storage });
  for (const v of ["0", "true", "yes", "", " 1"]) {
    storage.setItem(backupKey(A), v);
    assert.equal(b.confirmed(A), false, JSON.stringify(v));
  }
  storage.setItem(backupKey(B), "1");
  assert.equal(b.confirmed(A), false);
  assert.equal(b.confirmed(B), true);
});

test("a storage failure never throws: this page load counts, and the next one asks again", () => {
  for (const how of ["missing", "throws", "get", "set"]) {
    const storage = memoryStorage();
    const reach = how === "missing" ? () => null : how === "throws" ? () => { throw new Error("SecurityError"); } : () => storage;
    if (how === "get" || how === "set") storage.fail.add(how);
    const b = createBackup({ storage: reach });
    assert.equal(b.confirmed(A), false, how);
    assert.doesNotThrow(() => b.confirm(A), how);
    assert.equal(b.confirmed(A), true, `${how}: this page load still counts it`);
    const nextLoad = createBackup({ storage: reach });
    assert.equal(nextLoad.confirmed(A), false, `${how}: the next page load asks again`);
  }
});

test("storage that reads but will not write: confirmed on this load, asked again on the next", () => {
  const storage = memoryStorage();
  storage.fail.add("set");
  const b = createBackup({ storage: () => storage });
  b.confirm(A);
  assert.equal(b.confirmed(A), true);
  storage.fail.delete("set");
  assert.equal(createBackup({ storage: () => storage }).confirmed(A), false);
});

test("anything but an address is never confirmed, and cannot be", () => {
  const b = createBackup({ storage: () => memoryStorage() });
  for (const bad of [null, undefined, "", "0x", "0x1234", `${A}00`, A.slice(2), 42, {}]) {
    assert.equal(b.confirmed(/** @type {any} */ (bad)), false, String(bad));
    assert.throws(() => b.confirm(/** @type {any} */ (bad)), /No trading wallet/, String(bad));
  }
});

test("listeners hear a confirmation here, and one from another tab's storage event, and nothing else", () => {
  const b = createBackup({ storage: () => memoryStorage() });
  let heard = 0;
  const off = b.on(() => { heard++; });
  b.confirm(A);
  assert.equal(heard, 1);
  b.heard(backupKey(B));
  assert.equal(heard, 2, "another tab's confirmation");
  for (const other of ["clank.active", "clank.login", "clank.sends", null, undefined, 7]) b.heard(/** @type {any} */ (other));
  assert.equal(heard, 2, "other keys, and a cleared storage, are not confirmations");
  off();
  b.confirm(B);
  assert.equal(heard, 2, "unsubscribed");
});

// =========================================================== the flow --

/** A scripted frame behind `mount`: it records each mount, and the page hears it through `onStatus`. */
function frames({ fail = null } = {}) {
  const f = { mounts: [], cleaned: 0, fail };
  f.mount = async (element, onStatus) => {
    if (f.fail) { const e = f.fail; f.fail = null; throw e; }
    const one = { element, onStatus, cleaned: false };
    f.mounts.push(one);
    return () => { one.cleaned = true; f.cleaned++; };
  };
  f.last = () => f.mounts[f.mounts.length - 1];
  f.say = (status, message) => f.last().onStatus(status, message);
  return f;
}

function flowOver(f, over = {}) {
  const confirmed = [];
  const changes = [];
  const flow = createBackupFlow({
    address: A, mount: f.mount,
    backup: { confirmed: () => false, confirm: (a) => confirmed.push(a) },
    onChange: (st) => changes.push(st),
    ...over,
  });
  return { flow, confirmed, changes };
}

test("the checkbox waits for the copy; Continue waits for the checkbox; then it confirms this address and removes the frame", async () => {
  const f = frames();
  const { flow, confirmed } = flowOver(f);
  const el = { id: "export" };
  await flow.mount(el);
  assert.equal(f.mounts[0].element, el, "mounted in the sheet's container");
  assert.equal(flow.state().frame, "loading");
  f.say("ready");
  assert.equal(flow.state().frame, "ready");
  flow.tick(true);
  assert.equal(flow.state().ticked, false, "no ticking before the key was copied");
  assert.equal(flow.canContinue(), false);
  assert.equal(flow.finish(), false);
  f.say("pending");
  assert.equal(flow.state().frame, "copying");
  f.say("success");
  assert.deepEqual([flow.state().copied, flow.canTick(), flow.canContinue()], [true, true, false]);
  flow.tick(true);
  assert.equal(flow.canContinue(), true);
  flow.tick(false);
  assert.equal(flow.canContinue(), false, "unticked again");
  flow.tick(true);
  assert.equal(flow.finish(), true);
  assert.deepEqual(confirmed, [A]);
  assert.equal(f.mounts[0].cleaned, true, "the frame is removed");
  assert.equal(flow.finish(), false, "once");
  assert.deepEqual(confirmed, [A]);
  f.say("error", "late");
  assert.equal(flow.state().frame, "ready", "a closed sheet hears nothing more");
});

test("'I already saved it' allows the checkbox without a copy, and the checkbox is still required", async () => {
  const f = frames();
  const { flow, confirmed } = flowOver(f);
  await flow.mount({});
  flow.alreadySaved();
  assert.equal(flow.canTick(), true);
  assert.equal(flow.canContinue(), false, "the checkbox is still required");
  assert.equal(flow.finish(), false);
  flow.tick(true);
  assert.equal(flow.finish(), true);
  assert.deepEqual(confirmed, [A]);
});

test("an error or a failed mount offers another try; an expired frame is gone and can be shown again; a copy still counts", async () => {
  const f = frames({ fail: new Error("MFA is required") });
  const { flow } = flowOver(f);
  const el = {};
  await flow.mount(el);
  assert.deepEqual([flow.state().frame, flow.state().message], ["failed", "MFA is required"]);
  await flow.mount(el);
  f.say("ready");
  f.say("error", "Clipboard blocked");
  assert.deepEqual([flow.state().frame, flow.state().message], ["error", "Clipboard blocked"]);
  const first = f.last();
  await flow.mount(el);
  assert.equal(first.cleaned, true, "the old frame is removed before a new one");
  first.onStatus("success");
  assert.equal(flow.state().copied, false, "the old frame's words are not the new one's");
  f.say("success");
  f.say("expiring");
  assert.equal(flow.state().frame, "expiring");
  f.say("expired");
  assert.deepEqual([flow.state().frame, flow.state().copied], ["expired", true], "a copy made before it expired still counts");
  const expired = f.last();
  await flow.mount(el);
  assert.equal(expired.cleaned, false, "the SDK already removed an expired frame");
  assert.equal(f.mounts.length, 3, "three frames, after the mount that failed");
  f.say("whatever");
  assert.equal(flow.state().frame, "loading", "an unknown word changes nothing");
  f.say("error");
  assert.equal(flow.state().message, "", "an error with no words");
});

test("closing before Coinbase answers removes the frame when it arrives, and hears nothing from it", async () => {
  const f = frames();
  let release;
  const slow = { ...f, mount: (el, on) => new Promise((r) => { release = () => r(f.mount(el, on)); }) };
  const { flow, changes } = flowOver(f, { mount: slow.mount });
  const pending = flow.mount({});
  flow.close();
  release();
  await pending;
  await settle();
  assert.equal(f.mounts[0].cleaned, true, "removed as soon as it arrived");
  const seen = changes.length;
  f.say("ready");
  assert.equal(changes.length, seen, "heard nothing");
  await flow.mount({});
  assert.equal(f.mounts.length, 1, "a closed sheet mounts nothing");
});

test("a failed mount after closing, or a remount that overtook it, says nothing", async () => {
  const f = frames();
  let fail;
  const { flow } = flowOver(f, { mount: () => new Promise((_, rej) => { fail = () => rej(new Error("late")); }) });
  const p = flow.mount({});
  flow.close();
  fail();
  await p;
  assert.equal(flow.state().frame, "loading");
});

// ============================================ through the real session --

/** One tab's scripted facade: W1.1's nine functions, with an export frame that holds KEY. `who` is the wallet a login gives. */
function facade(who = A) {
  const f = {
    me: null, mounts: [], clipboard: null, listeners: new Set(),
    async init() {},
    async address() { return f.me; },
    async completeLogin() { return f.me; },
    async loginWithWallet(p) {
      const [account] = await p.request({ method: "eth_requestAccounts" });
      await p.request({ method: "personal_sign", params: ["0x73696e", account] });
      f.me = who;
      return f.me;
    },
    async startLogin() {},
    async logout() { f.me = null; for (const fn of f.listeners) fn(null); },
    onAuthChange(fn) { f.listeners.add(fn); return () => f.listeners.delete(fn); },
    async signTransaction() { throw new Error("nothing is signed here"); },
    // As W1.1's facade does: only the logged-in wallet's key, into the element given.
    async mountExport(element, address, onStatus) {
      if (!f.me || String(address).toLowerCase() !== f.me.toLowerCase()) {
        throw new Error("Only the logged-in trading wallet's key can be exported.");
      }
      const frame = { tag: "iframe", src: "https://secure-wallet.cdp.coinbase.com/?projectId=made-up", removed: false };
      element.appendChild(frame);
      f.mounts.push({ element, address, onStatus, frame });
      queueMicrotask(() => onStatus("ready"));
      return () => { frame.removed = true; };
    },
    /** The visitor presses Coinbase's button: the key goes to the clipboard, and the page hears one word. */
    press() {
      const m = f.mounts[f.mounts.length - 1];
      f.clipboard = KEY;
      m.onStatus("pending");
      m.onStatus("success");
    },
  };
  return f;
}

/** A session over the real start() and provider, and the scripted facade, ready to log in as `who`. */
async function loggedIn(state, who = A) {
  const f = facade(who);
    const PROJECTS = [{ name: "staging", origin: ORIGIN, projectId: "00000000-0000-4000-8000-000000000004" }];
  globalThis.fetch = async (_url, init) => ({
    ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: "0x0" }),
  });
  const main = { provider: { async request({ method }) { return method === "eth_requestAccounts" ? ["0x00000000000000000000000000000000000A11cE"] : "0x" + "ab".repeat(65); } } };
  const s = createSession({
    here: true, state,
    start: () => start({ origin: ORIGIN, projects: PROJECTS, load: async () => f }),
    storage: () => null, channel: () => null, locks: null, now: () => 1_789_600_000_000,
    every: () => () => {}, watch: () => {},
    location: () => ({ href: `${ORIGIN}/`, origin: ORIGIN }),
    history: () => ({ state: null, replaceState() {} }),
    acknowledge: async () => true,
    main: { connect: async () => "0x00000000000000000000000000000000000A11cE", provider: () => main.provider },
  });
  return { f, s };
}

test("the session mounts the frame for the logged-in address only, and refuses when logged out", async () => {
  const state = { trading: null, login: { here: true, phase: "idle", countdown: null, waiting: false } };
  const { f, s } = await loggedIn(state);
  await assert.rejects(s.mountExport({ appendChild() {} }, () => {}), /Log in to back up your key/);
  assert.equal(f.mounts.length, 0, "Coinbase was never asked");
  await s.login("wallet", { uuid: "made-up" });
  const el = { kids: [], appendChild(x) { el.kids.push(x); } };
  const statuses = [];
  const cleanup = await s.mountExport(el, (w) => statuses.push(w));
  assert.equal(f.mounts[0].address, A, "the trading wallet's own address, from the session");
  assert.equal(f.mounts[0].element, el);
  assert.equal(el.kids[0].tag, "iframe");
  await settle();
  assert.deepEqual(statuses, ["ready"]);
  cleanup();
  assert.equal(el.kids[0].removed, true);
  // The session never takes an address from the page: another wallet's key is refused at the facade too.
  await assert.rejects(f.mountExport(el, B, () => {}), /Only the logged-in trading wallet's key/);
  await s.logout();
  await assert.rejects(s.mountExport(el, () => {}), /Log in to back up your key/);
});

// ========================================================== the sheet --

/** A stub page where modals find their own parts, and every element made is kept, to search. */
function page() {
  const dom = stubDom();
  const make = document.createElement;
  const made = [];
  document.createElement = () => {
    const el = make();
    const found = new Map();
    el.querySelector = (sel) => {
      if (!found.has(sel)) found.set(sel, document.createElement());
      return found.get(sel);
    };
    el.querySelectorAll = () => [];
    el.q = (sel) => el.querySelector(sel);
    el.removed = 0;
    el.remove = () => { el.removed++; };
    el.repaints = 0;
    const replace = el.replaceChildren;
    el.replaceChildren = (...nodes) => { el.repaints++; replace.apply(el, nodes); };
    el.listeners = new Map();
    el.addEventListener = (type, fn) => { el.listeners.set(type, fn); };
    made.push(el);
    return el;
  };
  const body = { appended: [], appendChild(el) { body.appended.push(el); return el; } };
  Object.assign(document, { body });
  return { dom, body, made };
}

const sheetMod = () => import("../public/js/pages/backup.js");

/** The page's own state for a logged-in tab, and a clean slate after. */
function asLoggedIn(address = A) {
  const saved = { mode: S.mode, login: S.login, trading: S.trading };
  S.mode = "hosted";
  S.login = { here: true, phase: "idle", countdown: null, waiting: false };
  S.trading = { address, method: "google", balanceWei: 0n };
  return () => Object.assign(S, saved);
}

test("the sheet's words, in the spec's order, with the domain, the address and the beta warning", async () => {
  const { sheetMarkup, statusWords } = await sheetMod();
  const first = textOf(sheetMarkup(A, { again: false, origin: ORIGIN }).s);
  const order = [
    "Back up your key",
    `Beta: new software. Keep only trading money here. You are on ${ORIGIN}. Only fund a trading wallet on this site.`,
    "Your trading wallet has a private key. Anyone who has it controls the wallet. It is also your only way back in if Coinbase's service fails.",
    `Wallet ${A}`,
    "Loading Coinbase's button…",
    "Paste it into your password manager now, then copy something else so it leaves your clipboard.",
    `To check it, import it into MetaMask or Rabby. It should show ${A}.`,
    "I saved my key somewhere only I can reach",
    "Saved it before, in another browser? I already saved it",
    "Close Continue",
  ];
  let at = -1;
  for (const words of order) {
    const i = first.indexOf(words);
    assert.ok(i > at, `${words} (at ${i}, after ${at})`);
    at = i;
  }
  assert.equal(betaLine(ORIGIN), order[1]);
  assert.equal(domainLine(ORIGIN), `You are on ${ORIGIN}. Only fund a trading wallet on this site.`);
  // By default, the page's own host and port, with no scheme.
  const savedLocation = globalThis.location;
  globalThis.location = /** @type {any} */ ({ origin: "http://localhost:8790", host: "localhost:8790" });
  try {
    assert.equal(betaLine(), "Beta: new software. Keep only trading money here. You are on localhost:8790. " +
      "Only fund a trading wallet on this site.");
  } finally {
    globalThis.location = savedLocation;
  }
  const markup = sheetMarkup(A, { again: false, origin: ORIGIN }).s;
  assert.match(markup, /<input type="checkbox" data-saved disabled/, "the checkbox starts disabled");
  assert.match(markup, /data-ok disabled>Continue/, "and so does Continue");
  assert.match(markup, /<div data-export[^>]*><\/div>/, "an empty container for Coinbase's frame");
  assert.doesNotMatch(markup, /eject/i, "no eject");
  // One sheet family (U7): a named dialog with the ✕ in its head, the box to tick as the family's.
  assert.match(markup, /^<div class="mbox bksheet" role="dialog" aria-modal="true" aria-labelledby="bk-title" tabindex="-1">\s*<div class="sheethd"><h3 id="bk-title">Back up your key<\/h3><button class="sheetx"/);
  assert.match(markup, /<label class="sheetcheck">/);

  const again = textOf(sheetMarkup(A, { again: true, origin: ORIGIN }).s);
  assert.match(again, /^Export your key Beta: new software\./);
  assert.doesNotMatch(again, /I saved my key|I already saved it|Continue/, "exporting again asks nothing");
  assert.match(again, new RegExp(`You are on ${ORIGIN.replace(/\./g, "\\.")}\\.`));

  const w = (frame, over = {}) => statusWords({ frame, message: "", copied: false, ...over });
  assert.deepEqual(w("loading"), { text: "Loading Coinbase's button…", action: null });
  assert.deepEqual(w("ready"), { text: "Press Coinbase's button to copy your key.", action: null });
  assert.deepEqual(w("ready", { copied: true }), { text: "Copied. Paste it into your password manager now.", action: null });
  assert.deepEqual(w("copying"), { text: "Copying…", action: null });
  assert.deepEqual(w("expiring"), { text: "Coinbase's button expires soon. Copy your key now.", action: null });
  assert.deepEqual(w("expiring", { copied: true }), { text: "Copied. Coinbase's button expires soon.", action: null });
  assert.deepEqual(w("expired"), { text: "Coinbase's button expired.", action: "again" });
  assert.deepEqual(w("expired", { copied: true }), { text: "Coinbase's button expired. Your copy still counts.", action: "again" });
  assert.deepEqual(w("error", { message: "Clipboard blocked" }), { text: "Coinbase's button could not copy your key: Clipboard blocked", action: "retry" });
  assert.deepEqual(w("error"), { text: "Coinbase's button could not copy your key.", action: "retry" });
  assert.deepEqual(w("failed", { message: "MFA" }), { text: "Coinbase's button could not load: MFA", action: "retry" });
  assert.deepEqual(w("failed"), { text: "Coinbase's button could not load.", action: "retry" });
});

test("the sheet: the frame mounts in its container once the sheet is in the page, and the container is never repainted", async () => {
  const { body } = page();
  const restore = asLoggedIn();
  const { openBackup } = await sheetMod();
  const f = frames();
  let appendedFirst = null;
  const mount = (el, on) => { appendedFirst = body.appended.length === 1; return f.mount(el, on); };
  try {
    const opened = openBackup({ mount, origin: ORIGIN });
    const back = body.appended[0];
    assert.equal(appendedFirst, true, "the sheet was in the page before the frame was asked for");
    const container = back.q("[data-export]");
    assert.equal(f.mounts[0].element, container);
    const status = back.q("[data-export-status]");
    const box = back.q("[data-saved]"), ok = back.q("[data-ok]"), already = back.q("[data-already]");
    assert.equal(textOf(status.markup), "Loading Coinbase's button…");
    assert.deepEqual([box.disabled, ok.disabled, already.disabled], [true, true, false]);
    await settle();
    f.say("ready");
    assert.equal(textOf(status.markup), "Press Coinbase's button to copy your key.");
    f.say("error", "Clipboard blocked");
    assert.equal(textOf(status.markup), "Coinbase's button could not copy your key: Clipboard blocked Try again");
    status.q("[data-remount]").onclick();
    await settle();
    assert.equal(f.mounts.length, 2, "Try again mounts a new frame");
    assert.equal(f.mounts[1].element, container, "in the same container");
    f.say("expired");
    assert.match(textOf(status.markup), /Show the button again$/);
    status.q("[data-remount]").onclick();
    await settle();
    assert.equal(f.mounts.length, 3);
    f.say("success");
    assert.equal(textOf(status.markup), "Copied. Paste it into your password manager now.");
    assert.equal(box.disabled, false, "the checkbox, once the key was copied");
    assert.equal(ok.disabled, true);
    box.checked = true;
    box.onchange();
    assert.equal(ok.disabled, false);
    assert.equal(container.repaints, 0, "the frame's container was never repainted");
    assert.equal(opened.flow.state().ticked, true);
    ok.onclick();
    assert.equal(back.removed, 1, "Continue closes the sheet");
    assert.equal(f.mounts[2].cleaned, true, "and removes the frame");
    assert.equal(pageBackup.confirmed(A), true);
  } finally {
    restore();
  }
});

test("the sheet: 'I already saved it', then the checkbox, confirms without a copy; Close confirms nothing", async () => {
  const { body } = page();
  const OTHER = "0x0000000000000000000000000000000000000B0b";
  const THIRD = "0x0000000000000000000000000000000000000C0c";
  const restore = asLoggedIn(OTHER);
  const { openBackup, backupOpen } = await sheetMod();
  const f = frames();
  try {
    openBackup({ mount: f.mount, origin: ORIGIN });
    let back = body.appended[0];
    back.q("[data-already]").onclick();
    assert.equal(back.q("[data-already]").disabled, true);
    const box = back.q("[data-saved]");
    assert.equal(box.disabled, false);
    back.q("[data-ok]").onclick();
    assert.equal(back.removed, 0, "not before the checkbox");
    box.checked = true;
    box.onchange();
    back.q("[data-ok]").onclick();
    assert.equal(back.removed, 1);
    assert.equal(pageBackup.confirmed(OTHER), true);

    S.trading = { ...S.trading, address: THIRD };
    openBackup({ mount: f.mount, origin: ORIGIN });
    back = body.appended[1];
    assert.equal(backupOpen(), true);
    assert.equal(openBackup({ mount: f.mount, origin: ORIGIN }), null, "one sheet at a time");
    await settle();
    back.q("[data-x]").onclick();
    assert.equal(back.removed, 1);
    assert.equal(backupOpen(), false);
    assert.equal(f.last().cleaned, true, "closing removes the frame");
    assert.equal(pageBackup.confirmed(THIRD), false, "closing confirms nothing");
    back.q("[data-x]").onclick();
    assert.equal(back.removed, 1, "closed once");
    openBackup({ mount: f.mount, origin: ORIGIN });
    back = body.appended[2];
    back.listeners.get("click")({ target: back });
    assert.equal(back.removed, 1, "a click on the backdrop closes it too");
    assert.equal(backupOpen(), false);
    S.trading = null;
    assert.equal(openBackup({ mount: f.mount }), null, "logged out, nothing opens");
  } finally {
    restore();
  }
});

test("the sheet opens by itself once per page load for an unconfirmed address, and closes when it is no longer that wallet's", async () => {
  const { body } = page();
  const C = "0x000000000000000000000000000000000000Cafe";
  const D = "0x000000000000000000000000000000000000dead";
  const restore = asLoggedIn(C);
  const { offerBackup, backupOpen } = await sheetMod();
  const f = frames();
  const d = { mount: f.mount, origin: ORIGIN };
  try {
    S.login = { ...S.login, phase: "restoring" };
    offerBackup(d);
    assert.equal(body.appended.length, 0, "not mid-login");
    S.login = { ...S.login, phase: "idle", here: false };
    offerBackup(d);
    assert.equal(body.appended.length, 0, "not where there is no trading wallet");
    S.login = { ...S.login, here: true };
    offerBackup(d);
    assert.equal(body.appended.length, 1, "opens for an unconfirmed address");
    offerBackup(d);
    assert.equal(body.appended.length, 1, "a balance repaint does not open another");
    body.appended[0].q("[data-x]").onclick();
    offerBackup(d);
    assert.equal(body.appended.length, 1, "closed, it does not come back on this page load");

    // Another wallet (another login): its own sheet. Logging out closes it.
    S.trading = { ...S.trading, address: D };
    offerBackup(d);
    assert.equal(body.appended.length, 2);
    await settle();
    S.trading = null;
    offerBackup(d);
    assert.equal(body.appended[1].removed, 1, "logged out: closed");
    assert.equal(backupOpen(), false);
    assert.equal(f.last().cleaned, true);

    // A confirmed address never gets it.
    pageBackup.confirm(A);
    S.trading = { address: A, method: "x", balanceWei: 0n };
    offerBackup(d);
    assert.equal(body.appended.length, 2);
  } finally {
    restore();
  }
});

test("a sheet closes when another tab confirms, and when the wallet shown changes; exporting again stays open", async () => {
  const { body } = page();
  const E = "0x000000000000000000000000000000000000E0E0";
  const F = "0x000000000000000000000000000000000000F0F0";
  const restore = asLoggedIn(E);
  const { offerBackup, openBackup, watchBackups } = await sheetMod();
  const f = frames();
  const d = { mount: f.mount, origin: ORIGIN };
  const events = new Map();
  const savedWindow = globalThis.window;
  globalThis.window = {
    addEventListener: (type, fn) => events.set(type, fn),
    removeEventListener: (type, fn) => { if (events.get(type) === fn) events.delete(type); },
  };
  let rerenders = 0;
  const stop = watchBackups(() => { rerenders++; });
  try {
    offerBackup(d);
    const first = body.appended[0];
    // Another tab confirmed E: its storage event arrives here.
    const storage = memoryStorage();
    storage.setItem(backupKey(E), "1");
    globalThis.localStorage = /** @type {any} */ (storage);
    events.get("storage")({ key: "clank.active" });
    assert.equal(rerenders, 0, "not a confirmation");
    events.get("storage")({ key: backupKey(E) });
    assert.equal(rerenders, 1, "every reason is redrawn");
    assert.equal(first.removed, 1, "the sheet it no longer needs closes");

    // Exporting again, from the chip's menu: a confirmation does not close it.
    openBackup(d);
    const again = body.appended[1];
    assert.match(textOf(again.markup), /^Export your key/);
    events.get("storage")({ key: backupKey(E) });
    assert.equal(again.removed, 0);
    // But another wallet does, and F, unconfirmed, gets its own.
    S.trading = { ...S.trading, address: F };
    offerBackup(d);
    assert.equal(again.removed, 1);
    const own = body.appended[2];
    assert.match(textOf(own.markup), /^Back up your key/);
    // Continuing here: the confirmation redraws every reason, and the sheet
    // closes once, though the watcher closes it before Continue does.
    const before = rerenders;
    own.q("[data-already]").onclick();
    own.q("[data-saved]").checked = true;
    own.q("[data-saved]").onchange();
    own.q("[data-ok]").onclick();
    assert.equal(rerenders, before + 1);
    assert.equal(own.removed, 1, "closed once");
    stop();
    assert.equal(events.has("storage"), false, "stopped");
  } finally {
    stop();
    globalThis.window = savedWindow;
    delete globalThis.localStorage;
    restore();
  }
});

test("nothing of the key reaches the page: not the markup, the state or storage", async () => {
  const { body, made } = page();
  const storage = memoryStorage();
  globalThis.localStorage = /** @type {any} */ (storage);
  const G = "0x0000000000000000000000000000000000006060";
  const state = { trading: null, login: { here: true, phase: "idle", countdown: null, waiting: false } };
  const { f, s } = await loggedIn(state, G);
  const saved = { mode: S.mode, login: S.login, trading: S.trading };
  const { openBackup } = await sheetMod();
  try {
    await s.login("wallet", { uuid: "made-up" });
    Object.assign(S, { mode: "hosted", login: state.login, trading: state.trading });
    const opened = openBackup({ mount: (el, on) => s.mountExport(el, on), origin: ORIGIN });
    const back = body.appended[0];
    await settle();
    assert.equal(f.mounts[0].address, G);
    f.press();
    assert.equal(f.clipboard, KEY, "the frame put the key on the clipboard itself");
    const box = back.q("[data-saved]");
    box.checked = true;
    box.onchange();
    back.q("[data-ok]").onclick();
    assert.equal(opened.flow.state().done, true);
    const everything = [
      ...made.map((el) => `${el.markup} ${el.textContent} ${el.value}`),
      JSON.stringify(S, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      JSON.stringify(storage.dump()),
      JSON.stringify(opened.flow.state()),
    ].join("\n");
    assert.ok(!everything.includes(KEY.slice(2)), "the key is nowhere in the page");
    assert.ok(storage.writes.every(([k]) => k.startsWith(BACKUP_PREFIX)), "only the confirmation was stored");
  } finally {
    Object.assign(S, saved);
    delete globalThis.localStorage;
  }
});

// ================================================ the page's wiring --

const JS = (rel) => fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url));

test("shell.js offers the sheet on every session change, and watches confirmations only where there is a trading wallet", () => {
  const file = JS("pages/shell.js");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let fn = null;
  const find = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "startTradingWallet") fn = n;
    ts.forEachChild(n, find);
  };
  find(sf);
  assert.ok(fn, "startTradingWallet");
  const body = fn.body.statements.map((st) => st.getText(sf));
  const on = body.findIndex((t) => t.startsWith("session.on("));
  assert.ok(on >= 0 && /offerBackup\(\);\s*\}\);$/.test(body[on]), "the session's handler ends by offering the sheet");
  const guard = body.findIndex((t) => t === "if (!S.login.here) return;");
  const watch = body.findIndex((t) => t.startsWith("watchBackups("));
  assert.ok(guard > on && watch > guard, "confirmations are watched only past the trading-wallet guard");
});
