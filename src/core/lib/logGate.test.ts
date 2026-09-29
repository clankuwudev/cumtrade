/**
 * The log gate — public-release B4.6.
 *
 * Real viem errors, from a local server that answers the way the chain's
 * public node does, and the gate on a fake clock. No chain.
 *
 *   npm run test:loggate
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, http } from "viem";
import { createLogGate, createLogRoute, isKeyRefused, isOutage, isRateLimited, LogsBusy } from "./logGate.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

// ------------------------------------------------------------ real errors --
console.log("\nwhat counts as the node refusing us (real viem errors)");
{
  // status, body: each answer the local node can give. `id` is filled in.
  const answers: Record<string, [number, string]> = {
    // Exactly what rpc.mainnet.chain.robinhood.com sent on 2026-09-19.
    "HTTP 429 with a JSON-RPC 429 body": [429, '{"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}'],
    "a JSON-RPC 429 inside an HTTP 200": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":429,"message":"Too Many Requests"}}'],
    "JSON-RPC -32005, limit exceeded": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32005,"message":"limit exceeded"}}'],
    "HTTP 429 with a plain-text body": [429, "Too Many Requests"],
    "an HTTP 502": [502, "bad gateway"],
    "a revert": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":3,"message":"execution reverted"}}'],
    "a range too wide for the node": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32602,"message":"query exceeds max block range"}}'],
    // Exactly what the site's Alchemy app (PAYG) sent on 2026-09-23.
    "Alchemy's HTTP 400, response size exceeded": [400, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32602,"message":"Log response size exceeded. You can make eth_getLogs requests with up to a 5,000 block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response."}}'],
    "an HTTP 403": [403, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32000,"message":"forbidden"}}'],
    // Exactly what Alchemy sends for a key it will not serve (2026-09-23).
    "Alchemy's HTTP 401, must be authenticated": [401, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32600,"message":"Must be authenticated!"}}'],
    // What Alchemy sent a server call to an app with a domain allowlist
    // (current-issues.md #6, 2026-09-24), with and without an HTTP error.
    "Alchemy's allowlist refusal, HTTP 403": [403, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32600,"message":"Unspecified origin not on whitelist."}}'],
    "Alchemy's allowlist refusal, inside an HTTP 200": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32600,"message":"Unspecified origin not on whitelist."}}'],
    "a malformed request, -32600": [200, '{"jsonrpc":"2.0","id":ID,"error":{"code":-32600,"message":"invalid json request"}}'],
  };
  let current = "";
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const [status, body] = answers[current]!;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body.replace("ID", String(JSON.parse(b).id)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const c = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const errorFor = async (k: string) => {
    current = k;
    try { await c.request({ method: "eth_getLogs", params: [{}] } as never); return null; } catch (e) { return e; }
  };
  const expect: Record<string, boolean> = {
    "HTTP 429 with a JSON-RPC 429 body": true,
    "a JSON-RPC 429 inside an HTTP 200": true,
    "JSON-RPC -32005, limit exceeded": true,
    "HTTP 429 with a plain-text body": true,
    "an HTTP 502": false,
    "a revert": false,
    "a range too wide for the node": false,
    "Alchemy's HTTP 400, response size exceeded": false,
    "an HTTP 403": false,
  };
  for (const [k, want] of Object.entries(expect)) {
    const e = await errorFor(k) as { name?: string; shortMessage?: string } | null;
    ok(`${k} → ${want ? "refused" : "not a refusal"}`, e !== null && isRateLimited(e) === want, `${e?.name}: ${e?.shortMessage}`);
  }
  // D1.0: an outage moves a request to the next log endpoint; an answer, even
  // "too wide", stays with the caller, which splits the range.
  const outage: Record<string, boolean> = {
    "HTTP 429 with a JSON-RPC 429 body": true,
    "an HTTP 502": true,
    "an HTTP 403": true,
    "Alchemy's HTTP 401, must be authenticated": true,
    "a revert": false,
    "a range too wide for the node": false,
    "Alchemy's HTTP 400, response size exceeded": false,
  };
  for (const [k, want] of Object.entries(outage)) {
    const e = await errorFor(k) as { name?: string; shortMessage?: string } | null;
    ok(`${k} → ${want ? "an outage" : "an answer"}`, e !== null && isOutage(e) === want, `${e?.name}: ${e?.shortMessage}`);
  }
  // current-issues.md #6: the provider refusing our key is never a verdict
  // on a launch. A request that is simply wrong, or refused for volume, is not it.
  const keyRefused: Record<string, boolean> = {
    "Alchemy's allowlist refusal, HTTP 403": true,
    "Alchemy's allowlist refusal, inside an HTTP 200": true,
    "Alchemy's HTTP 401, must be authenticated": true,
    "an HTTP 403": true,
    "a malformed request, -32600": false,
    "HTTP 429 with a JSON-RPC 429 body": false,
    "a revert": false,
    "a range too wide for the node": false,
    "an HTTP 502": false,
  };
  for (const [k, want] of Object.entries(keyRefused)) {
    const e = await errorFor(k) as { name?: string; shortMessage?: string } | null;
    ok(`${k} → ${want ? "our key refused" : "not our key"}`, e !== null && isKeyRefused(e) === want, `${e?.name}: ${e?.shortMessage}`);
  }
  srv.close();

  // A request that never gets an answer.
  const dead = createPublicClient({ transport: http("http://127.0.0.1:9", { retryCount: 0, timeout: 500 }) });
  const timeout = await dead.request({ method: "eth_getLogs", params: [{}] } as never).then(() => null, (e) => e);
  ok("a connection that fails → not a refusal", timeout !== null && !isRateLimited(timeout), (timeout as Error)?.name);
  ok("…but an outage", isOutage(timeout), (timeout as Error)?.name);
  ok("LogsBusy is a refusal", isRateLimited(new LogsBusy(1000)));
  // What client.ts actually throws while the gate is closed (found 2026-09-21).
  ok("LogsBusy wrapped by viem is a refusal", isRateLimited(
    Object.assign(new Error("An unknown RPC error occurred.", { cause: new LogsBusy(1000) }), { name: "UnknownRpcError", code: -1 })));
  ok("a refusal wrapped twice is still found", isRateLimited(new Error("outer", { cause: new Error("mid", { cause: { code: 429 } }) })));
  const loop: Record<string, unknown> = { message: "x" };
  loop.cause = loop;
  ok("a cause chain that loops ends", isRateLimited(loop) === false);
}

// ------------------------------------------------------------------ gate --
console.log("\nthe gate");
{
  let t = 0;
  const gate = createLogGate({ now: () => t });
  const refusal = () => Promise.reject(Object.assign(new Error("RPC Request failed."), { code: 429 }));
  let calls = 0;
  const answer = () => { calls++; return Promise.resolve("logs"); };
  const run = <T>(fn: () => Promise<T>) => gate.run(fn).then((v) => ({ v }), (e) => ({ e }));

  ok("open to begin with", gate.state().open && (await run(answer)).hasOwnProperty("v"));
  await run(refusal);
  ok("a refusal closes it for 30s", !gate.state().open && gate.state().retryInMs === 30_000, JSON.stringify(gate.state()));
  calls = 0;
  const r = await run(answer) as { e?: unknown };
  ok("while closed, a request fails with LogsBusy", r.e instanceof LogsBusy && (r.e as LogsBusy).retryAfterMs === 30_000);
  ok("…and nothing is sent", calls === 0);

  // Refusals in a row double the wait, up to 5 minutes.
  const waits: number[] = [30_000];
  for (let i = 0; i < 6; i++) {
    t += gate.state().retryInMs;
    await run(refusal);
    waits.push(gate.state().retryInMs);
  }
  ok("refusals in a row: 30s, 60s, 120s, 240s, then 300s", waits.join() === "30000,60000,120000,240000,300000,300000,300000", waits.join());

  // Reopening: one probe at a time.
  t += gate.state().retryInMs;
  let release!: () => void;
  const slow = () => new Promise<string>((res) => { release = () => res("logs"); });
  calls = 0;
  const probe = run(() => { calls++; return slow(); });
  const second = await run(answer) as { e?: unknown };
  ok("when it reopens, one probe goes out", calls === 1);
  ok("…and the others fail fast until it answers", second.e instanceof LogsBusy);
  release();
  await probe;
  ok("the probe's success opens it", gate.state().open && gate.state().refusals === 0);
  ok("…and requests flow again", "v" in await run(answer));
  await run(refusal);
  ok("a success resets the backoff to 30s", gate.state().retryInMs === 30_000, String(gate.state().retryInMs));

  t += 30_000;
  const other = await run(() => Promise.reject(new Error("execution reverted")));
  ok("an error that is not a refusal passes through", "e" in other && !(other.e instanceof LogsBusy));
  ok("…and leaves the gate open", gate.state().open);
  const failedProbe = createLogGate({ now: () => t });
  await failedProbe.run(refusal).catch(() => {});
  t += 30_000;
  await failedProbe.run(() => Promise.reject(new Error("timeout"))).catch(() => {});
  ok("a probe that fails some other way does not wedge the gate", failedProbe.state().open
    && (await failedProbe.run(answer).then(() => true, () => false)));
}

// ----------------------------------------------------------------- route --
console.log("\nthe route across log endpoints (D1.0)");
{
  let t = 0;
  const alchemy = { name: "alchemy", url: "a", gate: createLogGate({ now: () => t }) };
  const pub = { name: "public", url: "p", gate: createLogGate({ now: () => t }) };
  const route = createLogRoute([alchemy, pub]);
  const asked: string[] = [];
  const answer = (fail: Record<string, unknown>) => (ep: { name: string }) => {
    asked.push(ep.name);
    return fail[ep.name] ? Promise.reject(fail[ep.name]) : Promise.resolve(ep.name);
  };
  const refusal = Object.assign(new Error("Too Many Requests"), { code: 429 });
  const tooWide = Object.assign(new Error("Log response size exceeded"), { name: "HttpRequestError", status: 400 });

  ok("the first endpoint answers when it can", await route.run(answer({})) === "alchemy" && asked.join() === "alchemy");
  asked.length = 0;
  const fell = await route.run(answer({ alchemy: refusal }));
  ok("a refusal there goes to the public node", fell === "public" && asked.join() === "alchemy,public", asked.join());
  ok("…and closes only the first endpoint's gate", !alchemy.gate.state().open && pub.gate.state().open);
  ok("…while the route stays open", route.state().open);
  asked.length = 0;
  await route.run(answer({}));
  ok("while its gate is closed, nothing is sent to it", asked.join() === "public", asked.join());
  asked.length = 0;
  const wide = await route.run(answer({ public: tooWide })).then(() => null, (e) => e);
  ok("a too-wide answer is the caller's, not moved on", wide === tooWide && asked.join() === "public", asked.join());
  await route.run(answer({ public: refusal })).catch(() => {});
  ok("with both refusing, the route is closed", !route.state().open && route.state().retryInMs > 0, JSON.stringify(route.state()));
  const busy = await route.run(answer({})).then(() => null, (e) => e);
  ok("…and a request fails at once with LogsBusy", busy instanceof LogsBusy);
  t += 30_000;
  asked.length = 0;
  ok("once the first reopens, it is asked first again", await route.run(answer({})) === "alchemy" && asked.join() === "alchemy", asked.join());
}

console.log(failures === 0
  ? "\n\x1b[32mall log gate checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
