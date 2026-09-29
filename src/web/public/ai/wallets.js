// The two wallets that can sign in to cumAI (stage C, C-D1 to C-D3), as
// signers for gateway.js: `{ kind, address, sign(message) }`.
// - The trading wallet: the same Coinbase wallet as cumOS, logged in through
//   the same session (login.js, C5c). It signs silently, and only the
//   gateway's sign-in accepting TERMS_VERSION, the terms this site shows: the
//   facade checks it line for line (C3).
// - The visitor's own wallet: personal_sign, which their wallet asks them
//   about. Each is its own account, with its own allowance (K15).
import { TERMS_VERSION } from "../js/core/constants.js";
import { GatewayRefusal } from "./gateway.js";

/**
 * The logged-in trading wallet as a signer, or null when no one is logged in.
 * The facade's refusal (a message that isn't the gateway's sign-in, or other
 * terms) reads as `wallet_refused`: nothing was signed.
 */
export async function tradingSigner(facade, { termsVersion = TERMS_VERSION } = {}) {
  const address = facade ? await facade.address() : null;
  if (!address) return null;
  return {
    kind: "trading",
    address,
    async sign(message) {
      try {
        return await facade.signGatewayMessage(message, { termsVersion });
      } catch (e) {
        if (/^Refused:/.test(String(e?.message ?? ""))) throw new GatewayRefusal("wallet_refused", e.message);
        throw e;
      }
    },
  };
}

/**
 * The visitor's own wallets, as they announce themselves through EIP-6963
 * within `ms`: `{ uuid, name, provider }`. No icon: the page's policy allows
 * no data: image, and a name is enough to choose by. The name is shown as
 * text.
 */
export function discoverOwn(ms = 400, target = globalThis) {
  return new Promise((resolve) => {
    const found = new Map();
    const heard = (e) => {
      const d = e?.detail;
      if (typeof d?.provider?.request !== "function" || typeof d?.info?.uuid !== "string") return;
      found.set(d.info.uuid, { uuid: d.info.uuid, name: String(d.info.name || "Wallet").slice(0, 40), provider: d.provider });
    };
    target.addEventListener("eip6963:announceProvider", heard);
    target.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      target.removeEventListener("eip6963:announceProvider", heard);
      resolve([...found.values()]);
    }, ms);
  });
}

/** An own wallet's account, as it gives it when asked: its first address. */
export async function ownAccount(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const a = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("The wallet gave no account.");
  return a;
}

/** A string as the 0x hex personal_sign takes (EIP-191's message, as utf-8). */
export const toHex = (s) => `0x${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * The visitor's own wallet, an EIP-1193 provider (found through EIP-6963),
 * as a signer for `address`. Their wallet shows the message and asks.
 */
export function ownSigner(provider, address) {
  return {
    kind: "own",
    address,
    sign: (message) => provider.request({ method: "personal_sign", params: [toHex(message), address] }),
  };
}
