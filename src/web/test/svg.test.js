// Token logos under the page's CSP (public-release F5.2). The page may run no
// inline script, so a logo that fails to load is removed by one document
// listener rather than an onerror attribute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ring, dropBrokenLogo } from "../public/js/core/svg.js";

test("a ring with a logo carries no inline event handler", () => {
  const markup = ring(44, 0.5, "#fff", "TK", "0x00000000000000000000000000000000000070A1").s; // the markup html produced
  assert.match(markup, /<img class="pfp"/);
  assert.doesNotMatch(markup, /\son[a-z]+=/i);
});

/** An element that records whether it was removed. */
const el = (tagName, classes) => {
  const node = { tagName, classList: { contains: (c) => classes.includes(c) }, removed: false };
  node.remove = () => { node.removed = true; };
  return node;
};

test("a logo that fails to load is removed", () => {
  const img = el("IMG", ["pfp"]);
  dropBrokenLogo(/** @type {any} */ ({ target: img }));
  assert.equal(img.removed, true);
});

test("any other failing image or element is left alone", () => {
  const icon = el("IMG", ["wallet-icon"]);
  const script = el("SCRIPT", ["pfp"]);
  dropBrokenLogo(/** @type {any} */ ({ target: icon }));
  dropBrokenLogo(/** @type {any} */ ({ target: script }));
  dropBrokenLogo(/** @type {any} */ ({ target: null }));
  assert.equal(icon.removed, false);
  assert.equal(script.removed, false);
});
