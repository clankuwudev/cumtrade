// The trading wallet's facade over Coinbase's SDK (public-release W1.1).
//
// scripts/vendor-wallet.mjs bundles this file, with @coinbase/cdp-core and
// everything it imports, into src/web/public/vendor/wallet.js. The page never
// sees the SDK itself: only the ten functions below, and only
// wallet/embedded.js may import them (scripts/check-web.mjs).
//
// What the facade decides, so no page code can change it:
// - Robinhood Chain only. A transaction for any other chain ID is refused
//   before Coinbase is asked.
// - cumTrade's trades only (P4 T2, P2e finding 1): src/web/public/js/trade/guard.js
//   accepts an approval to Permit2, the router or the token's own curve; a
//   Permit2 approval for the router; a curve buy or sell paying this wallet on
//   a curve the factory launched; one V4 swap in the token's own pool; and
//   ETH sent only to the wallet the person logged in with (Withdraw all). It
//   checks curves and tokens itself, over the two pinned public RPCs, and gas
//   and fees against the page's ceilings. Anything else is refused before
//   Coinbase is asked. It is a speed bump against a script calling our
//   provider, not a boundary: a script on the origin can reach Coinbase
//   without this facade (P2e). The Coinbase project policy (P4 T3) is the
//   backstop.
// - The only message the trading wallet signs is the gateway's sign-in, line
//   for line (Stage C, C-D2). Anything else, a key mint's message included, is
//   refused before Coinbase is asked, so no bug in the page makes this a
//   general signer.
// - Sign-in with a wallet names Ethereum mainnet, never Robinhood Chain:
//   Coinbase's SIWE refuses chain 4663 ("Unsupported network"). The login
//   only proves the visitor holds their address, which is the same on every
//   EVM chain, so it says nothing about where the trading wallet signs.
// - An embedded EOA is made on the first login (TW2). Smart accounts and
//   Solana accounts are never asked for.
// - Analytics are off. The page's policy blocks their host anyway.
// - Only the EOA's address leaves the facade. The user object, with its email
//   or X handle, stays inside the SDK.
// - The export frame offers Copy, never Eject.
//
// If the fallback provider (Turnkey) is chosen, this file is what changes.
import {
  createEvmKeyExportIframe,
  getCurrentUser,
  initialize,
  isSignedIn,
  onAuthStateChange,
  onOAuthStateChange,
  signEvmMessage,
  signEvmTransaction,
  signInWithOAuth,
  signInWithSiwe,
  signOut,
  verifySiweSignature,
} from "@coinbase/cdp-core";
import { getAddress, isAddress, stringToHex } from "viem";
import { FAST_RPC, MAX_BASE_FEE_WEI, MAX_GAS, PUBLIC_RPC } from "../../src/web/public/js/trade/constants.js";
import { checkTrade } from "../../src/web/public/js/trade/guard.js";

/** Robinhood Chain. The only chain this facade signs for. */
const CHAIN_ID = 4663;
/** The fee ceiling a send may carry: twice the page's base-fee ceiling, as embedded.js fills it in. */
const MAX_FEE_WEI = 2n * MAX_BASE_FEE_WEI;

/**
 * fetch as it was when this bundle loaded. The trade check's reads go only to
 * the two pinned RPCs, by these three methods (P4 T2).
 */
const netFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
const RPCS = [FAST_RPC, PUBLIC_RPC];
const READS = new Set(["eth_call", "eth_chainId", "eth_getBlockByNumber"]);
let rpcId = 0;
/** Tokens the trade check found graduated, kept for the session. */
const verified = new Map();

