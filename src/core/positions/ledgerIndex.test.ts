/**
 * The per-address ledger index — public-release B3.3.
 *
 * Hermetic. The history comes from the fake node (fixtures/node.ts) through a
 * real history client, over the recorded routed address and over synthetic
 * addresses. Synthetic events use the curve's real event layout (topics and
 * four data words, as recorded); their curves and balances are answered by
 * plain functions, since nothing here is about decoding a call. The clock is
 * a fake.
 *
 *   npm run test:ledgerindex
 */
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { fakeNode, type Fixture } from "./fixtures/node.js";

const routed = JSON.parse(readFileSync(new URL("./fixtures/ledger-routed.json", import.meta.url), "utf8")) as Fixture;
// clank.trade's second factory, asked about the same curves (B1.5).
const second = JSON.parse(readFileSync(new URL("./fixtures/ledger-second-factory.json", import.meta.url), "utf8")) as Fixture;
const node = fakeNode([routed, second]);
globalThis.fetch = node.fetch;

const { createLedgerIndex } = await import("./ledgerIndex.js");
const { createHistoryRpc } = await import("../lib/historyRpc.js");
const { createLogGate } = await import("../lib/logGate.js");
const { BUY_TOPIC, TRANSFER_TOPIC } = await import("./attribution.js");

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const u = (v: bigint) => v.toString(16).padStart(64, "0");
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

let clock = 1_000_000;
const now = () => clock;
const history = () => createHistoryRpc({ url: "http://fake", gate: createLogGate() });
const ROUTED = routed.address as Address;
const head = BigInt(routed.toBlock);

// ---------------------------------------------------------------------------
console.log("\nfreshness");
{
  const h = history();
  const index = createLedgerIndex({ sources: { history: h }, now });
  node.reset();
  const cold = await index.get(ROUTED);
  const coldLogs = node.count("eth_getLogs");
  ok("a cold lookup scans from genesis", coldLogs === 2 && cold.positions.length > 0, `${coldLogs} scans`);

  node.reset();
  const again = await index.get(ROUTED);
  ok("a second lookup within 30s makes no request at all", node.state.requests === 0 && again === cold,
    `${node.state.requests} requests`);

  // A new buy lands in a later block: a copy of a recorded buy, same curve.
  const buy = routed.logs.find((l) => same(l.topics[0], BUY_TOPIC) && same(l.topics[1], pad(ROUTED)))!;
  const tx = `0x${"ab".repeat(32)}` as Hex;
  const block = head + 100n;
  const ev = { ...buy, transactionHash: tx, blockNumber: hex(block), logIndex: "0x0" as Hex };
  node.state.logs.set(`${tx}:0x0`, ev);
  node.state.receipts.set(tx, { ...node.state.receipts.get(buy.transactionHash.toLowerCase())!, transactionHash: tx, logs: [ev] });
  node.state.blocks.set(block.toString(), hex(1_900_000_000n));
  node.state.head = block + 5n;
  // The balance grows by what the new buy delivered, or reconciliation would
  // (rightly) call the replay wrong.
  const token = cold.positions.find((p) => same(p.curve, buy.address))!.token;
  const key = `${token}|${ROUTED}`.toLowerCase();
  const held = cold.positions.filter((p) => same(p.token, token) && !p.closed).reduce((a, p) => a + BigInt(p.tokens), 0n);
  node.state.balances.set(key, held + BigInt(`0x${buy.data.slice(66, 130)}`));

  node.reset();
  clock += 29_000;
  await index.get(ROUTED);
  ok("…still none at 29s, though the chain has moved", node.state.requests === 0);

  node.reset();
  clock += 2_000;
  const tail = await index.get(ROUTED);
  const scans = node.state.seen.filter((m) => m === "eth_getLogs").length;
  ok("after 30s: the new head, two narrow scans, and one receipt and one block for the new transaction only",
    node.count("eth_blockNumber") === 1 && scans === 2 && node.count("eth_getTransactionReceipt") === 1
      && node.count("eth_getBlockByNumber") === 1,
    node.state.seen.join(","));
  ok("…and the tail scans run from the block after the last build to the new head",
    node.state.logRanges.length === 2 && node.state.logRanges.every(([a, b]) => a === head + 1n && b === block + 5n)
      && tail.toBlock === block + 5n,
    node.state.logRanges.map(([a, b]) => `${a}-${b}`).join(" "));
  const p = tail.positions.find((q) => same(q.curve, buy.address) && !q.closed)!;
  ok("the new buy is in the ledger, exact, at the balance it left",
    !!p && p.confidence === "exact" && BigInt(p.tokens) === node.state.balances.get(key),
    p ? `${p.tokens}` : "none");

  node.reset();
  index.markDirty(ROUTED);
  clock += 1_000;
  await index.get(ROUTED);
  ok("markDirty forces the tail inside the freshness window", node.count("eth_blockNumber") === 1,
    node.state.seen.join(","));
  node.reset();
  await index.get(ROUTED);
  ok("…once", node.state.requests === 0);

  node.state.balances.delete(key);
  node.state.logs.delete(`${tx}:0x0`);
  node.state.head = head;
}

