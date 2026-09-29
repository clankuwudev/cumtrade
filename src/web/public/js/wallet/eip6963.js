import { S } from "../core/store.js";
import { CHAIN_ID } from "../trade/constants.js";

// ====================================================================== //
// the visitor's wallet                                                   //
// ====================================================================== //
//
// The only module that may name the injected provider (scripts/check-web.mjs
// enforces it). Wallets announce themselves over EIP-6963, so several can be
// installed at once without fighting over one global. `window.ethereum` is
// offered only when nothing announced, as "Browser wallet".
//
// It keeps the active provider and writes `S.conn`, and it imports nothing
// that renders: the chrome subscribes with onChange. The address goes nowhere.
// Nothing here calls our server, and the balance comes from the wallet's own
// RPC.
//
// Only a hosted page starts any of this. A self page trades through its own
// server wallet and never touches a provider.

const REMEMBER = "clank.wallet";
const CHAIN_HEX = "0x" + CHAIN_ID.toString(16);
const MAX_ICON = 100_000;

/** The chain a wallet is asked to add when it does not know it. */
const ROBINHOOD_CHAIN = {
  chainId: CHAIN_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

/** @typedef {{ uuid: string, name: string, icon: string, rdns: string }} WalletInfo */
/** @typedef {{ request: (args: { method: string, params?: unknown[] }) => Promise<any>, on?: Function, removeListener?: Function }} Provider */

/** @type {Map<string, { info: WalletInfo, provider: Provider }>} */
const found = new Map();
/** @type {{ info: WalletInfo, provider: Provider } | null} */
let active = null;
let listening = false;
const listeners = new Set();

const emit = () => { for (const fn of listeners) fn(); };

/** Call `fn` whenever the connection, its account, chain or balance changes. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** An icon worth rendering: an inline image, never a URL that would fetch something. */
export const safeIcon = (icon) =>
  typeof icon === "string" && icon.length <= MAX_ICON && /^data:image\//i.test(icon) ? icon : "";

// ------------------------------------------------------------ discovery --

function announced(e) {
  const d = e && e.detail;
  const info = d && d.info;
  const provider = d && d.provider;
  if (!info || !provider || typeof provider.request !== "function") return;
  if (typeof info.uuid !== "string" || !info.uuid) return;
  if (typeof info.name !== "string" || typeof info.rdns !== "string") return;
  if (found.has(info.uuid)) return;
  found.set(info.uuid, {
    info: { uuid: info.uuid, name: info.name, icon: safeIcon(info.icon), rdns: info.rdns },
    provider,
  });
  emit();
}

/**
 * Ask installed wallets to announce themselves, and give them `ms` to answer.
 * Wallets that announce later still join the list. The injected global is
 * offered only when none announced within the window.
 *
 * @returns {Promise<WalletInfo[]>}
 */
export async function discover(ms = 300) {
  if (!listening) {
    window.addEventListener("eip6963:announceProvider", announced);
    listening = true;
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, ms));
  const injected = window.ethereum;
  if (found.size === 0 && injected && typeof injected.request === "function") {
    found.set("injected", {
      info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" },
      provider: injected,
    });
  }
  return wallets();
}

/** Every wallet found so far, in the order they announced. */
export const wallets = () => [...found.values()].map((w) => w.info);

/** The connected wallet's EIP-1193 provider, for the signing sequence and the verifier's reads. */
export const provider = () => (active ? active.provider : null);

// ----------------------------------------------------------- connection --

/** Connect the wallet with this uuid. It may open a popup. */
export async function connect(uuid) {
  const w = found.get(uuid);
  if (!w) throw new Error("That wallet is no longer available.");
  const accounts = await w.provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("The wallet returned no account.");
  await attach(w, accounts[0]);
  remember(w.info.rdns);
  return accounts[0];
}

/**
 * Reconnect the wallet this browser used last, without a popup. Nothing
 * happens if none is remembered or it is not installed. If the wallet no
 * longer authorises this site, the memory is dropped.
 */
export async function reconnect() {
  const rdns = recall();
  if (!rdns) return null;
  const w = [...found.values()].find((x) => x.info.rdns === rdns);
  if (!w) return null;
  const accounts = await w.provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    forget();
    return null;
  }
  await attach(w, accounts[0]);
  return accounts[0];
}

