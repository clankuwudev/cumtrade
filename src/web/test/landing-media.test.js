import test from "node:test";
import assert from "node:assert/strict";
import { classifyPublic, renderLanding } from "../../../scripts/release-page.mjs";

const sha = "a".repeat(40);
const page = (media) => `<!doctype html><head></head><body>${media}<a href="/ai">cumAI</a><span class="mo" id="release">local</span></body>`;

test("release pins both video attributes and nested sources without changing page links", () => {
  const result = renderLanding(page('<video src="/landing/companion.mp4" poster="/landing/companion.webp"><source src="/landing/alternate.mp4" type="video/mp4"></video>'), sha);
  assert.deepEqual(result.assets, ["landing/companion.mp4", "landing/companion.webp", "landing/alternate.mp4"]);
  for (const path of result.assets) assert.ok(result.page.includes(`/v/${sha}/${path}`));
  assert.ok(result.page.includes('href="/ai"'));
});

test("video cannot bypass the existing release-pinning checks", () => {
  for (const path of ["landing/a.mp4?v=1", "landing/a.webp#x", `v/${sha}/a.mp4`]) {
    assert.throws(() => renderLanding(page(`<video poster="/${path}"></video>`), sha), /cannot pin/);
  }
  assert.deepEqual(classifyPublic(["landing/companion.mp4", "landing/payload.html", "landing/payload.svg"]).refused,
    ["landing/payload.html", "landing/payload.svg"]);
});
