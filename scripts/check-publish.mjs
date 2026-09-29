// The publish check — public-release O1.2.
//
// Proves a tree is fit to publish, rather than trusting a careful read. It
// fails on:
//
//   - a file that is not on the curated list (scripts/publish-files.json), and
//     a file on the never-list below, whatever the curated list says. The
//     list's `rename` entries publish a file under another name (the public
//     README.md is README.public.md here), and --ref and --worktree give each
//     file its published name;
//   - an entry of the operator's denylist, or a truncated or prefix form of a
//     denylisted address or hash (`0x1234…abcd`, `0x1234`). The denylist lives
//     outside the repository, because a denylist in the repo would publish
//     exactly what it guards. It is read from --denylist or
//     CLANK_PUBLISH_DENYLIST, and the check fails closed: no denylist, an
//     unreadable one or an empty one is a failure;
//   - a 40- or 64-hex string that is not on scripts/publish-allowlist.json, not
//     inside a file pinned there by hash, and not plainly synthetic (a small
//     number, `0x…c1a4e`, `0xeeee…`). Unknown hex fails, not only known-bad
//     hex: a real address a test or a doc adds later fails until someone has
//     looked at it;
//   - personal data: a home-directory path, an email address, a public IP
//     address, a key block, a `*_KEY=`, `*_SECRET=`, `*_TOKEN=`, `PASSWORD=` or
//     `PASSPHRASE=` with a value;
//   - a binary file not pinned by hash, and any file over 1 MB;
//   - a file that needs one that is not published: a relative import, a
//     `new URL(…, import.meta.url)`, or a path in an npm script. The published
//     tree must build and test on its own. A reference the curated list names
//     as optional, because its file copes without it, is the one exception;
//   - in a git directory: uncommitted changes, any author or committer other
//     than the noreply identity, and any denylist entry anywhere in the history.
//
//   node scripts/check-publish.mjs <dir>              the tree about to be published
//   node scripts/check-publish.mjs --ref <ref>        the curated files of a commit
//   node scripts/check-publish.mjs --worktree         the curated files as they are on disk
//   node scripts/check-publish.mjs --ref HEAD --list  print the curated files, and stop
//
//   --denylist <file>        or CLANK_PUBLISH_DENYLIST
//   --identity <email>       or CLANK_PUBLISH_IDENTITY: the one commit identity
//                            allowed. Without it, every commit email must be a
//                            noreply address.
//   --allow-empty-denylist   for CI in the published tree, which must never hold
//                            the operator's list
//
// The denylist file: one entry per line, and `#` starts a comment. An entry is
// an address or a hash (0x and 40 or 64 hex digits), matched anywhere, padded
// or not, in any case; or any other text (an email, a name, a handle, a
// hostname), matched without regard to case. What follows `#` on an entry's
// line is its label. The report names an entry by its line and label and
// never prints its value.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const LIST_FILE = "scripts/publish-files.json";
export const ALLOW_FILE = "scripts/publish-allowlist.json";
export const HOSTED_ENTRY = "src/entry/hosted.ts";
export const MAX_BYTES = 1024 * 1024;

/**
 * Never published, whatever the curated list says (public-release README,
 * decision of 2026-09-22: public users get the web app only). Here rather
 * than in a JSON file, so that editing the list cannot publish one of these.
 */
