import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, type Address } from "viem";
import { readMeter } from "../../core/lib/meter.js";
import { logRoute, wsClient } from "../../core/lib/client.js";
import { analyze } from "../../core/checker/analyze.js";
import { derive, evaluate, score } from "../../core/checker/rules.js";
import { indexStats } from "../../core/lib/launchIndex.js";
import { cacheStats, cached } from "../../core/lib/cache.js";
import { poolFor as v4PoolFor } from "../../core/market/v4.js";
import { throughput } from "../../core/lib/throttle.js";
import { ethUsd, priceState } from "../../core/lib/price.js";
import * as history from "../../core/lib/history.js";
import { logo, logoStats } from "../../core/lib/logo.js";
import { BodyTooLarge, json, readJson, send, type Mode, type Route } from "../http.js";
import { WEB_DIR } from "../config.js";
import { analyseInto, clients, refreshEvery, rows } from "../board.js";
import { hasChainIndex } from "../../core/lib/chainIndex.js";
import { checkStats, type Market } from "../checkStats.js";
import { cspCounts, recordReport } from "../cspReports.js";
import { isRateLimited } from "../../core/lib/logGate.js";
import { candlesRoute, tradesRoute } from "./tape.js";
import { holdersRoute } from "./holders.js";
import { leadersRoute } from "./leaders.js";

// Routes both modes serve. Nothing here can reach a wallet. Where a mode
// changes what a route may say, the route takes the mode.

export const eventsRoute: Route = {
  name: "events",
  match: (url) => url.pathname === "/events",
  async handle(req, res, url) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${json([...rows.values()])}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20_000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  },
};

export const launchesRoute: Route = {
  name: "launches",
  match: (url) => url.pathname === "/api/launches",
  async handle(req, res, url) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json([...rows.values()]));
    return;
  },
};

export const statsRoute = (mode: Mode): Route => ({
  name: "stats",
  match: (url) => url.pathname === "/api/stats",
  async handle(req, res, url) {
    // Reading the price is what schedules its background refresh, and this is
    // the only endpoint the console polls on a timer. Without this call the
    // quote freezes at boot and slowly goes stale in the topbar.
    ethUsd();
    if (mode === "hosted") {
      // Only what a public page draws, and the calls by method since boot
      // (D1.0), so hosted RPC use can be seen. CU throughput and cache counts
      // say how close the budget is to empty, which is what someone would use
      // to time an attack on it (public-release B5.2), so they stay out.
      const p = priceState();
      return send(res, 200, {
        rows: rows.size,
        ws: wsClient !== null && wsClient !== undefined,
        lastBlock: [...rows.values()].reduce((b, r) => (r.block > b ? r.block : b), 0),
        price: { ethUsd: p.ethUsd, stale: p.stale },
        rpc: { byMethod: readMeter().byMethod },
      });
    }
    const m = readMeter();
    const up = Math.floor(process.uptime());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json({
      uptimeSec: up,
      rpc: { ...m, perMinute: up > 0 ? +(m.sub / (up / 60)).toFixed(1) : 0 },
      alchemyCu: throughput(),
      cache: cacheStats(),
      index: indexStats(),
      rows: rows.size,
      history: history.historyStats(),
      logos: logoStats(),
      price: priceState(),
      ws: wsClient !== null && wsClient !== undefined,
      // The console's topbar wants a block number. Polling eth_blockNumber for
      // it would cost ~6 calls/min against a steady state deliberately cut to
      // 5.9, so it reads the newest block the launch feed has already seen.
      lastBlock: [...rows.values()].reduce((b, r) => (r.block > b ? r.block : b), 0),
      // Report-only CSP violations since boot, by directive and source (B5.4).
      csp: cspCounts(),
    }));
    return;
  },
});

/**
 * `POST /api/csp-report`: where the page's report-only policy sends violations
 * (public-release B5.4). Only counts are kept (see cspReports.ts).
 *
 * The type is the check that matters, in both modes: a page on another origin
 * cannot send `application/csp-report` without a preflight, and a preflight
 * gets 405. Hosted's gate lets this one POST through its Origin and JSON rules
 * for that reason.
 */
