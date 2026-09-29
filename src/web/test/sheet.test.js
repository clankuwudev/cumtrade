// The plan sheet's ETH amounts (public-release F3.4). A trade small enough to
// round to "0.000000" at six decimals is written out exactly instead, so the
// sheet never shows a real payment as nothing. Then, since U7, when the plan
// sheet and the acknowledgement may close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";
import { ethText } from "../public/js/trade/planSheet.js";

test("normal amounts keep six decimals", () => {
  assert.equal(ethText("3000000000000000"), "0.003000 Ξ");
  assert.equal(ethText(10n ** 18n), "1.000000 Ξ");
  assert.equal(ethText("1000000000000"), "0.000001 Ξ", "a millionth is still six decimals");
  assert.equal(ethText("0"), "0.000000 Ξ");
});

test("below a millionth, the amount is exact rather than zero", () => {
  assert.equal(ethText("100000000000"), "0.0000001 Ξ");
  assert.equal(ethText("999999999999"), "0.000000999999999999 Ξ");
  assert.equal(ethText("1"), "0.000000000000000001 Ξ");
});

// ---- the sheet family (U7) ------------------------------------------------
//
// The plan sheet and the acknowledgement are held sheets now: a ✕ in the
// head, Esc, focus kept inside. What must not change is when they close. A
// stub page just big enough: scrims in the body in order, a document that
// hears keydown, and elements that keep what was painted into them.

const page = { scrims: [], keys: null };

/** A scrim or control: remembers its markup, listeners and whether it is in the page. */
function part() {
  const e = {
    markup: "", className: "", isConnected: false, listeners: new Map(), dataset: {}, onclick: null, disabled: false,
    checked: false, focus() { document.activeElement = e; },
    addEventListener(type, fn) { e.listeners.set(type, fn); },
    replaceChildren(...nodes) { e.markup = nodes.map((n) => n.markup).join(""); },
    remove() { e.isConnected = false; page.scrims = page.scrims.filter((s) => s !== e); },
    parts: new Map(),
    querySelector(sel) {
      if (sel === ".mbox") return null;
      if (sel === "[data-x]" && !/data-x/.test(e.markup)) return null;
      if (!e.parts.has(sel)) e.parts.set(sel, part());
      return e.parts.get(sel);
    },
    querySelectorAll: (sel) => (sel === "[data-x]" && /data-x/.test(e.markup) ? [e.querySelector(sel)] : []),
  };
  return e;
}

function sheetPage() {
  stubDom();
  page.scrims = [];
  page.keys = null;
  Object.assign(document, {
    activeElement: null,
    createElement: () => part(),
    body: { appendChild(el) { el.isConnected = true; page.scrims.push(el); return el; } },
    addEventListener: (type, fn) => { if (type === "keydown") page.keys = fn; },
    removeEventListener: (type, fn) => { if (type === "keydown" && page.keys === fn) page.keys = null; },
    querySelectorAll: (sel) => (sel === ".modal" ? page.scrims : []),
  });
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  return store;
}

const esc = () => page.keys?.({ key: "Escape", shiftKey: false, preventDefault() {} });
const scrim = (back) => back.listeners.get("click")({ target: back });
const T = "0x00000000000000000000000000000000000070A1";
const state = (phase, extra = {}) => ({ phase, intent: { side: "buy", token: T }, plan: null, steps: [], done: [], message: "", ...extra });

test("the plan sheet has the family's head, and no ✕ while a step is being prepared or signed or waits on Resume or Cancel", async () => {
  sheetPage();
  const { createSheet } = await import("../public/js/trade/planSheet.js");
  const sheet = createSheet({ resume() {}, cancel() {}, switchChain: async () => {} });
  for (const phase of ["preparing", "signing", "running", "paused", "rejected", "error"]) {
    sheet.update(state(phase, { steps: [{ label: "Buy TKN", status: phase === "signing" ? "signing" : "waiting" }] }));
    const back = page.scrims[0];
    assert.equal(page.scrims.length, 1, phase);
    assert.match(back.markup, /^<div class="mbox plansheet" role="dialog" aria-modal="true" aria-labelledby="plan-title" tabindex="-1">/);
    assert.match(back.markup, /<div class="sheethd"><h3 id="plan-title">Buy 0x0000…70A1<\/h3><\/div>/, `${phase}: no ✕`);
    esc();
    scrim(back);
    assert.equal(back.isConnected, true, `${phase}: Esc and the scrim do nothing`);
  }
  sheet.close();
  assert.equal(page.keys, null);
});

