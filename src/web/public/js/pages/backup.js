import { S } from "../core/store.js";
import { $, html, paint } from "../core/dom.js";
import { closeOn, holdSheet, sheetHead, siteIn } from "../core/ui.js";
import { backup as confirmations, createBackupFlow } from "../wallet/backup.js";
import { session } from "../wallet/session.js";
import { betaLine, here } from "../wallet/words.js";

// ====================================================================== //
// the backup sheet                                                       //
// ====================================================================== //
//
// The required backup at setup (public-release W4). Coinbase's export frame
// sits in a container this sheet never repaints: repainting it would remove
// the frame. Its status words go into a line of their own. The key is copied
// by the frame, on Coinbase's origin, and never reaches this page.
//
// The sheet opens by itself once per page load for each trading address this
// browser holds no confirmation for, and from the chip's "Back up key" at any
// time. Until the visitor confirms, buys, sells and funding wait (trade.js);
// a withdraw never does.

/** @type {{ address: string, again: boolean, close: () => void } | null} */
let open = null;
/** Addresses whose sheet opened by itself on this page load, lowercased. */
const offered = new Set();

const lower = (a) => String(a).toLowerCase();

/**
 * The frame's status line: its words, and the button it offers, if any
 * ("retry" after an error, "again" after the frame expired).
 *
 * @param {{ frame: string, message: string, copied: boolean }} st
 * @returns {{ text: string, action: "retry" | "again" | null }}
 */
export function statusWords(st) {
  const copied = st.copied ? " Your copy still counts." : "";
  switch (st.frame) {
    case "loading": return { text: "Loading Coinbase's button…", action: null };
    case "copying": return { text: "Copying…", action: null };
    case "expiring": return { text: st.copied ? "Copied. Coinbase's button expires soon." : "Coinbase's button expires soon. Copy your key now.", action: null };
    case "expired": return { text: `Coinbase's button expired.${copied}`, action: "again" };
    case "error": return { text: `Coinbase's button could not copy your key${st.message ? `: ${st.message}` : "."}${copied}`, action: "retry" };
    case "failed": return { text: `Coinbase's button could not load${st.message ? `: ${st.message}` : "."}${copied}`, action: "retry" };
    default: return {
      text: st.copied ? "Copied. Paste it into your password manager now." : "Press Coinbase's button to copy your key.",
      action: null,
    };
  }
}

/**
 * The sheet's markup, in the spec's order: the warning, what the key is, the
 * frame, the clipboard, then the checkbox and Continue. Exporting again, once
 * confirmed, has no checkbox.
 *
 * @param {string} address
 * @param {{ again: boolean, origin: string }} o
 */
export function sheetMarkup(address, { again, origin }) {
  return html`<div class="mbox bksheet" role="dialog" aria-modal="true" aria-labelledby="bk-title" tabindex="-1">
      ${sheetHead("bk-title", again ? "Export your key" : "Back up your key")}
      <p class="twsitel">${siteIn(betaLine(origin), origin)}</p>
      <div class="callout warn"><span>Your trading wallet has a private key. Anyone who has it controls the wallet. It is also your
        only way back in if Coinbase's service fails.</span></div>
      <div class="sheetcard"><div class="wrow"><span class="k">Wallet</span><span class="v mo">${address}</span></div></div>
      <div data-export class="bkframe"></div>
      <p data-export-status class="bkstatus" role="status">${statusWords({ frame: "loading", message: "", copied: false }).text}</p>
      <p>Paste it into your password manager now, then copy something else so it leaves your clipboard.</p>
      <p class="sheetnote">To check it, import it into MetaMask or Rabby. It should show ${address}.</p>
      ${again ? "" : html`
      <label class="sheetcheck">
        <input type="checkbox" data-saved disabled>
        <span>I saved my key somewhere only I can reach</span></label>
      <p class="bkalready">Saved it before, in another browser?
        <button class="btn sm ghost" type="button" data-already>I already saved it</button></p>`}
      <div class="mbtns sheetacts">
        <button class="btn" type="button" data-x>Close</button>
        ${again ? "" : html`<button class="btn pri" type="button" data-ok disabled>Continue</button>`}
      </div>
    </div>`;
}

