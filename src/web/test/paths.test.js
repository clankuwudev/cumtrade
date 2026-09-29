// The app at its path (L1 L3, L4b; P2b): the terminal, cumTrade, at /trade. cumAI is a
// page of its own at /ai (N-D6, changed by the user), so an address that
// names it here leaves for it. The console keeps its hash-only /.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { AI_PATH, AI_TABS, OS_PATH, addressOf, go, leaveFor, pathLinks, resolve } from "../public/js/router.js";

const dom = stubDom();

/** A location and history that keep a path and a hash, and a log of what was written. */
const writes = [];
const loc = {
  origin: "https://clankuwu.com", pathname: "/trade", hash: "",
  get href() { return this.origin + this.pathname + this.hash; },
  replace(url) { writes.push(["leave", url]); },
};
globalThis.location = loc;
globalThis.history = { replaceState(_s, _t, url) { writes.push(["replace", url]); loc.hash = url; } };
const at = (pathname, hash = "") => { loc.pathname = pathname; loc.hash = hash; writes.length = 0; dom.reset(); };
const as = (mode, fn) => { const saved = S.mode; S.mode = mode; try { fn(); } finally { S.mode = saved; } };

test("an old #/ai link leaves for cumAI's own page, with its tab when it names one", () => {
  assert.equal(OS_PATH, "/trade");
  assert.equal(AI_PATH, "/ai");
  assert.deepEqual(AI_TABS, ["models", "docs"]);
  assert.equal(leaveFor("ai", "hosted"), "/ai");
  assert.equal(leaveFor("ai/docs", "hosted"), "/ai#/docs");
  assert.equal(leaveFor("ai/models", "hosted"), "/ai#/models");
  assert.equal(leaveFor("ai/playground", "hosted"), "/ai", "a tab cumAI doesn't have is its first");
  for (const spec of ["", "token/0x1", "learn/terms", "aim", "portfolio"]) assert.equal(leaveFor(spec, "hosted"), null, spec);
  assert.equal(leaveFor("ai", "self"), null, "the console has no cumAI");
});

test("going to it leaves the page, and leaves no entry behind", () => {
  as("hosted", () => {
    at(OS_PATH, "#/ai/docs");
    go("ai/docs", false);
    assert.deepEqual(writes, [["leave", "/ai#/docs"]]);
  });
  as("self", () => {
    at("/", "#/ai");
    go("ai", false);
    assert.deepEqual(writes, [["replace", "#/"]], "the console reads it as the board");
  });
});

test("the gateway's terms link still opens the Terms section (L1 N1)", () => {
  // https://clankuwu.com/os#/learn/terms?version=2026-09-23, the sign-in's one resource: /os
  // now answers 301 to /trade, and the browser keeps the fragment, so it arrives here (P2d).
  assert.deepEqual(resolve("learn/terms?version=2026-09-23", "hosted"), { page: "about", arg: "terms" });
  assert.equal(addressOf("about", "terms"), "#/learn/terms");
});

test("the console's routes are untouched: hash only, at its own path", () => {
  as("self", () => {
    at("/", "#/launches");
    go("launches", false);
    assert.deepEqual(writes, [["replace", "#/"]]);
    assert.equal(loc.pathname, "/");
  });
});

test("a hosted page's nav points at /trade, and the logo home to the landing", () => {
  const a = (href) => { const attrs = { href }; return { attrs, getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } }; };
  const nav = [a("#/"), a("#/portfolio"), a("#/learn/how-it-works")];
  const logo = a("#/");
  pathLinks({ querySelectorAll: () => nav, querySelector: () => logo });
  assert.deepEqual(nav.map((x) => x.attrs.href), ["/trade#/", "/trade#/portfolio", "/trade#/learn/how-it-works"]);
  assert.equal(logo.attrs.href, "/");
  assert.equal(logo.attrs["aria-label"], "Clank Uwu Model, home");
});
