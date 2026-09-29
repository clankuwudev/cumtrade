import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { CONTACT } from "../core/constants.js";
import { $, html, paint } from "../core/dom.js";
import { XI, ago, eth, int, short, usd } from "../core/format.js";
import { asOfLine, readIndexLag } from "../core/indexLag.js";
import { trader } from "../trade.js";

// ====================================================================== //
// the Traders page (x29-leaderboard.md, X29b)                            //
// ====================================================================== //
//
// The addresses that have made the most on this venue's curves, from
// /api/leaders (X29a): ranked by what their closed positions realised, with
// the figures that make a rank fair to read beside it. Hosted only, as the
// Portfolio is: each row links to one. A Portfolio shows its own rank here
// too (`rankLine`).

/** The windows, their switch's labels, and how the line over the table says them. */
export const WINDOWS = [
  { key: "7d", label: "7 days", phrase: "in the last 7 days" },
  { key: "30d", label: "30 days", phrase: "in the last 30 days" },
  { key: "all", label: "All time", phrase: "" },
];

/** The board is worked out again at most once a minute (X29a), so an answer is kept that long. */
const KEEP_MS = 60_000;
/** Each window's last answer and when it came, so switching back is instant. */
const kept = new Map();

const key = (a) => String(a || "").toLowerCase();

/** A GET, with a page that could not reach the server read as status 0. */
const get = async (path) => {
  try { return await api(path); } catch { return { status: 0, data: null }; }
};

/**
 * Read the leaders for `window`, unless a minute-old answer is in hand.
 * A failed read keeps the rows already shown.
 *
 * @param {string} window
 * @param {boolean} [force]
 */
export async function loadLeaders(window, force = false) {
  const hit = kept.get(window);
  if (!force && hit && Date.now() - hit.at < KEEP_MS) {
    if (S.leaders.window === window) S.leaders = { window, state: "ready", data: hit.data };
    return renderTraders();
  }
  if (S.leaders.window === window && !(S.leaders.state === "ready" && S.leaders.data)) {
    S.leaders = { window, state: "loading", data: null };
  }
  renderTraders();
  void readIndexLag().then(renderTraders);
  const r = await get(`/api/leaders?window=${encodeURIComponent(window)}&limit=100`);
  if (r.status === 200 && r.data && Array.isArray(r.data.rows)) kept.set(window, { data: r.data, at: Date.now() });
  if (S.leaders.window !== window) return;
  if (r.status === 200 && r.data && Array.isArray(r.data.rows)) S.leaders = { window, state: "ready", data: r.data };
  else if (S.leaders.state !== "ready") S.leaders = { window, state: r.status === 404 ? "notIndexed" : "error", data: null };
  renderTraders();
}

/** The router opened #/traders. Your own wallet's rank is read too, for the line over the table. */
export function openTraders() {
  const mine = myAddress();
  if (mine) void loadRank(mine, renderTraders);
  return loadLeaders(S.leaders.window || "7d");
}

/** The wallet you trade from, lowercased, or "". */
const myAddress = () => {
  const t = trader();
  return t && t.address ? key(t.address) : "";
};

/** The window switch. */
export function setTradersWindow(window) {
  if (!WINDOWS.some((w) => w.key === window)) return;
  const hit = kept.get(window);
  S.leaders = hit ? { window, state: "ready", data: hit.data } : { window, state: "loading", data: null };
  return loadLeaders(window);
}

/** Try again, after a failed read. */
export function retryTraders() {
  return loadLeaders(S.leaders.window, true);
}

/** Forget every answer kept (tests). */
export function forgetLeaders() {
  kept.clear();
}

const signedEth = (v) => `${v >= 0 ? "+" : "−"}${eth(Math.abs(v))} ${XI}`;
const pct = (f) => `${Math.round(f * 100)}%`;
const plural = (count, one, many = one + "s") => `${int(count)} ${count === 1 ? one : many}`;
/** The same figure in dollars, signed, or "" while the ETH price is not known. */
const signedUsd = (v) => (S.stats && S.stats.price && S.stats.price.ethUsd ? `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}` : "");
/** A share from 0 to 1 as a small bar, `tone` its colour class. */
const bar = (f, tone) => html`<i class="mbar ${tone}" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, f * 100)).toFixed(0)}%"></i></i>`;

