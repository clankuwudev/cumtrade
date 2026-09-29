/**
 * The profitability leaderboard (x29-leaderboard.md, X29a): ranking, the
 * floor, the windows, unknown proceeds, the exclusion list, parity with
 * `buildFromIndex`, no RPC, the once-a-minute rebuild, the paperhand rate and
 * the route. Made-up positions and index rows; no chain.
 *
 *   npm run test:leaders
 */
export {};

// Before anything imports client.ts: nothing here may reach a real node.
process.env.RPC_URL = "http://fake-node.invalid";
process.env.LOGS_RPC_URL = "http://fake-node.invalid";
process.env.LOGS_FALLBACK_URL = "";

type TradeRow = import("../core/lib/indexStore.js").TradeRow;
type ReceiptRow = import("../core/lib/indexStore.js").ReceiptRow;
type IndexedInput = import("../core/positions/ledger.js").IndexedInput;
type LedgerPosition = import("../core/positions/ledger.js").LedgerPosition;
const { leaders, MIN_CLOSED } = await import("../core/record/leaders.js");
const { createLeaderboard, parseExclude } = await import("./leaderboard.js");
const { leadersRoute } = await import("./routes/leaders.js");
const { buildFromIndex } = await import("../core/positions/ledger.js");
const { verdict } = await import("../core/record/verdict.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const E = 10n ** 18n;
const MILLI = E / 1000n;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24, 12);
const addr = (tag: string) => `0x${tag.padStart(40, "0")}`;

// ---------------------------------------------------------------------------
// positions, for the pure ranking
// ---------------------------------------------------------------------------

let n = 0;
/** A position: closed `daysAgo` with this P&L in milli-ETH, or open (`daysAgo` null), or gone with its proceeds unknown. */
function pos(pnlMilli: number, daysAgo: number | null, o: { unknown?: boolean; at?: number } = {}): LedgerPosition {
  const cost = 10n * MILLI;
  const back = cost + BigInt(pnlMilli) * MILLI;
  const closedAt = daysAgo === null ? null : o.at ?? NOW - daysAgo * DAY;
  n++;
  return {
    token: addr(`70${n}`), curve: addr(`c0${n}`), symbol: "", source: "manual",
    costEth: daysAgo === null ? cost.toString() : "0", tokens: daysAgo === null ? "1000" : "0", feeBps: 100,
    entryFeeWei: "0", snipeTaxWei: "0",
    realizedWei: o.unknown || daysAgo === null ? "0" : back.toString(),
    realizedCostWei: o.unknown || daysAgo === null ? "0" : cost.toString(),
    realizedEntryFeeWei: "0", exitFeeWei: "0", soldTokens: o.unknown || daysAgo === null ? "0" : "1000",
    gasWei: (10n ** 13n).toString(), openedAt: (closedAt ?? NOW) - 3_600_000, openTx: null, peakValueWei: "0", dryRun: false,
    ...(closedAt === null ? {} : { closed: { at: closedAt, reason: "sold", proceedsEth: back.toString(), tokensSold: "1000", tx: null } }),
    confidence: o.unknown ? "proceeds-unknown" : "exact",
  } as LedgerPosition;
}
const many = (count: number, pnlMilli: number, daysAgo: number) => Array.from({ length: count }, () => pos(pnlMilli, daysAgo));

console.log("\nranking");
{
  const ls = [
    { address: addr("a1"), positions: many(5, 2, 1) },                                  // +10
    { address: addr("a2"), positions: many(6, 5, 1) },                                  // +30
    { address: addr("a3"), positions: [...many(5, 1, 1), pos(5, 1)] },                  // +10, 6 closed
    { address: addr("a4"), positions: many(5, 2, 2) },                                  // +10, 5 closed, earlier
    { address: addr("a5"), positions: many(5, -4, 1) },                                 // −20
  ];
  const s = leaders(ls, "7d", NOW);
  const order = s.ranked.map((r) => r.address);
  ok("by realised P&L", order[0] === addr("a2") && order[order.length - 1] === addr("a5"), order.join(","));
  ok("a tie goes to more closed positions", order[1] === addr("a3"));
  ok("then to the earlier last close", order[2] === addr("a4") && order[3] === addr("a1"));
  ok("ranks are 1..n", s.ranked.map((r) => r.rank).join() === "1,2,3,4,5");
  const a5 = s.ranked[4]!;
  ok("a loser is ranked, with its loss", a5.pnlWei === -20n * MILLI && a5.wins === 0);
  const a2 = s.ranked[0]!;
  ok("the row's figures: realised, cost, gas, wins", a2.realizedWei === 6n * 15n * MILLI && a2.costWei === 60n * MILLI
    && a2.gasWei === 6n * 10n ** 13n && a2.wins === 6 && a2.closed === 6);
}

