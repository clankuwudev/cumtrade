// The shared sheet (u-redesign.md, U0): the generic modal()'s markup, and
// holdSheet's keys — Esc closes the top sheet, Tab goes round inside it, and
// focus goes back where it was. Also the avatar drawn from an address.
//
// A stub page just big enough for the keys: elements that can be focused,
// a document that hears keydown, and the scrims in the body in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";
import { CLOSE_X, avatar, closeOn, faceOf, holdSheet, modal, refocus, sheetHead, siteIn } from "../public/js/core/ui.js";

stubDom();

/** A focusable element; `shown` false stands for one in a hidden pane. */
function el(name, shown = true) {
  const e = {
    name, isConnected: true, listeners: new Map(), onclick: null,
    focus() { document.activeElement = e; },
    getClientRects: () => (shown ? [1] : []),
    addEventListener(type, fn) { e.listeners.set(type, fn); },
    remove() { e.isConnected = false; page.scrims = page.scrims.filter((s) => s !== e); },
  };
  return e;
}

/** A scrim holding a box, whose controls are `controls`, in the page. */
function sheet(controls) {
  const back = el("back");
  const box = el("box");
  box.querySelectorAll = () => controls;
  box.contains = (x) => x === box || controls.includes(x);
  back.querySelector = (sel) => (sel === ".mbox" ? box : null);
  page.scrims.push(back);
  return { back, box };
}

const page = { scrims: [], keys: null };
Object.assign(document, {
  activeElement: null,
  addEventListener: (type, fn) => { if (type === "keydown") page.keys = fn; },
  removeEventListener: (type, fn) => { if (type === "keydown" && page.keys === fn) page.keys = null; },
  querySelectorAll: (sel) => (sel === ".modal" ? page.scrims : []),
});

/** Press a key on the page; whether the sheet took it. */
const press = (key, shiftKey = false) => {
  let taken = false;
  page.keys?.({ key, shiftKey, preventDefault: () => { taken = true; } });
  return taken;
};

test("the close button is named Close, and says Esc does the same", () => {
  assert.match(CLOSE_X.s, /^<button class="sheetx" type="button" data-x aria-label="Close" title="Close \(Esc\)">/);
  assert.equal(textOf(CLOSE_X.s), "", "no words, only the drawn ✕");
});

test("holdSheet: focus starts in the sheet, Tab goes round inside it, Esc closes it, focus goes back", () => {
  const opener = el("opener");
  opener.focus();
  const a = el("a"), hidden = el("hidden", false), b = el("b");
  const { back, box } = sheet([a, hidden, b]);
  let closed = 0;
  const release = holdSheet(back, () => { closed++; release(); back.remove(); });
  assert.equal(document.activeElement, box, "the box, when nothing is named first");
  assert.ok(page.keys, "the page hears the keys");

  assert.ok(press("Tab", true), "Shift+Tab from the box");
  assert.equal(document.activeElement, b, "goes to the last control shown");
  assert.ok(press("Tab"));
  assert.equal(document.activeElement, a, "Tab from the last goes round to the first, past the hidden one");
  assert.ok(press("Tab", true));
  assert.equal(document.activeElement, b, "and Shift+Tab from the first to the last");
  assert.equal(press("Tab", true), false, "between them, the browser moves focus itself");

  opener.focus();
  assert.ok(press("Tab"));
  assert.equal(document.activeElement, a, "focus that got out is brought back in");

  assert.ok(press("Escape"));
  assert.equal(closed, 1);
  assert.equal(document.activeElement, opener, "back where it was");
  assert.equal(page.keys, null, "no sheet held, no listener");
  release();
  assert.equal(closed, 1, "releasing twice does nothing");
});

test("holdSheet: only the top sheet hears the keys, and none does under a sheet it does not hold", () => {
  const under = sheet([el("u")]);
  const over = sheet([el("o")]);
  const shut = [];
  const r1 = holdSheet(under.back, () => shut.push("under"));
  const r2 = holdSheet(over.back, () => shut.push("over"), over.box);
  press("Escape");
  assert.deepEqual(shut, ["over"], "Esc closes the top one only");
  r2();
  over.back.remove();
  // A sheet that is not held (the share card's): open over this one, Esc and Tab are its own.
  const plan = el("plan");
  page.scrims.push(plan);
  assert.equal(press("Escape"), false);
  assert.equal(press("Tab"), false);
  assert.deepEqual(shut, ["over"]);
  plan.remove();
  press("Escape");
  assert.deepEqual(shut, ["over", "under"]);
  r1();
});

