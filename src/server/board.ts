import type { ServerResponse } from "node:http";
import type { Address } from "viem";
import { client, logRoute, wsClient } from "../core/lib/client.js";
import { FACTORIES, VENUE, factoryAt } from "../core/chain.js";
import { curveAbi } from "../core/abi.js";
import { analyze, prefetchSims, sellableOf, type Analysis } from "../core/checker/analyze.js";
import { derive, evaluate, score, type Finding } from "../core/checker/rules.js";
import { allLaunches, noteLaunch } from "../core/lib/launchIndex.js";
import { isKeyRefused, isRateLimited } from "../core/lib/logGate.js";
import { withSource } from "../core/lib/meter.js";
import { hasChainIndex, indexCursor, indexedActivity, indexedHolders, onIndexCommit, wakeFollower } from "../core/lib/chainIndex.js";
import { createLogRetry } from "./logRetry.js";
import * as history from "../core/lib/history.js";
import { poolFor as v4PoolFor } from "../core/market/v4.js";
import { json } from "./http.js";
import { BACKFILL, BOARD_MAX, DEAD_AFTER_S, POOL, REFRESH_MS, SWEEP_MS } from "./config.js";

export type Row = {
  token: Address; curve: Address; creator: Address;
  /** The ERC-20 the curve trades against, or null for native ETH (V4R D3). */
  pairToken?: Address | null;
  name: string; symbol: string; logo: string;
  block: number; launchedAt: number;
  band: string; score: number; findings: Finding[];
  /** Whether a simulated sell went through; null when the check could not run. */
  sellable: boolean | null;
  devBuyPct: number; bundlePct: number; top10Pct: number; holders: number;
  priorLaunches: number; priorDead: number;
  // live economics, refreshed on a timer
  raised: number; threshold: number; progress: number;
  /** Seeded at launch, never paid in — the part of the curve a sell cannot reach. */
  phantomEth: number; feeBps: number;
  tokensPerEth: number; fdvEth: number; graduated: boolean; readyToGraduate: boolean;
  /** The canonical V4 pool, once bonded. Null while the curve is the venue. */
  v4: { poolId: string; liquidity: string; lpFee: number } | null;
  updatedAt: number;
  status: "analysing" | "ready" | "error";
  error?: string;
};

export const rows = new Map<string, Row>();
export const clients = new Set<ServerResponse>();

/**
 * Each row's last analysis, so a change in its holders can be judged again
 * without reading the chain (D1.2).
 */
