import { keccak256 } from "../trade/keccak.js";

// ====================================================================== //
// the backup at setup                                                    //
// ====================================================================== //
//
// Before a new trading wallet is funded or trades, the visitor copies its
// private key once from Coinbase's export frame, and confirms they saved it
// (public-release W4, TW8). The key never enters this page: the frame is
// Coinbase's, on Coinbase's origin, and it puts the key on the clipboard
// itself. The page only hears its status words.
//
// Two parts, neither with a DOM:
// - the confirmation, per address, remembered in this browser;
// - one sheet's flow: mount the frame, follow its status, and say when the
//   checkbox and Continue may be used.
//
// Storage holds a hash of the address, never the address (W1.2 keeps every
// address out of storage). Without storage, a confirmation lasts this page
// load, and the next one asks again: "I already saved it" is enough then.

/** Every confirmation's storage key starts with this. */
export const BACKUP_PREFIX = "clank.backup.";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The storage key for an address's confirmation: its keccak256, not the address. */
export const backupKey = (address) => BACKUP_PREFIX + keccak256(address.slice(2).toLowerCase());

/**
 * The confirmations, per address.
 *
 * @param {{ storage?: () => (Storage | null) }} [d] tests pass their own storage
 */
export function createBackup(d = {}) {
  /** This browser's storage. It may be missing, or throw when reached: every use is inside a try. */
  const storage = () => (d.storage ? d.storage() : globalThis.localStorage);
  /** Keys confirmed on this page load, whatever storage did with them. */
  const thisLoad = new Set();
  /** An address's key, worked out once: every card asks at every repaint. */
  const keys = new Map();
  const listeners = new Set();

  const keyOf = (address) => {
    if (!keys.has(address)) keys.set(address, backupKey(address));
    return keys.get(address);
  };
  const emit = () => { for (const fn of listeners) fn(); };

  /** Whether this browser holds a confirmation for `address`. Never throws. */
  function confirmed(address) {
    if (typeof address !== "string" || !ADDRESS.test(address)) return false;
    const k = keyOf(address);
    if (thisLoad.has(k)) return true;
    try { return storage().getItem(k) === "1"; } catch { return false; /* none, or blocked */ }
  }

  /** Record that the visitor saved `address`'s key: in storage, and for this page load whatever storage does. */
  function confirm(address) {
    if (typeof address !== "string" || !ADDRESS.test(address)) throw new Error("No trading wallet to confirm.");
    const k = keyOf(address);
    thisLoad.add(k);
    try { storage().setItem(k, "1"); } catch { /* none, full or blocked: this page load still counts it */ }
    emit();
  }

  /**
   * A `storage` event: another tab wrote `key`. Only a confirmation matters,
   * and the listeners read it back themselves.
   *
   * @param {string | null} key
   */
  function heard(key) {
    if (typeof key === "string" && key.startsWith(BACKUP_PREFIX)) emit();
  }

  return {
    confirmed, confirm, heard,
    /** Hear every confirmation, here or in another tab. */
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** The page's own confirmations. */
export const backup = createBackup();

// ------------------------------------------------------------ the sheet --

/**
 * One backup sheet's flow, with no DOM. `mount(element, onStatus)` is the
 * session's `mountExport`: it puts Coinbase's frame in `element` for the
 * logged-in address and resolves to a function that removes it.
 *
 * The frame's states: "loading" (asked for), "ready" (Coinbase's button
 * shows), "copying", "expiring", "expired" (the SDK removed it), "error" (it
 * reported one) and "failed" (it could not be mounted). `copied` stays true
 * once a copy succeeded, whatever the frame does after.
 *
 * @param {{
 *   address: string,
 *   mount: (element: any, onStatus: (status: string, message?: string) => void) => Promise<() => void>,
 *   backup: { confirmed: (a: string) => boolean, confirm: (a: string) => void },
 *   onChange?: (state: object) => void,
 * }} d
 */
export function createBackupFlow(d) {
  const st = { frame: "loading", message: "", copied: false, already: false, ticked: false, done: false };
  let cleanup = null;
  let closed = false;
  /** Which mount is the current one: a status from an older frame is not this one's. */
  let generation = 0;

  const change = () => { if (d.onChange) d.onChange({ ...st }); };

  function removeFrame() {
    const c = cleanup;
    cleanup = null;
    if (c) try { c(); } catch { /* already gone */ }
  }

  /** Mount a frame in `element`, replacing any earlier one. */
  async function mount(element) {
    if (closed) return;
    removeFrame();
    const mine = ++generation;
    Object.assign(st, { frame: "loading", message: "" });
    change();
    const onStatus = (status, message) => {
      if (closed || mine !== generation) return;
      heard(status, message);
    };
    let c;
    try {
      c = await d.mount(element, onStatus);
    } catch (e) {
      if (closed || mine !== generation) return;
      Object.assign(st, { frame: "failed", message: String(e?.message ?? e) });
      change();
      return;
    }
    // Closed, or mounted again, while Coinbase was answering: this frame is not wanted.
    if (closed || mine !== generation) { try { c(); } catch { /* gone */ } return; }
    cleanup = c;
  }

  /** A status word from the frame. Words only: the key never comes with one. */
  function heard(status, message) {
    if (status === "ready") Object.assign(st, { frame: "ready", message: "" });
    else if (status === "pending") Object.assign(st, { frame: "copying", message: "" });
    else if (status === "success") Object.assign(st, { frame: "ready", message: "", copied: true });
    else if (status === "error") Object.assign(st, { frame: "error", message: typeof message === "string" ? message : "" });
    else if (status === "expiring") Object.assign(st, { frame: "expiring", message: "" });
    else if (status === "expired") { cleanup = null; Object.assign(st, { frame: "expired", message: "" }); }
    else return;
    change();
  }

  /** Whether the checkbox may be ticked: after a copy, or "I already saved it". Neither is ever undone. */
  const canTick = () => st.copied || st.already;
  /** Whether Continue may be pressed. A tick implies `canTick`. */
  const canContinue = () => st.ticked && !st.done;

  return {
    mount,
    state: () => ({ ...st }),
    canTick,
    canContinue,
    /** "I already saved it": the new-browser case. The checkbox is still required. */
    alreadySaved() { st.already = true; change(); },
    /** The checkbox. It cannot be ticked before a copy or "I already saved it". */
    tick(on) {
      st.ticked = !!on && canTick();
      change();
    },
    /** Continue: record the confirmation for this address, and remove the frame. True when it was recorded. */
    finish() {
      if (!canContinue()) return false;
      d.backup.confirm(d.address);
      st.done = true;
      removeFrame();
      closed = true;
      change();
      return true;
    },
    /** The sheet is closing, done or not: remove the frame, and hear nothing more. */
    close() {
      closed = true;
      removeFrame();
    },
  };
}
