// The console's escaping guarantee. Everything rendered goes through `html`,
// and the only way to get unescaped markup out of it is markup `html` itself
// produced — so these pin exactly that, from the outside.
//
//   node --test src/web/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as dom from "../public/js/core/dom.js";

const { html } = dom;
const render = (raw) => raw.s;

test("every interpolation is escaped", () => {
  const out = render(html`<p title="${`"><img src=x onerror=alert(1)>`}">${"<script>x</script>"}</p>`);
  assert.equal(out.includes("<script>"), false);
  assert.equal(out.includes("<img"), false);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&quot;&gt;&lt;img/);
  assert.match(render(html`${"'&"}`), /&#39;&amp;/);
});

test("nested html is not escaped twice", () => {
  const inner = html`<b>${"<i>"}</b>`;
  assert.equal(render(html`<p>${inner}</p>`), "<p><b>&lt;i&gt;</b></p>");
});

test("arrays flatten, and null or undefined render as nothing", () => {
  assert.equal(render(html`${["<a>", html`<b></b>`]}`), "&lt;a&gt;<b></b>");
  assert.equal(render(html`[${null}][${undefined}]`), "[][]");
  // 0 must not be swallowed the way a falsy check would swallow it.
  assert.equal(render(html`${0}`), "0");
});

test("an object merely shaped like trusted markup is still escaped", () => {
  const forged = { s: "<b>trust me</b>" };
  assert.equal(render(html`${forged}`).includes("<b>"), false);
});

test("the trusted-markup type is not reachable from outside the module", () => {
  assert.equal("Raw" in dom, false);
  assert.equal("flatten" in dom, false);
  assert.equal("escape" in dom, false);
});