export const NEVER = [
  ["src/self/**", "the console: keystore, sniper, exit manager and the Solana sniper"],
  ["src/entry/self.ts", "the console's entrypoint"],
  ["src/entry/solana.ts", "the Solana sniper's entrypoint"],
  ["src/server/routes/self.ts", "the console's route table"],
  ["sol/**", "the Solana sniper"],
  ["scripts/sol-*", "the Solana sniper's scripts"],
  ["docs/solana-*", "the Solana sniper's notes"],
  ["docs/specs/solana/**", "the Solana sniper's spec"],
  ["docs/specs/solana-rust/**", "the Solana sniper's spec"],
  ["art/**", "mascot sources, including clank.trade's marks (Q6)"],
  ["data/**", "local state: keystore, positions, spend"],
  ["releases/**", "built releases"],
  [".claude/**", "agent settings"],
  ["docs/progress.md", "session notes, positions and balances"],
  ["docs/current-issues.md", "session notes"],
  ["docs/specs/public/**", "the release plan, which discusses the operator's own trading and plans"],
  ["docs/specs/gated-launch.md", "the operator's own token plans"],
  ["docs/specs/clankchan-character.md", "the mascot's character notes"],
  ["docs/specs/positions-page.md", "names the operator's own round trip"],
  ["docs/specs/rpc-budget.md", "the operator's balance and positions"],
  ["docs/rpc-optimization.md", "the operator's own measurements"],
  ["**/.apimart-key", "an API key"],
  ["**/*.pem", "a key or certificate"],
  ["**/*.key", "a key"],
  ["**/keystore*.json", "a keystore"],
].map(([glob, why]) => ({ glob, why, re: globRe(glob) }));
/** `.env` and every variant, except the templates. */
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_TEMPLATE = /\.example$/;

/** `**` matches across segments, `*` within one, and a leading `**∕` matches none too. */
function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Why a path may never be published, or null. */
export function never(path) {
  if (ENV_FILE.test(path) && !ENV_TEMPLATE.test(path)) return "an environment file: secrets";
  return NEVER.find((n) => n.re.test(path))?.why ?? null;
}

/**
 * Compile the curated list. A repository path is on it (`has`) when an include
 * matches and no exclude does. A `rename` entry publishes a listed file under
 * another name (README.public.md as README.md), so a path in a published tree
 * is on it (`published`) under its published name only.
 */
export function compileList(list) {
  const inc = (list.include ?? []).map((e) => ({ ...e, re: globRe(e.path) }));
  const exc = (list.exclude ?? []).map((e) => ({ ...e, re: globRe(e.path) }));
  const has = (p) => inc.some((e) => e.re.test(p)) && !exc.some((e) => e.re.test(p));
  const renames = new Map((list.rename ?? []).map((r) => [r.from, r.to]));
  const sources = new Map((list.rename ?? []).map((r) => [r.to, r.from]));
  const published = (p) => (sources.has(p) ? has(sources.get(p)) : has(p) && !renames.has(p));
  return { inc, exc, has, renames, published, as: (p) => renames.get(p) ?? p };
}

/**
 * The files an npm script command names (a path with a directory and an
 * extension, or a glob of them) that `files` does not have.
 */
