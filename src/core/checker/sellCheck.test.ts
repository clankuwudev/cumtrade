/**
 * The sell check (current-issues.md #4): the quote and the simulation are read
 * at one block, and only a sell that reverts after a good buy says a token
 * cannot be sold. A check that could not run is unknown, not a failure.
 * Hermetic: a made-up curve whose price moves each block, and fake reads.
 *
 *   npm run test:sellcheck
 */

export {};

// Before anything imports client.ts: nothing here may reach a real node.
process.env.RPC_URL = "http://fake-node.invalid";
process.env.LOGS_RPC_URL = "http://fake-node.invalid";
process.env.LOGS_FALLBACK_URL = "";

const { SIM_UNKNOWN_TTL, prefetchSims, readTriple, roundTrip, sellableOf } = await import("./analyze.js");
type SimIo = import("./analyze.js").SimIo;
type SimCall = import("./analyze.js").SimCall;
const { derive, evaluate, score } = await import("./rules.js");
const { fakeAnalysis, who } = await import("../../server/analysisFixture.js");
const { cached, clearCache } = await import("../lib/cache.js");
const { decodeFunctionData } = await import("viem");
const { curveAbi } = await import("../abi.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const CURVE = who(0xc0e1), TOKEN = who(0x70a1);
const IN = 10n ** 16n;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as `0x${string}`;
const good = (v = 1n): SimCall => ({ status: "0x1", returnData: word(v) });
const reverted: SimCall = { status: "0x0", returnData: "0x", error: { message: "execution reverted" } };

/**
 * A curve that gives fewer tokens for 0.01 ETH at each later block, as a busy
 * one does while others buy. A simulated sell of more than the buy delivered
 * reverts, as on the chain (reproduced on NEKO, 2026-09-23).
 */
function busyCurve(head: bigint) {
  const asked: { quoteAt: bigint[]; simAt: bigint[] } = { quoteAt: [], simAt: [] };
  const tokensAt = (b: bigint) => 1_000_000n * 10n ** 18n - (b - 1000n) * 10n ** 18n;
  const io: SimIo = {
    blockNumber: async () => head,
    quoteBuy: async (_c, _in, b) => { asked.quoteAt.push(b); return tokensAt(b); },
    simulate: async (calls, b) => {
      asked.simAt.push(b);
      const out: SimCall[] = [];
      for (let i = 0; i < calls.length; i += 3) {
        const bought = tokensAt(b);
        const sell = decodeFunctionData({ abi: curveAbi, data: (calls[i + 2] as { data: `0x${string}` }).data });
        const selling = sell.args![0] as bigint;
        out.push(good(bought), good(1n), selling <= bought ? good(IN * 98n / 100n) : reverted);
      }
      return out;
    },
  };
  return { io, asked, tokensAt };
}

console.log("\none block for the quote and the simulation");
{
  const { io, asked } = busyCurve(1_005n);
  const r = await roundTrip(io, CURVE, TOKEN, IN);
  ok("the quote and the simulation are asked at the same block", asked.quoteAt[0] === 1_005n && asked.simAt[0] === 1_005n,
    `quote ${asked.quoteAt} / sim ${asked.simAt}`);
  ok("so a busy curve's sell goes through", r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)));

  // What it did before: the quote at one block, the simulation at a later one.
  const { io: io2, tokensAt } = busyCurve(1_005n);
  const late: SimIo = { ...io2, simulate: (calls) => io2.simulate(calls, 1_006n) };
  const r2 = await roundTrip(late, CURVE, TOKEN, IN);
  ok("(a simulation a block later sells more than the buy got, and reverts)", !r2.ok && !r2.unknown
    && tokensAt(1_006n) < tokensAt(1_005n), r2.error ?? "");

  const b = busyCurve(2_000n);
  await prefetchSims([{ token: TOKEN, curve: CURVE }, { token: who(0x70a2), curve: who(0xc0e2) }], IN, b.io);
  ok("a batch reads one block for all its quotes and its simulation",
    b.asked.quoteAt.length === 2 && b.asked.quoteAt.every((x) => x === 2_000n) && b.asked.simAt.join() === "2000",
    `quotes ${b.asked.quoteAt} / sim ${b.asked.simAt}`);
}

