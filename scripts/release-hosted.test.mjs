// The hosted release — public-release H1, H1.2.
//
// Builds a release from HEAD, checks what is in it, and boots it the way the
// server will: plain `node src/entry/hosted.js` in the release directory, with
// an environment that names only what hosted needs. No chain call is made
// (no backfill, no websocket).
//
// H1.2: the pages and their policies come from the release, not from Node.
// This checks each page (L1: the landing and the app) against what its hosted
// route would serve, the Caddyfile's headers against the code's, and
// scripts/verify-live.mjs against a local server that routes the release as
// the Caddyfile does: passing, then failing on one changed byte.
//
//   npm run test:release
//   RELEASE_TEST_REF=<commit> npm run test:release   a commit other than HEAD
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import {
  classifyPublic, entryModule, expectedRelease, MANIFEST_FILE, PAGES, RENAMED_PATHS, pageSha, renderLanding, sha256,
  staticImports, withPreloads,
} from "./release-page.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

// A release is built from a commit. A tree exported for publishing has none
// until O1.4b commits it, so there this skips, and says so (O1.4a).
if (!existsSync(join(REPO, ".git"))) {
  console.log("\n  \x1b[90mskip  not a git checkout: a release is built from a commit\x1b[0m\n");
  process.exit(0);
}

const REF = process.env.RELEASE_TEST_REF || "HEAD";
const sha = execFileSync("git", ["rev-parse", "--verify", `${REF}^{commit}`], { cwd: REPO, encoding: "utf8" }).trim();
const APP = PAGES.find((p) => p.name === "app");
const LANDING = PAGES.find((p) => p.name === "landing");
const AIPAGE = PAGES.find((p) => p.name === "ai");
const OUT = join(REPO, "releases", `hosted-${sha}`);
const TARBALL = `${OUT}.tar.gz`;

console.log(`\nbuilding ${sha.slice(0, 12)}`);
const t0 = Date.now();
const built = execFileSync(process.execPath, [join(REPO, "scripts", "release-hosted.mjs"), "--keep", "--ref", sha], { cwd: REPO, encoding: "utf8" });
ok("the release builds", existsSync(OUT) && existsSync(TARBALL), `${((Date.now() - t0) / 1000).toFixed(0)}s · ${built.trim().split("\n")[0]}`);

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [relative(OUT, p).split(sep).join("/")];
});
const files = walk(OUT);

/** What is between `opener` (which ends in "{") and its closing brace, in a Caddyfile. */
function block(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) return "";
  let depth = 1, i = start + opener.length;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return text.slice(start + opener.length, i - 1);
}

console.log("\nwhat is in it");
ok("nothing under src/self/", !files.some((f) => f.startsWith("src/self/")));
// Ours only: viem ships its own .ts sources in node_modules.
ok("no TypeScript of ours", !files.some((f) => f.startsWith("src/") && f.endsWith(".ts")));
ok("no .env file", !files.some((f) => /(^|\/)\.env/.test(f)));
ok("no tests", !files.some((f) => /\.test\.(js|ts|mjs)$/.test(f) && f.startsWith("src/")));
ok("hosted's entry is compiled", files.includes("src/entry/hosted.js") && files.includes("src/entry/mode-hosted.js"));
ok("no self entry, CLI or self routes", !files.some((f) => /^src\/(entry\/self|self|server\/routes\/self)/.test(f)));
const release = JSON.parse(readFileSync(join(OUT, "RELEASE.json"), "utf8"));
ok("RELEASE.json names the commit", release.sha === sha, JSON.stringify(release));
// The stylesheet asks for fonts by relative URL, so under /v/<sha>/ they must be
// in the release beside it (F5.2).
const css = readFileSync(join(OUT, "src", "web", "public", "app.css"), "utf8");
const fontUrls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
ok("every font the stylesheet names is in the release, by relative URL",
  fontUrls.length > 0 && fontUrls.every((u) => !u.startsWith("/") && files.includes(`src/web/public/${u}`)), fontUrls.join(", "));
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const present = (name) => existsSync(join(OUT, "node_modules", ...name.split("/")));
ok("every production dependency is installed", Object.keys(pkg.dependencies).every(present));
ok("no dev dependency is", !Object.keys(pkg.devDependencies).some(present),
  Object.keys(pkg.devDependencies).filter(present).join(", "));
ok("no native module", !files.some((f) => f.endsWith(".node")));
ok("no command shims", !files.some((f) => f.includes("node_modules/.bin/")));

console.log("\nthe pages, from the release (H1.2, L1)");
ok("the release has both pages, each with its policy, and its manifest",
  [APP.file, APP.policyFile, LANDING.file, LANDING.policyFile, AIPAGE.file, AIPAGE.policyFile, MANIFEST_FILE].every((f) => files.includes(f)));
