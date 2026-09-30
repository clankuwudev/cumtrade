import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, type Address } from "viem";
import { FACTORIES } from "../../core/chain.js";
import { logRoute, wsClient } from "../../core/lib/client.js";
import { isRateLimited, LogsBusy } from "../../core/lib/logGate.js";
import { withSource } from "../../core/lib/meter.js";
import { indexHealth, indexedTokenTrades } from "../../core/lib/chainIndex.js";
import { dailyUsd } from "../../core/lib/ethusd.js";
import { ethUsd } from "../../core/lib/price.js";
import { replayData, LEAD_MS, type ReplayData } from "../../core/record/replayData.js";
import { aiPageHeaders, createApp, docsPageHeaders, hostedPageHeaders, json, landingPageHeaders, readJson, send, type Refusal, type Route } from "../http.js";
import { ledgerPayload, type LedgerResponse } from "../ledgerPayload.js";
import { BRAND, TRUST_PROXY, WEB_DIR } from "../config.js";
import { clientAddress, loopbackHost, publicHost } from "../origin.js";
import { classify, createLimiter, type Limiter } from "../rateLimit.js";
import { prepareBuy, prepareSell } from "../prepare.js";
import { rows } from "../board.js";
import { publicRoutes } from "./public.js";

// Routes only hosted mode serves, and the gate in front of every hosted route.
// There is no wallet, sniper or exit manager behind a hosted page. Report
// arrives in B2.4.

/**
 * Hosted configuration. Self mode's config describes a sniper and its exit
 * rules, which mean nothing here. The page needs to know its mode and what it
 * may offer.
 */
export const configRoute: Route = {
  name: "config",
  match: (url) => url.pathname === "/api/config",
  async handle(_req, res) {
    return send(res, 200, {
      mode: "hosted",
      brand: BRAND,
      features: { trade: "wallet", sniper: false, positions: "lookup", decisions: false },
      factories: FACTORIES.map((f) => f.address),
    });
  },
};

/**
 * The console page, with no session token: nothing on a hosted page is
 * authorised by one, so its meta tag is removed.
 *
 * It is stamped with its mode instead. Module scripts run after the document is
 * parsed, and a browser may paint before that, so only markup can keep the
 * operator's chrome (wallet, sniper, arm switch) from flashing on a public
 * page. The stylesheet hides it from the first paint (public-release F1.1).
 *
 * It carries the hosted policy, not self's (F5.6): the trading wallet talks
 * to Coinbase and the chain's RPC, and shows Coinbase's export frame.
 *
 * It answers at /trade and /console (L1; P2b): the landing has /, and cumAI /ai (L4b).
 *
 * This is for local runs. A release has no app.html here: Caddy serves the
 * page from the release's page/ with its policy, and Node never writes it
 * (H1.2). So in a release this answers 404, never a page with Node's headers.
 */
export const APP_PATHS = ["/trade", "/console"];
export const pageRoute: Route = {
  name: "page",
  match: (url) => APP_PATHS.includes(url.pathname),
  async handle(_req, res) {
    let html: string;
    try {
      html = await readFile(join(WEB_DIR, "public", "app.html"), "utf8");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, hostedPageHeaders());
    res.end(html
      .replace("<body>", '<body data-mode="hosted">')
      // No session token exists here, so the page carries no slot for one and
      // sends no x-clank-token header (F5.2).
      .replace(/<meta name="clank-token"[^>]*>\r?\n/, ""));
  },
};

/**
 * The landing at / (L1), with its own policy: no wallet, no Coinbase origin,
 * no inline style, and the gateway as its one connection. Served as written:
 * the release's only edits are its asset URLs and the sha in its footer.
 *
 * For local runs, like the app's route: in a release Caddy serves the
 * landing, and this answers 404.
 */
