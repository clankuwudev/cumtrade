import { BRAND } from "./constants.js";

/**
 * Every piece of client state that is reassigned after load.
 *
 * These were `let`s inside one IIFE. An ES module cannot assign to a binding
 * it imports, so they live as fields of one shared object instead: a module
 * reads `S.wallet` and writes `S.wallet = …`, and every other module sees it.
 * Anything that is only ever mutated in place (Maps, Sets, arrays) is still
 * exported directly from the module that owns it.
 */
export const S = {
  /**
   * "self" or "hosted". Set at boot from the page's own stamp, before anything
   * renders, and confirmed by /api/config. Everything that differs by mode
   * reads this.
   */
  mode: "self",
  /** What this instance offers, from /api/config. */
  features: null,
  brand: BRAND,
  wallet: null,
  /** A switch of the system switch is in flight; its button waits. */
  sysBusy: false,
  /** The track record from /api/record, or null until it is first read. */
  record: null,
  /** When the track record was last read, so a running refresh is polled without piling up. */
  recordAt: 0,
  positions: { open: [], closed: [] },
  feed: { decisions: [], stats: {} },
  stats: null,
  cfg: null,
  connected: false,
  /** The board's first snapshot has come: until then it shows skeleton rows, after it an empty board says so. */
  boardReady: false,
  lastPositionsAt: Date.now(),
  buySize: 0.01,
  openToken: null,
  hist: { points: [], since: null },
  histFor: null,
  /**
   * The open token's candles from /api/candles (X25b): `for` the token,
   * `state` "loading", "ready", "notIndexed" or "error", and the answer.
   * @type {null | { for: string, state: string, from: number | null, to: number | null, candles: any[] }}
   */
  candles: null,
  /**
   * The open token's trades from /api/trades, newest first, with the live
   * ones added at the top (X25b). `unseen` counts live trades that came while
   * the Trades tab was not showing.
   * @type {null | { for: string, state: string, trades: any[], next: string | null, graduatedAt: number | null, more: boolean }}
   */
  tape: null,
  tapeUnseen: 0,
  /**
   * The open token's holders from /api/holders (X27b): `for` the token,
   * `state` "loading", "ready", "notIndexed" or "error", and the answer.
   * @type {null | { for: string, state: string, data: any }}
   */
  holders: null,
  /**
   * How far the chain index is behind the chain, from /healthz, and when it
   * was read (X27b). Null until read, or on a page with no /healthz.
   * @type {null | { blocks: number, at: number }}
   */
  indexLag: null,
  /**
   * The Traders page (x29-leaderboard.md, X29b): the window shown, and
   * /api/leaders' answer for it. `state` is "loading", "ready", "notIndexed"
   * or "error".
   * @type {{ window: string, state: string, data: any }}
   */
  leaders: { window: "7d", state: "idle", data: null },
  /**
   * A Portfolio's rank from /api/leaders?address= (X29b): `for` the address,
   * lowercased, and the answer; null data when there is none to show.
   * @type {null | { for: string, data: any, at: number }}
   */
  rank: null,
  tradeSide: "buy",
  customAmount: "",
  sellPct: 100,
  /**
   * "Review each trade" (public-release W3.1, TW5): the plan sheet for every
   * trading-wallet trade, as with a browser wallet. Off by default, so a
   * click trades. Kept in `clank.review`.
   */
  reviewTrades: false,
  holdingsPrimed: false,
  /**
   * The visitor's own wallet, on a hosted page: which wallet, the connected
   * address, its chain, and its ETH balance in wei (null until read). Null when
   * nothing is connected. Written only by wallet/eip6963.js.
   */
  conn: null,
  /**
   * The trading wallet, on a hosted page whose origin has a pinned Coinbase
   * project (public-release W1.2): its address, how the visitor logged in
   * ("google", "x" or "wallet"), and its ETH balance in wei (null until read).
   * Null when logged out. Written only by wallet/session.js. Trades on such a
   * page go from this address, never from `conn`.
   */
  trading: null,
  /**
   * The trading wallet's login (W1.2). `here`: this origin has a trading
   * wallet at all; false on a self page and on every origin with no pinned
   * project, where the page trades from `conn` as before. `phase`: "idle",
   * "restoring", "redirecting", "signing" or "leaving". `countdown`: seconds
   * until the idle lock, while it shows. `waiting`: the lock is due and waits
   * for a running trade.
   */
  login: { here: false, phase: "idle", countdown: null, waiting: false },
  /**
   * What the connected address holds, from the server's ledger of it
   * (`/api/ledger`, public-release B3.5): `{ address, byToken }`, where
   * `byToken` maps a lowercased token to `{ tokens, nowEth, capped }`. Null
   * until read, and whenever nothing is connected. Hosted only.
   */
  heldFromLedger: null,
  /**
   * The hosted Positions page's lookup (public-release F1.2): the address,
   * where its request is ("idle", "loading", "waiting", "ok", "error"), the
   * `/api/ledger` answer, and the reason there is none. `readAt`: when that
   * answer came, so a page opened again later knows it is old.
   */
  lookup: { address: null, state: "idle", data: null, error: null, startedAt: 0, attempt: 0, readAt: 0 },
  /**
   * The last trade of yours that filled on this page: `{ address, at }`, the
   * lowercased address that traded and when. The Portfolio reads that
   * address again, fresh, when it is opened after this (a tester's buys made
   * on token pages left it showing the empty answer it had before them).
   */
  lastFill: null,
};

// ---------------------------------------------------------------- state --
export const rows = new Map();

/**
 * Tokens a hosted check answered for that are not on the board, as rows built
 * from that answer (public-release B5.1b), by lowercased token. The hosted
 * check no longer puts a token on the shared board, so this is what the page
 * trades one from. Self's answers never fill it.
 */
export const checked = new Map();

/** The row to trade a token from: the board's, or failing that a hosted check's. */
export const rowFor = (token) => {
  const k = String(token || "").toLowerCase();
  return rows.get(k) ?? checked.get(k) ?? null;
};

export const sessionLog = [];
