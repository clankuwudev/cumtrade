// The trading wallet's provider (public-release W1.1), over a scripted facade
// and a scripted RPC. The facade stands in for Coinbase: it records what it is
// asked to sign and returns a real EIP-1559 envelope with a made-up signature,
// so nothing here holds a key. The RPC stands in for the chain's public
// endpoint: it decodes each raw transaction, keeps the pending nonce, and
// answers the verifier's reads from the same fixture chain as
// sequence.test.js. Nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, parseTransaction, serializeTransaction, toHex } from "viem";
import { CHAIN_ID, MAX_BASE_FEE_WEI, MAX_GAS, MAX_SENDS_PER_MINUTE, PUBLIC_RPC, READ } from "../public/js/trade/constants.js";
import { SENDS_KEY, createEmbeddedProvider, start } from "../public/js/wallet/embedded.js";
import { PROJECTS, projectFor, usable } from "../public/js/wallet/projects.js";
import { walletError } from "../public/js/wallet/eip6963.js";
import { readIdentity, verifyPlan } from "../public/js/trade/verify.js";
import { verifyQuote } from "../public/js/trade/quote.js";
import { createSequence } from "../public/js/trade/sequence.js";
import { word } from "./support/calldata.js";

const { chain, plans } = JSON.parse(readFileSync(new URL("./fixtures/plans.json", import.meta.url), "utf8"));
const fixture = (name) => structuredClone(plans.find((p) => p.name === name));
const lower = (a) => String(a).toLowerCase();
const yieldNow = () => new Promise((r) => setImmediate(r));

/** The trading wallet in every test: the fixture plans' own sender. */
const TRADER = plans[0].intent.from;
const OTHER = "0x000000000000000000000000000000000000B0b0";
const TOKEN_TO = "0x000000000000000000000000000000000000C0A1";
const OUR_ORIGIN = "https://clank.example";
const T0 = 1_789_562_978_000;
/** A made-up project ID, shaped like the portal's. Not anyone's project. */
const FAKE_PROJECT = "00000000-0000-4000-8000-000000000001";

// ------------------------------------------------------------ doubles --

/** Coinbase, as the facade presents it: who is logged in, and a signer. */
function facade(shared = { log: [] }) {
  const f = {
    who: TRADER, signed: [], log: shared.log, asked: 0,
    /** Set to return something that is not a signed transaction. */
    raw: null,
    async address() { f.asked++; return f.who; },
    async signTransaction(tx) {
      f.signed.push(tx);
      f.log.push(`sign:${tx.nonce}`);
      if (f.raw !== null) return f.raw;
      // A real envelope with a made-up signature: nothing here holds a key.
      return serializeTransaction(tx, { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, yParity: 0 });
    },
  };
  return f;
}

