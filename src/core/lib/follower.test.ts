/**
 * The chain follower and its store — spec D1.1 and D1.2.
 *
 * Hermetic: fake log endpoints in this process, which answer eth_blockNumber
 * and eth_getLogs over a made-up chain of launches and their Transfers,
 * refuse wide windows the way Alchemy does, and refuse for volume on demand.
 * The store is a real SQLite file in a temporary directory. No chain.
 *
 *   npm run test:index
 */
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything imports client.ts: nothing here may reach a real node.
process.env.RPC_URL = "http://fake-node.invalid";
process.env.LOGS_RPC_URL = "http://fake-node.invalid";
process.env.LOGS_FALLBACK_URL = "";

const { openIndexStore } = await import("./indexStore.js");
const { createFollower, TRANSFER_TOPIC, INITIALIZE_TOPIC } = await import("./follower.js");
const { createLogGate, createLogRoute } = await import("./logGate.js");
const launchIndex = await import("./launchIndex.js");
const { FACTORIES, VENUE } = await import("../chain.js");
const { BUY_TOPIC, SELL_TOPIC } = await import("../positions/attribution.js");
const { buildFromIndex } = await import("../positions/ledger.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "clank-index-"));
const FLOOR = 1_000n;
const VENUE_KEY = "test:clank";
const ZERO = "0x0000000000000000000000000000000000000000";
const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const hex = (n: bigint) => `0x${n.toString(16)}`;
const addr = (tag: string, n: bigint) => `0x${tag}${n.toString(16).padStart(40 - tag.length, "0")}`;

// ------------------------------------------------------------ fake chain --
type Log = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string };
const chain: Log[] = [];
const SUPPLY = 10n ** 27n;
const tokenAt = (b: bigint) => addr("a", b);
const curveAt = (b: bigint) => addr("b", b);
const creator = addr("c", 1n);

/** A transaction per block, unless `tx` names another. */
function transfer(token: string, from: string, to: string, value: bigint, block: bigint, tx?: string) {
  chain.push({
    address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: word(value.toString(16)),
    blockNumber: hex(block), logIndex: hex(BigInt(chain.length)), transactionHash: tx ?? word(block.toString(16)),
  });
}

/** A curve's Buy or Sell: caller, recipient, then amount in, amount out, fee and snipe tax. */
function trade(kind: "buy" | "sell", curve: string, caller: string, recipient: string, amountIn: bigint, amountOut: bigint, block: bigint, tx?: string) {
  chain.push({
    address: curve, topics: [kind === "buy" ? BUY_TOPIC : SELL_TOPIC, word(caller), word(recipient)],
    data: `0x${[amountIn, amountOut, amountIn / 100n, 0n].map((v) => word(v.toString(16)).slice(2)).join("")}`,
    blockNumber: hex(block), logIndex: hex(BigInt(chain.length)), transactionHash: tx ?? word(block.toString(16)),
  });
}

/** Who sent each transaction, for receipts: the block's own, unless set here. */
const senders = new Map<string, string>();
const ROUTER = addr("7", 1n), STRANGER = addr("8", 1n);

/**
 * A launch at `b`: the Launch event, the supply minted to the curve, the
 * creator's dev buy and a bundled buyer in the launch block, then a few
 * buys, a holder-to-holder transfer and a burn over the next 3,000 blocks.
 */
