/**
 * The Data API docs against the code — X21 D5.
 *
 * The docs page renders `src/web/public/js/core/apiFacts.js`. This checks that
 * data against what the server enforces and answers: the per-client limits,
 * the fields `/api/check`, `/api/history`, `/api/ledger`, `/api/trades`,
 * `/api/candles`, `/api/holders`, `/api/leaders` and a board row carry, and the events `/events` sends
 * (board.ts and routes/tape.ts). Change any of them without the docs
 * and this fails. Fake analysis, no chain.
 *
 *   npm run test:apidocs
 */
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { LIMITS } from "./rateLimit.js";
import { fakeAnalysis, who } from "./analysisFixture.js";
import { clearCache } from "../core/lib/cache.js";
import { analyseInto, rows, type AnalyseDeps } from "./board.js";
import { checkRoute, historyRoute, type CheckDeps } from "./routes/public.js";
import { shapeLedger } from "./ledgerPayload.js";
import { candlesRoute, tradesRoute } from "./routes/tape.js";
import { holdersRoute } from "./routes/holders.js";
import { leadersRoute } from "./routes/leaders.js";
import { createLeaderboard } from "./leaderboard.js";
import { tapeOf, tradeEvents } from "../core/record/tape.js";

// The page's modules are plain JS with JSDoc, typed by the web project, not
// this one: loaded here by URL, with the shapes this test reads.
type Field = { name: string; what: string };
type Endpoint = { path: string; fields: Field[] };
const facts = (await import(new URL("../web/public/js/core/apiFacts.js", import.meta.url).href)) as {
  API_LIMITS: { check: { perMin: number; burst: number }; ledger: { perMin: number; burst: number; distinctPerHour: number };
    read: { perMin: number }; streams: number; ipv4Factor: number };
  ENDPOINTS: Endpoint[]; EVENTS: Field[]; ROW_FIELDS: Field[]; STATS_FIELDS: Field[]; TOTALS_FIELDS: Field[];
  SELL_FIELDS: Field[]; TRADE_FIELDS: Field[]; CANDLE_FIELDS: Field[]; FRAME_TOP_FIELDS: Field[]; FRAME_CANDLE_FIELDS: Field[];
  HOLDER_FIELDS: Field[];
  LEADER_FIELDS: Field[]; STANDING_FIELDS: Field[]; STANDING_WINDOW_FIELDS: Field[];
};
const {
  API_LIMITS, ENDPOINTS, EVENTS, ROW_FIELDS, STATS_FIELDS, TOTALS_FIELDS, SELL_FIELDS, TRADE_FIELDS, CANDLE_FIELDS, HOLDER_FIELDS,
  LEADER_FIELDS, STANDING_FIELDS, STANDING_WINDOW_FIELDS, FRAME_TOP_FIELDS, FRAME_CANDLE_FIELDS,
} = facts;
const { BANDS } = (await import(new URL("../web/public/js/core/domain.js", import.meta.url).href)) as {
  BANDS: Record<string, [string, string]>;
};

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const names = (fields: { name: string }[]) => fields.map((f) => f.name).sort();
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const diff = (documented: string[], actual: string[]) =>
  `undocumented: ${actual.filter((k) => !documented.includes(k)).join(",") || "—"}; `
  + `documented but absent: ${documented.filter((k) => !actual.includes(k)).join(",") || "—"}`;
const endpoint = (path: string) => ENDPOINTS.find((e) => e.path === path)!;

/** Run a route and return its JSON answer. */
async function answer(route: { handle: (...a: never[]) => unknown }, path: string) {
  let body = "";
  const res = { writeHead() { return res; }, end(b?: unknown) { body = String(b ?? ""); } };
  await (route.handle as (req: unknown, res: unknown, url: URL) => Promise<void>)(
    { method: "GET", headers: {} }, res, new URL(path, "http://localhost:8787"));
  return JSON.parse(body);
}

