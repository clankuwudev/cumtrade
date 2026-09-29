// cumAI's login to the trading wallet (stage C, C5c; the user: "Log in on
// cumAI too"). It is cumOS's own session (wallet/sessionCore.js), with this
// page's parts:
// - its own state, and the console's acknowledgement, under cumOS's key and
//   in cumOS's words: accepted on either page, it is accepted on both;
// - the visitor's own wallets (EIP-6963), for a login with a wallet;
// - the trading wallet with no chain. Here it signs cumAI's sign-in through
//   the facade (C3) and nothing else: its provider reads and sends nothing,
//   so no transaction can leave this page, and nothing asks the chain.
// Same origin, so it is the same session as cumOS's: the same marks, the
// same tabs' channel, the same 30-minute lock, and a logout on either page
// is a logout on both.
import { $, html, paint } from "../js/core/dom.js";
import { start } from "../js/wallet/embedded.js";
import { createSession } from "../js/wallet/sessionCore.js";
import { ownAccount } from "./wallets.js";
import { TRADING_ACK } from "./words.js";

/** The trading wallet's provider on cumAI: it answers nothing, so nothing is read or sent on chain here. */
export const NO_CHAIN = Object.freeze({
  request: async () => { throw Object.assign(new Error("cumAI reads and sends nothing on chain."), { code: 4200 }); },
});

/** Start the trading wallet as cumOS does, with the chain taken away. */
export async function startHere(load = start) {
  const w = await load();
  return { facade: w.facade, provider: NO_CHAIN };
}

/**
 * The visitor's own wallets as the session's door for a wallet login: the
 * one picked by its id, asked for its account.
 * @param {() => { uuid: string, provider: any }[]} wallets
 */
export function ownDoor(wallets) {
  let current = null;
  return {
    async connect(uuid) {
      const w = wallets().find((x) => x.uuid === uuid);
      if (!w) throw new Error("That wallet isn't in this browser any more.");
      const address = await ownAccount(w.provider);
      current = w.provider;
      return address;
    },
    provider: () => current,
  };
}

/**
 * The acknowledgement before the first login to a trading wallet (W1.2), as
 * cumOS asks it, in the console's look: a box to tick, then Continue. Cancel,
 * Esc and the scrim go no further. Remembered under cumOS's key.
 * @param {{ storage?: () => (Storage | null) }} [o]
 */
export function acknowledgeHere({ storage = () => globalThis.localStorage } = {}) {
  let thisLoad = false;
  const remembered = () => {
    try { return storage()?.getItem(TRADING_ACK.key) === "1"; } catch { return thisLoad; }
  };
  const remember = () => {
    thisLoad = true;
    try { storage()?.setItem(TRADING_ACK.key, "1"); } catch { /* this page load only */ }
  };
  return function ask() {
    if (thisLoad || remembered()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "cai-modal";
      paint(back, html`<div class="cai-mbox" role="dialog" aria-modal="true" aria-labelledby="cai-ack-title">
        <h3 id="cai-ack-title">${TRADING_ACK.title}</h3>
        <p class="cai-mwarn">${TRADING_ACK.body}</p>
        <label class="cai-mcheck"><input type="checkbox" data-ack> <span>I understand</span></label>
        <div class="cai-macts"><button class="cai-small-btn" type="button" data-x>Cancel</button><button class="cai-btn cai-btn-amber" type="button" data-ok disabled>Continue</button></div>
      </div>`);
      const before = document.activeElement;
      let over = false;
      const done = (ok) => {
        if (over) return;
        over = true;
        document.removeEventListener("keydown", esc, true);
        back.remove();
        if (before && document.contains(before)) /** @type {HTMLElement} */ (before).focus();
        resolve(ok);
      };
      const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
      const box = $("[data-ack]", back);
      const ok = $("[data-ok]", back);
      box.addEventListener("change", () => { ok.disabled = !box.checked; });
      ok.addEventListener("click", () => { if (!box.checked) return; remember(); done(true); });
      $("[data-x]", back).addEventListener("click", () => done(false));
      back.addEventListener("click", (e) => { if (e.target === back) done(false); });
      document.addEventListener("keydown", esc, true);
      document.body.append(back);
      box.focus();
    });
  };
}

/**
 * cumAI's session: cumOS's machine, with this page's parts. Inert until
 * `boot()`, which picks up a remembered session, or a return from Google or X.
 * @param {{ wallets: () => { uuid: string, provider: any }[] }} o
 */
export function createLogin({ wallets }) {
  const state = { trading: null, login: { here: false, phase: "idle", countdown: null, waiting: false } };
  const session = createSession({ state, acknowledge: acknowledgeHere(), main: ownDoor(wallets), start: () => startHere() });
  return { session, state };
}