test("the plan sheet: a pending step hides it by ✕, Esc or the scrim, and it comes back when the trade is over", async () => {
  sheetPage();
  const { createSheet } = await import("../public/js/trade/planSheet.js");
  const sheet = createSheet({ resume() {}, cancel() {}, switchChain: async () => {} });
  const pending = state("pending", { steps: [{ label: "Buy TKN", status: "pending" }], message: "Waiting for the chain." });
  for (const how of ["x", "esc", "scrim"]) {
    sheet.update(pending);
    const back = page.scrims[page.scrims.length - 1];
    assert.match(back.markup, /<h3 id="plan-title">Buy 0x0000…70A1<\/h3><button class="sheetx"/, "the ✕, once closing loses nothing");
    if (how === "x") back.querySelector("[data-x]").onclick();
    else if (how === "esc") esc();
    else scrim(back);
    assert.equal(back.isConnected, false, how);
    sheet.update(pending);
    assert.equal(page.scrims.length, 0, `${how}: still pending, it stays hidden`);
    sheet.update(state("done", { message: "Done." }));
    const again = page.scrims[0];
    assert.ok(again && again.isConnected, `${how}: over, it comes back`);
    assert.match(again.markup, /class="sheetx"/);
    esc();
    assert.equal(again.isConnected, false, "and an ended trade closes");
    assert.equal(page.keys, null, "no sheet held, no listener");
  }
});

test("the plan sheet: a question's ✕, Esc and scrim are its Cancel", async () => {
  sheetPage();
  const { createSheet } = await import("../public/js/trade/planSheet.js");
  const sheet = createSheet({ resume() {}, cancel() {}, switchChain: async () => {} });
  const ask = { kind: "plan", intent: { side: "buy", token: T }, plan: null };
  for (const how of ["x", "esc", "scrim"]) {
    const answer = sheet.confirm(ask);
    const back = page.scrims[page.scrims.length - 1];
    assert.match(back.markup, /class="sheetx"/);
    assert.match(textOf(back.markup), /Check every step\. Your wallet will ask you to confirm each one\. Cancel Confirm$/);
    if (how === "x") back.querySelector("[data-x]").onclick();
    else if (how === "esc") esc();
    else scrim(back);
    assert.equal(await answer, false, how);
    sheet.update(state("cancelled"));
    sheet.close();
  }
});

test("the acknowledgement: the family's sheet, the words as a warning, Continue only once the box is ticked; ✕ and Esc are Cancel", async () => {
  const store = sheetPage();
  const { acknowledge, acknowledgeTrading, TRADING_WARNING } = await import("../public/js/trade/acknowledge.js");
  const asked = acknowledge();
  const back = page.scrims[0];
  assert.equal(textOf(back.markup), "Before your first trade Your wallet signs every transaction. This site holds no keys and " +
    "cannot undo a trade. Verdicts are automated and can be wrong. I understand Cancel Continue", "its words, unchanged");
  assert.match(back.markup, /<div class="sheethd"><h3 id="ack-title">Before your first trade<\/h3><button class="sheetx"/);
  assert.match(back.markup, /<div class="callout warn"><span>Your wallet signs every transaction\./);
  assert.match(back.markup, /<button class="btn pri" type="button" data-ok disabled>Continue<\/button>/);
  const box = back.querySelector("[data-ack]");
  assert.equal(document.activeElement, box, "focus starts on the box to tick");
  back.querySelector("[data-ok]").onclick();
  assert.equal(back.isConnected, true, "Continue does nothing unticked");
  box.checked = true;
  esc();
  assert.equal(await asked, false, "Esc is Cancel, ticked or not");
  assert.equal(store.size, 0, "and nothing is remembered");

  const again = acknowledgeTrading();
  const tw = page.scrims[0];
  assert.match(textOf(tw.markup), new RegExp(`^Your trading wallet ${TRADING_WARNING.replace(/\./g, "\\.")} I understand`));
  tw.querySelector("[data-x]").onclick();
  assert.equal(await again, false, "the ✕ is Cancel");

  const third = acknowledge();
  const ok = page.scrims[0];
  ok.querySelector("[data-ack]").checked = true;
  ok.querySelector("[data-ok]").onclick();
  assert.equal(await third, true);
  assert.equal(store.get("clank.ack"), "1", "remembered once ticked and continued");
  assert.equal(page.keys, null);
});