export const landingRoute: Route = {
  name: "landing",
  match: (url) => url.pathname === "/",
  async handle(_req, res) {
    let html: string;
    try {
      html = await readFile(join(WEB_DIR, "public", "landing", "index.html"), "utf8");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, landingPageHeaders());
    res.end(html);
  },
};

/**
 * cumAI at /ai (L1 L4b; N-D6, changed by the user): a page of its own, with
 * its own policy, served as written like the landing. For local runs: in a
 * release Caddy serves it, and this answers 404.
 */
export const aiRoute: Route = {
  name: "ai",
  match: (url) => url.pathname === "/ai",
  async handle(_req, res) {
    let html: string;
    try {
      html = await readFile(join(WEB_DIR, "public", "ai", "index.html"), "utf8");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, aiPageHeaders());
    res.end(html);
  },
};

/**
 * The project docs at /docs (PD): a page of their own, with their own policy,
 * served as written like the landing. For local runs: in a release Caddy
 * serves them, and this answers 404.
 */
export const docsRoute: Route = {
  name: "docs",
  match: (url) => url.pathname === "/docs",
  async handle(_req, res) {
    let html: string;
    try {
      html = await readFile(join(WEB_DIR, "public", "docs", "index.html"), "utf8");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, docsPageHeaders());
    res.end(html);
  },
};

/** The app's old names, each a 301 to /trade (L1 N-D9; P2b added /os), as the Caddyfile answers them. */
export const RENAMED_PATHS = ["/os", "/cumOS", "/cumos", "/terminal"];
export const renamedRoute: Route = {
  name: "renamed",
  match: (url) => RENAMED_PATHS.includes(url.pathname),
  async handle(_req, res, url) {
    // The query goes with it, as Caddy's {?query} keeps it: a login's return (?code=…) begun on an old name.
    res.writeHead(301, { location: `/trade${url.search}` }).end();
  },
};

/**
 * A page's own files, under /landing/, /ai/ or /docs/, by type (L1; PD). One
 * flat directory each, and only types that can never be a document, as a
 * release serves them under /v/<sha>/. The pages themselves, index.html, are
 * served at /, /ai and /docs and never from here.
 */
const LANDING_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