export function scriptMissing(cmd, files) {
  const missing = [];
  for (const m of cmd.matchAll(/(?<![\w./*-])((?:\.\/)?[\w.-]+(?:\/[\w.*-]+)+)(?![\w./*-])/g)) {
    const p = m[1].replace(/^\.\//, "");
    if (!/\.[A-Za-z0-9]{1,5}$/.test(p)) continue;
    const ok = p.includes("*") ? [...files.keys()].some((f) => globRe(p).test(f)) : files.has(p);
    if (!ok) missing.push(p);
  }
  return missing;
}

// ------------------------------------------------------------- the denylist --

/**
 * Parse a denylist file. Entries keep their line number and label so that a
 * finding can name one without printing it.
 */
export function parseDenylist(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const hash = raw.indexOf("#");
    const value = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const label = hash >= 0 ? raw.slice(hash + 1).trim() : "";
    if (!value) return;
    const hex = value.match(/^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/);
    entries.push(hex
      ? { line: i + 1, label, kind: "hex", value: hex[1].toLowerCase() }
      : { line: i + 1, label, kind: "text", value: value.toLowerCase() });
  });
  return entries;
}

/** Read the denylist, failing closed. Returns { entries } or { error }. */
export function loadDenylist(path, { allowEmpty = false } = {}) {
  if (!path && allowEmpty) return { entries: [] };
  if (!path) {
    return { error: "no denylist: pass --denylist <file> or set CLANK_PUBLISH_DENYLIST (it lives outside the repo)" };
  }
  const abs = resolve(path);
  const rel = relative(REPO, abs);
  if (!rel.startsWith("..") && !rel.includes(":")) {
    return { error: "the denylist is inside the repository, where it would be published: keep it outside" };
  }
  let text;
  try { text = readFileSync(abs, "utf8"); } catch (e) {
    return { error: `the denylist cannot be read (${e.code ?? e.message})` };
  }
  const entries = parseDenylist(text);
  if (!entries.length && !allowEmpty) {
    return { error: "the denylist is empty: pass --allow-empty-denylist only where the operator's list must not exist (CI in the published tree)" };
  }
  return { entries };
}

const name = (e) => `denylist line ${e.line}${e.label ? ` (${e.label})` : ""}`;

// -------------------------------------------------------------- the sources --

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** Blob contents for object ids, read in one `git cat-file --batch`. */
function readBlobs(cwd, oids) {
  if (!oids.length) return [];
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd, input: `${oids.join("\n")}\n`, maxBuffer: 1 << 30 });
  const blobs = [];
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(10, i);
    const head = out.subarray(i, nl).toString("utf8").split(" ");
    if (head[1] === "missing") throw new Error(`git has no object ${head[0]}`);
    const start = nl + 1;
    const end = start + Number(head[2]);
    blobs.push(out.subarray(start, end));
    i = end + 1;
  }
  return blobs;
}

/** Every file under a directory, relative, with forward slashes. */
function walk(dir, base = dir, skip = new Set([".git"])) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (skip.has(n) && dir === base) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base, skip));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/**
 * The curated files of this repository, from a commit (`ref`) or as they are
 * on disk (`worktree`: tracked files, plus untracked ones git does not ignore).
 * Returns { files: Map<path, Buffer>, repoFiles, label, list, allowlist }.
 */
export function fromRepo({ ref = null, cwd = REPO } = {}) {
  let paths;
  let read;
  let label;
  let modeOf = () => null;
  if (ref) {
    const sha = git(cwd, "rev-parse", "--verify", `${ref}^{commit}`).trim();
    const rows = git(cwd, "ls-tree", "-r", "-z", "--format=%(objectmode) %(objectname) %(path)", sha)
      .split("\0").filter(Boolean).map((row) => {
        const [mode, oid] = row.split(" ", 2);
        return { mode, oid, path: row.slice(mode.length + oid.length + 2) };
      });
    const byPath = new Map(rows.map((r) => [r.path, r]));
    modeOf = (p) => byPath.get(p)?.mode ?? null;
    paths = rows.map((r) => r.path);
    read = (want) => {
      const oids = want.map((p) => {
        const r = byPath.get(p);
        if (r.mode !== "100644" && r.mode !== "100755") throw new Error(`${p} is not a regular file in ${sha} (mode ${r.mode})`);
        return r.oid;
      });
      return readBlobs(cwd, oids);
    };
    label = `${ref} (${sha.slice(0, 12)})`;
  } else {
    paths = git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
      .split("\0").filter(Boolean).filter((p) => existsSync(join(cwd, p)));
    paths = [...new Set(paths)];
    read = (want) => want.map((p) => readFileSync(join(cwd, p)));
    label = "the working tree";
  }
  if (!paths.includes(LIST_FILE) || !paths.includes(ALLOW_FILE)) throw new Error(`${LIST_FILE} and ${ALLOW_FILE} must both exist in ${label}`);
  const [listBuf, allowBuf] = read([LIST_FILE, ALLOW_FILE]);
  const list = JSON.parse(listBuf.toString("utf8"));
  const allowlist = JSON.parse(allowBuf.toString("utf8"));
  const compiled = compileList(list);
  const chosen = paths.filter((p) => compiled.has(p)).sort();
  const blobs = read(chosen);
  // Keyed by the name each file is published under, so this is the tree as
  // it would be published. `modes` holds git's file mode (100755 for the
  // deploy scripts), from a commit only.
  const files = new Map();
  const modes = new Map();
  chosen.forEach((p, i) => {
    const as = compiled.as(p);
    if (files.has(as)) throw new Error(`${p} would be published as ${as}, which another listed file already is`);
    files.set(as, blobs[i]);
    if (modeOf(p)) modes.set(as, modeOf(p));
  });
  return {
    files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), modes, repoFiles: paths, label, list, allowlist, git: null,
  };
}

