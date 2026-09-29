// Types for the console's type check only. Never served: the /js/ route admits
// nothing but `.js` files.

interface Window {
  /** A legacy injected provider. Only wallet/eip6963.js may read it (check-web). */
  ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<any> };
}
