// The track record's words (docs/specs/track-record.md, T3): the verdict
// pill each row wears and the status line over the table. Both come only from
// the server's reply, so these pin that each state reads true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordStatus, verdictPill } from "../public/js/core/domain.js";

const idle = { running: false, phase: null, detail: null, done: 0, total: 0, error: null };

test("each verdict has its own label and colour", () => {
  const all = ["paperhand", "fumble", "good", "holding", "unpriced"].map(verdictPill);
  assert.deepEqual(all.map((v) => v.label), ["Paperhand", "Fumbled the top", "Good sell", "Holding", "No price"]);
  assert.equal(new Set(all.map((v) => v.cls)).size, 5);
  assert.ok(all.every((v) => v.tip.length > 10));
});

test("an unknown verdict reads as no price, not as a judgement", () => {
  assert.equal(verdictPill("something new").label, "No price");
});

test("while a refresh runs, the status says what it is doing", () => {
  assert.equal(recordStatus({ ...idle, running: true, phase: "transfers" }, null), "Reading transfers…");
  assert.equal(recordStatus({ ...idle, running: true, phase: "transactions", done: 40, total: 161 }, null),
    "Reading 40 of 161 transactions…");
  assert.equal(recordStatus({ ...idle, running: true, phase: "prices", detail: "TKN", done: 3, total: 32 }, null),
    "Pricing TKN (3 of 32)…");
});

test("a failed refresh says so, before how old the record is", () => {
  assert.equal(recordStatus({ ...idle, error: "the log node is refusing requests" }, 1),
    "Refresh failed: the log node is refusing requests");
});

test("otherwise, how old it is", () => {
  const now = 10 * 3600_000;
  assert.equal(recordStatus(idle, null, now), "Not read yet");
  assert.equal(recordStatus(idle, now - 20_000, now), "Updated just now");
  assert.equal(recordStatus(idle, now - 7 * 60_000, now), "Updated 7 min ago");
  assert.equal(recordStatus(idle, now - 3 * 3600_000, now), "Updated 3 h ago");
});
