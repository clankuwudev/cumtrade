import { S, rows } from "./core/store.js";
import { renderLaunches } from "./pages/launches.js";
import { renderShell } from "./pages/shell.js";
import { checks, loadHistory, onTokenTrade, renderTokenIfOpen } from "./pages/token.js";
import { flash, renderAll } from "./wiring.js";

// The board's events from the server's stream, applied to the page's rows.
// Apart from main.js, which opens the stream when it loads, so a test can
// drive them (public-release B4.1c).

const lower = (t) => String(t || "").toLowerCase();
const isOpen = (token) => !!S.openToken && lower(S.openToken) === lower(token);

/**
 * Apply one board event: `snapshot`, `row`, `evict` or `trade`.
 *
 * @param {string} type
 * @param {any} data
 */
export function onBoardEvent(type, data) {
  if (type === "snapshot") {
    // The server's whole board, so cards it no longer has go (B4.1c): a
    // reconnect after a token dropped off must not bring its card back.
    rows.clear();
    for (const r of data) rows.set(lower(r.token), r);
    S.connected = true;
    S.boardReady = true;
    renderAll();
    return;
  }

  if (type === "row") {
    const known = rows.has(lower(data.token));
    rows.set(lower(data.token), data);
    renderLaunches(); renderShell();
    // A dashboard open on this token should move with it, including its chart.
    if (isOpen(data.token)) {
      renderTokenIfOpen();
      void loadHistory(data.token);
    }
    if (!known) flash(data.token);
    return;
  }

  if (type === "trade") {
    // Every token's trades come to every page (X25a E8): only the open
    // token's is kept, by its page.
    if (isOpen(data.token)) onTokenTrade(data);
    return;
  }

  if (type === "evict") {
    // The token dropped off the board (B4.1). Its card goes; its page, if
    // open, checks it afresh, which on a hosted page answers that it is off
    // the board, so it trades from the check (B5.1b). A check from before it
    // dropped said it was on the board, so it is not kept.
    if (!rows.delete(lower(data.token))) return;
    if (isOpen(data.token) && S.mode === "hosted") checks.delete(lower(data.token));
    renderLaunches(); renderShell();
    if (isOpen(data.token)) renderTokenIfOpen();
  }
}
