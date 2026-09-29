import { S } from "../core/store.js";
import { AMB, DIM, EXPLORER, GRN, RED } from "../core/constants.js";
import { $, html, paint } from "../core/dom.js";
import { guardPct, initials, valueOf } from "../core/domain.js";
import { ago, cap1, dur, durExact, n, pc, short, sign, usd } from "../core/format.js";
import { ring } from "../core/svg.js";
import { counts, flagRow } from "./launches.js";
import { renderLookup } from "./positionsLookup.js";
import { holderOf, multi, sellWallet } from "../wallets.js";

// ====================================================================== //
// positions                                                              //
// ====================================================================== //

/**
 * Which cards have their fee ledger open, keyed token:source.
 *
 * #pgrid is repainted wholesale every sweep, so DOM state does not survive.
 * Keeping it here means the disclosure is rendered from data like
 * everything else on the board.
 */
export const ledgerOpen = new Set();

/** Main's key is what it always was; another wallet's position adds its label. */
export const ledgerKey = (p) =>
  `${p.token}:${p.source}${p.walletLabel && p.walletLabel !== "main" ? `:${p.walletLabel}` : ""}`.toLowerCase();

/**
 * The wallets holding an open position in this token, when there are several
 * of them (multi-wallet.md), or null.
 */
export function holdersOf(token) {
  if (!multi()) return null;
  const k = String(token).toLowerCase();
  const labels = [...new Set(S.positions.open
    .filter((p) => p.token.toLowerCase() === k && !p.dryRun)
    .map((p) => p.walletLabel || "main"))];
  return labels.length > 1 ? labels : null;
}

/** The same, when the token page's sell side is on every wallet: then no one basis is the total's. */
export const spreadAcross = (token) => (sellWallet() === "all" ? holdersOf(token) : null);

/**
 * Venue fees this position has actually been charged, over its whole life.
 *
 * `entryFeeWei` and `snipeTaxWei` shrink pro-rata as a position is sold
 * down, with the part that left accumulating in `realizedEntryFeeWei` — so
 * a lifetime total has to read all three, or a half-sold position under-
 * reports what it paid to get in. Gas is not a fee and is counted apart.
 */
const feesOf = (p) => (n(p.entryFeeWei) + n(p.snipeTaxWei)
  + n(p.realizedEntryFeeWei) + n(p.exitFeeWei)) / 1e18;

/** Everything ever deployed into it, open plus already sold. */
const basisOf = (p) => n(p.costEthNum || n(p.costEth) / 1e18)
  + n(p.realizedCostWei) / 1e18;

export function renderPositions() {
  // A hosted page has no positions of its own: it looks up any address
  // (public-release F1.2). Self's page below is untouched.
  if (S.mode === "hosted") return renderLookup();
  const open = S.positions.open;
  const closed = S.positions.closed.filter((p) => p.closed);
  const paper = open.filter((p) => p.dryRun).length;
  const manual = open.filter((p) => !p.dryRun && p.source === "manual").length;

  counts("#pchips", {
    all: open.length, sniped: open.length - paper - manual, manual, paper,
  });
  renderPositionStats(open, closed);

  $("#pvalued").textContent = open.length ? "Valued " + ago(S.lastPositionsAt) : "";

  paint($("#pgrid"), open.length ? open.map(positionCard)
    : html`<div class="empty"><b>Nothing open</b>Positions appear here the moment the sniper takes
          one — including dry-run ones.</div>`);

  paint($("#ptbody"), closed.length
    ? closed.slice().sort((a, b) => b.closed.at - a.closed.at).map(closedRow)
    : html`<tr><td colspan="6" style="color:var(--tx3);padding:26px 19px">Nothing has closed yet.</td></tr>`);
}

