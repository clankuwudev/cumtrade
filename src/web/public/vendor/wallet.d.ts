// Types for the page's type check only: the facade in scripts/vendor/wallet-entry.js,
// which scripts/vendor-wallet.mjs bundles into wallet.js beside this file. The
// check reads this instead of the minified bundle. Never served: /vendor/
// admits wallet.js and LICENSES.txt only, and a release leaves out .d.ts files.

/** An EIP-1193 provider: the visitor's own wallet, for a sign-in. */
type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<any> };

/**
 * An EIP-1559 transaction for Robinhood Chain, from the logged-in trading
 * wallet. Anything but a cumTrade trade (trade/guard.js), another chain ID or
 * type, or a fee or gas over the page's ceilings is refused (P4 T2).
 */
export type Transaction = {
  from: string;
  type: "eip1559";
  chainId: 4663;
  nonce: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function init(options: { projectId: string }): Promise<void>;
export function startLogin(provider: "google" | "x"): Promise<void>;
export function loginWithWallet(eip1193: Eip1193): Promise<string>;
export function completeLogin(): Promise<string | null>;
export function address(): Promise<string | null>;
export function signTransaction(tx: Transaction): Promise<string>;
/**
 * The gateway's sign-in message, signed by the trading wallet (Stage C, C-D2).
 * Refused, with nothing signed, unless it is line for line the gateway's
 * sign-in for this site and this wallet, accepting the terms at `termsVersion`.
 */
export function signGatewayMessage(message: string, options: { termsVersion: string }): Promise<`0x${string}`>;
export function mountExport(
  element: HTMLElement,
  address: string,
  onStatus?: (status: string, message?: string) => void,
): Promise<() => void>;
export function logout(): Promise<void>;
export function onAuthChange(cb: (address: string | null) => void): () => void;
