// Build the trading wallet's vendored SDK — public-release W1.1.
//
//   npm run vendor:wallet            build, check, and write the three files
//   npm run vendor:wallet -- --check build in memory and compare with the committed files
//
// scripts/vendor/wallet-entry.js (our facade) and @coinbase/cdp-core, with
// everything it imports, become one ES module:
//
//   src/web/public/vendor/wallet.js          the bundle
//   src/web/public/vendor/wallet.js.sha256   its hash, as sha256sum writes it
//   src/web/public/vendor/LICENSES.txt       every bundled package's licence
//
// It fails, and writes nothing, when:
//   - the bundle is over TW10's budget, 300 KB gzipped;
//   - the bundle names eval, the Function constructor, a string-bodied timer or
//     WebAssembly compilation. The page's policy allows no 'unsafe-eval' and no
//     'wasm-unsafe-eval', and adding either is the user's decision;
//   - a bundled package has no licence and is not one of the two named in
//     NO_LICENCE_DECLARED (Coinbase's own, which declare none).
//
// Both packages are exact-pinned dev dependencies, so the same lockfile gives
// the same bytes. An SDK upgrade is a reviewed diff of all three files.
import { build } from "esbuild";
import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const ENTRY = join(REPO, "scripts", "vendor", "wallet-entry.js");
export const OUT_DIR = join(REPO, "src", "web", "public", "vendor");
export const FILES = { bundle: "wallet.js", hash: "wallet.js.sha256", licences: "LICENSES.txt" };

/** TW10: at most 300 KB gzipped, in bytes (1 KB = 1,000 bytes, the stricter reading). */
export const BUDGET_GZIP_BYTES = 300_000;
/** The SDK the facade is built against. package.json pins it; this says which one the files came from. */
export const SDK = "@coinbase/cdp-core";

const posix = (p) => p.split("\\").join("/");

