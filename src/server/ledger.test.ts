/**
 * `GET /api/ledger` — public-release B3.5.
 *
 * Two halves, no network:
 *   - the payload, from the recorded routed address (core/positions/fixtures)
 *     and the recorded state of its two open positions' curves, served by the
 *     fake node;
 *   - the route, over HTTP through hosted's real gate, with the lookup
 *     stubbed, and everything the process logs captured.
 *
 *   npm run test:ledgerapi
 */
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { fakeNode, type Fixture } from "../core/positions/fixtures/node.js";

process.env.HISTORY_FILE = join(tmpdir(), `clank-ledger-test-${process.pid}.json`);
await import("../entry/mode-hosted.js");

const fixture = (n: string) =>
  JSON.parse(readFileSync(new URL(`../core/positions/fixtures/${n}.json`, import.meta.url), "utf8")) as Fixture;
const routed = fixture("ledger-routed");
// The second factory is clank.trade's newer one, asked about the same curves (B1.5).
const node = fakeNode([routed, fixture("ledger-routed-curves"), fixture("ledger-second-factory")]);
globalThis.fetch = node.fetch;

const { buildLedger } = await import("../core/positions/ledger.js");
const { valueAt, readState } = await import("../core/positions/valuation.js");
const { shapeLedger } = await import("./ledgerPayload.js");
const { verdict } = await import("../core/record/verdict.js");
const prices = await import("../core/record/prices.js");
const { valuedFields } = await import("./positionFields.js");
const { hostedApp } = await import("./routes/hosted.js");
const { createLimiter, LIMITS } = await import("./rateLimit.js");
const { LogsBusy } = await import("../core/lib/logGate.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const ROUTED = routed.address as Address;
const AT = { toBlock: BigInt(routed.toBlock) };
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------
console.log("\nthe payload");
{
  const l = { ...(await buildLedger(ROUTED, AT)).ledger, builtAt: 1_700_000_000_000 };
  node.reset();
  const r = await shapeLedger(l);
  ok("open and closed as the ledger has them", r.open.length === 2 && r.closed.length === 2,
    `${r.open.length} open, ${r.closed.length} closed`);
  // Two open curves and the one a closed position sold on that no open one
  // holds (P1): 3 × 8 reads, still one call. The fixture has no state for
  // that third curve at its block, so its sale cannot be valued (below).
  ok("both open positions valued, and what was sold, in one multicall of 24 curve reads",
    r.open.every((p) => p.valued === true && (p.nowEth ?? 0) > 0) && node.state.inner.join() === "24",
    `calls per multicall [${node.state.inner.join()}]`);

  // The same fields self's /api/positions derives, from the same helper, for
  // the same position and valuation. Only the manager's fields are missing.
  const p = l.positions.find((q) => !q.closed)!;
  const v = await valueAt(await readState(p.curve), BigInt(p.tokens), p.token);
  const hosted = r.open.find((q) => same(q.token, p.token) && !q.closed)!;
  const want = valuedFields(p, v);
  ok("every valued field equals self's derivation",
    Object.entries(want).every(([k, x]) => (hosted as Record<string, unknown>)[k] === x));
  ok("every accounting field is the ledger's",
    (["costEth", "tokens", "realizedWei", "realizedCostWei", "entryFeeWei", "realizedEntryFeeWei",
      "exitFeeWei", "snipeTaxWei", "gasWei", "soldTokens", "openTx", "confidence"] as const)
      .every((k) => (hosted as Record<string, unknown>)[k] === p[k]));
  const json = JSON.stringify(r);
  ok("nothing only a manager knows: no peakValueWei, peakPct or exit", !/peakValueWei|peakPct|"exit"/.test(json));
  ok("the block, the build time and completeness",
    r.asOfBlock === routed.toBlock && r.builtAt === 1_700_000_000_000 && r.partial === false && r.omittedTokens.length === 0);

  const eth = (w: bigint) => Number(w) / 1e18;
  const realized = l.positions.reduce((a, q) => a + BigInt(q.realizedWei), 0n);
  const realizedPnl = l.positions.reduce((a, q) => a + BigInt(q.realizedWei) - BigInt(q.realizedCostWei), 0n);
  ok("totals: realised, realised P&L, open value and cost, none excluded",
    r.totals.realizedEth === eth(realized) && r.totals.realizedPnlEth === eth(realizedPnl)
      && Math.abs(r.totals.openValueEth - r.open.reduce((a, q) => a + (q.nowEth ?? 0), 0)) < 1e-12
      && r.totals.openCostEth === eth(l.positions.filter((q) => !q.closed).reduce((a, q) => a + BigInt(q.costEth), 0n))
      && r.totals.excluded === 0,
    JSON.stringify(r.totals));

  // A position whose tokens left without a sell has unknown proceeds, and a
  // total that included it would read exactly like one that does not.
  const closedOne = l.positions.find((q) => q.closed)!;
  const guessed = { ...l, positions: l.positions.map((q) => (q === closedOne ? { ...q, confidence: "proceeds-unknown" as const } : q)) };
  const g = await shapeLedger(guessed);
  ok("proceeds-unknown rows are left out of the realised totals and counted",
    g.totals.excluded === 1
      && g.totals.realizedEth === eth(realized - BigInt(closedOne.realizedWei))
      && g.totals.realizedPnlEth === eth(realizedPnl - (BigInt(closedOne.realizedWei) - BigInt(closedOne.realizedCostWei))),
    JSON.stringify(g.totals));

  node.reset();
  await Promise.all([shapeLedger(l), shapeLedger(l)]);
  ok("curve state and sold values are shared across lookups: two more read only the sale that failed, once",
    node.state.inner.join() === "8", `calls per multicall [${node.state.inner.join()}]`);
  const sold = [...r.open, ...r.closed].filter((q) => BigInt(q.soldTokens) > 0n);
  ok("…which is shown unpriced, not guessed; the other sale is priced and judged",
    sold.some((q) => q.sellVerdict === "unpriced" && q.soldNowEth === null)
      && sold.some((q) => q.sellVerdict !== "unpriced" && (q.soldNowEth ?? 0) > 0),
    sold.map((q) => `${q.symbol} ${q.sellVerdict} ${q.soldNowEth}`).join(", "));

  const failing = await shapeLedger(l, async () => { throw new Error("no"); });
  ok("a position that cannot be valued says so, with zeros rather than guesses",
    failing.open.every((q) => q.valued === false && q.nowEth === 0) && failing.totals.openValueEth === 0);
}

// ---------------------------------------------------------------------------
console.log("\nthe call on each sell (p-sell-verdict.md, P1)");
{
  const l = { ...(await buildLedger(ROUTED, AT)).ledger, builtAt: 1_700_000_000_000 };
  const base = l.positions.find((q) => q.closed)!;
  const back = Number(BigInt(base.realizedWei)) / 1e18;
  const margin = Math.max(0.0005, 0.1 * back);
  // One sold position per case, each worth `now` today (null: cannot be valued).
  const cases: [string, number | null, string][] = [
    ["paperhand", back + margin * 2, "paperhand"],
    ["good", back / 2, "good"],
    ["inside", back + margin / 2, "good"],
    ["unpriced", null, "unpriced"],
  ];
  const positions = [
    ...cases.map(([symbol]) => ({ ...base, symbol })),
    { ...base, symbol: "unknown", confidence: "proceeds-unknown" as const },
    { ...base, symbol: "partly", closed: undefined, tokens: "1000" },
    { ...base, symbol: "unsold", closed: undefined, tokens: "1000", soldTokens: "0", realizedWei: "0" },
  ];
  const asked: string[] = [];
  const r = await shapeLedger({ ...l, positions }, async () => { throw new Error("not valued here"); }, async (p) => {
    asked.push(p.symbol);
    if (p.symbol === "partly") return back * 3;
    const c = cases.find(([s]) => s === p.symbol);
    if (!c || c[1] === null) throw new Error("no price");
    return c[1];
  });
  const by = new Map([...r.open, ...r.closed].map((q) => [q.symbol, q]));
  for (const [symbol, now, want] of cases) {
    const q = by.get(symbol)!;
    ok(`${symbol}: ${want}`, q.sellVerdict === want && q.soldNowEth === now, `${q.sellVerdict} at ${q.soldNowEth}`);
  }
  ok("proceeds unknown: no call and no valuation", by.get("unknown")!.sellVerdict === null
    && by.get("unknown")!.soldNowEth === null && !asked.includes("unknown"));
  ok("a partly sold open position is judged on what it sold", by.get("partly")!.sellVerdict === "paperhand"
    && r.open.some((q) => q.symbol === "partly"));
  ok("an open position that sold nothing is holding, and nothing is valued for it",
    by.get("unsold")!.sellVerdict === "holding" && by.get("unsold")!.soldNowEth === null && !asked.includes("unsold"));
  ok("never a fumble: there is no best exit here", [...r.open, ...r.closed].every((q) => (q.sellVerdict as string | null) !== "fumble"));
  ok("self's verdict is the same function", prices.verdict === verdict);
}

// ---------------------------------------------------------------------------
console.log("\nthe route");
{
  const SITE = "https://clank.test";
  const port = await new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
  let answer: (a: Address) => Promise<unknown> = async (a) => ({ address: a });
  const seen: string[] = [];
  const asked: boolean[] = [];
  // Room for every request below: the limits have their own test (test:gate).
  const room = { client: { perMin: 1000, burst: 1000 }, global: { perMin: 1000, burst: 1000 } };
  const limits = { ...LIMITS, classes: { ...LIMITS.classes, ledger: { ...room, distinctPerHour: 1000 } } };
  const app = hostedApp({
    port, publicOrigin: SITE, limiter: createLimiter({ limits }), trustProxy: false,
    ledger: async (a, o) => { seen.push(a); asked.push(!!o?.fresh); return answer(a) as never; },
  });
  await new Promise<void>((res) => app.listen(port, "127.0.0.1", res));

  // Everything the process writes while the route runs.
  const logged: string[] = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };

  const call = (path: string, method = "GET", headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, path, method, headers: { host: "clank.test", ...headers } }, (r) => {
      let body = ""; r.setEncoding("utf8"); r.on("data", (c) => (body += c)); r.on("end", () => res({ status: r.statusCode ?? 0, body, headers: r.headers }));
    });
    q.on("error", rej); q.end();
  });

  const A = "0x0000000000000000000000000000000000c0FFee";
  const good = await call(`/api/ledger?address=${A}`);
  const fresh = await call(`/api/ledger?address=${A}&fresh=1`);
  const notFresh = await call(`/api/ledger?address=${A}&fresh=yes`);
  const bad = await Promise.all(["", "?address=", "?address=0x123", "?address=nope", `?address=${A}00`].map((q) => call(`/api/ledger${q}`)));
  const lookedUp = seen.length;
  answer = async () => { throw new LogsBusy(12_000); };
  const busy = await call(`/api/ledger?address=${A}`);
  answer = async () => { throw new Error(`boom for ${A}`); };
  const broken = await call(`/api/ledger?address=${A}`);
  const post = await call(`/api/ledger?address=${A}`, "POST", { origin: SITE, "content-type": "application/json" });

  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = keep[k];
  app.close();

  ok("a valid address → 200 with the lookup's answer", good.status === 200 && JSON.parse(good.body).address === A, good.body);
  ok("fresh=1 asks the lookup for a fresh ledger; anything else does not (D1.0)",
    fresh.status === 200 && notFresh.status === 200 && asked.slice(0, 3).join() === "false,true,false", asked.slice(0, 3).join());
  ok("anything else → 400, and the lookup never runs", bad.every((b) => b.status === 400) && lookedUp === 3,
    bad.map((b) => b.status).join());
  ok("…with a sentence to show", bad.every((b) => typeof JSON.parse(b.body).text === "string"));
  ok("the log node refusing → 503 with its retry-after", busy.status === 503 && busy.headers["retry-after"] === "12"
    && JSON.parse(busy.body).error === "busy", `${busy.status} ${busy.headers["retry-after"]}`);
  ok("any other failure → 502, and the error's text is not passed on", broken.status === 502 && !broken.body.includes("boom"));
  ok("POST → 405", post.status === 405, String(post.status));
  ok("nothing the process logged names the address",
    !logged.some((l) => l.toLowerCase().includes(A.toLowerCase().slice(2))), `${logged.length} line(s) logged`);
  ok("…and no answer is cached", [good, busy, broken, ...bad].every((b) => b.headers["cache-control"] === "no-store"));
}

