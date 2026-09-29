import { CHAIN_ID, FAST_RPC, MAX_BASE_FEE_WEI, MAX_GAS, MAX_SENDS_PER_MINUTE, PUBLIC_RPC } from "../trade/constants.js";
import { keccak256 } from "../trade/keccak.js";
import { PROJECTS, projectFor } from "./projects.js";

// ====================================================================== //
// the trading wallet                                                     //
// ====================================================================== //
//
// An EIP-1193 provider over the visitor's embedded wallet at Coinbase
// (public-release W1.1). F3.2's signing sequence uses it unchanged, exactly as
// it uses a browser wallet: `trade/sequence.js` is still the one door that
// sends, and this is the signer behind it (scripts/check-web.mjs allows the
// two of them, and only them, to name eth_sendTransaction).
//
// - Reads, receipts and the broadcast go straight to the chain, never to our
//   origin: a compromised server cannot lie to the verifier. Reads try the
//   fast RPC first and fall back to the public one when it cannot answer; a
//   send goes to both. The chain id is answered here: this wallet only ever
//   signs for chain 4663.
// - A send is signed only for the logged-in address, one at a time per
//   address across every tab of this site (Web Locks), at most 12 a minute
//   from this browser, and never when the base fee is over 10 gwei. Its nonce
//   and fees are filled in here, for chain 4663, as EIP-1559.
// - Coinbase's SDK is the vendored facade in /vendor/wallet.js, loaded only
//   by `start`, and this is the only module allowed to import it.
//
// It keeps no key and cannot see one: signing happens at Coinbase.

/** The methods the public RPC answers for us. */
const TO_RPC = new Set([
  "eth_call", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getBalance",
  "eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction",
]);

/** Where this browser counts its recent sends: timestamps only, never an address. */
export const SENDS_KEY = "clank.sends";
const MINUTE_MS = 60_000;
const RPC_TIMEOUT_MS = 20_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/** An error with an EIP-1193 code, so walletError words it as it does a browser wallet's. */
const fail = (code, message) => Object.assign(new Error(message), { code });

/** A JSON-RPC quantity (hex, a decimal string, a number or a bigint) as a bigint, or null. */
function quantity(x) {
  if (typeof x === "bigint") return x >= 0n ? x : null;
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null;
  if (typeof x === "string" && (/^0x[0-9a-fA-F]+$/.test(x) || /^\d+$/.test(x))) return BigInt(x);
  return null;
}

const gwei = (wei) => (Number(wei) / 1e9).toFixed(wei < 10n ** 9n ? 3 : 1);

// -------------------------------------------------------------- starting --

/**
 * Start the trading wallet on this origin: find its pinned Coinbase project,
 * load the vendored SDK, and start it. An origin with no project gets no
 * wallet, and the SDK is never fetched for it. Resolves to the facade (for
 * logging in and out) and the provider (for the sequence).
 *
 * The page calls this on a login click or a remembered session only, so the
 * board loads as fast as it did before the trading wallet (TW10). It passes
 * no options: `load` and `projects` are for tests.
 */
export async function start({
  origin = globalThis.location?.origin, load = () => import("../../vendor/wallet.js"), projects = PROJECTS,
} = {}) {
  const projectId = projectFor(origin, projects);
  if (!projectId) throw new Error("There is no trading wallet on this site.");
  const facade = await load();
  await facade.init({ projectId });
  return { facade, provider: createEmbeddedProvider({ facade }) };
}

// -------------------------------------------------------------- provider --

/**
 * @param {{
 *   facade: { address: () => Promise<string | null>, signTransaction: (tx: object) => Promise<string> },
 *   fetch?: typeof fetch,
 *   locks?: { request: (name: string, options: object, fn: () => Promise<any>) => Promise<any> },
 *   storage?: () => (Storage | null),
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   fastRpc?: string | null,
 * }} d
 */
