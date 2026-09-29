/**
 * The hosted request gate — public-release B5.2.
 *
 * Boots hosted's real server (both route tables, the host check and the gate)
 * on a free loopback port and speaks HTTP to it, forging the headers a browser
 * or a proxy would send. No request here reaches the chain: every route that
 * could read it is either refused or given input it rejects first. Only
 * /api/stats starts a background ETH price fetch, whose result is not used.
 *
 *   npm run test:gate
 */
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything that could load history: its file is never written here, but
// it is read on first use, and the real one is not this test's business.
process.env.HISTORY_FILE = join(tmpdir(), `clank-gate-test-${process.pid}.json`);
// The process is hosted, so a self-mode module loaded by accident throws.
await import("../entry/mode-hosted.js");
const { hostedApp } = await import("./routes/hosted.js");
const { createApp } = await import("./http.js");
const { createLimiter, LIMITS } = await import("./rateLimit.js");
type Limits = typeof LIMITS;

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
/** Every response seen, so the crawl can check headers on refusals too. */
const seen: { what: string; status: number; headers: IncomingHttpHeaders }[] = [];

function call(port: number, path: string, o: {
  method?: string; host?: string | null; headers?: OutgoingHttpHeaders; body?: string;
} = {}): Promise<Reply> {
  // A header set to undefined is one the caller wants left out.
  const headers: OutgoingHttpHeaders = Object.fromEntries(
    Object.entries(o.headers ?? {}).filter(([, v]) => v !== undefined));
  if (o.host !== null) headers.host = o.host ?? SITE_HOST;
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method: o.method ?? "GET", headers, setHost: false,
    }, (res) => {
      const done = (body: string) => {
        seen.push({ what: `${o.method ?? "GET"} ${path}`, status: res.statusCode ?? 0, headers: res.headers });
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      };
      // The event stream never ends; its status and headers are the answer.
      if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
        done("");
        req.destroy();
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => done(body));
      res.on("error", reject);
      res.on("close", () => { if (!res.complete) reject(new Error("connection dropped mid-response")); });
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/**
 * Write bytes a client library would refuse to send. Returns the status line
 * and the body, so an answer from the app can be told from one Node's parser
 * gave before the app ever saw the request.
 */
function raw(port: number, bytes: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const s = connect(port, "127.0.0.1", () => s.write(bytes));
    const settle = () => {
      const [head = "", body = ""] = got.split("\r\n\r\n");
      resolve(`${head.split("\r\n")[0]} ${body}`.trim());
    };
    s.setEncoding("utf8");
    s.on("data", (d) => { got += d; });
    s.on("close", settle);
    s.on("error", settle);
    setTimeout(() => s.destroy(), 1500);
  });
}

const SITE = "https://gate.test";
const SITE_HOST = "gate.test";
const TOKEN = "0x0000000000000000000000000000000000000001";
const port = await freePort();
// B5.2's sections make many requests from one client, so they run with limits
// they cannot reach. The limits have their own section at the end.
const roomy: Limits = {
  ...LIMITS,
  classes: Object.fromEntries(Object.entries(LIMITS.classes).map(([k, v]) => [k, {
    client: { perMin: 1e6, burst: 1e6 }, global: v.global && { perMin: 1e6, burst: 1e6 },
  }])) as Limits["classes"],
  streams: 1000,
};
const server = hostedApp({ port, publicOrigin: SITE, limiter: createLimiter({ limits: roomy }) });
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));

const json = { "content-type": "application/json", origin: SITE, "sec-fetch-site": "same-origin" };
const page = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