function launch(b: bigint) {
  const token = tokenAt(b), curve = curveAt(b);
  chain.push({
    address: FACTORIES[0]!.address,
    topics: [VENUE.launchTopic, word(token), word(curve), word(creator)],
    data: `0x${"0".repeat(128)}${(10n ** 18n).toString(16).padStart(64, "0")}`,
    blockNumber: hex(b), logIndex: hex(BigInt(chain.length)), transactionHash: word(b.toString(16)),
  });
  transfer(token, ZERO, curve, SUPPLY, b);
  transfer(token, curve, creator, 5n * 10n ** 24n, b);
  transfer(token, curve, addr("d", b), 3n * 10n ** 24n, b);
  for (let i = 1n; i <= 6n; i++) transfer(token, curve, addr("e", b + i), i * 10n ** 23n, b + i * 400n);
  transfer(token, addr("e", b + 1n), addr("f", b), 10n ** 22n, b + 2_500n);
  transfer(token, creator, ZERO, 10n ** 24n, b + 2_700n);
  // The creator's dev buy in the launch block, sent by the creator.
  trade("buy", curve, creator, creator, 10n ** 18n, 5n * 10n ** 24n, b);
  senders.set(word(b.toString(16)), creator);
  // The first buyer after it, direct.
  trade("buy", curve, addr("e", b + 1n), addr("e", b + 1n), 10n ** 17n, 10n ** 23n, b + 400n);
  senders.set(word((b + 400n).toString(16)), addr("e", b + 1n));
  // A router sell: the router calls the curve, the ETH goes to the seller,
  // and the seller's tokens move out in the same transaction.
  const sellTx = word(`5e11${b.toString(16)}`);
  transfer(token, addr("e", b + 1n), ROUTER, 10n ** 22n, b + 2_600n, sellTx);
  transfer(token, ROUTER, curve, 10n ** 22n, b + 2_600n, sellTx);
  trade("sell", curve, ROUTER, addr("e", b + 1n), 10n ** 22n, 10n ** 15n, b + 2_600n, sellTx);
  senders.set(sellTx, addr("e", b + 1n));
  // A stranger buying for the same wallet, paid by the stranger: not its trade.
  const giftTx = word(`91f7${b.toString(16)}`);
  transfer(token, curve, addr("e", b + 1n), 10n ** 20n, b + 2_650n, giftTx);
  trade("buy", curve, STRANGER, addr("e", b + 1n), 10n ** 16n, 10n ** 20n, b + 2_650n, giftTx);
  senders.set(giftTx, STRANGER);
}

const MANAGER = addr("5", 1n);
const POOL_CREATED = `0x${"0a44".padEnd(64, "e")}`;
const HOOK = addr("4", 1n), OTHER_HOOK = addr("4", 2n);

/**
 * A graduation's pool, made at `b`: the factory's pool-created event and the
 * PoolManager's Initialize with the factory's hook, and in the same block an
 * impostor's Initialize for the same token with another hook.
 */
function graduate(token: string, b: bigint) {
  const base = { blockNumber: hex(b), transactionHash: word(b.toString(16)) };
  chain.push({ ...base, address: FACTORIES[0]!.address, topics: [POOL_CREATED, word(token)], data: `0x${"0".repeat(192)}`, logIndex: hex(BigInt(chain.length)) });
  for (const [id, hook, fee] of [[`0x${"1d".repeat(32)}`, HOOK, 3000n], [`0x${"2d".repeat(32)}`, OTHER_HOOK, 100n]] as const) {
    chain.push({
      ...base, address: MANAGER, logIndex: hex(BigInt(chain.length)),
      topics: [INITIALIZE_TOPIC, id.slice(0, 60) + token.slice(-4), word(ZERO), word(token)],
      data: `0x${word(fee.toString(16)).slice(2)}${word("c8").slice(2)}${word(hook).slice(2)}${"0".repeat(128)}`,
    });
  }
}

/** Balances and supply by a plain replay of the fake chain, up to `to`. */
function replay(token: string, to: bigint) {
  const bal = new Map<string, bigint>();
  let supply = 0n;
  for (const l of chain) {
    if (l.address !== token || l.topics[0] !== TRANSFER_TOPIC || BigInt(l.blockNumber) > to) continue;
    const from = `0x${l.topics[1]!.slice(26)}`, dest = `0x${l.topics[2]!.slice(26)}`, v = BigInt(l.data);
    if (from === ZERO) supply += v; else bal.set(from, (bal.get(from) ?? 0n) - v);
    if (dest === ZERO) supply -= v; else bal.set(dest, (bal.get(dest) ?? 0n) + v);
  }
  return { bal, supply };
}

const launchBlocks: bigint[] = [];
for (let b = FLOOR + 10n; b < FLOOR + 40_000n; b += 1_300n) {
  launchBlocks.push(b);
  launch(b);
}
// One token graduated long ago, before any index watched.
graduate(tokenAt(launchBlocks[1]!), launchBlocks[1]! + 3_000n);

type Call = { endpoint: string; method: string; from?: bigint; to?: bigint; addresses?: number };
const calls: Call[] = [];
let HEAD = FLOOR + 50_000n;