// ---------------------------------------------------------------------------
console.log("\nthe replay route (p-sell-verdict.md, P4a)");
{
  const SITE = "https://clank.test";
  const port = await new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
  const asked: unknown[] = [];
  let answer: () => Promise<unknown> = async () => ({ fills: [{ kind: "buy" }] });
  const room = { client: { perMin: 1000, burst: 1000 }, global: { perMin: 1000, burst: 1000 } };
  const limits = { ...LIMITS, classes: { ...LIMITS.classes, replay: { ...room, distinctPerHour: 1000 } } };
  const app = hostedApp({
    port, publicOrigin: SITE, limiter: createLimiter({ limits }), trustProxy: false,
    replay: async (q) => { asked.push(q); return answer() as never; },
  });
  await new Promise<void>((res) => app.listen(port, "127.0.0.1", res));
  const logged: string[] = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  const call = (path: string) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, path, headers: { host: "clank.test" } }, (r) => {
      let body = ""; r.setEncoding("utf8"); r.on("data", (c) => (body += c)); r.on("end", () => res({ status: r.statusCode ?? 0, body, headers: r.headers }));
    });
    q.on("error", rej); q.end();
  });

  const A = "0x0000000000000000000000000000000000c0FFee", T = "0x00000000000000000000000000000000000000c1";
  const good = await call(`/api/replay?address=${A}&token=${T}&opened=1790000000000&closed=1790000360000`);
  const open = await call(`/api/replay?address=${A}&token=${T}&opened=1790000000000`);
  const bad = await Promise.all([
    `?token=${T}&opened=1`, `?address=${A}&opened=1`, `?address=${A}&token=${T}`, `?address=${A}&token=${T}&opened=soon`,
    `?address=${A}&token=${T}&opened=-5`, `?address=${A}&token=${T}&opened=1790000000000&closed=1`, `?address=nope&token=${T}&opened=1`,
  ].map((q) => call(`/api/replay${q}`)));
  const lookedUp = asked.length;
  answer = async () => null;
  const none = await call(`/api/replay?address=${A}&token=${T}&opened=1790000000000`);
  answer = async () => { throw new Error(`boom for ${A}`); };
  const broken = await call(`/api/replay?address=${A}&token=${T}&opened=1790000000000`);
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = keep[k];
  app.close();

  ok("a position → 200 with the lookup's answer", good.status === 200 && JSON.parse(good.body).fills.length === 1, good.body);
  ok("the lookup gets whose, which token and the window",
    JSON.stringify(asked[0]) === JSON.stringify({ address: A, token: T, opened: 1790000000000, closed: 1790000360000 }), JSON.stringify(asked[0]));
  ok("an open position has no close", open.status === 200 && (asked[1] as { closed: unknown }).closed === null);
  ok("anything missing or wrong → 400, and the lookup never runs", bad.every((b) => b.status === 400) && lookedUp === 2,
    bad.map((b) => b.status).join());
  ok("no trades in the index → 404 with a sentence", none.status === 404 && typeof JSON.parse(none.body).text === "string");
  ok("a failure → 502, and its text is not passed on", broken.status === 502 && !broken.body.includes("boom"));
  ok("nothing the process logged names the address", !logged.some((l) => l.toLowerCase().includes(A.toLowerCase().slice(2))),
    `${logged.length} line(s) logged`);
}

console.log(failures === 0
  ? "\n\x1b[32mall ledger route checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
