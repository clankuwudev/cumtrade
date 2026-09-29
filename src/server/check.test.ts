/**
 * `/api/check` — public-release B5.1.
 *
 * Hosted answers the verdict without putting the token on the shared board;
 * self still enrols it. Concurrent hosted checks of one address share one
 * run, and its answer is kept a minute. Runs the route with fake analyze /
 * analyseInto / poolFor, so it makes no chain call.
 *
 *   npm run test:check
 */
import type { ServerResponse } from "node:http";
import type { Address } from "viem";
import type { Analysis } from "../core/checker/analyze.js";
import { fakeAnalysis, who } from "./analysisFixture.js";
import { clearCache } from "../core/lib/cache.js";
import * as history from "../core/lib/history.js";
import { clients, rows, type Row } from "./board.js";
import { checkRoute, CHECK_REUSE_MS, type CheckDeps } from "./routes/public.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const analysis = fakeAnalysis;

/** Fakes that count their calls. `analyze` answers from `known`, by token or curve. */
function fakes(known: Analysis[], opts: { delayMs?: number; fail?: unknown } = {}) {
  const calls = { analyze: 0, analyseInto: 0, poolFor: 0 };
  const deps: CheckDeps = {
    analyze: (async (addr: Address) => {
      calls.analyze++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw opts.fail;
      const a = known.find((k) => [k.token, k.curve].some((x) => x.toLowerCase() === addr.toLowerCase()));
      if (!a) throw new Error("not a clank.trade token");
      return a;
    }) as CheckDeps["analyze"],
    analyseInto: (async () => { calls.analyseInto++; }) as CheckDeps["analyseInto"],
    poolFor: (async () => {
      calls.poolFor++;
      return { id: "0xp001", lpFee: 10_000, liquidity: 5n, tokensPerEth: 2e8 };
    }) as unknown as CheckDeps["poolFor"],
  };
  return { calls, deps };
}

/** Run the route for `addr` and return what it answered. */
async function check(route: ReturnType<typeof checkRoute>, addr: string) {
  let status = 0, body = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string> = {}) { status = s; Object.assign(headers, h); return res; },
    end(b?: unknown) { body = b === undefined ? "" : String(b); },
  };
  const url = new URL(`/api/check?addr=${addr}`, "http://localhost:8787");
  await route.handle({ method: "GET", headers: {} } as never, res as never, url);
  return { status, headers, data: body ? JSON.parse(body) : null };
}

/** An SSE client that remembers every write. */
const sse: string[] = [];
clients.add({ write: (s: string) => { sse.push(s); return true; } } as unknown as ServerResponse);

const reset = () => { clearCache(); rows.clear(); sse.length = 0; };

console.log("\nhosted: a token off the board");
{
  reset();
  const T = who(0x7001), C = who(0xc001);
  const { calls, deps } = fakes([analysis(T, C)]);
  const route = checkRoute("hosted", deps);
  const before = rows.size;
  const r = await check(route, T);
  ok("answers 200 with the verdict", r.status === 200 && typeof r.data.band === "string" && Array.isArray(r.data.findings)
    && typeof r.data.score === "number" && r.data.stats?.curve === C, `${r.status} ${r.data?.band}`);
  ok("says it is not on the board, and when it was checked",
    r.data.onBoard === false && typeof r.data.checkedAt === "number" && Math.abs(r.data.checkedAt - Date.now()) < 5_000);
  ok("the board did not grow", rows.size === before, `${before} → ${rows.size}`);
  ok("nothing was broadcast", sse.length === 0, sse.join(" | ").slice(0, 120));
  ok("analyseInto was never called", calls.analyseInto === 0);
  ok("no history was recorded for it", history.series(T).length === 0);
  ok("a curve that has not bonded reads no pool", calls.poolFor === 0);

  // Asked by its curve: the answer names the token, and it is still not enrolled.
  const byCurve = await check(route, C);
  ok("asked by its curve: names the token, still off the board",
    byCurve.data.token === T && byCurve.data.onBoard === false && rows.size === before && calls.analyseInto === 0);
}