/** One read for the trade check: the fast RPC, then the public one. */
async function rpc({ method, params = [] }) {
  if (!READS.has(method) || !netFetch) throw new Error(`The trade check does not read ${method}.`);
  let last = null;
  for (const url of RPCS) {
    try {
      const res = await netFetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      });
      if (!res.ok) throw new Error(`Robinhood Chain's RPC answered ${res.status}.`);
      const body = await res.json();
      if (!body || body.error || !("result" in body)) throw new Error("Robinhood Chain's RPC gave no result.");
      return body.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
/** The chain named in a wallet login's SIWE message: Ethereum mainnet, which Coinbase's SIWE accepts. */
const SIWE_CHAIN_ID = 1;
const LOGINS = new Set(["google", "x"]);

let projectId = null;
/** @type {Promise<void> | null} */
let ready = null;
/** The OAuth flow's latest state, as the SDK reports it. */
let oauth = null;
const oauthWaiters = new Set();
const authListeners = new Set();

/** The embedded EOA of a user object, checksummed, or null. */
function eoaOf(user) {
  const a = user?.evmAccountObjects?.[0]?.address ?? user?.evmAccounts?.[0];
  return typeof a === "string" && isAddress(a, { strict: false }) ? getAddress(a) : null;
}

function initialized() {
  if (!ready) throw new Error("The wallet SDK has not been started.");
  return ready;
}

/**
 * Start the SDK for one Coinbase project. The page picks the ID from its own
 * pinned map (wallet/projects.js). A second call with another ID is refused:
 * one page, one project.
 *
 * Returning from a Google or X login is handled here too: the SDK reads the
 * code from the address bar, removes it with `history.replaceState`, and
 * finishes the login before this resolves.
 */
export function init({ projectId: id }) {
  if (typeof id !== "string" || id.trim() === "") return Promise.reject(new Error("No project ID."));
  if (ready) {
    return id === projectId ? ready : Promise.reject(new Error("The wallet SDK was started for another project."));
  }
  projectId = id;
  ready = initialize({
    projectId: id,
    ethereum: { createOnLogin: "eoa" },
    disableAnalytics: true,
  }).then(() => {
    onOAuthStateChange((state) => {
      oauth = state;
      for (const wake of oauthWaiters) wake();
      oauthWaiters.clear();
    });
    onAuthStateChange((user) => {
      const a = eoaOf(user);
      for (const fn of authListeners) fn(a);
    });
  });
  ready.catch(() => { ready = null; projectId = null; });
  return ready;
}

/** Leave the page for Google's or X's sign-in. The page comes back to the same address. */
export async function startLogin(provider) {
  if (!LOGINS.has(provider)) throw new Error("Log in with Google or X.");
  await initialized();
  await signInWithOAuth(provider);
}

/**
 * Sign in with the visitor's own wallet (SIWE). Their wallet signs one
 * message, which is checked first: it must name this site, their address and
 * Ethereum mainnet. Resolves to the embedded EOA that login gives them.
 */
export async function loginWithWallet(eip1193) {
  if (!eip1193 || typeof eip1193.request !== "function") throw new Error("No wallet to sign in with.");
  await initialized();
  const accounts = await eip1193.request({ method: "eth_requestAccounts" });
  const raw = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) throw new Error("The wallet returned no account.");
  const address = getAddress(raw);
  const { host, origin } = window.location;
  const { flowId, message } = await signInWithSiwe({ address, chainId: SIWE_CHAIN_ID, domain: host, uri: origin });
  checkSiwe(message, { host, origin, address });
  const signature = await eip1193.request({ method: "personal_sign", params: [stringToHex(message), address] });
  const { user } = await verifySiweSignature({ flowId, signature });
  const eoa = eoaOf(user);
  if (!eoa) throw new Error("The login gave no trading wallet.");
  return eoa;
}

/** EIP-4361's first lines, and the login's chain, before the visitor's wallet is asked to sign. */
function checkSiwe(message, { host, origin, address }) {
  const lines = typeof message === "string" ? message.split("\n") : [];
  const head = lines[0] === `${host} wants you to sign in with your Ethereum account:`
    || lines[0] === `${origin} wants you to sign in with your Ethereum account:`;
  const who = typeof lines[1] === "string" && lines[1].toLowerCase() === address.toLowerCase();
  const chain = lines.includes(`Chain ID: ${SIWE_CHAIN_ID}`);
  const uri = lines.includes(`URI: ${origin}`);
  if (!(head && who && chain && uri)) throw new Error("The sign-in message did not name this site, your address and Ethereum mainnet. Nothing was signed.");
}

