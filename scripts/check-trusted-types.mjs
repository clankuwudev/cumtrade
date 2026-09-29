// Trusted Types on every hosted page, in a real browser (P4 T1).
//
//   node scripts/check-trusted-types.mjs            boots this tree's hosted server on a free port
//   node scripts/check-trusted-types.mjs <origin>   or checks one already running
//
// The pages carry the policies from src/server/http.ts. It drives headless
// Chrome through each page and what paints on it, collects every Trusted
// Types violation (the securitypolicyviolation event, and the console), then
// plants an HTML sink and an untrusted parse, which must throw.
//
// It covers what runs without an account: the board, a token page, the
// Portfolio lookup, Learn, About, Traders, the login sheet, the vendored
// wallet (loaded and started), cumAI's tabs and playground, and the landing.
// A buy, a sell and a login need a live wallet; they are checked in the
// browser after the deploy.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** $CUM, a real clank.trade launch, for the token page. */
const TOKEN = "0xb90ad88c8ecd9f22a05cd8cb365542614f279ca9";
/** The sink a script-injection bug would use, named at run time. */
const SINK = ["inner", "HTML"].join("");

let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// ---------------------------------------------------------- the server --
let server = null;
let ORIGIN = process.argv[2];
if (!ORIGIN) {
  const port = await freePort();
  ORIGIN = `http://localhost:${port}`;
  server = spawn(process.execPath, [join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO, "src", "entry", "hosted.ts")], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      WEB_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, WEB_BACKFILL: "0", WS_URL: "",
      RPC_URL: "https://rpc.mainnet.chain.robinhood.com", HISTORY_FILE: join(tmpdir(), `clank-tt-${process.pid}.json`),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${ORIGIN}/healthz`)).ok) break; } catch { /* not yet */ }
    await sleep(250);
  }
}

// ---------------------------------------------------------- the browser --
const dir = mkdtempSync(join(tmpdir(), "tt-"));
const cdpPort = await freePort();
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dir}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const wait = new Map();
const consoleErrors = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") consoleErrors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Log.entryAdded") consoleErrors.push(d.params.entry.text);
  if (d.method === "Runtime.exceptionThrown") consoleErrors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
// Every violation, kept in the page for this test to read.
await send("Page.addScriptToEvaluateOnNewDocument", { source:
  "window.__tt = []; document.addEventListener('securitypolicyviolation', (e) => window.__tt.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sample || '')));" });

const violations = [];
async function visit(url, steps = []) {
  await send("Page.navigate", { url });
  await sleep(3000);
  for (const s of steps) { await evaluate(s); await sleep(800); }
  const v = await evaluate("JSON.stringify(window.__tt || [])");
  for (const x of JSON.parse(v || "[]")) if (/trusted-types/.test(x)) violations.push(`${url}: ${x}`);
}

try {
  console.log(`\nTrusted Types, at ${ORIGIN}`);
  const policy = (await fetch(`${ORIGIN}/trade`)).headers.get("content-security-policy");
  ok("the app's policy requires Trusted Types, with clank-dom alone",
    /require-trusted-types-for 'script'/.test(policy ?? "") && /trusted-types clank-dom(;|$)/.test(policy ?? ""), policy ?? "no policy");

  const click = (sel) => `document.querySelector(${JSON.stringify(sel)})?.click()`;
  const route = (hash) => `location.hash = ${JSON.stringify(hash)}`;
  await visit(`${ORIGIN}/trade`, [
    route("#/"), route(`#/token/${TOKEN}`), route("#/positions"), route("#/learn"), route("#/learn/terms"), route("#/about"),
    route("#/traders"), route("#/"), click("#tw"), "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))",
    // The vendored wallet, loaded and started as a login would.
    `import("${ORIGIN}/vendor/wallet.js").then((f) => f.init({ projectId: "5fa3921d-9617-48e5-a02e-bb0540fb6203" })).then(() => "started", (e) => "failed: " + e.message)`,
  ]);
  const painted = await evaluate(`document.querySelectorAll("#shell *").length`);
  ok("the app painted", Number(painted) > 50, `${painted} elements`);
  const walletLoaded = await evaluate(`performance.getEntriesByType("resource").some((e) => e.name.endsWith("/vendor/wallet.js"))`);
  ok("the vendored wallet loaded and started under the policy", walletLoaded === true);
  await visit(`${ORIGIN}/ai`, [route("#/models"), route("#/docs"), route("#/status"), route("#/playground")]);
  await visit(`${ORIGIN}/`, ["window.scrollTo(0, document.body.scrollHeight)"]);
  await visit(`${ORIGIN}/trade`);

  ok("no Trusted Types violation on any page", violations.length === 0, violations.slice(0, 5).join(" | ") || "none");
  const ttErrors = consoleErrors.filter((e) => /TrustedHTML|TrustedScript|Trusted Type/i.test(e ?? ""));
  ok("…and no Trusted Types error in the console", ttErrors.length === 0, ttErrors.slice(0, 3).join(" | ") || "none");

  console.log("\nplanted sinks throw");
  const planted = await evaluate(`(() => { try { document.body[${JSON.stringify(SINK)}] = "<b>x</b>"; return "assigned"; } catch (e) { return e.name; } })()`);
  ok("an HTML sink assignment throws", planted === "TypeError", planted);
  const parsed = await evaluate(`(() => { try { new DOMParser().parseFromString("<b>x</b>", "text/html"); return "parsed"; } catch (e) { return e.name; } })()`);
  ok("…and so does parsing a string that didn't come through clank-dom", parsed === "TypeError", parsed);
  const second = await evaluate(`(() => { try { trustedTypes.createPolicy("clank-dom", { createHTML: (s) => s }); return "made"; } catch (e) { return e.name; } })()`);
  ok("…and a second clank-dom policy can't be made", second === "TypeError", second);
  const other = await evaluate(`(() => { try { trustedTypes.createPolicy("anything", { createHTML: (s) => s }); return "made"; } catch (e) { return e.name; } })()`);
  ok("…nor any other policy", other === "TypeError", other);
} finally {
  ws.close();
  chrome.kill();
  server?.kill();
  await sleep(500);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ }
}
console.log(failures === 0 ? "\n\x1b[32mall Trusted Types checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
