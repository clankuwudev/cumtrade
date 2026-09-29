// Compare the live hosted site with the source it names — public-release H1.2.
//
//   node scripts/verify-live.mjs <origin> [--repo <dir>] [--ref <ref>] [--resolve <host>:<port>:<address>]
//
// It reads the release's sha from the live app page at /trade (its footer and
// its module URLs must agree), rebuilds that release's two pages (the landing
// and the app), their policies and headers, the files and the manifest from
// the source with scripts/release-page.mjs, as the release build does, and
// compares them with what the site serves, byte for byte, at every path each
// page answers on. It also checks that the app's old names redirect to /trade,
// that nothing under /v/<sha>/ is a page, and that what Node answers cannot
// act as a page.
//
//   <origin>     the site, such as https://staging.example: a scheme and a host, no path
//   --repo       the git repository to rebuild from (default: this one)
//   --ref        the commit to rebuild from (default: the sha the live page names). In the
//                published repository, whose one commit is not the deployed one, give HEAD:
//                the content is compared, and the output says so.
//   --resolve    connect to <address> for <host>:<port>, like curl's (the rehearsal's made-up name)
//
//   CLANK_VERIFY_AUTH=user:pass   basic auth, for private staging
//   NODE_EXTRA_CA_CERTS=<file>    a local CA, for a rehearsal's `tls internal`
//
// In the published repository the vendored SDK bundle is not committed. Its
// wallet.js is checked against the committed wallet.js.sha256, and its
// LICENSES.txt is read from the working tree after `npm run vendor:wallet`.
//
// Exit 0 when everything matches, 1 naming every difference, 2 on bad usage.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedRelease, MANIFEST_FILE, PAGES, PUBLIC, RENAMED_PATHS, pageSha, sha256 } from "./release-page.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const usage = (msg) => {
  if (msg) console.error(`verify-live: ${msg}`);
  console.error("usage: node scripts/verify-live.mjs <origin> [--repo <dir>] [--ref <ref>] [--resolve <host>:<port>:<address>]");
  process.exit(2);
};

const originArg = args.find((a, i) => !a.startsWith("--") && !["--repo", "--ref", "--resolve"].includes(args[i - 1]));
if (!originArg) usage();
let origin;
try {
  const u = new URL(originArg);
  if (!/^https?:$/.test(u.protocol) || u.pathname !== "/" || u.search || u.hash || u.username) throw new Error();
  origin = u;
} catch {
  usage(`not an origin: ${originArg}`);
}
const REPO = flag("--repo") ?? fileURLToPath(new URL("..", import.meta.url));
const REF = flag("--ref");
const resolveArg = flag("--resolve");
let pinnedAddress = null;
if (resolveArg) {
  const m = resolveArg.match(/^([^:]+):(\d+):(.+)$/);
  if (!m) usage(`--resolve takes <host>:<port>:<address>, not ${resolveArg}`);
  if (m[1] !== origin.hostname || Number(m[2]) !== Number(origin.port || (origin.protocol === "https:" ? 443 : 80))) {
    usage(`--resolve ${resolveArg} does not name ${origin.host}`);
  }
  pinnedAddress = m[3];
}
const auth = process.env.CLANK_VERIFY_AUTH;

// ------------------------------------------------------------------ fetch --
/**
 * One GET, with no redirect followed and no compression asked for. Each on a
 * connection of its own: the rebuild between GETs blocks the event loop, and a
 * kept-alive socket the server closed meanwhile would be reused unnoticed and
 * answer ECONNRESET (a server with a 5 s keep-alive, as test:release's is).
 */
function get(path) {
  const request = origin.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { accept: "*/*" };
  if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
  return new Promise((resolve) => {
    const req = request({
      host: origin.hostname, port: origin.port || undefined, path, method: "GET", headers, agent: false,
      ...(pinnedAddress ? { lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: pinnedAddress, family: pinnedAddress.includes(":") ? 6 : 4 }]) : cb(null, pinnedAddress, pinnedAddress.includes(":") ? 6 : 4)) } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error("timed out after 20s")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    req.end();
  });
}