/**
 * After the page comes back from Google or X: the trading wallet's address,
 * or null when no login was under way. A failed login throws its reason.
 */
export async function completeLogin() {
  await initialized();
  // The SDK finishes a returning login before init resolves, so this is only
  // a guard: nothing can change the state between the check and the wait.
  while (oauth && oauth.status === "pending") {
    await new Promise((wake) => oauthWaiters.add(wake));
  }
  if (oauth && oauth.status === "error") {
    throw new Error(oauth.errorDescription || oauth.error || "The login did not complete.");
  }
  return address();
}

/** The logged-in trading wallet's address, checksummed, or null. */
export async function address() {
  await initialized();
  return eoaOf(await getCurrentUser());
}

/**
 * A transaction's fields, each read exactly once, as primitives, frozen. A
 * field of the wrong type is refused here, before anything is awaited.
 */
function snapshot(input) {
  if (!input || typeof input !== "object") throw new Error("No transaction to sign.");
  const { from, type, chainId, nonce, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = input;
  const refuse = () => { throw new Error("Refused: the transaction's fields are not plain values. Nothing was signed."); };
  if (typeof from !== "string" || typeof type !== "string" || typeof chainId !== "number" || typeof nonce !== "number") refuse();
  if (typeof to !== "string" || (data !== undefined && typeof data !== "string")) refuse();
  for (const n of [value, gas, maxFeePerGas, maxPriorityFeePerGas]) if (typeof n !== "bigint") refuse();
  return Object.freeze({ from, type, chainId, nonce, to, data: data ?? "0x", value, gas, maxFeePerGas, maxPriorityFeePerGas });
}

/**
 * Sign one EIP-1559 transaction for Robinhood Chain with the logged-in EOA,
 * and return the signed raw transaction. Nothing is broadcast here.
 */
export async function signTransaction(input) {
  // The caller owns `input` and could change it while this waits (the
  // chain's reads take a while), or answer a second read differently. So
  // every field is read once, here, before anything is awaited, and only
  // this frozen copy is checked and signed (P2e re-review of T2).
  const tx = snapshot(input);
  await initialized();
  if (tx.chainId !== CHAIN_ID) throw new Error(`Refused: only Robinhood Chain (${CHAIN_ID}) is signed here.`);
  if (tx.type !== "eip1559") throw new Error("Refused: only EIP-1559 transactions are signed here.");
  const user = await getCurrentUser();
  const from = eoaOf(user);
  if (!from) throw new Error("Log in to trade.");
  const refuse = (why) => { throw new Error(`Refused: ${why}. Nothing was signed.`); };
  // The address the provider checked is the one that signs.
  if (typeof tx.from !== "string" || tx.from.toLowerCase() !== from.toLowerCase()) refuse("it is not from this trading wallet");
  const big = (x) => (typeof x === "bigint" && x >= 0n ? x : null);
  const gas = big(tx.gas), maxFee = big(tx.maxFeePerGas), tip = big(tx.maxPriorityFeePerGas);
  if (gas === null || gas === 0n || gas > BigInt(MAX_GAS)) refuse("its gas limit is missing or over the page's ceiling");
  if (maxFee === null || tip === null || maxFee > MAX_FEE_WEI || tip > maxFee) refuse("its fee is over the page's ceiling");
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) refuse("its nonce is not a number");
  // Withdraw all goes only to the wallet the person logged in with, as Coinbase recorded it.
  const siwe = user?.authenticationMethods?.siwe?.address;
  const withdrawTo = typeof siwe === "string" && isAddress(siwe, { strict: false }) ? getAddress(siwe) : null;
  await checkTrade({ to: tx.to, data: tx.data ?? "0x", value: tx.value }, {
    signer: from, withdrawTo, request: rpc, now: () => Date.now() / 1000, cache: verified,
  });
  const { signedTransaction } = await signEvmTransaction({
    evmAccount: from,
    transaction: {
      type: "eip1559",
      chainId: CHAIN_ID,
      nonce: tx.nonce,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    },
  });
  return signedTransaction;
}

