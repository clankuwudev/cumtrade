/**
 * A token's trade tape, its candles and the live `trade` event
 * (x25-batch2-token-page.md, X25a). Pure over made-up trades; the routes run
 * against a tape passed in. No chain, no index file.
 *
 *   npm run test:tape
 */
import type { ReceiptRow, TradeRow } from "../core/lib/indexStore.js";
import {
  EVENT_CAP, FRAME_CAP, LIVE_BLOCKS, SUPPLY, TIMEFRAMES, candlesOf, createTapeCache, framesOf, pageOf, parseCursor, tapeOf, tradeEvents,
  type FrameCandle, type Tape, type Timeframe, type TokenReading,
} from "../core/record/tape.js";
import { candlesRoute, tradesRoute } from "./routes/tape.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

const E = 10n ** 18n;
const TOKEN = "0x00000000000000000000000000000000000000c1";
const CURVE = "0x00000000000000000000000000000000000000d1";
const CREATOR = "0x00000000000000000000000000000000000000a1";
const BUYER = "0x00000000000000000000000000000000000000b1";
const ROUTER = "0x00000000000000000000000000000000000000cc";
const SIGNER = "0x00000000000000000000000000000000000000e1";
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 20, 12); // the launch, at block LAUNCH
const LAUNCH = 5_000_000;
/** Ten blocks a second, as the chain runs. */
const blockAt = (ms: number) => LAUNCH + Math.round((ms - T0) / 100);

/**
 * A curve trade at `ms`, logIndex `li` in its block. A buy pays `eth`, a 1%
 * fee on top of what reaches the curve, for `tokens`; a sell gives `tokens`
 * for `eth`, after a 1% fee.
 * `receipt: false` leaves its receipt out, as the index has not fetched it.
 */
function trade(ms: number, kind: "buy" | "sell", eth: number, tokens: number, o: {
  li?: number; caller?: string; recipient?: string; sender?: string; receipt?: boolean; tx?: string;
} = {}) {
  const w = BigInt(Math.round(eth * 1e6)) * 10n ** 12n, t = BigInt(Math.round(tokens)) * E;
  const block = BigInt(blockAt(ms));
  const tx = o.tx ?? `0x${block.toString(16)}${(o.li ?? 0).toString(16).padStart(4, "0")}`.padEnd(66, "0");
  const row: TradeRow = {
    tx, logIndex: o.li ?? 0, block, curve: CURVE, token: TOKEN, kind,
    caller: o.caller ?? BUYER, recipient: o.recipient ?? BUYER,
    amountIn: kind === "buy" ? w : t, amountOut: kind === "buy" ? t : w, fee: kind === "buy" ? w / 101n : w / 100n, snipeTax: 0n, movers: [],
  };
  const receipt: ReceiptRow | null = o.receipt === false ? null
    : { tx, sender: o.sender ?? o.caller ?? BUYER, gas: 10n ** 13n, block, time: BigInt(Math.floor(ms / 1000)) };
  return { row, receipt };
}

