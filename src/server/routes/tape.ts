import { isAddress } from "viem";
import { send, type Route } from "../http.js";
import { broadcast, clients } from "../board.js";
import { indexCursor, indexedTokenTrades, onIndexCommit } from "../../core/lib/chainIndex.js";
import {
  FRAME_CAP, SUPPLY, candlesOf, createTapeCache, framesOf, isTimeframe, pageOf, parseCursor, tradeEvents, type Tape,
} from "../../core/record/tape.js";

/**
 * A token's trades and candles from the chain index, and each new trade live
 * on `/events` (x25-batch2-token-page.md, X25a). Both are free and in the
 * `read` class (E15): each is a cached index read, with no chain call.
 */

/** The process's tapes: one per token per cursor, shared by both routes and the event (E3). */
export const tapes = createTapeCache({ read: indexedTokenTrades, cursor: indexCursor });

// Each window the follower commits: its new trades, once each (E8). A
// catch-up window moves a token's history without moving the cursor, so its
// tokens' tapes are read again.
onIndexCommit((w) => {
  tapes.drop([...w.synced, ...w.trades.map((t) => t.token)]);
  if (w.trades.length === 0 || clients.size === 0) return;
  for (const e of tradeEvents(w.trades, (t) => tapes.get(t))) broadcast("trade", e);
});

type TapeFor = (token: string) => Tape | null;

const notIndexed = (res: Parameters<typeof send>[0]) => send(res, 404, {
  error: "not indexed", indexed: false,
  text: "The index has not read this token's trades up to now yet. Try again in a minute.",
});

/** A whole number from a query, clamped into [lo, hi]; `dflt` when absent, null when not a number. */
function count(raw: string | null, dflt: number, lo: number, hi: number): number | null {
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** `GET /api/trades?token=&before=&limit=`: the tape, newest first, 50 a page (at most 100). */
export function tradesRoute(tapeFor: TapeFor = (t) => tapes.get(t)): Route {
  return {
    name: "trades",
    match: (url) => url.pathname === "/api/trades",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const p = url.searchParams;
      const token = p.get("token") ?? "";
      const limit = count(p.get("limit"), 50, 1, 100);
      const beforeRaw = p.get("before");
      const before = beforeRaw ? parseCursor(beforeRaw) : null;
      if (!isAddress(token, { strict: false }) || limit === null || (beforeRaw && !before)) {
        return send(res, 400, { error: "bad request", text: "Trades need a token's address; before is block:logIndex." });
      }
      const tape = tapeFor(token);
      if (!tape || !tape.indexed) return notIndexed(res);
      const page = pageOf(tape.rows, before, limit);
      return send(res, 200, {
        token: tape.token, asOfBlock: tape.asOfBlock, graduatedAt: tape.graduatedAt, trades: page.trades, next: page.next,
      });
    },
  };
}

/**
 * `GET /api/candles?token=&n=`: 120 candles (24 to 240) from the launch to graduation or now.
 * `GET /api/candles?token=&tf=1s|15s|1m|5m`: fixed-interval candles with volume, the newest
 * FRAME_CAP (the token page's chart, TV1); `n` is then ignored.
 */
export function candlesRoute(tapeFor: TapeFor = (t) => tapes.get(t), now: () => number = Date.now): Route {
  return {
    name: "candles",
    match: (url) => url.pathname === "/api/candles",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const token = url.searchParams.get("token") ?? "";
      const n = count(url.searchParams.get("n"), 120, 24, 240);
      const tf = url.searchParams.get("tf");
      if (!isAddress(token, { strict: false }) || n === null || (tf !== null && !isTimeframe(tf))) {
        return send(res, 400, {
          error: "bad request",
          text: "Candles need a token's address; n is a number of candles; tf is 1s, 15s, 1m or 5m.",
        });
      }
      const tape = tapeFor(token);
      if (!tape || !tape.indexed) return notIndexed(res);
      if (tf !== null) {
        const f = framesOf(tape, tf, now());
        return send(res, 200, {
          token: tape.token, asOfBlock: tape.asOfBlock, supply: SUPPLY, tf, cap: FRAME_CAP, from: f.from, to: f.to,
          graduatedAt: tape.graduatedAt, candles: f.candles,
        });
      }
      const c = candlesOf(tape, n, now());
      return send(res, 200, {
        token: tape.token, asOfBlock: tape.asOfBlock, supply: SUPPLY, from: c.from, to: c.to,
        graduatedAt: tape.graduatedAt, candles: c.candles,
      });
    },
  };
}