/** Web Locks as a browser grants them: one holder per name, in request order. */
function webLocks() {
  const tails = new Map();
  return {
    request(name, options, fn) {
      assert.equal(options.mode, "exclusive");
      const run = (tails.get(name) ?? Promise.resolve()).then(() => fn());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

/** localStorage, shared between the tabs a test opens. */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

/**
 * The chain's public RPC, behind a scripted fetch. It records every URL and
 * request, keeps the pending nonce, decodes each broadcast, and mines it.
 */
function rpcChain({ baseFee = 20_000_000n, nonce = 7, now = plans[0].plan.preparedAt } = {}) {
  const c = {
    baseFee, nonce, now, urls: [], inits: [], calls: [], log: null, raws: [], txs: [], receipts: new Map(),
    balance: 50_000_000n * 10n ** 18n, erc20: 0n, p2: { amount: 0n, expiration: 0n },
    /** (method) → Promise, to hold an answer back. */
    hold: null,
    /** What happens to a broadcast's answer after the chain took it: "lose" (the connection drops) or "garble". */
    afterRaw: null,
  };
  const curves = Object.fromEntries(Object.entries(chain.tokens).map(([t, v]) => [lower(v.curve), { token: t, ...v }]));
  const tokenRow = (a) => chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === lower(a))];
  const reverted = (sel, to) => ({ error: { code: 3, message: `execution reverted: ${sel} on ${to}` } });
  // The verifier's reads, as sequence.test.js's wallet answers them.
  const answerCall = ({ to, data }) => {
    const sel = data.slice(0, 10), at = lower(to), row = tokenRow(to);
    if (sel === READ.curve && row) return `0x${word(row.curve)}`;
    if (sel === READ.balanceOf && row) return `0x${word(c.balance)}`;
    if (sel === READ.allowance && row) return `0x${word(c.erc20)}`;
    if (sel === READ.permit2Allowance) return `0x${word(c.p2.amount)}${word(c.p2.expiration)}${word(0)}`;
    if (curves[at]) {
      if (sel === READ.token) return `0x${word(curves[at].token)}`;
      if (sel === READ.factory) return `0x${word(chain.factory)}`;
      if (sel === READ.graduated) return `0x${word(curves[at].graduated ? 1 : 0)}`;
    }
    if (at === lower(chain.factory)) {
      if (sel === READ.memeHook) return `0x${word(chain.memeHook)}`;
      if (sel === READ.getLaunchedToken) {
        const r = tokenRow(`0x${data.slice(-40)}`);
        return r ? `0x${word(`0x${data.slice(-40)}`)}${word(r.curve)}${word(0).repeat(13)}` : `0x${word(0).repeat(15)}`;
      }
    }
    return reverted(sel, to);
  };
  const grant = (tx) => {
    const sel = tx.data.slice(0, 10), args = tx.data.slice(10);
    if (sel === "0x095ea7b3") c.erc20 = BigInt(`0x${args.slice(64, 128)}`);
    if (sel === "0x87517c45") c.p2 = { amount: BigInt(`0x${args.slice(128, 192)}`), expiration: BigInt(`0x${args.slice(192, 256)}`) };
  };
  const answer = (method, params) => {
    switch (method) {
      case "eth_chainId": return toHex(CHAIN_ID);
      case "eth_getTransactionCount": return c.nonceAnswer !== undefined ? c.nonceAnswer : toHex(c.nonce);
      case "eth_getBlockByNumber": return { number: "0x10", timestamp: toHex(c.now), baseFeePerGas: c.baseFee === null ? undefined : toHex(c.baseFee) };
      case "eth_getBalance": return toHex(c.balance);
      case "eth_estimateGas": return "0x5208";
      case "eth_call": return answerCall(params[0]);
      case "eth_sendRawTransaction": {
        const raw = params[0];
        const tx = parseTransaction(raw);
        if (tx.nonce !== c.nonce) return { error: { code: -32000, message: `nonce too low: next nonce ${c.nonce}, tx nonce ${tx.nonce}` } };
        c.nonce++;
        c.raws.push(raw);
        c.txs.push(tx);
        const hash = keccak256(raw);
        c.receipts.set(hash, tx);
        c.log?.push(`raw:${tx.nonce}`);
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const tx = c.receipts.get(params[0]);
        if (!tx) return null;
        grant(tx);
        return { transactionHash: params[0], status: "0x1", logs: [] };
      }
      case "eth_getTransactionByHash": {
        const tx = c.receipts.get(params[0]);
        return tx ? { hash: params[0], nonce: toHex(tx.nonce) } : null;
      }
    }
    return { error: { code: -32601, message: `the method ${method} does not exist` } };
  };
  c.fetch = async (url, init) => {
    c.urls.push(String(url));
    c.inits.push(init);
    const { id, method, params } = JSON.parse(init.body);
    c.calls.push({ method, params });
    c.log?.push(method);
    if (c.hold) await c.hold(method);
    const out = answer(method, params);
    if (method === "eth_sendRawTransaction" && typeof out === "string") {
      if (c.afterRaw === "lose") throw new TypeError("Failed to fetch");
      if (c.afterRaw === "garble") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0xnot-a-hash" }) };
    }
    const body = out && typeof out === "object" && "error" in out ? { jsonrpc: "2.0", id, error: out.error } : { jsonrpc: "2.0", id, result: out };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return c;
}

/** One tab: a provider over the given facade, chain, locks and storage. */
function tab({ f, c, locks = webLocks(), storage = memoryStorage(), now = () => T0 } = {}) {
  return createEmbeddedProvider({ facade: f, fetch: c.fetch, locks, storage: () => storage, now, fastRpc: null });
}

const send = (p, tx = {}) => p.request({
  method: "eth_sendTransaction",
  params: [{ from: TRADER, to: TOKEN_TO, data: "0xabcdef", value: "0x2386f26fc10000", gas: "0x2f9b8", ...tx }],
});
const refusal = async (promise) => {
  try { await promise; } catch (e) { return e; }
  assert.fail("expected a refusal");
};

// ---------------------------------------------------------------- reads --

test("every read, and the broadcast, goes to the public RPC and none to our origin", async () => {
  globalThis.location = { origin: OUR_ORIGIN };
  const f = facade(), c = rpcChain();
  const p = tab({ f, c });
  for (const [method, params] of [
    ["eth_chainId", []], ["eth_call", [{ to: TOKEN_TO, data: READ.graduated }, "latest"]],
    ["eth_getBlockByNumber", ["latest", false]], ["eth_getTransactionReceipt", [`0x${"0".repeat(64)}`]],
    ["eth_getBalance", [TRADER, "latest"]], ["eth_getTransactionCount", [TRADER, "latest"]],
    ["eth_estimateGas", [{ from: TRADER, to: OTHER, value: "0x1" }]],
  ]) await p.request({ method, params });
  await send(p);
  // The chain id is the provider's own answer: it signs only for 4663.
  assert.equal(await p.request({ method: "eth_chainId" }), `0x${CHAIN_ID.toString(16)}`);
  assert.deepEqual(c.calls.map((x) => x.method), [
    "eth_call", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getBalance",
    "eth_getTransactionCount", "eth_estimateGas",
    "eth_getTransactionCount", "eth_getBlockByNumber", "eth_sendRawTransaction",
  ]);
  assert.equal(PUBLIC_RPC, "https://rpc.mainnet.chain.robinhood.com");
  assert.ok(c.urls.every((u) => u === PUBLIC_RPC), c.urls.join(" "));
  assert.ok(!c.urls.some((u) => u.startsWith("/") || u.startsWith(OUR_ORIGIN)));
  // No cookies and no referrer go with them.
  assert.ok(c.inits.every((i) => i.method === "POST" && i.credentials === "omit" && i.referrerPolicy === "no-referrer"));
  delete globalThis.location;
});

test("an RPC error keeps its code, and anything else the wallet is asked is refused with 4200", async () => {
  const f = facade(), c = rpcChain();
  const p = tab({ f, c });
  const reverted = await refusal(p.request({ method: "eth_call", params: [{ to: OTHER, data: "0x12345678" }, "latest"] }));
  assert.equal(reverted.code, 3);
  assert.match(reverted.message, /execution reverted/);
  for (const method of ["eth_sign", "personal_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain", "eth_requestAccounts", "eth_sendRawTransactionSync"]) {
    const e = await refusal(p.request({ method, params: [] }));
    assert.equal(e.code, 4200, method);
    assert.equal(walletError(e, method), `This wallet cannot do that (${method}).`);
  }
  assert.equal(f.signed.length, 0);
  assert.equal(c.calls.length, 1, "only the eth_call reached the RPC");
});

// ------------------------------------------------------------- accounts --

test("eth_accounts is the logged-in address, and empty when logged out", async () => {
  const f = facade(), c = rpcChain();
  const p = tab({ f, c });
  assert.deepEqual(await p.request({ method: "eth_accounts" }), [TRADER]);
  f.who = null;
  assert.deepEqual(await p.request({ method: "eth_accounts" }), []);
  assert.equal(c.calls.length, 0, "the account comes from the login, not the chain");
});

// ---------------------------------------------------------------- sends --

test("a send from any other address, or with no one logged in, is refused before anything is read or signed", async () => {
  const f = facade(), c = rpcChain();
  const p = tab({ f, c });
  let e = await refusal(send(p, { from: OTHER }));
  assert.equal(e.code, 4100);
  assert.match(e.message, /Nothing was signed\.$/);
  e = await refusal(send(p, { from: undefined }));
  assert.equal(e.code, 4100);
  f.who = null;
  e = await refusal(send(p));
  assert.equal(e.code, 4100);
  assert.equal(e.message, "Log in to trade. Nothing was signed.");
  assert.equal(f.signed.length, 0);
  assert.equal(c.calls.length, 0);
  // The case of the address does not matter.
  f.who = TRADER;
  await send(p, { from: TRADER.toLowerCase() });
  assert.equal(f.signed.length, 1);
});

test("nonce, fees, chain ID and type are filled in as specified", async () => {
  const f = facade(), c = rpcChain({ baseFee: 20_000_000n, nonce: 7 });
  const p = tab({ f, c });
  await send(p);
  assert.deepEqual(c.calls.find((x) => x.method === "eth_getTransactionCount").params, [TRADER, "pending"]);
  assert.deepEqual(c.calls.find((x) => x.method === "eth_getBlockByNumber").params, ["latest", false]);
  const want = {
    from: TRADER, type: "eip1559", chainId: 4663, nonce: 7, to: TOKEN_TO, data: "0xabcdef",
    value: 10n ** 16n, gas: 0x2f9b8n, maxFeePerGas: 40_000_000n, maxPriorityFeePerGas: 0n,
  };
  assert.deepEqual(f.signed, [want]);
  // And the bytes that went out say the same.
  const tx = c.txs[0];
  assert.equal(tx.type, "eip1559");
  assert.equal(tx.chainId, CHAIN_ID);
  assert.equal(tx.nonce, 7);
  assert.equal(lower(tx.to), lower(TOKEN_TO));
  assert.equal(tx.data, "0xabcdef");
  assert.equal(tx.value, 10n ** 16n);
  assert.equal(tx.gas, 0x2f9b8n);
  assert.equal(tx.maxFeePerGas, 40_000_000n);
  assert.equal(tx.maxPriorityFeePerGas ?? 0n, 0n);
});

test("the signed raw transaction goes to the RPC, and its hash comes back", async () => {
  const f = facade(), c = rpcChain();
  const p = tab({ f, c });
  const hash = await send(p);
  assert.equal(c.raws.length, 1);
  const raw = c.raws[0];
  assert.deepEqual(c.calls.at(-1), { method: "eth_sendRawTransaction", params: [raw] });
  assert.equal(raw, serializeTransaction(f.signed[0], { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, yParity: 0 }), "exactly what the signer returned");
  assert.equal(hash, keccak256(raw));
});

test("the hash is the signed bytes' own, whatever the RPC answers", async () => {
  const f = facade(), c = rpcChain();
  c.afterRaw = "garble";
  const hash = await send(tab({ f, c }));
  assert.equal(hash, keccak256(c.raws[0]));
});

test("a broadcast whose answer was lost, but which reached the chain, is not reported as failed", async () => {
  const f = facade(), c = rpcChain();
  c.afterRaw = "lose";
  const hash = await send(tab({ f, c }));
  assert.equal(hash, keccak256(c.raws[0]));
  assert.deepEqual(c.calls.at(-1), { method: "eth_getTransactionByHash", params: [hash] });
});

test("a broadcast the chain refused is reported with the node's code, and no hash is claimed", async () => {
  const f = facade(), c = rpcChain({ nonce: 9 });
  const p = tab({ f, c });
  // Another wallet with this key moves the nonce between the read and the broadcast.
  c.hold = async (method) => { if (method === "eth_sendRawTransaction") c.nonce = 10; };
  const e = await refusal(send(p));
  assert.equal(e.code, -32000);
  assert.match(e.message, /nonce too low/);
  assert.equal(c.calls.at(-1).method, "eth_getTransactionByHash", "it asked whether the chain had it anyway");
  assert.equal(c.raws.length, 0);
});

test("a signer that returns no signed EIP-1559 transaction broadcasts nothing", async () => {
  for (const bad of ["0x", "0xf86c", "not hex", 42]) {
    const f = facade(), c = rpcChain();
    f.raw = bad;
    const e = await refusal(send(tab({ f, c })));
    assert.equal(e.code, -32603, String(bad));
    assert.equal(c.raws.length, 0);
    assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
  }
});

test("a send with no recipient, bad data, a bad value or a gas limit that is missing or over the cap is refused unsigned", async () => {
  for (const tx of [
    { to: undefined }, { to: "0x1234" }, { data: "0xabc" }, { data: "zz" }, { value: "-1" }, { value: "0.5" },
    { gas: undefined }, { gas: "0x0" }, { gas: toHex(MAX_GAS + 1) },
  ]) {
    const f = facade(), c = rpcChain();
    const e = await refusal(send(tab({ f, c }), tx));
    assert.equal(e.code, -32602, JSON.stringify(tx));
    assert.equal(f.signed.length, 0);
  }
  // At the cap exactly, and with no data or value, it signs.
  const f = facade(), c = rpcChain();
  await send(tab({ f, c }), { gas: toHex(MAX_GAS), data: undefined, value: undefined });
  assert.equal(f.signed[0].gas, BigInt(MAX_GAS));
  assert.equal(f.signed[0].data, "0x");
  assert.equal(f.signed[0].value, 0n);
});

// ------------------------------------------------------------ one at a time --

test("two concurrent sends, from two tabs, run one after the other", async () => {
  const shared = { log: [] };
  const f1 = facade(shared), f2 = facade(shared), c = rpcChain({ nonce: 7 });
  c.log = shared.log;
  const locks = webLocks(), storage = memoryStorage();
  // The broadcast is slow, so an unguarded second send would read the same nonce.
  c.hold = async (method) => { if (method === "eth_sendRawTransaction") for (let i = 0; i < 20; i++) await yieldNow(); };
  const a = tab({ f: f1, c, locks, storage }), b = tab({ f: f2, c, locks, storage });
  const [h1, h2] = await Promise.all([send(a), send(b, { data: "0x01" })]);
  assert.notEqual(h1, h2);
  assert.deepEqual(c.txs.map((t) => t.nonce), [7, 8]);
  const firstRaw = shared.log.indexOf("raw:7");
  const secondNonce = shared.log.indexOf("eth_getTransactionCount", shared.log.indexOf("eth_getTransactionCount") + 1);
  assert.ok(firstRaw >= 0 && firstRaw < secondNonce, `the second send read its nonce only after the first was broadcast: ${shared.log.join(" ")}`);
});

test("a send that waited for the lock is refused if the session ended meanwhile", async () => {
  const shared = { log: [] };
  const f = facade(shared), c = rpcChain();
  const locks = webLocks(), storage = memoryStorage();
  let release;
  const gate = new Promise((r) => { release = r; });
  c.hold = async (method) => { if (method === "eth_sendRawTransaction") await gate; };
  const a = tab({ f, c, locks, storage }), b = tab({ f, c, locks, storage });
  const first = send(a);
  const second = send(b);
  for (let i = 0; i < 10; i++) await yieldNow();
  f.who = null;
  release();
  await first;
  const e = await refusal(second);
  assert.equal(e.code, 4100);
  assert.equal(f.signed.length, 1, "only the send that held the lock was signed");
});

test("a browser without Web Locks signs nothing", async () => {
  const f = facade(), c = rpcChain();
  const p = createEmbeddedProvider({ facade: f, fetch: c.fetch, locks: undefined, storage: () => memoryStorage(), now: () => T0, fastRpc: null });
  const e = await refusal(send(p));
  assert.equal(e.code, -32603);
  assert.match(e.message, /two tabs/);
  assert.equal(f.signed.length, 0);
});

// ------------------------------------------------------------ rate guard --

test(`the ${MAX_SENDS_PER_MINUTE + 1}th send in a minute is refused with nothing signed, and a minute later one goes`, async () => {
  assert.equal(MAX_SENDS_PER_MINUTE, 12);
  let now = T0;
  const f = facade(), c = rpcChain(), storage = memoryStorage();
  const p = tab({ f, c, storage, now: () => now });
  for (let i = 0; i < 12; i++) { await send(p); now += 1_000; }
  const e = await refusal(send(p));
  assert.equal(e.code, -32005);
  assert.equal(e.message, "Too many transactions in a minute. Nothing was sent.");
  assert.equal(walletError(e), "-32005: Too many transactions in a minute. Nothing was sent.");
  assert.equal(f.signed.length, 12);
  assert.equal(c.calls.length, 36, "twelve sends of three calls each, and nothing read for the thirteenth");
  // The first send falls out of the window exactly a minute after it.
  now = T0 + 60_000 - 1;
  assert.equal((await refusal(send(p))).code, -32005);
  now = T0 + 60_000;
  await send(p);
  assert.equal(f.signed.length, 13);
});

test("the guard counts across tabs, and keeps no address in storage", async () => {
  const f = facade(), c = rpcChain(), storage = memoryStorage(), locks = webLocks();
  const a = tab({ f, c, storage, locks }), b = tab({ f, c, storage, locks });
  for (let i = 0; i < 6; i++) { await send(a); await send(b); }
  assert.equal((await refusal(send(a))).code, -32005);
  assert.equal((await refusal(send(b))).code, -32005);
  assert.equal(f.signed.length, 12);
  assert.deepEqual(Object.keys(storage.dump()), [SENDS_KEY]);
  assert.doesNotMatch(JSON.stringify(storage.dump()), /0x/i);
  assert.deepEqual(JSON.parse(storage.dump()[SENDS_KEY]), Array(12).fill(T0));
});

test("with storage blocked or unreadable, a tab still counts its own sends", async () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  for (const storage of [() => { throw new Error("no storage"); }, () => null, () => blocked]) {
    const f = facade(), c = rpcChain();
    const p = createEmbeddedProvider({ facade: f, fetch: c.fetch, locks: webLocks(), storage, now: () => T0, fastRpc: null });
    for (let i = 0; i < 12; i++) await send(p);
    assert.equal((await refusal(send(p))).code, -32005);
    assert.equal(f.signed.length, 12);
  }
  // Garbage in storage counts as nothing, and a clock that went back counts nothing from the future.
  const s = memoryStorage();
  s.setItem(SENDS_KEY, "{not json");
  const f = facade(), c = rpcChain();
  await send(tab({ f, c, storage: s }));
  s.setItem(SENDS_KEY, JSON.stringify(Array(12).fill(T0 + 3_600_000)));
  await send(tab({ f, c, storage: s }));
  assert.equal(f.signed.length, 2);
});

test("a failed signature still counts: the guard records before signing", async () => {
  const f = facade(), c = rpcChain(), storage = memoryStorage();
  f.raw = "0x";
  const p = tab({ f, c, storage });
  for (let i = 0; i < 12; i++) assert.equal((await refusal(send(p))).code, -32603);
  f.raw = null;
  assert.equal((await refusal(send(p))).code, -32005);
});

// ------------------------------------------------------------- fee ceiling --

test("a base fee over the ceiling is refused with nothing signed; at the ceiling it signs", async () => {
  assert.equal(MAX_BASE_FEE_WEI, 10n * 10n ** 9n);
  let f = facade(), c = rpcChain({ baseFee: MAX_BASE_FEE_WEI + 1n });
  const e = await refusal(send(tab({ f, c })));
  assert.equal(e.code, -32003);
  assert.equal(e.message, "The network fee is 10.0 gwei, over the 10.0 gwei ceiling. Nothing was signed.");
  assert.equal(f.signed.length, 0);
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));

  f = facade(); c = rpcChain({ baseFee: MAX_BASE_FEE_WEI });
  await send(tab({ f, c }));
  assert.equal(f.signed[0].maxFeePerGas, 2n * MAX_BASE_FEE_WEI);

  f = facade(); c = rpcChain({ baseFee: null });
  assert.equal((await refusal(send(tab({ f, c })))).code, -32603, "no base fee reported");
  assert.equal(f.signed.length, 0);
});

