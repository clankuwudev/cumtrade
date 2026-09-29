import { EXPLORER } from "./constants.js";
import { $, $$, html, paint } from "./dom.js";
import { sessionLog } from "./store.js";
import { renderActivity } from "../pages/activity.js";

/**
 * Copy to the clipboard, with a fallback.
 *
 * The async clipboard API rejects when the document is not focused, which is
 * easy to hit in practice — a click that lands while the window is being
 * focused, a pane the OS does not consider active — and it failed silently
 * here before the fallback existed. The selection-based path is deprecated
 * but works in exactly the cases the modern one refuses, so try the good one
 * first and keep the old one for when it says no.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the selection path */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function note(event, detail) {
  sessionLog.unshift({ at: Date.now(), event, detail });
  if (sessionLog.length > 200) sessionLog.length = 200;
  if ($("#shell").dataset.page === "activity") renderActivity();
}

/** Draw a toast's kind, title, detail and explorer link into its box. */
function drawToast(box, kind, title, detail, hash) {
  box.className = "toast " + kind;
  paint(box, html`<b>${title}</b>${detail || ""}${hash
      ? html`<br><a href="${EXPLORER + "/tx/" + hash}" target="_blank" rel="noopener noreferrer">${hash.slice(0, 18) + "… ↗"}</a>`
      : ""}`);
}

/** Let a toast fade and go, later for an error. */
function fadeToast(box, kind) {
  setTimeout(() => { box.style.opacity = "0"; setTimeout(() => box.remove(), 400); },
    kind === "err" ? 9000 : 6000);
}

export function toast(kind, title, detail, hash) {
  const box = document.createElement("div");
  drawToast(box, kind, title, detail, hash);
  $("#toasts").appendChild(box);
  fadeToast(box, kind);
}

/**
 * A toast that stays while something runs and changes in place, such as a
 * one-click trade's progress (public-release W3.1). `set` redraws it; `end`
 * draws its last state and lets it fade like any other; `drop` removes it at
 * once. After `end` or `drop`, nothing changes it.
 */
export function liveToast(kind, title, detail, hash) {
  const box = document.createElement("div");
  drawToast(box, kind, title, detail, hash);
  $("#toasts").appendChild(box);
  let over = false;
  return {
    set(k, t, d, h) { if (!over) drawToast(box, k, t, d, h); },
    end(k, t, d, h) {
      if (over) return;
      over = true;
      drawToast(box, k, t, d, h);
      fadeToast(box, k);
    },
    drop() { over = true; box.remove(); },
  };
}

// ------------------------------------------------------------- sheets --
//
// The redesign's sheet (u-redesign.md, U0), from the trading wallet's: a
// close ✕ in the header's corner, Esc, and focus kept inside while it is
// open. The look is app.css's (.modal, .mbox, .sheethd, .sheetx); what is
// here is the behaviour, for any sheet that asks for it with holdSheet.

/** A sheet's close, in its header's corner: named Close for a screen reader. */
export const CLOSE_X = html`<button class="sheetx" type="button" data-x aria-label="Close" title="Close (Esc)"><svg
  width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round"/></svg></button>`;

/**
 * A sheet's head: its title, named by `id` (the box's aria-labelledby), and
 * the ✕ in the corner. `x` false leaves the ✕ out, for a sheet that cannot be
 * closed at that moment (a trade being signed): the corner is then empty.
 *
 * @param {string} id
 * @param {any} title
 * @param {boolean} [x]
 */
export const sheetHead = (id, title, x = true) =>
  html`<div class="sheethd"><h3 id="${id}">${title}</h3>${x ? CLOSE_X : ""}</div>`;

/**
 * Every [data-x] in a sheet closes it: the ✕ in its head, and a Cancel or
 * Close among its buttons, which keep their words.
 *
 * @param {any} back
 * @param {() => unknown} close
 */
export function closeOn(back, close) {
  for (const x of new Set([$("[data-x]", back), ...$$("[data-x]", back)])) if (x) x.onclick = close;
}

/** What Tab may land on. */
const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),"
  + "textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

/** The held sheets, newest last. Only the top one hears the keys. */
const held = [];

/** Esc and Tab, for the top held sheet. */
function onSheetKey(e) {
  const top = held[held.length - 1];
  if (!top) return;
  // A sheet that is not held may be open over it; then the keys are that
  // sheet's business, not this one's. (Every sheet on the site is held since
  // U8, the share card's last; this stays for any that is not.)
  const scrims = document.querySelectorAll(".modal");
  if (scrims.length && scrims[scrims.length - 1] !== top.back) return;
  if (e.key === "Escape") {
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key !== "Tab") return;
  // Only what is shown: a hidden tab's pane keeps its buttons in the page.
  const box = top.box();
  const all = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  const at = document.activeElement;
  if (!all.length) {
    e.preventDefault();
    box.focus();
  } else if (!box.contains(at)) {
    e.preventDefault();
    all[0].focus();
  } else if (e.shiftKey && (at === all[0] || at === box)) {
    e.preventDefault();
    all[all.length - 1].focus();
  } else if (!e.shiftKey && at === all[all.length - 1]) {
    e.preventDefault();
    all[0].focus();
  }
}

