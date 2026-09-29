// The system switch's words (docs/specs/system-switch.md, S2). What the
// switch and the banner say is drawn only from the server's reply, so these
// pin that each state reads true: off never claims to watch, a corrupt file
// says why, and positions whose exits still run are named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemCopy } from "../public/js/core/domain.js";

const sys = (over = {}) => ({ on: true, reason: null, managing: 0, ...over });

test("on: says it is watching, and no banner", () => {
  const c = systemCopy(sys());
  assert.equal(c.label, "System on");
  assert.equal(c.note, "Watching launches");
  assert.equal(c.banner, null);
});

test("off: standby, and the banner says nothing is watched or bought", () => {
  const c = systemCopy(sys({ on: false }));
  assert.equal(c.label, "System off");
  assert.equal(c.note, "Standby");
  assert.equal(c.banner, "Not watching launches, not buying.");
});

test("off with sniper positions open: the banner says their exits still run", () => {
  assert.match(systemCopy(sys({ on: false, managing: 1 })).banner, /Exits still run for 1 sniper position\.$/);
  assert.match(systemCopy(sys({ on: false, managing: 3 })).banner, /for 3 sniper positions\.$/);
});

test("off because the file was unreadable: the banner says so first", () => {
  const c = systemCopy(sys({ on: false, reason: "data/system.json was unreadable" }));
  assert.ok(c.banner.startsWith("It came up off because data/system.json was unreadable. "));
  assert.ok(c.banner.endsWith("Not watching launches, not buying."));
});
