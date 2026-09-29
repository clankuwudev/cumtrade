import { S } from "./core/store.js";
import { $, $$ } from "./core/dom.js";
import { renderFlow } from "./pages/flow.js";
import { renderLaunches } from "./pages/launches.js";
import { renderPositions } from "./pages/positions.js";
import { renderShell } from "./pages/shell.js";
import { renderSniper } from "./pages/sniper.js";
import { loadHistory, renderToken } from "./pages/token.js";

// ====================================================================== //
// wiring                                                                 //
// ====================================================================== //

export const CHIP_TARGET = {
  pchips: ["#pgrid", "f"], schips: ["#dfeed", "f"],
};

/**
 * Mark the chosen chip of a console filter row. The chips are buttons (U8),
 * and U0's .chip[aria-pressed=true] inverts the chosen one, as the board's.
 */
export function mark(scope, chip) {
  for (const c of $$(scope + " .chip")) c.setAttribute("aria-pressed", String(c === chip));
}

/**
 * One flash on the board row, or the Columns view's cards, of a launch that
 * has just landed, so the board reads as live without anything else moving.
 * A row the filter hides has nothing to flash. The mark comes off when the
 * flash ends: a card moves between places in its column as its figures
 * change, and a moved element would play its animation again.
 */
export function flash(token) {
  const t = CSS.escape(token);
  for (const el of $$(`#lrows tr[data-token="${t}"], #lcols .bmini[data-token="${t}"]`)) {
    el.classList.add("new");
    el.addEventListener("animationend", () => el.classList.remove("new"), { once: true });
  }
}

export function renderAll() {
  renderShell(); renderLaunches();
  renderPositions(); renderSniper(); renderFlow();
  // Covers a reload landing directly on a /token/ link: the page is drawn
  // before any row exists, and only the snapshot can fill it in.
  if ($("#shell").dataset.page === "token") {
    renderToken();
    if (S.openToken && S.histFor !== String(S.openToken).toLowerCase()) void loadHistory(S.openToken);
  }
}