function renderPositionStats(open, closed) {
  const cost = open.reduce((a, p) => a + n(p.costEthNum), 0);
  const now = open.reduce((a, p) => a + n(p.nowEth), 0);
  const delta = now - cost;
  const pct = cost > 0 ? (delta / cost) * 100 : 0;

  // The book-level version of what each card shows. Weighted by size rather
  // than averaged across positions: a 0.05 ETH position moving 1% is not the
  // same event as a 0.005 ETH one moving 1%, and a mean of the percentages
  // would say it was.
  const invested = open.reduce((a, p) =>
    a + n(p.costEthNum) - n(p.entryFeeEth) - n(p.snipeTaxWei) / 1e18, 0);
  const gross = open.reduce((a, p) => a + n(p.grossEth), 0);
  const bookMove = invested > 0 ? ((gross - invested) / invested) * 100 : 0;
  const bookDrag = cost > 0
    ? (open.reduce((a, p) => a + n(p.entryFeeEth) + n(p.exitFeeEth), 0) / cost) * 100
    : 0;

  const dayAgo = Date.now() - 24 * 3600e3;
  // Paper is excluded: a dry run never sent a transaction, so its "proceeds"
  // are simulated and have no business in a realised-money figure or a
  // win/loss record. Two stale paper stop-outs were showing up as two real
  // losses and about a dollar of realised P&L that never moved.
  const today = closed.filter((p) => !p.dryRun && p.closed.at >= dayAgo);
  const realised = today.reduce((a, p) =>
    a + (n(p.closed.proceedsEth) - n(p.realizedCostWei)) / 1e18, 0);
  const wins = today.filter((p) => n(p.closed.proceedsEth) > n(p.realizedCostWei)).length;
  const losses = today.length - wins;

  const max = S.wallet && S.wallet.budget ? S.wallet.budget.maxPositions : 0;
  // Slots are the sniper's, so capacity counts what the sniper is holding —
  // not every open position. Counting a hand-bought one here would show the
  // sniper as full while it was in fact still free to take a launch.
  const used = S.wallet && S.wallet.budget
    ? S.wallet.budget.positions
    : open.filter((p) => p.source !== "manual").length;
  const full = max > 0 && used >= max;
  const capPct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const moveCls = open.length === 0 ? "" : delta >= 0 ? "grn" : "red";

  // Fees split into charged and not-yet-charged, which the spec's original
  // "sum entry and exit across open and closed" would have run together.
  // An open position has paid its entry fee and, unless it has been sold
  // down in part, not one wei of an exit fee — so its exit cost is a
  // projection at today's size, not money that has left. The headline is
  // only what was actually taken.
  // Paper positions are excluded throughout: a dry run never sent a
  // transaction, so it never paid a fee, and counting its simulated one
  // would put money in this tile that never left the wallet.
  const realOpen = open.filter((p) => !p.dryRun);
  const realClosed = closed.filter((p) => !p.dryRun);
  const feesPaid = realOpen.concat(realClosed).reduce((a, p) => a + feesOf(p), 0);
  const gasPaid = realOpen.concat(realClosed)
    .reduce((a, p) => a + n(p.gasWei) / 1e18, 0);
  const feesPending = realOpen.reduce((a, p) => a + n(p.exitFeeEth), 0);
  const drag = S.wallet && S.wallet.manager && S.wallet.manager.fees
    ? S.wallet.manager.fees.roundTripDragPct : null;
  // Against realised cost, not against everything ever spent: an open
  // position has only paid half of its round trip, so including it would
  // understate the rate on what has actually been round-tripped.
  const realisedCost = realClosed.reduce((a, p) => a + n(p.realizedCostWei) / 1e18, 0);
  const closedFees = realClosed.reduce((a, p) => a + feesOf(p), 0);
  const takeRate = realisedCost > 0 ? (closedFees / realisedCost) * 100 : null;
  const paperOnly = feesPaid === 0 && open.length + closed.length > 0;

  // U0's stat (.kpi): its label, the figure, the lines under it. The words
  // and figures are the canvas tiles' own.
  paint($("#pstats"), html`
      <div class="kpi"><small>Open value</small><b>${usd(now)}</b>
        <span>${usd(cost)} at risk across ${open.length} position${open.length === 1 ? "" : "s"}</span></div>
      <div class="kpi"><small>Unrealised</small>
        <b class="${moveCls}">${open.length ? sign(pct) + "%" : "—"}</b>
        <span class="${moveCls}">${open.length
          ? `${n(delta) >= 0 ? "+" : "−"}${usd(Math.abs(delta))} cleared at today’s quote`
          : "nothing open"}</span>
        ${open.length ? html`<span class="t4"
          >price ${sign(bookMove)}% less ${bookDrag.toFixed(2)}% fees</span>` : ""}</div>
      <div class="kpi"><small>Realised today</small>
        <b class="${today.length === 0 ? "" : realised >= 0 ? "grn" : "red"}">${today.length
          ? (realised >= 0 ? "+" : "−") + usd(Math.abs(realised)) : "—"}</b>
        <span>${today.length
          ? `${today.length} closed · ${wins} win${wins === 1 ? "" : "s"}, ${losses} loss${losses === 1 ? "" : "es"}`
          : "nothing closed in the last 24h"}</span></div>
      <div class="kpi"><small>Fees paid</small>
        <b class="${feesPaid > 0 ? "amb" : ""}">${feesPaid > 0 ? usd(feesPaid) : "—"}</b>
        <span title="Fees as a share of the capital you cycled through the venue — not the venue's rate. It sits above the ${
          drag !== null ? drag.toFixed(2) : "1.99"}% a flat round trip costs whenever you have winners, because the exit fee is charged on what you sold for, not on what you paid.">${feesPaid > 0
          ? (takeRate !== null
              ? `${pc(takeRate, 2)} of everything round-tripped`
              : `${drag !== null ? pc(drag, 2) : "2%"} on a round trip`)
          : paperOnly
            ? "paper only — no fee was ever charged"
            : `nothing traded yet · ${drag !== null ? pc(drag, 2) : "2%"} a round trip`
        }${feesPending > 1e-9
          ? ` · ${usd(feesPending)} more to close what is open` : ""}${gasPaid > 0
          ? ` · ${usd(gasPaid)} gas on top` : ""}</span></div>
      <div class="kpi"><small>Capacity</small>
        <b class="${full ? "amb" : ""}">${max ? `${used} / ${max}` : used}</b>
        <div class="mtr"><i class="${full ? "full" : ""}" style="width:${capPct}%"></i></div>
        <span>${full ? "At the slot cap — the sniper is idle until one closes"
          : max ? `Room for another${open.length > used
            ? ` · ${open.length - used} manual, outside the cap` : ""}`
          : "No slot cap known yet"}</span></div>`);
}

