import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * One entry in a mode's route table. `match` decides, `handle` answers.
 *
 * Tables are tried in order and the first match answers, which is how the
 * single request handler behaved. No two routes in a table match the same
 * path (checked by `npm run test:routes`), so the order between tables cannot
 * change which handler answers.
 */
export type Route = {
  name: string;
  match: (url: URL, req: IncomingMessage) => boolean;
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>;
};

export const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** A request body past the route's cap. Anything else `readJson` throws is bad JSON. */
export class BodyTooLarge extends Error {
  constructor() { super("body too large"); }
}

export async function readJson(req: import("node:http").IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(json(body));
};

export type Mode = "self" | "hosted";

/**
 * The self page's directives, in order. `PAGE_POLICY` joins them unchanged,
 * and the hosted policy is these with two changes.
 */
const PAGE_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "report-uri /api/csp-report",
];

/**
 * The page's Content Security Policy (public-release B5.4, F5.2). Nothing but
 * this origin: the session token is a meta tag and the fonts are our own.
 * `style-src-attr 'unsafe-inline'` is for the templates' `style="…"`
 * attributes. CSSOM (`el.style`) is not governed.
 *
 * Self's, and the Solana console's. The hosted page has its own below.
 */
export const PAGE_POLICY = PAGE_DIRECTIVES.join("; ");

/** Headers for the console page, in both modes. */
export const pageHeaders = () => ({
  "content-type": "text/html; charset=utf-8",
  // Self's page carries the session token, so nothing may cache or embed it.
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // Enforced since F5.2, after a click-through of every page in both modes
  // reported nothing. Violations are still reported (cspReports.ts).
  "content-security-policy": PAGE_POLICY,
});

/**
 * Where the hosted page's trading wallet talks (public-release F5.6, W1.1).
 * The two Coinbase origins are the vendored SDK's own constants: its API
 * client's base URL and its export frame's. The facade overrides neither. The
 * RPC is `PUBLIC_RPC`'s origin in the page's `trade/constants.js`, where the
 * embedded provider sends every read and the broadcast. `test:headers` holds
 * all three to their sources.
 */
export const CDP_API_ORIGIN = "https://api.cdp.coinbase.com";
export const CDP_EXPORT_FRAME_ORIGIN = "https://secure-wallet.cdp.coinbase.com";
export const CHAIN_RPC_ORIGIN = "https://rpc.mainnet.chain.robinhood.com";
/** `FAST_RPC`'s origin in the page's `trade/constants.js`: the browser-only Alchemy app (2026-09-23). */
export const FAST_RPC_ORIGIN = "https://robinhood-mainnet.g.alchemy.com";

/**
 * The gateway's public origin (L1 N1): where the landing reads the live model
 * count, and cumAI's page its model list. `GET /v1/models` answers CORS for
 * the site with no credentials.
 */
export const GATEWAY_ORIGIN = "https://api.clankuwu.com";

/**
 * Trusted Types on every hosted page (P4 T1): every HTML sink takes only
 * trusted HTML, and the only policy allowed to make it is `clank-dom`, in
 * js/core/dom.js, whose input is `html``` markup (escaped). A new
 * innerHTML, or a parse of a string that didn't come through it, throws in
 * the browser instead of becoming a script injection. A backstop: the render
 * audit (2026-09-27) found no such sink.
 */
const TRUSTED_TYPES = ["require-trusted-types-for 'script'", "trusted-types clank-dom"];
/** Directives with Trusted Types just before the report address, which stays last. */
const withTrustedTypes = (directives: string[]) =>
  directives.flatMap((d) => (d.startsWith("report-uri ") ? [...TRUSTED_TYPES, d] : [d]));

/**
 * The hosted page's policy (public-release F5.6): self's, with connections
 * widened to Coinbase's API and the chain's two RPCs, and one frame origin,
 * Coinbase's export frame. Scripts stay `'self'` only, with no eval of any
 * kind. The app never calls the gateway: cumAI is a page of its own (L1 L4b).
 */
export const HOSTED_PAGE_POLICY = withTrustedTypes(PAGE_DIRECTIVES.flatMap((d) => d === "connect-src 'self'"
  ? [`connect-src 'self' ${CDP_API_ORIGIN} ${CHAIN_RPC_ORIGIN} ${FAST_RPC_ORIGIN}`, `frame-src ${CDP_EXPORT_FRAME_ORIGIN}`]
  : [d])).join("; ");

/**
 * Every header the hosted page carries, wherever it is served: by Node for a
 * local run, and by Caddy from the release in production (H1.2), which is
 * written from this. `nosniff` is on every Node response already
 * (`createApp`), and named here so this is the whole list.
 */
export const hostedPageHeaders = () => ({
  ...pageHeaders(),
  "content-security-policy": HOSTED_PAGE_POLICY,
  // Nothing the page opens keeps a handle on it, and nothing that opened it
  // does. Login is a full-page redirect, so it is unaffected.
  "cross-origin-opener-policy": "same-origin",
  "x-content-type-options": "nosniff",
});

