import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { EXPLORER } from "../core/constants.js";
import { $, html, paint } from "../core/dom.js";
import { recordStatus, verdictPill } from "../core/domain.js";
import { XI, n, short, usd } from "../core/format.js";
import { toast } from "../core/ui.js";

// ====================================================================== //
// track record (docs/specs/track-record.md)                              //
// ====================================================================== //

/** ETH to four places with the sign spelled out, the way P&L reads. */
const signed = (v) => (n(v) >= 0 ? "+" : "−") + Math.abs(n(v)).toFixed(4) + " " + XI;
const ethv = (v) => n(v).toFixed(4) + " " + XI;
const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export async function loadRecord() {
  const r = await api("/api/record");
  if (r.status !== 200) return;
  S.record = r.data;
  S.recordAt = Date.now();
  renderRecord();
  // While a refresh runs, follow it; stop once it is done or the page is left.
  if (S.record.progress && S.record.progress.running) {
    setTimeout(() => {
      if ($("#shell").dataset.page === "positions" && Date.now() - S.recordAt >= 2500) void loadRecord();
    }, 3000);
  }
}

export async function refreshRecord() {
  const btn = /** @type {HTMLButtonElement} */ ($("#recrefresh"));
  btn.disabled = true;
  const r = await api("/api/record/refresh", {});
  btn.disabled = false;
  if (r.status !== 200) return toast("err", "Could not refresh", r.data.error || "");
  S.record = r.data;
  renderRecord();
  void loadRecord();
}

export function renderRecord() {
  const r = S.record;
  if (!r) return;
  const running = !!(r.progress && r.progress.running);
  /** @type {HTMLButtonElement} */ ($("#recrefresh")).disabled = running || !r.address;
  /** @type {HTMLButtonElement} */ ($("#recshare")).disabled = !r.address || !r.positions || r.positions.length === 0;
  $("#recstatus").textContent = r.address ? recordStatus(r.progress, r.builtAt) : "";

  if (!r.address) {
    paint($("#recstats"), "");
    paint($("#rectbody"), html`<tr><td colspan="7" class="t3" style="padding:26px 19px">No wallet to read:
      there is no keystore, and RECORD_ADDRESS is not set.</td></tr>`);
    paint($("#recnote"), "");
    return;
  }
  if (!r.builtAt && !r.transactions) {
    paint($("#recstats"), "");
    paint($("#rectbody"), html`<tr><td colspan="7" class="t3" style="padding:26px 19px">${running
      ? "Reading this wallet's history from the chain. The first read takes a few minutes."
      : "Not read yet. Refresh reads every trade this wallet has made."}</td></tr>`);
    paint($("#recnote"), "");
    return;
  }

  const t = r.totals, j = r.judged;
  paint($("#recstats"), html`
    <div class="kpi"><small>Put in</small><b>${ethv(t.spent)}</b>
      <span>${t.positions} position${t.positions === 1 ? "" : "s"} · ${usd(t.spent)}</span></div>
    <div class="kpi"><small>Got out</small><b>${ethv(t.back)}</b>
      <span>${ethv(t.gas)} gas on top</span></div>
    <div class="kpi"><small>Net, after gas</small>
      <b class="${t.realised >= 0 ? "grn" : "red"}">${signed(t.realised)}</b>
      <span>${usd(Math.abs(t.realised))} ${t.realised >= 0 ? "up" : "down"}${t.leftOut
        ? ` · ${t.leftOut} left out, measured across a shared block` : ""}</span></div>
    <div class="kpi"><small>Worth now, had you held</small><b>${ethv(j.worthIfHeld)}</b>
      <span>everything bought, none of it sold${j.unpriced ? ` · ${j.unpriced} with no price` : ""}</span></div>
    <div class="kpi"><small>Paperhanded</small><b class="${j.paperhanded > 0 ? "amb" : ""}">${
      j.paperhanded > 0 ? signed(j.paperhanded) : "—"}</b>
      <span>what you sold would fetch this much more today</span></div>
    <div class="kpi"><small>Fumbled at the top</small><b class="${j.fumbled > 0 ? "red" : ""}">${
      j.fumbled > 0 ? signed(j.fumbled) : "—"}</b>
      <span>the best exit after each sell, over what it got</span></div>`);

  const rows = r.positions.slice().sort((a, b) => b.first - a.first);
  paint($("#rectbody"), rows.length ? rows.map(recordRow)
    : html`<tr><td colspan="7" class="t3" style="padding:26px 19px">This wallet has not bought anything.</td></tr>`);

  const f = r.flows;
  const parts = [];
  if (f.ethOut.count) parts.push(`${f.ethOut.count} ETH send${f.ethOut.count === 1 ? "" : "s"} with nothing back on this chain, such as a bridge (${ethv(f.ethOut.eth)})`);
  if (f.ethIn.count) parts.push(`${f.ethIn.count} ETH arrival${f.ethIn.count === 1 ? "" : "s"} (${ethv(f.ethIn.eth)})`);
  if (f.soldReceived.count) parts.push(`tokens you received and then sold (${ethv(f.soldReceived.eth)})`);
  const got = r.received.filter((x) => x.sells === 0).length;
  if (got) parts.push(`${got} token${got === 1 ? "" : "s"} received and never bought`);
  if (f.swaps) parts.push(`${f.swaps} token-for-token swap${f.swaps === 1 ? "" : "s"}`);
  paint($("#recnote"), html`${j.errors ? html`<span class="amb">${j.errors} token${j.errors === 1 ? "" : "s"} could not be
    priced or scanned this time (${j.firstError}). Refresh tries them again.</span> ` : ""}${
    parts.length ? html`<b>Not counted as positions:</b> ${parts.join(" · ")}. ` : ""}
    Uniswap values are what selling that many tokens into the deepest pool would return after its fee;
    checked against five real sells, they read 1–5% high, about what a trading app takes on top. The best exit
    is the best single moment after your last sell, in that pool. A clank.trade curve is valued exactly and has no
    best exit, because a curve keeps no swap history to replay.`);
}

