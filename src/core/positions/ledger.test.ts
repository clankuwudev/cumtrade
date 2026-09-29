/**
 * Positions for any address, from the chain — public-release B3.2.
 *
 * Hermetic. Global fetch is a fake node (fixtures/node.ts) that answers with
 * chain data recorded from third-party addresses at pinned blocks
 * (scripts/record-ledger-fixture.mts):
 *
 *   ledger-direct   trades clank.trade curves directly: its own buy and sell
 *   ledger-routed   four buys (one through a router it called) and two
 *                   sells on clank.trade curves, two positions still open
 *   ledger-foreign  90 events naming it, every one from a curve of another
 *                   launchpad that emits the same events
 *
 * Cases the chain did not happen to have (a router sell, a relayer paying
 * gas, a stranger's buy, a planted fake curve, a balance gone or grown) are
 * made from the recorded bytes with addresses swapped or a balance
 * overridden, and each says so. In ledger-routed, one token and its curve are
 * made-up stand-ins (0x5a5a…), swapped in everywhere the recording had them.
 * No request leaves the process.
 *
 *   npm run test:ledger
 */
import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { fakeNode, type Fixture } from "./fixtures/node.js";

const here = (f: string) => new URL(f, import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(here(`./fixtures/${name}.json`), "utf8")) as Fixture;
const direct = load("ledger-direct");
const routed = load("ledger-routed");
const foreign = load("ledger-foreign");
// clank.trade's second factory, asked about the same curves (B1.5).
const second = load("ledger-second-factory");

const node = fakeNode([direct, routed, foreign, second]);
globalThis.fetch = node.fetch;

