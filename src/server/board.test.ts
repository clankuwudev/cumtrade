/**
 * The board's cap — public-release B4.1.
 *
 * Past `WEB_BOARD_MAX` the oldest unbonded launch drops off, pinned tokens
 * never do, and a token that drops off leaves nothing behind: no row, no
 * analysis, no history, no retry. An analysis still running when its token
 * drops does not put it back. Runs with a cap of 5, a scratch history file, a
 * fake SSE client and a fake `analyze`, so it makes no chain call.
 *
 *   npm run test:board
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Address } from "viem";

process.env.WEB_BOARD_MAX = "5";
const dir = mkdtempSync(join(tmpdir(), "board-test-"));
process.env.HISTORY_FILE = join(dir, "history.json");

const { fakeAnalysis, who } = await import("./analysisFixture.js");
const history = await import("../core/lib/history.js");
const board = await import("./board.js");
const { rows, clients, upsert, setPinned, keptFor, analyseInto, addIndexedLaunches, indexFeed } = board;
const { isDead, pickBackfill, dropDead, reviveTraded } = board;
type Row = import("./board.js").Row;
type AnalyseDeps = import("./board.js").AnalyseDeps;

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

/** A ready row for token `n`, launched at block `block`. */
const row = (n: number, block: number, over: Partial<Row> = {}): Row => ({
  token: who(n), curve: who(n + 0x10000), creator: who(0xc4ea),
  name: "t", symbol: `T${n.toString(16)}`, logo: "", block, launchedAt: 0,
  band: "CLEAN", score: 0, findings: [], sellable: true,
  devBuyPct: 0, bundlePct: 0, top10Pct: 0, holders: 1, priorLaunches: 0, priorDead: 0,
  raised: 0, threshold: 4, progress: 0, phantomEth: 0, feeBps: 100,
  tokensPerEth: 1e8, fdvEth: 10, graduated: false, readyToGraduate: false, v4: null,
  updatedAt: Date.now(), status: "ready", ...over,
});

/** The SSE events sent since the last reset, as "type:token". */
const events: string[] = [];
clients.add({
  write: (s: string) => {
    const type = s.match(/^event: (\w+)/)?.[1];
    const token = s.match(/"token":"(0x[0-9a-fA-F]+)"/)?.[1]?.toLowerCase() ?? "";
    events.push(`${type}:${token}`);
    return true;
  },
} as unknown as ServerResponse);

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
const realLog = console.log;
const dropped: string[] = [];
console.log = (...a: unknown[]) => {
  const s = a.join(" ");
  if (s.startsWith("board: dropped")) dropped.push(s); else realLog(...a);
};

const reset = () => { rows.clear(); events.length = 0; warnings.length = 0; dropped.length = 0; setPinned(() => false); };
const key = (n: number) => who(n).toLowerCase();
const has = (n: number) => rows.has(key(n));

console.log("\nthe cap");
{
  reset();
  for (let i = 1; i <= 5; i++) upsert(row(i, 100 + i));
  ok("5 rows fit a cap of 5, and nothing drops", rows.size === 5 && !events.some((e) => e.startsWith("evict")));
  events.length = 0;
  upsert(row(6, 106));
  ok("a 6th drops the oldest", rows.size === 5 && !has(1) && has(6), [...rows.keys()].map((k) => k.slice(-1)).join(","));
  ok("the new row goes out, then the drop", events.join(" ") === `row:${key(6)} evict:${key(1)}`, events.join(" "));
  ok("and it is logged once", dropped.length === 1 && dropped[0]!.includes(who(1)) && dropped[0]!.includes("5 left"), dropped[0]);

  events.length = 0;
  upsert(row(3, 103, { raised: 1.5 }));
  ok("a refresh of a row already there drops nothing", rows.size === 5 && has(2) && events.join(" ") === `row:${key(3)}`,
    events.join(" "));
}

console.log("\nunbonded first");
{
  reset();
  upsert(row(1, 101, { graduated: true }));
  for (let i = 2; i <= 5; i++) upsert(row(i, 100 + i));
  upsert(row(6, 106));
  ok("a bonded token outlives newer unbonded ones", has(1) && !has(2), [...rows.keys()].map((k) => k.slice(-1)).join(","));

  reset();
  for (let i = 1; i <= 5; i++) upsert(row(i, 100 + i, { graduated: true }));
  upsert(row(6, 106, { graduated: true }));
  ok("when every row is bonded, the oldest bonded goes", !has(1) && has(6) && rows.size === 5);

  reset();
  // Two launches in one block: the lower address goes first, every time.
  upsert(row(0xb, 100)); upsert(row(0xa, 100));
  for (let i = 2; i <= 4; i++) upsert(row(i, 100 + i));
  upsert(row(5, 105));
  ok("equal blocks drop in a fixed order", !has(0xa) && has(0xb), [...rows.keys()].map((k) => k.slice(-2)).join(","));
}