test("a nonce the chain did not give is never guessed", async () => {
  for (const answer of [null, "", "pending", "-0x1", "0x20000000000000"]) {
    const f = facade(), c = rpcChain();
    c.nonceAnswer = answer;
    const e = await refusal(send(tab({ f, c })));
    assert.equal(e.code, -32603, String(answer));
    assert.equal(e.message, "Robinhood Chain gave no nonce. Nothing was signed.");
    assert.equal(f.signed.length, 0);
  }
});

test("a refused fee does not use up the minute's sends", async () => {
  const f = facade(), c = rpcChain({ baseFee: MAX_BASE_FEE_WEI * 2n }), storage = memoryStorage();
  const p = tab({ f, c, storage });
  for (let i = 0; i < 20; i++) assert.equal((await refusal(send(p))).code, -32003);
  c.baseFee = 20_000_000n;
  await send(p);
  assert.equal(f.signed.length, 1);
});

// ------------------------------------------------------------ the origin --

test("an unknown origin gets no wallet, and the SDK is never loaded for it", async () => {
  let loads = 0;
  const load = async () => { loads++; return { init: async () => {}, address: async () => null, signTransaction: async () => "0x" }; };
  const mine = [{ name: "staging", origin: "https://staging.clank.example", projectId: FAKE_PROJECT }];
  for (const origin of [
    "https://evil.example", "https://staging.clank.example:8443", "http://staging.clank.example",
    "https://staging.clank.example/", "https://sub.staging.clank.example", "", undefined, "null",
  ]) {
    await assert.rejects(start({ origin, load, projects: mine }), /no trading wallet on this site/, String(origin));
  }
  assert.equal(loads, 0);
  // The listed origin loads it, and starts it for its own project.
  let started = null;
  const { facade: got, provider } = await start({
    origin: "https://staging.clank.example", projects: mine,
    load: async () => { loads++; return { init: async (o) => { started = o; }, address: async () => TRADER, signTransaction: async () => "0x" }; },
  });
  assert.equal(loads, 1);
  assert.deepEqual(started, { projectId: FAKE_PROJECT });
  assert.equal(typeof got.address, "function");
  assert.deepEqual(await provider.request({ method: "eth_accounts" }), [TRADER]);
});