/** A fake endpoint. `maxLogs`: more than this in one window is refused as too wide (Alchemy's words). */
function endpoint(name: string, o: { maxLogs?: number; refuse?: () => boolean } = {}) {
  return {
    name, url: name, gate: createLogGate(),
    async request(a: { method: string; params?: unknown }) {
      if (o.refuse?.()) {
        calls.push({ endpoint: name, method: a.method });
        throw Object.assign(new Error("Too Many Requests"), { code: 429 });
      }
      if (a.method === "eth_getTransactionReceipt") {
        calls.push({ endpoint: name, method: a.method });
        const tx = (a.params as string[])[0]!;
        const l = chain.find((x) => x.transactionHash === tx);
        return l ? { from: senders.get(tx) ?? creator, gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", blockNumber: l.blockNumber } : null;
      }
      if (a.method === "eth_getBlockByNumber") {
        calls.push({ endpoint: name, method: a.method });
        return { timestamp: hex(1_700_000_000n + BigInt((a.params as string[])[0]!)) };
      }
      if (a.method === "eth_blockNumber") {
        calls.push({ endpoint: name, method: a.method });
        return hex(HEAD);
      }
      if (a.method === "eth_getLogs") {
        const f = (a.params as { fromBlock: string; toBlock: string; address: string[]; topics: (string | string[])[] }[])[0]!;
        const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
        calls.push({ endpoint: name, method: a.method, from, to, addresses: f.address.length });
        const wanted = new Set(f.address.map((x) => x.toLowerCase()));
        // Each topic position: null matches anything, a list any of its entries.
        const match = (l: Log) => f.topics.every((t, i) => t === null || [t].flat().includes(l.topics[i]!));
        const logs = chain.filter((l) => {
          const b = BigInt(l.blockNumber);
          return b >= from && b <= to && wanted.has(l.address.toLowerCase()) && match(l);
        });
        if (o.maxLogs !== undefined && logs.length > o.maxLogs) {
          throw Object.assign(new Error("InvalidParamsRpcError"), {
            details: "Log response size exceeded. You can make eth_getLogs requests with up to a 5,000 block range",
          });
        }
        return logs;
      }
      throw new Error(`not here: ${a.method}`);
    },
  };
}

const launchesIn = (to: bigint) => launchBlocks.filter((b) => b >= FLOOR && b <= to).length;

// ------------------------------------------------------------------ store --
console.log("\nthe store");
{
  const s = openIndexStore(join(dir, "a.sqlite"), { venue: VENUE_KEY, log: () => {} });
  ok("a new file has no cursor and no launches", s.cursor("main") === null && s.stats().launches === 0);
  const row = { token: "0xAA", curve: "0xBB", creator: "0xCC", factory: "0xDD", block: 5n, logIndex: 1, threshold: 7n };
  const first = s.commit({ cursor: "main", block: 10n, launches: [row] });
  const again = s.commit({ cursor: "main", block: 12n, launches: [row] });
  ok("a launch committed twice is kept once", first.added === 1 && again.added === 0 && s.stats().launches === 1);
  ok("…and the cursor moves with each commit", s.cursor("main") === 12n);
  ok("rows read back as written, addresses lowercased", JSON.stringify(s.launches()[0], (_, v) => typeof v === "bigint" ? v.toString() : v)
    === JSON.stringify({ token: "0xaa", curve: "0xbb", creator: "0xcc", factory: "0xdd", block: "5", logIndex: 1, threshold: "7" }));
  ok("a token with no Transfers read has no holders to give", s.holders("0xaa", 0n) === null);
  const t = { token: "0xaa", block: 6n };
  const tx = [
    { ...t, from: ZERO, to: "0xbb", value: 100n },
    { ...t, from: "0xbb", to: "0x01", value: 30n },
    { ...t, block: 8n, from: "0x01", to: "0x02", value: 10n },
    { ...t, block: 9n, from: "0x02", to: ZERO, value: 4n },
  ];
  s.commit({ block: 9n, transfers: tx, synced: ["0xaa"] });
  s.commit({ block: 9n, transfers: tx, synced: ["0xaa"] });
  const h = s.holders("0xaa", 9n);
  const list = h?.holders.map((x) => `${x.address}=${x.balance}`).join();
  ok("Transfers fold into holders once, however often they are committed", list === "0x01=20,0x02=6", list);
  ok("…less the curve, with supply minted less burned", h?.supply === 96n, String(h?.supply));
  ok("…and what each received in the block it first appeared", h?.holders.find((x) => x.address === "0x01")?.firstIn === 30n
    && h?.holders.find((x) => x.address === "0x02")?.firstBlock === 8n);
  ok("holders past a token's synced block are not given", s.holders("0xaa", 10n) === null);
  s.close();

  const bad = join(dir, "corrupt.sqlite");
  writeFileSync(bad, "this is not a database, it is a sentence of plain text that is long enough to have a header");
  const lines: string[] = [];
  const fresh = openIndexStore(bad, { venue: VENUE_KEY, log: (l) => lines.push(l) });
  ok("a corrupt file is moved aside and a fresh one opened", fresh.cursor("main") === null
    && readdirSync(dir).some((f) => f.startsWith("corrupt.sqlite.bad-")), lines[0]);
  fresh.commit({ cursor: "main", block: 1n });
  fresh.close();

  const other = openIndexStore(join(dir, "a.sqlite"), { venue: "test:pons", log: (l) => lines.push(l) });
  ok("a file for another venue is moved aside, not read", other.cursor("main") === null
    && readdirSync(dir).some((f) => f.startsWith("a.sqlite.bad-")), lines[1]);
  other.close();
}

// ----------------------------------------------------------- the follower --
const path = join(dir, "index.sqlite");
let store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
const wideEp = endpoint("wide", { maxLogs: 60 });
const tailEp = endpoint("tail", { maxLogs: 60 });
const route = (...eps: ReturnType<typeof endpoint>[]) => createLogRoute(eps);
const make = (o: Partial<Parameters<typeof createFollower>[0]> = {}) => createFollower({
  store, floor: FLOOR, launches: launchIndex.launchSource(), pools: { manager: MANAGER, createdTopic: POOL_CREATED },
  tail: route(tailEp), wide: route(wideEp),
  log: () => {}, catchUpMs: 60_000, catchUpBatch: 5, ...o,
});

/** Every token's holders equal a plain replay of the chain up to the cursor. */
function holdersMatch(f: ReturnType<typeof make>) {
  const cur = store.cursor("main")!;
  const bad: string[] = [];
  for (const b of launchBlocks.filter((x) => x <= cur)) {
    const t = tokenAt(b);
    const h = f.holders(t);
    const want = replay(t, cur);
    const wantList = [...want.bal].filter(([a, v]) => a !== curveAt(b) && v > 0n).map(([a, v]) => `${a}=${v}`).sort().join();
    const got = h?.holders.map((x) => `${x.address}=${x.balance}`).sort().join();
    if (!h || got !== wantList || h.supply !== want.supply) bad.push(t);
  }
  return bad;
}

console.log("\nan empty index");
{
  const seenPools: string[] = [];
  const f = make({ onCommit: (w) => seenPools.push(...w.pools.map((p) => p.token)) });
  calls.length = 0;
  const r = await f.round();
  const logCalls = calls.filter((c) => c.method === "eth_getLogs");
  ok("the first round reads from the venue's floor", logCalls[0]?.from === FLOOR, String(logCalls[0]?.from));
  ok("…the wide way", calls.every((c) => c.endpoint === "wide"), [...new Set(calls.map((c) => c.endpoint))].join());
  ok("…halving windows the endpoint says are too wide", logCalls.some((c) => c.to! - c.from! < 49_000n), `${logCalls.length} getLogs`);
  ok("…up to the head less the confirmations", store.cursor("main") === HEAD - 20n, String(store.cursor("main")));
  ok("…with every launch in that range, once", store.stats().launches === launchesIn(HEAD - 20n),
    `${store.stats().launches} of ${launchesIn(HEAD - 20n)}`);
  ok("…and catches every token's holders up in the same round", r.pending === 0 && store.stats().withHolders === store.stats().launches,
    `${store.stats().withHolders} of ${store.stats().launches}`);
  const bad = holdersMatch(f);
  ok("every token's holders and supply equal a replay of its Transfers, burns and moves between holders included",
    bad.length === 0, bad.slice(0, 3).join());
  const old = store.pools(tokenAt(launchBlocks[1]!));
  ok("a pool made before the index watched is found once, every candidate in its block kept",
    old.length === 2 && old.some((p) => p.hooks === HOOK && p.fee === 3000 && p.tickSpacing === 200)
    && store.cursor("pools") === store.cursor("main"), JSON.stringify(old.map((p) => `${p.hooks.slice(-3)}:${p.fee}/${p.tickSpacing}`)));
  const one = f.holders(tokenAt(launchBlocks[2]!))!;
  ok("…the creator's dev buy and the bundled buyer keep what they bought in the launch block",
    one.holders.find((h) => h.address === creator)?.firstIn === 5n * 10n ** 24n
    && one.holders.find((h) => h.address === addr("d", launchBlocks[2]!))?.firstBlock === launchBlocks[2]);

  HEAD += 3_000n;
  const newest = HEAD - 1_000n;
  launchBlocks.push(newest);
  launch(newest);
  transfer(tokenAt(launchBlocks[0]!), addr("e", launchBlocks[0]! + 1n), addr("9", 1n), 10n ** 20n, HEAD - 500n);
  graduate(tokenAt(launchBlocks[3]!), HEAD - 400n);
  calls.length = 0;
  const before = store.cursor("main")!;
  seenPools.length = 0;
  const r2 = await f.round();
  const next = calls.find((c) => c.method === "eth_getLogs");
  ok("the next round follows the cheap way", next?.endpoint === "tail", next?.endpoint);
  ok("…from the block after the cursor, in one filter over the factories and every caught-up token",
    next?.from === before + 1n && next?.to === HEAD - 20n && next?.addresses === FACTORIES.length + 2 * launchesIn(before),
    `${next?.from}..${next?.to}, ${next?.addresses} addresses`);
  ok("…and a launch in it is caught up the wide way in the same round",
    r2.pending === 0 && !!f.holders(tokenAt(newest)) && calls.some((c) => c.endpoint === "wide" && c.method === "eth_getLogs"));
  const bad2 = holdersMatch(f);
  ok("…and every token still equals the replay, the new Transfer included", bad2.length === 0, bad2.slice(0, 3).join());
  ok("a graduation in the tail stores its pool keys in the same window, and says so",
    store.pools(tokenAt(launchBlocks[3]!)).length === 2 && seenPools.includes(tokenAt(launchBlocks[3]!)));
  ok("…with one Initialize query in its own block", calls.filter((c) => c.method === "eth_getLogs" && c.from === HEAD - 400n && c.to === HEAD - 400n).length === 1);

  calls.length = 0;
  await f.round();
  ok("a round with nothing new asks for no logs", !calls.some((c) => c.method === "eth_getLogs"));
}

console.log("\nrounds are idempotent");
{
  const cursor = store.cursor("main")!;
  const t = tokenAt(launchBlocks[1]!);
  const snap = () => JSON.stringify(store.holders(t, cursor), (_, v) => typeof v === "bigint" ? v.toString() : v);
  const before = snap();
  // A window read again, as if a commit had been lost after the fold.
  const logs = chain.filter((l) => l.address === t && BigInt(l.blockNumber) <= cursor);
  store.commit({
    block: cursor,
    transfers: logs.map((l) => ({ token: t, from: `0x${l.topics[1]!.slice(26)}`, to: `0x${l.topics[2]!.slice(26)}`, value: BigInt(l.data), block: BigInt(l.blockNumber) })),
    synced: [t],
  });
  ok("a token's Transfers committed again change nothing", snap() === before);
  const count = store.stats().launches;
  store.commit({ cursor: "main", block: cursor - 20_000n });
  const f = make();
  await f.round();
  ok("the cursor set back 20,000 blocks adds no launch", store.stats().launches === count, `${store.stats().launches} vs ${count}`);
  ok("…and folds no Transfer twice", holdersMatch(f).length === 0);
  ok("…and the cursor is back where it was", store.cursor("main") === cursor);
  const [a, b] = await Promise.all([f.round(), f.round()]);
  ok("two rounds asked at once are one round", a === b);
}

console.log("\na refusal part way through a backfill");
{
  store.close();
  rmSync(path);
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  let n = 0;
  let refuseFrom = 6;
  // 20 logs a window: the launches alone take several windows.
  const flaky = endpoint("flaky", { maxLogs: 20, refuse: () => ++n > refuseFrom });
  const f = make({ wide: route(flaky) });
  const r = await f.round().then(() => null, (e) => e);
  const stopped = store.cursor("main");
  ok("the round fails", r !== null);
  ok("…keeping the windows it committed", stopped !== null && stopped < HEAD - 20n && store.stats().launches === launchesIn(stopped),
    `cursor ${stopped}, ${store.stats().launches} launches`);
  refuseFrom = Infinity;
  calls.length = 0;
  flaky.gate = createLogGate();
  const f2 = make({ wide: route(flaky) });
  await f2.round();
  const first = calls.find((c) => c.method === "eth_getLogs");
  ok("the next round carries on from the cursor, not the floor", first?.from === (stopped ?? 0n) + 1n, `${first?.from}`);
  ok("…and finishes with every launch once and every token's holders right",
    store.cursor("main") === HEAD - 20n && store.stats().launches === launchesIn(HEAD - 20n) && holdersMatch(f2).length === 0);
}

console.log("\na refusal while catching up");
{
  store.close();
  rmSync(path);
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  let refusing = false;
  const flaky = endpoint("flaky", { maxLogs: 60, refuse: () => refusing });
  const f = make({ wide: route(flaky), catchUpBatch: 2 });
  // Let the launches through, then refuse once catching up has begun.
  const orig = flaky.request.bind(flaky);
  let seen = 0;
  flaky.request = async (a) => {
    // The second catching-up request: a Transfer-only filter.
    const topics = (a.params as { topics: unknown[] }[] | undefined)?.[0]?.topics;
    const t0 = topics?.[0];
    if (a.method === "eth_getLogs" && Array.isArray(t0) && !t0.includes(VENUE.launchTopic) && ++seen === 2) refusing = true;
    return orig(a);
  };
  const r = await f.round();
  ok("the round still succeeds: the cursor moved", store.cursor("main") === HEAD - 20n && r.pending === -1, `pending ${r.pending}`);
  ok("…with some tokens caught up and the rest waiting", store.stats().withHolders > 0 && store.stats().withHolders < store.stats().launches,
    `${store.stats().withHolders} of ${store.stats().launches}`);
  refusing = false;
  flaky.gate = createLogGate();
  const f2 = make({ wide: route(flaky) });
  await f2.round();
  ok("…and the next round finishes them, every one right", store.stats().withHolders === store.stats().launches && holdersMatch(f2).length === 0);
}

console.log("\na catch-up cut short");
{
  store.close();
  rmSync(path);
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  const f = make({ catchUpMs: 0 });
  const r = await f.round();
  ok("with no time for it, the tokens wait", r.pending > 0 && store.stats().withHolders === 0, `${r.pending} pending`);
  ok("…and a token not caught up has no holders from the index", f.holders(tokenAt(launchBlocks[0]!)) === null);
  const f2 = make({ catchUpBatch: 3 });
  const r2 = await f2.round();
  ok("the next round catches them up, newest first", r2.pending === 0 && holdersMatch(f2).length === 0);
}

console.log("\nan endpoint refusing us");
{
  store.close();
  rmSync(path);
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  const refusing = endpoint("alchemy", { refuse: () => true });
  const f = make({ wide: route(refusing, endpoint("public", { maxLogs: 60 })) });
  calls.length = 0;
  await f.round();
  ok("the backfill moves to the endpoint behind it", store.cursor("main") === HEAD - 20n
    && calls.some((c) => c.endpoint === "public" && c.method === "eth_getLogs") && holdersMatch(f).length === 0);
}

console.log("\na restart");
{
  const cursor = store.cursor("main")!;
  store.close();
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  HEAD += 500n;
  calls.length = 0;
  const f = make();
  await f.round();
  const first = calls.find((c) => c.method === "eth_getLogs");
  ok("a reopened index resumes from its cursor", first?.from === cursor + 1n, `${first?.from} after ${cursor}`);
  ok("…the wide way, since how far behind is not known yet", calls.every((c) => c.endpoint === "wide"));
  ok("…with every token's holders still right", holdersMatch(f).length === 0);
}

console.log("\nthe launch index, served by the follower");
{
  const f = make({
    onCommit: (w) => launchIndex.followerCommitted({ to: w.to, launches: w.launches }),
  });
  launchIndex.attachFollower(f, store.launches());
  calls.length = 0;
  const all = await launchIndex.allLaunches();
  ok("allLaunches is what the index holds, oldest first", all.length === store.stats().launches
    && all.every((r, i) => i === 0 || all[i - 1]!.block <= r.block), `${all.length}`);
  ok("…after one round of its own, the loop being stopped", calls.filter((c) => c.method === "eth_blockNumber").length === 1);
  const one = all[3]!;
  ok("launchOf finds a token by any case", (await launchIndex.launchOf(one.token.toUpperCase().replace("0X", "0x") as `0x${string}`))?.block === one.block);
  HEAD += 2_000n;
  const newest = HEAD - 100n;
  launchBlocks.push(newest);
  launch(newest);
  launchIndex.noteLaunch({ token: tokenAt(newest) as `0x${string}`, curve: curveAt(newest) as `0x${string}`, creator: creator as `0x${string}`, block: newest, graduationThreshold: 0n });
  ok("a websocket launch is known before the follower reads it", !!(await launchIndex.launchOf(tokenAt(newest) as `0x${string}`)));
  await f.round();
  ok("…and the follower's round stores it once", store.launches().filter((r) => r.token === tokenAt(newest)).length === 1);
  ok("…and the launch index lists it once", (await launchIndex.allLaunches()).filter((r) => r.token.toLowerCase() === tokenAt(newest)).length === 1);
  ok("indexStats reports the follower", (launchIndex.indexStats() as { follower?: { cursor: string } }).follower?.cursor === String(HEAD - 20n));
}

console.log("\ntrades and ledgers from the index");
{
  store.close();
  rmSync(path);
  store = openIndexStore(path, { venue: VENUE_KEY, log: () => {} });
  const told: { tx: string; logIndex: number }[] = [];
  const f = make({ onCommit: (w) => told.push(...w.trades) });
  await f.round();
  await f.round();
  const s = store.stats();
  const want = chain.filter((l) => l.topics[0] === BUY_TOPIC || l.topics[0] === SELL_TOPIC).filter((l) => BigInt(l.blockNumber) <= store.cursor("main")!).length;
  ok("every curve trade is kept once", s.trades === want, `${s.trades} of ${want}`);
  // The live `trade` event (X25a) sends what each commit says is new.
  ok("each commit names the trades it added, each once over every window",
    told.length === want && new Set(told.map((t) => `${t.tx}:${t.logIndex}`)).size === want, `${told.length} of ${want}`);
  const again = store.tokenTrades(tokenAt(launchBlocks[2]!)).trades;
  ok("…and a window read twice adds none", store.commit({ block: store.cursor("main")!, trades: again }).trades.length === 0
    && again.length > 0, `${again.length} trades read again`);
  ok("…with every trade's receipt and block time", s.receipts === new Set(chain.filter((l) => l.topics[0] === BUY_TOPIC || l.topics[0] === SELL_TOPIC).filter((l) => BigInt(l.blockNumber) <= store.cursor("main")!).map((l) => l.transactionHash)).size,
    `${s.receipts} receipts`);
  const b = launchBlocks[2]!;
  const seller = addr("e", b + 1n);
  const sell = store.ledgerOf(seller).trades.find((t) => t.kind === "sell" && t.token === tokenAt(b));
  ok("a router sell keeps who moved the token in its transaction", !!sell && sell.movers.includes(seller) && sell.caller === ROUTER,
    JSON.stringify(sell?.movers));

  // A ledger from the index: no log is read, and attribution works as a scan's.
  const curves = async (cs: `0x${string}`[]) => new Map(cs.map((c) => {
    const lb = launchBlocks.find((x) => curveAt(x) === c.toLowerCase())!;
    return [c.toLowerCase(), { token: tokenAt(lb) as `0x${string}`, symbol: `T${lb}` }];
  }));
  calls.length = 0;
  const input = f.ledgerOf(seller)!;
  const built = await buildFromIndex(seller as `0x${string}`, input, { sources: { curves } });
  ok("a ledger from the index reads no log", !calls.some((c) => c.method === "eth_getLogs"), calls.map((c) => c.method).join());
  const tokenTrades = built.trades.filter((t) => t.curve.toLowerCase() === curveAt(b));
  ok("…books the wallet's own buy and its router sell", tokenTrades.map((t) => t.kind).join() === "buy,sell",
    tokenTrades.map((t) => t.kind).join());
  ok("…and not the stranger's buy for it", !built.trades.some((t) => t.tx === word(`91f7${b.toString(16)}`)));
  const pos = built.ledger.positions.find((p) => p.token.toLowerCase() === tokenAt(b));
  ok("…with its balance from the index, at the cursor", built.ledger.toBlock === store.cursor("main") && !!pos,
    `${pos?.tokens} tokens, ${pos?.confidence}`);

  // A token's trades for its replay (p-sell-verdict.md P4a), by the v5 index.
  const tt = f.tokenTrades(tokenAt(b))!;
  const onChain = chain.filter((l) => (l.topics[0] === BUY_TOPIC || l.topics[0] === SELL_TOPIC)
    && l.address.toLowerCase() === curveAt(b) && BigInt(l.blockNumber) <= store.cursor("main")!);
  ok("a token's trades: every one on its curve, oldest first",
    tt.trades.length === onChain.length && tt.trades.every((t, i) => i === 0 || t.block >= tt.trades[i - 1]!.block)
      && tt.trades.every((t) => t.token === tokenAt(b)), `${tt.trades.length} of ${onChain.length}`);
  ok("…with their receipts, and the stranger's buy and the router sell among them",
    tt.trades.every((t) => tt.receipts.has(t.tx)) && tt.trades.some((t) => t.caller === ROUTER), `${tt.receipts.size} receipts`);
  ok("…at the cursor", tt.toBlock === store.cursor("main"));
  ok("…with its launch, read up to the cursor (X25a's indexed)", tt.launch?.creator === creator
    && tt.launch.block === b && tt.launch.syncedTo !== null && tt.launch.syncedTo >= tt.toBlock, JSON.stringify(tt.launch, (_k, v) => typeof v === "bigint" ? String(v) : v));
  ok("…and the index's newest and oldest block times", tt.anchors.length === 2 && tt.anchors[0]![0] >= tt.anchors[1]![0]
    && tt.anchors[0]![1] > 0, JSON.stringify(tt.anchors));
  const foreign = f.tokenTrades("0x" + "f".repeat(40))!;
  ok("a token of another venue has none, and no launch", foreign.trades.length === 0 && foreign.launch === null);

  // The board's dead-launch rule reads these (B6).
  const act = store.activity();
  ok("activity: a token's newest curve-trade block", act.lastTrade.get(tokenAt(b)) === tt.trades.at(-1)!.block,
    `${act.lastTrade.get(tokenAt(b))} vs ${tt.trades.at(-1)!.block}`);
  ok("…and every token with a pool counts as graduated",
    [...act.graduated].every((t) => store.pools(t).length > 0) && act.graduated.has(tokenAt(launchBlocks[3]!)), [...act.graduated].join(","));
}

console.log("\ndrift, rebuild and health");
{
  // The chain's truth at a block, from the fake chain itself.
  const drift = {
    everyMs: 0, tokens: 100,
    balances: async (token: string, owners: string[], block: bigint) => {
      const { bal } = replay(token, block);
      return new Map(owners.map((o) => [o, bal.get(o) ?? 0n]));
    },
    supply: async (token: string, block: bigint) => replay(token, block).supply,
  };
  const lines: string[] = [];
  const f = make({ drift, log: (l) => lines.push(l) });
  await f.round();
  await f.round();
  ok("an index that agrees with the chain is left alone", !lines.some((l) => l.includes("drift in")), lines.filter((l) => l.includes("drift")).join(" | "));
  ok("…every token checked", (f.state() as { driftChecked: number }).driftChecked >= launchesIn(store.cursor("main")!));

  // One balance wrong in the file, as a lost write or a bug would leave it.
  const victim = tokenAt(launchBlocks[4]!);
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE holders SET balance = '1' WHERE token = ? AND address = ?").run(victim, creator);
  raw.close();
  lines.length = 0;
  await f.round();
  ok("a wrong balance is found at the cursor block and said so", lines.some((l) => l.includes(`drift in ${victim}`)), lines.join(" | "));
  ok("…and the token is read again from its launch", f.holders(victim) === null && f.health().building === 1,
    JSON.stringify(f.health()));
  await f.round();
  ok("…which the next round does, and it agrees again", holdersMatch(f).length === 0 && f.health().building === 0);
  lines.length = 0;
  await f.round();
  ok("…so the next check finds nothing", !lines.some((l) => l.includes("drift in")));
  const h = f.health();
  ok("health says how far behind the head, what is building, and how long since a round",
    h.followerLagBlocks === 20 && h.building === 0 && h.followerRoundAgeSec !== null && h.followerRoundAgeSec < 5, JSON.stringify(h));
}

console.log("\nthe loop");
{
  const f = make({ followMs: 20 });
  HEAD += 100n;
  f.start();
  await new Promise((r) => setTimeout(r, 150));
  f.stop();
  const at = store.cursor("main");
  ok("started, it follows the head", at === HEAD - 20n, String(at));
  HEAD += 100n;
  await new Promise((r) => setTimeout(r, 100));
  ok("stopped, it reads nothing more", store.cursor("main") === at);
}

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? "\n\x1b[32mall chain index checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