console.log("\nhosted: one run for many, kept a minute");
{
  reset();
  // Letters in it, so another casing is a different string.
  const T = who(0xab7002), C = who(0xc002);
  const { calls, deps } = fakes([analysis(T, C)], { delayMs: 30 });
  const route = checkRoute("hosted", deps);
  const answers = await Promise.all(Array.from({ length: 10 }, () => check(route, T)));
  ok("10 concurrent checks run one analysis", calls.analyze === 1, `${calls.analyze}`);
  ok("and all get the same answer", answers.every((a) => a.status === 200 && a.data.checkedAt === answers[0]!.data.checkedAt));
  // Another casing of the same address is the same address.
  const again = await check(route, T.toUpperCase().replace("0X", "0x"));
  ok("a check within the minute reuses it, in any casing", calls.analyze === 1 && again.data.checkedAt === answers[0]!.data.checkedAt);

  const realNow = Date.now;
  Date.now = () => realNow() + CHECK_REUSE_MS + 1_000;
  try {
    const later = await check(route, T);
    ok("after the minute it runs again", calls.analyze === 2 && later.data.checkedAt > answers[0]!.data.checkedAt,
      `${calls.analyze}`);
  } finally {
    Date.now = realNow;
  }
}

console.log("\nhosted: a failure is not kept");
{
  reset();
  const T = who(0x7003), C = who(0xc003);
  const busy = Object.assign(new Error("Too Many Requests"), { status: 429 });
  const failing = fakes([analysis(T, C)], { fail: busy });
  const r = await check(checkRoute("hosted", failing.deps), T);
  ok("the log node refusing → 503 with retry-after", r.status === 503 && Number(r.headers["retry-after"]) >= 1,
    `${r.status} ${r.headers["retry-after"]}`);
  const good = fakes([analysis(T, C)]);
  const next = await check(checkRoute("hosted", good.deps), T);
  ok("the next check runs the analysis again", good.calls.analyze === 1 && next.status === 200);

  const other = fakes([], {});
  const bad = await check(checkRoute("hosted", other.deps), who(0xdead));
  ok("an address that is not a token → 500, and nothing enrolled", bad.status === 500 && rows.size === 0 && sse.length === 0);
  ok("a malformed address → 400 without an analysis", (await check(checkRoute("hosted", other.deps), "0x12")).status === 400
    && other.calls.analyze === 1);
}

console.log("\nhosted: a token already on the board (D1)");
{
  reset();
  const T = who(0x7004), C = who(0xc004);
  rows.set(T.toLowerCase(), { token: T, curve: C, status: "ready", v4: null, tokensPerEth: 0, fdvEth: 0 } as unknown as Row);
  const { calls, deps } = fakes([analysis(T, C)]);
  const r = await check(checkRoute("hosted", deps), T);
  ok("refreshed through analyseInto once", calls.analyseInto === 1, `${calls.analyseInto}`);
  ok("says it is on the board", r.data.onBoard === true);
  ok("the board did not grow", rows.size === 1);
}

console.log("\nhosted: a bonded token off the board (D4)");
{
  reset();
  const T = who(0x7005), C = who(0xc005);
  const { calls, deps } = fakes([analysis(T, C, { graduated: true, realQuote: 0n })]);
  const r = await check(checkRoute("hosted", deps), T);
  ok("reads its own pool once", calls.poolFor === 1, `${calls.poolFor}`);
  ok("and is priced from it", r.data.stats.fdvEth === 1e9 / 2e8 && r.data.stats.tokensPerEth === 2e8
    && r.data.stats.v4?.poolId === "0xp001" && r.data.stats.v4?.liquidity === "5" && r.data.stats.v4?.lpFee === 10_000,
    JSON.stringify(r.data.stats.v4));
  ok("still not enrolled", rows.size === 0 && sse.length === 0 && calls.analyseInto === 0);

  reset();
  const noPool = fakes([analysis(T, C, { graduated: true, realQuote: 0n })]);
  noPool.deps.poolFor = (async () => { noPool.calls.poolFor++; throw new Error("no pool"); }) as never;
  const r2 = await check(checkRoute("hosted", noPool.deps), T);
  ok("a pool read that fails leaves the price unknown, not an error",
    r2.status === 200 && r2.data.stats.fdvEth === null && r2.data.stats.v4 === null);
}

console.log("\nself: unchanged");
{
  reset();
  const T = who(0x7006), C = who(0xc006);
  const { calls, deps } = fakes([analysis(T, C)]);
  const route = checkRoute("self", deps);
  const r = await check(route, T);
  ok("a token off the board is enrolled", calls.analyseInto === 1);
  ok("the answer has no onBoard or checkedAt", r.status === 200 && !("onBoard" in r.data) && !("checkedAt" in r.data),
    Object.keys(r.data).join(","));
  await check(route, T);
  ok("nothing is reused: two checks, two analyses", calls.analyze === 2, `${calls.analyze}`);
}

console.log(failures === 0
  ? "\n\x1b[32mall check-route checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