console.log("\nwhat says a token cannot be sold, and what only says the check did not run");
{
  const fail = (io: Partial<SimIo>): SimIo => ({ ...busyCurve(1_000n).io, ...io });
  const cases: [string, SimResultLike, boolean][] = [
    ["a sell that reverts after a good buy", readTriple(IN, 5n, [good(), good(), reverted]), false],
    ["an approve that reverts", readTriple(IN, 5n, [good(), reverted, good()]), false],
    ["a buy that reverts", readTriple(IN, 5n, [reverted, good(), good()]), true],
    ["no result at all", readTriple(IN, 5n, []), true],
    ["the block number cannot be read", await roundTrip(fail({ blockNumber: async () => { throw new Error("429"); } }), CURVE, TOKEN, IN), true],
    ["quoteBuy fails", await roundTrip(fail({ quoteBuy: async () => { throw new Error("header not found"); } }), CURVE, TOKEN, IN), true],
    ["the simulation request fails", await roundTrip(fail({ simulate: async () => { throw new Error("timeout"); } }), CURVE, TOKEN, IN), true],
  ];
  for (const [name, r, unknown] of cases) {
    ok(`${name}: ${unknown ? "not known" : "cannot be sold"}`, !r.ok && r.unknown === unknown && r.sellBlocked === !unknown
      && sellableOf(r as never) === (unknown ? null : false), r.error ?? "");
  }
  ok("a round trip that goes through is sellable", sellableOf(readTriple(IN, 5n, [good(), good(), good(IN)]) as never) === true);
}
type SimResultLike = { ok: boolean; unknown: boolean; sellBlocked: boolean; error: string | null };

console.log("\nhow the check scores each");
{
  const judge = (sim: object, over: Record<string, unknown> = {}) => {
    const a = fakeAnalysis(TOKEN, CURVE, { sim, ...over });
    const findings = evaluate(a, derive(a));
    return { findings, s: score(findings) };
  };
  const blocked = judge({ ok: false, unknown: false, sellBlocked: true, error: "SELL REVERTED after a successful buy: execution reverted" });
  ok("a reverted sell is critical, as before",
    blocked.findings.some((f) => f.severity === "critical" && f.title === "Sell simulation failed") && blocked.s.band === "AVOID",
    blocked.s.band);
  const unknown = judge({ ok: false, unknown: true, sellBlocked: false, error: "eth_simulateV1 failed: timeout" });
  const f = unknown.findings.find((x) => x.title === "Sell check did not run");
  ok("a check that did not run is medium, with its reason", f?.severity === "medium" && /timeout/.test(f.detail), f?.detail ?? "none");
  ok("…and not critical, so the token is not AVOID for it",
    !unknown.findings.some((x) => x.severity === "critical") && unknown.s.band !== "AVOID", unknown.s.band);
  const grad = judge({ ok: false, unknown: true, sellBlocked: false, error: "buy reverted" }, { graduated: true });
  ok("a graduated token gets neither", !grad.findings.some((x) => /Sell (check|simulation)/.test(x.title)));
}

console.log("\nhow long each is kept");
{
  clearCache();
  const refuse = busyCurve(3_000n).io;
  await prefetchSims([{ token: TOKEN, curve: CURVE }], IN, {
    ...refuse, simulate: async () => [reverted, good(), good()],
  });
  const kept = await cached(`sim:${CURVE.toLowerCase()}`, 90_000, async () => "read again" as never) as { unknown?: boolean };
  ok("a check that could not run is kept", kept.unknown === true);
  ok(`…for ${SIM_UNKNOWN_TTL / 1000}s, not the 90s a result is kept`, SIM_UNKNOWN_TTL === 10_000);
}

console.log(failures === 0
  ? "\n\x1b[32mall sell-check checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
