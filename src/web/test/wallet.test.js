// The visitor's wallet (public-release F2): EIP-6963 discovery, connecting,
// silent reconnect, chain switching and the provider's events, against
// scripted wallets. Each test gets a fresh window, fresh storage and a fresh
// copy of the module, so nothing one test connects leaks into the next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";

const ALICE = "0x00000000000000000000000000000000000A11cE";
const BOB = "0x000000000000000000000000000000000000B0b0";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
let fresh = 0;

/** A new window and storage, and a module instance that has never seen them. */
async function setup() {
  globalThis.window = new EventTarget();
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
  S.conn = null;
  const mod = await import(`../public/js/wallet/eip6963.js?fresh=${++fresh}`);
  return mod;
}

/** Keep localStorage across a "reload": a new module and window, the same storage. */
async function reload(storage) {
  globalThis.window = new EventTarget();
  globalThis.localStorage = storage;
  S.conn = null;
  return import(`../public/js/wallet/eip6963.js?fresh=${++fresh}`);
}

const err = (code, message = "wallet error", data) => Object.assign(new Error(message), { code, data });

/**
 * A scripted EIP-1193 wallet that announces itself over EIP-6963. It records
 * every method asked of it, and lets a test move its account or chain the way
 * a user would inside the wallet.
 */
function wallet({
  uuid, name, rdns, icon = PNG, chainId = 4663, accounts = [ALICE], authorized = false,
  knowsChain = true, balance = 10n ** 16n, nested4902 = false, reject = false, announce = true,
}) {
  const state = { chainId, accounts, authorized, knowsChain, balance, reject, added: null, slowBalance: null };
  const handlers = {};
  const calls = [];
  const provider = {
    on: (ev, fn) => { (handlers[ev] ??= new Set()).add(fn); },
    removeListener: (ev, fn) => { handlers[ev]?.delete(fn); },
    async request({ method, params }) {
      calls.push(method);
      switch (method) {
        case "eth_requestAccounts":
          if (state.reject) throw err(4001, "User rejected the request.");
          state.authorized = true;
          return state.accounts;
        case "eth_accounts": return state.authorized ? state.accounts : [];
        case "eth_chainId": return "0x" + state.chainId.toString(16);
        case "eth_getBalance": {
          // The balance at the moment of asking, even if the answer is slow.
          const wei = state.balance;
          if (state.slowBalance) await state.slowBalance;
          return "0x" + wei.toString(16);
        }
        case "wallet_switchEthereumChain":
          if (!state.knowsChain) throw nested4902 ? err(-32603, "internal", { originalError: { code: 4902 } }) : err(4902, "Unrecognized chain ID");
          state.chainId = Number(params[0].chainId);
          emit("chainChanged", params[0].chainId);
          return null;
        case "wallet_addEthereumChain":
          state.knowsChain = true;
          state.added = params[0];
          return null;
        case "wallet_revokePermissions":
          state.authorized = false;
          return null;
      }
      throw err(4200, `unsupported ${method}`);
    },
  };
  function emit(ev, arg) { for (const fn of handlers[ev] ?? []) fn(arg); }
  const detail = { info: { uuid, name, icon, rdns }, provider };
  const say = () => window.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail }));
  if (announce) window.addEventListener("eip6963:requestProvider", say);
  return {
    provider, state, calls, emit, say,
    listeners: () => Object.values(handlers).reduce((n, s) => n + s.size, 0),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// ----------------------------------------------------------- discovery --

test("every announcing wallet is listed once, and the injected global is not offered beside them", async () => {
  const w = await setup();
  wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  const rabby = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby" });
  window.addEventListener("eip6963:requestProvider", () => rabby.say()); // announces twice
  window.ethereum = { request: async () => null };
  const list = await w.discover(20);
  assert.deepEqual(list.map((x) => x.name), ["MetaMask", "Rabby"]);
});

test("the first announcement for a uuid wins; a later one cannot swap in its own provider", async () => {
  const w = await setup();
  const real = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  const impostor = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask", accounts: [BOB] });
  await w.discover(20);
  assert.equal(w.wallets().length, 1);
  await w.connect("mm");
  assert.equal(w.provider(), real.provider);
  assert.deepEqual(impostor.calls, []);
});

test("malformed announcements are ignored", async () => {
  const w = await setup();
  const junk = [
    { info: { uuid: "a", name: "No request", rdns: "x" }, provider: {} },
    { info: { uuid: "b", name: 42, rdns: "x" }, provider: { request: async () => null } },
    { info: { uuid: "", name: "Empty uuid", rdns: "x" }, provider: { request: async () => null } },
    { info: null, provider: { request: async () => null } },
    null,
  ];
  window.addEventListener("eip6963:requestProvider", () => {
    for (const detail of junk) window.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail }));
  });
  wallet({ uuid: "ok", name: "Fine", rdns: "fine" });
  assert.deepEqual((await w.discover(20)).map((x) => x.name), ["Fine"]);
});