const analyses = new Map<string, Analysis>();

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${json(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

export function upsert(row: Row) {
  rows.set(row.token.toLowerCase(), row);
  broadcast("row", row);
  trim();
}

// ------------------------------------------------------------ the cap --
// The board holds at most BOARD_MAX tokens (public-release B4.1). Past it,
// the oldest unbonded launch drops off: dead launches are what should go, and
// the few bonded ones are the only old tokens with a real market. A bonded
// token goes only when nothing else can. A token that drops off still works
// from its token page, which checks it and trades from the check (B5.1b).

/** Tokens that must stay on the board. Self pins its open positions; hosted nothing. */
let pinned: (token: string) => boolean = () => false;

/** Keep these tokens on the board whatever its size. A hook, so the board never imports self code. */
export function setPinned(fn: (token: string) => boolean) {
  pinned = fn;
}

/** Whether `a` drops off before `b`: unbonded first, then the older launch, then a fixed order. */
const dropsBefore = (a: Row, b: Row) =>
  a.graduated !== b.graduated ? !a.graduated
  : a.block !== b.block ? a.block < b.block
  : a.token.toLowerCase() < b.token.toLowerCase();

/** Said once when every row over the cap is pinned, not on every upsert. */
let overCap = false;

function trim() {
  while (rows.size > BOARD_MAX) {
    let victim: Row | null = null;
    for (const r of rows.values()) {
      if (pinned(r.token)) continue;
      if (!victim || dropsBefore(r, victim)) victim = r;
    }
    if (!victim) {
      if (!overCap) console.warn(`board: ${rows.size} rows, over its cap of ${BOARD_MAX}, and every one is pinned`);
      overCap = true;
      return;
    }
    evict(victim);
  }
  overCap = false;
}

/** Where the board keeps something for a token, so a test can see eviction leaves nothing behind. */
export function keptFor(token: string) {
  const key = token.toLowerCase();
  return {
    row: rows.has(key), analysis: analyses.has(key), awaitingHistory: awaitingHistory.has(key),
    traded: traded.has(key), retrying: retry.has(key), history: history.series(key).length > 0,
  };
}

/** Take a token off the board, and everything kept for it with it. */
function evict(r: Row) {
  const key = r.token.toLowerCase();
  rows.delete(key);
  analyses.delete(key);
  awaitingHistory.delete(key);
  traded.delete(key);
  retry.forget(key);
  history.forget(key);
  broadcast("evict", { token: r.token });
  console.log(`board: dropped ${r.symbol || "?"} ${r.token} (block ${r.block}), ${rows.size} left`);
}

// ------------------------------------------------------ dead launches --
// A launch that is old and has not traded is dead: the backfill skips it, the
// sweep drops it, and it comes back if it trades (B6). Graduated tokens are
// never dead, and always load, whatever their age (the user, 2026-09-27: CABO
// and CLANKCAT fell off the board after a restart). Hosted only (config.ts).

/** Graduated tokens and each token's newest curve-trade block, from the index. */
export type Activity = { graduated: Set<string>; lastTrade: Map<string, bigint> };

/** Whether a launch at `block` is dead against `cutoff`, the first block of the live window. */
export function isDead(token: string, block: bigint, a: Activity, cutoff: bigint): boolean {
  const k = token.toLowerCase();
  if (a.graduated.has(k)) return false;
  return block < cutoff && (a.lastTrade.get(k) ?? -1n) < cutoff;
}

/**
 * What the backfill loads, newest first: every graduated token, then the
 * newest launches that aren't dead, up to `take` in all. Without the index's
 * activity, the newest `take`, as before B6.
 */
export function pickBackfill<L extends { token: string; block: bigint }>(
  all: L[], take: number, a: Activity | null, cutoff: bigint | null,
): L[] {
  if (!a) return all.slice(-take).reverse();
  const graduated = all.filter((l) => a.graduated.has(l.token.toLowerCase()));
  const live = all.filter((l) => !a.graduated.has(l.token.toLowerCase())
    && (cutoff === null || !isDead(l.token, l.block, a, cutoff)));
  const picked = new Set<L>([...graduated.slice(-take), ...live.slice(-Math.max(0, take - graduated.length))]);
  return all.filter((l) => picked.has(l)).reverse();
}

/** The chain's blocks per second, read once at the backfill; null until then. */
let blockRate: number | null = null;

/** The chain's head and its blocks per second, from the head and the block 100,000 before it. */
async function readChainPace(): Promise<{ head: bigint; rate: number } | null> {
  try {
    const head = await client.getBlock({ blockTag: "latest" });
    const ref = await client.getBlock({ blockNumber: head.number > 100_000n ? head.number - 100_000n : 0n });
    const seconds = Number(head.timestamp - ref.timestamp);
    return seconds > 0 ? { head: head.number, rate: Number(head.number - ref.number) / seconds } : null;
  } catch {
    return null;
  }
}

/** The first block of the live window at `head`, or null when the rule is off or the pace unknown. */
function deadCutoff(head: bigint | null): bigint | null {
  if (DEAD_AFTER_S <= 0 || blockRate === null || head === null) return null;
  const back = BigInt(Math.round(DEAD_AFTER_S * blockRate));
  return head > back ? head - back : 0n;
}

/** Take the rows that have gone dead off the board. Returns how many went. */
export function dropDead(a: Activity, cutoff: bigint): number {
  let dropped = 0;
  for (const r of [...rows.values()]) {
    if (r.status !== "ready" || r.graduated || pinned(r.token)) continue;
    if (isDead(r.token, BigInt(r.block), a, cutoff)) {
      evict(r);
      dropped++;
    }
  }
  return dropped;
}

/** Every launch the backfill and the feed have seen, by token, to bring a dead one back when it trades. */
const known = new Map<string, { token: Address; curve: Address; creator: Address; block: bigint }>();

/** Launches being brought back, so two windows naming one start it once. */
const reviving = new Set<string>();

/**
 * Bring back the launches these curve trades name that are off the board: a
 * trade after the backfill's cut, for a launch the board has seen. Through the
 * list gate when there is one. Returns how many it started.
 */
export function reviveTraded(trades: { token: string; block: bigint }[], deps: AnalyseDeps = ANALYSE_DEPS): number {
  if (!fromIndex.on || fromIndex.cut === null) return 0;
  let started = 0;
  for (const t of trades) {
    const k = t.token.toLowerCase();
    if (t.block <= fromIndex.cut || rows.has(k) || reviving.has(k)) continue;
    const l = known.get(k);
    if (!l) continue;
    reviving.add(k);
    started++;
    const gate = fromIndex.gate;
    const analyse = () => analyseInto(l.token, l.curve, l.creator, Number(l.block), deps);
    void withSource("launch", () => (gate ? gate(l.token, l.creator).then((wanted) => (wanted ? analyse() : undefined)) : analyse()))
      .catch((e) => console.error("[board] bringing back a traded launch failed:", (e as Error).message))
      .finally(() => reviving.delete(k));
  }
  return started;
}

/** A card for a launch not analysed yet, so the board shows it as checking. */
function placeholder(token: Address, curve: Address, creator: Address, block: number) {
  if (rows.has(token.toLowerCase())) return;
  upsert({
    token, curve, creator, name: "", symbol: "", logo: "", block, launchedAt: 0,
    band: "", score: 0, findings: [], sellable: false,
    devBuyPct: 0, bundlePct: 0, top10Pct: 0, holders: 0,
    priorLaunches: 0, priorDead: 0,
    raised: 0, threshold: 0, progress: 0, phantomEth: 0, feeBps: 0,
    tokensPerEth: 0, fdvEth: 0,
    graduated: false, readyToGraduate: false, v4: null,
    updatedAt: Date.now(), status: "analysing",
  });
}

/**
 * Launches the log node refused to let us analyse, tried again once it lets us
 * (public-release B4.6). Ticked by the refresh sweep.
 */
const retry = createLogRetry({
  gateOpen: () => logRoute.state().open,
  async prefetch(batch) {
    await prefetchSims(batch.map((w) => ({ token: w.token, curve: w.curve })));
  },
  analyse: (w) => analyseInto(w.token, w.curve, w.creator, w.block),
  pool: POOL,
});

/** What analysing a launch calls out to, so a test can run it without a chain. */
export type AnalyseDeps = { analyze: typeof analyze; poolFor: typeof v4PoolFor };
const ANALYSE_DEPS: AnalyseDeps = { analyze, poolFor: v4PoolFor };

export async function analyseInto(
  token: Address, curve: Address, creator: Address, block: number, deps: AnalyseDeps = ANALYSE_DEPS,
) {
  const key = token.toLowerCase();
  placeholder(token, curve, creator, block);
  try {
    const a = await deps.analyze(token, { deep: true });
    // Dropped from the board while this ran (B4.1): the answer is no longer
    // wanted, and writing it would put the token back.
    if (!rows.has(key)) return;
    const d = derive(a);
    const findings = evaluate(a, d);
    const s = score(findings);
    const dead = a.creatorLaunches.filter((p) => !p.graduated && p.raised < 10n ** 17n).length;

    // First point of the series, so a token charted the moment it lands has
    // something to draw before the refresh sweep first reaches it.
    // A settled curve's reserves are drained, so its derived price froze at
    // graduation. The live market is the V4 pool; read it and price from there.
    let v4Row: Row["v4"] = null;
    let tokensPerEth = d.tokensPerEth;
    let fdvEth = d.fdvEth;
    if (a.graduated) {
      const pool = await deps.poolFor(a.token).catch(() => null);
      if (pool && pool.tokensPerEth > 0) {
        v4Row = {
          poolId: pool.id,
          liquidity: pool.liquidity.toString(),
          lpFee: pool.lpFee,
        };
        tokensPerEth = pool.tokensPerEth;
        fdvEth = 1e9 / pool.tokensPerEth;
      }
    }

    // The pool read above is a wait too.
    if (!rows.has(key)) return;
    history.record(a.token, fdvEth, Number(a.realQuote) / 1e18);
    analyses.set(key, a);

    upsert({
      token: a.token, curve: a.curve, creator: a.creator,
      name: a.name, symbol: a.symbol, logo: a.logo,
      block: block || rows.get(key)?.block || 0, launchedAt: Number(a.launchedAt),
      band: s.band, score: s.value, findings,
      sellable: sellableOf(a.sim),
      pairToken: a.isNative ? null : a.pairToken,
      devBuyPct: d.creatorBundlePct, bundlePct: d.foreignBundlePct,
      top10Pct: d.top10Pct, holders: a.holders.length,
      priorLaunches: a.creatorLaunches.length, priorDead: dead,
      raised: Number(a.realQuote) / 1e18,
      threshold: Number(a.gradThreshold) / 1e18,
      progress: d.progress,
      phantomEth: Number(a.phantom) / 1e18,
      feeBps: Number(a.feeBps),
      tokensPerEth, fdvEth, v4: v4Row,
      graduated: a.graduated, readyToGraduate: a.readyToGrad,
      updatedAt: Date.now(), status: "ready",
    });
  } catch (e) {
    const prev = rows.get(key);
    // Dropped from the board while this ran (B4.1): nothing to mark.
    if (!prev) return;
    // The log node refusing us is not a verdict on the launch, and neither is
    // the RPC provider refusing our key (current-issues.md #6: a key with an
    // allowlist, or rotated away, failed every launch for good). A card still
    // being checked waits and is tried again. One already judged keeps its
    // verdict (B4.6).
    if (isRateLimited(e) || isKeyRefused(e)) {
      if (prev.status !== "ready") retry.defer({ token, curve, creator, block });
      return;
    }
    const err = e as { shortMessage?: string; message?: string };
    upsert({ ...prev, status: "error", error: err.shortMessage ?? err.message ?? "failed", updatedAt: Date.now() });
  }
}

let sweep = 0;

/**
 * Put freshly read economics on a row. The row is taken again at write time:
 * between the read and now, the index may have judged it again (D1.2), and
 * that must not be overwritten by the copy the read started from.
 */
function applyEconomics(token: Address, patch: Partial<Row>, changed: (r: Row) => boolean) {
  const key = token.toLowerCase();
  const cur = rows.get(key);
  if (!cur) return;
  const next: Row = { ...cur, ...patch, updatedAt: Date.now() };
  const moved = changed(cur);
  rows.set(key, next);
  // The numbers are in hand here; charting them costs nothing extra.
  history.record(next.token, next.fdvEth, next.raised);
  if (moved) broadcast("row", next);
}

/** Re-price bonded tokens off their V4 pool. Two storage reads each. */
async function rereadPools(bonded: Row[]) {
  await Promise.all(bonded.map(async (r) => {
    try {
      const pool = await v4PoolFor(r.token);
      if (!pool || pool.tokensPerEth <= 0) return;
      const fdvEth = 1e9 / pool.tokensPerEth;
      const v4 = { poolId: pool.id, liquidity: pool.liquidity.toString(), lpFee: pool.lpFee };
      applyEconomics(r.token, { fdvEth, tokensPerEth: pool.tokensPerEth, v4 },
        (cur) => fdvEth !== cur.fdvEth || v4.liquidity !== cur.v4?.liquidity);
    } catch { /* a pool read failing just leaves the last price up */ }
  }));
}

/** Re-read curves. Issued together, so the client folds them into one multicall. */
async function rereadCurves(live: Row[]) {
  const results = await Promise.all(
    live.map(async (r) => {
      try {
        const C = { address: r.curve, abi: curveAbi } as const;
        const [realQuote, quoteReserve, tokenReserve, graduated, ready] = await Promise.all([
          client.readContract({ ...C, functionName: "realQuoteReserve" }),
          client.readContract({ ...C, functionName: "quoteReserve" }),
          client.readContract({ ...C, functionName: "tokenReserve" }),
          client.readContract({ ...C, functionName: "graduated" }),
          client.readContract({ ...C, functionName: "readyToGraduate" }),
        ]);
        return { r, realQuote, quoteReserve, tokenReserve, graduated, ready };
      } catch {
        return null;
      }
    }),
  );
  for (const res of results) {
    if (!res) continue;
    const { r, realQuote, quoteReserve, tokenReserve, graduated, ready } = res;
    const raised = Number(realQuote) / 1e18;
    const tokensPerEth = Number(tokenReserve) / Number(quoteReserve);
    applyEconomics(r.token, {
      raised, tokensPerEth, fdvEth: 1e9 / tokensPerEth,
      progress: r.threshold > 0 ? raised / r.threshold : 0,
      graduated, readyToGraduate: ready,
    }, (cur) => raised !== cur.raised || graduated !== cur.graduated || ready !== cur.readyToGraduate);
  }
}

/** Re-read these rows' markets: curves in one multicall, pools as their own reads. */
async function reread(targets: Row[]) {
  const ready = targets.filter((r) => r.status === "ready");
  await Promise.all([
    rereadCurves(ready.filter((r) => !r.graduated)),
    rereadPools(ready.filter((r) => r.graduated)),
  ]);
  history.save();
}

/**
 * How often the timed sweep runs. With the chain index it is a safety net,
 * every 2 minutes: a row is re-read as soon as the follower sees it trade
 * (below). Without one, every 10 s, as before D1.3.
 */
export const refreshEvery = () => (hasChainIndex() ? SWEEP_MS : REFRESH_MS);

/**
 * The timed sweep: every row's market, in case a trade was missed.
 *
 * Two things keep this cheap. Every row's reads are issued concurrently, so
 * the client folds all of them into a single Multicall3 aggregate3 rather than
 * one call per row. And a curve that has raised nothing and is no longer new
 * is checked every fourth sweep instead of every sweep — most of the board is
 * dead launches that will never move again.
 */
export function refreshEconomics(): Promise<void> {
  // Counted as the sweep (D1.0), with the retries and pool reads it starts.
  return withSource("sweep", sweepEconomics);
}

async function sweepEconomics() {
  sweep++;
  const a = DEAD_AFTER_S > 0 ? indexedActivity() : null;
  const cutoff = deadCutoff(indexCursor());
  if (a && cutoff !== null) {
    const n = dropDead(a, cutoff);
    if (n > 0) console.log(`board: ${n} launch(es) with no trade in ${DEAD_AFTER_S / 3600} h dropped, ${rows.size} left`);
  }
  const now = Date.now() / 1000;
  // Launches the log node refused, tried again once it lets us (B4.6).
  void retry.tick();
  // Bonded tokens still move — their market is just the V4 pool now.
  const targets = [...rows.values()].filter((r) => {
    if (r.status !== "ready") return false;
    if (r.graduated) return true;
    const stale = r.raised === 0 && r.launchedAt > 0 && now - r.launchedAt > 900;
    return !stale || sweep % 4 === 0;
  });
  if (targets.length > 0) await reread(targets);
}

// ------------------------------------------------ re-reads driven by trades --
// A curve trade or a pool swap moves the token, so a token with Transfers in
// a committed window is a row that traded (D1.3). The windows of one round
// land within milliseconds of each other; the rows they name are re-read
// together once the round goes quiet: one multicall for the curves.

const traded = new Set<string>();
let rereadTimer: ReturnType<typeof setTimeout> | null = null;

function rereadTraded() {
  rereadTimer = null;
  const targets = [...traded].map((k) => rows.get(k)).filter((r): r is Row => !!r);
  traded.clear();
  if (targets.length > 0) void withSource("trades", () => reread(targets));
}

onIndexCommit((w) => {
  for (const t of w.changed) if (rows.has(t)) traded.add(t);
  // A pool the index just learned: its token's price moves to it now.
  for (const p of w.pools) if (rows.has(p.token)) traded.add(p.token);
  if (traded.size > 0 && !rereadTimer) rereadTimer = setTimeout(rereadTraded, 50);
});

/**
 * Load the most recent launches onto the board.
 *
 * `active` is how self mode's off switch stops it: checked before each slow
 * step and by the retry timer, so a backfill begun before the switch went off
 * goes no further. Hosted has no switch and passes nothing.
 */
export function backfill(opts: { active?: () => boolean; gate?: LaunchGate } = {}): Promise<void> {
  return withSource("backfill", () => backfillOnce(opts));
}

async function backfillOnce(opts: { active?: () => boolean; gate?: LaunchGate }): Promise<void> {
  const active = opts.active ?? (() => true);
  if (!active()) return;
  // Served by the shared launch index — one scan, reused by every analyse.
  // The entries call this with `void`, so a rejection here would be unhandled
  // and would end the process. A failure is tried again instead (B4.6).
  let all: Awaited<ReturnType<typeof allLaunches>>;
  try {
    all = await allLaunches();
  } catch (e) {
    if (!active()) return;
    const waitMs = Math.max(30_000, logRoute.state().retryInMs + 1_000);
    console.warn(`launch index ${isRateLimited(e) ? "refused by the log node (429)" : "failed"}; `
      + `backfill again in ${Math.round(waitMs / 1000)}s:`, (e as Error)?.message?.split("\n")[0]?.slice(0, 120));
    setTimeout(() => void backfill(opts), waitMs).unref();
    return;
  }
  if (!active()) return;
  // Launches after the newest one here are new: the index puts them on the
  // board as it commits them (step 5, above).
  indexFeed({ cut: all.at(-1)?.block ?? 0n, gate: opts.gate });
  // Never more than the board holds (B4.1): the rest would be analysed only
  // to be dropped again.
  const take = Math.min(BACKFILL, BOARD_MAX);
  if (take < BACKFILL) console.log(`backfill cut to ${take}, the board's cap (WEB_BACKFILL is ${BACKFILL})`);
  for (const l of all) known.set(l.token.toLowerCase(), l);
  // Graduated tokens first, whatever their age; then the newest live launches (B6).
  const activity = indexedActivity();
  let head: bigint | null = null;
  if (DEAD_AFTER_S > 0 && activity) {
    const pace = await readChainPace();
    if (pace) { blockRate = pace.rate; head = pace.head; }
    if (!active()) return;
  }
  const cutoff = DEAD_AFTER_S > 0 ? deadCutoff(head ?? indexCursor()) : null;
  let recent = pickBackfill(all, take, activity, cutoff);
  if (activity) {
    const dead = cutoff === null ? 0 : all.filter((l) => isDead(l.token, l.block, activity, cutoff)).length;
    const graduated = recent.filter((l) => activity.graduated.has(l.token.toLowerCase())).length;
    console.log(`backfill: ${graduated} graduated token(s), ${dead} dead launch(es) of ${all.length} left unread`);
  }
  // With a list, history is read the same way the feed is: only what was named.
  if (opts.gate) {
    const keep = await Promise.all(recent.map((l) => opts.gate!(l.token, l.creator).catch(() => false)));
    recent = recent.filter((_, i) => keep[i]);
  }
  // With the chain index, a launch whose Transfers it has not read yet waits
  // for them (D1.2): its card shows as checking and is judged when the
  // follower catches it up (`onIndexCommit` below), so no launch is scanned
  // on its own. Without an index, every one is, as before D1.
  if (hasChainIndex()) {
    const waiting = recent.filter((l) => !indexedHolders(l.token));
    for (const l of waiting) {
      placeholder(l.token, l.curve, l.creator, Number(l.block));
      awaitingHistory.add(l.token.toLowerCase());
    }
    if (waiting.length > 0) console.log(`${waiting.length} launch(es) wait for the index to read their holders`);
    recent = recent.filter((l) => !awaitingHistory.has(l.token.toLowerCase()));
  }
  console.log(`backfilling ${recent.length} launch(es)…`);
  const t0 = Date.now();

  // One simulation request per 8 round trips, so each analyse() below finds
  // its sellability check already cached.
  const [simPre] = await Promise.allSettled([prefetchSims(recent.map((l) => ({ token: l.token, curve: l.curve })))]);
  if (!active()) return;
  if (simPre.status === "rejected") {
    console.warn("prefetch sims failed, falling back per-token:", (simPre.reason as Error)?.message?.slice(0, 160));
  }

  // Analyse in pools so the remaining reads fold into multicalls ACROSS tokens
  // rather than one set per token.
  for (let i = 0; i < recent.length; i += POOL) {
    if (!active()) {
      console.log(`backfill stopped after ${i} of ${recent.length}: the system was switched off`);
      return;
    }
    await Promise.all(
      recent.slice(i, i + POOL).map((l) => analyseInto(l.token, l.curve, l.creator, Number(l.block))),
    );
  }
  console.log(`backfill complete in ${Date.now() - t0}ms`);
  broadcast("ready", { count: rows.size });
}

// ---------------------------------------------------- the index's holders --

/** Launches on the board waiting for the index to read their holders (D1.2). */
const awaitingHistory = new Set<string>();
/** Of those, the ones read and queued to be judged, `POOL` at a time. */
const judgeQueue: string[] = [];
let judging = 0;

function judgeNext() {
  while (judging < POOL && judgeQueue.length > 0) {
    const key = judgeQueue.shift()!;
    const r = rows.get(key);
    if (!r) continue;
    judging++;
    void withSource("backfill", () => analyseInto(r.token, r.curve, r.creator, r.block))
      .finally(() => { judging--; judgeNext(); });
  }
}

/**
 * A row judged again with its holders from the index: holder count, top 10,
 * the creator's and the launch block's figures, and the verdict they feed.
 * Everything else is the last analysis's, so it costs no read.
 */
function rejudgeHolders(key: string) {
  const a = analyses.get(key);
  const r = rows.get(key);
  if (!a || !r || r.status !== "ready") return;
  const ix = indexedHolders(key);
  if (!ix) return;
  const next: Analysis = {
    ...a,
    holders: ix.holders.map((h) => ({ ...h, address: h.address as Address })),
    totalSupply: ix.supply > 0n ? ix.supply : a.totalSupply,
  };
  analyses.set(key, next);
  const d = derive(next);
  const findings = evaluate(next, d);
  const s = score(findings);
  const row: Row = {
    ...r, band: s.band, score: s.value, findings,
    devBuyPct: d.creatorBundlePct, bundlePct: d.foreignBundlePct,
    top10Pct: d.top10Pct, holders: next.holders.length, updatedAt: Date.now(),
  };
  const changed = row.band !== r.band || row.score !== r.score || row.holders !== r.holders
    || row.top10Pct !== r.top10Pct || row.devBuyPct !== r.devBuyPct || row.bundlePct !== r.bundlePct;
  rows.set(key, row);
  if (changed) broadcast("row", row);
}

// ------------------------------------------- launches without the feed --
// The websocket was the only way a new launch reached the board: the chain
// index's follower committed it to the launch index, and nothing put it on
// the board. With the websocket down, the board froze at its backfill until
// a restart (current-issues.md #6, step 5). Now each launch the follower
// commits goes on the board too, so a dead websocket only costs a round.
//
// Hosted only: a self page's feed calls the sniper for each launch, and a
// launch the index put on the board first would never reach it. Only
// launches after the newest one the backfill saw: the follower's first rounds
// commit the whole history, which is the backfill's to load.

/** Whether the index feeds the board, the newest launch the backfill saw, and the list gate if any. */
const fromIndex: { on: boolean; cut: bigint | null; gate?: LaunchGate } = { on: false, cut: null };

/** Set how the index feeds the board. The feed and the backfill set it; a test sets it directly. */
export function indexFeed(s: Partial<typeof fromIndex>) {
  Object.assign(fromIndex, s);
}

/**
 * Put the launches a committed window found on the board, as the websocket's
 * feed does, minus the sniper. Returns how many it started.
 */
export function addIndexedLaunches(
  launches: { token: string; curve: string; creator: string; block: bigint }[], deps: AnalyseDeps = ANALYSE_DEPS,
): number {
  // Every launch the index names is one a dead launch's trade may bring back (B6), fed or not.
  for (const l of launches) {
    known.set(l.token.toLowerCase(), { token: l.token as Address, curve: l.curve as Address, creator: l.creator as Address, block: l.block });
  }
  if (!fromIndex.on || fromIndex.cut === null) return 0;
  let started = 0;
  for (const l of launches) {
    if (l.block <= fromIndex.cut || rows.has(l.token.toLowerCase())) continue;
    started++;
    const token = l.token as Address, creator = l.creator as Address;
    broadcast("launch", { token, block: Number(l.block) });
    const gate = fromIndex.gate;
    const analyse = () => analyseInto(token, l.curve as Address, creator, Number(l.block), deps);
    // With no list, its card goes up now, so a second window naming it finds it there.
    void withSource("launch", () => (gate ? gate(token, creator).then((wanted) => (wanted ? analyse() : undefined)) : analyse()))
      .catch((e) => console.error("[board] a launch from the index failed:", (e as Error).message));
  }
  return started;
}

onIndexCommit((w) => { addIndexedLaunches(w.launches); });

// A dead launch that trades again comes back (B6). Hosted only, with the rule on.
onIndexCommit((w) => { if (DEAD_AFTER_S > 0) reviveTraded(w.trades); });

// Each window the follower commits: judge the launches whose holders just
// came in, and judge again the rows whose holders moved.
onIndexCommit((w) => {
  for (const t of w.synced) {
    if (awaitingHistory.has(t) && indexedHolders(t)) {
      awaitingHistory.delete(t);
      judgeQueue.push(t);
    }
  }
  judgeNext();
  for (const t of w.changed) if (!awaitingHistory.has(t)) rejudgeHolders(t);
});

/**
 * What happens to a launch after it is analysed. Self mode passes the
 * sniper's `judge`; hosted passes nothing. Taking it as a parameter keeps the
 * board from importing the sniper, so a hosted process never loads it.
 */
/**
 * Whether a launch is worth analysing at all. Self mode passes the watchlist
 * here so a launch nobody named costs one cheap read instead of ~73, most of
 * them log scans against a node that rate-limits (pons-venue.md). A hook, not
 * an import, for the same reason `LaunchHook` is: the board is shared with the
 * hosted build, which must never load the sniper's code.
 */
export type LaunchGate = (token: Address, creator: Address) => Promise<boolean>;

export type LaunchHook = (
  token: Address, curve: Address, creator: Address, block: number, detectedAt: number,
  graduationThreshold?: bigint,
) => Promise<unknown>;

/** Watch the factory for launches. Returns the unwatch, or null with no feed. */
export function subscribe(onLaunch?: LaunchHook, gate?: LaunchGate): (() => void) | null {
  // Without a sniper to call, the index feeds the board too (step 5), with or
  // without a websocket.
  indexFeed({ on: !onLaunch });
  if (!wsClient) {
    console.warn("WS_URL not set — live launches will not stream in.");
    return null;
  }
  const ws = wsClient;
  // The subscription and what it delivers are counted as the feed (D1.0).
  return withSource("feed", () => ws.watchEvent({
    // Every listed factory (B1.5). The node filters by address, and the check
    // below repeats it: other launchpads emit this same event, and a launch
    // from one of them is not this venue's.
    address: FACTORIES.map((f) => f.address as Address),
    onLogs: (logs) => {
      // The follower reads these for itself; this only tells it to look soon (D1.1).
      wakeFollower();
      for (const l of logs) {
        if (l.topics[0]?.toLowerCase() !== VENUE.launchTopic) continue;
        if (!factoryAt(l.address)) continue;
        const token = `0x${l.topics[1]!.slice(26)}` as Address;
        if (rows.has(token.toLowerCase())) continue;
        const curve = `0x${l.topics[2]!.slice(26)}` as Address;
        const creator = `0x${l.topics[3]!.slice(26)}` as Address;
        // The graduation target rides along in the event, so the sniper can
        // judge a launch's shape before anything has traded (pons-venue.md V5).
        const data = (l as { data?: `0x${string}` }).data ?? "0x";
        const graduationThreshold = data.length >= 2 + 3 * 64 ? BigInt(`0x${data.slice(2 + 2 * 64, 2 + 3 * 64)}`) : 0n;
        // Feed the index directly so no history rescan is triggered.
        noteLaunch({ token, curve, creator, block: l.blockNumber ?? 0n, graduationThreshold });
        console.log(`new launch ${token}`);
        broadcast("launch", { token, block: Number(l.blockNumber ?? 0n) });
        const detectedAt = Date.now();
        const block = Number(l.blockNumber ?? 0n);
        // Counted as a launch (D1.0): the whole chain is started inside, so
        // every step of it is.
        void withSource("launch", () => (gate ? gate(token, creator) : Promise.resolve(true)).then((wanted) => {
          // Not on the list: seen, broadcast, and left there. Analysing it
          // would spend the read budget on a launch nobody asked about.
          if (!wanted) return;
          return analyseInto(token, curve, creator, block)
          // analyse() is cached by this point, so judging costs almost nothing
          // extra. It runs whether or not the sniper is armed — a decision to
          // decline is the one worth recording.
          .then(() => onLaunch?.(token, curve, creator, block, detectedAt, graduationThreshold));
        }).catch((e) => console.error("[sniper] judge failed:", (e as Error).message)));
      }
    },
    onError: (e) => console.error("ws error:", e.message),
  }));
}
