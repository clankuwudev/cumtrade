/**
 * Prices, paperhands and fumbles — docs/specs/track-record.md, T2.
 *
 * Hermetic. The estimate is checked against Uniswap V4's own integer maths;
 * the scan runs against a fake node that holds made-up swaps and refuses wide
 * windows the way the public node does.
 *
 *   npm run test:record
 */
export {};
process.env.RPC_URL = "http://fake-node.invalid";
process.env.LOGS_RPC_URL = "http://fake-node.invalid";
process.env.LOGS_FALLBACK_URL = "";

const Q96 = 2n ** 96n;
const E = 10n ** 18n;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");

// ---------------------------------------------------------------------------
// the node: swaps in one pool, and a limit on how wide a window it answers
// ---------------------------------------------------------------------------

const POOL = `0x${"ab".repeat(32)}`;
type Swap = { block: number; sqrtX96: bigint; liquidity: bigint; fee: number };
const swaps: Swap[] = [];
const CURVE = "0x00000000000000000000000000000000000c0001";
const BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
/** Curve trades: [block, kind, amountIn, amountOut, fee]. */
const trades: [number, "buy" | "sell", bigint, bigint, bigint][] = [];
let widest = 1_000_000;
let requests = 0;

globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  type Req = { id: number; method: string; params: any[] };
  const body = JSON.parse(String(init?.body)) as Req | Req[];
  const one = (r: Req) => {
    if (r.method !== "eth_getLogs") return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    requests++;
    const q = r.params[0];
    const lo = Number(BigInt(q.fromBlock)), hi = Number(BigInt(q.toBlock));
    if (hi - lo + 1 > widest) {
      return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "Missing or invalid parameters." } };
    }
    if (Array.isArray(q.topics[0])) {
      const result = trades.filter(([b]) => q.address === CURVE && b >= lo && b <= hi).map(([b, kind, i, o, f]) => ({
        blockNumber: hex(b), topics: [kind === "buy" ? BUY : SELL],
        data: `0x${word(i)}${word(o)}${word(f)}${word(0n)}`,
      }));
      return { jsonrpc: "2.0", id: r.id, result };
    }
    const result = swaps.filter((s) => s.block >= lo && s.block <= hi && q.topics[1] === POOL).map((s) => ({
      blockNumber: hex(s.block),
      data: `0x${word(0n)}${word(0n)}${word(s.sqrtX96)}${word(s.liquidity)}${word(0n)}${word(BigInt(s.fee))}`,
    }));
    return { jsonrpc: "2.0", id: r.id, result };
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { sellEstimate, verdict, advance, newScan, advanceCurve, newCurveSeries } = await import("./prices.js");
const { BUCKET_BLOCKS } = await import("./candles.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

/**
 * Uniswap V4's own answer, in integers: the new sqrtP after adding `amountIn`
 * of currency1 (SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown), then
 * the currency0 that leaves (getAmount0Delta, rounded down).
 */
function v4Out(raw: bigint, sqrtX96: bigint, L: bigint, feePips: number): bigint {
  const inAfterFee = (raw * BigInt(1_000_000 - feePips)) / 1_000_000n;
  const next = sqrtX96 + (inAfterFee * Q96) / L;
  return ((L * Q96) * (next - sqrtX96)) / next / sqrtX96;
}

console.log("\nthe estimate against V4's integer maths");
{
  const sqrt = (tokensPerEth: number) => BigInt(Math.floor(Math.sqrt(tokensPerEth) * 2 ** 96));
  const cases: [string, bigint, bigint, bigint, number][] = [
    ["a small sale into a deep pool", 1000n * E, sqrt(3e5), 5n * 10n ** 22n, 2500],
    ["a sale that moves the price a lot", 400_000n * E, sqrt(1.4e7), 7n * 10n ** 22n, 3000],
    ["a big fee", 10_000n * E, sqrt(2e5), 10n ** 21n, 700_000],
    ["a thin pool", 1_000_000n * E, sqrt(1e6), 10n ** 19n, 10_000],
  ];
  for (const [name, raw, sq, L, fee] of cases) {
    const est = sellEstimate(raw, sq, L, fee);
    const exact = Number(v4Out(raw, sq, L, fee)) / 1e18;
    const err = Math.abs(est - exact) / exact;
    ok(name, err < 1e-9, `estimate ${est.toPrecision(8)} vs ${exact.toPrecision(8)} ETH, error ${err.toExponential(1)}`);
  }
  ok("nothing sold is worth nothing", sellEstimate(0n, sqrt(1e5), 10n ** 20n, 3000) === 0);
  ok("an empty pool is worth nothing", sellEstimate(E, sqrt(1e5), 0n, 3000) === 0);
  // A pool can never pay out more ETH than a sale at the starting price would.
  const spot = Number(1000n * E) / 1e18 / 3e5;
  ok("never more than the spot price pays", sellEstimate(1000n * E, sqrt(3e5), 10n ** 20n, 0) <= spot * (1 + 1e-12));
}

console.log("\nthe verdict");
{
  const v = (back: number, soldNow: number | null, best: number | null, sold = true) => verdict({ sold, back, soldNow, best });
  ok("worth far more now: paperhand", v(0.028, 1.3, 3.1) === "paperhand");
  ok("worth less now, but it ran after: fumble", v(0.1195, 0.0625, 0.39) === "fumble");
  ok("neither: good", v(0.0324, 0.009, null) === "good");
  ok("a wobble under 10% is not a mistake", v(0.05, 0.054, 0.0545) === "good");
  ok("nor under 0.0005 ETH on a tiny position", v(0.001, 0.0014, null) === "good");
  ok("nothing sold: holding", v(0, 0.2, null, false) === "holding");
  ok("no price at all: unpriced", v(0.05, null, null) === "unpriced");
}

console.log("\nthe best-exit scan");
{
  const sq = BigInt(Math.floor(Math.sqrt(1e6) * 2 ** 96));
  const L = 10n ** 22n;
  // The price of the token rises 4x at block 1,500,000, then falls back.
  swaps.push(
    { block: 120_000, sqrtX96: sq, liquidity: L, fee: 3000 },
    { block: 1_500_000, sqrtX96: sq / 2n, liquidity: L, fee: 3000 },
    { block: 2_900_000, sqrtX96: sq, liquidity: L, fee: 3000 },
  );
  const scan = newScan(POOL as `0x${string}`, 1000n * E, 100_000);
  widest = 600_000;
  const first = await advance(scan, 1_000_000, { maxCalls: 50 });
  ok("reaches the end it was given", first.complete && scan.scannedTo === 1_000_000);
  ok("narrowed the window when the node refused", requests > 1, `${requests} requests`);
  ok("saw the one swap in range", scan.swaps === 1);

  requests = 0;
  const second = await advance(scan, 3_000_000, { maxCalls: 50 });
  ok("resumes from its cursor", second.complete && scan.swaps === 3);
  ok("keeps the best exit, at the price peak", scan.best?.block === 1_500_000, JSON.stringify(scan.best));
  const expect = sellEstimate(1000n * E, sq / 2n, L, 3000);
  ok("valued at that swap's price and liquidity", Math.abs((scan.best?.eth ?? 0) - expect) < 1e-15);

  const short = newScan(POOL as `0x${string}`, 1000n * E, 100_000);
  widest = 1_000_000;
  const cut = await advance(short, 3_000_000, { maxCalls: 1, window: 1_000_000 });
  ok("stops at its budget, not done", !cut.complete && short.scannedTo === 1_099_999, String(short.scannedTo));

  const refused = newScan(POOL as `0x${string}`, 1000n * E, 100_000);
  widest = 0;
  const gaveUp = await advance(refused, 3_000_000, { maxCalls: 100 });
  ok("gives up on a node refusing every window, and says so", !gaveUp.complete && gaveUp.error !== null &&
    refused.scannedTo === 99_999, `${gaveUp.calls} calls: ${gaveUp.error}`);
}

console.log("\nwindows widen again after the node rejects one");
{
  // The node rejects one wide window, then answers everything: a scan of 20M
  // blocks must not crawl the rest in the narrowed size.
  let rejectOnce = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown, init?: { body?: unknown }) => {
    if (rejectOnce) {
      rejectOnce = false;
      const r = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "query timeout" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return real(u as never, init as never);
  }) as typeof fetch;
  widest = 10_000_000;
  requests = 0;
  const scan = newScan(POOL as `0x${string}`, 1000n * E, 5_000_000, 5_000_000);
  const res = await advance(scan, 25_000_000, { maxCalls: 200 });
  globalThis.fetch = real;
  // 2M windows over 20M blocks is 10; one rejection costs a few more while
  // the scan stays at half size, then it widens back.
  ok("one rejection costs a few windows, not hundreds", res.complete && requests <= 16, `${requests} windows`);
}