/**
 * Hold an open sheet: Esc closes it, Tab and Shift+Tab go round inside it,
 * focus starts on `first` (or the box, which carries tabindex="-1") and goes
 * back where it was once the sheet closes. `back` is the scrim, already in
 * the page, and `close` what closing it does. Returns the release, which the
 * sheet's close calls; calling it twice does nothing.
 *
 * @param {any} back
 * @param {() => void} close
 * @param {any} [first]
 * @returns {() => void}
 */
export function holdSheet(back, close, first) {
  // The box is found at each key, not once: a sheet that repaints (the plan
  // sheet, the login sheet) has a new box after every step.
  const box = () => $(".mbox", back) ?? back;
  const before = /** @type {HTMLElement | null} */ (document.activeElement);
  const entry = { back, box, close };
  if (!held.length) document.addEventListener?.("keydown", onSheetKey);
  held.push(entry);
  (first ?? box()).focus?.();
  return () => {
    const at = held.indexOf(entry);
    if (at < 0) return;
    held.splice(at, 1);
    if (!held.length) document.removeEventListener?.("keydown", onSheetKey);
    if (before && before.isConnected) before.focus?.();
  };
}

/**
 * A held sheet that repaints its box (the plan sheet at each step, the login
 * sheet's wallet list) took the focused control away with the old box, and
 * focus is then on nothing. Put it on the new box, so Tab and a screen reader
 * stay in the sheet. Nothing moves while focus is still inside, or while
 * another sheet is over this one.
 *
 * @param {any} back
 */
export function refocus(back) {
  const top = held[held.length - 1];
  if (!top || top.back !== back) return;
  const box = $(".mbox", back);
  const at = document.activeElement;
  if (box && !(at && box.contains?.(at))) box.focus?.();
}

/**
 * A line from words.js with the sentence naming the site picked out: the part
 * a clone cannot show truthfully. The words themselves are left as they are.
 * Every money step's sheet shows it so (wallet, transfer, backup).
 */
export const siteIn = (line, origin) => {
  const at = origin ? line.indexOf(origin) : -1;
  if (at < 0) return line;
  const dot = line.lastIndexOf(". ", at);
  const from = dot < 0 ? 0 : dot + 2;
  const stop = line.indexOf(". ", at + origin.length);
  const to = stop < 0 ? line.length : stop + 1;
  return html`${line.slice(0, from)}<b class="twsite">${line.slice(from, to)}</b>${line.slice(to)}`;
};

/** A face for an address, two hues read from it: the same wallet always looks the same. */
export const faceOf = (/** @type {string} */ a) => {
  const h1 = parseInt(a.slice(2, 6), 16) % 360;
  const h2 = parseInt(a.slice(-4), 16) % 360;
  return `background:linear-gradient(135deg,hsl(${h1} 72% 62%),hsl(${h2} 68% 40%))`;
};

/** An address's avatar (.avatar, and "sm" or "lg"). A picture, so a screen reader skips it. */
export const avatar = (/** @type {string} */ address, size = "") =>
  html`<span class="${size ? `avatar ${size}` : "avatar"}" style="${faceOf(address)}" aria-hidden="true"></span>`;

let sheets = 0;

/**
 * @param {{
 *   title: string, body: any, confirmText: string,
 *   placeholder?: string, onConfirm: (...args: any[]) => unknown,
 * }} opts
 */
export function modal({ title, body, placeholder, confirmText, onConfirm }) {
  const back = document.createElement("div");
  back.className = "modal";
  const id = `sheet-${++sheets}`;
  paint(back, html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1">
      ${sheetHead(id, title)}<p>${body}</p>${placeholder
      ? html`<input type="password" placeholder="${placeholder}">` : ""}
      <div class="mbtns sheetacts"><button class="btn" data-x>Cancel</button>
        <button class="btn pri" data-ok>${confirmText}</button></div></div>`);
  let release = () => {};
  const close = () => { release(); back.remove(); };
  const input = $("input", back);
  const ok = $("[data-ok]", back);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  closeOn(back, close);
  ok.onclick = async () => {
    ok.textContent = "…";
    try { await onConfirm(input ? input.value : ""); } finally { close(); }
  };
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.click(); });
  document.body.appendChild(back);
  release = holdSheet(back, close, input || ok);
}
