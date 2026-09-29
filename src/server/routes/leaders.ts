import { isAddress } from "viem";
import { send, type Route } from "../http.js";
import { DEFAULT_WINDOW, MAX_ROWS, WINDOWS, leaderboard, type Leaderboard } from "../leaderboard.js";
import type { Window } from "../../core/record/leaders.js";

/**
 * `GET /api/leaders?window=7d|30d|all&limit=` and `GET /api/leaders?address=0x…`
 * (x29-leaderboard.md, X29a): the addresses that realised the most on this
 * venue's curves, or one address's standing in each window. Free, in the
 * `read` class (E15); an answer is the board's until its next rebuild.
 */

const notIndexed = (res: Parameters<typeof send>[0]) => send(res, 404, {
  error: "not indexed", indexed: false,
  text: "The index has not read the chain's trades yet. Try again in a minute.",
});

/** A whole number from a query, clamped into [lo, hi]; `dflt` when absent, null when not a number. */
function count(raw: string | null, dflt: number, lo: number, hi: number): number | null {
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

export function leadersRoute(board: Pick<Leaderboard, "page" | "standing"> = leaderboard): Route {
  return {
    name: "leaders",
    match: (url) => url.pathname === "/api/leaders",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const p = url.searchParams;
      const address = p.get("address");
      if (address !== null) {
        if (!isAddress(address, { strict: false })) {
          return send(res, 400, { error: "bad request", text: "address is not an address." });
        }
        const s = await board.standing(address);
        return s ? send(res, 200, s) : notIndexed(res);
      }
      const window = (p.get("window") || DEFAULT_WINDOW) as Window;
      const limit = count(p.get("limit"), 50, 1, MAX_ROWS);
      if (!WINDOWS.includes(window) || limit === null) {
        return send(res, 400, { error: "bad request", text: "window is 7d, 30d or all; limit is a number." });
      }
      const page = await board.page(window, limit);
      return page ? send(res, 200, page) : notIndexed(res);
    },
  };
}
