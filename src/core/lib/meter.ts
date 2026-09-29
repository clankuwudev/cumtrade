import { AsyncLocalStorage } from "node:async_hooks";

/**
 * RPC meter. Wraps global fetch to count what actually leaves the process:
 * HTTP round trips, and the JSON-RPC sub-requests inside them (which is what
 * a provider bills and rate-limits on).
 *
 * Each call is counted three ways (spec D1.0): by method, by the part of the
 * process that asked (`withSource`), and by the endpoint it went to. The
 * websocket does not use fetch; client.ts counts it through `countRpc`.
 * Nothing about an address or a URL's path is kept, only a host's class.
 */
type Counts = Record<string, number>;
type Stat = { http: number; sub: number; byMethod: Counts; bySource: Counts; byEndpoint: Counts; ms: number };

const empty = (): Stat => ({ http: 0, sub: 0, byMethod: {}, bySource: {}, byEndpoint: {}, ms: 0 });

/** Since boot (or `resetMeter`). */
let stat: Stat = empty();
/** Since the last `drainMeterWindow`: the minute line. */
let window: Stat = empty();
let installed = false;

const source = new AsyncLocalStorage<string>();

/**
 * Run `fn` with its RPC calls counted under `name`. The name follows the call
 * through awaits and timers started inside it. Calls viem folds into one
 * multicall or one batch are counted under whoever started the batch.
 */
export function withSource<T>(name: string, fn: () => T): T {
  return source.run(name, fn);
}

/** Where a request went, as a class: never the URL, which can carry a key. */
export function endpointOf(url: string): string {
  let host: string;
  try { host = new URL(url).hostname; } catch { return "other"; }
  if (host.endsWith(".alchemy.com")) return "alchemy";
  if (host === "rpc.mainnet.chain.robinhood.com") return "public";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
  return "other";
}

const bump = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };

/** Count `n` JSON-RPC calls of `method` sent to `endpoint` in one round trip. */
export function countRpc(method: string, endpoint: string, n = 1) {
  const from = source.getStore() ?? "other";
  for (const s of [stat, window]) {
    bump(s.byMethod, method, n);
    bump(s.bySource, from, n);
    bump(s.byEndpoint, endpoint, n);
  }
}

export function installMeter() {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    let bodies: any[] = [];
    try {
      const raw = init?.body;
      if (typeof raw === "string") {
        const parsed = JSON.parse(raw);
        bodies = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch { /* not json-rpc */ }
    bodies = bodies.filter((b) => typeof b?.method === "string");
    if (bodies.length) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
      const endpoint = endpointOf(url);
      for (const s of [stat, window]) {
        s.http += 1;
        s.sub += bodies.length;
      }
      for (const b of bodies) countRpc(b.method, endpoint);
    }
    const t0 = Date.now();
    try {
      return await orig(input, init);
    } finally {
      if (bodies.length) {
        const ms = Date.now() - t0;
        stat.ms += ms;
        window.ms += ms;
      }
    }
  };
}

const copy = (s: Stat): Stat => ({
  ...s, byMethod: { ...s.byMethod }, bySource: { ...s.bySource }, byEndpoint: { ...s.byEndpoint },
});

export function resetMeter() {
  stat = empty();
}

export function readMeter(): Stat {
  return copy(stat);
}

/** The counts since the last drain, and a fresh window. */
export function drainMeterWindow(): Stat {
  const w = window;
  window = empty();
  return w;
}

const listed = (c: Counts) =>
  Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");

/**
 * One line for the journal: a window's calls by method, source and endpoint,
 * or null when nothing was sent.
 */
export function meterLine(w: Stat): string | null {
  const calls = Object.values(w.byMethod).reduce((a, b) => a + b, 0);
  if (calls === 0) return null;
  return `[rpc] last minute: ${calls} call(s), ${w.http} http · method ${listed(w.byMethod)}`
    + ` · source ${listed(w.bySource)} · endpoint ${listed(w.byEndpoint)}`;
}

export function formatMeter(label: string, wallMs: number) {
  const s = readMeter();
  const methods = Object.entries(s.byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}=${n}`)
    .join(" ");
  return `${label.padEnd(26)} http=${String(s.http).padStart(3)}  rpc=${String(s.sub).padStart(4)}  wall=${String(wallMs).padStart(5)}ms  [${methods}]`;
}