const filesRoute = (dir: string): Route => ({
  name: `${dir}-files`,
  match: (url) => url.pathname.startsWith(`/${dir}/`),
  async handle(_req, res, url) {
    const name = url.pathname.slice(`/${dir}/`.length);
    const ext = name.match(/^[a-z0-9_-]+(\.[a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const type = ext && Object.hasOwn(LANDING_TYPES, ext) ? LANDING_TYPES[ext] : undefined;
    if (!type) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(join(WEB_DIR, "public", dir, name));
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  },
});
export const landingFilesRoute = filesRoute("landing");
export const aiFilesRoute = filesRoute("ai");
export const docsFilesRoute = filesRoute("docs");

/**
 * The files under /vendor/ that may be served, and as what: the trading
 * wallet's bundled SDK and its licences (public-release W1.1). The same kind
 * of allowlist as /js/ and /fonts/, but exact names: nothing else in the
 * directory (its hash, the page's type declarations) is ever served.
 */
const VENDOR_FILES: Record<string, string> = {
  "wallet.js": "text/javascript; charset=utf-8",
  "LICENSES.txt": "text/plain; charset=utf-8",
};

/**
 * `GET /vendor/wallet.js`: Coinbase's SDK behind our facade, built by
 * scripts/vendor-wallet.mjs and committed with its hash. Hosted only: a self
 * page has no trading wallet and never loads it. The server serves the file
 * and never imports it.
 */
export const vendorRoute: Route = {
  name: "vendor",
  match: (url) => url.pathname.startsWith("/vendor/"),
  async handle(_req, res, url) {
    const name = url.pathname.slice("/vendor/".length);
    const type = Object.hasOwn(VENDOR_FILES, name) ? VENDOR_FILES[name] : undefined;
    if (!type) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(join(WEB_DIR, "public", "vendor", name));
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  },
};

/**
 * `POST /api/prepare/buy` and `/api/prepare/sell`: a quote and the unsigned
 * steps for the visitor's own wallet to sign. See src/server/prepare.ts.
 */
export const prepareRoute: Route = {
  name: "prepare",
  match: (url) => url.pathname === "/api/prepare/buy" || url.pathname === "/api/prepare/sell",
  async handle(req, res, url) {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { return send(res, 400, { error: "the body must be JSON, at most 64 KB" }); }
    try {
      const out = url.pathname.endsWith("/buy") ? await prepareBuy(body) : await prepareSell(body);
      return send(res, out.status, out.body);
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      return send(res, 502, { error: `could not reach the chain: ${(err.shortMessage ?? err.message ?? "failed").slice(0, 160)}` });
    }
  },
};

/**
 * `GET /healthz`, for the proxy's health check, the deploy's rollback and an
 * external uptime check (H1). It answers on loopback as well as the public host.
 *
 * `newestLaunchAgeSec` is chain time since the newest launch on the board.
 * Nothing here records when a block was last seen, and launches can be hours
 * apart, so this is context and not an alarm. B4.4 knows whether the socket
 * is up, and adds that.
 */
export const healthzRoute: Route = {
  name: "healthz",
  match: (url) => url.pathname === "/healthz",
  async handle(_req, res) {
    let newest: { block: number; launchedAt: number } | null = null;
    for (const r of rows.values()) if (!newest || r.block > newest.block) newest = r;
    return send(res, 200, {
      ok: true,
      feed: wsClient ? "websocket" : "none",
      lastBlock: newest?.block ?? 0,
      newestLaunchAgeSec: newest && newest.launchedAt > 0
        ? Math.max(0, Math.round(Date.now() / 1000 - newest.launchedAt))
        : null,
      // The chain index (D1.5): blocks the follower is behind, tokens whose
      // history is not in yet, seconds since its last good round.
      ...indexHealth(),
    });
  },
};

/**
 * `GET /api/ledger?address=0x…`: positions for any address, rebuilt from the
 * chain (public-release B3.5, server/ledgerPayload.ts). Rate-limited as its
 * own class (B5.3), by client and by distinct addresses an hour.
 *
 * No address is written to any log here: not on success, not on failure.
 * The count of lookups is all this process keeps (`drainLookups`).
 */
export function ledgerRoute(
  lookup: (address: Address, opts?: { fresh?: boolean }) => Promise<LedgerResponse> = ledgerPayload,
): Route {
  return {
    name: "ledger",
    match: (url) => url.pathname === "/api/ledger",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const address = url.searchParams.get("address") ?? "";
      if (!isAddress(address, { strict: false })) {
        return send(res, 400, { error: "bad address", text: "That is not an address. Paste one that starts with 0x." });
      }
      // `fresh=1`: the page has just seen this address trade, so the lookup
      // reads the chain's newest blocks even inside its freshness window
      // (D1.0). It costs one small scan, and the route's own limits hold.
      const fresh = url.searchParams.get("fresh") === "1";
      try {
        return send(res, 200, await lookup(address, fresh ? { fresh } : undefined));
      } catch (e) {
        // The log node refusing us: busy, not broken, and it says when to come
        // back (B4.6, README P6). A lookup keeps what it had fetched, so the
        // next attempt carries on (B3.3).
        if (isRateLimited(e)) {
          const wait = Math.max(1, Math.ceil(Math.max(logRoute.state().retryInMs, busyFor(e)) / 1000));
          res.writeHead(503, { "content-type": "application/json", "retry-after": String(wait) });
          res.end(json({
            error: "busy", retryAfter: wait,
            text: `The chain's history node is refusing requests. Try again in ${wait}s; what was read so far is kept.`,
          }));
          return;
        }
        return send(res, 502, { error: "could not read the chain", text: "Could not read the chain. Try again shortly." });
      }
    },
  };
}

/** What a replay is asked for: whose, which token, and which of its positions (opened, closed). */
export type ReplayAsk = { address: Address; token: Address; opened: number; closed: number | null };

/**
 * The replay's data from the process's chain index (p-sell-verdict.md, P4a):
 * null without an index, or with no trade of the address's in that window.
 * ETH/USD by day is best effort: without it the video shows ETH.
 */
export async function replayPayload(q: ReplayAsk, now = Date.now()): Promise<ReplayData | null> {
  const ix = indexedTokenTrades(q.token);
  if (!ix) return null;
  let usdDay: Record<string, number> = {};
  try { usdDay = await dailyUsd(q.opened - LEAD_MS, now, now); } catch { /* the video falls back to ETH */ }
  return replayData({ ...q, ...ix, now, usdNow: ethUsd(), usdDay });
}

/**
 * `GET /api/replay?address=&token=&opened=&closed=`: one position's trade
 * replay, for the hosted Portfolio's Share (p-sell-verdict.md, P4a).
 * Rate-limited as its own class, by client and distinct address (a Portfolio
 * shares several positions in a minute, which the ledger's burst of 3 did
 * not allow), and, as for the ledger, no address is written to any log.
 */
export function replayRoute(lookup: (q: ReplayAsk) => Promise<ReplayData | null> = replayPayload): Route {
  return {
    name: "replay",
    match: (url) => url.pathname === "/api/replay",
    async handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET only" });
      const p = url.searchParams;
      const address = p.get("address") ?? "", token = p.get("token") ?? "";
      const opened = Number(p.get("opened")), closedRaw = p.get("closed");
      const closed = closedRaw === null || closedRaw === "" ? null : Number(closedRaw);
      if (!isAddress(address, { strict: false }) || !isAddress(token, { strict: false })
        || !Number.isSafeInteger(opened) || opened <= 0 || (closed !== null && (!Number.isSafeInteger(closed) || closed < opened))) {
        return send(res, 400, { error: "bad request", text: "A replay needs an address, a token and when the position opened." });
      }
      try {
        const r = await lookup({ address, token, opened, closed });
        if (!r) return send(res, 404, { error: "no trades", text: "The index has no trade of this position yet." });
        return send(res, 200, r);
      } catch {
        return send(res, 502, { error: "could not read the index", text: "Could not build the replay. Try again shortly." });
      }
    },
  };
}

/** How long a refusal said to wait, found anywhere in its cause chain (viem wraps it). */
function busyFor(e: unknown): number {
  for (let x = e as { cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    if (x instanceof LogsBusy) return x.retryAfterMs;
  }
  return 0;
}

export const hostedRoutes: Route[] = [configRoute, landingRoute, aiRoute, docsRoute, pageRoute, renamedRoute, landingFilesRoute, aiFilesRoute, docsFilesRoute, prepareRoute, ledgerRoute(), replayRoute(), healthzRoute, vendorRoute];

/**
 * What hosted refuses before any route runs (public-release B5.2). The host
 * was already checked.
 *
 * There is no cookie, session or key, so a forged request can do nothing on a
 * visitor's behalf. What another site can do is make its visitors' browsers
 * spend our RPC budget. A `POST` from a page elsewhere carries that page's
 * `Origin`, and a `GET` fired by an `<img>` or a `no-cors` fetch carries
 * `Sec-Fetch-Site: cross-site`, so a browser cannot hide either. curl can, and
 * rate limits (B5.3) are the control for curl.
 */
export function hostedGate(req: IncomingMessage, url: URL, publicOrigin: string): Refusal | null {
  const method = req.method ?? "GET";
  // Nothing here answers OPTIONS, so no CORS preflight ever succeeds, and no
  // Access-Control-* header is ever sent.
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return { status: 405, error: "method not allowed" };
  }

  // Absent: not a browser, or an old one. Anything but same-origin or none
  // (typed, bookmarked) is another site, except a person following a link to
  // the page itself. Frames get no exception: nothing may embed the site.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    const visit = method !== "POST"
      && req.headers["sec-fetch-mode"] === "navigate"
      && req.headers["sec-fetch-dest"] === "document";
    if (!visit) return { status: 403, error: "cross-site request" };
  }

  // A CSP report is a POST the browser writes itself, as application/csp-report.
  // The route checks that type, which a page elsewhere cannot send without a
  // preflight, and the fetch-metadata check above still applies (B5.4).
  if (method === "POST" && url.pathname !== "/api/csp-report") {
    if (req.headers.origin !== publicOrigin) return { status: 403, error: "wrong origin" };
    // A cross-origin application/json POST needs a preflight, which gets 405.
    // text/plain and form types do not, so they are refused outright.
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return { status: 415, error: "the body must be application/json" };
  }
  return null;
}

