import { S } from "../core/store.js";
import { $, html, paint } from "../core/dom.js";
import { XI, cap1, clock, eth, int, n, short } from "../core/format.js";
import { counts } from "./launches.js";
import { armLife } from "./shell.js";

/** Each decision outcome as a pill: its colour class and its word. */
export const DEC_PILL = {
  sniped: ["g", "Sniped"], skipped: ["n", "Skipped"],
  blocked: ["r", "Blocked"], failed: ["r", "Failed"],
};

// ====================================================================== //
// sniper                                                                 //
// ====================================================================== //

export function renderSniper() {
  const arm = S.wallet && S.wallet.arm;
  const armed = !!(arm && arm.auto.armed);
  $("#armhero").className = "card armhero " + (armed ? "armed" : "safe");
  $("#ah-sw").setAttribute("aria-pressed", String(armed));

  $("#ah-life").textContent = !arm ? ""
    : armed ? armLife(arm.auto)
    : arm.manual.armed ? "Your own buys are hot; this switch is the sniper's"
    : "";

  if (S.wallet && S.wallet.budget) {
    const b = S.wallet.budget;
    const spent = n(b.spentEth), budget = n(b.budgetEth);
    const slotsFull = b.positions >= b.maxPositions;

    paint($("#ah-budget"), html`${eth(spent)}
        <span class="t3" style="font-size:13px;font-weight:400">of ${eth(budget)} ${XI}</span>`);
    $("#ah-budget-bar").style.width =
      (budget > 0 ? Math.min(100, (spent / budget) * 100) : 0) + "%";
    $("#ah-budget-bar").className = budget > 0 && spent >= budget ? "full" : "";

    paint($("#ah-slots"), html`${b.positions}
        <span class="t3" style="font-size:13px;font-weight:400">of ${b.maxPositions}${slotsFull ? " — at cap" : ""}</span>`);
    $("#ah-slots-bar").style.width =
      (b.maxPositions > 0 ? Math.min(100, (b.positions / b.maxPositions) * 100) : 0) + "%";
    $("#ah-slots-bar").className = slotsFull ? "full" : "";
  }

  renderConfigCards();
  renderFeed();
}

export function renderConfigCards() {
  // A hosted config describes no sniper: no sizing, filters or exits.
  if (!S.cfg || !S.cfg.sizing) return;
  const rowsFor = (list) => list.map((c) => {
    const modified = String(c.value) !== String(c.def);
    const bool = typeof c.value === "boolean";
    return html`<div class="cfgrow ${modified ? "mod" : ""}"><span class="k">${c.key}</span>
        <span class="d">def ${typeof c.def === "boolean" ? (c.def ? "on" : "off") : c.def}</span>
        <span class="v ${bool && c.value ? "grn" : ""}">${bool ? (c.value ? "On" : "Off") : c.value}</span></div>`;
  });

  paint($("#cfg-sizing"), rowsFor(S.cfg.sizing));
  paint($("#cfg-filters"), rowsFor(S.cfg.filters));
  paint($("#cfg-exits"), rowsFor(S.cfg.exits));

  paint($("#interlocks"), S.cfg.interlocks.map((lk, i, a) =>
    html`<div class="ilk" style="${i >= a.length - 2 ? "border-bottom:none" : ""}">
        <span class="lock"></span><div>${lk.title}<em>${lk.note}</em></div></div>`));
}

const OUTCOME_KEY = { sniped: "sn", skipped: "sk", blocked: "bl", failed: "bl" };

export function renderFeed() {
  const ds = S.feed.decisions;
  const tally = { all: ds.length, sn: 0, sk: 0, bl: 0 };
  for (const d of ds) tally[OUTCOME_KEY[d.outcome] || "bl"]++;
  counts("#schips", tally);

  paint($("#dfeed"), ds.length ? ds.map(decision)
    : html`<div class="empty" style="margin:19px"><b>Nothing judged yet</b>Every launch is judged
          whether or not the sniper is armed — the declines are the part worth reading.</div>`);
}

function decision(d) {
  const [cls, label] = DEC_PILL[d.outcome] || ["n", d.outcome];
  const rules = d.rules || [];
  const failed = rules.filter((r) => !r.passed)
    .sort((a, b) => (b.interlock ? 1 : 0) - (a.interlock ? 1 : 0));
  const risk = rules.find((r) => r.name === "Risk score");

  const chips = failed.map((r) =>
    html`<span class="rch ${r.interlock ? "hard" : ""}">${r.name} <b>${r.observed}</b> · ${r.limit}</span>`);
  // A couple of the passes too, so a decline reads as a near miss rather than
  // a verdict out of nowhere — but only when there is something to contrast.
  if (failed.length && failed.length < rules.length) {
    for (const r of rules.filter((r) => r.passed && !r.interlock).slice(0, 3)) {
      chips.push(html`<span class="rch ok">${r.name} <b>${r.observed}</b></span>`);
    }
  }

  return html`<div class="dec" data-v="${OUTCOME_KEY[d.outcome] || "bl"}">
      <div class="when"><b>${clock(d.at)}</b><span>block ${int(d.block)}</span></div>
      <div class="dbody">
        <div class="dhd"><b>${d.symbol || short(d.token)}</b>
          <span class="pill ${cls}">${label}</span>
          <span>${d.name || ""}${risk ? ` · risk ${risk.observed}` : ""}</span>
          ${!d.armed && d.outcome === "sniped" ? html`<span class="pill n">Paper</span>` : ""}</div>
        <div class="why2">${cap1(d.summary)}${d.error ? " — " + d.error : ""}</div>
        ${chips.length ? html`<div class="rules">${chips}</div>` : ""}
        ${d.fill ? html`<div class="kv" style="margin-top:12px">
          <div class="c"><i>Tokens out</i><b>${int(n(d.fill.tokensOut) / 1e18)}</b></div>
          <div class="c"><i>Spent</i><b>${eth(n(d.fill.amountInWei) / 1e18) + " " + XI}</b></div>
          <div class="c"><i>Slippage cap</i><b>${(d.fill.slippageBps / 100).toFixed(1)}%</b></div>
          <div class="c"><i>Detect → send</i><b>${int(d.fill.ms)}ms</b></div></div>` : ""}
      </div>
    </div>`;
}