test("projectFor: exact origins, filled entries and one entry per origin only", () => {
  const ok = { name: "a", origin: "https://a.example", projectId: FAKE_PROJECT };
  assert.equal(projectFor("https://a.example", [ok]), FAKE_PROJECT);
  assert.equal(projectFor("http://localhost:8787", [{ ...ok, origin: "http://localhost:8787" }]), FAKE_PROJECT);
  for (const [why, list, origin] of [
    ["an empty ID", [{ ...ok, projectId: "" }], ok.origin],
    ["an ID of another shape", [{ ...ok, projectId: "my-project" }], ok.origin],
    ["an empty origin", [{ ...ok, origin: "" }], ""],
    ["http off localhost", [{ ...ok, origin: "http://a.example" }], "http://a.example"],
    ["an origin with a path", [{ ...ok, origin: "https://a.example/app" }], "https://a.example/app"],
    ["two entries for one origin", [ok, { ...ok, name: "b" }], ok.origin],
    ["another origin", [ok], "https://b.example"],
  ]) assert.equal(projectFor(origin, list), null, why);
});

test("the committed map: well formed, and only the origins the user shared have a wallet", () => {
  const origins = PROJECTS.map((p) => p.origin).filter(Boolean);
  assert.equal(new Set(origins).size, origins.length, "no origin twice");
  for (const p of PROJECTS) {
    assert.ok(Object.isFrozen(p));
    const empty = p.origin === "" && p.projectId === "";
    assert.ok(empty || usable(p), `${p.name}: either both empty or both filled in correctly`);
    if (p.name === "production" && !empty) assert.ok(!/localhost|127\.0\.0\.1/.test(p.origin), "production is never local");
  }
  assert.ok(Object.isFrozen(PROJECTS));
  // The user shared two projects: the web app on their own machine
  // (2026-09-22), and production (2026-09-23). Production moved to
  // clankuwu.com on the same project (L1 N-D5, 2026-09-24). cumtrade.com
  // only redirects since L5, so it gets no wallet. Staging waits on the user.
  const filled = PROJECTS.filter((p) => p.origin !== "" || p.projectId !== "");
  assert.deepEqual(filled.map((p) => [p.name, p.origin]),
    [["staging-local", "http://localhost:8790"], ["production", "https://clankuwu.com"]],
    "fill in only the IDs the user shares");
  assert.equal(projectFor("http://localhost:8790"), "5fa3921d-9617-48e5-a02e-bb0540fb6203");
  assert.equal(projectFor("https://clankuwu.com"), "71cd77b1-e4a1-4bc6-8d53-8ec5c0e549b6");
  for (const origin of ["http://localhost:8787", "http://127.0.0.1:8790", "http://localhost:8791", OUR_ORIGIN,
    "https://www.clankuwu.com", "http://clankuwu.com", "https://clankuwu.com:8443", "https://api.clankuwu.com",
    "https://cumtrade.com", "https://www.cumtrade.com", "http://cumtrade.com", "https://cumtrade.com:8443"]) {
    assert.equal(projectFor(origin), null, origin);
  }
});