/**
 * Open the backup sheet for the logged-in trading wallet. Nothing opens when
 * logged out, or while a sheet is already open.
 *
 * @param {{ mount?: (el: any, onStatus: (status: string, message?: string) => void) => Promise<() => void>, origin?: string }} [d] tests pass their own
 */
export function openBackup(d = {}) {
  const t = S.trading;
  if (!t || open) return null;
  const address = t.address;
  const again = confirmations.confirmed(address);
  const back = document.createElement("div");
  back.className = "modal";
  paint(back, sheetMarkup(address, { again, origin: d.origin ?? here() }));

  const frameEl = $("[data-export]", back);
  const statusEl = $("[data-export-status]", back);
  const box = $("[data-saved]", back);
  const ok = $("[data-ok]", back);
  const already = $("[data-already]", back);

  const flow = createBackupFlow({
    address,
    mount: d.mount ?? ((el, onStatus) => session.mountExport(el, onStatus)),
    backup: confirmations,
    onChange: () => draw(),
  });

  function draw() {
    const st = flow.state();
    const w = statusWords(st);
    paint(statusEl, html`${w.text}${w.action ? html` <button class="btn sm" type="button" data-remount>${
      w.action === "again" ? "Show the button again" : "Try again"}</button>` : ""}`);
    const remount = $("[data-remount]", statusEl);
    if (remount) remount.onclick = () => void flow.mount(frameEl);
    if (box) box.disabled = !flow.canTick();
    if (ok) ok.disabled = !flow.canContinue();
    if (already) already.disabled = st.already;
  }

  // Once: Continue's confirmation also reaches `offerBackup`, which closes a
  // sheet that is no longer needed, before Continue itself does.
  let shut = false;
  /** Esc and the focus held inside, from ui.js; set once the sheet is in the page. */
  let release = () => {};
  const close = () => {
    if (shut) return;
    shut = true;
    release();
    flow.close();
    back.remove();
    if (open && open.close === close) open = null;
  };
  open = { address, again, close };

  if (box) box.onchange = () => flow.tick(box.checked);
  if (already) already.onclick = () => flow.alreadySaved();
  if (ok) ok.onclick = () => { if (flow.finish()) close(); };
  closeOn(back, close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  // The frame needs its container in the page before it loads.
  document.body.appendChild(back);
  release = holdSheet(back, close);
  draw();
  void flow.mount(frameEl);
  return { flow, close };
}

/**
 * The trading wallet shown may have changed: log in, out, another address,
 * or a confirmation from another tab. Close a sheet that is no longer this
 * wallet's, or no longer needed, and open it once per page load for an
 * address this browser holds no confirmation for.
 *
 * @param {Parameters<typeof openBackup>[0]} [d] passed on to `openBackup`, for tests
 */
export function offerBackup(d) {
  const t = S.trading;
  if (open) {
    const stale = !t || lower(open.address) !== lower(t.address);
    const settled = !open.again && confirmations.confirmed(open.address);
    if (stale || settled) open.close();
  }
  if (!t || !S.login.here || S.login.phase !== "idle") return;
  const a = lower(t.address);
  if (offered.has(a) || confirmations.confirmed(t.address)) return;
  offered.add(a);
  openBackup(d);
}

/**
 * Keep the page in step with the confirmations, from this tab or another
 * (through the `storage` event): an open sheet closes once it is not needed,
 * and `rerender` redraws every reason. Called on a page with a trading
 * wallet only. Returns a function that stops it.
 *
 * @param {() => void} rerender
 */
export function watchBackups(rerender) {
  const off = confirmations.on(() => { offerBackup(); rerender(); });
  const heard = (e) => confirmations.heard(e.key);
  window.addEventListener("storage", heard);
  return () => { off(); window.removeEventListener("storage", heard); };
}

/** Whether a backup sheet is open now (for tests). */
export const backupOpen = () => open !== null;