/**
 * Charge a request to its client's rate limits (public-release B5.3), or refuse
 * it. What `classify` leaves out is never limited. An event stream holds its
 * slot until the response closes.
 *
 * The answer never says which bucket refused. Someone emptying a global bucket
 * should not learn that it worked.
 */
export function limitRequest(
  limiter: Limiter, req: IncomingMessage, url: URL, res: ServerResponse, trustProxy: boolean,
): Refusal | null {
  const cls = classify(url.pathname);
  if (!cls) return null;
  const client = clientAddress(req, trustProxy);

  if (cls === "sse") {
    const stream = limiter.open(client);
    if (!stream.ok) {
      return {
        status: 429, error: "rate-limited", retryAfter: stream.retryAfter,
        text: "Too many live connections from your network. Close another tab, then reload this one.",
      };
    }
    res.once("close", stream.release);
    return null;
  }

  const address = cls === "ledger" || cls === "replay" ? url.searchParams.get("address") ?? undefined : undefined;
  const got = limiter.take(cls, client, { address });
  if (got.ok) return null;
  const wait = got.retryAfter < 120 ? `${got.retryAfter}s` : `${Math.ceil(got.retryAfter / 60)} min`;
  return {
    status: 429, error: "rate-limited", retryAfter: got.retryAfter,
    text: `Too many requests right now. Try again in ${wait}.`,
  };
}