/** Forget the wallet on this page. The wallet's own permission is revoked where it can be. */
export async function disconnect() {
  const w = active;
  detach();
  forget();
  S.conn = null;
  emit();
  if (w) {
    try {
      await w.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch { /* not every wallet supports it, and ours is already forgotten */ }
  }
}

async function attach(w, address) {
  if (active !== w) {
    detach();
    active = w;
    if (typeof w.provider.on === "function") {
      w.provider.on("accountsChanged", onAccounts);
      w.provider.on("chainChanged", onChain);
      w.provider.on("disconnect", onDisconnect);
    }
  }
  const chainId = Number(await w.provider.request({ method: "eth_chainId" }));
  S.conn = { info: w.info, address, chainId, balanceWei: null };
  emit();
  await refreshBalance();
}

function detach() {
  if (!active) return;
  const p = active.provider;
  if (typeof p.removeListener === "function") {
    p.removeListener("accountsChanged", onAccounts);
    p.removeListener("chainChanged", onChain);
    p.removeListener("disconnect", onDisconnect);
  }
  active = null;
}

function onAccounts(accounts) {
  if (!active) return;
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    // Disconnected inside the wallet.
    detach();
    forget();
    S.conn = null;
    emit();
    return;
  }
  if (S.conn && accounts[0].toLowerCase() === S.conn.address.toLowerCase()) return;
  S.conn = { ...S.conn, info: active.info, address: accounts[0], balanceWei: null };
  emit();
  void refreshBalance();
}

function onChain(chainId) {
  if (!active || !S.conn) return;
  S.conn = { ...S.conn, chainId: Number(chainId), balanceWei: null };
  emit();
  void refreshBalance();
}

function onDisconnect() {
  // The provider lost its connection to every chain. Remembered, so a reload
  // can try again.
  detach();
  S.conn = null;
  emit();
}

// -------------------------------------------------------------- chain --

/** Ask the wallet to move to Robinhood Chain, adding the chain first if it does not know it. */
export async function ensureChain() {
  if (!active) throw new Error("No wallet is connected.");
  const p = active.provider;
  const sw = () => p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  try {
    await sw();
  } catch (e) {
    if (codeOf(e) !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD_CHAIN] });
    // Not every wallet switches after adding.
    await sw();
  }
  const chainId = Number(await p.request({ method: "eth_chainId" }));
  if (S.conn && S.conn.chainId !== chainId) onChain(chainId);
  return chainId;
}

/**
 * Read the connected address's ETH balance through the wallet's RPC. Only on
 * Robinhood Chain, and a result for an account or chain that has since
 * changed is dropped.
 */
export async function refreshBalance() {
  const c = S.conn;
  if (!active || !c || c.chainId !== CHAIN_ID) return;
  const p = active.provider;
  try {
    const wei = BigInt(await p.request({ method: "eth_getBalance", params: [c.address, "latest"] }));
    const now = S.conn;
    if (!now || now.address !== c.address || now.chainId !== c.chainId || active.provider !== p) return;
    S.conn = { ...now, balanceWei: wei };
    emit();
  } catch { /* the next refresh will try again */ }
}

// ------------------------------------------------------------- errors --

/** An EIP-1193 error code, including the nested form some mobile wallets use. */
export function codeOf(e) {
  const nested = e && e.data && e.data.originalError && e.data.originalError.code;
  return e && typeof e.code === "number" ? (e.code === -32603 && nested ? nested : e.code) : nested ?? null;
}

/** What went wrong, in words. */
export function walletError(e, method = "") {
  const code = codeOf(e);
  if (code === 4001) return "You rejected the request in your wallet.";
  if (code === -32002) return "Your wallet already has a request open. Check it.";
  if (code === 4100 || code === 4200) return `This wallet cannot do that${method ? ` (${method})` : ""}.`;
  const message = e && e.message ? String(e.message) : String(e);
  return code === null ? message : `${code}: ${message}`;
}

// ------------------------------------------------------------- memory --

function remember(rdns) {
  try { localStorage.setItem(REMEMBER, rdns); } catch { /* private window: no reconnect, nothing worse */ }
}

function recall() {
  try { return localStorage.getItem(REMEMBER); } catch { return null; }
}

function forget() {
  try { localStorage.removeItem(REMEMBER); } catch { /* nothing remembered to forget */ }
}
