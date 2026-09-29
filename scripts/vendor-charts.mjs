// Build the token page's vendored chart library (docs/specs/tv-candlestick-chart.md, TV0).
//
//   npm run vendor:charts            build, check, and write the three files
//   npm run vendor:charts -- --check build in memory and compare with the committed files
//
// scripts/vendor/charts-entry.js and lightweight-charts, with fancy-canvas, become one ES module:
//
//   src/web/public/vendor/charts.js                 the bundle
//   src/web/public/vendor/charts.js.sha256          its hash, as sha256sum writes it
//   src/web/public/vendor/charts.LICENSES.txt       every bundled package's licence, and TradingView's notice
//
// It fails, and writes nothing, on the same rules as scripts/vendor-wallet.mjs:
// over budget (80 KB gzipped), any code from strings, or a package with no licence.
// It also fails if the bundle writes HTML from a string anywhere but in the
// attribution logo, which the page turns off (`attributionLogo: false`).
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evalUses, gzipBytes, installed, licences, sha256 } from "./vendor-wallet.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const ENTRY = join(REPO, "scripts", "vendor", "charts-entry.js");
export const OUT_DIR = join(REPO, "src", "web", "public", "vendor");
export const FILES = { bundle: "charts.js", hash: "charts.js.sha256", licences: "charts.LICENSES.txt" };
export const LIB = "lightweight-charts";
/** At most 80 KB gzipped (1 KB = 1,000 bytes). */
export const BUDGET_GZIP_BYTES = 80_000;

/**
 * TradingView's attribution notice. The licence asks for it, with a link to
 * tradingview.com, on the page (README, "License"). npm ships no NOTICE file,
 * so its text is here, as in the v5.2.1 tag.
 */
export const NOTICE = "TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/";

/** HTML written from a string. The attribution logo's one use is allowed, because the page turns the logo off. */
const HTML_SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/g;
export function htmlSinks(code) {
  const out = [];
  for (const m of code.matchAll(HTML_SINKS)) {
    const around = code.slice(Math.max(0, m.index - 200), m.index + 60);
    if (m[1] === "innerHTML" && around.includes('"tv-attr-logo"')) continue;
    out.push(code.slice(Math.max(0, m.index - 60), m.index + 40));
  }
  return out;
}

export async function bundle() {
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    charset: "utf8",
    sourcemap: false,
    conditions: ["production"],
    banner: {
      js: `/* ${LIB} ${installed(LIB)} (TradingView Lightweight Charts™, Apache-2.0), built by scripts/vendor-charts.mjs from scripts/vendor/charts-entry.js. Licences and notice: charts.LICENSES.txt. Do not edit: rebuild. */`,
    },
    logLevel: "silent",
    absWorkingDir: REPO,
  });
  if (out.errors.length) throw new Error(out.errors.map((e) => e.text).join("\n"));
  return { code: Buffer.from(out.outputFiles[0].contents), metafile: out.metafile };
}

export async function make() {
  const { code, metafile } = await bundle();
  const gz = gzipBytes(code);
  const text = code.toString("utf8");
  const problems = [];
  if (gz > BUDGET_GZIP_BYTES) problems.push(`over budget: ${gz} bytes gzipped, the limit is ${BUDGET_GZIP_BYTES}`);
  const evals = evalUses(text, FILES.bundle);
  if (evals.length) problems.push(`code from strings, which the page's policy forbids:\n    ${evals.join("\n    ")}`);
  const sinks = htmlSinks(text);
  if (sinks.length) problems.push(`HTML written from a string, which Trusted Types refuses:\n    ${sinks.join("\n    ")}`);
  const lic = licences(metafile, {}, { file: FILES.bundle, by: "scripts/vendor-charts.mjs" });
  if (lic.missing.length) problems.push(`no licence for ${lic.missing.join(", ")}`);
  const licencesText = lic.text + "\n" + "=".repeat(78) + "\nNOTICE (TradingView's attribution notice)\n" + "=".repeat(78) + "\n" + NOTICE + "\n";
  const hash = sha256(code);
  return {
    code, gz, hash, problems, licencesText, hashLine: `${hash}  ${FILES.bundle}\n`,
    sections: lic.count, exports: Object.values(metafile.outputs)[0].exports.slice().sort(),
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
  console.log(`vendor-charts: ${LIB} ${installed(LIB)}, esbuild ${installed("esbuild")}`);
  console.log(`  ${m.sections} licence sections; exports ${m.exports.join(", ")}`);
  console.log(`  ${kb(m.code.length)} minified, ${kb(m.gz)} gzipped (budget ${kb(BUDGET_GZIP_BYTES)})`);
  console.log(`  sha256 ${m.hash}`);
  if (m.problems.length) {
    console.error(`vendor-charts: refused, nothing written:\n  - ${m.problems.join("\n  - ")}`);
    process.exit(1);
  }
  const files = [[FILES.bundle, m.code], [FILES.hash, Buffer.from(m.hashLine)], [FILES.licences, Buffer.from(m.licencesText)]];
  if (check) {
    const stale = files.filter(([name, want]) => { const got = read(name); return !got || !got.equals(want); }).map(([name]) => name);
    if (stale.length) {
      console.error(`vendor-charts: the committed files differ from a fresh build: ${stale.join(", ")}. Run npm run vendor:charts and review the diff.`);
      process.exit(1);
    }
    console.log("vendor-charts: the committed files are exactly a fresh build");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, buf] of files) writeFileSync(join(OUT_DIR, name), buf);
  console.log(`vendor-charts: wrote src/web/public/vendor/{${Object.values(FILES).join(",")}}`);
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  await main();
}