function recordRow(p) {
  const v = verdictPill(p.verdict);
  const pct = p.ethSpent > 0 ? (p.realised / p.ethSpent) * 100 : 0;
  const venue = p.venue === "clank" ? "clank.trade" : p.venue === "pons" ? "Pons" : "Uniswap";
  const nowCell = p.soldNow === null
    ? html`<span class="t3">—</span>`
    : html`${ethv(p.soldNow)}${p.paperhand !== null && Math.abs(p.paperhand) >= 0.00005
      ? html`<span class="sub2 ${p.paperhand > 0 ? "amb" : ""}">${signed(p.paperhand)} vs your sell</span>` : ""}${
      p.held > 0 && p.heldNow !== null ? html`<span class="sub2">still hold ${ethv(p.heldNow)}</span>` : ""}`;
  const bestCell = p.bestExit
    ? html`${ethv(p.bestExit.eth)}<span class="sub2">${p.bestExit.at ? day(p.bestExit.at) : ""}${
        p.bestExit.complete ? "" : " · still scanning"}</span>`
    : html`<span class="t3" title="${p.via === "curve" ? "A curve keeps no swap history to replay" : "No pool to replay"}">n/a</span>`;
  return html`<tr>
      <td><span class="tk2">${p.symbol || "—"}</span>
        <span class="sub2">${venue} · ${day(p.first)}${p.last - p.first > 86_400_000 ? "–" + day(p.last) : ""} ·
          <a class="mo" href="${EXPLORER + "/token/" + p.token}" target="_blank" rel="noopener noreferrer">${short(p.token)}</a></span></td>
      <td class="rt">${ethv(p.ethSpent)}<span class="sub2">${p.buys} buy${p.buys === 1 ? "" : "s"}</span></td>
      <td class="rt">${ethv(p.ethBack)}<span class="sub2">${p.sells} sell${p.sells === 1 ? "" : "s"}</span></td>
      <td class="rt ${p.realised >= 0 ? "grn" : "red"}" style="font-weight:600">${signed(p.realised)}
        <span class="sub2">${(pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1)}%</span></td>
      <td class="rt">${nowCell}</td>
      <td class="rt">${bestCell}</td>
      <td><span class="pill ${v.cls}" title="${p.priceError ? p.priceError : v.tip}">${v.label}</span>
        <button class="shr" type="button" data-share-token="${p.token}" title="Make a share card of this trade">Share</button>${p.priceError
        ? html`<span class="sub2 amb" title="${p.priceError}">last price kept</span>` : ""}${p.split || p.sharedBlock
        ? html`<span class="sub2" title="${p.sharedBlock ? "Another of your transactions was in the same block, so its ETH could not be told apart" : "One transaction bought several tokens; its ETH was shared evenly"}">approximate</span>` : ""}</td></tr>`;
}