/** The pinned version of a package, as installed. */
export function installed(name) {
  return JSON.parse(readFileSync(join(REPO, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
}

/**
 * The SDK imports `createStore` from "zustand", whose root also exports the
 * React binding, and React is not installed (the SDK does not depend on it).
 * `createStore` is zustand's framework-free half, so the root is pointed at
 * "zustand/vanilla" and no React code can enter the bundle.
 */
const zustandVanilla = {
  name: "zustand-vanilla",
  setup(b) {
    b.onResolve({ filter: /^zustand$/ }, async (args) => {
      const r = await b.resolve("zustand/vanilla", { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer });
      return r.errors.length ? { errors: r.errors } : { path: r.path };
    });
  },
};

/** The bundle, in memory, and the files it was made from. */
export async function bundle() {
  const out = await build({
    entryPoints: [ENTRY],
    plugins: [zustandVanilla],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    // Licences go to LICENSES.txt, whole, rather than scattered comments.
    legalComments: "none",
    charset: "utf8",
    sourcemap: false,
    // React's production build, which the SDK imports for a side effect, and
    // not its development build. Nothing else reads the environment.
    define: { "process.env.NODE_ENV": '"production"' },
    banner: {
      js: `/* clankchan's trading-wallet facade over ${SDK} ${installed(SDK)}, built by scripts/vendor-wallet.mjs from scripts/vendor/wallet-entry.js. Licences: LICENSES.txt. Do not edit: rebuild. */`,
    },
    logLevel: "silent",
    absWorkingDir: REPO,
  });
  if (out.errors.length) throw new Error(out.errors.map((e) => e.text).join("\n"));
  return { code: Buffer.from(out.outputFiles[0].contents), metafile: out.metafile };
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
/** Gzipped size at zlib's default level, which is close to what a server sends. */
export const gzipBytes = (buf) => gzipSync(buf).length;

// --------------------------------------------------------------- no eval --

const GLOBALS = new Set(["globalThis", "window", "self", "global", "frames", "parent", "top"]);
const WASM_COMPILE = new Set(["compile", "compileStreaming", "instantiate", "instantiateStreaming", "Module"]);

/**
 * Every use of code-from-strings in `code`, found in its syntax tree so that
 * a string or comment that merely mentions one cannot trip it:
 * `eval` referenced at all, `eval` read off a global, the Function
 * constructor, a timer with a string body, and WebAssembly compilation.
 */
export function evalUses(code, name = "bundle.js") {
  const sf = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const at = (n) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${line + 1}:${character + 1}`;
  };
  const flag = (n, why) => found.push(`${at(n)}  ${why}: ${n.getText(sf).slice(0, 80)}`);
  const isGlobal = (e) => ts.isIdentifier(e) && GLOBALS.has(e.text);
  const keyOf = (n) => (ts.isPropertyAccessExpression(n) ? n.name.text
    : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : null);
  const isStringy = (a) => a && (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a) || ts.isBinaryExpression(a));

  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === "eval") {
      const p = n.parent;
      // A property named eval (`x.eval`, `{ eval: … }`) is not the global.
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertySignature?.(p) && p.name === n);
      if (!isName) flag(n, "eval");
    }
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isGlobal(n.expression)) {
      const key = keyOf(n);
      if (key === "eval") flag(n, "eval read off a global");
      if (key === "Function") flag(n, "the Function constructor read off a global");
    }
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "Function") {
      flag(n, "the Function constructor");
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : keyOf(callee);
      if ((name === "setTimeout" || name === "setInterval") && isStringy(n.arguments[0])) {
        flag(n, `${name} with a string body`);
      }
    }
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && WASM_COMPILE.has(keyOf(n) ?? "")) {
      const obj = n.expression;
      const isWasm = (ts.isIdentifier(obj) && obj.text === "WebAssembly")
        || ((ts.isPropertyAccessExpression(obj) || ts.isElementAccessExpression(obj)) && keyOf(obj) === "WebAssembly");
      if (isWasm) flag(n, "WebAssembly compilation (needs 'wasm-unsafe-eval')");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// -------------------------------------------------------------- licences --

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/**
 * Bundled packages that declare no licence at all: no license field, no
 * licence file, and no public source repository. Each is named here with the
 * terms that cover it, and LICENSES.txt says so. Any other package without a
 * licence fails the build, and so does an entry here that no longer applies.
 */
export const NO_LICENCE_DECLARED = {
  "@coinbase/cdp-core": "Coinbase publishes this package with no licence. Its use is governed by the Coinbase Developer Platform terms (https://www.coinbase.com/legal/developer-platform/terms-of-service), which the operator accepts when creating the CDP project.",
  "@coinbase/cdp-api-client": "Coinbase publishes this package with no licence. Its use is governed by the Coinbase Developer Platform terms (https://www.coinbase.com/legal/developer-platform/terms-of-service), which the operator accepts when creating the CDP project.",
};

/**
 * Code that @coinbase/cdp-core's own files carry inline, without its notices:
 * React's production build (imported for a side effect), zustand's persist
 * middleware and parts of jose. zustand's and jose's texts are read from their
 * installed packages; React is not installed, so its MIT text is here.
 */
const INLINED_IN_SDK = [
  { name: "react", note: "React 19's production build, inlined in @coinbase/cdp-core's files", text: [
    "MIT License", "", "Copyright (c) Meta Platforms, Inc. and affiliates.", "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:", "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.", "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n") },
  { name: "zustand", note: "zustand's persist middleware, inlined in @coinbase/cdp-core's files", file: ["zustand", "LICENSE"] },
  { name: "jose", note: "parts of jose (JWT signing), inlined in @coinbase/cdp-core's files", file: ["jose", "LICENSE.md"] },
];

/** The package directory a bundled file came from, e.g. node_modules/@a/b or node_modules/x/node_modules/y. */
function packageDirOf(input) {
  const parts = posix(input).split("/");
  let end = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "node_modules") end = parts[i + 1]?.startsWith("@") ? i + 2 : i + 1;
  }
  return end < 0 ? null : parts.slice(0, end + 1).join("/");
}

/**
 * One section per bundled package: its name, version, licence field and every
 * licence file it ships. Sorted by name and version, so the file is stable.
 * A package with neither is in `missing`, unless NO_LICENCE_DECLARED names it;
 * an entry there that matches no such package is in `stale`. `file` and `by`
 * name the bundle and its build in the text (the keystore has its own, P2c).
 */
export function licences(metafile, exceptions = NO_LICENCE_DECLARED, { file = FILES.bundle, by = "scripts/vendor-wallet.mjs" } = {}) {
  // What reached the output, not everything esbuild read: a module that was
  // tree-shaken to nothing ships nothing.
  const dirs = new Set();
  for (const out of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(out.inputs)) {
      const d = bytesInOutput > 0 ? packageDirOf(input) : null;
      if (d) dirs.add(d);
    }
  }
  const rows = [];
  const missing = [];
  const used = new Set();
  const seen = new Set();
  for (const dir of [...dirs].sort()) {
    const abs = join(REPO, ...dir.split("/"));
    const pkg = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
    // Nested copies of one version are one package.
    if (seen.has(`${pkg.name}@${pkg.version}`)) continue;
    seen.add(`${pkg.name}@${pkg.version}`);
    const field = typeof pkg.license === "string" ? pkg.license
      : pkg.license && typeof pkg.license.type === "string" ? pkg.license.type : null;
    const texts = readdirSync(abs).filter((f) => LICENCE_FILE.test(f)).sort()
      .map((f) => readFileSync(join(abs, f), "utf8").replace(/\r\n/g, "\n").trimEnd());
    if (!field && texts.length === 0) {
      if (Object.hasOwn(exceptions, pkg.name)) {
        used.add(pkg.name);
        texts.push(exceptions[pkg.name]);
      } else {
        missing.push(`${pkg.name}@${pkg.version}`);
      }
    }
    rows.push({ name: pkg.name, version: pkg.version, field, texts });
  }
  const stale = Object.keys(exceptions).filter((name) => !used.has(name));
  rows.sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
  const sdk = rows.some((r) => r.name === SDK);
  if (sdk) {
    for (const x of INLINED_IN_SDK) {
      const text = x.text ?? readFileSync(join(REPO, "node_modules", ...x.file), "utf8").replace(/\r\n/g, "\n").trimEnd();
      rows.push({ name: `${x.name} (${x.note})`, version: "", field: "MIT", texts: [text] });
    }
  }
  const head = [
    `Third-party software in ${file}, bundled by ${by}.`,
    ...(sdk ? [
      `${rows.length} sections: each bundled package's own licence field and files, then`,
      `the code ${SDK} carries inline in its own files.`,
    ] : [`${rows.length} sections: each bundled package's own licence field and files.`]),
    "",
  ];
  const body = rows.map((r) => [
    "=".repeat(78),
    r.version ? `${r.name}@${r.version}` : r.name,
    `License: ${r.field ?? "(none declared)"}`,
    "=".repeat(78),
    r.texts.length ? r.texts.join("\n\n" + "-".repeat(78) + "\n\n") : "(The package ships no licence file. Its license field is above.)",
    "",
  ].join("\n"));
  return { text: [...head, ...body].join("\n").trimEnd() + "\n", count: rows.length, missing, stale };
}

// ------------------------------------------------------------------ run --

/** Build everything and check it. Throws on any failed rule, with nothing written. */
export async function make() {
  const { code, metafile } = await bundle();
  const gz = gzipBytes(code);
  const problems = [];
  if (gz > BUDGET_GZIP_BYTES) {
    problems.push(`over TW10's budget: ${gz.toLocaleString("en-US")} bytes gzipped, the limit is ${BUDGET_GZIP_BYTES.toLocaleString("en-US")}`);
  }
  const evals = evalUses(code.toString("utf8"));
  if (evals.length) problems.push(`code from strings, which the page's policy forbids:\n    ${evals.join("\n    ")}`);
  const lic = licences(metafile);
  if (lic.missing.length) problems.push(`no licence for ${lic.missing.join(", ")}`);
  if (lic.stale.length) problems.push(`NO_LICENCE_DECLARED names packages that now declare one, or are no longer bundled: ${lic.stale.join(", ")}`);
  const hash = sha256(code);
  return {
    code, gz, hash, evals, problems,
    hashLine: `${hash}  ${FILES.bundle}\n`,
    licencesText: lic.text, sections: lic.count, missing: lic.missing, stale: lic.stale,
    inputs: Object.keys(metafile.inputs).length,
    exports: Object.values(metafile.outputs)[0].exports.slice().sort(),
  };
}

const read = (name) => {
  const p = join(OUT_DIR, name);
  return existsSync(p) ? readFileSync(p) : null;
};

async function main() {
  const check = process.argv.includes("--check");
  const m = await make();
  const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
  console.log(`vendor-wallet: ${SDK} ${installed(SDK)}, esbuild ${installed("esbuild")}`);
  console.log(`  ${m.inputs} source files read; ${m.sections} licence sections; exports ${m.exports.join(", ")}`);
  console.log(`  ${kb(m.code.length)} minified, ${kb(m.gz)} gzipped (budget ${kb(BUDGET_GZIP_BYTES)})`);
  console.log(`  sha256 ${m.hash}`);
  if (m.problems.length) {
    console.error(`vendor-wallet: refused, nothing written:\n  - ${m.problems.join("\n  - ")}`);
    process.exit(1);
  }
  if (check) {
    const stale = [
      [FILES.bundle, m.code], [FILES.hash, Buffer.from(m.hashLine)], [FILES.licences, Buffer.from(m.licencesText)],
    ].filter(([name, want]) => { const got = read(name); return !got || !got.equals(want); }).map(([name]) => name);
    if (stale.length) {
      console.error(`vendor-wallet: the committed files differ from a fresh build: ${stale.join(", ")}. Run npm run vendor:wallet and review the diff.`);
      process.exit(1);
    }
    console.log("vendor-wallet: the committed files are exactly a fresh build");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, FILES.bundle), m.code);
  writeFileSync(join(OUT_DIR, FILES.hash), m.hashLine);
  writeFileSync(join(OUT_DIR, FILES.licences), m.licencesText);
  console.log(`vendor-wallet: wrote ${posix(join("src", "web", "public", "vendor"))}/{${Object.values(FILES).join(",")}}`);
}

// Run, unless imported by the test.
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  await main();
}
