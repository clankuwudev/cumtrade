import type { Address } from "viem";
import { isRateLimited } from "../core/lib/logGate.js";

/**
 * Launches whose analysis the log node refused, waiting to be tried again
 * (public-release B4.6).
 *
 * A refusal is "not yet", not a verdict: the row stays `analysing` and waits
 * here. Each tick, if the gate is open, one pass takes everything waiting,
 * newest launch first, `pool` at a time: one holders prefetch for the chunk,
 * then its analyses. A refusal stops the pass, and whatever is left waits for
 * the next tick. One prefetch for everything was refused outright once the
 * board passed a hundred launches (2026-09-23): a scan that wide is one the
 * public node will not take, however long it is left to rest.
 *
 * The dependencies are injected, so this has no chain and no board of its
 * own and can be tested with fakes. board.ts supplies the real ones.
 */
export type Waiting = { token: Address; curve: Address; creator: Address; block: number };

export function createLogRetry(deps: {
  /** Whether a log request would go out now. */
  gateOpen: () => boolean;
  /** One holders scan for the whole batch, as the backfill does. */
  prefetch: (batch: Waiting[]) => Promise<void>;
  /** Analyse one launch. It defers the launch again itself if it is refused. */
  analyse: (w: Waiting) => Promise<void>;
  pool: number;
}) {
  const waiting = new Map<string, Waiting>();
  let running = false;

  return {
    defer(w: Waiting) {
      waiting.set(w.token.toLowerCase(), w);
    },

    has(token: string) {
      return waiting.has(token.toLowerCase());
    },

    /** Stop waiting on a launch: it left the board (public-release B4.1). */
    forget(token: string) {
      waiting.delete(token.toLowerCase());
    },

    /** One pass, if anything waits and the gate is open. Never runs twice at once. */
    async tick(): Promise<{ analysed: number }> {
      if (running || waiting.size === 0 || !deps.gateOpen()) return { analysed: 0 };
      running = true;
      let analysed = 0;
      try {
        // Newest first: the shortest scans, and the launches people look at.
        const batch = [...waiting.values()].sort((a, b) => b.block - a.block);
        for (let i = 0; i < batch.length; i += deps.pool) {
          // A refusal earlier in this pass closed the gate: stop here.
          if (!deps.gateOpen()) break;
          const chunk = batch.slice(i, i + deps.pool);
          try {
            await deps.prefetch(chunk);
          } catch (e) {
            // Refused again: this chunk and the rest keep waiting, and the
            // gate's backoff grows.
            if (isRateLimited(e)) return { analysed };
            // Anything else: each analysis scans for itself, as the backfill's
            // fallback always has.
          }
          for (const w of chunk) waiting.delete(w.token.toLowerCase());
          await Promise.all(chunk.map((w) => deps.analyse(w)));
          analysed += chunk.length;
        }
        return { analysed };
      } finally {
        running = false;
      }
    },

    get size() {
      return waiting.size;
    },
  };
}
