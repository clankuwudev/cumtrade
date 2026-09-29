import { rows } from "../core/store.js";
import { $, html, paint } from "../core/dom.js";
import { bandOf, initials, ringColor } from "../core/domain.js";
import { n, short, usd } from "../core/format.js";
import { ring } from "../core/svg.js";
import { holdSheet } from "../core/ui.js";
import { go } from "../router.js";

// ====================================================================== //
// search (u-redesign.md, U1)                                             //
// ====================================================================== //
//
// Search is the checker. One palette, opened from the top bar, the phone's
// tab bar, Ctrl+K / Cmd+K or "/": it lists the board's tokens by symbol or
// name (the largest by market cap when nothing is typed), and a pasted
// address opens that token's page, which runs the deep check when the token
// is not on the board (U4).

/** How many results the palette lists. */
export const SEARCH_LIMIT = 8;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * What the palette lists for what was typed: a heading, and items that are
 * either a board row (`row`) or an address to check (`check`).
 *
 * @param {string} query
 * @param {Iterable<any>} [board] the board's rows (store.rows by default)
 * @returns {{ heading: string, items: ({ row: any } | { check: string })[] }}
 */
export function searchResults(query, board = rows.values()) {
  const q = String(query || "").trim();
  const all = [...board];
  const mcap = (a, b) => n(b.fdvEth) - n(a.fdvEth);
  if (ADDRESS.test(q)) {
    const a = q.toLowerCase();
    const hit = all.find((r) => String(r.token).toLowerCase() === a || String(r.curve || "").toLowerCase() === a);
    return hit ? { heading: "On the board", items: [{ row: hit }] }
      : { heading: "Not on the board", items: [{ check: q }] };
  }
  if (!q) return { heading: "Top by market cap", items: all.sort(mcap).slice(0, SEARCH_LIMIT).map((row) => ({ row })) };
  const low = q.toLowerCase();
  const sym = (r) => String(r.symbol || "").toLowerCase();
  const matches = all.filter((r) => sym(r).includes(low) || String(r.name || "").toLowerCase().includes(low)
    || (low.startsWith("0x") && String(r.token).toLowerCase().startsWith(low)));
  // A symbol that starts with what was typed first, then by market cap.
  const rank = (r) => (sym(r) === low ? 0 : sym(r).startsWith(low) ? 1 : 2);
  matches.sort((a, b) => rank(a) - rank(b) || mcap(a, b));
  return { heading: "Tokens", items: matches.slice(0, SEARCH_LIMIT).map((row) => ({ row })) };
}

/** Go where an item leads: a token's page, which checks an address not on the board. */
function openItem(item) {
  go("token/" + ("check" in item ? item.check : item.row.token));
}

/** One result, as an option of the list. */
function itemMarkup(item, i, sel) {
  const id = `sr-${i}`;
  if ("check" in item) {
    return html`<div class="sritem" role="option" id="${id}" data-i="${i}" aria-selected="${i === sel}">
        <span class="srq" aria-hidden="true">?</span>
        <span class="srname"><b>Check ${short(item.check)}</b><span>Runs the full check on this address</span></span>
        <span class="srend" aria-hidden="true">↵</span></div>`;
  }
  const r = item.row;
  const [cls, words] = bandOf(r);
  return html`<div class="sritem" role="option" id="${id}" data-i="${i}" aria-selected="${i === sel}">
      ${ring(30, r.graduated ? 1 : r.progress, ringColor(r), initials(r.symbol), r.logo ? r.token : "")}
      <span class="srname"><b>${r.symbol || short(r.token)}</b><span>${r.name || short(r.token)}</span></span>
      <span class="srend">${r.status === "ready" ? usd(r.fdvEth) : ""}<span class="bd band ${cls}">${words}</span></span></div>`;
}

let open = false;

/** Open the search palette. Esc, a click outside or opening a result closes it. */
export function openSearch(initial = "") {
  if (open) return;
  open = true;
  const back = document.createElement("div");
  back.className = "modal srback";
  paint(back, html`<div class="mbox palette" role="dialog" aria-modal="true" aria-label="Search" tabindex="-1">
      <label class="srin"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5"
        stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round"/></svg><input id="srq" type="text" role="combobox" aria-expanded="true" aria-controls="srlist"
        aria-autocomplete="list" placeholder="Search a token, or paste any token or curve address" aria-label="Search"
        spellcheck="false" autocomplete="off"><kbd class="kbd">Esc</kbd></label>
      <div class="srhead" id="srhead"></div>
      <div class="srlist" id="srlist" role="listbox" aria-labelledby="srhead"></div>
      <div class="srfoot"><span>↑↓ to move</span><span>↵ to open</span><span class="sp"></span><span>Any address gets the full check</span></div>
    </div>`);
  const input = $("#srq", back), list = $("#srlist", back), head = $("#srhead", back);
  input.value = initial;
  let sel = 0;
  /** @type {({ row: any } | { check: string })[]} */
  let items = [];

  const draw = () => {
    const res = searchResults(input.value);
    items = res.items;
    sel = Math.max(0, Math.min(sel, items.length - 1));
    head.textContent = res.heading;
    paint(list, items.length ? items.map((it, i) => itemMarkup(it, i, sel))
      : html`<p class="srnone">Nothing on the board matches. Paste an address to check any token.</p>`);
    if (items.length) input.setAttribute("aria-activedescendant", "sr-" + sel);
    else input.removeAttribute("aria-activedescendant");
    const on = $(`#sr-${sel}`, list);
    if (on && typeof on.scrollIntoView === "function") on.scrollIntoView({ block: "nearest" });
  };

  let release = () => {};
  const close = () => {
    if (!open) return;
    open = false;
    release();
    back.remove();
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    openItem(it);
  };

  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
  });
  list.addEventListener("click", (e) => {
    const it = /** @type {any} */ (e.target).closest("[data-i]");
    if (it) choose(Number(it.dataset.i));
  });
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  draw();
  document.body.appendChild(back);
  release = holdSheet(back, close, input);
}

/** Whether the palette is open. */
export const searchOpen = () => open;