function positionCard(p) {
  const up = n(p.pnlPct) >= 0;
  const prog = n(p.progress) * 100;
  const exiting = !!(p.exit && p.exit.exit);
  const sell = n(p.sellablePct);
  const capped = p.capped || sell < 99.5;
  const delta = n(p.nowEth) - n(p.costEthNum);

  const manual = p.source === "manual";

  const flag =
    exiting && !manual ? flagRow(p.exit.urgent ? "amb" : "red", cap1(p.exit.reason)) :
    exiting && manual ? flagRow("amb",
      `The exit rules would leave here (${cap1(p.exit.reason)}) — but this was bought by hand, so nothing will act on it`) :
    p.dryRun ? html`<div class="flag" style="background:var(--card2);color:var(--tx2)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9.2"/></svg>
          Dry run — valued after a simulated entry, or it would read back as −100%</div>` :
    capped && sell > 0 ? flagRow("amb", `Only ${pc(sell, 0)} of this can be sold in one go`) :
    "";

  const [pillCls, pillText] =
    exiting && !manual ? ["r", "Exiting"] :
    p.dryRun ? ["n", "Paper"] :
    manual ? ["n", "Manual"] :
    capped ? ["a", "Capped"] :
    up ? ["g", "Open"] : ["b", "Open"];

  return html`<article class="lc ${exiting ? "hot" : up ? "" : "bad"}"
      data-b="${p.dryRun ? "paper" : manual ? "manual" : "sniped"}" data-token="${p.token}">
      <div class="lchd">
        ${ring(44, p.progress, p.dryRun ? DIM : exiting ? AMB : up ? GRN : RED, initials(p.symbol), p.token)}
        <div class="id"><div class="tk ${p.dryRun ? "t2" : ""}">${p.symbol || short(p.token)}</div>
          <div class="nm">${usd(p.costEthNum)} → ${usd(p.nowEth)} · open ${dur(Date.now() - p.openedAt)}</div></div>
        <div style="text-align:right;flex:none">
          <div style="font-size:24px;font-weight:700;letter-spacing:-.035em;line-height:1"
            class="${p.dryRun ? "t2" : up ? "grn" : "red"}">${sign(p.pnlPct) + "%"}</div>
          <div style="font-size:11.5px;color:var(--tx3);margin-top:4px">${
            n(delta) >= 0 ? "+" : "−"}${usd(Math.abs(delta))}</div>
          <div style="font-size:11px;color:var(--tx4);margin-top:2px"
            title="Net P&amp;L is the market move less the fee paid entering and the fee leaving would cost."
            >price ${sign(n(p.priceMovePct))}% · fees −${n(p.feeDragPct).toFixed(2)}%</div>
        </div>
      </div>
      ${flag}
      <div>
        <div class="barlb" style="margin:0 0 7px"><span>Sellable in one go</span>
          <span class="${capped ? "amb" : ""}">${capped
            ? `${pc(sell, 0)} · ${usd(p.nowEth)}` : "100% · no cap applies"}</span></div>
        <div class="bar"><i class="${exiting ? "bad" : capped ? "hot" : ""}"
          style="width:${Math.min(100, sell).toFixed(1)}%${p.dryRun ? ";background:var(--tx4)" : ""}"></i></div>
      </div>
      <div class="kv">
        <div class="c"><i>Peak</i><b class="${n(p.peakPct) <= 0 ? "t3" : ""}">${n(p.peakPct) <= 0
          ? "never above entry" : sign(p.peakPct) + "%"}</b></div>
        <div class="c ${prog >= guardPct() ? "near" : ""}"><i>Graduation</i>
          <b class="${prog >= guardPct() ? "amb" : ""}">${pc(prog)}</b></div>
        <div class="c ${exiting && !manual ? "warn" : ""}"><i>Next rule</i>
          <b style="font-size:12px" class="${exiting && !manual ? "red" : ""}">${nextRule(p)}</b></div>
        <div class="c"><i>Breakeven</i>
          <b class="${n(p.priceMovePct) >= n(p.breakevenMovePct) ? "grn" : ""}"
            >+${n(p.breakevenMovePct).toFixed(2)}%</b></div>
      </div>
      ${ledgerOpen.has(ledgerKey(p)) ? feeLedger(p) : ""}
      <div class="lcft"><span class="pill ${pillCls}">${pillText}</span>${holderOf(p)
        ? html`<span class="pill n" title="${`Held by ${p.walletLabel} · ${p.wallet || ""}`}">${p.walletLabel}</span>` : ""}
        <span class="feetog" data-ledger="${ledgerKey(p)}"
          >Fees ${ledgerOpen.has(ledgerKey(p)) ? "▴" : "▾"}</span>${holdersOf(p.token) && !p.dryRun
          ? html`<button class="btn sm sell" data-sell="${p.token}" data-pct="100" data-wallet="all"
              title="${`Sell every wallet's ${p.symbol || "holding"}: ${holdersOf(p.token).join(", ")}`}">Sell all wallets</button>` : ""}
        <span class="sp"></span>${p.openTx
          ? html`<a href="${EXPLORER + "/tx/" + p.openTx}" target="_blank" rel="noopener noreferrer">Entry tx · ${short(p.openTx)}</a>`
          : html`<span class="t4">No transaction was broadcast</span>`}</div>
    </article>`;
}