/**
 * A directory about to be published. In a git directory, what is published is
 * the commit: the tracked files, with a clean status required. Otherwise every
 * file in it.
 */
export function fromDir(dir) {
  const abs = resolve(dir);
  const isGit = existsSync(join(abs, ".git"));
  const paths = isGit ? git(abs, "ls-files", "-z").split("\0").filter(Boolean) : walk(abs);
  const files = new Map(paths.filter((p) => existsSync(join(abs, p))).sort().map((p) => [p, readFileSync(join(abs, p))]));
  const readJson = (p) => (files.has(p) ? JSON.parse(files.get(p).toString("utf8")) : null);
  return {
    files, repoFiles: null, label: abs, list: readJson(LIST_FILE), allowlist: readJson(ALLOW_FILE),
    git: isGit ? abs : null,
  };
}

// ---------------------------------------------------------------- the checks --

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
/** A text file's hash ignores line endings, so a Windows checkout pins the same as git. */
export function pinHash(buf) {
  const body = isBinary(buf) ? buf : Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(body).digest("hex");
}

/** Line number of each offset, from a text's line starts. */
function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
function lineStarts(text) {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
  return s;
}

/**
 * Plainly not an identifier: a number (at most 24 significant hex digits once
 * leading and trailing zeros go, which no real address or hash has), or a
 * repeated short unit (`0xeeee…`, all ones, `deadbeef` repeated).
 */
export function synthetic(hex) {
  const core = hex.replace(/^0+/, "").replace(/0+$/, "");
  if (core.length <= 24) return true;
  return /^(.{1,8})\1+$/.test(hex);
}

/** The values a hex run stands for: itself, or the 64-digit words of ABI data. */
function hexValues(run) {
  const n = run.length;
  if (n === 40 || n === 64) return [run];
  if (n > 64 && n % 64 === 0) return run.match(/.{64}/g);
  if (n > 72 && (n - 8) % 64 === 0) return run.slice(8).match(/.{64}/g);
  return [run];
}

// Runs of 40+ hex digits: 0x-prefixed ones whatever follows (a BigInt literal
// ends in n), bare ones only where they stand alone, not inside a word.
const HEX_RUN = /(?<![0-9A-Za-z])(0[xX])?([0-9a-fA-F]{40,})([g-zG-Z]?)/g;
const TRUNCATED = /(?<![0-9A-Za-z])(?:0[xX])?([0-9a-fA-F]{4,})\s?(?:…|\.{2,3})\s?([0-9a-fA-F]{3,})(?![0-9A-Za-z])/g;
const PREFIX = /(?<![0-9A-Za-z])0[xX]([0-9a-fA-F]{4,39})(?![0-9A-Za-z])/g;