test("with no announcements, the injected global is offered as Browser wallet", async () => {
  const w = await setup();
  window.ethereum = { request: async () => null };
  assert.deepEqual(await w.discover(20), [{ uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }]);
});

test("with nothing at all, there is nothing to pick", async () => {
  const w = await setup();
  assert.deepEqual(await w.discover(20), []);
});

test("a wallet that announces after the window still joins the list", async () => {
  const w = await setup();
  await w.discover(20);
  const late = wallet({ uuid: "late", name: "Late", rdns: "late", announce: false });
  late.say();
  assert.deepEqual(w.wallets().map((x) => x.name), ["Late"]);
});

test("only an inline image under 100 KB is kept as an icon", async () => {
  const w = await setup();
  assert.equal(w.safeIcon(PNG), PNG);
  assert.equal(w.safeIcon("DATA:IMAGE/svg+xml;base64,PHN2Zy8+"), "DATA:IMAGE/svg+xml;base64,PHN2Zy8+");
  for (const bad of ["https://evil.test/i.png", "javascript:alert(1)", "data:text/html,<b>", `data:image/png;base64,${"A".repeat(100_000)}`, null, 7]) {
    assert.equal(w.safeIcon(bad), "", String(bad).slice(0, 40));
  }
  wallet({ uuid: "x", name: "Tracker", rdns: "t", icon: "https://evil.test/pixel.png" });
  assert.equal((await w.discover(20))[0].icon, "");
});

// ---------------------------------------------------------- connection --

test("connecting asks for accounts, reads the chain and balance, and remembers only the wallet", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  let changes = 0;
  w.onChange(() => changes++);
  assert.equal(await w.connect("mm"), ALICE);
  assert.deepEqual(mm.calls, ["eth_requestAccounts", "eth_chainId", "eth_getBalance"]);
  assert.deepEqual({ ...S.conn, info: S.conn.info.rdns }, { info: "io.metamask", address: ALICE, chainId: 4663, balanceWei: 10n ** 16n });
  assert.deepEqual(localStorage.dump(), { "clank.wallet": "io.metamask" });
  assert.ok(changes >= 2, "a change for the connection and one for the balance");
  assert.equal(w.provider(), mm.provider);
});

test("a rejected connection leaves nothing connected or remembered", async () => {
  const w = await setup();
  wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask", reject: true });
  await w.discover(20);
  await assert.rejects(w.connect("mm"), (e) => w.walletError(e) === "You rejected the request in your wallet.");
  assert.equal(S.conn, null);
  assert.deepEqual(localStorage.dump(), {});
});

test("a wallet that approves but returns no account is not connected", async () => {
  const w = await setup();
  wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask", accounts: [] });
  await w.discover(20);
  await assert.rejects(w.connect("mm"), /no account/);
  assert.equal(S.conn, null);
  assert.equal(w.provider(), null);
  assert.deepEqual(localStorage.dump(), {});
});

test("a reload reconnects the remembered wallet with eth_accounts, never a popup", async () => {
  let w = await setup();
  wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  const storage = globalThis.localStorage;

  w = await reload(storage);
  const mm = wallet({ uuid: "mm2", name: "MetaMask", rdns: "io.metamask", authorized: true });
  const other = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby", authorized: true, accounts: [BOB] });
  await w.discover(20);
  assert.equal(await w.reconnect(), ALICE);
  assert.ok(!mm.calls.includes("eth_requestAccounts"));
  assert.deepEqual(mm.calls, ["eth_accounts", "eth_chainId", "eth_getBalance"]);
  assert.deepEqual(other.calls, [], "an unremembered wallet is not asked anything");
  assert.equal(S.conn.address, ALICE);
});

test("with nothing remembered, a reload asks no wallet anything", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask", authorized: true });
  await w.discover(20);
  assert.equal(await w.reconnect(), null);
  assert.deepEqual(mm.calls, []);
});

test("a wallet that no longer authorises the site is forgotten on reload", async () => {
  const w = await setup();
  localStorage.setItem("clank.wallet", "io.metamask");
  wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask", authorized: false });
  await w.discover(20);
  assert.equal(await w.reconnect(), null);
  assert.equal(S.conn, null);
  assert.deepEqual(localStorage.dump(), {});
});

test("disconnecting forgets the wallet, clears the connection, and revokes where it can", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  await w.disconnect();
  assert.equal(S.conn, null);
  assert.equal(w.provider(), null);
  assert.deepEqual(localStorage.dump(), {});
  assert.equal(mm.calls.at(-1), "wallet_revokePermissions");
  assert.equal(mm.listeners(), 0);
});

test("connecting a second wallet drops the first one's listeners", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  const rb = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby", accounts: [BOB] });
  await w.discover(20);
  await w.connect("mm");
  assert.equal(mm.listeners(), 3);
  await w.connect("rb");
  assert.equal(mm.listeners(), 0);
  assert.equal(rb.listeners(), 3);
  assert.equal(S.conn.address, BOB);
  // The old wallet's events no longer reach us.
  mm.emit("accountsChanged", []);
  assert.equal(S.conn.address, BOB);
});

