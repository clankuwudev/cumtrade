// The trading-wallet facade's wallet login, run for real — public-release W1.1.
//
// Bundles scripts/vendor/wallet-entry.js the way scripts/vendor-wallet.mjs
// does, but with @coinbase/cdp-core swapped for a stand-in that answers
// Sign-In with Ethereum the way Coinbase's API does, then logs in with a fake
// wallet. Then the trading wallet is offered the gateway's sign-in and a
// list of forgeries (Stage C, C-D2). Nothing is fetched and nothing is written.
//
//   npm run test:vendor
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { FAST_RPC, PUBLIC_RPC, READ, SEL, UNIVERSAL_ROUTER } from "../src/web/public/js/trade/constants.js";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import { ENTRY } from "./vendor-wallet.mjs";

let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

// Coinbase's `auth/init` for SIWE, probed on 2026-09-23 against both of the
// operator's projects: chains 1 and 8453 get a message, and Robinhood Chain
// (4663) gets 400 "Unsupported network". The stand-in keeps to what was seen.
const SIWE_ACCEPTED = new Set([1, 8453]);
// Lower case, as the test compares it; it has letters, so its checksummed form differs.
const EOA = "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd";

const STAND_IN = `
const fake = globalThis.__cdp;
export const initialize = async () => {};
export const onOAuthStateChange = () => {};
export const onAuthStateChange = () => {};
export const getCurrentUser = async () => fake.user;
export const isSignedIn = async () => !!fake.user;
export const signOut = async () => { fake.user = null; };
export const signInWithOAuth = async () => {};
export const createEvmKeyExportIframe = async () => ({ cleanup() {} });
export async function signInWithSiwe({ address, chainId, domain, uri }) {
  fake.siwe.push({ address, chainId, domain, uri });
  if (!fake.accepted.has(chainId)) throw new Error("Unsupported network");
  return {
    flowId: "flow-1",
    message: domain + " wants you to sign in with your Ethereum account:\\n" + address
      + "\\n\\nURI: " + uri + "\\nVersion: 1\\nChain ID: " + chainId
      + "\\nNonce: 00\\nIssued At: 2026-09-23T00:00:00Z",
  };
}
export async function verifySiweSignature({ flowId, signature }) {
  if (flowId !== "flow-1" || !signature) throw new Error("bad verify");
  fake.user = { evmAccounts: [fake.eoa] };
  return { user: fake.user };
}
export async function signEvmMessage({ evmAccount, message }) {
  fake.messages.push({ evmAccount, message });
  return { signature: "0x" + "ab".repeat(65) };
}
export async function signEvmTransaction({ transaction }) {
  fake.signed.push(transaction);
  return { signedTransaction: "0x02" };
}
`;

const standIn = {
  name: "cdp-stand-in",
  setup(b) {
    b.onResolve({ filter: /^@coinbase\/cdp-core$/ }, () => ({ path: "cdp-core", namespace: "stand-in" }));
    b.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: STAND_IN, loader: "js" }));
  },
};

const out = await build({
  entryPoints: [ENTRY], plugins: [standIn], bundle: true, write: false,
  format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
});
const code = Buffer.from(out.outputFiles[0].contents).toString("base64");

globalThis.__cdp = { accepted: SIWE_ACCEPTED, eoa: EOA, user: null, siwe: [], signed: [], messages: [] };
globalThis.window = { location: { host: "clankuwu.com", origin: "https://clankuwu.com" } };