export const cspReportRoute: Route = {
  name: "csp-report",
  match: (url) => url.pathname === "/api/csp-report",
  async handle(req, res) {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/csp-report") return send(res, 415, { error: "the body must be application/csp-report" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, 8 * 1024);
    } catch (e) {
      return e instanceof BodyTooLarge
        ? send(res, 413, { error: "a report is at most 8 KB" })
        : send(res, 400, { error: "the body must be JSON" });
    }
    if (!recordReport(body)) return send(res, 400, { error: "not a CSP report" });
    res.writeHead(204).end();
  },
};

export const logoRoute: Route = {
  name: "logo",
  match: (url) => url.pathname === "/api/logo",
  async handle(req, res, url) {
    const token = url.searchParams.get("token");
    if (!token || !isAddress(token)) return send(res, 400, { error: "bad token" });
    const row = rows.get(token.toLowerCase());
    if (!row || !row.logo) { res.writeHead(404).end(); return; }

    const img = await logo(row.logo);
    if (!img) { res.writeHead(404).end(); return; }

    res.writeHead(200, {
      "content-type": img.type,
      // Content-addressed and therefore immutable: the browser should never ask
      // for the same CID twice.
      "cache-control": "public, max-age=604800, immutable",
      "content-length": String(img.body.length),
      // Belt and braces for an SVG logo, which is a document the browser would
      // otherwise be willing to run script in.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    });
    res.end(img.body);
    return;
  },
};

export const historyRoute: Route = {
  name: "history",
  match: (url) => url.pathname === "/api/history",
  async handle(req, res, url) {
    const token = url.searchParams.get("token");
    if (!token || !isAddress(token)) return send(res, 400, { error: "bad token" });
    const pts = history.series(token);
    return send(res, 200, {
      points: pts,
      // Said plainly so the chart can label itself honestly: this is sampled
      // from the moment this process first saw the curve, not from launch.
      since: pts.length ? pts[0]![0] : null,
      // With the chain index a point is taken when the curve trades, and by
      // the 2-minute sweep (D1.3); without it, on a 10 s timer.
      sampledOn: hasChainIndex() ? "trades" : "timer",
      sampledMs: refreshEvery(),
      ethUsd: ethUsd(),
    });
  },
};

/** What the check calls out to, so a test can run it without a chain. */
export type CheckDeps = {
  analyze: typeof analyze;
  analyseInto: typeof analyseInto;
  poolFor: typeof v4PoolFor;
};

const CHECK_DEPS: CheckDeps = { analyze, analyseInto, poolFor: v4PoolFor };

/** How long a hosted check's answer is reused for the same address (B5.1 D3). */
export const CHECK_REUSE_MS = 60_000;

/**
 * The hosted check (public-release B5.1): the verdict, without putting the
 * token on the shared board. A token already there is refreshed as self
 * refreshes it (D1), so Re-check still means something, but the board never
 * grows from a visitor's request: no placeholder, no history, no broadcast.
 */
async function hostedCheck(addr: Address, deps: CheckDeps) {
  const a = await deps.analyze(addr, { deep: true });
  const d = derive(a);
  const findings = evaluate(a, d);
  const s = score(findings);
  const key = a.token.toLowerCase();
  const onBoard = rows.has(key);
  let market: Market | undefined;
  if (onBoard) {
    await deps.analyseInto(a.token, a.curve, a.creator, Number(a.launchBlock));
    market = rows.get(key);
  } else if (a.graduated) {
    // Off the board there is no row to price a bonded token from: two
    // storage reads of its own pool instead (D4).
    const pool = await deps.poolFor(a.token).catch(() => null);
    if (pool && pool.tokensPerEth > 0) {
      market = {
        v4: { poolId: pool.id, liquidity: pool.liquidity.toString(), lpFee: pool.lpFee },
        tokensPerEth: pool.tokensPerEth,
        fdvEth: 1e9 / pool.tokensPerEth,
      };
    }
  }
  return {
    token: a.token, symbol: a.symbol, name: a.name, band: s.band, score: s.value, findings,
    stats: checkStats(a, d, market),
    // The page trades a token off the board from this answer (B5.1b), and
    // says when it was computed: a reused answer is not a fresh one.
    onBoard, checkedAt: Date.now(),
  };
}

export const checkRoute = (mode: Mode, deps: CheckDeps = CHECK_DEPS): Route => ({
  name: "check",
  match: (url) => url.pathname === "/api/check",
  async handle(req, res, url) {
    const addr = url.searchParams.get("addr");
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(json({ error: "bad address" }));
      return;
    }
    try {
      if (mode === "hosted") {
        // Concurrent checks of one address share one run, and its answer is
        // kept a minute. A failure is not kept, so a refusal is retried.
        const answer = await cached(`check:${addr.toLowerCase()}`, CHECK_REUSE_MS,
          () => hostedCheck(addr as Address, deps));
        return send(res, 200, answer);
      }
      const a = await deps.analyze(addr as Address, { deep: true });
      const d = derive(a);
      const findings = evaluate(a, d);
      const s = score(findings);
      // The launch block from the analysis, never 0: a 0 would overwrite a
      // board row's real block and sink a checked token in the Newest sort.
      await deps.analyseInto(a.token, a.curve, a.creator, Number(a.launchBlock));
      // `stats` is the card's numbers from this same analysis, so a token
      // that is not on the board still gets them. The board row is read only
      // for a bonded token's V4 price, which it already has (no extra call).
      const stats = checkStats(a, d, rows.get(a.token.toLowerCase()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json({ token: a.token, symbol: a.symbol, name: a.name, band: s.band, score: s.value, findings, stats }));
    } catch (e) {
      // The log node refusing us: busy, not broken, and it says when to come
      // back (B4.6, README P6).
      if (isRateLimited(e)) {
        const wait = Math.max(1, Math.ceil(logRoute.state().retryInMs / 1000));
        res.writeHead(503, { "content-type": "application/json", "retry-after": String(wait) });
        res.end(json({ error: `The chain's log node is refusing requests. Try again in ${wait}s.` }));
        return;
      }
      const err = e as { shortMessage?: string; message?: string };
      res.writeHead(500, { "content-type": "application/json" });
      res.end(json({ error: err.shortMessage ?? err.message ?? "failed" }));
    }
    return;
  },
});

// The page's stylesheets, by name: the design (app.css) and the phone rules
// loaded after it (public-release F5.7). A fixed list, so no other file can
// be reached through this route.
const STYLESHEETS = ["/app.css", "/phone.css"];

export const cssRoute: Route = {
  name: "css",
  match: (url) => STYLESHEETS.includes(url.pathname),
  async handle(req, res, url) {
    const css = await readFile(join(WEB_DIR, "public", url.pathname.slice(1)), "utf8");
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
    res.end(css);
    return;
  },
};

// The site's icons, cropped from the mascot's avatar: the browser tab's and
// the phone home screen's. A fixed list, like the stylesheets. PNG only: an
// image type that can never be a document (H1.2).
const ICONS = ["/favicon-32.png", "/apple-touch-icon.png"];

export const iconRoute: Route = {
  name: "icon",
  match: (url) => ICONS.includes(url.pathname),
  async handle(req, res, url) {
    const png = await readFile(join(WEB_DIR, "public", url.pathname.slice(1)));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
    res.end(png);
    return;
  },
};

// The console's ES modules, served as written — no build step, so what is
// in the repo is exactly what runs. The pattern admits only lowercase path
// segments of letters, digits, `-` and `_` ending in `.js`, so no `..`, no
// absolute path and no other file type can be reached through it.
export const jsRoute: Route = {
  name: "js",
  match: (url) => url.pathname.startsWith("/js/"),
  async handle(req, res, url) {
    const rest = url.pathname.slice("/js/".length);
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/i.test(rest)) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const js = await readFile(join(WEB_DIR, "public", "js", ...rest.split("/")), "utf8");
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.end(js);
    } catch {
      res.writeHead(404).end("not found");
    }
    return;
  },
};