// ------------------------------------------------- the sequence, unchanged --

/** F3.2's sequence, wired exactly as sequence.test.js wires it, over the embedded provider. */
function trade(name) {
  const fx = fixture(name);
  const f = facade(), c = rpcChain({ nonce: 0, now: fx.plan.preparedAt });
  const provider = tab({ f, c });
  const updates = [];
  const seq = createSequence({
    provider: () => provider,
    prepare: async () => ({ status: 200, data: structuredClone(fx.plan) }),
    readIdentity, verifyPlan, verifyQuote,
    readQuote: async (_request, plan) => BigInt(plan.quote.expectedOut),
    acknowledge: async () => true,
    confirm: async () => true,
    update: (s) => updates.push(s.phase),
    sleep: yieldNow, pollMs: 1, receiptMs: 5, backgroundMs: 20,
  });
  const input = fx.intent.side === "buy"
    ? { side: "buy", from: fx.intent.from, token: fx.intent.token, amountEth: "0.01", slippageBps: fx.intent.slippageBps }
    : { side: "sell", from: fx.intent.from, token: fx.intent.token, tokens: fx.intent.tokens, slippageBps: fx.intent.slippageBps };
  return { fx, f, c, seq, input, updates };
}

for (const name of ["curve buy", "curve sell with approval", "v4 sell with both approvals", "v4 buy"]) {
  test(`the sequence, unchanged, trades through the embedded provider: ${name}`, async () => {
    const t = trade(name);
    const out = await t.seq.start(t.input);
    assert.equal(out.phase, "done", out.message);
    const steps = t.fx.plan.steps;
    assert.equal(t.c.txs.length, steps.length);
    t.c.txs.forEach((tx, i) => {
      assert.equal(tx.chainId, CHAIN_ID);
      assert.equal(tx.type, "eip1559");
      assert.equal(tx.nonce, i, "one nonce after another");
      assert.equal(lower(tx.to), lower(steps[i].to));
      assert.equal(lower(tx.data), lower(steps[i].data));
      // viem decodes a zero value as absent.
      assert.equal(tx.value ?? 0n, BigInt(steps[i].value));
      assert.equal(tx.gas, BigInt(steps[i].gas));
    });
    assert.ok(t.c.urls.every((u) => u === PUBLIC_RPC), "every read and receipt went to the public RPC");
  });
}