// ---------------------------------------------------------------------------
console.log("\none build at a time per address");
{
  const index = createLedgerIndex({ sources: { history: history() }, now });
  node.reset();
  const [a, b, c] = await Promise.all([index.get(ROUTED), index.get(ROUTED), index.get(ROUTED.toUpperCase().replace("0X", "0x") as Address)]);
  ok("three concurrent lookups share one build", a === b && b === c && node.count("eth_blockNumber") === 1,
    `${node.count("eth_blockNumber")} builds`);
}

// ---------------------------------------------------------------------------
// Synthetic addresses: many tokens, many transactions.
const OWNER = "0x00000000000000000000000000000000000a11ce" as Address;
const curveOf = (i: number) => `0x${(0xc0_0000 + i).toString(16).padStart(40, "0")}` as Address;
const tokenOf = (i: number) => `0x${(0x70_0000 + i).toString(16).padStart(40, "0")}` as Address;

/** `perToken[i]` direct buys of token i, spread over blocks; token 0's are the oldest. */
function synthetic(owner: Address, perToken: number[], firstBlock = 64_000_000n) {
  const logs: Fixture["logs"] = [];
  let b = firstBlock, k = 0;
  perToken.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      const tx = `0x${owner.slice(-8)}${(++k).toString(16).padStart(56, "0")}` as Hex;
      const ev = {
        address: curveOf(i), topics: [BUY_TOPIC, pad(owner), pad(owner)],
        data: `0x${u(10n ** 15n)}${u(10n ** 21n)}${u(10n ** 13n)}${u(0n)}` as Hex,
        transactionHash: tx, blockNumber: hex(b), logIndex: "0x1" as Hex,
      };
      logs.push(ev);
      node.state.logs.set(`${tx}:0x1`, ev);
      node.state.receipts.set(tx, {
        transactionHash: tx, from: owner, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
        logs: [ev, { ...ev, address: tokenOf(i), topics: [TRANSFER_TOPIC, pad(curveOf(i)), pad(owner)], data: `0x${u(10n ** 21n)}` as Hex }],
      });
      node.state.blocks.set(b.toString(), hex(1_800_000_000n + b));
      b += 10n;
    }
  });
  return logs;
}
const curves = async (cs: Address[]) => new Map(cs.flatMap((c) => {
  const i = Number(BigInt(c) - 0xc0_0000n);
  return i >= 0 && i < 10_000 ? [[c.toLowerCase(), { token: tokenOf(i), symbol: `T${i}` }] as const] : [];
}));
/** Whatever the replay says it holds: reconciliation leaves exact positions exact. */
const balances = async (_o: Address, tokens: Address[]) => new Map(tokens.map((t) => [t.toLowerCase(), 25n * 10n ** 21n]));