// The chain, for the trade check's reads (P4 T2): the fixture chain the page's
// tests use, behind a fetch the facade takes when it loads. It records every
// URL, so the test can see the reads go only to the two pinned RPCs.
const { chain } = JSON.parse(readFileSync(new URL("../src/web/test/fixtures/plans.json", import.meta.url), "utf8"));
const lower = (a) => String(a).toLowerCase();
const w32 = (v) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : BigInt(v).toString(16)).padStart(64, "0");
const rpcUrls = [];
/** Called on each of the trade check's reads, so a test can change a transaction while it is checked. */
let onRead = null;
globalThis.fetch = async (url, init) => {
  rpcUrls.push(String(url));
  const { id, method, params } = JSON.parse(init.body);
  const answer = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id, result }) });
  if (method === "eth_chainId") return answer("0x1237");
  if (method === "eth_getBlockByNumber") return answer({ timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
  const { to, data } = params[0];
  const sel = data.slice(0, 10);
  const tokenRow = chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === lower(to))];
  const curveRow = Object.entries(chain.tokens).find(([, v]) => lower(v.curve) === lower(to));
  if (tokenRow && sel === READ.curve) return answer(`0x${w32(tokenRow.curve)}`);
  if (curveRow && sel === READ.token) return answer(`0x${w32(curveRow[0])}`);
  if (curveRow && sel === READ.factory) return answer(`0x${w32(chain.factory)}`);
  if (curveRow && sel === READ.graduated) return answer(`0x${w32(curveRow[1].graduated ? 1 : 0)}`);
  // The curve's own quotes: 2 tokens for any buy, 2 wei for any sell, so a minimum of 1 is within 50%.
  if (curveRow && sel === READ.quoteBuyFor) return answer(`0x${w32(0)}${w32(0)}${w32(0)}${w32(2)}${w32(0)}`);
  if (curveRow && sel === READ.quoteSell) return answer(`0x${w32(2)}${w32(2)}${w32(0)}`);
  onRead?.();
  if (lower(to) === lower(chain.factory) && sel === READ.memeHook) return answer(`0x${w32(chain.memeHook)}`);
  if (lower(to) === lower(chain.factory) && sel === READ.getLaunchedToken) {
    const tok = `0x${data.slice(-40)}`;
    const row = chain.tokens[Object.keys(chain.tokens).find((t) => lower(t) === lower(tok))];
    return answer(row ? `0x${w32(tok)}${w32(row.curve)}${w32(0).repeat(13)}` : `0x${w32(0).repeat(15)}`);
  }
  return answer("0x");
};
const facade = await import(`data:text/javascript;base64,${code}`);
await facade.init({ projectId: "00000000-0000-4000-8000-000000000000" });

const visitor = "0x2222222222222222222222222222222222222222";
const signedBy = [];
const wallet = {
  async request({ method, params }) {
    if (method === "eth_requestAccounts") return [visitor];
    if (method === "personal_sign") { signedBy.push(Buffer.from(params[0].slice(2), "hex").toString("utf8")); return "0xsig"; }
    throw new Error(`unexpected ${method}`);
  },
};

console.log("\nlogging in with a wallet");
let got = null;
let err = null;
try { got = await facade.loginWithWallet(wallet); } catch (e) { err = e; }
const asked = globalThis.__cdp.siwe[0]?.chainId;
ok("the login gives the embedded EOA", got?.toLowerCase() === EOA, err ? String(err.message) : String(got));
ok("…asking Coinbase for a chain its SIWE accepts", SIWE_ACCEPTED.has(asked), `chainId ${asked}`);
ok("…for this site and the visitor's address",
  globalThis.__cdp.siwe[0]?.domain === "clankuwu.com" && globalThis.__cdp.siwe[0]?.uri === "https://clankuwu.com"
  && globalThis.__cdp.siwe[0]?.address.toLowerCase() === visitor);
ok("the visitor's wallet signed exactly one message, the checked one",
  signedBy.length === 1 && signedBy[0].includes(`Chain ID: ${asked}`), `${signedBy.length} signed`);