function reading(made: ReturnType<typeof trade>[], o: {
  toBlock?: number; graduatedBlock?: number | null; syncedTo?: number | null; launch?: boolean;
} = {}): TokenReading {
  const toBlock = BigInt(o.toBlock ?? blockAt(T0 + 60 * MIN));
  const receipts = new Map<string, ReceiptRow>();
  for (const m of made) if (m.receipt) receipts.set(m.row.tx, m.receipt);
  return {
    toBlock,
    trades: made.map((m) => m.row).sort((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex),
    receipts,
    graduatedBlock: o.graduatedBlock == null ? null : BigInt(o.graduatedBlock),
    launch: o.launch === false ? null : {
      curve: CURVE, creator: CREATOR, block: BigInt(LAUNCH), syncedTo: o.syncedTo === undefined ? toBlock : o.syncedTo === null ? null : BigInt(o.syncedTo),
    },
    anchors: [],
  };
}

/** Run a route and return its status and JSON answer. */
async function answer(route: { handle: (...a: never[]) => unknown }, path: string) {
  let body = "", status = 0;
  const res = { writeHead(s: number) { status = s; return res; }, end(b?: unknown) { body = String(b ?? ""); } };
  await (route.handle as (req: unknown, res: unknown, url: URL) => Promise<void>)(
    { method: "GET", headers: {} }, res, new URL(path, "http://localhost:8787"));
  return { status, body: JSON.parse(body) };
}

const NOW = T0 + 60 * MIN;

console.log("\nthe tape: order and paging");
{
  // Seven trades, three of them in one block, newest last.
  const made = [
    trade(T0, "buy", 0.505, 5_000_000, { caller: CREATOR, recipient: CREATOR }),
    trade(T0 + 2 * MIN, "buy", 0.101, 900_000),
    trade(T0 + 5 * MIN, "buy", 0.202, 1_700_000, { li: 0 }),
    trade(T0 + 5 * MIN, "sell", 0.099, 1_000_000, { li: 1 }),
    trade(T0 + 5 * MIN, "buy", 0.303, 2_400_000, { li: 2 }),
    trade(T0 + 9 * MIN, "sell", 0.198, 1_500_000),
    trade(T0 + 12 * MIN, "buy", 0.404, 3_000_000),
  ];
  const tape = tapeOf(TOKEN, reading(made), NOW);
  ok("oldest first in the tape", tape.rows.every((r, i) => i === 0 || r.block > tape.rows[i - 1]!.block
    || (r.block === tape.rows[i - 1]!.block && r.logIndex > tape.rows[i - 1]!.logIndex)));
  const all = pageOf(tape.rows, null, 100);
  ok("a page is newest first, with no next when it has them all",
    all.trades.length === 7 && all.trades[0]!.at === T0 + 12 * MIN && all.next === null);

  // Pages of two: the second boundary falls inside the block of three.
  const seen: string[] = [];
  let before = null as ReturnType<typeof parseCursor>, pages = 0, cuts: string[] = [];
  for (;;) {
    const p = pageOf(tape.rows, before, 2);
    seen.push(...p.trades.map((t) => `${t.block}:${t.logIndex}`));
    pages++;
    if (!p.next) break;
    cuts.push(p.next);
    before = parseCursor(p.next);
  }
  ok("pages of two cover every trade once, newest first", pages === 4
    && JSON.stringify(seen) === JSON.stringify(all.trades.map((t) => `${t.block}:${t.logIndex}`)), seen.join(" "));
  const b5 = blockAt(T0 + 5 * MIN);
  ok("…with a page boundary inside one block", cuts.includes(`${b5}:1`), cuts.join(" "));
  ok("a bad cursor is refused", parseCursor("12") === null && parseCursor("a:1") === null && parseCursor("1:2:3") === null);

  const r = tape.rows[1]!;
  ok("a buy: ETH paid, tokens, and the price before the fee",
    r.side === "buy" && near(r.eth, 0.101) && near(r.tokens, 900_000) && near(r.price!, 0.1 / 900_000), JSON.stringify(r));
  const s = tape.rows[3]!;
  ok("a sell: ETH taken out, and the price with its fee added back",
    s.side === "sell" && near(s.eth, 0.099) && near(s.price!, (0.099 + 0.00099) / 1_000_000), JSON.stringify(s));
  ok("with a receipt: the block's time, and who signed", !r.atEstimated && r.at === T0 + 2 * MIN && !r.traderFromEvent);
  ok("the launch is at the launch block's time", tape.launchedAt === T0, String(tape.launchedAt));
}

console.log("\nthe tape: before a receipt, and a router sell");
{
  const made = [
    trade(T0, "buy", 0.505, 5_000_000),
    trade(T0 + 10 * MIN, "buy", 0.101, 900_000),
    // No receipts yet: a buy for BUYER through the router, and a sell whose caller is the router.
    trade(T0 + 4 * MIN, "buy", 0.101, 900_000, { caller: ROUTER, recipient: BUYER, receipt: false }),
    trade(T0 + 6 * MIN, "sell", 0.099, 1_000_000, { caller: ROUTER, recipient: ROUTER, receipt: false }),
    // With its receipt: the router sold for SIGNER, who signed.
    trade(T0 + 8 * MIN, "sell", 0.099, 1_000_000, { caller: ROUTER, recipient: ROUTER, sender: SIGNER }),
  ];
  const tape = tapeOf(TOKEN, reading(made), NOW);
  const byAt = (ms: number) => tape.rows.find((r) => r.block === blockAt(ms))!;
  const b = byAt(T0 + 4 * MIN), s = byAt(T0 + 6 * MIN), rs = byAt(T0 + 8 * MIN);
  ok("before its receipt, a trade's time is estimated from the blocks around it",
    b.atEstimated && Math.abs(b.at - (T0 + 4 * MIN)) < 1000, `${(b.at - T0) / MIN} min`);
  ok("…a buy's trader is its recipient, marked as from the event", b.trader === BUYER && b.traderFromEvent);
  ok("…a sell's trader is its caller", s.trader === ROUTER && s.traderFromEvent);
  ok("a router sell with its receipt: the trader is who signed, not the router",
    rs.trader === SIGNER && !rs.traderFromEvent, rs.trader);

  // Nothing of the token's own to place it by: the index's own block times do.
  const lone = trade(T0 + 30 * MIN, "buy", 0.101, 900_000, { receipt: false });
  const r = reading([lone]);
  r.anchors = [[blockAt(T0), T0], [blockAt(T0 + 20 * MIN), T0 + 20 * MIN]];
  const t2 = tapeOf(TOKEN, r, NOW);
  ok("a token with no receipt of its own is placed by the index's", Math.abs(t2.rows[0]!.at - (T0 + 30 * MIN)) < 1000,
    `${(t2.rows[0]!.at - T0) / MIN} min`);
  const t3 = tapeOf(TOKEN, r, T0 + 25 * MIN);
  ok("…and never later than now", t3.rows[0]!.at === T0 + 25 * MIN);
  const t4 = tapeOf(TOKEN, { ...r, anchors: [] }, NOW);
  ok("with no block time known at all, it is now, estimated", t4.rows[0]!.at === NOW && t4.rows[0]!.atEstimated);
}

console.log("\ncandles, worked by hand");
{
  // A buy of 1.01 ETH (0.01 of it the fee) for 1,000,000 tokens: 1e-6 ETH a
  // token. Then 2e-6 and, three minutes on, 3e-6.
  const made = [
    trade(T0 + 30_000, "buy", 1.01, 1_000_000),
    trade(T0 + 42_000, "buy", 2.02, 1_000_000),
    trade(T0 + 3 * MIN + 12_000, "buy", 3.03, 1_000_000),
  ];
  const r = reading(made);
  const tape = tapeOf(TOKEN, r, NOW);
  // Launch at T0 with no receipt of its own in that block: placed from the trades'.
  ok("the launch is placed from the trades' blocks", Math.abs(tape.launchedAt! - T0) < 1000, String(tape.launchedAt! - T0));
  const to = T0 + 24 * MIN - 1;
  const c = candlesOf({ ...tape, launchedAt: T0 }, 24, to).candles;
  const want = [
    { o: 1e-6, h: 2e-6, l: 1e-6, c: 2e-6 },
    { o: 2e-6, h: 2e-6, l: 2e-6, c: 2e-6 },
    { o: 2e-6, h: 2e-6, l: 2e-6, c: 2e-6 },
    { o: 2e-6, h: 3e-6, l: 2e-6, c: 3e-6 },
  ];
  ok("24 candles over 24 minutes: one a minute", c.length === 24 && c[0]!.t0 === T0 && near(c[1]!.t0 - c[0]!.t0, MIN), String(c.length));
  ok("the first four are as worked by hand", want.every((w, i) =>
    near(c[i]!.o, w.o) && near(c[i]!.h, w.h) && near(c[i]!.l, w.l) && near(c[i]!.c, w.c)),
  JSON.stringify(c.slice(0, 4).map((x) => [x.o, x.h, x.l, x.c])));
  ok("…and the rest carry the last close flat", c.slice(4).every((x) => x.o === x.c && near(x.c, 3e-6)));
  ok("market cap is close × a billion", SUPPLY === 1e9 && near(c[23]!.c * SUPPLY, 3000));

  // Graduated at minute 10: the candles stop there.
  const g = tapeOf(TOKEN, reading(made, { graduatedBlock: blockAt(T0 + 10 * MIN) }), NOW);
  const gc = candlesOf(g, 24, NOW);
  ok("a graduated token's candles end at graduation", gc.to === g.graduatedAt
    && Math.abs(g.graduatedAt! - (T0 + 10 * MIN)) < 1000 && gc.candles[gc.candles.length - 1]!.t1 === gc.to! + 1,
  `${(gc.to! - T0) / MIN} min`);
  ok("no trades yet: no candles", candlesOf(tapeOf(TOKEN, reading([]), NOW), 24, NOW).candles.length === 0);
}

console.log("\nfixed-interval candles (TV1), worked by hand");
{
  // The same three buys: 1e-6 at 0:30, 2e-6 at 0:42, 3e-6 at 3:12. T0 is on
  // a 5-minute boundary, so every size's boundaries line up with it.
  const made = [
    trade(T0 + 30_000, "buy", 1.01, 1_000_000),
    trade(T0 + 42_000, "buy", 2.02, 1_000_000),
    trade(T0 + 3 * MIN + 12_000, "buy", 3.03, 1_000_000),
  ];
  const tape = tapeOf(TOKEN, reading(made), NOW);
  const f = (tf: Timeframe) => framesOf(tape, tf, NOW).candles;
  const same = (got: FrameCandle[], want: [number, number, number, number, number, number][]) =>
    got.length === want.length && want.every(([t, o, h, l, c, v], i) => got[i]!.t === t
      && near(got[i]!.o, o) && near(got[i]!.h, h) && near(got[i]!.l, l) && near(got[i]!.c, c) && near(got[i]!.v, v, 1e-6));
  const show = (x: FrameCandle[]) => JSON.stringify(x.map((k) => [(k.t - T0) / 1000, k.o, k.h, k.l, k.c, +k.v.toFixed(4)]));
  const m1 = f("1m");
  ok("1m: two candles, the empty minutes left out", same(m1, [
    [T0, 1e-6, 2e-6, 1e-6, 2e-6, 3.03],
    [T0 + 3 * MIN, 2e-6, 3e-6, 2e-6, 3e-6, 3.03],
  ]), show(m1));
  const s15 = f("15s");
  ok("15s: 0:30 and 0:42 share one candle", same(s15, [
    [T0 + 30_000, 1e-6, 2e-6, 1e-6, 2e-6, 3.03],
    [T0 + 3 * MIN, 2e-6, 3e-6, 2e-6, 3e-6, 3.03],
  ]), show(s15));
  const s1 = f("1s");
  ok("1s: each opens at the last close", same(s1, [
    [T0 + 30_000, 1e-6, 1e-6, 1e-6, 1e-6, 1.01],
    [T0 + 42_000, 1e-6, 2e-6, 1e-6, 2e-6, 2.02],
    [T0 + 3 * MIN + 12_000, 2e-6, 3e-6, 2e-6, 3e-6, 3.03],
  ]), show(s1));
  const m5 = f("5m");
  ok("5m: one candle, volume summed", same(m5, [[T0, 1e-6, 3e-6, 1e-6, 3e-6, 6.06]]), show(m5));
  ok("every start is on its size's boundary", (Object.keys(TIMEFRAMES) as Timeframe[])
    .every((tf) => f(tf).every((k) => k.t % TIMEFRAMES[tf] === 0)));
  ok("no trades yet: no candles", framesOf(tapeOf(TOKEN, reading([]), NOW), "1m", NOW).candles.length === 0);

  // A trade a second for 600 s: 1s keeps the newest 500, and the first kept
  // one still opens at the close before it.
  const many = Array.from({ length: 600 }, (_, i) => trade(T0 + i * 1000, "buy", 1.01 * (1 + i / 1000), 1_000_000));
  const mt = tapeOf(TOKEN, reading(many, { toBlock: blockAt(T0 + 20 * MIN) }), NOW);
  const capped = framesOf(mt, "1s", NOW).candles;
  const all = framesOf(mt, "1s", NOW, 10_000).candles;
  ok(`1s is held to the newest ${FRAME_CAP}`, capped.length === FRAME_CAP && capped[0]!.t === T0 + 100_000
    && capped[FRAME_CAP - 1]!.t === T0 + 599_000, `${capped.length} from ${(capped[0]!.t - T0) / 1000}s`);
  ok("…the first kept opens at the close before it", all.length === 600 && near(capped[0]!.o, all[99]!.c));
}

console.log("\nthe routes");
{
  const made = [
    trade(T0, "buy", 0.505, 5_000_000),
    trade(T0 + 2 * MIN, "buy", 0.101, 900_000),
    trade(T0 + 5 * MIN, "sell", 0.099, 1_000_000),
  ];
  const tape = tapeOf(TOKEN, reading(made), NOW);
  const trades = tradesRoute(() => tape), candles = candlesRoute(() => tape, () => NOW);
  const a = await answer(trades, `/api/trades?token=${TOKEN}`);
  ok("/api/trades: 200 with the documented top level", a.status === 200
    && JSON.stringify(Object.keys(a.body).sort()) === JSON.stringify(["asOfBlock", "graduatedAt", "next", "token", "trades"]),
  Object.keys(a.body).join());
  ok("…each trade with its fields", JSON.stringify(Object.keys(a.body.trades[0]).sort()) === JSON.stringify(
    ["at", "atEstimated", "block", "eth", "logIndex", "price", "side", "tokens", "trader", "traderFromEvent", "tx"]),
  Object.keys(a.body.trades[0]).join());
  const p1 = await answer(trades, `/api/trades?token=${TOKEN}&limit=2`);
  const p2 = await answer(trades, `/api/trades?token=${TOKEN}&limit=2&before=${p1.body.next}`);
  ok("…pages with before", p1.body.trades.length === 2 && p2.body.trades.length === 1 && p2.body.next === null
    && p2.body.trades[0].at === T0);
  const big = await answer(trades, `/api/trades?token=${TOKEN}&limit=100000`);
  ok("…a limit over 100 is 100", big.status === 200 && big.body.trades.length === 3);
  for (const q of ["token=0x12", "token=" + TOKEN + "&before=nope", "token=" + TOKEN + "&limit=abc", ""]) {
    const x = await answer(trades, `/api/trades?${q}`);
    ok(`…400 for ?${q}`, x.status === 400);
  }

  const c = await answer(candles, `/api/candles?token=${TOKEN}`);
  ok("/api/candles: 120 by default, with the documented top level", c.status === 200 && c.body.candles.length === 120
    && JSON.stringify(Object.keys(c.body).sort()) === JSON.stringify(["asOfBlock", "candles", "from", "graduatedAt", "supply", "to", "token"]),
  `${c.body.candles.length} · ${Object.keys(c.body).join()}`);
  ok("…each candle { t0, t1, o, h, l, c }",
    JSON.stringify(Object.keys(c.body.candles[0]).sort()) === JSON.stringify(["c", "h", "l", "o", "t0", "t1"]));
  const lo = await answer(candles, `/api/candles?token=${TOKEN}&n=5`);
  const hi = await answer(candles, `/api/candles?token=${TOKEN}&n=9999`);
  ok("…n is held to 24–240", lo.body.candles.length === 24 && hi.body.candles.length === 240,
    `${lo.body.candles.length} / ${hi.body.candles.length}`);
  ok("…the last close is the last trade's price", near(c.body.candles[119].c, tape.rows[2]!.price!));

  const tf = await answer(candles, `/api/candles?token=${TOKEN}&tf=1m`);
  ok("/api/candles?tf=1m: the documented top level", tf.status === 200
    && JSON.stringify(Object.keys(tf.body).sort()) === JSON.stringify(["asOfBlock", "candles", "cap", "from", "graduatedAt", "supply", "tf", "to", "token"])
    && tf.body.tf === "1m" && tf.body.cap === FRAME_CAP && tf.body.to === NOW, Object.keys(tf.body).join());
  ok("…each candle { t, o, h, l, c, v }, one per minute with a trade",
    tf.body.candles.length === 3 && JSON.stringify(Object.keys(tf.body.candles[0]).sort()) === JSON.stringify(["c", "h", "l", "o", "t", "v"]));
  ok("…n is ignored with tf", (await answer(candles, `/api/candles?token=${TOKEN}&tf=1m&n=24`)).body.candles.length === 3);
  for (const q of ["tf=2m", "tf=", "tf=1M", "tf=1m&tf=5m"]) {
    const x = await answer(candles, `/api/candles?token=${TOKEN}&${q}`);
    ok(`…${x.status === 400 ? "400" : x.status} for ?${q}`, q === "tf=1m&tf=5m" ? x.status === 200 && x.body.tf === "1m" : x.status === 400);
  }

  // Not indexed: behind the cursor, never seen, or no index at all.
  const behind = tapeOf(TOKEN, reading(made, { syncedTo: blockAt(T0 + 30 * MIN) }), NOW);
  const unseen = tapeOf(TOKEN, reading([], { launch: false }), NOW);
  for (const [name, t] of [["behind the cursor", behind], ["never seen launch", unseen], ["no index", null]] as [string, Tape | null][]) {
    const x = await answer(tradesRoute(() => t), `/api/trades?token=${TOKEN}`);
    const y = await answer(candlesRoute(() => t), `/api/candles?token=${TOKEN}`);
    ok(`not indexed (${name}): 404 with indexed: false, on both`,
      x.status === 404 && x.body.indexed === false && y.status === 404 && y.body.indexed === false);
  }
  const g = tapeOf(TOKEN, reading(made, { graduatedBlock: blockAt(T0 + 10 * MIN) }), NOW);
  const ga = await answer(tradesRoute(() => g), `/api/trades?token=${TOKEN}`);
  ok("a graduated token says when", ga.status === 200 && ga.body.graduatedAt === g.graduatedAt && ga.body.graduatedAt !== null);
}

console.log("\nthe trade event");
{
  const made = [trade(T0, "buy", 0.505, 5_000_000), trade(T0 + MIN, "buy", 0.101, 900_000), trade(T0 + 2 * MIN, "sell", 0.099, 1_000_000)];
  const to = blockAt(T0 + 2 * MIN) + 20;
  const tape = tapeOf(TOKEN, reading(made, { toBlock: to }), NOW);
  const fresh = [made[2]!.row];
  const ev = tradeEvents(fresh, () => tape);
  ok("a new trade is sent once, as its tape row with its token",
    ev.length === 1 && ev[0]!.token === TOKEN && ev[0]!.tx === made[2]!.row.tx && ev[0]!.side === "sell", JSON.stringify(ev[0]));
  ok("a window with no new trade sends none", tradeEvents([], () => tape).length === 0);
  ok("…nor one whose token has no tape", tradeEvents(fresh, () => null).length === 0);

  // 250 new trades in one window: the newest 200, oldest first.
  const many = Array.from({ length: 250 }, (_, i) => trade(T0 + 3 * MIN + i * 100, "buy", 0.011, 100_000, { li: i }));
  const t2 = tapeOf(TOKEN, reading(many, { toBlock: blockAt(T0 + 3 * MIN + 250 * 100) }), NOW);
  const e2 = tradeEvents(many.map((m) => m.row), () => t2);
  ok(`at most ${EVENT_CAP} a window, the newest, oldest first`, e2.length === EVENT_CAP
    && e2[0]!.logIndex === 50 && e2[EVENT_CAP - 1]!.logIndex === 249
    && e2.every((e, i) => i === 0 || e.block >= e2[i - 1]!.block), `${e2.length}, from ${e2[0]?.logIndex}`);

  // A token read again from its launch: every trade is new to the store, none is live.
  const rebuilt = tapeOf(TOKEN, reading(made, { toBlock: blockAt(T0 + 2 * MIN) + LIVE_BLOCKS + 50 }), NOW);
  ok("a rebuild's history is not sent live", tradeEvents(made.map((m) => m.row), () => rebuilt).length === 0);
}

console.log("\none tape per token per cursor");
{
  let cursor: bigint | null = 100n, reads = 0;
  const made = [trade(T0, "buy", 0.505, 5_000_000)];
  const cache = createTapeCache({
    read: () => { reads++; return { ...reading(made), toBlock: cursor! }; },
    cursor: () => cursor, now: () => NOW, max: 2,
  });
  cache.get(TOKEN); cache.get(TOKEN.toUpperCase().replace("0X", "0x"));
  ok("read once while the cursor stays", reads === 1, String(reads));
  cursor = 101n; cache.get(TOKEN);
  ok("read again when it moves", reads === 2);
  cache.drop([TOKEN]); cache.get(TOKEN);
  ok("read again when dropped", reads === 3);
  cache.get("0x" + "1".repeat(40)); cache.get("0x" + "2".repeat(40));
  ok("kept to its size", cache.size() === 2);
  cursor = null;
  ok("no cursor, no tape", cache.get(TOKEN) === null);
}

console.log(failures === 0
  ? "\n\x1b[32mall tape checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