console.log("\nthe cap drops whole tokens, oldest first");
{
  // 20 tokens × 25 transactions = 500, against a cap of 400.
  synthetic(OWNER, Array(20).fill(25));
  node.state.head = 64_100_000n;
  const index = createLedgerIndex({ sources: { history: history(), curves, balances }, maxTxs: 400, now });
  node.reset();
  const l = await index.get(OWNER);
  ok("partial, with 16 tokens in and 4 out", l.partial && l.positions.length === 16 && l.omittedTokens.length === 4,
    `${l.positions.length} in, ${l.omittedTokens.length} out`);
  ok("every returned token has all 25 of its transactions",
    l.positions.every((p) => BigInt(p.costEth) === 25n * 10n ** 15n && BigInt(p.tokens) === 25n * 10n ** 21n));
  ok("the omitted tokens are the least recently active",
    l.omittedTokens.map((o) => o.token.toLowerCase()).sort().join() === [0, 1, 2, 3].map((i) => tokenOf(i).toLowerCase()).join(),
    l.omittedTokens.map((o) => `${o.symbol}:${o.txs}`).join(" "));
  ok("…each with its count and symbol", l.omittedTokens.every((o) => o.txs === 25 && /^T\d$/.test(o.symbol)));
  ok("receipts were fetched only for what fits", node.count("eth_getTransactionReceipt") === 400,
    `${node.count("eth_getTransactionReceipt")} receipts`);

  const whole = createLedgerIndex({ sources: { history: history(), curves, balances }, maxTxs: 500, now });
  const all = await whole.get(OWNER);
  ok("at exactly the cap, nothing is left out", !all.partial && all.positions.length === 20 && all.omittedTokens.length === 0);

  // A token that alone is over the cap stops the walk: nothing older is taken
  // in its place, or a recent token would be missing while an old one showed.
  const BIG = "0x00000000000000000000000000000000000b0b00" as Address;
  synthetic(BIG, [5, 30, 5], 65_000_000n);
  node.state.head = 66_000_000n;
  const capped = await createLedgerIndex({ sources: { history: history(), curves, balances }, maxTxs: 20, now }).get(BIG);
  // One transaction can trade two tokens (a router's batch). The cap counts
  // transactions, so what two tokens share is counted once.
  const SHARED = "0x0000000000000000000000000000000000005aed" as Address;
  // Tokens 4 (1 transaction, oldest), 5 and 6 (3 each, 6 newest).
  const logs = synthetic(SHARED, [0, 0, 0, 0, 1, 3, 3], 65_500_000n);
  for (let j = 0; j < 2; j++) {
    // Two of token 5's buys move into token 6's transactions: 5 unique
    // transactions in all, against a cap of 4.
    const into = logs[4 + j]!;
    const moved = { ...logs[1 + j]!, transactionHash: into.transactionHash, blockNumber: into.blockNumber, logIndex: "0x2" as Hex };
    node.state.logs.delete(`${logs[1 + j]!.transactionHash}:0x1`);
    node.state.logs.set(`${moved.transactionHash}:0x2`, moved);
    node.state.receipts.get(moved.transactionHash.toLowerCase())!.logs.push(moved);
  }
  const shared = await createLedgerIndex({ sources: { history: history(), curves, balances }, maxTxs: 4, now }).get(SHARED);
  ok("transactions two tokens share count once toward the cap",
    shared.partial && shared.positions.map((p) => p.symbol).sort().join() === "T5,T6"
      && shared.omittedTokens.map((o) => o.symbol).join() === "T4",
    `${shared.positions.map((p) => p.symbol).join()} in; ${shared.omittedTokens.map((o) => o.symbol).join()} out`);

  ok("a token that does not fit stops the walk: older ones are left out even where they would fit",
    capped.positions.length === 1 && same(capped.positions[0]!.token, tokenOf(2)) && capped.omittedTokens.length === 2,
    `${capped.positions.map((p) => p.symbol).join()} in; ${capped.omittedTokens.map((o) => o.symbol).join()} out`);
}

// ---------------------------------------------------------------------------
console.log("\na refused build keeps what landed");
{
  // The public node refuses a few hundred calls in (docs/rpc-optimization.md).
  // 250 transactions; the node allows the head, both scans and 150 calls.
  const P = "0x00000000000000000000000000000000000a55e7" as Address;
  synthetic(P, [250], 66_500_000n);
  node.state.head = 66_600_000n;
  const gate = createLogGate({ baseMs: 1, maxMs: 1 });
  const index = createLedgerIndex({ sources: { history: createHistoryRpc({ url: "http://fake", gate }), curves, balances }, now });
  node.reset();
  node.state.budget = 1 + 2 + 150;
  const first = await index.get(P).then(() => null, (e: Error) => e);
  node.state.budget = Infinity;
  ok("the first build is refused part way", first !== null && /Too Many Requests/.test(first.message), first?.message);
  await new Promise((r) => setTimeout(r, 10)); // the gate reopens
  node.reset();
  const second = await index.get(P);
  ok("the next build scans nothing again and fetches only the 150 receipts still missing",
    node.count("eth_getLogs") === 0 && node.count("eth_getTransactionReceipt") === 150,
    `${node.count("eth_getLogs")} scans, ${node.count("eth_getTransactionReceipt")} receipts`);
  ok("…and the ledger is whole", !second.partial && second.positions.length === 1
    && BigInt(second.positions[0]!.costEth) === 250n * 10n ** 15n);
}