test("the sequence over the embedded provider: a plan for another sender is voided before anything is signed", async () => {
  const t = trade("curve buy");
  t.f.who = OTHER;
  const out = await t.seq.start(t.input);
  assert.equal(out.phase, "void", out.message);
  assert.equal(t.f.signed.length, 0);
});

test("the sequence over the embedded provider: a refusal is worded, resumable, and nothing is sent twice", async () => {
  const t = trade("curve buy");
  t.c.baseFee = MAX_BASE_FEE_WEI * 3n;
  let out = await t.seq.start(t.input);
  assert.equal(out.phase, "error");
  assert.equal(out.message, "-32003: The network fee is 30.0 gwei, over the 10.0 gwei ceiling. Nothing was signed.");
  assert.equal(t.f.signed.length, 0);
  t.c.baseFee = 20_000_000n;
  out = await t.seq.resume();
  assert.equal(out.phase, "done", out.message);
  assert.equal(t.c.txs.length, 1);
});

// ------------------------------------------------ the fast RPC (2026-09-23) --

const FAST = "https://fast.rpc.test/v2/key";

/**
 * A provider whose fast RPC behaves as `fast` says for each call: "ok" (the
 * scripted chain answers), "down" (unreachable), "500", "refused" (the origin
 * is not on its allowlist, -32600) or "busy" (429). The public RPC always
 * answers through the scripted chain.
 */