/**
 * The landing's policy (L1): stricter than the app's. The landing has no
 * wallet, so no Coinbase origin and no frame. It connects to two places:
 * our own origin, for the live board (/api/launches and /api/stats, L2b),
 * and the gateway, for the model count. No inline style attribute either, so
 * there is no `unsafe-inline` of any kind. Images are our own files only.
 */
export const LANDING_PAGE_POLICY = withTrustedTypes([
  "default-src 'none'",
  "script-src 'self'",
  "style-src-elem 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "media-src 'self'",
  `connect-src 'self' ${GATEWAY_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "report-uri /api/csp-report",
]).join("; ");

/**
 * Every header the landing carries: the app page's set with its own policy,
 * so Caddy's two page blocks differ in the policy file alone.
 */
export const landingPageHeaders = () => ({
  ...hostedPageHeaders(),
  "content-security-policy": LANDING_PAGE_POLICY,
});

/**
 * cumAI's page's policy (L1 L4b; N-D6, changed by the user): the landing's,
 * except that it reads nothing of ours. It connects to the gateway (the model
 * list, and the playground's calls) and, since stage C's C4, to Coinbase's
 * API: the page loads the trading wallet to sign in (C-D1). No frame: the
 * key export stays on cumOS. No chain RPC: nothing is sent from here.
 * Pictures (X15c) are drawn from `blob:` URLs the page makes from the
 * gateway's answer once its bytes are an image: `img-src blob:`, and no
 * other origin for images.
 */
export const AI_PAGE_POLICY = withTrustedTypes([
  "default-src 'none'",
  "script-src 'self'",
  "style-src-elem 'self'",
  "font-src 'self'",
  "img-src 'self' blob:",
  `connect-src ${GATEWAY_ORIGIN} ${CDP_API_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "report-uri /api/csp-report",
]).join("; ");

/** Every header cumAI's page carries: the app page's set with its own policy. */
export const aiPageHeaders = () => ({
  ...hostedPageHeaders(),
  "content-security-policy": AI_PAGE_POLICY,
});

/**
 * A refusal from a mode's gate, answered before any route sees the request.
 * `text` is a sentence a page can show. `retryAfter` (seconds) is also sent as
 * `retry-after`.
 */
export type Refusal = { status: number; error: string; text?: string; retryAfter?: number };
/** `res` is there so a gate can tie something to the response's close. */
export type Gate = (req: IncomingMessage, url: URL, res: ServerResponse) => Refusal | null;

/**
 * The request loop both modes share: the host check, the mode's gate, then the
 * route table, then 404.
 *
 * Nothing thrown in here may escape. The handler is async, so an escaped error
 * is an unhandled rejection, and Node exits on one: a single malformed request
 * line (`GET http://[ HTTP/1.1`) used to take the whole process down.
 */
export function createApp(opts: {
  port: number;
  routes: Route[];
  hostCheck: (host: string | undefined, url: URL) => boolean;
  gate?: Gate;
  /**
   * Runs each route's handler, given the route's name: the RPC meter's
   * `withSource`, so what a route asks of the chain is counted under its name
   * (D1.0). Passed in, not imported: release-hosted.mjs evaluates this file
   * on its own, where no relative import resolves.
   */
  around?: <T>(name: string, fn: () => T) => T;
}) {
  const around = opts.around ?? (<T>(_name: string, fn: () => T) => fn());
  return createServer(async (req, res) => {
    let route: Route | undefined;
    // On every response, refusals included (public-release B5.4). A route's own
    // writeHead takes precedence over these where it names the same header.
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      let url: URL;
      try { url = new URL(req.url ?? "/", `http://localhost:${opts.port}`); }
      catch { return send(res, 400, { error: "bad request target" }); }
      // API answers are about now, and some are about a wallet. /api/logo sets
      // its own, because a CID never changes.
      if (url.pathname.startsWith("/api/")) res.setHeader("cache-control", "no-store");

      // Before anything else, including the page and the event stream: a request
      // addressed to any other host is a DNS-rebinding page, not the console.
      if (!opts.hostCheck(req.headers.host, url)) return send(res, 421, { error: "wrong host" });

      const refused = opts.gate?.(req, url, res);
      if (refused) {
        const { status, ...body } = refused;
        if (body.retryAfter !== undefined) res.setHeader("retry-after", String(body.retryAfter));
        return send(res, status, body);
      }

      route = opts.routes.find((r) => r.match(url, req));
      const r = route;
      if (r) return await around(r.name, () => r.handle(req, res, url));

      res.writeHead(404).end("not found");
    } catch (e) {
      // The route's name and nothing from the URL: a query string can carry an
      // address someone looked up, and that is not ours to log.
      const err = e as { shortMessage?: string; message?: string };
      const why = String(err?.shortMessage ?? err?.message ?? e).split("\n")[0]!.slice(0, 160);
      console.error(`[http] ${route?.name ?? "request"} failed: ${why}`);
      try {
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: "internal error" });
      } catch {
        res.destroy();
      }
    }
  });
}