console.log("\nthe limits the page states");
{
  const c = LIMITS.classes;
  ok("check: per minute and burst", API_LIMITS.check.perMin === c.check.client.perMin && API_LIMITS.check.burst === c.check.client.burst,
    JSON.stringify(c.check.client));
  ok("ledger: per minute, burst and distinct addresses an hour",
    API_LIMITS.ledger.perMin === c.ledger.client.perMin && API_LIMITS.ledger.burst === c.ledger.client.burst
      && API_LIMITS.ledger.distinctPerHour === c.ledger.distinctPerHour, JSON.stringify(c.ledger));
  ok("everything else: per minute", API_LIMITS.read.perMin === c.read.client.perMin, JSON.stringify(c.read.client));
  ok("streams", API_LIMITS.streams === LIMITS.streams, String(LIMITS.streams));
  ok("the IPv4 multiple, on reads and streams",
    API_LIMITS.ipv4Factor === LIMITS.ipv4.factor && same([...LIMITS.ipv4.classes], ["read", "sse"]), JSON.stringify(LIMITS.ipv4));
}

console.log("\n/api/check's fields");
{
  clearCache();
  const T = who(0x7d0c), C = who(0xc0d0c);
  const deps: CheckDeps = {
    analyze: (async () => fakeAnalysis(T, C)) as CheckDeps["analyze"],
    analyseInto: (async () => {}) as CheckDeps["analyseInto"],
    poolFor: (async () => null) as unknown as CheckDeps["poolFor"],
  };
  const a = await answer(checkRoute("hosted", deps), `/api/check?addr=${T}`);
  const doc = endpoint("/api/check");
  ok("top level", same(names(doc.fields), Object.keys(a)), diff(names(doc.fields), Object.keys(a)));
  ok("stats", same(names(STATS_FIELDS), Object.keys(a.stats)), diff(names(STATS_FIELDS), Object.keys(a.stats)));
  ok("a finding", same(["severity", "title", "detail"], Object.keys(a.findings[0] ?? {})), Object.keys(a.findings[0] ?? {}).join(","));
  // The bands the page lists (the site's BANDS) are exactly the ones score() can give.
  const rules = readFileSync(new URL("../core/checker/rules.ts", import.meta.url), "utf8");
  const block = rules.slice(rules.indexOf("const band ="), rules.indexOf(";", rules.indexOf("const band =")));
  const given = [...block.matchAll(/"([A-Z ]+)"/g)].map((m) => m[1]!);
  ok("the bands the page lists are the bands a check can give", same(Object.keys(BANDS), given),
    `page ${Object.keys(BANDS).join(",")} / rules ${given.join(",")}`);
}

console.log("\n/api/history's fields");
{
  const h = await answer(historyRoute, `/api/history?token=${who(0x7d0d)}`);
  const doc = endpoint("/api/history");
  ok("top level", same(names(doc.fields), Object.keys(h)), diff(names(doc.fields), Object.keys(h)));
}

console.log("\n/api/ledger's fields");
{
  const l = await shapeLedger({
    address: who(0xadd), toBlock: 1n, builtAt: 0, partial: false, omittedTokens: [], positions: [],
  } as unknown as Parameters<typeof shapeLedger>[0]);
  const doc = endpoint("/api/ledger");
  ok("top level", same(names(doc.fields), Object.keys(l)), diff(names(doc.fields), Object.keys(l)));
  ok("totals", same(names(TOTALS_FIELDS), Object.keys(l.totals)), diff(names(TOTALS_FIELDS), Object.keys(l.totals)));

  // A sold position's call (p-sell-verdict.md, P1): every field it adds is
  // documented, and no other. The rest of a position is described in prose.
  const sold = { token: who(0x5e11), curve: who(0xc5e1), symbol: "S", soldTokens: "1", realizedWei: "1", realizedCostWei: "1", costEth: "0",
    confidence: "exact", closed: { at: 0, reason: "sold", proceedsEth: "1", tokensSold: "1", tx: null } };
  const withSells = await shapeLedger({
    address: who(0xadd), toBlock: 1n, builtAt: 0, partial: false, omittedTokens: [], positions: [sold],
  } as unknown as Parameters<typeof shapeLedger>[0], async () => { throw new Error("none open"); }, async () => 0);
  const added = Object.keys(withSells.closed[0]!).filter((k) => !Object.keys(sold).includes(k));
  ok("each position's sell call", same(names(SELL_FIELDS), added), diff(names(SELL_FIELDS), added));
}

