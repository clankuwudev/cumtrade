// The trading app is cumTrade (spec p1-page-speed.md, Part 2, P2a; the user,
// 2026-09-26: "cumTrade, add a wallet using private key."). "cumOS" now names
// the platform everything runs on, so no page may call the trading app cumOS.
// Code comments may still say cumOS until the files they sit in are next
// touched; only what a visitor reads is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PUBLIC = new URL("../public/", import.meta.url);
const read = (p) => readFileSync(new URL(p, PUBLIC), "utf8");
/** The text a visitor can read or hear: markup without comments, plus attribute text. */
const visible = (htmlText) => htmlText.replace(/<!--[\s\S]*?-->/g, "");
/** A module's string literals and template text, without its comments. */
const strings = (js) => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

test("the landing calls the trading app cumTrade, never cumOS", () => {
  // CP1: companion-first; the existing-user trading link keeps its name.
  const page = visible(read("landing/index.html"));
  const tradingLinks = [...page.matchAll(/<a\b[^>]*href="\/trade"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.ok(tradingLinks.length > 0);
  for (const [, label] of tradingLinks) {
    assert.match(label, /cumTrade/);
    assert.doesNotMatch(label, /cumOS/);
  }
  assert.match(page, /cumOS <small class="kind">Personal AI companions/);
  assert.doesNotMatch(page, /Launch cumTrade|Start with cumTrade/);
});

test("cumAI's links and words call it cumTrade", () => {
  const page = visible(read("ai/index.html"));
  assert.doesNotMatch(page, /cumOS/);
  assert.equal((page.match(/<a href="\/trade">cumTrade<\/a>/g) ?? []).length, 2, "both footers");
  assert.match(strings(read("ai/ai.js")), /\["cumTrade", "\/trade"\]/, "the command palette's entry");
  assert.match(strings(read("ai/playground.js")), /Open <a class="cai-lnk" href="\/trade">cumTrade<\/a>/);
});

test("the app's own title names it, before and after its script runs", () => {
  assert.match(read("app.html"), /<title>cumTrade · Clank Uwu Model<\/title>/);
  assert.match(read("js/main.js"), /document\.title = S\.mode === "hosted" \? `cumTrade · \$\{S\.brand\}` : S\.brand;/,
    "the hosted app sets it again once the config names the brand; the self-hosted console keeps the brand alone");
});
