import { createPublicClient, http, webSocket, custom, fallback, type Transport } from "viem";
import { config as loadDotenv } from "dotenv";
import { robinhood } from "../chain.js";
import { throttle } from "./throttle.js";
import { createLogRoute, logGate, publicLogGate } from "./logGate.js";
import { countRpc, endpointOf } from "./meter.js";

// A hosted process reads only its environment: systemd's EnvironmentFile on a
// server, `--env-file-if-exists=.env.hosted` locally. A `.env` in its working
// directory is the operator's self config, with wallet settings and the self
// RPC key, and hosted must not pick it up (public-release P8, H1).
if ((globalThis as { __CLANK_MODE__?: string }).__CLANK_MODE__ !== "hosted") loadDotenv();

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Fast provider endpoint: eth_call, simulate, subscriptions. */
const fastUrl = process.env.RPC_URL ?? PUBLIC_RPC;

/**
 * Endpoint for log scans, and the public node behind it (spec D1.0).
 *
 * `LOGS_RPC_URL` is the site's Alchemy app on Pay-As-You-Go, which answers
 * any block range under 10,000 logs, or 5,000 blocks with no limit. Its free
 * tier capped eth_getLogs at 10 blocks, which is why history went to the
 * chain's public node, and still does when `LOGS_RPC_URL` is unset. With it
 * set, the public node stands behind it: a refusal or an outage there moves
 * the request to the public node (`createLogRoute`).
 */
const logUrl = process.env.LOGS_RPC_URL ?? process.env.RPC_FALLBACK ?? PUBLIC_RPC;

/** Behind it: the public node, unless `LOGS_FALLBACK_URL` names another or is empty (none). */
const logFallbackUrl = process.env.LOGS_FALLBACK_URL ?? PUBLIC_RPC;

const opts = { retryCount: 3, retryDelay: 250, timeout: 25_000 } as const;

const fastTransport = createPublicClient({
  chain: robinhood,
  transport: fallback([
    http(fastUrl, { ...opts, batch: { wait: 12 } }),
    http(PUBLIC_RPC, { ...opts, batch: { wait: 12 } }),
  ]),
});

// No batching: these are single large requests, not chatty ones. Retries are
// kept low deliberately — a wide scan that is struggling gets slower under
// retry pressure, not faster, and the caller already degrades gracefully.
const logEndpoint = (url: string, gate: typeof logGate) => ({
  name: endpointOf(url),
  url,
  gate,
  request: http(url, { retryCount: 1, retryDelay: 800, timeout: 90_000 })({ chain: robinhood }).request,
});

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

const primaryLogs = logEndpoint(logUrl, logGate);
const behindLogs = !logFallbackUrl || sameUrl(logUrl, logFallbackUrl) ? null : logEndpoint(logFallbackUrl, publicLogGate);

/** Every log request goes through this: the first endpoint that answers. */
export const logRoute = createLogRoute(behindLogs ? [primaryLogs, behindLogs] : [primaryLogs]);

/**
 * The chain follower's steady tail (spec D1): two small filters every 2 s,
 * ~60 requests a minute. They go to the endpoint behind (the public node)
 * first, because on Alchemy they would cost tens of dollars a month, and
 * tiny ranges are what the public node answers well. `TAIL_RPC=alchemy`
 * puts the log endpoint first. Wide reads (a backfill) use `logRoute`.
 */
export const tailRoute = behindLogs && process.env.TAIL_RPC !== "alchemy"
  ? createLogRoute([behindLogs, primaryLogs])
  : logRoute;

export type LogEndpointClient = (typeof logRoute.endpoints)[number];

/**
 * Methods served by the log route instead of the fast provider.
 *
 * Only log scans. Everything else stays on the provider — routing more away
 * from it to save CU backfired, because the public node's retries cost more
 * in wall-clock and load than the CU ever cost us against a 30M budget.
 */
const LOG_METHODS = new Set([
  "eth_getLogs", "eth_newFilter", "eth_getFilterLogs",
]);

/**
 * Read client.
 *
 * `batch.multicall` folds concurrent readContract calls into ONE Multicall3
 * aggregate3 eth_call — that is the layer that actually cuts billed requests,
 * since a JSON-RPC batch costs the same latency but is billed per entry.
 * Requests are then routed by method to whichever endpoint can serve them.
 */
export const client = createPublicClient({
  chain: robinhood,
  batch: { multicall: { wait: 12, batchSize: 2048 } },
  transport: custom({
    async request({ method, params }) {
      if (LOG_METHODS.has(method)) {
        // Through each endpoint's gate: while one is refusing us, nothing is
        // sent to it (logGate.ts, public-release B4.6, D1.0).
        return logRoute.run((ep) => ep.request({ method, params } as never));
      }
      // Provider-bound: pay for it in CU before dispatching, so a burst is
      // spread rather than rejected.
      await throttle(method);
      return fastTransport.request({ method, params } as never);
    },
  }),
});

export const wsUrl = process.env.WS_URL ?? null;

/**
 * The websocket, counted by the meter (D1.0): it does not go through fetch.
 * Requests count by method, a subscription as `eth_subscribe`, and each
 * notification it delivers as `eth_subscription`.
 */
function countedWebSocket(url: string): Transport {
  const inner = webSocket(url, { retryCount: 10, retryDelay: 500, keepAlive: true });
  return ((args: Parameters<typeof inner>[0]) => {
    const t = inner(args);
    const value = t.value as { subscribe?: (p: { onData: (d: unknown) => void }) => Promise<unknown> } | undefined;
    return {
      ...t,
      request: (async (a: { method: string }) => {
        countRpc(a.method, "websocket");
        return t.request(a as never);
      }) as typeof t.request,
      value: value?.subscribe
        ? {
            ...value,
            subscribe: (p: { onData: (d: unknown) => void }) => {
              countRpc("eth_subscribe", "websocket");
              return value.subscribe!({
                ...p,
                onData: (d: unknown) => { countRpc("eth_subscription", "websocket"); p.onData(d); },
              });
            },
          }
        : t.value,
    };
  }) as Transport;
}

export const wsClient = wsUrl
  ? createPublicClient({ chain: robinhood, transport: countedWebSocket(wsUrl) })
  : null;

export const endpoints = { fast: fastUrl, logs: logUrl, ws: wsUrl };

export const fmtEth = (v: bigint, dp = 4) =>
  (Number(v) / 1e18).toFixed(dp).replace(/\.?0+$/, "") || "0";

export const fmtNum = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(2) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1) + "K"
  : n.toFixed(2);

export const pct = (n: number, dp = 2) => n.toFixed(dp) + "%";
export const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
