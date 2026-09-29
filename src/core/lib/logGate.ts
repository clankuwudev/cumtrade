/**
 * A gate in front of the log node (public-release B4.6), and the route across
 * log endpoints (spec D1.0).
 *
 * Every eth_getLogs went to the chain's public node (client.ts), which answers
 * too many requests from one IP with HTTP 429. viem parses that body into
 * `RpcRequestError { code: 429 }`, "RPC Request failed.", and drops the HTTP
 * status and any Retry-After. On 2026-09-19 one refusal at startup turned into
 * 313 refused requests, because every caller tried again on its own.
 *
 * A refusal closes the gate. While it is closed, log requests fail at once
 * with `LogsBusy`, and nothing goes on the wire. It reopens after 30s, doubling
 * on each refusal in a row up to 5 minutes, and lets one request through as a
 * probe before the rest. A success resets the backoff.
 */

/** A log request not sent because the node is refusing us. */
export class LogsBusy extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`The chain's log node is refusing requests; retrying in ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = "LogsBusy";
  }
}

const RATE_LIMITED_CODES = new Set([429, -32005]);
const RATE_LIMITED_TEXT = /too many requests|rate.?limit/i;

/**
 * Is this error the node refusing us for volume? Looks through the whole cause
 * chain, because viem wraps the node's answer in one or two layers.
 */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof LogsBusy) return true;
  const seen = new Set<unknown>();
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === "object" && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    // The gate's own refusal arrives wrapped: client.ts's custom transport
    // hands it to viem, which throws UnknownRpcError with it as the cause.
    if (e instanceof LogsBusy) return true;
    if (typeof e.code === "number" && RATE_LIMITED_CODES.has(e.code)) return true;
    if (e.status === 429) return true;
    for (const k of ["message", "details", "shortMessage"]) {
      if (typeof e[k] === "string" && RATE_LIMITED_TEXT.test(e[k] as string)) return true;
    }
  }
  return false;
}

/** An RPC key refused for who is asking, not for what was asked: an allowlist, auth, or a dead key. */
const KEY_REFUSED_TEXT = /not on (the )?(whitelist|allowlist)|must be authenticated|unauthori[sz]ed|forbidden|invalid api key|api key (is )?(invalid|disabled|deleted)/i;

/**
 * Is this error the RPC provider refusing our key itself? Alchemy answers a
 * server call to an app with a domain allowlist with -32600 "Unspecified
 * origin not on whitelist", and a deleted or locked app with "Must be
 * authenticated!" (current-issues.md #6). That says nothing about the launch
 * being read, so, like a rate limit, it is a reason to wait and try again,
 * never a verdict. Looks through the cause chain, as isRateLimited does.
 */
export function isKeyRefused(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === "object" && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    if (e.status === 401 || e.status === 403) return true;
    for (const k of ["message", "details", "shortMessage"]) {
      if (typeof e[k] === "string" && KEY_REFUSED_TEXT.test(e[k] as string)) return true;
    }
  }
  return false;
}

export type LogGate = ReturnType<typeof createLogGate>;

export function createLogGate(opts: { now?: () => number; baseMs?: number; maxMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const baseMs = opts.baseMs ?? 30_000;
  const maxMs = opts.maxMs ?? 5 * 60_000;
  let closedUntil = 0; // 0: open
  let backoff = baseMs;
  let refusals = 0; // in a row
  let probing = false;

  return {
    /** Run one log request through the gate. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const t = now();
      if (closedUntil > 0) {
        if (t < closedUntil) throw new LogsBusy(closedUntil - t);
        // Time is up: one probe at a time, the rest wait for its answer.
        if (probing) throw new LogsBusy(1_000);
        probing = true;
      }
      try {
        const out = await fn();
        closedUntil = 0;
        backoff = baseMs;
        refusals = 0;
        return out;
      } catch (e) {
        if (isRateLimited(e)) {
          refusals++;
          closedUntil = now() + backoff;
          backoff = Math.min(maxMs, backoff * 2);
        }
        throw e;
      } finally {
        probing = false;
      }
    },

    /** Whether a request would go out now, and when it will if not. */
    state: () => {
      const t = now();
      return { open: closedUntil === 0 || t >= closedUntil, retryInMs: Math.max(0, closedUntil - t), refusals };
    },
  };
}

/**
 * Did the endpoint fail to answer at all, rather than answer "no"? A refusal
 * for volume, a closed gate, a timeout, the network, or an HTTP error other
 * than 400. A 400 is the request's fault: Alchemy answers a too-wide log query
 * with HTTP 400 and -32602 "Log response size exceeded" (measured 2026-09-23),
 * and that one must reach the caller, which splits the range. Another
 * endpoint would refuse the same query.
 */
export function isOutage(err: unknown): boolean {
  if (isRateLimited(err)) return true;
  const seen = new Set<unknown>();
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === "object" && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    // viem drops the HTTP status when the body is JSON-RPC, so a key Alchemy
    // will not serve is known by its words: HTTP 401, -32600 "Must be
    // authenticated!" (2026-09-23).
    for (const k of ["message", "details", "shortMessage"]) {
      if (typeof e[k] === "string" && ENDPOINT_REFUSED_TEXT.test(e[k] as string)) return true;
    }
    if (typeof e.status === "number") return e.status !== 400 && (e.status >= 400 || e.status === 0);
    if (e.name === "TimeoutError") return true;
    // viem's HttpRequestError with no status: the request never got an answer.
    if (e.name === "HttpRequestError") return true;
    if (e.name === "TypeError" && /fetch failed/i.test(String(e.message))) return true;
  }
  return false;
}

const TOO_WIDE_TEXT =
  /exceeds limit|response size exceeded|more than \d+ results|too many (logs|results)|query timed? ?out|log query timed out|block range/i;

/**
 * Did the endpoint refuse a log query for asking too much at once? The public
 * node: HTTP 200, -32000 "logs matched by query exceeds limit of 10000", or
 * "log query timed out". Alchemy (PAYG): HTTP 400, -32602 "Log response size
 * exceeded" (both measured 2026-09-23). The answer is a smaller range.
 */
export function isTooWide(err: unknown): boolean {
  if (isRateLimited(err)) return false;
  const seen = new Set<unknown>();
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === "object" && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    for (const k of ["message", "details", "shortMessage"]) {
      if (typeof e[k] === "string" && TOO_WIDE_TEXT.test(e[k] as string)) return true;
    }
  }
  return false;
}

const ENDPOINT_REFUSED_TEXT = /must be authenticated|unauthori[sz]ed|forbidden|capacity limit|invalid api key/i;

/** One log endpoint: where it is, and its own gate. */
export type LogEndpoint = { name: string; url: string; gate: LogGate };

/**
 * Log endpoints in order of preference, each behind its own gate (spec D1.0).
 * A request goes to the first; if that one is refusing us or down, to the
 * next. Only an outage moves a request on (`isOutage`): an answer, even an
 * error, is the answer.
 */
export function createLogRoute<E extends LogEndpoint>(endpoints: E[]) {
  if (endpoints.length === 0) throw new Error("a log route needs an endpoint");
  return {
    endpoints,
    /** Run `fn` on the first endpoint that answers, each through its gate. */
    async run<T>(fn: (endpoint: E) => Promise<T>): Promise<T> {
      for (let i = 0; ; i++) {
        const ep = endpoints[i]!;
        try {
          return await ep.gate.run(() => fn(ep));
        } catch (e) {
          if (i === endpoints.length - 1 || !isOutage(e)) throw e;
        }
      }
    },
    /** Open while any endpoint would take a request; otherwise, when the first one will. */
    state: () => {
      const states = endpoints.map((ep) => ep.gate.state());
      const open = states.some((s) => s.open);
      return {
        open,
        retryInMs: open ? 0 : Math.min(...states.map((s) => s.retryInMs)),
        refusals: states.reduce((a, s) => a + s.refusals, 0),
      };
    },
  };
}

export type LogRoute = ReturnType<typeof createLogRoute>;

/** The first log endpoint's gate. */
export const logGate = createLogGate();
/** The public node's gate, when it stands behind another log endpoint. */
export const publicLogGate = createLogGate();
