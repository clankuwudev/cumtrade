import { S } from "./core/store.js";
import { html } from "./core/dom.js";
import { XI, eth, n, short } from "./core/format.js";

// ====================================================================== //
// the console's wallets (docs/specs/multi-wallet.md)                     //
// ====================================================================== //
//
// A self page only. The console can hold several wallets; a buy is split
// across the ones ticked here, and a sell goes out from one or all of them.
// They are for the operator's own trades: the sniper stays on main.
// With main alone every control below draws nothing, so a console with one
// wallet looks exactly as it did. A hosted page never has `S.wallet`.

const TICKS_KEY = "clank.wallets";

/**
 * Every wallet the console holds, main first, from `/api/wallet`.
 *
 * @returns {{ label: string, address: string, main: boolean,
 *   unlocked: boolean, error: string | null, balanceEth: string | null }[]}
 */
export const walletList = () =>
  S.mode === "self" && S.wallet && Array.isArray(S.wallet.wallets) ? S.wallet.wallets : [];

/** More than one wallet: only then does the page show wallet controls. */
export const multi = () => walletList().length > 1;

/** The wallets that can sign right now. */
export const openWallets = () => walletList().filter((w) => w.unlocked);

/** @type {Set<string> | null} */
let ticked = null;

/** The ticks this browser remembers. Main alone until something else is ticked. */
function ticks() {
  if (ticked) return ticked;
  try {
    const raw = JSON.parse(localStorage.getItem(TICKS_KEY) || "null");
    ticked = new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : ["main"]);
  } catch { ticked = new Set(["main"]); }
  return ticked;
}

function saveTicks() {
  try { localStorage.setItem(TICKS_KEY, JSON.stringify([...ticks()])); } catch { /* storage blocked: ticks last the tab */ }
}

/**
 * The wallets a buy goes out from: the ticked ones that are open, in the
 * console's order, or main when none of them is.
 */
export function buyWallets() {
  const open = openWallets().map((w) => w.label);
  const t = ticks();
  const chosen = open.filter((l) => t.has(l));
  return chosen.length ? chosen : open.includes("main") ? ["main"] : open.slice(0, 1);
}

/** Tick or untick a wallet. The last tick cannot be taken away: a buy needs a wallet. */
export function toggleTick(label) {
  const t = ticks();
  const chosen = buyWallets();
  if (chosen.includes(label)) {
    if (chosen.length === 1) return;
    for (const l of chosen) t.add(l);
    t.delete(label);
  } else {
    for (const l of chosen) t.add(l);
    t.add(label);
  }
  saveTicks();
}

/** The ETH the ticked wallets hold between them, or null before it is known. */
export function tickedBalance() {
  const chosen = new Set(buyWallets());
  const ws = openWallets().filter((w) => chosen.has(w.label));
  if (!ws.length || ws.some((w) => w.balanceEth === null)) return null;
  return ws.reduce((a, w) => a + n(w.balanceEth), 0);
}

/** "split across main and w2", for a button's title. */
export const splitNote = () => {
  const chosen = buyWallets();
  return chosen.length > 1 ? `split evenly across ${chosen.join(", ")}` : "";
};

/** The wallet ticks, for the quick buy and the token page's buy panel. Nothing with one wallet. */
export function walletTicks() {
  if (!multi()) return "";
  const chosen = buyWallets();
  return html`<div class="qrow" style="flex-wrap:wrap;margin-top:6px" title="Which wallets a buy goes out from. The size is the total, split evenly.">
      ${openWallets().map((w) => html`<button class="qsz ${chosen.includes(w.label) ? "on" : ""}"
        data-wtick="${w.label}" style="flex:0 1 auto;padding:6px 9px"
        title="${w.label} · ${short(w.address)} · ${w.balanceEth === null ? "—" : eth(w.balanceEth, 4) + " " + XI}"
        >${w.label}</button>`)}
    </div>`;
}

/** The label a position is held under, or null when the page need not say. */
export const holderOf = (p) => (multi() && p && p.walletLabel ? p.walletLabel : null);

/** A Buy button's words: the whole amount, and how many wallets it is split across. */
export const buyLabel = (amount) => {
  const k = multi() ? buyWallets().length : 1;
  return `Buy ${amount} ${XI}${k > 1 ? ` across ${k}` : ""}`;
};

/** The token page's sell side: every wallet ("all"), or one. */
let sellFrom = "all";
export const sellWallet = () => (multi() && walletList().some((w) => w.label === sellFrom) ? sellFrom : "all");
export const setSellWallet = (label) => { sellFrom = label; };

/**
 * What a holding from `/api/trade/sellable` says for the wallet the sell side
 * is on: the total for "all", that wallet's share otherwise, or null when it
 * holds none.
 */
export function holdingFor(h) {
  const w = sellWallet();
  if (!h || w === "all" || !Array.isArray(h.wallets)) return h;
  return h.wallets.find((x) => x.wallet === w) ?? null;
}

/** The sell side's wallet picker: All, then each wallet that holds some. Nothing with one wallet. */
export function sellPicker(h) {
  if (!multi() || !h || !Array.isArray(h.wallets)) return "";
  const holding = h.wallets.filter((x) => x.balance && x.balance !== "0").map((x) => x.wallet);
  if (holding.length < 2 && sellWallet() === "all") return "";
  const on = sellWallet();
  return html`<div class="tpseg">${["all", ...holding].map((l) => html`<button data-sellfrom="${l}"
      class="${on === l ? "on" : ""}">${l === "all" ? "All wallets" : l}</button>`)}</div>`;
}