console.log("\n/api/trades' and /api/candles' fields, and the trade event's");
{
  const T = who(0x7d10);
  const trade = (block: bigint, kind: "buy" | "sell") => ({
    tx: `0x${block.toString(16).padStart(64, "0")}`, logIndex: 0, block, curve: who(0xc7d1), token: T.toLowerCase(), kind,
    caller: who(0xb0b), recipient: who(0xb0b), amountIn: 10n ** 17n, amountOut: 10n ** 24n, fee: 10n ** 15n, snipeTax: 0n,
    movers: [] as string[],
  });
  const trades = [trade(1000n, "buy"), trade(1600n, "buy")];
  const receipts = new Map([[trades[0]!.tx, { tx: trades[0]!.tx, sender: who(0xb0b), gas: 1n, block: 1000n, time: 1_790_000_000n }]]);
  const now = 1_790_000_080_000;
  const tape = tapeOf(T, {
    toBlock: 1700n, trades, receipts, graduatedBlock: null,
    launch: { curve: who(0xc7d1), creator: who(0xc0d10), block: 1000n, syncedTo: 1700n }, anchors: [[1700, 1_790_000_070_000]],
  }, now);
  const t = await answer(tradesRoute(() => tape), `/api/trades?token=${T}`);
  const td = endpoint("/api/trades");
  ok("/api/trades: top level", same(names(td.fields), Object.keys(t)), diff(names(td.fields), Object.keys(t)));
  ok("/api/trades: each trade", same(names(TRADE_FIELDS), Object.keys(t.trades[0])), diff(names(TRADE_FIELDS), Object.keys(t.trades[0])));
  const c = await answer(candlesRoute(() => tape, () => now), `/api/candles?token=${T}`);
  const cd = endpoint("/api/candles");
  ok("/api/candles: top level", same(names(cd.fields), Object.keys(c)), diff(names(cd.fields), Object.keys(c)));
  ok("/api/candles: each candle", same(names(CANDLE_FIELDS), Object.keys(c.candles[0])), diff(names(CANDLE_FIELDS), Object.keys(c.candles[0])));
  const f = await answer(candlesRoute(() => tape, () => now), `/api/candles?token=${T}&tf=1m`);
  const fTop = [...names(cd.fields), ...names(FRAME_TOP_FIELDS)];
  ok("/api/candles?tf=: top level", same(fTop, Object.keys(f)), diff(fTop, Object.keys(f)));
  ok("/api/candles?tf=: each candle", same(names(FRAME_CANDLE_FIELDS), Object.keys(f.candles[0])),
    diff(names(FRAME_CANDLE_FIELDS), Object.keys(f.candles[0])));
  const e = tradeEvents([trades[1]!], () => tape)[0]!;
  const want = [...names(TRADE_FIELDS), "token"];
  ok("the trade event: a trade and its token", same(want, Object.keys(e)), diff(want, Object.keys(e)));

  const reading = {
    toBlock: 1700n, trades, receipts, graduatedBlock: null, anchors: [[1700, 1_790_000_070_000]] as [number, number][],
    launch: { curve: who(0xc7d1), creator: who(0xc0d10), block: 1000n, syncedTo: 1700n },
  };
  const h = await answer(holdersRoute({
    reading: () => reading,
    holders: () => ({ holders: [{ address: who(0xb0b), balance: 10n ** 24n, firstBlock: 1000n, firstIn: 10n ** 24n }],
      supply: 10n ** 27n, syncedTo: 1700n }),
    spot: async () => 4e8, now: () => now,
  }), `/api/holders?token=${T}`);
  const hd = endpoint("/api/holders");
  ok("/api/holders: top level", same(names(hd.fields), Object.keys(h)), diff(names(hd.fields), Object.keys(h)));
  ok("/api/holders: each row", same(names(HOLDER_FIELDS), Object.keys(h.rows[0])), diff(names(HOLDER_FIELDS), Object.keys(h.rows[0])));
}

