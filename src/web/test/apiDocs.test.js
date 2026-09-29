// The Data API section (X21): a section of About, under Developers in Learn's
// contents at #/learn/api. What a reader must find there: the base URL, that
// another site's page cannot call it, the per-client limits (and only those),
// every endpoint with one curl line, the four bands in the site's own words,
// and the caveats. Whether its facts match the server is test:apidocs'.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";
import { S } from "../public/js/core/store.js";
import { BANDS } from "../public/js/core/domain.js";
import { API_LIMITS, ENDPOINTS, EVENTS } from "../public/js/core/apiFacts.js";
import { API_BASE } from "../public/js/pages/apiDocs.js";
import { aboutPage } from "../public/js/pages/about.js";
import { learnHref } from "../public/js/pages/learn.js";
import { resolve } from "../public/js/router.js";

stubDom();

/** The Data API section's markup and text, as a hosted page draws it. */
function section() {
  S.mode = "hosted";
  try {
    const all = aboutPage().s;
    const start = all.indexOf('id="about-api"');
    assert.ok(start > 0, "the About page has the section");
    const end = all.indexOf("</section>", start);
    const markup = all.slice(start, end);
    return { markup, text: textOf(markup) };
  } finally {
    S.mode = "self";
  }
}

test("#/learn/api opens the section on a hosted page; the console has none", () => {
  assert.equal(learnHref("api"), "#/learn/api");
  assert.deepEqual(resolve("learn/api", "hosted"), { page: "about", arg: "api" });
  assert.equal(resolve("learn/api", "self").page, "flow", "the console has no About");
});

test("the section says where, what, and that it is for scripts, not other sites' pages", () => {
  const { text } = section();
  assert.equal(API_BASE, "https://clankuwu.com");
  assert.match(text, /The data API/);
  assert.match(text, /No key, no sign-up\. It answers JSON over HTTPS at https:\/\/clankuwu\.com ?\./);
  assert.match(text, /Call it from a script or your own server\. A page on another website cannot call it from the browser/);
});

test("the limits are the per-client ones, and no shared number is published", () => {
  const { text } = section();
  assert.match(text, new RegExp(`/api/check ?: ${API_LIMITS.check.perMin} a minute, ${API_LIMITS.check.burst} of them at once`));
  assert.match(text, new RegExp(`/api/ledger ?: ${API_LIMITS.ledger.perMin} a minute, ${API_LIMITS.ledger.burst} at once, and ${API_LIMITS.ledger.distinctPerHour} different addresses an hour`));
  assert.match(text, new RegExp(`Everything else: ${API_LIMITS.read.perMin} a minute`));
  assert.match(text, new RegExp(`/events ?: ${API_LIMITS.streams} streams open at a time`));
  assert.match(text, /There is also a limit shared by all clients/);
  // The shared buckets' sizes (B5.3) appear nowhere.
  for (const n of ["120", "600"]) assert.doesNotMatch(text, new RegExp(`\\b${n} a minute`));
});

test("every endpoint has its heading, one curl line at the official site, and an example answer", () => {
  const { markup, text } = section();
  for (const e of ENDPOINTS) {
    assert.match(text, new RegExp(`${e.method} ${e.path.replace(/\//g, "\\/")} ·`), e.path);
    const curl = e.example.split("{base}").join(API_BASE);
    const escaped = curl.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    assert.ok(markup.includes(escaped) || markup.includes(curl.replace(/'/g, "&#39;")) || markup.includes(curl), `${e.path}: ${curl}`);
  }
  assert.equal((markup.match(/curl /g) || []).length, ENDPOINTS.length, "one curl line each");
  assert.doesNotMatch(markup, /\{base\}/, "no placeholder left");
  for (const ev of EVENTS) assert.match(text, new RegExp(`\\b${ev.name}\\b`));
});

test("the bands are the site's four, in its own words, and none is called safe", () => {
  const { text } = section();
  for (const [key, [, words]] of Object.entries(BANDS)) assert.match(text, new RegExp(`${key} ${words}`));
  assert.match(text, /not whether a token is a good buy/);
  assert.doesNotMatch(text, /\bsafe\b/i);
});

test("the caveats and the changes list", () => {
  const { markup, text } = section();
  assert.match(markup, /href="#\/learn\/verdicts"/);
  assert.match(markup, /href="#\/learn\/advice"/);
  assert.match(text, /There is no uptime promise/);
  assert.match(text, /It is not every trade/);
  assert.match(text, /2026-09-23 First published\./);
});