console.log("\nthe trading wallet still signs for Robinhood Chain only");
// Coinbase records the wallet a SIWE login used; Withdraw all may send only there (P4 T2).
globalThis.__cdp.user.authenticationMethods = { siwe: { type: "siwe", address: visitor } };
const tradingAddress = await facade.address();
const tx = { from: tradingAddress, type: "eip1559", nonce: 0, to: visitor, data: "0x", value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
let refused = null;
try { await facade.signTransaction({ ...tx, chainId: asked }); } catch (e) { refused = e; }
ok(`a transaction for the login's chain (${asked}) is refused before Coinbase is asked`,
  !!refused && globalThis.__cdp.signed.length === 0, refused?.message);
await facade.signTransaction({ ...tx, chainId: 4663 });
ok("Withdraw all to the login wallet, on 4663, is signed", globalThis.__cdp.signed.length === 1 && globalThis.__cdp.signed[0].chainId === 4663);

// P4 T2 (P2e finding 1): cumTrade's trades, and nothing else. Each refusal
// comes before Coinbase is asked; the reads go only to the pinned RPCs.
console.log("\nthe trading wallet signs cumTrade's trades, and nothing else (P4 T2)");
const ATTACKER = "0x" + "a1".repeat(20);
const TOKEN = Object.keys(chain.tokens).find((t) => !chain.tokens[t].graduated);
const CURVE = chain.tokens[TOKEN].curve;
const MAX = "f".repeat(64);
const base = { from: tradingAddress, chainId: 4663, type: "eip1559", nonce: 1, gas: 300_000n, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n };
const buy = (to, recipient, amount = 10n ** 16n) => ({ ...base, to, data: `${SEL.curveBuy}${w32(amount)}${w32(1)}${w32(recipient)}`, value: amount });
const signedBefore = () => globalThis.__cdp.signed.length;
const refusedTx = async (name, t) => {
  const n = signedBefore();
  let e = null;
  try { await facade.signTransaction(t); } catch (x) { e = x; }
  ok(`${name} is refused, before Coinbase is asked`, !!e && /^Refused: /.test(e.message) && signedBefore() === n, e ? e.message : "signed");
};
let n0 = signedBefore();
await facade.signTransaction(buy(CURVE, tradingAddress));
ok("a buy on a clank.trade curve, paying this wallet, is signed", signedBefore() === n0 + 1);
ok("…and its reads went only to the two pinned RPCs", rpcUrls.length > 0 && rpcUrls.every((u) => u === FAST_RPC || u === PUBLIC_RPC),
  [...new Set(rpcUrls)].join(", "));
await refusedTx("a 4-byte call with 5 ETH to an EOA", { ...base, to: ATTACKER, data: "0xdeadbeef", value: 5n * 10n ** 18n });
await refusedTx("\"0x00\" with ETH to an EOA", { ...base, to: ATTACKER, data: "0x00", value: 5n * 10n ** 18n });
await refusedTx("transfer(attacker, max)", { ...base, to: TOKEN, data: `0xa9059cbb${w32(ATTACKER)}${MAX}`, value: 0n });
await refusedTx("transferFrom(me, attacker, max)", { ...base, to: TOKEN, data: `0x23b872dd${w32(tradingAddress)}${w32(ATTACKER)}${MAX}`, value: 0n });
await refusedTx("approve(attacker, max)", { ...base, to: TOKEN, data: `${SEL.erc20Approve}${w32(ATTACKER)}${MAX}`, value: 0n });
await refusedTx("a buy on a contract the factory didn't launch", buy(ATTACKER, tradingAddress));
await refusedTx("a buy paying another address", buy(CURVE, ATTACKER));
await refusedTx("the router with another command", { ...base, to: UNIVERSAL_ROUTER, data: `${SEL.execute}${w32(96)}${w32(160)}${w32(0)}${w32(1)}${"0b".padEnd(64, "0")}${w32(0)}`, value: 0n });
await refusedTx("a fee of 1e30", { ...buy(CURVE, tradingAddress), maxFeePerGas: 10n ** 30n });
await refusedTx("gas over 3,000,000", { ...buy(CURVE, tradingAddress), gas: 3_000_001n });
await refusedTx("a transaction from another address", { ...buy(CURVE, tradingAddress), from: ATTACKER });
await refusedTx("ETH to an address that isn't the login wallet", { ...tx, chainId: 4663, to: ATTACKER });
await refusedTx("a buy with no minimum out", { ...base, to: CURVE, data: `${SEL.curveBuy}${w32(10n ** 16n)}${w32(0)}${w32(tradingAddress)}`, value: 10n ** 16n });

// The P2e re-review of 123c81f: the caller owns the transaction, and may change it while it is checked.
const transferOut = `0xa9059cbb${w32(ATTACKER)}${MAX}`;
n0 = signedBefore();
const moving = buy(CURVE, tradingAddress);
onRead = () => { moving.to = TOKEN; moving.data = transferOut; moving.value = 0n; };
await facade.signTransaction(moving);
onRead = null;
const signedMoving = globalThis.__cdp.signed.at(-1);
ok("a transaction changed while it is checked is signed as it was checked, not as it became",
  signedBefore() === n0 + 1 && lower(signedMoving.to) === lower(CURVE) && signedMoving.data.startsWith(SEL.curveBuy),
  `${signedMoving.to} ${signedMoving.data.slice(0, 10)}`);
let reads = 0;
const twoFaced = { ...buy(CURVE, tradingAddress) };
const genuine = twoFaced.data;
Object.defineProperty(twoFaced, "data", { get: () => (reads++ === 0 ? genuine : transferOut), enumerable: true });
Object.defineProperty(twoFaced, "to", { get: () => (reads < 2 ? CURVE : TOKEN), enumerable: true });
n0 = signedBefore();
await facade.signTransaction(twoFaced);
const signedTwo = globalThis.__cdp.signed.at(-1);
ok("…and a getter that answers differently the second time is read once",
  signedBefore() === n0 + 1 && lower(signedTwo.to) === lower(CURVE) && signedTwo.data === genuine, `${reads} reads of data`);
const proxied = new Proxy(buy(CURVE, tradingAddress), {
  get: (t, k) => (k === "value" ? 10n ** 18n : t[k]),
});
await refusedTx("a Proxy whose value isn't the amount it buys with", proxied);

const siweUser = globalThis.__cdp.user.authenticationMethods;
globalThis.__cdp.user.authenticationMethods = { google: { type: "google" } };
await refusedTx("Withdraw all after a Google login, which has no login wallet", { ...tx, chainId: 4663 });
globalThis.__cdp.user.authenticationMethods = siweUser;

// Stage C, C-D2: the trading wallet signs the gateway's sign-in and nothing
// else. The real message is written the way the gateway writes it
// (src/gateway/signin.ts, with viem); each forgery must be refused before
// Coinbase is asked.
console.log("\nthe trading wallet signs the gateway's sign-in, and nothing else");
const TERMS = "2026-09-23";
const STATEMENT = "Sign in to Clank Uwu Model's API and accept its terms. This costs nothing and moves nothing.";
const me = await facade.address();
const gatewayMessage = (o = {}) => createSiweMessage({
  domain: o.domain ?? "clankuwu.com",
  uri: o.uri ?? "https://clankuwu.com",
  address: o.address ?? me,
  chainId: o.chainId ?? 4663,
  nonce: o.nonce ?? generateSiweNonce(),
  version: "1",
  issuedAt: new Date(o.issuedAt ?? Date.now()),
  expirationTime: new Date(o.expiresAt ?? Date.now() + 5 * 60_000),
  statement: o.statement ?? STATEMENT,
  resources: o.resources ?? [`https://clankuwu.com/os#/learn/terms?version=${TERMS}`],
  ...(o.requestId ? { requestId: o.requestId } : {}),
});
const asked0 = () => globalThis.__cdp.messages.length;
const refusedBefore = async (what, message, opts = { termsVersion: TERMS }) => {
  const before = asked0();
  let e = null;
  try { await facade.signGatewayMessage(message, opts); } catch (x) { e = x; }
  ok(`refused: ${what}`, !!e && /^Refused: .*Nothing was signed\.$/.test(e.message) && asked0() === before, e ? e.message : "it was signed");
};

const real = gatewayMessage();
const sig = await facade.signGatewayMessage(real, { termsVersion: TERMS });
const asked1 = globalThis.__cdp.messages[0];
ok("the gateway's sign-in is signed by the trading wallet, as written, and the signature comes back",
  asked0() === 1 && asked1.message === real && asked1.evmAccount === me && sig === "0x" + "ab".repeat(65));

const now = Date.now();
await refusedBefore("a key mint's message", gatewayMessage({ statement: "Create an API key labelled 'x'. This costs nothing and moves nothing." }));
await refusedBefore("another site", gatewayMessage({ domain: "evil.example", uri: "https://evil.example" }));
await refusedBefore("this site's name but another URI", gatewayMessage({ uri: "https://evil.example" }));
await refusedBefore("plain http", gatewayMessage({ uri: "http://clankuwu.com" }));
await refusedBefore("another address", gatewayMessage({ address: visitor }));
await refusedBefore("this address in lower case", real.replace(me, me.toLowerCase()));
await refusedBefore("another chain", gatewayMessage({ chainId: 1 }));
await refusedBefore("terms the page doesn't show", real, { termsVersion: "2026-10-01" });
await refusedBefore("no terms version from the page", real, {});
await refusedBefore("a terms version that isn't a date", real, { termsVersion: "latest" });
await refusedBefore("a resource on another page", gatewayMessage({ resources: [`https://clankuwu.com/os#/learn/privacy?version=${TERMS}`] }));
await refusedBefore("the terms on another site", gatewayMessage({ resources: [`https://evil.example/os#/learn/terms?version=${TERMS}`] }));
await refusedBefore("a second resource", gatewayMessage({ resources: [`https://clankuwu.com/os#/learn/terms?version=${TERMS}`, "https://evil.example/"] }));
await refusedBefore("an extra field", gatewayMessage({ requestId: "x" }));
await refusedBefore("a line added at the end", `${real}\n`);
await refusedBefore("Windows line endings", real.replace(/\n/g, "\r\n"));
await refusedBefore("a nonce that isn't one", real.replace(/^Nonce: .*$/m, "Nonce: abc def"));
await refusedBefore("an expired message", gatewayMessage({ issuedAt: now - 10 * 60_000, expiresAt: now - 60_000 }));
await refusedBefore("one that lasts more than a day", gatewayMessage({ expiresAt: now + 25 * 3_600_000 }));
await refusedBefore("one issued in the future", gatewayMessage({ issuedAt: now + 10 * 60_000, expiresAt: now + 15 * 60_000 }));
await refusedBefore("a time that isn't one", real.replace(/^Expiration Time: .*$/m, "Expiration Time: soon"));
await refusedBefore("no message", undefined);
await refusedBefore("an arbitrary text", "Hello");
const user = globalThis.__cdp.user;
globalThis.__cdp.user = null;
await refusedBefore("a message when nobody is logged in", real);
globalThis.__cdp.user = user;
ok("…and Coinbase was asked to sign exactly one message in all", asked0() === 1, `${asked0()} asked`);

console.log(failures === 0
  ? "\n\x1b[32mall facade checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
