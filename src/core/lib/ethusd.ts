import { readJson, writeJson } from "./jsonStore.js";
import { ethUsd } from "./price.js";

/**
 * ETH/USD on a given day, for the trade replay's dollar figures
 * (docs/specs/trade-replay.md): a trade from August is worth August's dollars,
 * not today's. Daily closes from Coinbase's public candles, kept on disk;
 * today is the live spot price the console already reads. Only dates go out.
 */

const FILE = process.env.ETHUSD_FILE ?? "data/ethusd-daily.json";
const URL_ = process.env.ETHUSD_HISTORY_URL ?? "https://api.exchange.coinbase.com/products/ETH-USD/candles";
const DAY = 86_400_000;
/** Coinbase returns at most 300 candles a request. */
const PER_REQUEST = 300;

/** `gaps`: past days the source had no close for, so they are not asked for again. */
type Store = { closes: Record<string, number>; gaps?: string[] };

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function load(): Store {
  const s = readJson<Store | null>(FILE, null, {
    valid: (v) => typeof v === "object" && v !== null && typeof (v as Store).closes === "object",
  });
  return s ?? { closes: {} };
}

/** Coinbase's rows: [time (s), low, high, open, close, volume], newest first. */
async function fetchCloses(fromDay: number, toDay: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let d = fromDay; d <= toDay; d += PER_REQUEST) {
    const end = Math.min(toDay, d + PER_REQUEST - 1);
    const q = new URLSearchParams({
      granularity: "86400", start: new Date(d * DAY).toISOString(), end: new Date((end + 1) * DAY).toISOString(),
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch(`${URL_}?${q}`, { signal: ctl.signal, headers: { "user-agent": "clankbot" } });
      if (!r.ok) throw new Error(`ETH/USD history: HTTP ${r.status}`);
      const rows = (await r.json()) as number[][];
      for (const row of rows) {
        const [time, , , , close] = row;
        if (typeof time === "number" && typeof close === "number" && close > 0) out[dayOf(time * 1000)] = close;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/**
 * The ETH/USD close of every day from `fromMs` to `toMs`, by "YYYY-MM-DD".
 * Today is the live price. A day the source has no close for takes the last
 * close before it. Days already on disk are not asked for again.
 */
export async function dailyUsd(fromMs: number, toMs: number, now = Date.now()): Promise<Record<string, number>> {
  const store = load();
  const today = dayOf(now);
  const first = Math.floor(fromMs / DAY), last = Math.floor(Math.min(toMs, now) / DAY);
  const missing: number[] = [];
  const gaps = new Set(store.gaps ?? []);
  for (let d = first; d <= last; d++) {
    const k = dayOf(d * DAY);
    if (k !== today && !(k in store.closes) && !gaps.has(k)) missing.push(d);
  }
  if (missing.length) {
    const got = await fetchCloses(missing[0]!, missing[missing.length - 1]!);
    Object.assign(store.closes, got);
    // A day more than two days old with no close will not get one: remember
    // it. A recent one may only be late, and is asked for again.
    for (const d of missing) {
      const k = dayOf(d * DAY);
      if (!(k in got) && now - (d + 1) * DAY > 2 * DAY) gaps.add(k);
    }
    store.gaps = [...gaps].sort();
    writeJson(FILE, store);
  }
  const out: Record<string, number> = {};
  let carry: number | null = null;
  for (let d = first - 7; d <= last; d++) {
    const k = dayOf(d * DAY);
    const v: number | null = k === today ? (ethUsd() ?? store.closes[k] ?? carry) : (store.closes[k] ?? carry);
    if (v != null) carry = v;
    if (d >= first && v != null) out[k] = v;
  }
  return out;
}