console.log("\npinned");
{
  reset();
  setPinned((t) => t.toLowerCase() === key(1));
  for (let i = 1; i <= 5; i++) upsert(row(i, 100 + i));
  upsert(row(6, 106));
  ok("a pinned token stays; the next oldest goes", has(1) && !has(2) && rows.size === 5);

  reset();
  setPinned(() => true);
  for (let i = 1; i <= 7; i++) upsert(row(i, 100 + i));
  ok("with every row pinned, the board stays over its cap", rows.size === 7 && dropped.length === 0);
  ok("and says so once, not on every upsert", warnings.length === 1 && warnings[0]!.includes("every one is pinned"),
    `${warnings.length}: ${warnings[0]}`);
  setPinned(() => false);
  upsert(row(8, 108));
  ok("unpinned again, the next upsert brings it back to the cap", rows.size === 5 && !has(1) && !has(3) && has(8));
}

/** A fake `analyze` that answers once released, or throws `fail`. */
function slowAnalyze(opts: { fail?: unknown } = {}) {
  let go: () => void = () => {};
  const gate = new Promise<void>((r) => { go = r; });
  const deps: AnalyseDeps = {
    analyze: (async (addr: Address) => {
      await gate;
      if (opts.fail) throw opts.fail;
      return fakeAnalysis(addr, who(0xc0));
    }) as AnalyseDeps["analyze"],
    poolFor: (async () => null) as unknown as AnalyseDeps["poolFor"],
  };
  return { deps, release: () => go() };
}

console.log("\nnothing is left behind");
{
  reset();
  // A token analysed onto the board: a row, an analysis and a history point.
  const t = who(0x1);
  const a = slowAnalyze();
  const run = analyseInto(t, who(0xc0), who(0xc4ea), 101, a.deps);
  a.release();
  await run;
  const kept = keptFor(t);
  ok("an analysed token has a row, an analysis and a history point", kept.row && kept.analysis && kept.history,
    JSON.stringify(kept));
  const inFile = () => (existsSync(process.env.HISTORY_FILE!) ? JSON.parse(readFileSync(process.env.HISTORY_FILE!, "utf8")) : {});
  history.save();
  ok("its series is saved to the file", key(1) in inFile());

  // One the log node refused: a placeholder that waits in the retry queue.
  const refused = who(0x2);
  const busy = Object.assign(new Error("Too Many Requests"), { status: 429 });
  const b = slowAnalyze({ fail: busy });
  const run2 = analyseInto(refused, who(0xc1), who(0xc4ea), 102, b.deps);
  b.release();
  await run2;
  ok("a refused one waits to be tried again", keptFor(refused).retrying && keptFor(refused).row);

  for (let i = 3; i <= 7; i++) upsert(row(i, 100 + i));
  const gone = keptFor(t), gone2 = keptFor(refused);
  ok("dropped: no row, analysis or history", !gone.row && !gone.analysis && !gone.history, JSON.stringify(gone));
  ok("dropped: no longer waiting to be tried again", !gone2.row && !gone2.retrying, JSON.stringify(gone2));
  history.save();
  const file = inFile();
  ok("the next save writes its series out of the file", !(key(1) in file), Object.keys(file).join(","));
}

