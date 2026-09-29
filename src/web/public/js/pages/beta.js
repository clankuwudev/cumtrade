import { S } from "../core/store.js";
import { $ } from "../core/dom.js";
import { STAGE } from "../core/constants.js";

// ====================================================================== //
// the beta badge and notice (public-release F5.3, the user, 2026-09-23)  //
// ====================================================================== //
//
// Hosted only. Both are in app.html, marked data-hosted-only and `hidden`, so
// a self page never shows them and a hosted page shows them only once this
// has run: the badge takes its words from STAGE, and the notice stays hidden
// in a browser that closed it. With STAGE "" neither shows.

/** Where this browser remembers that it closed the notice. */
export const BETA_DISMISSED = "clank.beta";

/** Closed on this page load, for a browser whose storage fails. */
let closedThisLoad = false;

/** Whether this browser closed the notice. Storage that fails falls back to this page load. */
function dismissed() {
  try { return localStorage.getItem(BETA_DISMISSED) === "1" || closedThisLoad; } catch { return closedThisLoad; }
}

/** Close the notice: for good in this browser, or for this page load when storage fails. */
export function dismissBeta() {
  closedThisLoad = true;
  const bar = $("#betabar");
  if (bar) bar.hidden = true;
  try { localStorage.setItem(BETA_DISMISSED, "1"); } catch { /* this page load only */ }
}

/** Show the badge and, unless this browser closed it, the notice. */
export function showBeta() {
  if (S.mode !== "hosted" || !STAGE) return;
  const badge = $("#stagebadge");
  if (badge) {
    badge.textContent = STAGE;
    badge.hidden = false;
  }
  const bar = $("#betabar");
  if (!bar) return;
  bar.hidden = dismissed();
  const close = $("#betaclose");
  if (close) close.onclick = dismissBeta;
}