console.log("\nPOST: origin and type");
{
  const buy = (headers: OutgoingHttpHeaders, host?: string) =>
    call(port, "/api/prepare/buy", { method: "POST", headers, body: "{}", host });
  let r = await buy({ ...json });
  ok("the page's own POST reaches the route", r.status === 400 && r.body.includes("from"), `${r.status} ${r.body.slice(0, 80)}`);
  r = await buy({ ...json, origin: "https://evil.test" });
  ok("Origin https://evil.test → 403", r.status === 403, `${r.status} ${r.body}`);
  r = await buy({ "content-type": "application/json" });
  ok("no Origin → 403", r.status === 403, `${r.status}`);
  r = await buy({ ...json, origin: "null" });
  ok("Origin null → 403", r.status === 403, `${r.status}`);
  r = await buy({ ...json, origin: "http://gate.test" });
  ok("the right host on the wrong scheme → 403", r.status === 403, `${r.status}`);
  r = await buy({ ...json, origin: "https://gate.test.evil.test" });
  ok("our origin as a prefix → 403", r.status === 403, `${r.status}`);
  r = await buy({ ...json, "content-type": "text/plain" });
  ok("content-type text/plain → 415", r.status === 415, `${r.status} ${r.body}`);
  r = await buy({ ...json, "content-type": "application/x-www-form-urlencoded" });
  ok("a form body → 415", r.status === 415, `${r.status}`);
  r = await buy({ ...json, "content-type": undefined as unknown as string });
  ok("no content-type → 415", r.status === 415, `${r.status}`);
  r = await buy({ ...json, "content-type": "application/jsonp" });
  ok("application/jsonp → 415", r.status === 415, `${r.status}`);
  r = await buy({ ...json, "content-type": "Application/JSON; charset=utf-8" });
  ok("application/json with a charset, any case, passes", r.status === 400, `${r.status}`);
  r = await buy({ ...json }, "evil.test");
  ok("the wrong Host → 421", r.status === 421, `${r.status}`);
  r = await buy({ ...json, origin: "https://evil.test", "content-type": "text/plain" }, "evil.test");
  ok("the Host is checked first", r.status === 421, `${r.status}`);
}

