import { readJson, writeJson } from "./jsonStore.js";

/**
 * Price history for the per-token chart.
 *
 * There is no swap event on these curves — the reconstructed ABI has `Launch`
 * and ERC20 `Transfer` and nothing else — so there is no log to replay into
 * candles. Deriving price per trade from Transfer flow plus the constant-product
 * invariant is possible but drifts: `k` grows with every fee, so the error
 * compounds backwards over exactly the range a chart is meant to show.
 *
 * So this samples instead. The dashboard already re-reads every live curve's
 * reserves on a timer; each sweep drops a point in here. That costs no extra
 * RPC at all, and the honest claim it supports — "since clankbot started
 * watching" — is one the chart can actually make good on. The alternative was a
 * prettier line that was partly invented.
 */

const FILE = process.env.HISTORY_FILE ?? "data/history.json";
/**
 * Points kept per token. At the 10 s sweep this is about two hours; with the
 * chain index a point is taken at each trade and each 2-minute sweep (D1.3),
 * so it spans longer the quieter the token.
 */
const KEEP = Number(process.env.HISTORY_POINTS ?? 720);
/** Tokens untouched for this long are dropped on the next save. */
const TTL_MS = Number(process.env.HISTORY_TTL_MS ?? 6 * 3600_000);

/** [unix seconds, market cap in ETH, raised in ETH] — packed to keep the file small. */
export type Point = [number, number, number];

type Store = Record<string, Point[]>;

let store: Store | null = null;
let dirty = false;

const isStore = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

/** The server is the only writer, so memory is authoritative and no lock is needed. */
function load(): Store {
  return (store ??= readJson<Store>(FILE, {}, { valid: isStore }));
}

/**
 * Record a sample.
 *
 * Consecutive identical readings are collapsed: most of the board is dead
 * launches that never move again, and keeping 720 copies of the same number
 * costs a chart its resolution over the range where something did happen. The
 * last point is always advanced in time so the line still reaches "now".
 */
export function record(token: string, mcEth: number, raisedEth: number, at = Date.now()) {
  const all = load();
  const key = token.toLowerCase();
  const series = (all[key] ??= []);
  const t = Math.round(at / 1000);
  const prev = series[series.length - 1];

  if (prev && prev[1] === mcEth && prev[2] === raisedEth) {
    // Same reading: move the existing point forward rather than adding one,
    // unless the gap is large enough that the flat stretch is itself the story.
    if (t - prev[0] < 300) { prev[0] = t; dirty = true; return; }
  }
  series.push([t, mcEth, raisedEth]);
  if (series.length > KEEP) series.splice(0, series.length - KEEP);
  dirty = true;
}

/**
 * Drop a token's series: it left the board (public-release B4.1). The next
 * save writes it out of the file, so a stale line is never drawn for it again.
 */
export function forget(token: string) {
  const all = load();
  const key = token.toLowerCase();
  if (!(key in all)) return;
  delete all[key];
  dirty = true;
}

export function series(token: string): Point[] {
  return load()[token.toLowerCase()] ?? [];
}

export function save() {
  if (!dirty || !store) return;
  const cutoff = Math.round((Date.now() - TTL_MS) / 1000);
  for (const [key, pts] of Object.entries(store)) {
    if (pts.length === 0 || pts[pts.length - 1]![0] < cutoff) delete store[key];
  }
  writeJson(FILE, store);
  dirty = false;
}

export const historyStats = () => {
  const all = load();
  const keys = Object.keys(all);
  return {
    tokens: keys.length,
    points: keys.reduce((s, k) => s + all[k]!.length, 0),
  };
};
