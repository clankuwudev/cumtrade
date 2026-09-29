// What a hosted release and a gateway release share (public-release H1, X18).
//
// Both are built on the operator's machine from a commit, never from the
// working tree: the files are read through git, only what the entries reach
// is compiled, production packages are installed from the lockfile, and the
// result is checked before it is packed. release-hosted.mjs adds the page and
// the static files; release-gateway.mjs adds the price book.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const posix = (p) => p.split(sep).join("/");

/** Every path under a directory, relative and with forward slashes. */
export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(posix(relative(base, p)));
  }
  return out;
}

/**
 * Every blob under `paths` at `sha`, written into `tree`, read through git
 * itself. No tar: Git Bash's tar takes "C:" for a remote host. Each path must
 * be in the commit.
 */
export function readCommit({ repo, sha, paths, tree, fail }) {
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
  const files = git("ls-tree", "-r", "-z", "--format=%(objectname) %(path)", sha, "--", ...paths)
    .split("\0").filter(Boolean).map((line) => {
      const i = line.indexOf(" ");
      return { oid: line.slice(0, i), path: line.slice(i + 1) };
    });
  for (const p of paths) if (!files.some((f) => f.path === p || f.path.startsWith(`${p}/`))) fail(`${p} is not in ${sha}`);
  for (const { oid, path } of files) {
    const dest = join(tree, ...path.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, execFileSync("git", ["cat-file", "blob", oid], { cwd: repo, maxBuffer: 1 << 28 }));
  }
}

/**
 * Compile exactly what `roots` reach into `out/src`. It fails on a type error,
 * and on any reached source under a `forbidden` directory of src/: type-only
 * imports count, since a type from src/self/ is the design leaking.
 */
export function compile({ tree, out, sha, roots, forbidden, who, fail }) {
  const SRC = join(tree, "src") + sep;
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(tree, "tsconfig.json"), ts.sys.readFile).config, ts.sys, tree);
  const program = ts.createProgram({
    rootNames: roots.map((r) => join(tree, ...r.split("/"))),
    options: {
      ...parsed.options, noEmit: false, outDir: join(out, "src"), rootDir: join(tree, "src"),
      declaration: false, sourceMap: false, listEmittedFiles: true,
    },
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    fail(`type errors in ${sha}:\n${ts.formatDiagnostics(errors, {
      getCanonicalFileName: (f) => f, getCurrentDirectory: () => tree, getNewLine: () => "\n",
    })}`);
  }
  const reached = program.getSourceFiles().map((s) => resolve(s.fileName));
  for (const dir of forbidden) {
    const abs = join(tree, "src", ...dir.split("/")) + sep;
    const bad = reached.filter((f) => f.startsWith(abs));
    if (bad.length) fail(`${who}'s program reaches src/${dir}/:\n  ${bad.map((f) => posix(relative(tree, f))).join("\n  ")}`);
  }
  const emitted = program.emit();
  if (emitted.emitSkipped) fail("the compiler skipped emit");
  const js = (emitted.emittedFiles ?? []).map((f) => posix(relative(out, resolve(f))));
  for (const dir of forbidden) if (js.some((f) => f.startsWith(`src/${dir}/`))) fail(`emitted a file under src/${dir}/`);
  return { js, reached: reached.filter((f) => f.startsWith(SRC)).length };
}

/**
 * Production packages from the lockfile, then the release's checks: no dev
 * dependency, no native module, no env file, nothing under a forbidden
 * directory, no TypeScript source. Returns package.json.
 */
export function installAndCheck({ tree, out, forbidden, who, fail }) {
  cpSync(join(tree, "package.json"), join(out, "package.json"));
  cpSync(join(tree, "package-lock.json"), join(out, "package-lock.json"));
  const npm = (...a) => execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", a, {
    cwd: out, stdio: "pipe", encoding: "utf8", shell: process.platform === "win32",
  });
  // --omit=optional as well: typescript is devOptional, a dev dependency that is
  // also an optional peer of viem, ox and abitype, and --omit=dev alone keeps it.
  // No production package is optional.
  const install = ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    npm(...install, "--offline");
  } catch {
    console.log(`${who}: not all packages are in the npm cache, fetching the locked versions`);
    npm(...install, "--prefer-offline");
  }
  // Command shims are never run on a server, and Windows ones are useless there.
  for (const p of walk(join(out, "node_modules")).filter((f) => f.includes(".bin/"))) {
    rmSync(join(out, "node_modules", ...p.split("/")), { force: true });
  }
  const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
  const devTop = Object.keys(pkg.devDependencies ?? {}).filter((d) => existsSync(join(out, "node_modules", ...d.split("/"))));
  if (devTop.length) fail(`dev dependencies in node_modules: ${devTop.join(", ")}`);
  const all = walk(out);
  const native = all.filter((f) => f.endsWith(".node"));
  if (native.length) fail(`native modules would not run on the server: ${native.join(", ")}`);
  const envs = all.filter((f) => /(^|\/)\.env/.test(f));
  if (envs.length) fail(`env files in the release: ${envs.join(", ")}`);
  for (const dir of forbidden) if (all.some((f) => f.startsWith(`src/${dir}/`))) fail(`a file under src/${dir}/ is in the release`);
  if (all.some((f) => f.endsWith(".ts") && f.startsWith("src/"))) fail("TypeScript source is in the release");
  return pkg;
}

/** RELEASE.json, then the tarball; the build directory goes, and the unpacked release unless kept. */
export function finish({ out, outRoot, build, tarball, meta, keep }) {
  writeFileSync(join(out, "RELEASE.json"), JSON.stringify(meta, null, 2) + "\n");
  rmSync(tarball, { force: true });
  // Windows' own bsdtar understands drive letters. Everywhere else, tar.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-czf", tarball, "-C", out, "."], { stdio: "pipe" });
  rmSync(build, { recursive: true, force: true });
  rmSync(join(outRoot, ".build"), { recursive: true, force: true });
  if (!keep) rmSync(out, { recursive: true, force: true });
}