console.log("\nthe floor");
{
  const ls = [
    { address: addr("f4"), positions: many(4, 50, 1) },
    { address: addr("f5"), positions: many(5, 1, 1) },
    // Five closed, but only four this week.
    { address: addr("fw"), positions: [...many(4, 9, 1), pos(9, 10)] },
  ];
  const s = leaders(ls, "7d", NOW);
  ok(`${MIN_CLOSED - 1} closed positions are left out, ${MIN_CLOSED} are ranked`,
    s.ranked.length === 1 && s.ranked[0]!.address === addr("f5"));
  ok("it counts closed positions in the window only", s.closedOf.get(addr("fw")) === 4
    && leaders(ls, "30d", NOW).ranked.some((r) => r.address === addr("fw")));
}

console.log("\nwindows");
{
  const eight = pos(3, 8);
  const open = pos(0, null);
  const l = { address: addr("w1"), positions: [eight, open] };
  const has = (w: "7d" | "30d" | "all", p: LedgerPosition) =>
    leaders([l], w, NOW, { minClosed: 1 }).ranked[0]?.positions.includes(p) ?? false;
  ok("closed 8 days ago: in 30d and all, not 7d", !has("7d", eight) && has("30d", eight) && has("all", eight));
  ok("an open position is in none", !has("7d", open) && !has("30d", open) && !has("all", open));
  const old = pos(3, 40);
  const lo = { address: addr("w2"), positions: [old] };
  ok("closed 40 days ago: only all", leaders([lo], "30d", NOW, { minClosed: 1 }).ranked.length === 0
    && leaders([lo], "all", NOW, { minClosed: 1 }).ranked.length === 1);
  const untimed = pos(3, 0, { at: 0 });
  ok("a close with no block time yet waits for the next rebuild",
    leaders([{ address: addr("w3"), positions: [untimed] }], "all", NOW, { minClosed: 1 }).ranked.length === 0);
  ok("traders: a position opened or closed in the window",
    leaders([l, lo], "7d", NOW).traders === 1 && leaders([l, lo], "all", NOW).traders === 2);
}

console.log("\nunknown proceeds");
{
  const ls = [{ address: addr("u1"), positions: [...many(4, 2, 1), pos(0, 1, { unknown: true }), pos(0, 1, { unknown: true })] }];
  ok("they do not count toward the floor", leaders(ls, "7d", NOW).ranked.length === 0);
  const r = leaders(ls, "7d", NOW, { minClosed: 4 }).ranked[0]!;
  ok("left out of the P&L and counted in the row", r.pnlWei === 8n * MILLI && r.closed === 4 && r.unknownProceeds === 2);
}

console.log("\nexclusion (L7)");
{
  const ls = [
    { address: addr("e1"), positions: many(5, 9, 1) },
    { address: addr("e2"), positions: many(5, 5, 1) },
    { address: addr("e3"), positions: many(5, 1, 1) },
  ];
  const s = leaders(ls, "7d", NOW, { exclude: new Set([addr("e1")]) });
  ok("an excluded address is not ranked, and the ranks close up",
    s.ranked.length === 2 && s.ranked[0]!.address === addr("e2") && s.ranked[0]!.rank === 1);
  ok("nor counted anywhere", s.traders === 2 && !s.closedOf.has(addr("e1")));
  const logged: string[] = [];
  const set = parseExclude(` ${addr("E1").toUpperCase().replace("0X", "0x")}, nope ,${addr("e2")}\n`, (l) => logged.push(l));
  ok("LEADERS_EXCLUDE: split on commas and spaces, lowercased, junk dropped and counted",
    set.size === 2 && set.has(addr("e1")) && logged.length === 1 && !logged[0]!.includes("nope"), logged.join(" | "));
}