export function createEmbeddedProvider(d) {
  const facade = d.facade;
  const fetchFn = d.fetch ?? ((...a) => globalThis.fetch(...a));
  const locks = "locks" in d ? d.locks : globalThis.navigator?.locks;
  const storage = d.storage ?? (() => globalThis.localStorage ?? null);
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? ((line) => globalThis.console?.info(line));
  const guard = sendGuard(storage, now);
  let id = 0;

  // The fast RPC is left for the rest of the session once it refuses this
  // origin: a page not on its allowlist should not pay a failed call per read.
  const fast = "fastRpc" in d ? d.fastRpc : FAST_RPC;
  let fastOn = typeof fast === "string" && fast !== "";

  /**
   * A failure that says nothing about the chain, so the other RPC may answer:
   * unreachable, an HTTP error, a refused origin, or a rate limit. A revert or
   * any other answer from the chain is never asked again elsewhere.
   */
  const elsewhere = (e) => e.transport === true || e.code === -32600 || e.code === -32005 || e.code === 429;

  /** A read: the fast RPC, or the public one when the fast one cannot answer. */
  async function rpc(method, params = []) {
    if (fastOn) {
      try {
        return await post(fast, method, params);
      } catch (e) {
        if (!elsewhere(e)) throw e;
        if (e.code === -32600) fastOn = false;
      }
    }
    return post(PUBLIC_RPC, method, params);
  }

  /** A signed transaction to both RPCs at once: the first to take it is enough. */
  async function broadcast(raw) {
    const urls = fastOn ? [fast, PUBLIC_RPC] : [PUBLIC_RPC];
    try {
      await Promise.any(urls.map((u) => post(u, "eth_sendRawTransaction", [raw])));
    } catch (all) {
      throw all.errors ? all.errors[all.errors.length - 1] : all;
    }
  }

  /** One JSON-RPC call to one RPC. Its errors keep the node's code. */
  async function post(url, method, params) {
    let res;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(RPC_TIMEOUT_MS) : undefined,
      });
    } catch (e) {
      throw Object.assign(fail(-32603, `Could not reach Robinhood Chain: ${e?.message ?? e}`), { transport: true });
    }
    if (!res.ok) throw Object.assign(fail(-32603, `Robinhood Chain's RPC answered ${res.status}.`), { transport: true });
    let body;
    try { body = await res.json(); } catch {
      throw Object.assign(fail(-32603, "Robinhood Chain's RPC answered with something that is not JSON."), { transport: true });
    }
    if (body && body.error) {
      const e = body.error;
      throw Object.assign(new Error(String(e.message ?? "The RPC refused the request.")), {
        code: typeof e.code === "number" ? e.code : -32603, data: e.data,
      });
    }
    if (!body || !("result" in body)) throw fail(-32603, "Robinhood Chain's RPC answered with no result.");
    return body.result;
  }

  async function accounts() {
    const a = await facade.address();
    return a ? [a] : [];
  }

  async function sendTransaction(tx) {
    if (!tx || typeof tx !== "object") throw fail(-32602, "No transaction to send.");
    // 1. Only the logged-in address.
    const me = await facade.address();
    if (!me) throw fail(4100, "Log in to trade. Nothing was signed.");
    if (typeof tx.from !== "string" || tx.from.toLowerCase() !== me.toLowerCase()) {
      throw fail(4100, `This transaction is from ${tx.from}, not the trading wallet ${me}. Nothing was signed.`);
    }
    const to = tx.to, data = tx.data ?? "0x", value = quantity(tx.value ?? "0x0"), gas = quantity(tx.gas);
    if (typeof to !== "string" || !ADDRESS.test(to)) throw fail(-32602, "The transaction names no recipient. Nothing was signed.");
    if (typeof data !== "string" || !DATA.test(data)) throw fail(-32602, "The transaction's data is not hex. Nothing was signed.");
    if (value === null) throw fail(-32602, "The transaction's value is not an amount. Nothing was signed.");
    if (gas === null || gas <= 0n || gas > BigInt(MAX_GAS)) throw fail(-32602, "The transaction's gas limit is missing or over the limit. Nothing was signed.");
    if (!locks || typeof locks.request !== "function") {
      throw fail(-32603, "This browser cannot keep two tabs from sending at once, so the trading wallet does not sign here. Update your browser.");
    }

    // 2. One send at a time for this address, in every tab of this site.
    return locks.request(`clank.send:${me.toLowerCase()}`, { mode: "exclusive" }, async () => {
      // The session can end while a send waits for the lock.
      const still = await facade.address();
      if (!still || still.toLowerCase() !== me.toLowerCase()) throw fail(4100, "The trading wallet logged out. Nothing was signed.");
      if (guard.full()) throw fail(-32005, "Too many transactions in a minute. Nothing was sent.");

      // 3. The nonce, counting what is already pending, and the base fee.
      const t0 = now();
      const [count, block] = await Promise.all([
        rpc("eth_getTransactionCount", [me, "pending"]),
        rpc("eth_getBlockByNumber", ["latest", false]),
      ]);
      const nonce = quantity(count);
      const base = quantity(block && block.baseFeePerGas);
      if (nonce === null || nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(-32603, "Robinhood Chain gave no nonce. Nothing was signed.");
      if (base === null) throw fail(-32603, "Robinhood Chain gave no base fee. Nothing was signed.");
      // 4. The fee ceiling.
      if (base > MAX_BASE_FEE_WEI) {
        throw fail(-32003, `The network fee is ${gwei(base)} gwei, over the ${gwei(MAX_BASE_FEE_WEI)} gwei ceiling. Nothing was signed.`);
      }

      // 5. Fees, chain and type. The sequencer is first come, first served,
      // so no tip; twice the base fee covers it rising before inclusion.
      guard.record();
      const t1 = now();
      // `from` is the address checked above, so the facade can check it again (P4 T2).
      const raw = await facade.signTransaction({
        from: me, type: "eip1559", chainId: CHAIN_ID, nonce: Number(nonce),
        to, data, value, gas, maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n,
      });
      if (typeof raw !== "string" || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(raw)) {
        throw fail(-32603, "The wallet returned no signed transaction. Nothing was sent.");
      }
      // 6. Straight to the chain. The hash is the signed bytes' own, worked
      // out here. A broadcast whose answer was lost, or garbled, may still
      // have reached the chain: it is reported as a failure only when the
      // chain does not know it, or a resume would send the trade twice.
      const hash = `0x${keccak256(raw.slice(2))}`;
      const t2 = now();
      try {
        await broadcast(raw);
      } catch (e) {
        let known = null;
        try { known = await rpc("eth_getTransactionByHash", [hash]); } catch { /* the first error is the one to report */ }
        if (!known) throw e;
      }
      // Where a send's time went: the chain's reads, Coinbase's signature, the broadcast.
      log(`[trading wallet] nonce and fee ${t1 - t0} ms · Coinbase signs ${t2 - t1} ms · broadcast ${now() - t2} ms`);
      // 7.
      return hash;
    });
  }

  return {
    /** @param {{ method: string, params?: unknown[] }} args */
    async request(args) {
      const method = args && args.method;
      const params = args && args.params !== undefined ? args.params : [];
      if (typeof method !== "string") throw fail(-32600, "No method.");
      if (!Array.isArray(params)) throw fail(-32602, "params must be an array.");
      if (method === "eth_accounts") return accounts();
      if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`;
      if (method === "eth_sendTransaction") return sendTransaction(params[0]);
      if (TO_RPC.has(method)) return rpc(method, params);
      throw fail(4200, `The trading wallet does not support ${method}.`);
    },
  };
}

// ---------------------------------------------------------- send guard --

/**
 * The rolling minute of sends, shared by every tab through localStorage and
 * read and written only under the send lock. It keeps timestamps and nothing
 * else: a browser holds one trading session at a time, so counting per
 * browser is counting per address, and a change of wallet within the minute
 * only makes it stricter. Without storage it counts in this tab alone.
 */
function sendGuard(storage, now) {
  let mine = [];
  const store = () => { try { return storage(); } catch { return null; } };
  const recent = () => {
    const t = now();
    // A clock that moved back leaves nothing counted from the future.
    const inMinute = (x) => Number.isFinite(x) && x > t - MINUTE_MS && x <= t;
    let shared = [];
    const s = store();
    if (s) {
      try {
        const parsed = JSON.parse(s.getItem(SENDS_KEY) ?? "[]");
        if (Array.isArray(parsed)) shared = parsed.filter(inMinute);
      } catch { /* unreadable: this tab's own count still holds */ }
    }
    const own = mine.filter(inMinute);
    // The shared list holds this tab's sends too, unless storage failed it.
    return shared.length >= own.length ? shared : own;
  };
  return {
    full: () => recent().length >= MAX_SENDS_PER_MINUTE,
    record() {
      const list = [...recent(), now()];
      mine = list;
      const s = store();
      if (s) try { s.setItem(SENDS_KEY, JSON.stringify(list)); } catch { /* full or blocked: this tab still counts */ }
    },
  };
}