console.log("\nan analysis in flight does not put a dropped token back");
{
  reset();
  for (let i = 2; i <= 5; i++) upsert(row(i, 100 + i));
  const t = who(0x1);
  const a = slowAnalyze();
  // Its placeholder is the oldest row, so the board is full with it.
  const run = analyseInto(t, who(0xc0), who(0xc4ea), 101, a.deps);
  ok("its placeholder is on the board", has(1) && rows.get(key(1))!.status === "analysing");
  upsert(row(6, 106));
  ok("a newer launch drops it while it is analysed", !has(1));
  events.length = 0;
  a.release();
  await run;
  ok("when the analysis lands, it stays off", !has(1) && rows.size === 5 && events.length === 0, events.join(" "));
  ok("and nothing was kept for it", !Object.values(keptFor(t)).some(Boolean), JSON.stringify(keptFor(t)));

  // A bonded token: dropped while it is analysed, its pool is not read at all;
  // dropped while its pool is read, it still stays off.
  for (const during of ["analysis", "pool read"] as const) {
    reset();
    for (let i = 2; i <= 5; i++) upsert(row(i, 100 + i));
    let go: () => void = () => {};
    const gate = new Promise<void>((r) => { go = r; });
    let poolReads = 0;
    const deps: AnalyseDeps = {
      analyze: (async (addr: Address) => {
        if (during === "analysis") await gate;
        return fakeAnalysis(addr, who(0xc0), { graduated: true });
      }) as AnalyseDeps["analyze"],
      poolFor: (async () => {
        poolReads++;
        if (during === "pool read") await gate;
        return { id: "0xp", lpFee: 3000, liquidity: 1n, tokensPerEth: 1e7 };
      }) as unknown as AnalyseDeps["poolFor"],
    };
    const run3 = analyseInto(t, who(0xc0), who(0xc4ea), 101, deps);
    await new Promise((r) => setImmediate(r));
    upsert(row(6, 106));
    events.length = 0;
    go();
    await run3;
    ok(`bonded, dropped during its ${during}: stays off, nothing kept`,
      !has(1) && events.length === 0 && !Object.values(keptFor(t)).some(Boolean), `${events.join(" ")} ${JSON.stringify(keptFor(t))}`);
    if (during === "analysis") ok("…and its pool is never read", poolReads === 0, String(poolReads));
  }

  // The same, for an analysis that fails.
  reset();
  for (let i = 2; i <= 5; i++) upsert(row(i, 100 + i));
  const f = slowAnalyze({ fail: new Error("execution reverted") });
  const run2 = analyseInto(t, who(0xc0), who(0xc4ea), 101, f.deps);
  upsert(row(6, 106));
  events.length = 0;
  f.release();
  let threw = false;
  try { await run2; } catch { threw = true; }
  ok("a failed analysis of a dropped token neither throws nor puts it back",
    !threw && !has(1) && events.every((e) => e !== "row:" + key(1)));
}

console.log("\na refused RPC key is never a verdict on a launch (current-issues.md #6)");
{
  reset();
  // What viem throws for Alchemy's allowlist refusal, as the live board showed it.
  const allowlist = Object.assign(new Error("JSON is not a valid request object."), {
    name: "InvalidRequestRpcError", code: -32600, shortMessage: "JSON is not a valid request object.",
    details: "Unspecified origin not on whitelist.",
  });
  const t = who(0x9);
  const a = slowAnalyze({ fail: allowlist });
  const run = analyseInto(t, who(0xc9), who(0xc4ea), 109, a.deps);
  a.release();
  await run;
  const r = rows.get(key(9));
  ok("it stays a card being checked, with no error", r?.status === "analysing" && r.error === undefined, JSON.stringify(r?.status));
  ok("…and waits to be tried again", keptFor(t).retrying);

  // Anything else still is: a revert says something about the token.
  const other = who(0xa);
  const b = slowAnalyze({ fail: Object.assign(new Error("execution reverted"), { shortMessage: "execution reverted" }) });
  const run2 = analyseInto(other, who(0xca), who(0xc4ea), 110, b.deps);
  b.release();
  await run2;
  ok("another failure is still marked failed", rows.get(key(0xa))?.status === "error" && !keptFor(other).retrying);
}

console.log("\nlaunches the index commits reach the board without the websocket (current-issues.md #6, step 5)");
{
  reset();
  const launch = (n: number, block: number) => ({ token: who(n), curve: who(0xc00 + n), creator: who(0xc4ea), block: BigInt(block) });
  const quick: AnalyseDeps = {
    analyze: (async (addr: Address) => fakeAnalysis(addr, who(0xc0))) as AnalyseDeps["analyze"],
    poolFor: (async () => null) as unknown as AnalyseDeps["poolFor"],
  };

  indexFeed({ on: true, cut: null });
  ok("before the backfill has read the index, nothing: the follower's first rounds are history",
    addIndexedLaunches([launch(0x21, 500)], quick) === 0 && !has(0x21));

  indexFeed({ on: true, cut: 400n });
  upsert(row(0x22, 450));
  const started = addIndexedLaunches([launch(0x21, 500), launch(0x22, 450), launch(0x23, 400), launch(0x24, 300)], quick);
  ok("only a launch after the backfill's newest, and not already on the board, is started", started === 1, String(started));
  ok("…and it is on the board at once, as a card being checked", has(0x21));
  ok("…the others are not: the one at the cut, and older", !has(0x23) && !has(0x24));
  await new Promise((r) => setTimeout(r, 20));
  ok("…and once analysed it is ready", rows.get(key(0x21))?.status === "ready", rows.get(key(0x21))?.status);

  // A self page's feed calls the sniper for each launch: the index stays out of it.
  indexFeed({ on: false });
  ok("a self page's board is fed by its websocket alone", addIndexedLaunches([launch(0x25, 600)], quick) === 0 && !has(0x25));
  indexFeed({ on: false, cut: null });
}

