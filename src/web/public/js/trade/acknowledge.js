import { $, html, paint } from "../core/dom.js";
import { closeOn, holdSheet, sheetHead } from "../core/ui.js";

// ====================================================================== //
// the acknowledgement                                                    //
// ====================================================================== //
//
// Asked once per browser, before the first trade is prepared. It needs a
// ticked box, not just a click. Moved here from F5.3 so that signing never
// exists without it (public-release F3.2); F5.3 keeps the About and terms
// pages. Without storage (a private window, blocked site data) it asks once
// per page load instead.
//
// The trading wallet has its own (W1.2), asked at the first login rather than
// the first trade: once logged in, that wallet signs with no pop-up, so the
// moment to say so is before the login.
//
// A sheet of the family (U7): the head with its ✕, the words as a warning
// callout, the box to tick, then Cancel and Continue. Continue stays disabled
// until the box is ticked, and checks it again when pressed. The ✕, Esc and
// the scrim are Cancel: nothing is remembered and nothing goes ahead.

/** What the trading wallet's acknowledgement says (W1.2). */
export const TRADING_WARNING = "This wallet signs trades without asking you. Anyone who controls this " +
  "page's code, or this browser while you are logged in, can move what is in it. Keep here only what you " +
  "are ready to trade. Verdicts are automated and can be wrong.";

/**
 * One acknowledgement: remembered under `key`, or for this page load alone
 * when storage is unavailable.
 *
 * @param {string} key
 * @param {string} title
 * @param {string} body
 */
function acknowledgement(key, title, body) {
  let thisLoad = false;
  const remembered = () => {
    try { return localStorage.getItem(key) === "1"; } catch { return thisLoad; }
  };
  const remember = () => {
    thisLoad = true;
    try { localStorage.setItem(key, "1"); } catch { /* this page load only */ }
  };

  /** Resolve true once the visitor has accepted, now or before. */
  return function ask() {
    if (thisLoad || remembered()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "modal";
      paint(back, html`<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="ack-title" tabindex="-1">
          ${sheetHead("ack-title", title)}
          <div class="callout warn"><span>${body}</span></div>
          <label class="sheetcheck">
            <input type="checkbox" data-ack>
            <span>I understand</span></label>
          <div class="mbtns sheetacts">
            <button class="btn" type="button" data-x>Cancel</button>
            <button class="btn pri" type="button" data-ok disabled>Continue</button>
          </div>
        </div>`);
      /** Esc and the focus held inside (ui.js); focus goes back to what asked. */
      let release = () => {};
      let over = false;
      const done = (ok) => {
        if (over) return;
        over = true;
        release();
        back.remove();
        resolve(ok);
      };
      const box = $("[data-ack]", back);
      const ok = $("[data-ok]", back);
      box.addEventListener("change", () => { ok.disabled = !box.checked; });
      ok.onclick = () => { if (!box.checked) return; remember(); done(true); };
      closeOn(back, () => done(false));
      back.addEventListener("click", (e) => { if (e.target === back) done(false); });
      document.body.appendChild(back);
      // Focus starts on the box to tick, as it always did.
      release = holdSheet(back, () => done(false), box);
    });
  };
}

/** Before the first trade from the visitor's own wallet (F3.2). */
export const acknowledge = acknowledgement("clank.ack", "Before your first trade",
  "Your wallet signs every transaction. This site holds no keys and cannot undo a trade. " +
  "Verdicts are automated and can be wrong.");

/** Before the first login to a trading wallet (W1.2), and again before a trade from it if it was not given. */
export const acknowledgeTrading = acknowledgement("clank.ack.tw", "Your trading wallet", TRADING_WARNING);