// The console's own fonts (public-release F5.2), instead of Google Fonts. The
// same kind of allowlist as /js/: one flat directory, woff2 files and the
// licence texts, nothing else.
export const fontsRoute: Route = {
  name: "fonts",
  match: (url) => url.pathname.startsWith("/fonts/"),
  async handle(req, res, url) {
    const name = url.pathname.slice("/fonts/".length);
    const type = /^[A-Za-z0-9_-]+\.woff2$/.test(name) ? "font/woff2"
      : /^[A-Za-z0-9_-]+\.txt$/.test(name) ? "text/plain; charset=utf-8" : null;
    if (!type) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(join(WEB_DIR, "public", "fonts", name));
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  },
};

/**
 * clankchan's reactions, for the share cards (docs/specs/share-cards.md;
 * hosted too since p-sell-verdict.md P3): 1024px WebP copies in
 * web/public/art/, made from art/source/, which stays out of git. Only the
 * names below; a release serves the same files under /v/<sha>/art/. The list
 * matches REACTIONS in web/public/js/card/model.js.
 */
export const ART_ALLOWED = new Set([
  "e01-manic", "e02-hollow", "e03-crying", "e04-sweating", "e05-smug", "e06-screaming",
  "e07-deadpan", "e08-sparkle", "e09-rage", "e10-sleepy", "e11-shock", "e12-laughing",
]);