// cumAI's own page (L4b): rendered as the landing is, with its own policy.
const aiPage = readFileSync(join(OUT, ...AIPAGE.file.split("/")), "utf8");
const aiAssets = [...aiPage.matchAll(/<(?:link|script|img)\b[^>]*\s(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
ok("cumAI's page loads every asset from /v/<sha>/, each in the release, and shows its sha",
  aiAssets.length > 0 && aiAssets.every((u) => u.startsWith(`/v/${sha}/`) && files.includes(`src/web/public/${u.slice(`/v/${sha}/`.length)}`))
    && aiPage.includes(`id="release">${sha}<`), aiAssets.join(", "));
const page = readFileSync(join(OUT, ...APP.file.split("/")), "utf8");
ok("the page loads its modules from /v/<sha>/", page.includes(`src="/v/${sha}/js/main.js"`) && !page.includes('src="/js/main.js"'));
ok("…and its stylesheet", page.includes(`href="/v/${sha}/app.css"`) && !page.includes('href="/app.css"'));
ok("…and the phone stylesheet (F5.7)", page.includes(`href="/v/${sha}/phone.css"`) && !page.includes('href="/phone.css"')
  && files.includes("src/web/public/phone.css"));
// A link to one of the site's pages is a page, not an asset (L1 L3: cumAI at /ai).
const PAGE_LINKS = new Set(["/", "/trade", "/ai"]);
const outside = [...page.matchAll(/<(\w+)\b[^>]*?\s(?:href|src)="(\/[^"]*)"/g)]
  .filter((m) => !m[2].startsWith(`/v/${sha}/`) && !(m[1] === "a" && PAGE_LINKS.has(m[2].split("#")[0])))
  .map((m) => m[2]);
ok("no asset URL in the page is left outside /v/<sha>/, and every other absolute link is one of the site's pages",
  outside.length === 0, outside.join(", "));
ok("…is stamped hosted, as the hosted route stamps it", page.includes('<body data-mode="hosted">') && !page.includes("<body>"));
ok("…carries no session-token slot", !page.includes('name="clank-token"') && !page.includes("__CLANK_TOKEN__"));
ok("…and shows its sha in the footer", pageSha(page) === sha && page.includes(`id="release">${sha}<`));
const served = files.filter((f) => f.startsWith("src/web/public/")).map((f) => f.slice("src/web/public/".length));
// The landing (L1): its assets under /v/<sha>/, its links to the app left as
// they are, and nothing inline.
const landing = readFileSync(join(OUT, ...LANDING.file.split("/")), "utf8");
const landingAssets = [...landing.matchAll(/<(?:link|script|img)\b[^>]*\s(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
ok("the landing loads every asset from /v/<sha>/, and each is in the release",
  landingAssets.length > 0 && landingAssets.every((u) => u.startsWith(`/v/${sha}/`) && served.includes(u.slice(`/v/${sha}/`.length))),
  landingAssets.join(", "));
ok("…links to the app by its path, not under /v/", /<a href="\/trade">/.test(landing) && !/<a href="\/v\//.test(landing));
ok("…has no inline script and shows its sha in the footer",
  !/<script(?![^>]*\bsrc=)[^>]*>/.test(landing) && landing.includes(`id="release">${sha}<`));
ok("…and loads no wallet module", !/vendor\/|js\/wallet|wallet\.js/.test(landing));
ok("nothing under /v/<sha>/ is a document: neither page's source, and only served types",
  !served.includes("app.html") && !served.includes("landing/index.html")
    && classifyPublic(served).refused.length === 0 && classifyPublic(served).skipped.length === 0,
  [...classifyPublic(served).refused, ...classifyPublic(served).skipped.map((s) => s.path)].join(", "));
// P1a: each page names every module its entry imports statically, so the
// browser asks for them all at once instead of one round trip at a time. The
// expected set comes from a plain reading of the import lines, not from
// staticImports, so the two check each other.
console.log("\nmodulepreload (P1a)");
const pub = (f) => join(OUT, "src", "web", "public", ...f.split("/"));
function importClosure(entry) {
  const seen = new Set([entry]), queue = [entry];
  while (queue.length) {
    const at = queue.shift();
    const text = readFileSync(pub(at), "utf8");
    for (const m of text.matchAll(/^(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm)) {
      const to = join("/", dirnameOf(at), m[1] ?? m[2]).replace(/\\/g, "/").slice(1);
      if (!seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}
/** A page's source at the commit: the release serves it rendered, not as a file. */
const pageSource = (p) => execFileSync("git", ["cat-file", "blob", `${sha}:src/web/public/${p.source}`], { cwd: REPO, encoding: "utf8" });
/** What the release preloads for a page, as the renderers take it. */
const preloadOf = (p) => staticImports(entryModule(pageSource(p), p.source), { read: (f) => readFileSync(join(OUT, ...f.split("/"))) });
function dirnameOf(f) { return f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""; }
for (const [p, html] of [[APP, page], [AIPAGE, aiPage], [LANDING, landing]]) {
  const entry = entryModule(pageSource(p), p.source);
  const want = importClosure(entry);
  const got = [...html.matchAll(/<link rel="modulepreload" href="\/v\/([0-9a-f]{40})\/([^"]+)">/g)];
  const paths = got.map((m) => m[2]);
  const head = html.slice(0, html.indexOf("</head>"));
  ok(`the ${p.name} preloads every module ${entry} imports statically (${want.length}), and nothing else`,
    JSON.stringify([...paths].sort()) === JSON.stringify(want) && new Set(paths).size === paths.length,
    `missing ${want.filter((w) => !paths.includes(w)).join(" ") || "none"}; extra ${paths.filter((x) => !want.includes(x)).join(" ") || "none"}`);
  ok("…each under this release's /v/<sha>/, in the head, and served", got.every((m) => m[1] === sha)
    && (html.match(/rel="modulepreload"/g) ?? []).length === got.length && head.split('rel="modulepreload"').length - 1 === got.length
    && paths.every((x) => served.includes(x)));
  ok("…and never the wallet bundle, which loads only when it is used", !paths.some((x) => x.startsWith("vendor/")));
}
{
  // Written with ` for each quote and put back here, so that scripts/check-publish.mjs
  // does not read these made-up modules as this file's own imports.
  const files = Object.fromEntries(Object.entries({
    "a.js": "import { b } from `./b.js`;\nexport * from `./c/d.js`;\nimport `./side.js`;\nconst w = () => import(`./lazy.js`);\n// import { no } from `./comment.js`;\n",
    "b.js": "import { a } from `./a.js`;\nexport const b = 1;\n",
    "c/d.js": "export { b } from `../b.js`;\nimport(`../lazy.js`);\n",
    "side.js": "import { pinned } from `./bundles/pinned.js`;\n",
    "lazy.js": "",
    "bare.js": "import x from `viem`;\n",
    "up.js": "import x from `../../out.js`;\n",
  }).map(([k, v]) => [k, v.replaceAll("`", '"')]));
  const src = (extra = {}) => ({ read: (f) => { const k = f.slice("src/web/public/".length); return k in files ? Buffer.from(files[k]) : null; }, ...extra });
  ok("staticImports follows import, export … from and bare imports, through cycles, breadth first, and not import() or comments",
    JSON.stringify(staticImports("a.js", src({ pinned: (f) => f.endsWith("bundles/pinned.js") }))) === JSON.stringify(["b.js", "c/d.js", "side.js", "bundles/pinned.js"]));
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  ok("…refuses a module it can't read, a bare specifier, and a path outside the site",
    throws(() => staticImports("side.js", src()), /bundles\/pinned\.js is not in the source/)
      && throws(() => staticImports("bare.js", src()), /imports viem/) && throws(() => staticImports("up.js", src()), /not a relative path/));
  ok("withPreloads refuses a page that writes its own modulepreload, or has no single </head>",
    throws(() => withPreloads('<head><link rel="modulepreload" href="/x.js"></head>', ["a.js"]), /already has/)
      && throws(() => withPreloads("<p>", ["a.js"]), /0 copies/));
}
ok("…the type declarations and the bundle's pin are left out", !served.some((f) => f.endsWith(".d.ts") || f.endsWith(".sha256")));
// The very constants the release's server was compiled with.
const compiled = await import(pathToFileURL(join(OUT, "src", "server", "http.js")).href);
const policy = readFileSync(join(OUT, ...APP.policyFile.split("/")), "utf8");
ok(`${APP.policyFile} is HOSTED_PAGE_POLICY, one line, as compiled into this release`, policy === compiled.HOSTED_PAGE_POLICY && !/[\r\n]/.test(policy), policy);
const landingPolicy = readFileSync(join(OUT, ...LANDING.policyFile.split("/")), "utf8");
const aiPolicy = readFileSync(join(OUT, ...AIPAGE.policyFile.split("/")), "utf8");
ok(`${AIPAGE.policyFile} is AI_PAGE_POLICY, one line, as compiled into this release`,
  aiPolicy === compiled.AI_PAGE_POLICY && !/[\r\n]/.test(aiPolicy), aiPolicy);
ok(`${LANDING.policyFile} is LANDING_PAGE_POLICY, one line, as compiled into this release`,
  landingPolicy === compiled.LANDING_PAGE_POLICY && !/[\r\n]/.test(landingPolicy), landingPolicy);

console.log("\nthe manifest");
const manifestBytes = readFileSync(join(OUT, MANIFEST_FILE), "utf8");
const manifest = JSON.parse(manifestBytes);
ok("it names the commit", manifest.sha === sha);
for (const p of PAGES) {
  const m = manifest.pages?.[p.name];
  ok(`it hashes the ${p.name} as served`, m?.sha256 === sha256(readFileSync(join(OUT, ...p.file.split("/")))));
  ok(`…with every header ${p.headers}() gives it, at ${p.paths.join(", ")}`,
    JSON.stringify(m?.headers) === JSON.stringify(compiled[p.headers]()) && JSON.stringify(m?.paths) === JSON.stringify(p.paths));
}
const listedFiles = Object.keys(manifest.files).sort();
ok(`it covers every file served under /v/<sha>/ (${served.length}), and nothing else`,
  JSON.stringify(listedFiles) === JSON.stringify([...served].sort()),
  `${listedFiles.length} listed, ${served.length} in the release`);
const wrong = listedFiles.filter((f) => manifest.files[f] !== sha256(readFileSync(join(OUT, "src", "web", "public", ...f.split("/")))));
ok("…each by its sha256", wrong.length === 0, wrong.join(", "));
// What verify-live does: rebuild from the commit, not from the release. In the
// published repository the commit lacks what the publish leaves out of
// src/web/public/ (the SDK bundle): it is counted in, and read from the
// working tree, where npm run vendor:wallet built it.
const commitBlob = (p) => { try { return execFileSync("git", ["cat-file", "blob", `${sha}:${p}`], { cwd: REPO, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const leftOut = (() => {
  const list = commitBlob("scripts/publish-files.json");
  if (!list) return [];
  return (JSON.parse(list.toString("utf8")).exclude ?? []).map((e) => e.path)
    .filter((p) => p.startsWith("src/web/public/") && !p.includes("*")).map((p) => p.slice("src/web/public/".length));
})();
const rebuilt = await expectedRelease({
  list: () => [...new Set([...execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", sha, "--", "src/web/public"], { cwd: REPO, encoding: "utf8" })
    .split("\0").filter(Boolean).map((p) => p.slice("src/web/public/".length)), ...leftOut])],
  read: (p) => {
    const b = commitBlob(p);
    if (b || !leftOut.includes(p.slice("src/web/public/".length))) return b;
    const disk = join(REPO, ...p.split("/"));
    return existsSync(disk) ? readFileSync(disk) : null;
  },
}, sha);
ok("rebuilt from the commit, it is the same manifest byte for byte (no build time in it)", rebuilt.manifest === manifestBytes);

console.log("\nthe Caddyfile serves it (deploy/Caddyfile)");
const caddy = readFileSync(join(REPO, "deploy", "Caddyfile"), "utf8").replace(/\r\n/g, "\n");
// Each page's block (L1): its matcher, its file, its policy file, and the
// fixed headers its function lists.
for (const [p, matcher] of [[LANDING, "landing"], [APP, "page"], [AIPAGE, "ai"]]) {
  const pageBlock = block(caddy, `handle @${matcher} {`);
  const caddyHeaders = Object.fromEntries(block(pageBlock, "header {").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return [l.slice(0, i).toLowerCase(), l.slice(i + 1).replace(/^"(.*)"$/, "$1")];
  }));
  const { "content-type": _type, "content-security-policy": _policy, ...fixed } = compiled[p.headers]();
  const { "content-security-policy": caddyPolicy, ...caddyFixed } = caddyHeaders;
  ok(`the ${p.name}'s policy is read from the live release's ${p.policyFile}`,
    caddyPolicy === `{file./srv/clank/current/${p.policyFile}}`, caddyPolicy);
  ok(`the ${p.name}'s other headers are ${p.headers}()'s, all of them and no more`,
    JSON.stringify(Object.entries(caddyFixed).sort()) === JSON.stringify(Object.entries(fixed).sort()),
    `Caddyfile ${JSON.stringify(caddyFixed)} · code ${JSON.stringify(fixed)}`);
  const pagePaths = caddy.match(new RegExp(`@${matcher} path ([^\\n]+)\\n`))?.[1].split(/\s+/) ?? [];
  const inPage = (f) => f.slice("page/".length);
  ok(`the ${p.name} is the live release's ${p.file}, at ${p.paths.join(", ")} only`,
    pagePaths.join(" ") === p.paths.join(" ") && pageBlock.includes("root * /srv/clank/current/page\n")
      && pageBlock.includes(`rewrite * /${inPage(p.file)}\n`), pagePaths.join(" "));
  ok("…and with no policy file it is 503, never a page without one",
    new RegExp(`@nopolicy not file \\{\\s*root /srv/clank/current/page\\s*try_files /${inPage(p.policyFile).replace(".", "\\.")}\\s*\\}`).test(pageBlock)
      && /respond @nopolicy .* 503/.test(pageBlock));
}
const renamedPaths = caddy.match(/@renamed path ([^\n]+)\n/)?.[1].split(/\s+/) ?? [];
// `redir /os 301` would read /os as a path matcher, not the target: the old
// names then answer an empty 200 (L5). The target needs a matcher before it.
ok("the app's old names, /os now among them, answer 301 to /trade (N-D9, P2b), with the redirect's matcher written out",
  renamedPaths.join(" ") === RENAMED_PATHS.join(" ") && /handle @renamed \{[\s\S]*?\n\s*redir \* \/trade\{\?query\} 301\s*\}/.test(caddy), renamedPaths.join(" "));
ok("no redir in the Caddy files starts with a path, which Caddy would take for a matcher",
  [caddy, readFileSync(join(REPO, "deploy", "redirects.caddy"), "utf8"), readFileSync(join(REPO, "deploy", "gateway.caddy"), "utf8")]
    .every((f) => !/^\s*redir\s+\/(?!\S*\s+\/)/m.test(f)));
const nodePaths = caddy.match(/@node path ([^\n]+)\n/)?.[1].split(/\s+/) ?? [];
ok("Node is proxied /healthz, /events and /api/* only: never the page", nodePaths.join(" ") === "/healthz /events /api/*", nodePaths.join(" "));
// P1b (P-D3): behind Cloudflare, the visitor's address is CF-Connecting-IP,
// believed only from Cloudflare's own ranges, and Node gets exactly it.
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const globalOptions = caddy.slice(caddy.search(/^\{$/m), caddy.indexOf("{$SITE_HOST} {"));
const servers = block(globalOptions, "servers {");
ok("the global options come first, and trust Cloudflare's published ranges, and only them (P1b)",
  caddy.search(/^\{$/m) >= 0 && caddy.search(/^\{$/m) < caddy.indexOf("{$SITE_HOST} {")
    && JSON.stringify(servers.match(/trusted_proxies static ([^\n]+)/)?.[1].trim().split(/\s+/)) === JSON.stringify(CLOUDFLARE),
  servers.match(/trusted_proxies[^\n]*/)?.[0].slice(0, 80));
ok("…read the visitor from CF-Connecting-IP, and say when the ranges were fetched",
  /^\s*client_ip_headers CF-Connecting-IP\s*$/m.test(servers) && /fetched \d{4}-\d{2}-\d{2}/.test(caddy));
ok("…and Node is given that address as its one X-Forwarded-For entry",
  /reverse_proxy 127\.0\.0\.1:8787 \{[\s\S]*?header_up X-Forwarded-For \{client_ip\}/.test(block(caddy, "handle @node {")));
const INERT = "default-src 'none'; frame-ancestors 'none'; sandbox";
const nodeBlock = block(caddy, "handle @node {");
ok("what Node answers is sandboxed, nosniff, cookie-free, and never a script or stylesheet",
  nodeBlock.includes(`header_down Content-Security-Policy "${INERT}"`) && nodeBlock.includes("header_down X-Content-Type-Options nosniff")
    && nodeBlock.includes('header_down Content-Type "(?i)^.*(script|css).*$" "application/octet-stream"')
    && nodeBlock.includes("header_down -Set-Cookie") && nodeBlock.includes("header_down -Clear-Site-Data"));
ok("…and so is every /v/ file", block(block(caddy, "handle @release {"), "header {").includes(`Content-Security-Policy "${INERT}"`));

// ---------------------------------------------------------------- booting --
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const get = (port, path, host) => new Promise((resolve) => {
  const q = request({ host: "127.0.0.1", port, path, headers: { host }, setHost: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  q.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  q.end();
});

/** Only what an OS needs to run node, plus what the test names. Nothing from this shell's wallet settings. */
function env(extra) {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), ...extra };
}

/** Start the release; resolves when it exits or `until` says so. */
function boot(extra, until) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/entry/hosted.js"], { cwd: OUT, env: env(extra) });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    let settled = null;
    const timer = setTimeout(() => { settled = { code: "timeout" }; child.kill(); }, 25_000);
    // Resolve only once the process is gone: on Windows a live child still holds
    // the release directory, and the cleanup below would fail with EBUSY.
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, ...settled, out }); });
    if (until) until(child, (result) => { clearTimeout(timer); settled = result; child.kill(); });
  });
}

const base = (port) => ({
  WEB_PORT: String(port), PUBLIC_ORIGIN: `http://localhost:${port}`, WEB_BACKFILL: "0", WS_URL: "",
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com", HISTORY_FILE: join(tmpdir(), `clank-release-test-${process.pid}.json`),
});

console.log("\nbooting it as the server will");
{
  const port = await freePort();
  // Each page as its hosted route would write it, from the same source the
  // release was built from: put back for one request, then taken away again.
  const nodeCopy = join(OUT, "src", "web", "public", "app.html");
  const landingCopy = join(OUT, "src", "web", "public", "landing", "index.html");
  const landingSource = execFileSync("git", ["cat-file", "blob", `${sha}:src/web/public/landing/index.html`], { cwd: REPO, encoding: "utf8" });
  const source = execFileSync("git", ["cat-file", "blob", `${sha}:src/web/public/app.html`], { cwd: REPO, encoding: "utf8" })
    .replace('href="/app.css"', `href="/v/${sha}/app.css"`).replace('href="/phone.css"', `href="/v/${sha}/phone.css"`)
    .replace('href="/favicon-32.png"', `href="/v/${sha}/favicon-32.png"`)
    .replace('href="/apple-touch-icon.png"', `href="/v/${sha}/apple-touch-icon.png"`)
    .replace('src="/apple-touch-icon.png"', `src="/v/${sha}/apple-touch-icon.png"`)
    .replace('src="/js/main.js"', `src="/v/${sha}/js/main.js"`);
  const r = await boot(base(port), async (_child, done) => {
    for (let i = 0; i < 80; i++) {
      const h = await get(port, "/healthz", `127.0.0.1:${port}`);
      if (h.status === 200) {
        const bare = await get(port, "/", `localhost:${port}`);
        const bareOs = await get(port, "/trade", `localhost:${port}`);
        const bareAi = await get(port, "/ai", `localhost:${port}`);
        const bareConsole = await get(port, "/console", `localhost:${port}`);
        writeFileSync(nodeCopy, source);
        const route = await get(port, "/trade", `localhost:${port}`);
        rmSync(nodeCopy, { force: true });
        mkdirSync(join(OUT, "src", "web", "public", "landing"), { recursive: true });
        writeFileSync(landingCopy, landingSource);
        const landingRoute = await get(port, "/", `localhost:${port}`);
        rmSync(landingCopy, { force: true });
        const renamed = await get(port, "/terminal", `localhost:${port}`);
        return done({ health: h, bare, bareOs, bareAi, bareConsole, route, landingRoute, renamed });
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    done({ health: null });
  });
  rmSync(nodeCopy, { force: true });
  rmSync(landingCopy, { force: true });
  ok("plain node boots the release and /healthz answers", r.health?.status === 200, r.health ? r.health.body : r.out.slice(0, 300));
  ok("Node has no page to write in a release: /, /trade, /ai and /console are 404 (H1.2)",
    r.bare?.status === 404 && r.bareOs?.status === 404 && r.bareAi?.status === 404 && r.bareConsole?.status === 404 && !r.bare?.headers["content-security-policy"],
    `${r.bare?.status} ${r.bareOs?.status} ${r.bareAi?.status} ${r.bareConsole?.status}`);
  ok("the release's landing is what the landing route writes, with its assets under /v/<sha>/",
    r.landingRoute?.status === 200 && renderLanding(r.landingRoute.body, sha, undefined, preloadOf(LANDING)).page === landing, `${r.landingRoute?.status}`);
  ok("…and the route's headers are landingPageHeaders(), the ones the manifest lists",
    Object.entries(compiled.landingPageHeaders()).every(([k, v]) => r.landingRoute?.headers[k] === v));
  ok("Node answers an old name with the same 301 to /trade as Caddy, for local runs",
    r.renamed?.status === 301 && r.renamed.headers.location === "/trade", `${r.renamed?.status} ${r.renamed?.headers.location}`);
  ok("the release's page is what the hosted route writes, plus its sha in the footer and its modulepreload links",
    r.route?.status === 200 && withPreloads(r.route.body.replace('id="release">local<', `id="release">${sha}<`), preloadOf(APP), `/v/${sha}/`) === page,
    `${r.route?.status}`);
  const routeHeaders = compiled.hostedPageHeaders();
  ok("…and the route's headers are hostedPageHeaders(), the ones the manifest lists (F5.6)",
    Object.entries(routeHeaders).every(([k, v]) => r.route?.headers[k] === v));
}
{
  const port = await freePort();
  const r = await boot({ ...base(port), WALLET_HOT: "manual" });
  ok("it refuses to boot with WALLET_HOT=manual", r.code === 1 && r.out.includes("Refusing to start: WALLET_HOT"), `exit ${r.code}`);
  const r2 = await boot({ ...base(port), KEYSTORE_PATH: "/x", PRIVATE_KEY: "0x01", WALLET_PASSPHRASE: "p" });
  ok("…and names every self variable it found", r2.code === 1 && r2.out.includes("KEYSTORE_PATH, WALLET_PASSPHRASE, PRIVATE_KEY"), r2.out.trim().split("\n")[0]);
  const r3 = await boot({ ...base(port), PUBLIC_ORIGIN: "" });
  ok("it refuses to boot without PUBLIC_ORIGIN", r3.code === 1 && r3.out.includes("PUBLIC_ORIGIN is not set"), `exit ${r3.code}`);
}
{
  // A copied self .env in the release directory must not reach the process.
  const port = await freePort();
  const dotenv = join(OUT, ".env");
  writeFileSync(dotenv, "WALLET_HOT=both\nWALLET_PASSPHRASE=hunter2\nKEYSTORE_PATH=data/keystore.json\n");
  try {
    const r = await boot(base(port), async (_child, done) => {
      for (let i = 0; i < 80; i++) {
        if ((await get(port, "/healthz", `127.0.0.1:${port}`)).status === 200) return done({ up: true });
        await new Promise((res) => setTimeout(res, 250));
      }
      done({ up: false });
    });
    ok("a self .env in its directory is never read (it boots, not refuses)", r.up === true, r.out.trim().split("\n")[0]);
  } finally {
    rmSync(dotenv, { force: true });
  }
}

// ------------------------------------------------------------ verify-live --
console.log("\nverify-live, against a server that routes the release as the Caddyfile does");
{
  const headerBlock = (opener) => Object.fromEntries(block(block(caddy, opener), "header {").split("\n")
    .map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf(" ");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")];
    }));
  const fixedOf = (opener) => Object.fromEntries(Object.entries(headerBlock(opener)).filter(([k]) => k !== "Content-Security-Policy"));
  const pageFixed = { landing: fixedOf("handle @landing {"), app: fixedOf("handle @page {"), ai: fixedOf("handle @ai {") };
  const releaseHeaders = headerBlock("handle @release {");
  const manifestHeaders = headerBlock("handle @manifest {");
  const PUB = join(OUT, "src", "web", "public");
  let nodeInert = true;
  let renames = true;
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const p = PAGES.find((x) => x.paths.includes(path));
    if (p) {
      const policyPath = join(OUT, ...p.policyFile.split("/"));
      if (!existsSync(policyPath)) return void res.writeHead(503).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...pageFixed[p.name], "content-security-policy": readFileSync(policyPath, "utf8") });
      return void res.end(readFileSync(join(OUT, ...p.file.split("/"))));
    }
    if (renames && RENAMED_PATHS.includes(path)) return void res.writeHead(301, { location: "/trade" }).end();
    if (path === `/${MANIFEST_FILE}`) {
      res.writeHead(200, { "content-type": "application/json", ...manifestHeaders });
      return void res.end(readFileSync(join(OUT, MANIFEST_FILE)));
    }
    const v = path.match(/^\/v\/([0-9a-f]{40})\/(.+)$/);
    if (v && v[1] === sha) {
      const f = join(PUB, ...v[2].split("/"));
      if (!relative(PUB, f).startsWith("..") && existsSync(f) && statSync(f).isFile()) {
        res.writeHead(200, releaseHeaders);
        return void res.end(readFileSync(f));
      }
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", ...(nodeInert
        ? { "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox", "X-Content-Type-Options": "nosniff" } : {}) });
      return void res.end('{"ok":true}');
    }
    res.writeHead(404).end();
  });
  const port = await freePort();
  await new Promise((res) => server.listen(port, "127.0.0.1", res));
  const verify = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, "scripts", "verify-live.mjs"), `http://127.0.0.1:${port}`, "--repo", REPO], { env: env({}) });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") }));
  });
  /** Change a file for one run of verify-live, then put it back. */
  const withChange = async (file, change) => {
    const before = existsSync(file) ? readFileSync(file) : null;
    change(before);
    try { return await verify(); } finally {
      if (before) writeFileSync(file, before); else rmSync(file, { force: true });
    }
  };
  const diffs = (out) => out.split("\n").filter((l) => l.trim().startsWith("DIFF")).map((l) => l.trim().slice(4).trim().split("  ")[0]);

  let r = await verify();
  ok("it passes against the release as built", r.code === 0, r.code === 0 ? r.out.trim().split("\n").at(-1) : r.out.slice(-600));
  const mainJs = join(PUB, "js", "main.js");
  r = await withChange(mainJs, (b) => { const c = Buffer.from(b); c[c.length - 2] ^= 1; writeFileSync(mainJs, c); });
  ok("…and fails, naming the file, when one byte of one served file differs", r.code === 1 && diffs(r.out).join() === "js/main.js", diffs(r.out).join(" | "));
  const font = join(PUB, "fonts", "JetBrainsMono-Regular.woff2");
  r = await withChange(font, (b) => { const c = Buffer.from(b); c[100] ^= 0x80; writeFileSync(font, c); });
  ok("…one byte of a font", r.code === 1 && diffs(r.out).join() === "fonts/JetBrainsMono-Regular.woff2", diffs(r.out).join(" | "));
  const pageFile = join(OUT, ...APP.file.split("/"));
  r = await withChange(pageFile, (b) => writeFileSync(pageFile, b.toString("utf8").replace("<title>", "<title> ")));
  ok("…one byte of the app", r.code === 1 && diffs(r.out).some((d) => d.includes("the app, byte for byte")), diffs(r.out).join(" | "));
  const landingFile = join(OUT, ...LANDING.file.split("/"));
  r = await withChange(landingFile, (b) => writeFileSync(landingFile, b.toString("utf8").replace("<title>", "<title> ")));
  ok("…one byte of the landing", r.code === 1 && diffs(r.out).length > 0 && diffs(r.out).every((d) => d.includes("/: the landing, byte for byte")), diffs(r.out).join(" | "));
  const policyFile = join(OUT, ...APP.policyFile.split("/"));
  r = await withChange(policyFile, (b) => writeFileSync(policyFile, b.toString("utf8").replace("connect-src 'self'", "connect-src 'self' https://evil.test")));
  ok("…the policy the app is served with", r.code === 1 && diffs(r.out).join().includes("content-security-policy"), diffs(r.out).join(" | "));
  const landingPolicyFile = join(OUT, ...LANDING.policyFile.split("/"));
  r = await withChange(landingPolicyFile, (b) => writeFileSync(landingPolicyFile, b.toString("utf8").replace("connect-src ", "connect-src https://api.cdp.coinbase.com ")));
  ok("…the policy the landing is served with", r.code === 1 && diffs(r.out).some((d) => d.startsWith("/: content-security-policy")), diffs(r.out).join(" | "));
  renames = false;
  r = await verify();
  renames = true;
  ok("…an old name that no longer redirects", r.code === 1 && diffs(r.out).length === RENAMED_PATHS.length && diffs(r.out).every((d) => d.includes("answers 301 to /trade")), diffs(r.out).join(" | "));
  r = await withChange(join(PUB, "app.html"), () => writeFileSync(join(PUB, "app.html"), page));
  ok("…a document under /v/<sha>/", r.code === 1 && diffs(r.out).some((d) => d.includes("app.html is not served")), diffs(r.out).join(" | "));
  mkdirSync(join(PUB, "landing"), { recursive: true });
  r = await withChange(join(PUB, "landing", "index.html"), () => writeFileSync(join(PUB, "landing", "index.html"), landing));
  ok("…the landing's source under /v/<sha>/", r.code === 1 && diffs(r.out).some((d) => d.includes("landing/index.html is not served")), diffs(r.out).join(" | "));
  const extra = join(PUB, "js", "extra.js");
  r = await withChange(extra, () => writeFileSync(extra, "export {};\n"));
  // A file the source does not have is not fetched by name, but the live
  // manifest would list it; this release's manifest does not, so it passes.
  ok("…but a file that nothing loads and the manifest does not list is not a difference", r.code === 0, diffs(r.out).join(" | "));
  const manifestFile = join(OUT, MANIFEST_FILE);
  r = await withChange(manifestFile, (b) => writeFileSync(manifestFile, b.toString("utf8").replace(/"app\.css": "[0-9a-f]{64}"/, `"app.css": "${"0".repeat(64)}"`)));
  ok("…the live manifest", r.code === 1 && diffs(r.out).some((d) => d.includes("hash is the source's")), diffs(r.out).join(" | "));
  nodeInert = false;
  r = await verify();
  nodeInert = true;
  ok("…and a proxy that lets Node's answers act as a page", r.code === 1 && diffs(r.out).some((d) => d.includes("sandboxed")), diffs(r.out).join(" | "));
  await new Promise((res) => server.close(res));
}

rmSync(OUT, { recursive: true, force: true });
rmSync(TARBALL, { force: true });
console.log(failures === 0
  ? "\n\x1b[32mall release checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
