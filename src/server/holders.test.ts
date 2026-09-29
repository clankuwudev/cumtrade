/**
 * A token's holders from the chain index (x25-batch2-token-page.md, X27a):
 * roles, buys and sells by the ledger's own rules, spot values, and the
 * route's answers. Made-up trades; the ledger's `buildFromIndex` is run on the
 * same rows to show both book the same trades. No chain.
 *
 *   npm run test:holders
 */
export {};

// Before anything imports client.ts: nothing here may reach a real node.
process.env.RPC_URL = "http://fake-node.invalid";
process.env.LOGS_RPC_URL = "http://fake-node.invalid";
process.env.LOGS_FALLBACK_URL = "";

type TradeRow = import("../core/lib/indexStore.js").TradeRow;
type ReceiptRow = import("../core/lib/indexStore.js").ReceiptRow;
type HolderRow = import("../core/lib/indexStore.js").HolderRow;
type TokenReading = import("../core/record/tape.js").TokenReading;
const { holderSet, withSpot } = await import("../core/record/holders.js");
const { holdersRoute } = await import("./routes/holders.js");
const { buildFromIndex } = await import("../core/positions/ledger.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const near = (a: number | null, b: number, eps = 1e-12) => a !== null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

const E = 10n ** 18n;
const addr = (tag: string) => `0x${tag.padStart(40, "0")}`;
const TOKEN = addr("70a1"), CURVE = addr("c0e1"), POOL = addr("9001");
const CREATOR = addr("c4ea"), BUNDLER = addr("b1"), ROUTER_SELLER = addr("5e11"), ROUTER = addr("7007");
const ROUTED_BUYER = addr("7b"), UNRECEIPTED_ROUTED = addr("7c"), DIRECT_NO_RECEIPT = addr("d1"), STRANGER = addr("5a");
const GIFTEE = addr("61f7"), RECEIVED = addr("4ec");
const LAUNCH = 1_000n;
const T0 = Date.UTC(2026, 8, 23, 12);
const at = (b: bigint) => T0 + Number(b - LAUNCH) * 100;

const trades: TradeRow[] = [];
const receipts = new Map<string, ReceiptRow>();
let seq = 0;
/** A curve trade; `sender` signs it (its receipt), or `null` for one whose receipt is not in yet. */
function trade(block: bigint, kind: "buy" | "sell", ethWei: bigint, tokens: bigint, o: {
  caller: string; recipient: string; sender: string | null; movers?: string[];
}) {
  const tx = `0x${(++seq).toString(16).padStart(64, "0")}`;
  trades.push({
    tx, logIndex: 0, block, curve: CURVE, token: TOKEN, kind, caller: o.caller, recipient: o.recipient,
    amountIn: kind === "buy" ? ethWei : tokens, amountOut: kind === "buy" ? tokens : ethWei,
    fee: ethWei / 100n, snipeTax: 0n, movers: o.movers ?? (kind === "sell" ? [o.caller] : []),
  });
  if (o.sender) receipts.set(tx, { tx, sender: o.sender, gas: 10n ** 13n, block, time: BigInt(Math.floor(at(block) / 1000)) });
}
const direct = (who: string) => ({ caller: who, recipient: who, sender: who });

trade(LAUNCH, "buy", 1n * E / 10n, 50_000_000n * E, direct(CREATOR));
trade(LAUNCH, "buy", 5n * E / 100n, 20_000_000n * E, direct(BUNDLER));
trade(1_100n, "buy", 2n * E / 100n, 8_000_000n * E, direct(ROUTER_SELLER));
trade(1_150n, "sell", 1n * E / 100n, 2_000_000n * E, direct(BUNDLER));
// The router sells for ROUTER_SELLER: the router calls, the ETH goes to it, it moved the tokens and signed.
trade(1_200n, "sell", 5n * E / 1000n, 3_000_000n * E, { caller: ROUTER, recipient: ROUTER_SELLER, sender: ROUTER_SELLER, movers: [ROUTER_SELLER] });
// A stranger buys and sends the tokens to GIFTEE: not GIFTEE's buy.
trade(1_300n, "buy", 1n * E / 100n, 3_000_000n * E, { caller: STRANGER, recipient: GIFTEE, sender: STRANGER });
// Routed buys: one with its receipt (ROUTED_BUYER signed), one without yet.
trade(1_400n, "buy", 3n * E / 100n, 9_000_000n * E, { caller: ROUTER, recipient: ROUTED_BUYER, sender: ROUTED_BUYER });
trade(1_500n, "buy", 1n * E / 100n, 2_500_000n * E, { caller: ROUTER, recipient: UNRECEIPTED_ROUTED, sender: null });
// A direct buy whose receipt is not in yet: its caller is the buyer, so it counts.
trade(1_550n, "buy", 2n * E / 100n, 4_000_000n * E, { caller: DIRECT_NO_RECEIPT, recipient: DIRECT_NO_RECEIPT, sender: null });

const hold = (a: string, tokens: bigint, first: bigint): HolderRow => ({ address: a, balance: tokens * E, firstBlock: first, firstIn: tokens * E });
const holders: HolderRow[] = [
  hold(CREATOR, 50_000_000n, LAUNCH),
  hold(BUNDLER, 18_000_000n, LAUNCH),
  hold(ROUTER_SELLER, 5_000_000n, 1_100n),
  hold(GIFTEE, 3_000_000n, 1_300n),
  hold(ROUTED_BUYER, 9_000_000n, 1_400n),
  hold(UNRECEIPTED_ROUTED, 2_500_000n, 1_500n),
  hold(DIRECT_NO_RECEIPT, 4_000_000n, 1_550n),
  hold(RECEIVED, 1_000_000n, 1_600n),
];
for (let i = 0; i < 6; i++) holders.push(hold(addr(`dd${i}`), 100_000n - BigInt(i), 1_700n));
const SUPPLY = 1_000_000_000n * E;

const reading = (o: { graduated?: boolean; toBlock?: bigint } = {}): TokenReading => ({
  toBlock: o.toBlock ?? 2_000n, trades, receipts, graduatedBlock: o.graduated ? 1_800n : null,
  launch: { curve: CURVE, creator: CREATOR, block: LAUNCH, syncedTo: o.toBlock ?? 2_000n },
  anchors: [],
});
const now = T0 + 3_600_000;
const set = holderSet({ token: TOKEN, reading: reading(), holders, supply: SUPPLY, poolManager: POOL, limit: 100, now });
const row = (a: string) => set.rows.find((r) => r.address === a)!;

console.log("\nroles, from chain facts");
{
  ok("the creator, who bought in the launch block, is both", JSON.stringify(row(CREATOR).roles) === '["creator","launch-block"]',
    JSON.stringify(row(CREATOR).roles));
  ok("a launch-block buyer", JSON.stringify(row(BUNDLER).roles) === '["launch-block"]');
  ok("a holder whose tokens a stranger bought for it: received, with no ETH in",
    JSON.stringify(row(GIFTEE).roles) === '["received"]' && row(GIFTEE).ethIn === 0);
  ok("a holder with no trade at all: received", JSON.stringify(row(RECEIVED).roles) === '["received"]' && row(RECEIVED).ethIn === 0);
  ok("an ordinary buyer has no role", row(ROUTED_BUYER).roles.length === 0);
}

console.log("\nbuys and sells, by the ledger's rules");
{
  ok("a direct buy: its ETH in, fee included", near(row(CREATOR).ethIn, 0.1) && row(CREATOR).ethOut === 0);
  ok("a direct sell: its ETH out", near(row(BUNDLER).ethIn, 0.05) && near(row(BUNDLER).ethOut, 0.01));
  ok("a router sell counts for who moved the tokens", near(row(ROUTER_SELLER).ethOut, 0.005) && near(row(ROUTER_SELLER).ethIn, 0.02));
  ok("…and not for the router, which holds nothing", !set.rows.some((r) => r.address === ROUTER));
  ok("a router buy with its receipt counts for who signed", near(row(ROUTED_BUYER).ethIn, 0.03));
  ok("a router buy with no receipt yet does not count yet (the ledger's rule)",
    row(UNRECEIPTED_ROUTED).ethIn === 0 && row(UNRECEIPTED_ROUTED).roles.includes("received"));
  ok("a direct buy with no receipt yet counts: the buyer called the curve", near(row(DIRECT_NO_RECEIPT).ethIn, 0.02));
}

console.log("\nagainst /api/ledger's own build");
{
  const curves = async () => new Map([[CURVE.toLowerCase(), { token: TOKEN as `0x${string}`, symbol: "TKN" }]]);
  for (const who of [CREATOR, BUNDLER, ROUTER_SELLER, ROUTED_BUYER, GIFTEE]) {
    const mine = trades.filter((t) => t.caller === who || t.recipient === who);
    const txs = new Set(mine.map((t) => t.tx));
    const built = await buildFromIndex(who as `0x${string}`, {
      toBlock: 2_000n, trades: mine,
      inTx: new Map([...txs].map((tx) => [tx, trades.filter((t) => t.tx === tx)])),
      receipts: new Map([...receipts].filter(([tx]) => txs.has(tx))),
      balance: () => holders.find((h) => h.address === who)!.balance,
    }, { sources: { curves } as never });
    const sum = (k: "buy" | "sell") => Number(built.trades.filter((t) => t.kind === k)
      .reduce((s, t) => s + (k === "buy" ? t.amountIn : t.amountOut), 0n)) / 1e18;
    ok(`${who.slice(-4)}: ethIn and ethOut equal the ledger's buys and sells`,
      near(row(who).ethIn, sum("buy")) && near(row(who).ethOut, sum("sell")),
      `${row(who).ethIn}/${row(who).ethOut} vs ${sum("buy")}/${sum("sell")}`);
  }
}

console.log("\nshares and counts");
{
  const total = holders.reduce((s, h) => s + h.balance, 0n);
  ok("holders counts every one, not just the page", set.holders === holders.length
    && holderSet({ token: TOKEN, reading: reading(), holders, supply: SUPPLY, poolManager: POOL, limit: 3, now }).holders === holders.length);
  const top10 = [...holders].sort((a, b) => (b.balance > a.balance ? 1 : -1)).slice(0, 10).reduce((s, h) => s + h.balance, 0n);
  ok("top10Pct is the ten largest, % of the supply", near(set.top10Pct, Number(top10) / Number(SUPPLY) * 100), String(set.top10Pct));
  ok("pct and balance in whole tokens", near(row(CREATOR).pct, 5) && row(CREATOR).balance === 50_000_000);
  ok("largest first", set.rows.every((r, i) => i === 0 || r.balance <= set.rows[i - 1]!.balance) && total > 0n);
  ok("firstAt is the block's time", row(ROUTER_SELLER).firstAt === at(1_100n), `${row(ROUTER_SELLER).firstAt - T0}`);
}

console.log("\nspot values and P&L");
{
  const lines = withSpot(set.rows, 400_000_000); // 400M tokens per ETH
  const c = lines.find((r) => r.address === CREATOR)!;
  ok("nowEth is balance at spot", near(c.nowEth, 50_000_000 / 400_000_000));
  ok("pnlEth = ethOut + nowEth − ethIn", near(c.pnlEth, 0 + 0.125 - 0.1));
  const none = withSpot(set.rows, null);
  ok("no price: nowEth and pnlEth are null, the rest stands", none.every((r) => r.nowEth === null && r.pnlEth === null)
    && none.find((r) => r.address === CREATOR)!.ethIn !== null);

  // Graduated: the PoolManager holds the pool's side and is a row, with no P&L.
  const grad = holderSet({
    token: TOKEN, reading: reading({ graduated: true }), holders: [hold(POOL, 300_000_000n, 1_800n), ...holders],
    supply: SUPPLY, poolManager: POOL, limit: 100, now,
  });
  const p = withSpot(grad.rows, 380_000_000).find((r) => r.address === POOL)!;
  ok("the pool is tagged, first, and counted in holders and the top 10",
    grad.rows[0]!.address === POOL && JSON.stringify(p.roles) === '["pool"]' && grad.holders === holders.length + 1
      && grad.top10Pct > set.top10Pct);
  ok("…with no ETH in, out, value or P&L", p.ethIn === null && p.ethOut === null && p.nowEth === null && p.pnlEth === null);
  ok("before graduation the same address is not the pool", !holderSet({
    token: TOKEN, reading: reading(), holders: [hold(POOL, 1n, 1_800n)], supply: SUPPLY, poolManager: POOL, limit: 5, now,
  }).rows[0]!.roles.includes("pool"));
}

console.log("\nthe route");
{
  async function answer(route: { handle: (...a: never[]) => unknown }, path: string) {
    let body = "", status = 0;
    const res = { writeHead(s: number) { status = s; return res; }, end(b?: unknown) { body = String(b ?? ""); } };
    await (route.handle as (req: unknown, res: unknown, url: URL) => Promise<void>)(
      { method: "GET", headers: {} }, res, new URL(path, "http://localhost:8787"));
    return { status, body: JSON.parse(body) };
  }
  let spotAsked = 0;
  const route = holdersRoute({
    reading: () => reading(),
    holders: () => ({ holders, supply: SUPPLY, syncedTo: 2_000n }),
    spot: async () => { spotAsked++; return 400_000_000; },
    now: () => now,
  });
  const a = await answer(route, `/api/holders?token=${TOKEN}`);
  ok("200 with the documented top level", a.status === 200 && JSON.stringify(Object.keys(a.body).sort()) === JSON.stringify(
    ["asOfBlock", "graduatedAt", "holders", "pnl", "rows", "supply", "token", "top10Pct"]), Object.keys(a.body).join());
  ok("…each row with its fields", JSON.stringify(Object.keys(a.body.rows[0]).sort()) === JSON.stringify(
    ["address", "balance", "ethIn", "ethOut", "firstAt", "firstIn", "nowEth", "pct", "pnlEth", "roles"]), Object.keys(a.body.rows[0]).join());
  ok("…P&L said to be before gas", a.body.pnl === "before gas" && a.body.graduatedAt === null);
  ok("a limit is held to 1–100",
    (await answer(route, `/api/holders?token=${TOKEN}&limit=2`)).body.rows.length === 2
      && (await answer(route, `/api/holders?token=${TOKEN}&limit=0`)).body.rows.length === 1
      && (await answer(route, `/api/holders?token=${TOKEN}&limit=5000`)).body.rows.length === holders.length);
  ok("the spot price is asked per request", spotAsked === 4, String(spotAsked));
  for (const q of ["token=0x12", `token=${TOKEN}&limit=abc`, ""]) {
    ok(`400 for ?${q}`, (await answer(route, `/api/holders?${q}`)).status === 400);
  }
  const behind = holdersRoute({ reading: () => reading(), holders: () => null, spot: async () => 1, now: () => now });
  const noIndex = holdersRoute({ reading: () => null, holders: () => null, spot: async () => 1, now: () => now });
  for (const [name, r] of [["behind the cursor", behind], ["no index", noIndex]] as const) {
    const x = await answer(r, `/api/holders?token=${TOKEN}`);
    ok(`not indexed (${name}): 404 with indexed: false`, x.status === 404 && x.body.indexed === false);
  }
  const unpriced = holdersRoute({
    reading: () => reading(), holders: () => ({ holders, supply: SUPPLY, syncedTo: 2_000n }), spot: async () => null, now: () => now,
  });
  const u = await answer(unpriced, `/api/holders?token=${TOKEN}`);
  ok("a failed spot read: 200, with nulls where the value was", u.status === 200
    && u.body.rows.every((r: { nowEth: unknown; pnlEth: unknown }) => r.nowEth === null && r.pnlEth === null));
  const g = await answer(holdersRoute({
    reading: () => reading({ graduated: true }), holders: () => ({ holders, supply: SUPPLY, syncedTo: 2_000n }),
    spot: async () => 1, now: () => now,
  }), `/api/holders?token=${TOKEN}`);
  ok("a graduated token says when", g.body.graduatedAt === at(1_800n), String(g.body.graduatedAt));
}

console.log(failures === 0
  ? "\n\x1b[32mall holders checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