export const artRoute: Route = {
  name: "art",
  match: (url) => url.pathname.startsWith("/art/"),
  async handle(req, res, url) {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const name = url.pathname.match(/^\/art\/([a-z0-9-]+)\.webp$/)?.[1];
    if (!name || !ART_ALLOWED.has(name)) return send(res, 404, { error: "not found" });
    let body: Buffer;
    try { body = await readFile(join(WEB_DIR, "public", "art", `${name}.webp`)); }
    catch { return send(res, 404, { error: "not found" }); }
    res.writeHead(200, { "content-type": "image/webp", "content-length": String(body.length), "cache-control": "no-cache" });
    res.end(body);
  },
};

/**
 * The token page's chart library and its licences (tv-candlestick-chart.md,
 * TV2), in both modes: TradingView's Lightweight Charts, built by
 * scripts/vendor-charts.mjs and committed with its hash. Exactly these two
 * names; every other /vendor/ file is hosted's (routes/hosted.ts), and a self
 * page never gets the wallet's bundle. A release serves them under /v/<sha>/.
 */
const CHART_FILES: Record<string, string> = {
  "/vendor/charts.js": "text/javascript; charset=utf-8",
  "/vendor/charts.LICENSES.txt": "text/plain; charset=utf-8",
};
export const chartsVendorRoute: Route = {
  name: "vendor-charts",
  match: (url) => Object.hasOwn(CHART_FILES, url.pathname),
  async handle(_req, res, url) {
    let body: Buffer;
    try { body = await readFile(join(WEB_DIR, "public", ...url.pathname.slice(1).split("/"))); }
    catch { return send(res, 404, { error: "not found" }); }
    res.writeHead(200, { "content-type": CHART_FILES[url.pathname]!, "cache-control": "no-cache" });
    res.end(body);
  },
};

/** The routes both modes serve, as each mode serves them. */
export const publicRoutes = (mode: Mode): Route[] => [
  eventsRoute, launchesRoute, statsRoute(mode), logoRoute, historyRoute, tradesRoute(), candlesRoute(), holdersRoute(), leadersRoute(), checkRoute(mode),
  cssRoute, iconRoute, jsRoute, fontsRoute, artRoute, chartsVendorRoute, cspReportRoute,
];
