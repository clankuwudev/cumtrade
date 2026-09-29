import { S } from "./core/store.js";
import { $ } from "./core/dom.js";
import { parseEth } from "./trade/sequence.js";
import { renderLaunches } from "./pages/launches.js";
import { renderToken } from "./pages/token.js";
import { openSearch, searchOpen } from "./pages/search.js";
import { renderQuickBuy, savePrefs } from "./trade.js";

// ====================================================================== //
// the frame (u-redesign.md, U1)                                          //
// ====================================================================== //
//
// What the top bar does beyond drawing: the buy-size popover, search's
// buttons and keys. The drawing is renderShell's (pages/shell.js) and the
// quick buy's (trade.js renderQuickBuy); the routes are router.js's.

/**
 * The quick-buy size every Buy button uses. The same steps as a click on a
 * size always took: the token panel's own amount is cleared, the size is
 * remembered, and whatever shows a Buy button is drawn again.
 *
 * @param {number} size
 */
export function setBuySize(size) {
  S.buySize = size;
  S.customAmount = "";
  savePrefs(); renderQuickBuy(); renderLaunches();
  if ($("#shell").dataset.page === "token") renderToken();
  // A size picked in the popover was redrawn under the pointer: focus stays
  // on the size now chosen, not on nothing.
  const pop = $("#sizepop");
  const lost = !document.activeElement || document.activeElement === document.body;
  if (pop && !pop.hidden && lost) { const on = pop.querySelector(".qsz.on"); if (on) on.focus(); }
}

/**
 * A typed quick-buy amount as a size, or null when it is not one: a plain
 * decimal above zero that stays the same decimal as a number, because a
 * hosted buy sends the size as text ("1e-7" is not an amount of ETH).
 *
 * @param {string} typed
 * @returns {number | null}
 */
export function customSize(typed) {
  const t = String(typed || "").trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = Number(t);
  if (!(v > 0) || /e/i.test(String(v))) return null;
  try { if (parseEth(String(v)) <= 0n) return null; } catch { return null; }
  return v;
}

/** Whether a key press is someone typing, which "/" must not interrupt. */
const typing = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

/** The buy-size popover: open, closed, and the custom amount in it. */
function bindSize() {
  const btn = $("#sizebtn"), pop = $("#sizepop"), custom = $("#qcustom");
  const show = (on) => {
    pop.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (on) { const pick = pop.querySelector(".qsz.on") || pop.querySelector(".qsz"); if (pick) pick.focus(); }
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); show(pop.hidden); });
  // A click anywhere else closes it; a click on a size inside it does not.
  document.addEventListener("click", (e) => {
    if (pop.hidden) return;
    const t = /** @type {any} */ (e.target);
    // A size clicked is redrawn before this hears the click: it was inside.
    if (t.isConnected && !t.closest("#sizepop") && !t.closest("#sizebtn")) show(false);
  });
  // Esc closes it, from inside it or from its button, and focus goes back to the button.
  const esc = (e) => {
    if (e.key !== "Escape" || pop.hidden) return;
    e.stopPropagation();
    show(false);
    btn.focus();
  };
  pop.addEventListener("keydown", esc);
  btn.addEventListener("keydown", esc);
  const takeCustom = () => {
    if (custom.value.trim() === "") return;
    const v = customSize(custom.value);
    custom.setAttribute("aria-invalid", String(v === null));
    if (v !== null) setBuySize(v);
  };
  custom.addEventListener("change", takeCustom);
  custom.addEventListener("keydown", (e) => { if (e.key === "Enter") takeCustom(); });
  custom.addEventListener("input", () => custom.removeAttribute("aria-invalid"));
}

/** Search's buttons, and Ctrl+K / Cmd+K and "/" from anywhere. */
function bindSearch() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  $("#searchkey").textContent = mac ? "⌘K" : "Ctrl K";
  document.addEventListener("click", (e) => {
    if (/** @type {any} */ (e.target).closest("[data-search]")) openSearch();
  });
  document.addEventListener("keydown", (e) => {
    const k = String(e.key || "").toLowerCase();
    const combo = k === "k" && (e.metaKey || e.ctrlKey) && !e.altKey;
    const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(document.activeElement);
    if (!combo && !slash) return;
    // Another sheet open (a plan, a login) keeps the keys.
    if (!combo && document.querySelector(".modal")) return;
    e.preventDefault();
    if (!searchOpen() && !document.querySelector(".modal")) openSearch();
  });
}

/** Wire the top bar. Once, at boot. */
export function bindFrame() {
  bindSize();
  bindSearch();
}