console.log("\n/api/leaders' fields, and its lookup's");
{
  // One address with five round trips, the floor, so it has a row.
  const P = who(0xbeef).toLowerCase();
  const now = 1_790_000_000_000;
  const trades = Array.from({ length: 10 }, (_, i) => {
    const k = Math.floor(i / 2), buy = i % 2 === 0;
    return {
      tx: `0x${(i + 1).toString(16).padStart(64, "0")}`, logIndex: 0, block: BigInt(1000 + i),
      curve: who(0xc000 + k).toLowerCase(), token: who(0x7000 + k).toLowerCase(),
      kind: (buy ? "buy" : "sell") as "buy" | "sell", caller: P, recipient: P,
      amountIn: buy ? 10n ** 16n : 10n ** 24n, amountOut: buy ? 10n ** 24n : 2n * 10n ** 16n, fee: 10n ** 14n, snipeTax: 0n,
      movers: buy ? [] : [P],
    };
  });
  const receipts = new Map(trades.map((t) => [t.tx, { tx: t.tx, sender: P, gas: 1n, block: t.block, time: BigInt(now / 1000 - 60) }]));
  const lb = createLeaderboard({
    traders: () => ({ toBlock: 2000n, traders: [P] }),
    ledgerOf: () => ({ toBlock: 2000n, trades, receipts, inTx: new Map(trades.map((t) => [t.tx, [t]])), balance: () => 0n }),
    launches: () => Array.from({ length: 5 }, (_, k) => ({ token: who(0x7000 + k).toLowerCase(), curve: who(0xc000 + k).toLowerCase() })),
    soldNow: async () => 0.01, exclude: new Set(), now: () => now, log: () => {},
  });
  const l = await answer(leadersRoute(lb), "/api/leaders");
  const ld = endpoint("/api/leaders");
  ok("/api/leaders: top level", same(names(ld.fields), Object.keys(l)), diff(names(ld.fields), Object.keys(l)));
  ok("/api/leaders: each row", l.rows.length === 1 && same(names(LEADER_FIELDS), Object.keys(l.rows[0])),
    diff(names(LEADER_FIELDS), Object.keys(l.rows[0] ?? {})));
  const s = await answer(leadersRoute(lb), `/api/leaders?address=${P}`);
  ok("/api/leaders?address=: top level", same(names(STANDING_FIELDS), Object.keys(s)), diff(names(STANDING_FIELDS), Object.keys(s)));
  ok("/api/leaders?address=: each window", same(names(STANDING_WINDOW_FIELDS), Object.keys(s.windows[0])),
    diff(names(STANDING_WINDOW_FIELDS), Object.keys(s.windows[0])));
}

console.log("\na board row (/api/launches and /events)");
{
  rows.clear();
  const T = who(0x7d0e);
  const deps: AnalyseDeps = {
    analyze: (async () => fakeAnalysis(T, who(0xc0d0e))) as AnalyseDeps["analyze"],
    poolFor: (async () => null) as unknown as AnalyseDeps["poolFor"],
  };
  await analyseInto(T, who(0xc0d0e), who(0xc4ea), 100, deps);
  const ready = Object.keys(rows.get(T.toLowerCase())!);
  const documented = names(ROW_FIELDS);
  ok("a ready row: every field documented", ready.every((k) => documented.includes(k)), diff(documented, ready));

  const E = who(0x7d0f);
  const failing: AnalyseDeps = { ...deps, analyze: (async () => { throw new Error("execution reverted"); }) as AnalyseDeps["analyze"] };
  await analyseInto(E, who(0xc0d0f), who(0xc4ea), 101, failing);
  const errored = Object.keys(rows.get(E.toLowerCase())!);
  ok("a row that failed: every field documented", errored.every((k) => documented.includes(k)), diff(documented, errored));
  ok("and nothing documented that no row has", documented.every((k) => ready.includes(k) || errored.includes(k)),
    diff(documented, [...new Set([...ready, ...errored])]));
  rows.clear();
}

console.log("\nthe events /events sends");
{
  const board = readFileSync(new URL("./board.ts", import.meta.url), "utf8");
  const pub = readFileSync(new URL("./routes/public.ts", import.meta.url), "utf8");
  const tape = readFileSync(new URL("./routes/tape.ts", import.meta.url), "utf8");
  const sent = [...(board + tape).matchAll(/broadcast\("(\w+)"/g)].map((m) => m[1]!);
  if (pub.includes("event: snapshot")) sent.push("snapshot");
  const actual = [...new Set(sent)];
  ok("every event sent is documented, and no other", same(names(EVENTS), actual), diff(names(EVENTS), actual));
}

console.log(failures === 0
  ? "\n\x1b[32mall API docs checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);