/**
 * Itemised cost of one position.
 *
 * Split into charged and projected, because they are different kinds of
 * number: the entry fee, any snipe tax, any exit fee from a partial sell
 * and the gas burned are money that has left, while the exit fee is only a
 * quote at today's size and moves with the curve. A paper position pays
 * none of it and says so rather than showing simulated costs as real ones.
 */
export function feeLedger(p) {
  const w = (v) => n(v) / 1e18;
  // Lifetime, not just the open part: a sold-down position keeps the entry
  // cost of what left in realizedEntryFeeWei, and a ledger that ignored it
  // would show a position paying less than it did.
  const entry = w(p.entryFeeWei) + w(p.realizedEntryFeeWei);
  const tax = w(p.snipeTaxWei);
  const exitPaid = w(p.exitFeeWei), gas = w(p.gasWei);
  const exitNow = n(p.exitFeeEth);
  const paid = entry + tax + exitPaid + gas;
  // Against everything ever deployed, for the same reason.
  const basis = basisOf(p);
  const sold = n(p.realizedCostWei) > 0;

  if (p.dryRun) {
    return html`<div class="feeledger">
        <div class="tprow"><span>Paper position</span><b>no fee was charged</b></div>
        <div class="tprow proj"><span>It would have cost</span>
          <b>${usd(entry + exitNow)} in fees on a round trip</b></div></div>`;
  }

  return html`<div class="feeledger">
      <div class="tprow"><span>Entry fee${p.feeBps
        ? ` · ${(p.feeBps / 100).toFixed(2)}%` : ""}</span><b>${usd(entry)}</b></div>
      ${tax > 0 ? html`<div class="tprow"><span>Snipe tax</span><b>${usd(tax)}</b></div>` : ""}
      ${exitPaid > 0 ? html`<div class="tprow"><span>Exit fees so far</span>
        <b>${usd(exitPaid)}</b></div>` : ""}
      <div class="tprow ${gas > 0 ? "" : "proj"}"><span>Gas</span>
        <b>${gas > 0 ? usd(gas) : "awaiting receipt"}</b></div>
      <div class="tprow tot"><span>Paid so far</span><b>${usd(paid)}</b></div>
      <div class="tprow proj"><span>Exit fee to close now</span><b>${usd(exitNow)}</b></div>
      <div class="tprow proj"><span>All-in ${sold ? "over its whole life" : "if you closed now"}</span>
        <b>${usd(paid + exitNow)} · ${basis > 0
          ? pc(((paid + exitNow) / basis) * 100, 2) : "—"} of ${usd(basis)}</b></div>
    </div>`;
}