/**
 * The hosted server: both route tables, the host check, the gate and the rate
 * limits. Built here, not in the entry, so `npm run test:gate` drives exactly
 * what runs.
 */
export function hostedApp(opts: {
  port: number; publicOrigin: string; limiter?: Limiter; trustProxy?: boolean;
  /** The ledger lookup, injected by tests that must not reach the chain. */
  ledger?: (address: Address, opts?: { fresh?: boolean }) => Promise<LedgerResponse>;
  /** The replay lookup, likewise. */
  replay?: (q: ReplayAsk) => Promise<ReplayData | null>;
}) {
  const limiter = opts.limiter ?? createLimiter();
  const trustProxy = opts.trustProxy ?? TRUST_PROXY;
  const routes = hostedRoutes.map((r) => (r.name === "ledger" && opts.ledger ? ledgerRoute(opts.ledger)
    : r.name === "replay" && opts.replay ? replayRoute(opts.replay) : r));
  return createApp({
    port: opts.port,
    routes: [...publicRoutes("hosted"), ...routes],
    around: withSource,
    // The public name only. The proxy reaches /healthz on loopback, so that
    // one path answers there too.
    hostCheck: (host, url) => publicHost(host, opts.publicOrigin)
      || (url.pathname === "/healthz" && loopbackHost(host, opts.port)),
    // The gate's own checks first, so a request it refuses spends no token.
    gate: (req, url, res) => hostedGate(req, url, opts.publicOrigin)
      ?? limitRequest(limiter, req, url, res, trustProxy),
  });
}
