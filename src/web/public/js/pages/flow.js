import { S } from "../core/store.js";
import { $ } from "../core/dom.js";
import { PROJECT_TOKEN } from "../core/constants.js";
import { BANDS, guardPct, valueOf } from "../core/domain.js";
import { XI, eth, n } from "../core/format.js";
import { rows } from "../core/store.js";
import { CHAIN_ID, MAX_SENDS_PER_MINUTE } from "../trade/constants.js";
import { IDLE_MS } from "../wallet/session.js";

// ====================================================================== //
// the story (public-release F5.8)                                        //
// ====================================================================== //
//
// Above the curve cards, in both modes: why we exist, what we do with a
// trade, what it is built on, and what we control. It is the web app's story;
// the console shows it word for word under one line that says so. Its
// numbers are the constants the rest of the page runs on, written here, so
// the story cannot say one thing while the code does another.

/** A value in the story: `#fs-<name>`, and `#fsp-<name>` where a phone drawing has it too. */
const inStory = (name, text) => {
  for (const id of ["#fs-" + name, "#fsp-" + name]) {
    const el = $(id);
    if (el) el.textContent = text;
  }
};

/**
 * Which wallet the story's trade signs with, as About's trust section decides
 * it: "trading" where this origin has a trading wallet, "own" where the page
 * trades from the visitor's own wallet. The console tells the web app's story,
 * which is the trading wallet's.
 */
export const storyWallet = () => (S.mode !== "hosted" || S.login.here === true ? "trading" : "own");

function renderStory() {
  const page = $("#pg-flow");
  if (page) page.dataset.wallet = storyWallet();
  inStory("bands", String(Object.keys(BANDS).length));
  inStory("chain", String(CHAIN_ID));
  inStory("idle", String(Math.round(IDLE_MS / 60_000)));
  inStory("sends", String(MAX_SENDS_PER_MINUTE));
  inStory("cum", PROJECT_TOKEN.symbol);
  inStory("cumlink", PROJECT_TOKEN.symbol);
}

// ====================================================================== //
// flow                                                                   //
// ====================================================================== //

/**
 * A value that sits inside a diagram. Each diagram is drawn twice, wide and
 * for a phone (public-release F5.7), so it goes into both: `#fl-<name>` and
 * `#flp-<name>`. The graduation diagram has a second pair for a hosted page,
 * in neutral words (F5.3): `#flh-<name>` and `#flhp-<name>`. A drawing that
 * has no such value simply has no such id.
 */
const inDiagram = (name, text) => {
  for (const id of ["#fl-" + name, "#flp-" + name, "#flh-" + name, "#flhp-" + name]) {
    const el = $(id);
    if (el) el.textContent = text;
  }
};

export function renderFlow() {
  renderStory();
  const hosted = S.mode === "hosted";
  // The diagram describes a mechanism, but the numbers on it are a real
  // curve — the one with the most raised, since that is where the ceiling
  // and the guard actually bite.
  const r = [...rows.values()]
    .filter((x) => x.status === "ready" && !x.graduated)
    .sort((a, b) => b.raised - a.raised)[0];
  const guard = guardPct();

  $("#fl-caption").textContent = r
    ? `${r.symbol} — a curve that has raised ${eth(r.raised)} ${XI}`
    : "No curve is trading right now";
  inDiagram("real", r ? eth(r.raised, 2) : "—");
  inDiagram("phantom", r ? eth(r.phantomEth, 2) : "—");

  // "Your buy" is the sniper's size on the console, and the visitor's own
  // quick-buy size on a hosted page, which has no sniper.
  const amount = hosted ? S.buySize : S.cfg ? valueOf(S.cfg.sizing, "SNIPE_AMOUNT_ETH") : null;
  inDiagram("buy", amount ? `${eth(amount)} ${XI}` : "—");

  const thr = r ? n(r.threshold) : 0;
  $("#fl-thr").textContent = thr ? `${eth(thr)} ${XI}` : "graduation";
  inDiagram("thr2", thr ? eth(thr) : "—");
  inDiagram("guardpct", guard + "%");
  inDiagram("guard", thr
    ? `Guard at ${eth(thr * guard / 100)} ${XI}` : `Guard at ${guard}%`);

  const graduated = [...rows.values()].filter((x) => x.graduated).length;
  $("#fl-gradnote").textContent = graduated
    ? `${graduated} launch${graduated === 1 ? " has" : "es have"} graduated — the migration is observable`
    : "No launch on this pad has graduated yet — the migration is unobserved";

  // What a capped exit has actually cost, if it has cost anything yet.
  const capped = S.positions.closed.filter((p) => p.closed &&
    /partial|graduation/i.test(p.closed.reason) &&
    n(p.closed.proceedsEth) < n(p.costEth));
  $("#fl-guardcost").textContent = capped.length
    ? `It costs something: ${capped.map((p) => p.symbol).join(", ")} closed below entry on a capped exit.`
    : "It costs something when the first sell is capped and the rest has to go later, and worse.";

  const fee = r ? r.feeBps : null;
  $("#fl-feein").textContent = fee === null ? "—" : `${fee} bps`;
  $("#fl-feeout").textContent = fee === null ? "—" : `${fee} bps`;
  $("#fl-feenote").textContent = hosted ? hostedFeeNote(fee) : fee === null
    ? "A position opens below water before anything moves — the fee is charged on the way in and again on the way out. That is why a dry-run entry is valued after a simulated buy of the same size."
    : `A position opens at about −${(fee * 2 / 100).toFixed(1)}% before anything moves. That is why a dry-run entry is valued after a simulated buy of the same size — against spot it would read −100% and trip its own stop within seconds.`;
}

/** The fee card on a hosted page: what the fee does to a position, without the console's dry runs and stops. */
const hostedFeeNote = (fee) => fee === null
  ? "A position opens below water before anything moves: the fee is charged on the way in and again on the way out."
  : `A position opens at about −${(fee * 2 / 100).toFixed(1)}% before anything moves: the fee is charged on the way in and again on the way out.`;
