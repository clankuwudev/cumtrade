// The session token a POST carries (public-release F5.2). A self page has it
// in a meta tag, and a hosted page has no tag and sends no header at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenHeader } from "../public/js/core/api.js";

/** A document whose only meta tag is the given one, or none. */
const page = (meta) => ({
  querySelector: (sel) => (sel === 'meta[name="clank-token"]' ? meta : null),
});

test("a self page's meta token becomes the x-clank-token header", () => {
  assert.deepEqual(tokenHeader(page({ content: "ab12" })), { "x-clank-token": "ab12" });
});

test("a hosted page, with no meta tag, sends no header at all", () => {
  assert.deepEqual(tokenHeader(page(null)), {});
});

test("an empty token is no token", () => {
  assert.deepEqual(tokenHeader(page({ content: "" })), {});
});