test("the family's head: the title and the ✕, or the title alone while the sheet cannot close; every [data-x] closes", () => {
  assert.equal(sheetHead("t1", "Buy TKN").s, `<div class="sheethd"><h3 id="t1">Buy TKN</h3>${CLOSE_X.s}</div>`);
  assert.equal(sheetHead("t1", "Buy TKN", false).s, '<div class="sheethd"><h3 id="t1">Buy TKN</h3></div>');
  const back = el("back"), corner = el("corner"), cancel = el("cancel");
  // A page whose querySelectorAll finds nothing still gets the first one.
  back.querySelector = (sel) => (sel === "[data-x]" ? corner : null);
  back.querySelectorAll = () => [];
  let shut = 0;
  closeOn(back, () => shut++);
  corner.onclick();
  back.querySelectorAll = (sel) => (sel === "[data-x]" ? [corner, cancel] : []);
  closeOn(back, () => shut++);
  cancel.onclick();
  assert.equal(shut, 2, "the ✕ and Cancel alike");
});

test("a held sheet that repaints its box: Tab and refocus find the new box, not the one painted over", () => {
  const { back } = sheet([el("old")]);
  const release = holdSheet(back, () => {});
  const a = el("a"), b = el("b");
  const box = el("new box");
  box.querySelectorAll = () => [a, b];
  box.contains = (x) => x === box || x === a || x === b;
  back.querySelector = (sel) => (sel === ".mbox" ? box : null);
  document.activeElement = null;
  refocus(back);
  assert.equal(document.activeElement, box, "focus that went with the old box comes to the new one");
  assert.ok(press("Tab", true));
  assert.equal(document.activeElement, b, "Tab goes round the new box's controls");
  refocus(back);
  assert.equal(document.activeElement, b, "focus already inside stays put");
  release();
  back.remove();
  assert.equal(page.keys, null);
});

test("the site sentence is picked out of a line, its words unchanged", () => {
  const line = "Beta: new software. Keep only trading money here. You are on clankuwu.com. Only fund a trading wallet on this site.";
  const out = siteIn(line, "clankuwu.com");
  assert.equal(textOf(out.s), line);
  assert.match(out.s, /<b class="twsite">You are on clankuwu\.com\.<\/b>/);
  assert.equal(siteIn(line, "elsewhere.com"), line, "no origin in it, the line as it is");
});

test("modal(): the same words, now under a header with the close button, as a dialog named by its title", () => {
  const made = [];
  const body = { appendChild(e) { made.push(e); return e; } };
  const saved = { createElement: document.createElement, body: document.body };
  document.body = /** @type {any} */ (body);
  document.createElement = /** @type {any} */ (() => {
    const back = el("back");
    const parts = new Map();
    const part = (sel) => { if (!parts.has(sel)) parts.set(sel, el(sel)); return parts.get(sel); };
    back.replaceChildren = (...nodes) => { back.markup = nodes.map((n) => n.markup).join(""); };
    back.querySelector = (sel) => (sel === "input" && !/<input/.test(back.markup) ? null : part(sel));
    back.querySelectorAll = (sel) => (sel === "[data-x]" ? [part("[data-x] corner"), part("[data-x] cancel")] : []);
    page.scrims.push(back);
    return back;
  });
  try {
    modal({ title: "Unlock the wallet", body: "Enter the passphrase.", placeholder: "passphrase", confirmText: "Unlock", onConfirm: () => {} });
    const back = made[0];
    assert.equal(textOf(back.markup), "Unlock the wallet Enter the passphrase. Cancel Unlock", "its words, unchanged");
    assert.match(back.markup, /^<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="(sheet-\d+)" tabindex="-1">/);
    const id = back.markup.match(/aria-labelledby="(sheet-\d+)"/)[1];
    assert.match(back.markup, new RegExp(`<div class="sheethd"><h3 id="${id}">Unlock the wallet</h3><button class="sheetx"`));
    assert.equal(document.activeElement, back.querySelector("input"), "focus starts in the field");
    // The ✕ and Cancel both close it, and so does Esc.
    back.querySelectorAll("[data-x]")[0].onclick();
    assert.equal(back.isConnected, false, "the ✕ closes it");
    modal({ title: "Buy anyway?", body: "It failed a check.", confirmText: "Buy", onConfirm: () => {} });
    const again = made[1];
    assert.equal(document.activeElement, again.querySelector("[data-ok]"), "with no field, focus starts on the confirm");
    assert.ok(press("Escape"));
    assert.equal(again.isConnected, false, "Esc closes it");
    assert.equal(page.keys, null);
  } finally {
    Object.assign(document, saved);
  }
});

test("an avatar is the address's own: the same face every time, a different one for another", () => {
  const A = "0x0000000000000000000000000000000000007Ead";
  const B = "0x1234000000000000000000000000000000000abc";
  assert.equal(faceOf(A), faceOf(A));
  assert.notEqual(faceOf(A), faceOf(B));
  assert.match(avatar(A).s, /^<span class="avatar" style="background:linear-gradient\(135deg,hsl\(\d+ 72% 62%\),hsl\(\d+ 68% 40%\)\)" aria-hidden="true"><\/span>$/);
  assert.match(avatar(A, "lg").s, /^<span class="avatar lg" /);
});
