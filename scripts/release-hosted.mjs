// Build a hosted release from a commit — public-release H1.
//
//   node scripts/release-hosted.mjs [--ref <ref>] [--keep]
//
// Runs on the operator's machine, never on the server: a server with a checkout
// would hold src/self/. The release is built from the commit, not the working
// tree, so uncommitted files neither block it nor leak into it.
//
//   releases/hosted-<sha>.tar.gz   what deploy/deploy.sh ships
//   releases/hosted-<sha>/         the same, unpacked (only with --keep)
//
// Inside: src/**/*.js compiled from exactly what src/entry/hosted.ts reaches;
// src/web/public/ with only what is served under /v/<sha>/; the two pages, the
// landing and the app, rendered for this commit, each with its policy in page/
// (H1.2, L1); release-manifest.json;
// package.json, the lockfile, production node_modules and RELEASE.json.
//
// It fails on a type error, anything under src/self/, a native module, a dev
// dependency in node_modules, an .env file, or a file in src/web/public/ of a
// type that could be served as a document.
//
// The steps it shares with the gateway's release (X18) are in
// release-common.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, finish, installAndCheck, posix, readCommit, walk } from "./release-common.mjs";
import { expectedRelease, MANIFEST_FILE } from "./release-page.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const REF = flag("--ref") ?? "HEAD";
const KEEP = args.includes("--keep");
const fail = (msg) => { console.error(`release-hosted: ${msg}`); process.exit(1); };
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });

const sha = git("rev-parse", "--verify", `${REF}^{commit}`).trim();
const OUT_ROOT = join(REPO, "releases");
// Inside the repo, so the compiler finds the repo's node_modules for types by
// walking up. Deleted at the end.
const BUILD = join(OUT_ROOT, ".build", sha);
const TREE = join(BUILD, "tree");
const OUT = join(OUT_ROOT, `hosted-${sha}`);
const TARBALL = join(OUT_ROOT, `hosted-${sha}.tar.gz`);
rmSync(BUILD, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(TREE, { recursive: true });

// ---------------------------------------------------------------- 1. commit --
readCommit({ repo: REPO, sha, paths: ["src", "package.json", "package-lock.json", "tsconfig.json"], tree: TREE, fail });

// The published repository commits the wallet SDK bundle's pin, not the bundle
// (Coinbase publishes it with no licence). There, the release takes the bundle
// `npm run vendor:wallet` built in this checkout, with its licences, and only
// when its sha256 is the committed pin. A commit that holds the bundle is
// released as it is.
{
  const VENDOR = ["src", "web", "public", "vendor"];
  const inTree = (name) => join(TREE, ...VENDOR, name);
  if (!existsSync(inTree("wallet.js")) && existsSync(inTree("wallet.js.sha256"))) {
    const pin = readFileSync(inTree("wallet.js.sha256"), "utf8").trim().split(/\s+/)[0];
    const built = join(REPO, ...VENDOR, "wallet.js");
    const licences = join(REPO, ...VENDOR, "LICENSES.txt");
    if (!existsSync(built) || !existsSync(licences)) fail(`${sha} holds the wallet bundle's pin only: run npm run vendor:wallet first`);
    const bytes = readFileSync(built);
    if (createHash("sha256").update(bytes).digest("hex") !== pin) {
      fail("src/web/public/vendor/wallet.js is not the bundle the commit pins: run npm run vendor:wallet again, with the committed lockfile");
    }
    writeFileSync(inTree("wallet.js"), bytes);
    writeFileSync(inTree("LICENSES.txt"), readFileSync(licences));
  }
}

// --------------------------------------------------------------- 2. compile --
const { js, reached: reachedTs } = compile({
  tree: TREE, out: OUT, sha, roots: ["src/entry/hosted.ts"], forbidden: ["self"], who: "hosted", fail,
});
if (!js.includes("src/entry/hosted.js") || !js.includes("src/entry/mode-hosted.js")) fail("hosted's entry was not emitted");

// ---------------------------------------------------------- 3. static files --
// What Caddy serves from the release (H1.2, scripts/release-page.mjs): the
// files under /v/<sha>/, none of them a document; the two pages and their
// policies, which Node never writes; and the manifest that lets anyone compare
// the live site with this commit. The declarations, the bundle's pin and the
// pages' own sources are left out of the /v/ tree.
let expected;
try {
  expected = await expectedRelease({
    list: () => walk(join(TREE, "src", "web", "public")),
    read: (p) => { const f = join(TREE, ...p.split("/")); return existsSync(f) ? readFileSync(f) : null; },
  }, sha);
} catch (e) {
  fail(e.message);
}
for (const f of expected.files) {
  if (!f.bytes) fail(`src/web/public/${f.path} is missing from ${sha}`);
  const dest = join(OUT, "src", "web", "public", ...f.path.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.bytes);
}
// The landing and the app (L1), each with its own policy.
for (const p of expected.pages) {
  mkdirSync(join(OUT, dirname(p.file)), { recursive: true });
  writeFileSync(join(OUT, p.file), p.page);
  // One line and no newline: Caddy's {file.*} placeholder puts it in the header as read.
  writeFileSync(join(OUT, p.policyFile), p.policy);
}
writeFileSync(join(OUT, MANIFEST_FILE), expected.manifest);

// ------------------------------------------------------------ 4. packages --
const pkg = installAndCheck({ tree: TREE, out: OUT, forbidden: ["self"], who: "release-hosted", fail });

// --------------------------------------------------------------- 5. tarball --
finish({
  out: OUT, outRoot: OUT_ROOT, build: BUILD, tarball: TARBALL, keep: KEEP,
  meta: { sha, ref: REF, builtAt: new Date().toISOString(), node: pkg.engines?.node ?? null },
});

const size = (statSync(TARBALL).size / 1024 / 1024).toFixed(1);
console.log(`release-hosted: ${sha.slice(0, 12)} → ${posix(relative(REPO, TARBALL))} (${size} MB)`);
console.log(`  ${js.length} compiled modules from ${reachedTs} reachable sources, none under src/self/`);
console.log(`  ${expected.files.length} files under /v/<sha>/, ${expected.pages.length} pages and their policies in page/, and ${MANIFEST_FILE}`);
if (KEEP) console.log(`  unpacked in ${posix(relative(REPO, OUT))}`);