/** The sign-in statement the gateway writes (src/gateway/signin.ts). A key mint's statement is never signed here. */
const GATEWAY_STATEMENT = "Sign in to Clank Uwu Model's API and accept its terms. This costs nothing and moves nothing.";
/** The longest a signed sign-in may stay valid (C-D2). */
const GATEWAY_MAX_TTL_MS = 24 * 3_600_000;
/** How far ahead of this machine's clock the gateway's may run. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** EIP-4361's times, as viem writes them. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Sign the gateway's sign-in message with the logged-in trading wallet, and
 * return the signature (Stage C, C-D2). The message must be, line for line,
 * one the gateway writes for this site: its host and origin, the trading
 * wallet's own address, chain 4663, the sign-in statement, and one resource,
 * the terms at `termsVersion`, the version the page shows. It lasts at most a
 * day. Anything else is refused before Coinbase is asked.
 */
export async function signGatewayMessage(message, { termsVersion } = {}) {
  await initialized();
  const refuse = (why) => { throw new Error(`Refused: ${why}. Nothing was signed.`); };
  if (typeof message !== "string") refuse("there is no message");
  if (typeof termsVersion !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(termsVersion)) refuse("there are no terms to accept");
  const from = await address();
  if (!from) refuse("log in first");
  const { host, origin } = window.location;
  const lines = message.split("\n");
  if (lines.length !== 13) refuse("it is not the gateway's sign-in message");
  const fixed = [
    [0, `${host} wants you to sign in with your Ethereum account:`],
    [1, from],
    [2, ""],
    [3, GATEWAY_STATEMENT],
    [4, ""],
    [5, `URI: ${origin}`],
    [6, "Version: 1"],
    [7, `Chain ID: ${CHAIN_ID}`],
    [11, "Resources:"],
    [12, `- ${origin}/os#/learn/terms?version=${termsVersion}`],
  ];
  for (const [i, want] of fixed) {
    if (lines[i] !== want) refuse(`line ${i + 1} is not the gateway's sign-in`);
  }
  if (!/^Nonce: [A-Za-z0-9]{8,128}$/.test(lines[8])) refuse("line 9 is not a nonce");
  const time = (line, label) => {
    const value = line.startsWith(`${label}: `) ? line.slice(label.length + 2) : "";
    const t = ISO_TIME.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) refuse(`the ${label} is not a time`);
    return t;
  };
  const issued = time(lines[9], "Issued At");
  const expires = time(lines[10], "Expiration Time");
  const now = Date.now();
  if (issued > now + CLOCK_SKEW_MS) refuse("it was issued in the future");
  if (expires <= now) refuse("it has expired");
  if (expires <= issued || expires - issued > GATEWAY_MAX_TTL_MS || expires - now > GATEWAY_MAX_TTL_MS) {
    refuse("it would last more than a day");
  }
  const { signature } = await signEvmMessage({ evmAccount: from, message });
  return signature;
}

/**
 * Mount Coinbase's key-export button in `element`. The key is copied from
 * Coinbase's frame and never enters this page. `onStatus` hears the frame's
 * status words ("ready", "success", "error", "expired"). Resolves to a
 * function that removes the frame.
 */
export async function mountExport(element, exportAddress, onStatus) {
  await initialized();
  const from = await address();
  if (!from || typeof exportAddress !== "string" || exportAddress.toLowerCase() !== from.toLowerCase()) {
    throw new Error("Only the logged-in trading wallet's key can be exported.");
  }
  const { cleanup } = await createEvmKeyExportIframe({
    address: from,
    target: element,
    projectId,
    action: "copy",
    onStatusUpdate: (status, message) => {
      if (typeof onStatus === "function") onStatus(status, message);
    },
  });
  return cleanup;
}

/** Sign out of Coinbase. Nothing happens when no one is logged in. */
export async function logout() {
  await initialized();
  if (await isSignedIn()) await signOut();
}

/** Hear the trading wallet's address, or null, whenever the login changes. Returns an unsubscribe. */
export function onAuthChange(cb) {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}