// ---------------------------------------------------------------------------
console.log("\nthe least recently used address is forgotten first");
{
  const index = createLedgerIndex({ sources: { history: history(), curves, balances }, maxAddresses: 3, now });
  const addr = (i: number) => `0x${(0xa0_0000 + i).toString(16).padStart(40, "0")}` as Address;
  for (let i = 0; i < 3; i++) synthetic(addr(i), [2], 67_000_000n + BigInt(i) * 1000n);
  node.state.head = 68_000_000n;
  for (let i = 0; i < 3; i++) await index.get(addr(i));
  await index.get(addr(0)); // used again, so addr(1) is now the oldest
  synthetic(addr(3), [2], 67_900_000n);
  await index.get(addr(3));
  ok("the fourth address evicts the least recently used one",
    index.size() === 3 && index.has(addr(0)) && !index.has(addr(1)) && index.has(addr(2)) && index.has(addr(3)),
    JSON.stringify(index.stats()));

  // Two events each, and room for five: the third address pushes out the first.
  const small = createLedgerIndex({ sources: { history: history(), curves, balances }, maxEvents: 5, now });
  for (let i = 0; i < 3; i++) await small.get(addr(i));
  ok("the event bound evicts too, least recently used first",
    small.size() === 2 && !small.has(addr(0)) && small.stats().events === 4, JSON.stringify(small.stats()));
  const one = createLedgerIndex({ sources: { history: history(), curves, balances }, maxEvents: 1, now });
  await one.get(addr(0));
  ok("…but never the address just looked up", one.size() === 1 && one.has(addr(0)));
}

// ---------------------------------------------------------------------------
console.log("\nmemory, measured");
{
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    ok("run with --expose-gc to measure memory (npm run test:ledgerindex does)", false);
  } else {
    // 2,001 addresses of 20 transactions over 5 tokens each: a modest wallet.
    const N = 2_001;
    let index: ReturnType<typeof createLedgerIndex> | null =
      createLedgerIndex({ sources: { history: history(), curves, balances }, maxAddresses: 2_000, now });
    const who = (i: number) => `0x${(0xd0_0000 + i).toString(16).padStart(40, "0")}` as Address;
    for (let i = 0; i < N; i++) synthetic(who(i), [4, 4, 4, 4, 4], 68_100_000n + BigInt(i) * 200n);
    node.state.head = 69_000_000n;
    node.state.seen.length = 0;
    for (let i = 0; i < N; i++) await index.get(who(i));
    node.state.seen.length = 0;
    ok("2,001 addresses evict the first", index.size() === 2_000 && !index.has(who(0)) && index.has(who(N - 1)));
    // What the index holds is what goes when it goes: the heap with it,
    // less the heap once it is dropped, so nothing else in the process counts.
    gc(); gc();
    const full = process.memoryUsage().heapUsed;
    index = null;
    gc(); gc();
    const empty = process.memoryUsage().heapUsed;
    const perAddress = (full - empty) / 2_000;
    const after = full, before = empty;
    // The bound recorded in the spec and progress: 20 events and 20 receipts
    // per address, kept compact, stay under 64 KB an address (128 MB at the
    // default 2,000 addresses).
    ok("a 20-transaction address costs under 64 KB kept", perAddress < 64 * 1024,
      `${(perAddress / 1024).toFixed(1)} KB an address, ${((after - before) / 1048576).toFixed(1)} MB for 2,000`);
  }
}

ok("the fake node was asked for nothing it was not given", node.state.unknown.length === 0, node.state.unknown.slice(0, 5).join("; "));

console.log(failures === 0
  ? "\n\x1b[32mall ledger index checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
