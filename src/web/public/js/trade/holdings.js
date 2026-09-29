import { CHAIN_ID, READ } from "./constants.js";
import { hexBody, uintAt, word } from "./abi.js";

// ====================================================================== //
// what the visitor's wallet holds                                        //
// ====================================================================== //
//
// A hosted token page sells a share of what the visitor's wallet actually
// holds (public-release F3.4). That is one `balanceOf` through their own
// provider, never a call to our server with their address. Entries are kept
// per address and token for a short while, read at most once at a time, only
// on Robinhood Chain, and a result for an address that has since changed is
// dropped rather than shown.

const FRESH_MS = 30_000;

/**
 * @param {{
 *   provider: () => ({ request: (args: { method: string, params?: unknown[] }) => Promise<any> } | null),
 *   onChange?: () => void,
 *   now?: () => number,
 * }} d
 */
export function createHoldings(d) {
  const now = d.now ?? (() => Date.now());
  const onChange = d.onChange ?? (() => {});
  /** @type {Map<string, { state: "unknown" | "loading" | "ok" | "error", balance: bigint | null, at: number }>} */
  const entries = new Map();
  const inflight = new Map();
  let generation = 0;

  const key = (address, token) => `${String(address).toLowerCase()}:${String(token).toLowerCase()}`;

  /** What is known about this address's balance of this token. */
  function get(address, token) {
    const e = entries.get(key(address, token));
    return e ? { state: e.state, balance: e.balance } : { state: "unknown", balance: null };
  }

  /** Read it if nothing is known or what is known is stale. */
  function ensure(address, token) {
    const e = entries.get(key(address, token));
    if (e && (e.state === "loading" || now() - e.at < FRESH_MS)) return inflight.get(key(address, token)) ?? Promise.resolve();
    return refresh(address, token);
  }

  /** Read it now, unless a read of the same key is already on its way. */
  function refresh(address, token) {
    const k = key(address, token);
    if (inflight.has(k)) return inflight.get(k);
    const p = read(k, address, token).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  async function read(k, address, token) {
    const provider = d.provider();
    if (!provider) return;
    const gen = generation;
    const prev = entries.get(k);
    entries.set(k, { state: "loading", balance: prev ? prev.balance : null, at: prev ? prev.at : 0 });
    onChange();
    /** @type {{ state: "ok" | "error", balance: bigint | null, at: number }} */
    let next;
    try {
      // Only on Robinhood Chain: a balance on any other chain is not this token.
      // Recorded as unknown, with a time, so a redraw does not ask again at once.
      if (Number(await provider.request({ method: "eth_chainId" })) !== CHAIN_ID) {
        if (gen !== generation) return;
        entries.set(k, { state: "unknown", balance: null, at: now() });
        onChange();
        return;
      }
      const out = await provider.request({
        method: "eth_call", params: [{ to: token, data: READ.balanceOf + word(address) }, "latest"],
      });
      next = { state: "ok", balance: uintAt(hexBody(out), 0), at: now() };
    } catch {
      next = { state: "error", balance: null, at: now() };
    }
    // Cleared while the read was out (the chain or account moved): drop it.
    if (gen !== generation) return;
    entries.set(k, next);
    onChange();
  }

  /** Forget everything, for a chain change. A read already out is dropped when it lands. */
  function clear() {
    generation++;
    entries.clear();
    inflight.clear();
    onChange();
  }

  return { get, ensure, refresh, clear };
}