// --------------------------------------------------------------- chain --

test("switching to a chain the wallet knows is one request", async () => {
  const w = await setup();
  const rb = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby", chainId: 1 });
  await w.discover(20);
  await w.connect("rb");
  assert.equal(S.conn.chainId, 1);
  assert.ok(!rb.calls.includes("eth_getBalance"), "a balance on another chain is not read");
  rb.calls.length = 0;
  assert.equal(await w.ensureChain(), 4663);
  assert.equal(rb.calls[0], "wallet_switchEthereumChain");
  assert.ok(!rb.calls.includes("wallet_addEthereumChain"));
  assert.equal(S.conn.chainId, 4663);
  await settle();
  assert.equal(S.conn.balanceWei, 10n ** 16n, "and once there, the balance is read");
});

for (const nested of [false, true]) {
  test(`a wallet without the chain adds it and switches again${nested ? " (4902 nested, as some mobile wallets send it)" : ""}`, async () => {
    const w = await setup();
    const rb = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby", chainId: 1, knowsChain: false, nested4902: nested });
    await w.discover(20);
    await w.connect("rb");
    rb.calls.length = 0;
    assert.equal(await w.ensureChain(), 4663);
    assert.deepEqual(rb.calls.slice(0, 3), ["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
    assert.deepEqual(rb.state.added, {
      chainId: "0x1237", chainName: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
      blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
    });
    assert.equal(S.conn.chainId, 4663);
  });
}

test("a refused switch is an error, not a chain change", async () => {
  const w = await setup();
  const rb = wallet({ uuid: "rb", name: "Rabby", rdns: "io.rabby", chainId: 1 });
  await w.discover(20);
  await w.connect("rb");
  rb.provider.request = async ({ method }) => {
    if (method === "wallet_switchEthereumChain") throw err(4001, "User rejected");
    return "0x1";
  };
  await assert.rejects(w.ensureChain(), (e) => w.codeOf(e) === 4001);
  assert.equal(S.conn.chainId, 1);
});

// -------------------------------------------------------------- events --

test("changing account inside the wallet updates the connection and re-reads the balance", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  mm.state.balance = 0n;
  mm.emit("accountsChanged", [BOB]);
  assert.equal(S.conn.address, BOB);
  assert.equal(S.conn.balanceWei, null, "the old account's balance is not shown for the new one");
  await settle();
  assert.equal(S.conn.balanceWei, 0n);
});

test("an empty account list means disconnected inside the wallet: cleared and forgotten", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  mm.emit("accountsChanged", []);
  assert.equal(S.conn, null);
  assert.deepEqual(localStorage.dump(), {});
});

test("a chain change updates the connection, and the balance is only read on Robinhood Chain", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  mm.calls.length = 0;
  mm.emit("chainChanged", "0x1");
  await settle();
  assert.equal(S.conn.chainId, 1);
  assert.equal(S.conn.balanceWei, null);
  assert.ok(!mm.calls.includes("eth_getBalance"));
  mm.emit("chainChanged", "0x1237");
  await settle();
  assert.equal(S.conn.chainId, 4663);
  assert.equal(S.conn.balanceWei, 10n ** 16n);
});

test("a provider disconnect clears the connection but remembers the wallet for a reload", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  mm.emit("disconnect", err(4900, "Disconnected"));
  assert.equal(S.conn, null);
  assert.deepEqual(localStorage.dump(), { "clank.wallet": "io.metamask" });
});

test("a balance that arrives after the account changed is dropped", async () => {
  const w = await setup();
  const mm = wallet({ uuid: "mm", name: "MetaMask", rdns: "io.metamask" });
  await w.discover(20);
  await w.connect("mm");
  let release;
  mm.state.slowBalance = new Promise((r) => { release = r; });
  mm.state.balance = 5n;
  const pending = w.refreshBalance();
  mm.state.slowBalance = null;
  mm.state.balance = 7n;
  mm.emit("accountsChanged", [BOB]);
  await settle();
  assert.equal(S.conn.balanceWei, 7n, "Bob's own balance");
  release();
  await pending;
  assert.equal(S.conn.address, BOB);
  assert.equal(S.conn.balanceWei, 7n, "the late read for Alice did not overwrite it");
});

// -------------------------------------------------------------- errors --

test("wallet errors are said in words", async () => {
  const w = await setup();
  assert.equal(w.walletError(err(4001)), "You rejected the request in your wallet.");
  assert.equal(w.walletError(err(-32002)), "Your wallet already has a request open. Check it.");
  assert.equal(w.walletError(err(4200), "wallet_addEthereumChain"), "This wallet cannot do that (wallet_addEthereumChain).");
  assert.equal(w.walletError(err(4100)), "This wallet cannot do that.");
  assert.equal(w.walletError(err(-32000, "header not found")), "-32000: header not found");
  assert.equal(w.walletError(new Error("plain")), "plain");
  assert.equal(w.codeOf(err(-32603, "internal", { originalError: { code: 4902 } })), 4902);
});
