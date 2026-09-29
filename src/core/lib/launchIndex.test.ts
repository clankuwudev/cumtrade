/**
 * The launch index when the log node fails — public-release B4.6.
 *
 * Against a local fake node. It answers eth_blockNumber, and answers or fails
 * eth_getLogs on demand. The failure is an HTTP 500, not a 429, so the log
 * gate stays open and each step is fresh. No chain.
 *
 *   npm run test:loggate
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

let HEAD = 64_000_000;
const word = (hex: string) => `0x${hex.padStart(64, "0")}`;
const launchLog = (n: number) => ({
  topics: [
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
    word(n.toString(16).padStart(40, "a")), word((n + 1).toString(16).padStart(40, "b")), word("c".repeat(40)),
  ],
  // The decoder reads the launch's config words from data since 78908ab.
  data: `0x${"0".repeat(64 * 3)}`,
  blockNumber: `0x${(63_917_500 + n).toString(16)}`,
});

const node = { logsFail: true, logRequests: [] as { fromBlock: string; toBlock: string }[] };
const srv = createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    const msg = JSON.parse(b);
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      if (m.method === "eth_blockNumber") return { jsonrpc: "2.0", id: m.id, result: `0x${HEAD.toString(16)}` };
      if (m.method === "eth_getLogs") {
        node.logRequests.push(m.params[0] as { fromBlock: string; toBlock: string });
        return { jsonrpc: "2.0", id: m.id, result: [launchLog(1), launchLog(2)] };
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not here" } };
    };
    const calls = Array.isArray(msg) ? msg : [msg];
    if (node.logsFail && calls.some((c) => c.method === "eth_getLogs")) {
      for (const c of calls) if (c.method === "eth_getLogs") node.logRequests.push(c.params[0]);
      res.writeHead(500).end("upstream down");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
// Before client.ts is imported: it reads these once.
process.env.RPC_URL = url;
process.env.LOGS_RPC_URL = url;
// No public node behind the fake: a failure here must stay a failure.
process.env.LOGS_FALLBACK_URL = "";
const { allLaunches, syncIndex, noteLaunch, indexStats } = await import("./launchIndex.js");
const { logGate } = await import("./logGate.js");

console.log("\nnever scanned");
{
  const r = await allLaunches().then((v) => ({ v }), (e) => ({ e }));
  ok("a first scan that fails throws, instead of returning []", "e" in r, "v" in r ? `returned ${(r as { v: unknown[] }).v.length}` : "");
  ok("…and leaves the index unscanned", indexStats().scannedTo === "0");
  ok("…without closing the log gate (a 500 is not a refusal)", logGate.state().open);

  noteLaunch({ token: `0x${"d".repeat(40)}`, curve: `0x${"e".repeat(40)}`, creator: `0x${"f".repeat(40)}`, block: 63_990_000n, graduationThreshold: 0n });
  ok("a launch noted before the first scan leaves scannedTo at 0", indexStats().scannedTo === "0", indexStats().scannedTo);
}

console.log("\nthe node answers");
{
  node.logsFail = false;
  node.logRequests.length = 0;
  const records = await syncIndex(true);
  ok("the first scan starts at the older factory's genesis block",
    node.logRequests[0]?.fromBlock === `0x${(63_917_462).toString(16)}`, node.logRequests[0]?.fromBlock);
  // B1.5: one call carrying both of clank.trade's factories, and nothing else.
  // Pons emits the very same event, so the address list is what keeps it out.
  const asked = (node.logRequests[0] as { address?: unknown } | undefined)?.address;
  ok("…in one eth_getLogs carrying exactly both clank.trade factories",
    node.logRequests.length === 1 && JSON.stringify(asked) === JSON.stringify([
      "0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1", "0x798daaa0707c1e538bb5acf0867ac0e1a84cccf2",
    ]), `${node.logRequests.length} call(s), address ${JSON.stringify(asked)}`);
  ok("…and keeps the launch noted earlier as well", records.length === 3, String(records.length));
  ok("…and the index is scanned to the head", indexStats().scannedTo === String(HEAD), indexStats().scannedTo);
  // D1.0: the scan runs to the head the log endpoint named, never to "latest",
  // so the cursor cannot pass a block that endpoint did not answer for.
  ok("…asked for exactly the log endpoint's own head, not \"latest\"",
    node.logRequests[0]?.toBlock === `0x${HEAD.toString(16)}`, node.logRequests[0]?.toBlock);
}

console.log("\na launch over the websocket, then a scan");
{
  const before = indexStats().scannedTo;
  noteLaunch({ token: `0x${"9".repeat(40)}`, curve: `0x${"8".repeat(40)}`, creator: `0x${"7".repeat(40)}`, block: BigInt(HEAD + 500), graduationThreshold: 0n });
  ok("a websocket launch past the cursor leaves the cursor where it was", indexStats().scannedTo === before, indexStats().scannedTo);
  HEAD += 1_000;
  node.logRequests.length = 0;
  await syncIndex(true);
  ok("…and the next scan reads every block after the old cursor",
    node.logRequests[0]?.fromBlock === `0x${(Number(before) + 1).toString(16)}`
    && node.logRequests[0]?.toBlock === `0x${HEAD.toString(16)}`,
    `${node.logRequests[0]?.fromBlock}..${node.logRequests[0]?.toBlock}`);
  ok("…and moves the cursor to the new head", indexStats().scannedTo === String(HEAD), indexStats().scannedTo);
}

console.log("\nscanned, then the node fails");
{
  node.logsFail = true;
  const had = indexStats().launches;
  const r = await syncIndex(true).then((v) => ({ v }), (e) => ({ e }));
  ok("a later sync that fails serves what it has", "v" in r && (r as { v: unknown[] }).v.length === had, String(had));
}

srv.close();
console.log(failures === 0
  ? "\n\x1b[32mall launch index checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