/** One ranked address: the whole row opens its Portfolio. */
function row(r, mine) {
  const me = !!mine && r.address === mine;
  const unknown = r.unknownProceeds > 0
    ? html`<span class="unk" title="${plural(r.unknownProceeds, "more position") + " left the wallet without a curve sale, such as a sale on Uniswap after graduation, so what they fetched is unknown and not counted"}">+${r.unknownProceeds}</span>`
    : "";
  const paper = r.paperhandRate === null || r.paperhandRate === undefined
    ? html`<span class="t3" title="No sell of these could be priced now">—</span>`
    : html`<span title="${`Of ${plural(r.paperhandOf, "sell")} priced now, ${int(Math.round(r.paperhandRate * r.paperhandOf))} would fetch at least 10% more today than they got`}">${bar(r.paperhandRate, "a")}<span class="pv">${pct(r.paperhandRate)}</span></span>`;
  const dollars = signedUsd(r.realizedPnlEth);
  return html`<a class="${"trr" + (r.rank <= 3 ? " top" + r.rank : "") + (me ? " me" : "")}" role="row" href="${"#/portfolio/" + r.address}" title="${"Open " + r.address + "’s Portfolio"}">
      <span class="c-rank" role="cell"><span class="rk">${r.rank}</span></span>
      <span class="c-who" role="cell"><span class="mo">${short(r.address)}</span>${me ? html`<span class="ltag you">You</span>` : ""}</span>
      <span class="c-pnl" role="cell" title="${`After fees, before gas. Gas: ${eth(r.gasEth, 5)} ${XI}`}"><b class="${"mo " + (r.realizedPnlEth >= 0 ? "grn" : "red")}">${signedEth(r.realizedPnlEth)}</b>${dollars ? html`<small>${dollars}</small>` : ""}</span>
      <span class="c-closed" role="cell"><span class="k">Closed </span>${int(r.closed)}${unknown}</span>
      <span class="c-win" role="cell" title="${`${int(r.wins)} of ${int(r.closed)} made money`}"><span class="k">Win rate </span>${bar(r.winRate, "g")}<span class="pv">${pct(r.winRate)}</span></span>
      <span class="c-paper" role="cell">${paper}</span>
      <span class="c-last" role="cell" title="${new Date(r.lastClosedAt).toLocaleString()}">${ago(r.lastClosedAt)}</span>
    </a>`;
}

/** Where your own wallet stands, over the table, once its rank is read; "" otherwise. */
function yourLine(mine) {
  const r = mine && S.rank && S.rank.for === mine ? S.rank : null;
  const text = r ? rankText(r.data) : "";
  return text ? html`<p class="tryou"><span class="ltag you">You</span> <a href="${"#/portfolio/" + mine}">${text}</a></p>` : "";
}

/** The table, or why there is none. */
function body() {
  const st = S.leaders;
  const w = WINDOWS.find((x) => x.key === st.window) ?? WINDOWS[0];
  if (st.state === "loading" || st.state === "idle") return html`<div class="empty plain tempty" role="status">Loading traders…</div>`;
  if (st.state === "notIndexed") {
    return html`<div class="empty plain tempty"><b>Not indexed yet</b>The index has not read the chain’s trades yet. They show here once it has, usually within a minute.</div>`;
  }
  if (st.state === "error") {
    return html`<div class="callout danger" role="alert"><span><b>Could not load the traders.</b> Try again in a moment.</span>
      <button class="btn sm" type="button" data-traders-retry>Try again</button></div>`;
  }
  const d = st.data;
  const mine = myAddress();
  const within = w.phrase ? " " + w.phrase : "";
  const sum = html`<p class="thsum"><b>${plural(d.eligible, "trader")} with at least ${d.minClosed} closed positions${within}</b>, of ${int(d.traders)} who traded${d.builtAt ? html`<span class="t3"> · as of ${ago(d.builtAt)}</span>` : ""}</p>`;
  if (!d.rows.length) {
    return html`${asOfLine()}${sum}${yourLine(mine)}<div class="empty plain tempty">Nobody has ${d.minClosed} closed positions${within} yet.</div>`;
  }
  return html`${asOfLine()}${sum}${yourLine(mine)}
    <div class="ttraders" role="table" aria-label="${"Traders ranked by realised P&L, " + w.label.toLowerCase()}">
      <div class="trr trrhd" role="row"><span class="c-rank" role="columnheader">#</span><span role="columnheader">Trader</span>
        <span class="c-pnl" role="columnheader" title="What the closed positions made, after fees, before gas">Realised P&amp;L</span>
        <span class="c-closed" role="columnheader" title="Positions closed in the window">Closed</span>
        <span class="c-win" role="columnheader" title="The share of those that made money">Win rate</span>
        <span class="c-paper" role="columnheader" title="How often the tokens sold would fetch at least 10% more today">Paperhand</span>
        <span class="c-last" role="columnheader">Last closed</span></div>
      ${d.rows.map((r) => row(r, mine))}
    </div>`;
}