console.log("\na node that rejects every wide window");
{
  // Windows over 300k blocks always fail: the scan must settle below that,
  // not keep trying double and paying for a rejection each time.
  const real = globalThis.fetch;
  let rejected = 0;
  globalThis.fetch = (async (u: unknown, init?: { body?: unknown }) => {
    const r = JSON.parse(String(init?.body));
    const q = r.params?.[0];
    if (q && Number(BigInt(q.toBlock)) - Number(BigInt(q.fromBlock)) + 1 > 300_000) {
      rejected++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "query timeout" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return real(u as never, init as never);
  }) as typeof fetch;
  widest = 100_000_000;
  requests = 0;
  const scan = newScan(POOL as `0x${string}`, 1000n * E, 5_000_000, 5_000_000);
  const res = await advance(scan, 25_000_000, { maxCalls: 400 });
  globalThis.fetch = real;
  ok("finishes", res.complete, `${res.calls} calls`);
  ok("rejections stay a small share of the calls", rejected <= res.calls / 6, `${rejected} rejected of ${res.calls}`);
  ok("and the next refresh starts at a size that works", (scan.window ?? 0) <= 300_000 && (scan.window ?? 0) >= 100_000,
    String(scan.window));
}

console.log("\na best exit carried over from an older scan");
{
  widest = 10_000_000;
  const scan = newScan(POOL as `0x${string}`, 1000n * E, 1_000_000, 100_000);
  // What an older scan found at the peak, before scans kept prices.
  const eth = sellEstimate(1000n * E, BigInt(Math.floor(Math.sqrt(1e6) * 2 ** 96)) / 2n, 10n ** 22n, 3000);
  scan.best = { eth, block: 1_500_000, price: undefined as unknown as number };
  await advance(scan, 3_000_000, { maxCalls: 50 });
  ok("stays the best while the new scan passes it", scan.best?.block === 1_500_000 && Math.abs(scan.best.eth - eth) < 1e-15);
  ok("and gets its price when it does", scan.best !== null && Math.abs(scan.best.price - 4e-6) < 1e-15, String(scan.best?.price));
}

console.log("\nthe price series for the candles");
{
  widest = 1_000_000;
  // The same three swaps: a scan that starts at block 100,000 but whose sale
  // was at 2,000,000 buckets all three and measures only the last.
  const scan = newScan(POOL as `0x${string}`, 1000n * E, 2_000_000, 100_000);
  await advance(scan, 3_000_000, { maxCalls: 50 });
  ok("every swap from the start is bucketed", Object.keys(scan.buckets).length === 3, Object.keys(scan.buckets).join(","));
  ok("the best exit counts only swaps after the sell", scan.best?.block === 2_900_000, JSON.stringify(scan.best));
  ok("and carries the price there", scan.best !== null && Math.abs(scan.best.price - 1e-6) < 1e-15, String(scan.best?.price));
  const peak = scan.buckets[String(Math.floor(1_500_000 / BUCKET_BLOCKS))]!;
  ok("the peak bucket's price is 4x the others", Math.abs(peak[3] - 4e-6) < 1e-15, JSON.stringify(peak));

  // A launchpad curve: a buy at 0.000001 and a sell at 0.000002 ETH a token.
  trades.push([150_000, "buy", 101n * E / 100n, 1_000_000n * E, E / 100n]);
  trades.push([150_500, "sell", 1_000_000n * E, 198n * E / 100n, 2n * E / 100n]);
  const cs = newCurveSeries(CURVE, 100_000);
  const res = await advanceCurve(cs, 3_000_000, { maxCalls: 50 });
  const b = cs.buckets[String(Math.floor(150_000 / BUCKET_BLOCKS))]!;
  ok("a curve's buys and sells are read", res.complete && cs.trades === 2);
  ok("into the same buckets, open at the buy and close at the sell", Math.abs(b[0] - 1e-6) < 1e-15 &&
    Math.abs(b[3] - 2e-6) < 1e-15, JSON.stringify(b));
}

console.log(failures === 0
  ? "\n\x1b[32mall price checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