console.log("\ngraduated tokens always load, dead launches don't (B6; the user: CABO and CLANKCAT fell off after a restart)");
{
  const L = (n: number, block: number) => ({ token: who(n), block: BigInt(block) });
  // 10 launches at blocks 100..1000. Two old ones graduated (blocks 100 and 200); the live window starts at 700.
  const all = Array.from({ length: 10 }, (_, i) => L(0x40 + i, 100 * (i + 1)));
  const activity = {
    graduated: new Set([who(0x40).toLowerCase(), who(0x41).toLowerCase()]),
    lastTrade: new Map([[who(0x43).toLowerCase(), 750n], [who(0x44).toLowerCase(), 300n]]),
  };
  const blocks = (xs: { block: bigint }[]) => xs.map((l) => Number(l.block)).join(",");

  const picked = pickBackfill(all, 5, activity, 700n);
  ok("both old graduated tokens load, whatever their age", picked.some((l) => l.token === who(0x40)) && picked.some((l) => l.token === who(0x41)), blocks(picked));
  ok("…with the newest live launches filling the rest of the cap, newest first", blocks(picked) === "1000,900,800,200,100", blocks(picked));
  const wide = pickBackfill(all, 10, activity, 700n);
  ok("an old launch that traded in the window loads; one that traded before it doesn't", wide.some((l) => l.token === who(0x43)) && !wide.some((l) => l.token === who(0x44)), blocks(wide));
  ok("…and old launches with no trade don't load at all", blocks(wide) === "1000,900,800,700,400,200,100", blocks(wide));
  ok("without the index's activity, the newest launches, as before", blocks(pickBackfill(all, 3, null, null)) === "1000,900,800");
  ok("with the rule off (no cutoff), graduated first, then the newest", blocks(pickBackfill(all, 4, activity, null)) === "1000,900,200,100");

  ok("dead: old, not graduated, no trade in the window", isDead(who(0x45), 600n, activity, 700n));
  ok("not dead: young", !isDead(who(0x45), 700n, activity, 700n));
  ok("not dead: traded in the window", !isDead(who(0x43), 400n, activity, 700n));
  ok("not dead: graduated", !isDead(who(0x40), 100n, activity, 700n));

  reset();
  upsert(row(0x45, 600)); upsert(row(0x46, 800)); upsert(row(0x40, 100, { graduated: true }));
  upsert(row(0x47, 500)); upsert(row(0x48, 550, { status: "analysing" }));
  setPinned((t) => t.toLowerCase() === key(0x47));
  const gone = dropDead(activity, 700n);
  ok("the sweep drops a row gone dead", !has(0x45) && gone === 1, String(gone));
  ok("…but not a young, graduated, pinned or analysing one", has(0x46) && has(0x40) && has(0x47) && has(0x48));
  ok("…and nothing is kept for the dropped one", !Object.values(keptFor(who(0x45))).some(Boolean));

  reset();
  const quick: AnalyseDeps = {
    analyze: (async (addr: Address) => fakeAnalysis(addr, who(0xc0))) as AnalyseDeps["analyze"],
    poolFor: (async () => null) as unknown as AnalyseDeps["poolFor"],
  };
  // The board has seen these launches (the backfill fills its list of known ones).
  addIndexedLaunches([{ token: who(0x50), curve: who(0xc50), creator: who(0xc4ea), block: 100n }, { token: who(0x51), curve: who(0xc51), creator: who(0xc4ea), block: 110n }], quick);
  indexFeed({ on: true, cut: 400n });
  ok("a trade at or before the cut brings nothing back", reviveTraded([{ token: who(0x50), block: 400n }], quick) === 0 && !has(0x50));
  ok("a dead launch that trades after the cut comes back", reviveTraded([{ token: who(0x50), block: 900n }, { token: who(0x50), block: 901n }], quick) === 1 && has(0x50));
  ok("a launch the board never saw is not made up", reviveTraded([{ token: who(0x5f), block: 900n }], quick) === 0 && !has(0x5f));
  ok("one already on the board is left as it is", reviveTraded([{ token: who(0x50), block: 950n }], quick) === 0);
  await new Promise((r) => setTimeout(r, 20));
  ok("…and once analysed it is ready", rows.get(key(0x50))?.status === "ready", rows.get(key(0x50))?.status);
  indexFeed({ on: false, cut: null });
  ok("with the feed off, nothing is brought back", reviveTraded([{ token: who(0x51), block: 900n }], quick) === 0 && !has(0x51));
}

console.log = realLog;
console.warn = realWarn;
console.log(failures === 0
  ? "\n\x1b[32mall board checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