function fastTab(fast) {
  const f = facade(), c = rpcChain();
  const seen = [];
  const fetch = async (url, init) => {
    const { id, method } = JSON.parse(init.body);
    seen.push(`${url === FAST ? "fast" : url === PUBLIC_RPC ? "public" : url}:${method}`);
    if (url === FAST) {
      const how = typeof fast === "function" ? fast(method) : fast;
      if (how === "down") throw new TypeError("Failed to fetch");
      if (how === "500") return { ok: false, status: 500, json: async () => ({}) };
      if (how === "refused") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, error: { code: -32600, message: "Origin not on whitelist." } }) };
      if (how === "busy") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, error: { code: 429, message: "Too Many Requests" } }) };
    }
    return c.fetch(url, init);
  };
  const p = createEmbeddedProvider({ facade: f, fetch, locks: webLocks(), storage: () => memoryStorage(), now: () => T0, fastRpc: FAST });
  return { p, c, seen };
}
const block = (p) => p.request({ method: "eth_getBlockByNumber", params: ["latest", false] });

test("the fast RPC answers the reads, and the public one is not asked", async () => {
  const { p, seen } = fastTab("ok");
  await block(p);
  await p.request({ method: "eth_call", params: [{ to: TOKEN_TO, data: READ.graduated }, "latest"] });
  assert.deepEqual(seen, ["fast:eth_getBlockByNumber", "fast:eth_call"]);
});