console.log("\nmethods");
for (const method of ["OPTIONS", "PUT", "DELETE", "PATCH"]) {
  const r = await call(port, "/api/prepare/buy", {
    method,
    headers: { origin: "https://evil.test", "access-control-request-method": "POST", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
  });
  ok(`${method} → 405`, r.status === 405, `${r.status}`);
}
{
  const r = await call(port, "/", { method: "OPTIONS", headers: { origin: SITE } });
  ok("OPTIONS on any path → 405, same-origin included", r.status === 405, `${r.status}`);
}

console.log("\ncross-site requests");
{
  const cross = (path: string, mode: string, dest: string, site = "cross-site", method = "GET") =>
    call(port, path, { method, headers: { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest } });
  // A bad address, so a request that got through would be a 400 and not an analysis.
  let r = await cross("/api/check?addr=nope", "no-cors", "image");
  ok("an <img> of /api/check → 403", r.status === 403, `${r.status}`);
  r = await cross("/api/check?addr=nope", "no-cors", "empty");
  ok("a no-cors fetch of /api/check → 403", r.status === 403, `${r.status}`);
  r = await cross("/api/check?addr=nope", "cors", "empty");
  ok("a cors fetch of /api/check → 403", r.status === 403, `${r.status}`);
  r = await cross("/api/check?addr=nope", "no-cors", "image", "same-site");
  ok("same-site is not same-origin → 403", r.status === 403, `${r.status}`);
  r = await cross("/api/check?addr=nope", "no-cors", "image", "something-new");
  ok("an unknown Sec-Fetch-Site counts as cross-site → 403", r.status === 403, `${r.status}`);
  r = await cross("/events", "cors", "empty");
  ok("a cross-site EventSource → 403", r.status === 403, `${r.status}`);
  r = await cross(`/api/logo?token=${TOKEN}`, "no-cors", "image");
  ok("a hotlinked logo → 403", r.status === 403, `${r.status}`);
  r = await cross("/js/main.js", "no-cors", "script");
  ok("a cross-site <script> of our modules → 403", r.status === 403, `${r.status}`);
  r = await cross("/", "navigate", "document");
  ok("a link from another site to the page → 200", r.status === 200, `${r.status}`);
  r = await cross("/", "navigate", "document", "cross-site", "HEAD");
  ok("…and a HEAD of it → 200", r.status === 200, `${r.status}`);
  r = await cross("/", "navigate", "iframe");
  ok("the page framed by another site → 403", r.status === 403, `${r.status}`);
  r = await cross("/api/check?addr=nope", "navigate", "document");
  ok("a top-level visit to an API route is still a visit → 400 from the route", r.status === 400, `${r.status}`);
  r = await call(port, "/api/prepare/buy", {
    method: "POST", body: "{}",
    headers: { ...json, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  // Even with our own Origin forged in: a POST is never a visit.
  ok("a cross-site form POST → 403, as cross-site", r.status === 403 && r.body.includes("cross-site"), `${r.status} ${r.body}`);
  r = await cross("/", "navigate", "document", "none");
  ok("a typed or bookmarked visit → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/api/check?addr=nope", { headers: { ...page } });
  ok("the page's own GET reaches the route", r.status === 400, `${r.status}`);
  r = await call(port, "/api/check?addr=nope");
  ok("no fetch metadata (curl) reaches the route", r.status === 400, `${r.status}`);
}

console.log("\nhosts");
{
  let r = await call(port, "/", { host: "GATE.TEST" });
  ok("the public host, any case → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/", { host: "gate.test:443" });
  ok("the public host with :443 → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/", { host: "gate.test:8443" });
  ok("another port → 421", r.status === 421, `${r.status}`);
  r = await call(port, "/", { host: null });
  // Node refuses an HTTP/1.1 request with no Host before the app sees it.
  ok("no Host → refused (400, from Node itself)", r.status === 400 && !r.body.includes("{"), `${r.status} ${r.body}`);
  r = await call(port, "/", { host: `127.0.0.1:${port}` });
  ok("the page on loopback → 421", r.status === 421, `${r.status}`);
  r = await call(port, "/api/stats", { host: `localhost:${port}` });
  ok("the API on loopback → 421", r.status === 421, `${r.status}`);
  r = await call(port, "/healthz", { host: `127.0.0.1:${port}` });
  ok("/healthz on loopback → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/healthz?probe=1", { host: `localhost:${port}` });
  ok("/healthz with a query, on localhost → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/healthz");
  ok("/healthz on the public host → 200", r.status === 200, `${r.status}`);
  r = await call(port, "/healthz", { host: "evil.test" });
  ok("/healthz on another host → 421", r.status === 421, `${r.status}`);
  r = await call(port, "/healthz", { host: `127.0.0.1:${port + 1}` });
  ok("/healthz on loopback with another port → 421", r.status === 421, `${r.status}`);
  r = await call(port, "/healthzz", { host: `127.0.0.1:${port}` });
  ok("a path that merely starts with /healthz, on loopback → 421", r.status === 421, `${r.status}`);
}

console.log("\nwhat hosted says about itself");
{
  const h = await call(port, "/healthz");
  const body = JSON.parse(h.body) as Record<string, unknown>;
  ok("/healthz is { ok, feed, lastBlock, newestLaunchAgeSec } and the index's health (D1.5)",
    Object.keys(body).join() === "ok,feed,lastBlock,newestLaunchAgeSec,followerLagBlocks,building,followerRoundAgeSec" && body.ok === true
      && (body.feed === "websocket" || body.feed === "none"),
    h.body);
  const s = await call(port, "/api/stats", { headers: { ...page } });
  const stats = JSON.parse(s.body) as Record<string, unknown>;
  // D1.0 adds the calls by method, and only that of the meter.
  ok("/api/stats is exactly rows, ws, lastBlock, price, rpc.byMethod",
    Object.keys(stats).join() === "rows,ws,lastBlock,price,rpc"
      && Object.keys(stats.rpc as object).join() === "byMethod", s.body);
  ok("price is exactly ethUsd, stale",
    Object.keys(stats.price as object).join() === "ethUsd,stale", JSON.stringify(stats.price));
}

console.log("\nthe crawl");
{
  // Every hosted route, answered and refused, and the 404.
  const paths = [
    "/", "/console", "/app.css", "/js/main.js", "/js/nope.js", "/api/config", "/api/launches",
    "/api/stats", `/api/logo?token=${TOKEN}`, `/api/history?token=${TOKEN}`, "/api/check?addr=nope",
    "/events", "/healthz", "/nope",
  ];
  for (const p of paths) await call(port, p, { headers: { ...page } });
  await call(port, "/api/prepare/sell", { method: "POST", headers: { ...json }, body: "{}" });
  // Everything this server has answered so far, refusals from the sections above included.
  const leaky = seen.filter(({ headers }) =>
    Object.keys(headers).some((n) => n === "set-cookie" || n.startsWith("access-control-")));
  ok(`${seen.length} responses carry no Set-Cookie and no Access-Control-*`,
    leaky.length === 0, leaky.map((s) => s.what).join(", "));
  const codes = new Set(seen.map((s) => s.status));
  ok("they include every answer and refusal the gate gives", [200, 400, 403, 404, 405, 415, 421].every((c) => codes.has(c)),
    [...codes].sort().join(" "));
}

console.log("\nnothing a request does takes the server down");
{
  const fromApp = (line: string) => line.startsWith("HTTP/1.1 400") && line.includes("bad request target");
  let line = await raw(port, `GET http://[ HTTP/1.1\r\nHost: ${SITE_HOST}\r\nConnection: close\r\n\r\n`);
  ok("GET http://[ → 400 from the app, which used to crash on it", fromApp(line), line);
  let r = await call(port, "/healthz");
  ok("…and the next request is answered", r.status === 200, `${r.status}`);
  line = await raw(port, `GET http://[ HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n`);
  ok("…with any Host", fromApp(line), line);

  // A self-shaped app: no gate, loopback host check, and routes that throw.
  const selfPort = await freePort();
  const errors: string[] = [];
  const logged = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  const app = createApp({
    port: selfPort,
    hostCheck: (host) => host === `localhost:${selfPort}`,
    routes: [
      { name: "throws", match: (u) => u.pathname === "/throws", handle: async () => { throw new Error("boom\nsecond line"); } },
      {
        name: "throws-late", match: (u) => u.pathname === "/late",
        handle: async (_q, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("part"); throw new Error("late"); },
      },
      { name: "echo", match: (u) => u.pathname === "/echo", handle: async (_q, res) => { res.writeHead(200).end("ok"); } },
    ],
  });
  await new Promise<void>((res) => app.listen(selfPort, "127.0.0.1", res));
  const host = `localhost:${selfPort}`;
  r = await call(selfPort, "/throws?addr=0xabc", { host });
  ok("a handler that throws → 500", r.status === 500 && r.body.includes("internal error"), `${r.status} ${r.body}`);
  ok("…logged once, by route name, with no query string and one line",
    errors.length === 1 && errors[0] === "[http] throws failed: boom", JSON.stringify(errors));
  const late = await call(selfPort, "/late", { host }).then(() => "answered", (e: Error) => `dropped (${e.message})`);
  ok("a handler that throws after writing headers has its socket dropped", late.startsWith("dropped"), late);
  r = await call(selfPort, "/echo", { host });
  ok("…and the server still answers", r.status === 200, `${r.status}`);
  line = await raw(selfPort, `GET http://[ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  ok("a gate-less app answers GET http://[ with 400", fromApp(line), line);
  r = await call(selfPort, "/echo", { method: "OPTIONS", host });
  ok("a gate-less app does not refuse OPTIONS itself", r.status === 200, `${r.status}`);
  console.error = logged;
  app.close();
}

console.log("\nrate limits over HTTP (B5.3)");
{
  // The shipped table, except a small read burst so exemptions are cheap to prove.
  const tight: Limits = { ...LIMITS, classes: { ...LIMITS.classes, read: { client: { perMin: 60, burst: 5 } } } };
  let clock = 0;
  const limiter = createLimiter({ limits: tight, now: () => clock });
  const lport = await freePort();
  // The ledger lookup is stubbed: this is about the limits in front of it.
  const ledger = async (address: string) => ({ address, stub: true }) as never;
  const app = hostedApp({ port: lport, publicOrigin: SITE, limiter, trustProxy: true, ledger });
  await new Promise<void>((res) => app.listen(lport, "127.0.0.1", res));
  const as = (client: string, headers: OutgoingHttpHeaders = {}) => ({ ...page, "x-forwarded-for": client, ...headers });

  let codes: number[] = [];
  for (let i = 0; i < 4; i++) codes.push((await call(lport, "/api/check?addr=nope", { headers: as("198.51.100.1") })).status);
  ok("3 checks reach the route, the 4th → 429", codes.join() === "400,400,400,429", codes.join());
  const r = await call(lport, "/api/check?addr=nope", { headers: as("198.51.100.1") });
  const body = JSON.parse(r.body) as Record<string, unknown>;
  ok("a 429 carries retry-after", r.headers["retry-after"] === "10", String(r.headers["retry-after"]));
  ok("…and { error, text, retryAfter } in the body",
    body.error === "rate-limited" && body.retryAfter === 10 && body.text === "Too many requests right now. Try again in 10s.",
    r.body);
  ok("…and nothing that says which bucket refused", Object.keys(body).sort().join() === "error,retryAfter,text", r.body);
  ok("…and no Access-Control-* or Set-Cookie header",
    !Object.keys(r.headers).some((n) => n === "set-cookie" || n.startsWith("access-control-")));
  codes = [];
  for (let i = 0; i < 3; i++) codes.push((await call(lport, "/api/check?addr=nope", { headers: as("198.51.100.2") })).status);
  ok("another client is not affected", codes.join() === "400,400,400", codes.join());
  clock += 10_000;
  ok("10 seconds later the first client gets one more",
    (await call(lport, "/api/check?addr=nope", { headers: as("198.51.100.1") })).status === 400);

  codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await call(lport, "/api/check?addr=nope", {
      headers: as("198.51.100.3", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }),
    })).status);
  }
  for (let i = 0; i < 3; i++) codes.push((await call(lport, "/api/check?addr=nope", { headers: as("198.51.100.3") })).status);
  ok("requests the gate refuses spend no token", codes.join() === "403,403,403,403,403,400,400,400", codes.join());

  codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await call(lport, "/api/prepare/buy", { method: "POST", body: "{}", headers: { ...json, "x-forwarded-for": "198.51.100.4" } })).status);
  }
  ok("5 prepares reach the route, the 6th → 429", codes.join() === "400,400,400,400,400,429", codes.join());

  // An IPv6 client reads 5 here; the page, its files and the health check are free.
  const v6 = "2001:db8:aa:1::1";
  const free = ["/", "/console", "/app.css", "/js/main.js", "/fonts/JetBrainsMono-Regular.woff2", "/healthz"];
  codes = [];
  for (const p of free) for (let i = 0; i < 8; i++) codes.push((await call(lport, p, { headers: as(v6) })).status);
  ok("the page, /app.css, /js/*, /fonts/* and /healthz are never refused", codes.every((c) => c === 200), [...new Set(codes)].join());
  codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(lport, "/api/config", { headers: as(v6) })).status);
  ok("…while other reads still count (5, then 429)", codes.join() === "200,200,200,200,200,429", codes.join());
  codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(lport, `/nope${i}`, { headers: as("2001:db8:aa:2::1") })).status);
  ok("404s count as reads", codes.join() === "404,404,404,404,404,429", codes.join());

  // The ledger route (B3.5) is limited by ?address=.
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  codes = [];
  for (let i = 1; i <= 31; i++) {
    clock += 6_000;
    codes.push((await call(lport, `/api/ledger?address=${addr(i)}`, { headers: as("198.51.100.5") })).status);
  }
  ok("30 distinct ledger addresses pass the limiter, the 31st → 429",
    codes.slice(0, 30).every((c) => c === 200) && codes[30] === 429, [...new Set(codes)].join());
  clock += 6_000;
  const late = await call(lport, `/api/ledger?address=${addr(32)}`, { headers: as("198.51.100.5") });
  // The first address was seen at 16s and this is 202s: 3,414s left, which reads as minutes.
  ok("a long wait reads in minutes", late.status === 429 && late.headers["retry-after"] === "3414"
    && (JSON.parse(late.body) as { text: string }).text === "Too many requests right now. Try again in 57 min.", late.body);
  clock += 6_000;
  ok("…and a repeat of the first still passes",
    (await call(lport, `/api/ledger?address=${addr(1)}`, { headers: as("198.51.100.5") })).status === 200);

  /** Open an event stream and hold it. */
  const hold = (client: string) => new Promise<{ status: number; close: () => void }>((resolve, reject) => {
    const q = request({ host: "127.0.0.1", port: lport, path: "/events", headers: { host: SITE_HOST, ...as(client) } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, close: () => q.destroy() });
    });
    q.on("error", (e) => { if (!String(e.message).includes("socket hang up")) reject(e); });
    q.end();
  });
  const streamer = "2001:db8:bb:1::1";
  const held = [];
  for (let i = 0; i < 6; i++) held.push(await hold(streamer));
  ok("6 streams from one IPv6 client open", held.every((s) => s.status === 200), held.map((s) => s.status).join());
  const seventh = await hold(streamer);
  ok("the 7th → 429", seventh.status === 429);
  seventh.close();
  held[0]!.close();
  // The slot comes back when the server sees the connection close.
  let eighth = await hold(streamer);
  for (let i = 0; i < 20 && eighth.status !== 200; i++) {
    eighth.close();
    await new Promise((res) => setTimeout(res, 50));
    eighth = await hold(streamer);
  }
  ok("closing one lets the next in", eighth.status === 200, String(eighth.status));
  for (const s of [...held, eighth]) s.close();

  // Without TRUST_PROXY, a forged X-Forwarded-For names nobody.
  const dport = await freePort();
  const direct = hostedApp({ port: dport, publicOrigin: SITE, limiter: createLimiter({ limits: tight, now: () => clock }), trustProxy: false });
  await new Promise<void>((res) => direct.listen(dport, "127.0.0.1", res));
  codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call(dport, "/api/check?addr=nope", { headers: as(`198.51.100.${10 + i}`) })).status);
  ok("without TRUST_PROXY, rotating X-Forwarded-For does not escape the limit", codes.join() === "400,400,400,429", codes.join());

  const refusals = limiter.drain();
  ok("the limiter counted what it refused, by class and bucket only",
    (refusals.get("check client") ?? 0) >= 1 && (refusals.get("ledger distinct") ?? 0) === 2 && (refusals.get("sse client") ?? 0) >= 1,
    JSON.stringify([...refusals]));
  app.close();
  direct.close();
}

server.close();
console.log(failures === 0
  ? "\n\x1b[32mall gate checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
