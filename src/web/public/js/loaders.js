import { S } from "./core/store.js";
import { api } from "./core/api.js";
import { $ } from "./core/dom.js";
import { renderActivity } from "./pages/activity.js";
import { renderFlow } from "./pages/flow.js";
import { renderLaunches } from "./pages/launches.js";
import { renderPositions } from "./pages/positions.js";
import { renderShell } from "./pages/shell.js";
import { renderConfigCards, renderFeed, renderSniper } from "./pages/sniper.js";
import { renderTokenIfOpen } from "./pages/token.js";
import { refreshHoldings } from "./trade.js";
import { renderTraders } from "./pages/traders.js";

export async function loadWallet() {
  const r = await api("/api/wallet");
  if (r.status !== 200) return;
  const wasUnlocked = S.wallet && S.wallet.unlocked;
  const first = S.wallet === null;
  S.wallet = r.data;
  renderShell(); renderSniper();
  // The token page's whole right column is wallet state, and the first poll
  // lands after the first render of it.
  if (first || wasUnlocked !== S.wallet.unlocked) renderTokenIfOpen();
  // Holdings can only be read through an unlocked wallet, so prime them on
  // the first poll that finds one rather than at boot.
  if (S.wallet.unlocked && (!S.holdingsPrimed || !wasUnlocked)) {
    S.holdingsPrimed = true;
    void refreshHoldings();
  }
}

export async function loadPositions() {
  const r = await api("/api/positions");
  if (r.status !== 200) return;
  S.positions = r.data;
  S.lastPositionsAt = Date.now();
  renderPositions(); renderShell();
}

export async function loadDecisions() {
  const r = await api("/api/decisions?n=100");
  if (r.status === 200) { S.feed = r.data; renderFeed(); }
}

export async function loadStats() {
  const r = await api("/api/stats");
  if (r.status !== 200) return;
  const was = S.stats && S.stats.price ? S.stats.price.ethUsd : null;
  S.stats = r.data;
  const now = S.stats.price ? S.stats.price.ethUsd : null;
  renderShell();
  // Every valuation on the board is priced off this. The first stats poll
  // usually lands *after* the first board render, so without re-rendering
  // here the whole app sits in its ETH fallback until something else
  // happens to redraw it.
  if (was !== now) { renderLaunches(); renderPositions(); renderTokenIfOpen(); }
  // The Traders page gives each P&L in dollars too (X29b).
  if (was !== now && $("#shell").dataset.page === "traders") renderTraders();
  if ($("#shell").dataset.page === "activity") renderActivity();
}

export async function loadConfig() {
  if (S.cfg) return;
  const r = await api("/api/config");
  if (r.status !== 200) return;
  S.cfg = r.data;
  if (r.data.features) S.features = r.data.features;
  if (r.data.brand) S.brand = r.data.brand;
  renderConfigCards(); renderLaunches(); renderFlow();
}