test("a fast RPC that is down, errs or is busy hands that read to the public one, and is tried again next time", async () => {
  for (const how of ["down", "500", "busy"]) {
    const { p, seen } = fastTab(how);
    await block(p);
    await block(p);
    assert.deepEqual(seen, ["fast:eth_getBlockByNumber", "public:eth_getBlockByNumber",
      "fast:eth_getBlockByNumber", "public:eth_getBlockByNumber"], how);
  }
});

test("a fast RPC that refuses this origin is left for the session", async () => {
  const { p, seen } = fastTab("refused");
  await block(p);
  await block(p);
  assert.deepEqual(seen, ["fast:eth_getBlockByNumber", "public:eth_getBlockByNumber", "public:eth_getBlockByNumber"]);
});

test("the chain's own answer, a revert, is never asked again of the other RPC", async () => {
  const { p, seen } = fastTab("ok");
  const e = await refusal(p.request({ method: "eth_call", params: [{ to: OTHER, data: "0x12345678" }, "latest"] }));
  assert.equal(e.code, 3);
  assert.deepEqual(seen, ["fast:eth_call"]);
});

test("a send is broadcast to both RPCs, and one taking it is enough", async () => {
  const both = fastTab("ok");
  await send(both.p);
  assert.deepEqual(both.seen.filter((s) => s.endsWith("eth_sendRawTransaction")).sort(),
    ["fast:eth_sendRawTransaction", "public:eth_sendRawTransaction"]);
  const oneDown = fastTab((m) => (m === "eth_sendRawTransaction" ? "down" : "ok"));
  const hash = await send(oneDown.p);
  assert.match(hash, /^0x[0-9a-f]{64}$/, "the public RPC took it");
});