const HOME_PATH = /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)|(?<![\w.-])\/(?:home|Users)\/[\w.-]/;
// Five dashes and BEGIN: a PEM block. Written so that this file does not match itself.
const KEY_BLOCK = /-{5}BEGIN/;
// Environment-file style, NAME=value with no spaces: `const X_KEY = {` is code, not a secret.
const SECRET = /(?<![A-Z0-9_])([A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|PASSWORD|PASSPHRASE))=([^\s#'"`\\,;)}\]]+)/;
// The lookbehind starts a match only where a local part can begin: without it a
// long run of word characters costs quadratic time looking for an @.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const PLACEHOLDER_DOMAIN = /(^|\.)(example(\.[a-z]+)?|test|invalid|localhost)$/i;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

/** Loopback, private, link-local, documentation and special ranges: nobody's server. */
function reservedIp([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127);
}

/** Relative module paths a source file needs, with where each is named. */
const SPECIFIERS = [
  /\b(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g,
  /\bimport\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)/g,
  /(['"])(\.{1,2}\/[^'"\n]*)\1\s*,\s*import\.meta\.url/g,
];
const SOURCE = /\.(?:[cm]?[jt]s)$/;

function resolveIn(files, from, spec) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith("../")) return false;
  if (spec.endsWith("/")) return [...files.keys()].some((f) => f.startsWith(base));
  const cands = [base];
  if (base.endsWith(".js")) cands.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  if (base.endsWith(".mjs")) cands.push(base.replace(/\.mjs$/, ".mts"));
  if (base.endsWith(".cjs")) cands.push(base.replace(/\.cjs$/, ".cts"));
  if (!/\.[A-Za-z0-9]+$/.test(posix.basename(base))) cands.push(`${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`);
  return cands.some((c) => files.has(c));
}

/**
 * Run every check over a set of files.
 *
 * @param {object} t   { files: Map<path, Buffer>, list, allowlist, git, repoFiles }
 * @param {object} o   { denylist: { entries } | { error }, identity }
 * @returns {{ failures: {kind, where, what}[], warnings: {kind, where, what}[] }}
 */
export function check(t, { denylist, identity = null }) {
  const failures = [];
  const warnings = [];
  const fail = (kind, where, what) => failures.push({ kind, where, what });
  const warn = (kind, where, what) => warnings.push({ kind, where, what });
  const { files } = t;

  // ---- configuration
  const deny = denylist.entries ?? [];
  if (denylist.error) fail("denylist", "-", denylist.error);
  if (!t.list) fail("list", LIST_FILE, "missing: the curated list decides what may be published");
  if (!t.allowlist) fail("allowlist", ALLOW_FILE, "missing: the allowlist of public constants and reviewed fixtures");
  const list = compileList(t.list ?? {});
  const allow = t.allowlist ?? {};
  const hexAllowed = new Map();
  for (const group of ["constants", "thirdParty"]) {
    for (const e of allow[group] ?? []) {
      const v = String(e.value ?? "").toLowerCase().replace(/^0x/, "");
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) fail("allowlist", ALLOW_FILE, `${group}: ${e.value} is not 40 or 64 hex digits`);
      if (!e.why) fail("allowlist", ALLOW_FILE, `${group}: ${e.value} has no reason`);
      hexAllowed.set(v, { group, seen: false });
    }
  }
  const pins = new Map((allow.files ?? []).map((e) => [e.path, e]));
  for (const e of allow.files ?? []) {
    if (!e.why || !/^[0-9a-f]{64}$/.test(e.sha256 ?? "")) fail("allowlist", ALLOW_FILE, `files: ${e.path} needs a sha256 and a reason`);
    // A pin's own hash is a reviewed value: it names a reviewed file.
    else if (!hexAllowed.has(e.sha256)) hexAllowed.set(e.sha256, { group: "files", seen: true });
  }
  // A reviewed line excuses its own listing in the allowlist, too.
  const reviewed = (allow.lines ?? []).flatMap((e) => [e, { ...e, file: ALLOW_FILE, self: true }]);
  const usedLines = new Set();
  for (const e of reviewed) if (!e.why) fail("allowlist", ALLOW_FILE, `lines: ${e.file} "${e.text}" has no reason`);
  for (const e of [...(t.list?.include ?? []), ...(t.list?.exclude ?? [])]) {
    if (!e.why) fail("list", LIST_FILE, `${e.path} has no reason`);
  }
  // A rename publishes a listed file under another name. It must not land on
  // a name the list publishes anyway, or on one that may never be published.
  for (const r of t.list?.rename ?? []) {
    if (!r.from || !r.to || !r.why) { fail("list", LIST_FILE, `rename: ${r.from} → ${r.to} needs from, to and why`); continue; }
    if (list.has(r.to)) fail("list", LIST_FILE, `rename: ${r.from} → ${r.to}, but the list also publishes ${r.to} itself`);
    const why = never(r.to);
    if (why) fail("never", LIST_FILE, `rename: ${r.from} → ${r.to}, which is never published: ${why}`);
  }
  // References a published file may make to one that is not, because it copes
  // without it (a test that skips). Each with its reason.
  const optional = t.list?.optional ?? [];
  const usedOptional = new Set();
  for (const o of optional) if (!o.why || !o.from || !o.needs) fail("list", LIST_FILE, `optional: ${o.from} → ${o.needs} needs from, needs and why`);
  // Nothing the check denies may be on the allowlist.
  for (const e of deny.filter((d) => d.kind === "hex")) {
    if (hexAllowed.has(e.value)) fail("denylist", ALLOW_FILE, `${name(e)} is on the allowlist`);
  }

  // ---- which files
  if (!files.has(HOSTED_ENTRY)) fail("list", HOSTED_ENTRY, "the hosted entry is not in the tree");
  for (const p of files.keys()) {
    const why = never(p);
    if (why) fail("never", p, `never published: ${why}`);
    else if (list.renames.has(p) && list.has(p)) fail("unlisted", p, `published as ${list.renames.get(p)}, not under this name (${LIST_FILE}, rename)`);
    else if (!list.published(p)) fail("unlisted", p, `not on the curated list (${LIST_FILE})`);
  }
  const universe = t.repoFiles ?? [...files.keys()];
  // A published tree holds a renamed file under its new name.
  const exists = (p) => universe.includes(p) || (!t.repoFiles && list.renames.has(p) && universe.includes(list.renames.get(p)));
  for (const e of list.inc) if (!/[*]/.test(e.path) && !exists(e.path)) warn("list", LIST_FILE, `include ${e.path} matches no file`);
  // A published tree holds no excluded file, by design: only a repository can
  // show that an exclude has gone stale.
  if (t.repoFiles) for (const e of list.exc) if (!universe.some((p) => e.re.test(p))) warn("list", LIST_FILE, `exclude ${e.path} matches no file`);

  // ---- each file
  for (const [path, buf] of files) {
    if (buf.length > MAX_BYTES) fail("size", path, `${(buf.length / 1024 / 1024).toFixed(1)} MB, over the 1 MB limit`);
    const binary = isBinary(buf);
    const pin = pins.get(path);
    if (pin) {
      const got = pinHash(buf);
      if (got !== pin.sha256) fail("pin", path, `changed since it was reviewed (sha256 ${got}): review it, then update its sha256 in ${ALLOW_FILE}`);
    } else if (binary) {
      fail("binary", path, `a binary file that is not pinned: review it, then pin its sha256 in ${ALLOW_FILE}`);
    }
    const text = binary ? buf.toString("latin1") : buf.toString("utf8");
    const starts = lineStarts(text);
    const lower = text.toLowerCase();
    const at = (i) => `${path}:${lineOf(starts, i)}`;

    // The denylist, in every file, binary or not.
    const denied = new Set();
    for (const e of deny) {
      let i = lower.indexOf(e.value);
      while (i >= 0) {
        fail("denylist", at(i), name(e));
        if (e.kind === "hex") denied.add(e.value);
        i = lower.indexOf(e.value, i + e.value.length);
      }
    }
    const hexDeny = deny.filter((e) => e.kind === "hex");
    if (hexDeny.length) {
      for (const m of text.matchAll(TRUNCATED)) {
        const [pre, post] = [m[1].toLowerCase(), m[2].toLowerCase()];
        for (const e of hexDeny) if (e.value.startsWith(pre) && e.value.endsWith(post)) fail("denylist", at(m.index), `${name(e)}, truncated`);
      }
      for (const m of text.matchAll(PREFIX)) {
        const pre = m[1].toLowerCase();
        for (const e of hexDeny) if (e.value.startsWith(pre)) fail("denylist", at(m.index), `${name(e)}, a prefix of it`);
      }
    }
    if (binary) continue;

    // Unknown hex.
    if (!pin) {
      const seen = new Map();
      for (const m of text.matchAll(HEX_RUN)) {
        const prefixed = !!m[1];
        const run = m[2].toLowerCase();
        if (!prefixed && (m[3] || /^[0-9]+$/.test(run))) continue; // part of a word, or a decimal number
        for (const v of hexValues(run)) {
          if (denied.has(v)) continue;
          const direct = hexAllowed.get(v);
          const padded = v.length === 64 && v.startsWith("0".repeat(24)) ? hexAllowed.get(v.slice(24)) : undefined;
          if (direct) { direct.seen = true; continue; }
          if (padded) { padded.seen = true; continue; }
          if (synthetic(v)) continue;
          if (![...denied].some((d) => v.includes(d)) && !seen.has(v)) seen.set(v, m.index);
        }
      }
      for (const [v, i] of seen) fail("unknown hex", at(i), `0x${v} (${v.length} hex) is on no allowlist`);
    }

    // Personal data, line by line.
    const lines = text.split("\n");
    lines.forEach((line, n) => {
      const where = `${path}:${n + 1}`;
      const excuse = reviewed.findIndex((r) => r.file === path && line.includes(r.text));
      if (excuse >= 0) { usedLines.add(excuse); return; }
      if (HOME_PATH.test(line)) fail("personal", where, "a home-directory path");
      if (KEY_BLOCK.test(line)) fail("personal", where, "a key block (a PEM BEGIN line)");
      const s = line.match(SECRET);
      if (s && !/^(<.*>|\$\{?[A-Z_]+\}?|\.\.\.|…)$/.test(s[2])) fail("personal", where, `${s[1]}= has a value`);
      for (const m of line.matchAll(EMAIL)) {
        const domain = m[1];
        if (PLACEHOLDER_DOMAIN.test(domain) || /^\d+x\./.test(domain) || /^no-?reply@|noreply\./i.test(m[0])) continue;
        fail("personal", where, `an email address (${m[0]})`);
      }
      for (const m of line.matchAll(IPV4)) {
        const q = m.slice(1, 5).map(Number);
        if (q.some((x) => x > 255) || reservedIp(q)) continue;
        fail("personal", where, `a public IP address (${m[0]})`);
      }
    });

    // What the file needs.
    if (SOURCE.test(path)) {
      for (const re of SPECIFIERS) {
        for (const m of text.matchAll(re)) {
          if (resolveIn(files, path, m[2])) continue;
          const target = posix.normalize(posix.join(posix.dirname(path), m[2]));
          const opt = optional.findIndex((o) => o.from === path && o.needs === target);
          if (opt >= 0) { usedOptional.add(opt); continue; }
          fail("closure", at(m.index), `needs ${m[2]}, which is not published`);
        }
      }
    }
  }

  // ---- npm scripts name only published files
  if (files.has("package.json")) {
    let pkg = null;
    try { pkg = JSON.parse(files.get("package.json").toString("utf8")); } catch { fail("closure", "package.json", "not JSON"); }
    for (const [script, cmd] of Object.entries(pkg?.scripts ?? {})) {
      for (const p of scriptMissing(String(cmd), files)) fail("closure", "package.json", `script "${script}" names ${p}, which is not published`);
    }
  }

  // ---- git
  if (t.git) {
    const status = git(t.git, "status", "--porcelain");
    if (status.trim()) fail("git", t.git, `uncommitted changes, so the check did not see what would be published:\n      ${status.trim().split("\n").slice(0, 5).join("\n      ")}`);
    const log = git(t.git, "log", "--all", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e");
    for (const rec of log.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
      const [sha, an, ae, cn, ce, body] = rec.split("\0");
      const where = `commit ${sha.slice(0, 12)}`;
      for (const [who, email] of [["author", ae], ["committer", ce]]) {
        const good = identity ? email.toLowerCase() === identity.toLowerCase() : /noreply/i.test(email);
        if (!good) fail("git", where, `${who} email ${email} is not ${identity ?? "a noreply address"}`);
      }
      const lowered = `${an}\n${cn}\n${body}`.toLowerCase();
      for (const e of deny) if (lowered.includes(e.value)) fail("denylist", where, name(e));
      for (const m of (body ?? "").matchAll(EMAIL)) {
        if (!PLACEHOLDER_DOMAIN.test(m[1]) && !/noreply/i.test(m[0])) fail("git", where, `an email address in the message (${m[0]})`);
      }
    }
  }

  // ---- allowlist entries nothing uses are stale, and should go
  for (const [v, a] of hexAllowed) if (!a.seen) warn("allowlist", ALLOW_FILE, `${a.group}: 0x${v} is not in the tree`);
  for (const p of pins.keys()) if (!files.has(p)) warn("allowlist", ALLOW_FILE, `files: ${p} is not in the tree`);
  reviewed.forEach((r, i) => { if (!r.self && !usedLines.has(i)) warn("allowlist", ALLOW_FILE, `lines: "${r.text}" is not in ${r.file}`); });
  optional.forEach((o, i) => { if (!usedOptional.has(i)) warn("list", LIST_FILE, `optional: ${o.from} no longer needs ${o.needs}`); });

  return { failures, warnings };
}

// ------------------------------------------------------------------- the CLI --

function main(argv) {
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes(n);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !["--ref", "--denylist", "--identity"].includes(argv[i - 1]));

  let tree;
  try {
    if (has("--ref") || has("--worktree")) tree = fromRepo({ ref: has("--ref") ? flag("--ref") : null });
    else if (positional[0]) tree = fromDir(positional[0]);
    else {
      console.error("usage: check-publish.mjs <dir> | --ref <ref> | --worktree  [--denylist <file>] [--identity <email>] [--list]");
      return 2;
    }
  } catch (e) {
    console.error(`check-publish: ${e.message}`);
    return 1;
  }
  if (has("--list")) {
    for (const p of tree.files.keys()) console.log(p);
    return 0;
  }

  const denylist = loadDenylist(flag("--denylist") ?? process.env.CLANK_PUBLISH_DENYLIST, { allowEmpty: has("--allow-empty-denylist") });
  const identity = flag("--identity") ?? process.env.CLANK_PUBLISH_IDENTITY ?? null;
  const { failures, warnings } = check(tree, { denylist, identity });

  const total = [...tree.files.values()].reduce((n, b) => n + b.length, 0);
  console.log(`check-publish: ${tree.label}: ${tree.files.size} files, ${(total / 1024).toFixed(0)} KB` +
    (tree.repoFiles ? `, ${tree.repoFiles.length - tree.files.size} of the repository's files left out` : "") +
    `, denylist ${denylist.entries ? `${denylist.entries.length} entries` : "missing"}`);
  for (const w of warnings) console.log(`  \x1b[33mwarn\x1b[0m  ${w.kind.padEnd(12)} ${w.where}  ${w.what}`);
  for (const f of failures) console.log(`  \x1b[31mFAIL\x1b[0m  ${f.kind.padEnd(12)} ${f.where}  ${f.what}`);
  const kinds = Object.entries(failures.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] ?? 0) + 1 }), {}));
  console.log(failures.length
    ? `\x1b[31mcheck-publish: ${failures.length} failure(s)\x1b[0m: ${kinds.map(([k, n]) => `${k} ${n}`).join(", ")}`
    : "\x1b[32mcheck-publish: nothing to stop publishing\x1b[0m");
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