// ---------------------------------------------------------------------------
// the board, from index rows
// ---------------------------------------------------------------------------

type Trip = { token: number; buy: bigint; sell: bigint | null; daysAgo: number; noReceipt?: boolean };
const launches: { token: string; curve: string }[] = [];
const tokenOf = (i: number) => addr(`7e${i}`), curveOf = (i: number) => addr(`c7e${i}`);
for (let i = 1; i <= 12; i++) launches.push({ token: tokenOf(i), curve: curveOf(i) });

let block = 5_000n, seq = 0;
const TOKENS = 1_000_000n * E;
/** An address's index input: a buy and (unless `sell` is null) a whole sell per trip. */
function input(address: string, trips: Trip[]): IndexedInput {
  const trades: TradeRow[] = [];
  const receipts = new Map<string, ReceiptRow>();
  const balances = new Map<string, bigint>();
  const add = (t: Trip, kind: "buy" | "sell", eth: bigint, at: number) => {
    const tx = `0x${(++seq).toString(16).padStart(64, "0")}`;
    block += 10n;
    trades.push({
      tx, logIndex: 0, block, curve: curveOf(t.token), token: tokenOf(t.token), kind, caller: address, recipient: address,
      amountIn: kind === "buy" ? eth : TOKENS, amountOut: kind === "buy" ? TOKENS : eth, fee: eth / 100n, snipeTax: 0n,
      movers: kind === "sell" ? [address] : [],
    });
    if (!(t.noReceipt && kind === "sell")) receipts.set(tx, { tx, sender: address, gas: 10n ** 13n, block, time: BigInt(Math.floor(at / 1000)) });
  };
  for (const t of trips) {
    const closeAt = NOW - t.daysAgo * DAY;
    add(t, "buy", t.buy, closeAt - 600_000);
    if (t.sell !== null) add(t, "sell", t.sell, closeAt);
    // A trip with no sell has left the wallet anyway: proceeds unknown.
    balances.set(tokenOf(t.token), 0n);
  }
  return {
    toBlock: 100_000n, trades, receipts,
    inTx: new Map(trades.map((t) => [t.tx, [t]])),
    balance: (token) => balances.get(token.toLowerCase()) ?? 0n,
  };
}
const trips = (count: number, buyMilli: number, sellMilli: number, daysAgo: number, from = 1): Trip[] =>
  Array.from({ length: count }, (_, i) => ({ token: from + i, buy: BigInt(buyMilli) * MILLI, sell: BigInt(sellMilli) * MILLI, daysAgo }));

const A = addr("aa"), B = addr("bb"), C = addr("cc"), X = addr("ee"), R = addr("dd");
const inputs = new Map<string, IndexedInput>([
  [A, input(A, [...trips(5, 10, 16, 1), { token: 6, buy: 10n * MILLI, sell: null, daysAgo: 1 }])],   // +30, 1 unknown
  [B, input(B, trips(6, 20, 25, 2))],                                                              // +30, 6 closed
  [C, input(C, [...trips(4, 10, 12, 1), ...trips(1, 10, 40, 9, 5)])],                              // +8 this week; +38 over 30d
  [X, input(X, trips(7, 10, 50, 1))],                                                              // +280, excluded
  [R, input(R, [...trips(4, 10, 11, 1), { token: 5, buy: 10n * MILLI, sell: 20n * MILLI, daysAgo: 1, noReceipt: true }])],
]);

function board(o: { soldNow?: (p: LedgerPosition) => Promise<number>; now?: () => number; noIndex?: boolean } = {}) {
  const logs: string[] = [];
  const lb = createLeaderboard({
    traders: () => (o.noIndex ? null : { toBlock: 100_000n, traders: [...inputs.keys()] }),
    ledgerOf: (a) => inputs.get(a) ?? null,
    launches: () => launches,
    soldNow: o.soldNow ?? (async (p) => Number(BigInt(p.realizedWei)) / 1e18),
    exclude: new Set([X]),
    now: o.now ?? (() => NOW),
    log: (l) => logs.push(l),
  });
  return { lb, logs };
}