/** Draw the page into #pg-traders. */
export function renderTraders() {
  const host = $("#trpage");
  if (!host) return;
  const st = S.leaders;
  const tabs = WINDOWS.map((w) => html`<button type="button" data-traders-window="${w.key}" aria-pressed="${w.key === st.window ? "true" : "false"}">${w.label}</button>`);
  paint(host, html`
    <div class="phead trhead"><div><h1>Traders</h1>
      <p>The addresses that made the most on clank.trade’s curves, ranked by what their closed positions realised.</p></div>
      <div class="seg sm trwin" role="group" aria-label="Window">${tabs}</div></div>
    <div class="card cardpad trcard">${body()}</div>
    <div class="trnotes">
      <p>Past P&amp;L on this venue’s curves only, from the chain, for each address alone. Automated, not advice.</p>
      <p>P&amp;L is after fees, before gas. A position counts once it closes, in the window it closed in.</p>
      <p>A +N beside Closed is positions that left the wallet without a curve sale, such as a sale on Uniswap after graduation: what they fetched is unknown, so they are not counted.</p>
      <p>Some addresses are not ranked. To take yours off, write to <a href="${CONTACT.href}" target="_blank" rel="noopener noreferrer">${CONTACT.label}</a>.</p>
    </div>`);
}

// ------------------------------------------------------- a Portfolio's rank --

/**
 * Read `address`'s standing for its Portfolio, then `done()`. A minute-old
 * answer for the same address is kept; a failed read shows nothing.
 *
 * @param {string} address
 * @param {() => void} done
 */
export async function loadRank(address, done) {
  const a = key(address);
  if (!a) return;
  if (S.rank && S.rank.for === a && Date.now() - S.rank.at < KEEP_MS) return done();
  if (!S.rank || S.rank.for !== a) S.rank = { for: a, data: null, at: 0 };
  const r = await get(`/api/leaders?address=${encodeURIComponent(a)}`);
  if (!S.rank || S.rank.for !== a) return;
  S.rank = { for: a, data: r.status === 200 && r.data && Array.isArray(r.data.windows) ? r.data : null, at: Date.now() };
  done();
}

/**
 * What a Portfolio says of its rank: "#7 over 7 days · #12 all time", or
 * how many closed positions a rank needs. Nothing for an address with no
 * closed position, and nothing for one the answer does not rank at all.
 *
 * @param {any} d the lookup's answer
 */
export function rankText(d) {
  if (!d || !Array.isArray(d.windows)) return "";
  const of = (w) => d.windows.find((x) => x.window === w);
  const week = of("7d"), all = of("all");
  if (!all || all.closed === null || all.closed === undefined) return "";
  const ranks = [];
  if (week && week.rank) ranks.push(`#${week.rank} over 7 days`);
  if (all.rank) ranks.push(`#${all.rank} all time`);
  if (ranks.length) return ranks.join(" · ");
  if (all.closed > 0) return `${all.minClosed} closed positions to be ranked · ${all.closed} so far`;
  return "";
}

/** The rank as a link to the Traders page, for the Portfolio of `address`; "" when there is nothing to say. */
export function rankLine(address) {
  const r = S.rank && S.rank.for === key(address) ? S.rank : null;
  const text = r ? rankText(r.data) : "";
  return text ? html`<a class="pfrank" href="#/traders" title="Ranked by realised P&amp;L on clank.trade’s curves">${text}</a>` : "";
}