// ----------------------------------------------------------------- report --
let differences = 0;
const same = (what, detail = "") => console.log(`  \x1b[32msame\x1b[0m  ${what}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
const differs = (what, detail = "") => {
  differences++;
  console.log(`  \x1b[31mDIFF\x1b[0m  ${what}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
};
const check = (pass, what, detail) => (pass ? same(what) : differs(what, detail));
const fatal = (msg) => { console.error(`verify-live: ${msg}`); process.exit(1); };

// ------------------------------------------------------------------- page --
console.log(`\nverify-live: ${origin.origin}`);
// The app names the release in its footer and its module URLs (L1: at /os; P2b: at /trade).
const SHA_PATH = PAGES.find((p) => p.name === "app").paths[0];
const page = await get(SHA_PATH);
if (page.status !== 200) fatal(`GET ${SHA_PATH} answered ${page.status || page.error}${page.status === 401 ? " (set CLANK_VERIFY_AUTH=user:pass for private staging)" : ""}`);
const sha = pageSha(page.body.toString("utf8"));
if (!sha) fatal(`the live page at ${SHA_PATH} names no release: its footer and its module URLs must give the same sha`);
const ref = REF ?? sha;

// ----------------------------------------------------------------- source --
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
let commit;
try {
  commit = git("rev-parse", "--verify", `${ref}^{commit}`).toString().trim();
} catch {
  fatal(`${ref === sha ? `the live page's sha ${sha}` : ref} is not a commit in ${REPO}. `
    + "Fetch it, or compare with a checkout of the published source with --ref HEAD.");
}
console.log(`  release ${sha}`);
console.log(commit === sha
  ? `  source  the same commit, in ${REPO}`
  : `  source  ${commit} in ${REPO}: another commit, so this compares content only`);

const blob = (path) => {
  try { return git("cat-file", "blob", `${commit}:${path}`); } catch { return null; }
};
const listed = git("ls-tree", "-r", "-z", "--name-only", commit, "--", PUBLIC.slice(0, -1)).toString()
  .split("\0").filter(Boolean).map((p) => p.slice(PUBLIC.length));
// What the publish leaves out of src/web/public/ (the SDK bundle, O1.1) is
// still served. Count it in, and let the pin or the working tree vouch for it.
const excluded = (() => {
  const list = blob("scripts/publish-files.json");
  if (!list) return [];
  try {
    return (JSON.parse(list.toString("utf8")).exclude ?? []).map((e) => e.path)
      .filter((p) => typeof p === "string" && p.startsWith(PUBLIC) && !p.includes("*")).map((p) => p.slice(PUBLIC.length));
  } catch { return []; }
})();
const outside = [];
const source = {
  list: () => [...new Set([...listed, ...excluded])],
  read: (path) => {
    const b = blob(path);
    if (b) return b;
    if (!excluded.includes(path.slice(PUBLIC.length))) return null;
    // Not committed here: the bundle a clone builds with npm run vendor:wallet.
    const disk = join(REPO, ...path.split("/"));
    if (!existsSync(disk)) return null;
    outside.push(path);
    return readFileSync(disk);
  },
  pinned: (path) => {
    const pin = blob(`${path}.sha256`);
    return pin?.toString("utf8").match(/^([0-9a-f]{64})\b/)?.[1] ?? null;
  },
};
let expected;
try {
  expected = await expectedRelease(source, sha);
} catch (e) {
  fatal(`could not rebuild the release from ${commit}: ${e.message}`);
}
for (const p of outside) console.log(`  note    ${p} is not committed here; read from the working tree`);

// ------------------------------------------------------------- compare it --
for (const p of expected.pages) {
  console.log(`\nthe ${p.name}`);
  for (const path of p.paths) {
    const r = path === SHA_PATH ? page : await get(path);
    check(r.status === 200 && sha256(r.body) === sha256(Buffer.from(p.page, "utf8")),
      `${path}: the ${p.name}, byte for byte`, r.status !== 200 ? `status ${r.status || r.error}` : firstDifference(r.body, p.page));
    for (const [name, want] of Object.entries(p.headers)) {
      const got = r.headers[name];
      check(got === want, `${path}: ${name}`, `live ${JSON.stringify(got ?? null)}, source ${JSON.stringify(want)}`);
    }
  }
}

console.log("\nthe app's old names");
for (const path of RENAMED_PATHS) {
  const r = await get(path);
  check(r.status === 301 && r.headers.location === SHA_PATH, `${path} answers 301 to ${SHA_PATH}`,
    `status ${r.status || r.error}, location ${JSON.stringify(r.headers.location ?? null)}`);
}

console.log(`\nthe ${expected.files.length} files under /v/${sha.slice(0, 12)}…/`);
let filesSame = 0;
for (const f of expected.files) {
  const r = await get(`/v/${sha}/${f.path}`);
  if (!f.sha256) { differs(f.path, "not in the source, so it cannot be checked (for the SDK bundle, run npm run vendor:wallet)"); continue; }
  if (r.status !== 200) { differs(f.path, `status ${r.status || r.error}`); continue; }
  if (sha256(r.body) !== f.sha256) { differs(f.path, `live ${sha256(r.body).slice(0, 16)}…, source ${f.sha256.slice(0, 16)}…`); continue; }
  if (r.headers["x-content-type-options"] !== "nosniff") { differs(f.path, "served without nosniff"); continue; }
  filesSame++;
}
if (filesSame === expected.files.length) same(`all ${filesSame}, byte for byte, with nosniff`, expected.files.some((f) => f.from === "pin") ? "vendor/wallet.js by its pin" : "");

console.log("\nthe manifest");
{
  const r = await get(`/${MANIFEST_FILE}`);
  let live = null;
  try { live = r.status === 200 ? JSON.parse(r.body.toString("utf8")) : null; } catch { /* reported below */ }
  if (!live) differs(`/${MANIFEST_FILE}`, r.status === 200 ? "not JSON" : `status ${r.status || r.error}`);
  else {
    check(live.sha === sha, "it names the page's sha", String(live.sha));
    for (const p of expected.pages) {
      const lp = live.pages?.[p.name];
      check(lp?.sha256 === sha256(Buffer.from(p.page, "utf8")), `the ${p.name}'s hash is the source's`);
      check(JSON.stringify(lp?.headers) === JSON.stringify(p.headers), `the ${p.name}'s headers are the source's`);
      check(JSON.stringify(lp?.paths) === JSON.stringify(p.paths), `the ${p.name}'s paths are the source's`, JSON.stringify(lp?.paths ?? null));
    }
    const want = Object.fromEntries(expected.files.map((f) => [f.path, f.sha256]));
    const keys = [...new Set([...Object.keys(want), ...Object.keys(live.files ?? {})])];
    const off = keys.filter((k) => live.files?.[k] !== want[k]);
    check(off.length === 0, `every file's hash is the source's (${Object.keys(want).length})`, off.join(", "));
    if (expected.manifest) check(r.body.toString("utf8") === expected.manifest, "…and it is the source's manifest, byte for byte");
  }
}

console.log("\nnothing else is a page");
{
  for (const p of PAGES) {
    const r = await get(`/v/${sha}/${p.source}`);
    check(r.status === 404, `/v/${sha.slice(0, 12)}…/${p.source} is not served`, `status ${r.status}`);
  }
  const h = await get("/healthz");
  const csp = String(h.headers["content-security-policy"] ?? "");
  check(h.status === 200 && /(^|;\s*)sandbox(;|$)/.test(csp) && /default-src 'none'/.test(csp) && h.headers["x-content-type-options"] === "nosniff",
    "what Node answers is sandboxed, with no script and nosniff (/healthz)", `status ${h.status}, ${csp || "no policy"}`);
}

console.log(differences === 0
  ? `\n\x1b[32mthe live site is ${commit === sha ? "commit" : "the content of"} ${commit.slice(0, 12)}, byte for byte\x1b[0m\n`
  : `\n\x1b[31m${differences} difference(s)\x1b[0m\n`);
process.exit(differences === 0 ? 0 : 1);

/** Where two pages first differ, for the report. */
function firstDifference(live, want) {
  const a = live.toString("utf8"), b = want;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = a.slice(0, i).split("\n").length;
  return `first difference on line ${line}: live ${JSON.stringify(a.slice(i, i + 40))}, source ${JSON.stringify(b.slice(i, i + 40))}`;
}