const { buildLedger, ledgerFor } = await import("./ledger.js");
const { migrate } = await import("./accounting.js");
const { BUY_TOPIC, SELL_TOPIC, TRANSFER_TOPIC } = await import("./attribution.js");
const { createHistoryRpc } = await import("../lib/historyRpc.js");
const { createLogGate, isRateLimited } = await import("../lib/logGate.js");
const { FACTORIES } = await import("../chain.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

type Log = Fixture["logs"][number];
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const word = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const receiptOf = (tx: string) => node.state.receipts.get(tx.toLowerCase())!;
const gasOf = (tx: string) => BigInt(receiptOf(tx).gasUsed) * BigInt(receiptOf(tx).effectiveGasPrice);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const DIRECT = direct.address as Address;
const ROUTED = routed.address as Address;
const AT_DIRECT = { toBlock: BigInt(direct.toBlock) };
const AT_ROUTED = { toBlock: BigInt(routed.toBlock) };
const isBuy = (l: Log) => same(l.topics[0], BUY_TOPIC);
const isSell = (l: Log) => same(l.topics[0], SELL_TOPIC);

// ---------------------------------------------------------------------------
console.log("\nthe ledger agrees with the backfill it replaced");
{
  // The B3.1 backfill's --print output for the same address at the same
  // block, captured live before ledgerFor existed: an independent pipeline
  // (viem receipts, three unchunked scans, sequential balance reads).
  const golden = here("./fixtures/ledger-routed.backfill.json");
  // A checkout may have turned its line endings into CRLF.
  const before = existsSync(golden) ? readFileSync(golden, "utf8").replace(/\r\n/g, "\n").trim() : "(not recorded)";
  const l = await ledgerFor(ROUTED, AT_ROUTED);
  const asBackfill = JSON.stringify(l.positions.map(({ confidence: _c, ...p }) => migrate(p)), null, 2);
  ok("ledgerFor, as the backfill prints it, is byte-identical to the backfill before it",
    asBackfill === before, `${l.positions.length} position(s), ${l.positions.filter((p) => !p.closed).length} open`);
  ok("no call went unanswered by the recording", node.state.unknown.length === 0, node.state.unknown.join("; "));
}

// ---------------------------------------------------------------------------
console.log("\ndirect trades, checked against the raw events");
{
  for (const f of [direct, routed]) {
    const owner = f.address as Address;
    const b = await buildLedger(owner, { toBlock: BigInt(f.toBlock) });
    const logs = f.logs;
    ok(`${f.note}: every event is the address's own trade`, b.events === logs.length && b.trades.length === logs.length,
      `${b.events} events, ${b.trades.length} trades`);
    ok(`${f.note}: every position is exact`, b.ledger.positions.length > 0 && b.ledger.positions.every((p) => p.confidence === "exact"),
      b.ledger.positions.map((p) => `${p.symbol}:${p.closed ? "closed" : "open"}:${p.confidence}`).join(" "));

    // Each position against the event words and receipts of its own curve,
    // summed here rather than taken from anything the ledger computed.
    const byTime = (a: Log, c: Log) => Number(BigInt(a.blockNumber) - BigInt(c.blockNumber))
      || Number(BigInt(a.logIndex) - BigInt(c.logIndex));
    // Summed per curve, since a curve can hold a closed position and a later
    // one: everything the curve's events say went in and came out must be in
    // that curve's positions, to the wei.
    const W = (p: { [k: string]: unknown }, k: string) => BigInt(p[k] as string);
    for (const curve of new Set(b.ledger.positions.map((p) => p.curve.toLowerCase()))) {
      const ps = b.ledger.positions.filter((p) => same(p.curve, curve));
      const mine = logs.filter((l) => same(l.address, curve)).sort(byTime);
      const buys = mine.filter(isBuy), sells = mine.filter(isSell);
      const sum = (ls: Log[], i: number) => ls.reduce((a, l) => a + word(l.data, i), 0n);
      const all = (k: string) => ps.reduce((a, p) => a + W(p, k), 0n);
      const txs = [...new Set(mine.map((l) => l.transactionHash.toLowerCase()))];
      const good = all("costEth") + all("realizedCostWei") === sum(buys, 0)
        && all("realizedWei") === sum(sells, 1)
        && all("exitFeeWei") === sum(sells, 2)
        && all("entryFeeWei") + all("realizedEntryFeeWei") + all("snipeTaxWei") === sum(buys, 2) + sum(buys, 3)
        && all("soldTokens") === sum(sells, 0)
        && all("tokens") === sum(buys, 1) - sum(sells, 0)
        && all("gasWei") === txs.reduce((a, tx) => a + gasOf(tx), 0n)
        && same(ps[0]!.openTx, buys[0]!.transactionHash)
        && ps.filter((p) => p.closed).every((p) => sells.some((s) => same(p.closed!.tx, s.transactionHash)));
      ok(`${f.note} $${ps[0]!.symbol} (${ps.length} position, ${buys.length} buy, ${sells.length} sell): ` +
        `cost, size, proceeds, fees and gas`, good);
    }
    const first = logs.filter(isBuy).sort(byTime)[0]!;
    const t0 = BigInt(f.blocks[BigInt(first.blockNumber).toString()]!) * 1000n;
    ok(`${f.note}: times are the blocks'`, b.ledger.positions.some((p) => BigInt(p.openedAt) === t0 && same(p.openTx, first.transactionHash)));
  }
}

// ---------------------------------------------------------------------------
console.log("\nevents from another launchpad's curves");
{
  // Recorded: every curve this address traded answers the zero address from
  // the factory's tokenForCurve. The backfill before B3.2 booked them all
  // under token 0x000…000, merged into one another.
  const b = await buildLedger(foreign.address as Address, { toBlock: BigInt(foreign.toBlock) });
  ok("are dropped: no receipt fetched, nothing booked",
    b.foreign === foreign.logs.length && b.events === 0 && b.ledger.positions.length === 0,
    `foreign ${b.foreign} of ${foreign.logs.length}`);
}

// ---------------------------------------------------------------------------
console.log("\na router trade is the user's, not the router's");
{
  // Recorded: a buy whose curve call came from a router the address itself
  // called. topic1 is the router, the transaction is the address's.
  const viaRouter = routed.logs.find((l) => isBuy(l) && !same(l.topics[1], pad(ROUTED)))!;
  const b = await buildLedger(ROUTED, AT_ROUTED);
  ok("recorded: the routed buy is booked", b.trades.some((t) => same(t.tx, viaRouter.transactionHash)));
  const router = `0x${viaRouter.topics[1]!.slice(26)}` as Address;
  ok("recorded: the router gets no position from it", (await ledgerFor(router, AT_ROUTED)).positions.length === 0);
}

// Cases built from the direct recording's bytes, with addresses swapped.
const USER = "0x000000000000000000000000000000000000beef" as Address;
const ROUTER = "0x000000000000000000000000000000000000c0de" as Address;
const RELAYER = "0x000000000000000000000000000000000000f00d" as Address;
const STRANGER = "0x0000000000000000000000000000000000005a5a" as Address;
const HOLDER = "0x000000000000000000000000000000000000abcd" as Address;

/** The direct recording's first curve with exactly one buy and one sell. */
const pair = (() => {
  for (const buy of direct.logs.filter(isBuy)) {
    const onCurve = direct.logs.filter((l) => same(l.address, buy.address));
    if (onCurve.length === 2 && onCurve.filter(isSell).length === 1) return { buy, sell: onCurve.find(isSell)! };
  }
  throw new Error("the direct recording has no single round trip");
})();

let n = 0;
/**
 * Plant a copy of a recorded trade under a new hash: the curve event with its
 * caller and recipient replaced, and a receipt from `from` holding the copied
 * event and, for a sell, the token's Transfer out of `seller`.
 */
function plant(log: Log, o: { caller: Address; recipient: Address; from: Address; seller?: Address; curve?: string }) {
  const tx = `0x${"fe".repeat(28)}${(++n).toString(16).padStart(8, "0")}` as Hex;
  const ev = { ...log, address: (o.curve ?? log.address) as Address, transactionHash: tx,
    topics: [log.topics[0]!, pad(o.caller), pad(o.recipient)] };
  const orig = receiptOf(log.transactionHash);
  const logs = [ev];
  if (o.seller) {
    const t = orig.logs.find((l) => same(l.topics[0], TRANSFER_TOPIC) && same(l.topics[1], pad(DIRECT)))!;
    logs.push({ ...t, transactionHash: tx, topics: [t.topics[0]!, pad(o.seller), t.topics[2]!] });
  }
  node.state.logs.set(`${tx}:${log.logIndex}`, ev);
  node.state.receipts.set(tx, { ...orig, transactionHash: tx, from: o.from, logs });
  return tx;
}

{
  // The user sent both transactions; the router called the curve and passed
  // the tokens and the proceeds on. The sell moved the user's own tokens.
  plant(pair.buy, { caller: ROUTER, recipient: USER, from: USER });
  plant(pair.sell, { caller: ROUTER, recipient: USER, from: USER, seller: USER });
  const user = await ledgerFor(USER, AT_DIRECT);
  const router = await ledgerFor(ROUTER, AT_DIRECT);
  const p = user.positions[0];
  ok("a router buy and sell: the user has one closed, exact position",
    user.positions.length === 1 && !!p?.closed && p.confidence === "exact", user.positions.map((q) => q.confidence).join(","));
  ok("…with the recorded trade's cost and proceeds",
    !!p && BigInt(p.realizedCostWei) === word(pair.buy.data, 0) && BigInt(p.realizedWei) === word(pair.sell.data, 1));
  ok("…and the gas of both transactions it sent",
    !!p && BigInt(p.gasWei) === gasOf(pair.buy.transactionHash) + gasOf(pair.sell.transactionHash));
  ok("the router, which called the curve both times, has no position", router.positions.length === 0,
    `${router.positions.length}`);
}

console.log("\na stranger's buy delivered to an address is not its buy");
{
  plant(pair.buy, { caller: STRANGER, recipient: HOLDER, from: STRANGER });
  const b = await buildLedger(HOLDER, AT_DIRECT);
  ok("the event is seen and not booked", b.events === 1 && b.trades.length === 0 && b.ledger.positions.length === 0,
    `events ${b.events}, trades ${b.trades.length}`);
}

console.log("\ngas is booked only for what the address sent");
{
  // A relayer sends the router sell, so the gas is the relayer's.
  const OWNER2 = "0x000000000000000000000000000000000000b0b0" as Address;
  plant(pair.buy, { caller: OWNER2, recipient: OWNER2, from: OWNER2 });
  plant(pair.sell, { caller: ROUTER, recipient: OWNER2, from: RELAYER, seller: OWNER2 });
  const p = (await ledgerFor(OWNER2, AT_DIRECT)).positions[0];
  ok("the relayed sell closes the position", !!p?.closed && p.confidence === "exact");
  ok("…and only the buy's gas is booked", !!p && BigInt(p.gasWei) === gasOf(pair.buy.transactionHash),
    p ? `${p.gasWei} vs buy ${gasOf(pair.buy.transactionHash)}` : "no position");
}

{
  // Two buys in one transaction (a router can batch them): gas once.
  const OWNER3 = "0x000000000000000000000000000000000000b0b3" as Address;
  const tx = plant(pair.buy, { caller: OWNER3, recipient: OWNER3, from: OWNER3 });
  const second = { ...node.state.logs.get(`${tx}:${pair.buy.logIndex}`)!, logIndex: "0x7f" as Hex };
  node.state.logs.set(`${tx}:0x7f`, second);
  node.state.receipts.get(tx)!.logs.push(second);
  const token = (await ledgerFor(DIRECT, AT_DIRECT)).positions.find((q) => same(q.curve, pair.buy.address))!.token;
  node.state.balances.set(`${token}|${OWNER3}`.toLowerCase(), 2n * word(pair.buy.data, 1));
  const p = (await ledgerFor(OWNER3, AT_DIRECT)).positions[0];
  ok("two trades in one transaction book its gas once",
    !!p && BigInt(p.costEth) === 2n * word(pair.buy.data, 0) && BigInt(p.gasWei) === gasOf(tx),
    p ? `cost ${p.costEth}, gas ${p.gasWei}` : "no position");
}

console.log("\na contract the factory does not know is not a curve");
{
  // Anyone can emit an event shaped like a curve's Buy, naming anyone as both
  // caller and buyer. The factory answers the zero address for anything it
  // did not launch (checked live).
  const FAKE = "0x00000000000000000000000000000000000fa4e0";
  const VICTIM = "0x000000000000000000000000000000000000d00d" as Address;
  // Every listed factory is asked, and none of them launched it.
  for (const f of FACTORIES) {
    node.state.calls.set(`${f.address}|0x4c1c1c6e${pad(FAKE).slice(2)}`.toLowerCase(),
      { success: true, returnData: pad("0x0") });
  }
  plant(pair.buy, { caller: VICTIM, recipient: VICTIM, from: VICTIM, curve: FAKE });
  const b = await buildLedger(VICTIM, AT_DIRECT);
  ok("its events are dropped, and nothing is booked", b.foreign === 1 && b.events === 0 && b.ledger.positions.length === 0,
    `foreign ${b.foreign}, events ${b.events}`);
}

// ---------------------------------------------------------------------------
console.log("\nreconciling against the balance");
{
  node.reset();
  const base = await ledgerFor(ROUTED, AT_ROUTED);
  ok("balances are read at the lookup's block, not at latest",
    node.state.callBlocks.length > 0 && node.state.callBlocks.every((b) => b === `0x${AT_ROUTED.toBlock.toString(16)}`),
    node.state.callBlocks.join(","));
  const open = base.positions.find((p) => !p.closed);
  ok("the routed recording has an open position, exact at its recorded balance",
    !!open && open.confidence === "exact", open ? `$${open.symbol}` : "none");
  if (open) {
    const key = `${open.token}|${ROUTED}`.toLowerCase();
    const find = (l: Awaited<ReturnType<typeof ledgerFor>>) =>
      l.positions.find((p) => same(p.openTx, open.openTx) && same(p.token, open.token))!;

    node.state.balances.set(key, 0n);
    const gone = find(await ledgerFor(ROUTED, AT_ROUTED));
    ok("a balance of 0 with no sell closes it as proceeds-unknown",
      !!gone.closed && gone.confidence === "proceeds-unknown" && /proceeds unknown/.test(gone.closed.reason));
    ok("…with no proceeds invented", gone.realizedWei === open.realizedWei && gone.closed!.tx === null);

    const more = BigInt(open.tokens) + 5n * 10n ** 18n;
    node.state.balances.set(key, more);
    const grown = find(await ledgerFor(ROUTED, AT_ROUTED));
    ok("a balance above the replay leaves it open as size-adjusted, at the chain's size",
      !grown.closed && grown.confidence === "size-adjusted" && BigInt(grown.tokens) === more);
    ok("…and the basis is still the replay's", grown.costEth === open.costEth);
    node.state.balances.delete(key);

    const others = base.positions.filter((p) => p !== open);
    const again = await ledgerFor(ROUTED, AT_ROUTED);
    ok("the other positions were untouched throughout",
      JSON.stringify(others, big) === JSON.stringify(again.positions.filter((p) => !(same(p.openTx, open.openTx) && same(p.token, open.token))), big));
  }
}

// ---------------------------------------------------------------------------
console.log("\ntwo lookups at once");
{
  const alone = JSON.stringify(await ledgerFor(DIRECT, AT_DIRECT), big) + JSON.stringify(await ledgerFor(ROUTED, AT_ROUTED), big);
  const [a, b] = await Promise.all([ledgerFor(DIRECT, AT_DIRECT), ledgerFor(ROUTED, AT_ROUTED)]);
  ok("concurrently, each address gets what it gets alone", alone === JSON.stringify(a, big) + JSON.stringify(b, big));
}

// ---------------------------------------------------------------------------
console.log("\nthe public node's limits");
{
  const gate = createLogGate();
  const history = createHistoryRpc({ url: "http://fake", gate });
  const whole = await ledgerFor(ROUTED, AT_ROUTED);

  node.state.maxLogSpan = 1_500_000n;
  const narrow = await ledgerFor(ROUTED, { ...AT_ROUTED, sources: { history } });
  node.state.maxLogSpan = Infinity;
  ok("a range the node calls too wide is halved, and the ledger is the same",
    history.stats().halved > 0 && JSON.stringify(narrow.positions) === JSON.stringify(whole.positions),
    `halved ${history.stats().halved}`);
  ok("…and the next scan starts at the width that worked",
    history.logSpan() !== undefined && history.logSpan()! <= 1_500_000n, String(history.logSpan()));

  node.reset();
  const small = createHistoryRpc({ url: "http://fake", gate: createLogGate(), batchSize: 4 });
  await ledgerFor(ROUTED, { ...AT_ROUTED, sources: { history: small } });
  const receipts = node.count("eth_getTransactionReceipt");
  ok("receipts go in batches of the batch size",
    receipts === routed.logs.length && small.stats().requests === 2 + Math.ceil(receipts / 4) + Math.ceil(receipts / 4),
    `${receipts} receipts; ${small.stats().requests} requests: 2 scans, then receipts and blocks by 4`);

  node.state.refuse = true;
  let refused: unknown = null;
  try { await ledgerFor(ROUTED, { ...AT_ROUTED, sources: { history } }); } catch (e) { refused = e; }
  node.state.refuse = false;
  ok("a 429 fails the lookup as rate-limited", refused !== null && isRateLimited(refused));
  const before = node.state.requests;
  const next = await ledgerFor(ROUTED, { ...AT_ROUTED, sources: { history } }).then(() => null, (e) => e);
  ok("…and closes the gate, so the next lookup sends nothing to the node",
    !gate.state().open && isRateLimited(next) && node.state.requests === before);
}

ok("the fake node was asked for nothing it was not given", node.state.unknown.length === 0, node.state.unknown.join("; "));

console.log("\nwhat the node cannot answer fails the lookup");
{
  // A receipt the node does not have would drop a router trade or its gas
  // without a word, so it is an error, not a gap.
  const tx = routed.logs[0]!.transactionHash.toLowerCase();
  const kept = node.state.receipts.get(tx)!;
  node.state.receipts.delete(tx);
  const e = await ledgerFor(ROUTED, AT_ROUTED).then(() => null, (x: Error) => x);
  node.state.receipts.set(tx, kept);
  ok("a missing receipt", !!e && /no receipt/.test(e.message), e?.message ?? "resolved");
}

console.log(failures === 0
  ? "\n\x1b[32mall ledger checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