console.log("\nthe board: parity, no RPC");
{
  const { lb, logs } = board();
  const b = (await lb.get())!;
  const all = b.windows.all;
  for (const a of [A, B]) {
    const built = await buildFromIndex(a as `0x${string}`, inputs.get(a)!, {
      sources: {
        curves: async (cs) => new Map(cs.map((c) => [c.toLowerCase(), { token: launches.find((l) => l.curve === c.toLowerCase())!.token as `0x${string}`, symbol: "" }])),
      },
    });
    const want = built.ledger.positions.filter((p) => p.closed && p.confidence !== "proceeds-unknown")
      .reduce((s, p) => s + BigInt(p.realizedWei) - BigInt(p.realizedCostWei), 0n);
    const row = all.rows.find((r) => r.address === a)!;
    ok(`parity: ${a === A ? "A" : "B"}'s P&L is buildFromIndex's own`, row.realizedPnlEth === Number(want) / 1e18,
      `${row.realizedPnlEth} vs ${Number(want) / 1e18}`);
  }
  const a = all.rows.find((r) => r.address === A)!;
  ok("A: 5 closed, 1 unknown, the gas of its closed positions", a.closed === 5 && a.unknownProceeds === 1 && Math.abs(a.gasEth - 10 * 1e-5) < 1e-12, `${a.gasEth}`);
  ok("the rebuild fetched nothing; it only counted the receipt and block time not in yet", b.stats.unfetched === 2, `unfetched ${b.stats.unfetched}`);
  ok("and that sell waits: R has 4 closed, below the floor", b.windows.all.closedOf.get(R) === 4 && !b.windows.all.rankOf.has(R));
  ok("the rebuild is logged, with no address in it", logs.length === 1 && !/0x[0-9a-f]{40}/i.test(logs[0]!), logs[0]);
  ok("ranks: C (+38), then B (+30, 6 closed) over A (+30, 5 closed)", all.rows.map((r) => r.address).join() === [C, B, A].join());
  ok("C is ranked over 30 days, not this week", b.windows["30d"].rankOf.has(C) && !b.windows["7d"].rankOf.has(C));
  const text = JSON.stringify(await lb.page("all", 100));
  ok("the excluded address is nowhere in the answer", !text.includes(X.slice(2)));
}

console.log("\nonce a minute");
{
  let t = NOW;
  const { lb } = board({ now: () => t });
  await lb.get();
  await lb.get();
  ok("two asks rebuild once", lb.rebuilds() === 1);
  lb.markStale();
  t += 30_000;
  await lb.get();
  ok("a commit inside the minute does not rebuild", lb.rebuilds() === 1);
  t += 31_000;
  await lb.get();
  ok("a commit after a minute rebuilds", lb.rebuilds() === 2);
  t += 120_000;
  await lb.get();
  ok("no commit, no rebuild", lb.rebuilds() === 2);
  const { lb: lb2 } = board();
  await Promise.all([lb2.get(), lb2.get(), lb2.get()]);
  ok("asks during a rebuild share it", lb2.rebuilds() === 1);
  lb.markStale();
  const before = (await lb.get())!.builtAt;
  const during = (await lb.get())!.builtAt;
  await new Promise((r) => setTimeout(r, 20));
  const after = (await lb.get())!.builtAt;
  ok("an ask during a rebuild is answered from the board in hand, then the new one",
    lb.rebuilds() === 3 && during === before && after === t, `${before} ${during} ${after} ${t}`);
  lb.markStale();
  t += 6 * 60_000;
  const waited = (await lb.get())!.builtAt;
  ok("after a quiet spell, over five minutes, the ask waits for the new board", lb.rebuilds() === 4 && waited === t, `${waited} ${t}`);
}