/**
 * What the manager will act on next. When it is already acting, its own words
 * are the answer; otherwise the nearest of the configured thresholds.
 */
/**
 * The tracked position for a token. Yours first: a hand-bought position and
 * a sniped one can both be open in the same token, and the token page is
 * where you look at your own.
 */
export function positionFor(token, walletLabel) {
  const k = String(token).toLowerCase();
  const mine = S.positions.open.filter((p) => p.token.toLowerCase() === k &&
    (!walletLabel || (p.walletLabel || "main") === walletLabel));
  return mine.find((p) => p.source === "manual") || mine[0] || null;
}

function nextRule(p) {
  if (p.source === "manual") return "Yours to close";
  if (p.exit && p.exit.exit) return "Exiting now";
  if (!S.cfg) return "—";
  const tp = valueOf(S.cfg.exits, "TAKE_PROFIT_PCT") ?? 0;
  const sl = valueOf(S.cfg.exits, "STOP_LOSS_PCT") ?? 0;
  const tr = valueOf(S.cfg.exits, "TRAILING_STOP_PCT") ?? 0;
  const pnl = n(p.pnlPct), peak = n(p.peakPct);

  const candidates = [
    { d: Math.abs(tp - pnl), t: `Take profit +${tp}%` },
    { d: Math.abs(pnl + sl), t: `Stop −${sl}%` },
  ];
  if (tr > 0 && peak > 0) {
    candidates.push({ d: Math.abs(pnl - (peak - tr)), t: `Trailing ${sign(peak - tr)}%` });
  }
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0].t;
}

function closedRow(p) {
  // The basis of a closed position is what was spent on the tokens that
  // left, i.e. `realizedCostWei` — NOT `costEth`, which tracks the part
  // still open and is therefore zero by the time anything is closed.
  const cost = n(p.realizedCostWei) / 1e18;
  const proceeds = n(p.closed.proceedsEth) / 1e18;
  const pnl = cost > 0 ? ((proceeds - cost) / cost) * 100 : 0;
  const partial = /partial/i.test(p.closed.reason || "");

  return html`<tr>
      <td><span class="tk2 ${p.dryRun ? "t2" : ""}">${p.symbol || "—"}</span>${p.dryRun
        ? html` <span class="pill n">Paper</span>` : ""}${holderOf(p)
        ? html` <span class="pill n">${p.walletLabel}</span>` : ""}
        <span class="sub2 mo">${short(p.token)}</span></td>
      <td class="rt">${usd(cost)}</td>
      <td class="rt">${usd(proceeds)}</td>
      <td class="rt ${p.dryRun ? "" : pnl >= 0 ? "grn" : "red"}" style="font-weight:600">${sign(pnl) + "%"}</td>
      <td class="rt">${durExact(p.closed.at - p.openedAt)}</td>
      <td>${cap1(p.closed.reason)}${p.closed.tx
        ? html`<span class="sub2 mo"><a href="${EXPLORER + "/tx/" + p.closed.tx}" target="_blank" rel="noopener noreferrer">${short(p.closed.tx)}</a></span>`
        : html`<span class="sub2 ${partial ? "amb" : ""}">No transaction was broadcast</span>`}</td></tr>`;
}
