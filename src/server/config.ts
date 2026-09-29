import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** `src/web`, which holds `public/`: the directory the server lived in before the split. */
export const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
export const PORT = Number(process.env.WEB_PORT ?? 8787);
/** How many past launches to load on boot. */
export const BACKFILL = Number(process.env.WEB_BACKFILL ?? 40);
/**
 * The most tokens the board holds (public-release B4.1). Every row is on the
 * sweep, so this bounds RPC as well as memory. At about 17 launches a day,
 * 200 is the last twelve days or so.
 *
 * Hosted only by default (the user, 2026-09-23). The console trades only from
 * a board row, and a token it checks joins its board as the oldest, so a full
 * console board would drop a checked token at once and leave it untradable.
 * The console stays unbounded unless this is set, and then pins what it holds.
 */
const HOSTED = (globalThis as { __CLANK_MODE__?: string }).__CLANK_MODE__ === "hosted";
export const BOARD_MAX = process.env.WEB_BOARD_MAX ? Number(process.env.WEB_BOARD_MAX) : HOSTED ? 200 : Infinity;
/**
 * A launch older than this, with no curve trade for as long, is dead: the
 * backfill skips it and the sweep drops it, until it trades again (B6). Hosted
 * only: the console trades from its board and keeps everything. 0 turns it off.
 */
export const DEAD_AFTER_S = HOSTED ? Number(process.env.WEB_DEAD_AFTER_H ?? 24) * 3600 : 0;
/** How often to re-read cheap economics for every tracked launch. */
export const REFRESH_MS = Number(process.env.WEB_REFRESH_MS ?? 10_000);
/**
 * With the chain index, the timed refresh is a safety sweep: rows are re-read
 * when they trade, and every row on this timer in case a trade was missed
 * (spec D1.3, the user's 2 minutes).
 */
export const SWEEP_MS = Number(process.env.WEB_SWEEP_MS ?? 120_000);
/** Tokens analysed concurrently, so multicalls fold across them. */
export const POOL = Number(process.env.WEB_POOL ?? 8);
/**
 * Behind our own proxy (hosted, H1): the client is the rightmost
 * X-Forwarded-For entry, not the socket. Never set without a proxy that writes
 * that header, or any client can name itself.
 */
export const TRUST_PROXY = process.env.TRUST_PROXY === "1";
/** The name the console shows. The product rename is its own unit (public-release Q1). */
export const BRAND = process.env.BRAND_NAME ?? "Clank Uwu Model";