console.log("\nthe paperhand rate (L6)");
{
  // B's tokens 1 and 2 would fetch 50% more now; token 3 cannot be valued.
  const { lb } = board({
    soldNow: async (p) => {
      const back = Number(BigInt(p.realizedWei)) / 1e18;
      if (p.token === tokenOf(3)) throw new Error("no price");
      return p.token === tokenOf(1) || p.token === tokenOf(2) ? back * 1.5 : back;
    },
  });
  const b = (await lb.page("all", 100))!;
  const rowB = b.rows.find((r) => r.address === B)!;
  ok("a position that cannot be valued is left out; paperhandOf says of how many", rowB.paperhandOf === 5, `${rowB.paperhandOf}`);
  ok("the share matches verdict()", rowB.paperhandRate === 2 / 5, `${rowB.paperhandRate}`);
  const back = 0.025;
  ok("verdict() agrees on both sides of the line",
    verdict({ sold: true, back, soldNow: back * 1.5, best: null }) === "paperhand"
    && verdict({ sold: true, back, soldNow: back, best: null }) === "good");
  const { lb: none } = board({ soldNow: async () => { throw new Error("down"); } });
  const rowNone = (await none.page("all", 100))!.rows[0]!;
  ok("nothing valued: the rate is null, of 0", rowNone.paperhandRate === null && rowNone.paperhandOf === 0);
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

async function ask(route: ReturnType<typeof leadersRoute>, path: string) {
  let status = 0, body = "";
  const res = { writeHead(s: number) { status = s; return res; }, end(b?: unknown) { body = String(b ?? ""); } };
  await (route.handle as (req: unknown, res: unknown, url: URL) => Promise<void>)(
    { method: "GET", headers: {} }, res, new URL(path, "http://localhost:8787"));
  return { status, json: body ? JSON.parse(body) : null };
}

console.log("\nthe route");
{
  const { lb } = board();
  const route = leadersRoute(lb);
  for (const q of ["window=1d", "window=all&limit=ten", "address=0x12"]) {
    const r = await ask(route, `/api/leaders?${q}`);
    ok(`400 for ${q}`, r.status === 400);
  }
  const d = await ask(route, "/api/leaders");
  ok("the default window is 7d, and the top level's fields",
    d.status === 200 && d.json.window === "7d" && d.json.minClosed === MIN_CLOSED && d.json.pnl === "after fees, before gas"
    && JSON.stringify(Object.keys(d.json)) === JSON.stringify(["window", "asOfBlock", "builtAt", "traders", "eligible", "minClosed", "pnl", "rows"]));
  const row = d.json.rows[0];
  ok("each row's fields", JSON.stringify(Object.keys(row)) === JSON.stringify([
    "rank", "address", "realizedPnlEth", "realizedEth", "costEth", "gasEth", "closed", "wins", "winRate",
    "unknownProceeds", "paperhandRate", "paperhandOf", "lastClosedAt"]));
  const one = await ask(route, "/api/leaders?window=all&limit=1");
  const big = await ask(route, "/api/leaders?window=all&limit=1000");
  ok("limit is clamped, not refused", one.json.rows.length === 1 && big.status === 200 && big.json.rows.length === 3);
  const s = await ask(route, `/api/leaders?address=${A.toUpperCase().replace("0X", "0x")}`);
  ok("the lookup: a rank in each window", s.status === 200 && s.json.address === A
    && s.json.windows.map((w: { window: string; rank: number | null }) => `${w.window}:${w.rank}`).join() === "7d:2,30d:3,all:3",
    JSON.stringify(s.json.windows));
  const low = await ask(route, `/api/leaders?address=${R}`);
  ok("below the floor: rank null, with its closed count", low.json.windows[2].rank === null && low.json.windows[2].closed === 4);
  const hid = await ask(route, `/api/leaders?address=${X}`);
  ok("excluded: rank null, and nothing more said", hid.json.windows.every((w: { rank: null; closed: null }) => w.rank === null && w.closed === null)
    && JSON.stringify(Object.keys(hid.json)) === JSON.stringify(Object.keys(s.json))
    && JSON.stringify(Object.keys(hid.json.windows[0])) === JSON.stringify(Object.keys(s.json.windows[0])));
  const nobody = await ask(route, `/api/leaders?address=${addr("123")}`);
  ok("an address that never traded: rank null, 0 closed", nobody.json.windows.every((w: { rank: null; closed: number }) => w.rank === null && w.closed === 0));
  const { lb: empty } = board({ noIndex: true });
  const r404 = await ask(leadersRoute(empty), "/api/leaders");
  const s404 = await ask(leadersRoute(empty), `/api/leaders?address=${A}`);
  ok("404 with no index, for both", r404.status === 404 && r404.json.indexed === false && s404.status === 404);
}

console.log(failures === 0
  ? "\n\x1b[32mall leaders checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
