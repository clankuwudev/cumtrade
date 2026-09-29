// Structural invariants for the console's client code.
//
// app.js used to state its XSS defence in a comment: every interpolation is
// escaped, the only escape hatch is markup built by the `html` tag, and nothing
// writes HTML strings into the DOM. A comment enforces nothing. This walks the
// syntax tree of every client module — not the text, so a string or comment
// that merely mentions `innerHTML` cannot trip it — and fails on:
//
//   - reading or writing innerHTML / outerHTML, insertAdjacentHTML, document.write
//   - eval, the Function constructor, and string-bodied setTimeout / setInterval
//   - constructing `Raw` anywhere but core/dom.js, or exporting it at all
//   - eth_sendTransaction outside trade/sequence.js (the one door that sends)
//     and wallet/embedded.js (the trading wallet's signer behind it), and
//     window.ethereum outside wallet/eip6963.js
//   - importing anything under vendor/ (Coinbase's bundled SDK, W1.1) from
//     any module but wallet/embedded.js, from js/, ai/ or landing/; any
//     specifier that is not a plain relative path to a .js file (P2e, 8); and
//     a dynamic import() whose specifier is not a plain string, which this
//     check could not follow
//
// The vendored bundle itself lives outside js/, so none of these rules walk
// it: it is minified third-party code, and its guarantee is its pinned hash
// (scripts/vendor-wallet.mjs).
//
//   node scripts/check-web.mjs
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The site's public directory: src/web/public/, or the one named on the command line (the test's copy). */
const PUBLIC = process.argv[2] ? process.argv[2].replace(/[\\/]?$/, "/") : fileURLToPath(new URL("../src/web/public/", import.meta.url));
const ROOT = PUBLIC + "js/";

/** Modules allowed to name eth_sendTransaction: the door, and the trading wallet's signer. */
const SENDERS = new Set(["trade/sequence.js", "wallet/embedded.js"]);
/** Each vendored bundle, and the one module allowed to import it. */
const VENDOR_IMPORTERS = { "vendor/wallet.js": "wallet/embedded.js", "vendor/charts.js": "pages/tokenChart.js" };
/** The other pages' code, walked for the import rules only (P2e, 8): it may not reach a vendored bundle. */
const OTHER_ROOTS = ["ai", "landing"].map((d) => `${PUBLIC}${d}/`);
/**
 * The one shape a specifier may take: a plain relative path to a .js file
 * (P2e, 8). Anything else could name a module past the rules below: a URL to
 * this origin, a protocol-relative one, a backslash, a percent-escape, a query
 * or a hash, /v/<sha>/, data:. Every import in the site already has this shape.
 *
 * These rules guard against our own mistakes. They are not a boundary: any
 * script running on the origin can import any module at run time (finding 1).
 */
const PLAIN = /^\.{1,2}\/[A-Za-z0-9_./-]+\.js$/;
const DISGUISED = (spec) => !PLAIN.test(spec);

/**
 * Where an import specifier points, relative to src/web/public/ ("js/…" or
 * "vendor/…"), or null for a bare name. `rel` is the importer, relative to js/.
 */
function target(rel, spec) {
  if (spec.startsWith("/")) return posix.normalize(spec.slice(1));
  if (spec.startsWith("./") || spec.startsWith("../")) return posix.normalize(posix.join("js", posix.dirname(rel), spec));
  return null;
}

const walkFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walkFiles(p) : name.endsWith(".js") ? [p] : [];
});

const findings = [];
for (const file of walkFiles(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const at = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const flag = (n, why) => findings.push(`${at(n)}  ${why}`);

  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (name === "innerHTML" || name === "outerHTML") flag(n, `.${name} — render through html\`\` and paint() instead`);
      if (name === "insertAdjacentHTML") flag(n, ".insertAdjacentHTML — render through html`` and paint() instead");
      if (name === "write" && n.expression.getText(sf) === "document") flag(n, "document.write");
      if (name === "ethereum" && n.expression.getText(sf) === "window" && rel !== "wallet/eip6963.js") {
        flag(n, "window.ethereum outside wallet/eip6963.js");
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (callee === "eval") flag(n, "eval");
      if ((callee === "setTimeout" || callee === "setInterval") && n.arguments[0] &&
          (ts.isStringLiteral(n.arguments[0]) || ts.isTemplateExpression(n.arguments[0]) ||
           ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) {
        flag(n, `${callee} with a string body — equivalent to eval`);
      }
    }
    if (ts.isNewExpression(n)) {
      const callee = n.expression.getText(sf);
      if (callee === "Function") flag(n, "the Function constructor — equivalent to eval");
      if (callee === "Raw" && rel !== "core/dom.js") flag(n, "Raw constructed outside core/dom.js — only html`` may mark markup as safe");
    }
    if (ts.isStringLiteralLike(n) && n.text === "eth_sendTransaction" && !SENDERS.has(rel)) {
      flag(n, "eth_sendTransaction outside trade/sequence.js and wallet/embedded.js");
    }
    // Every module specifier: static imports, re-exports and import().
    let spec = null;
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      spec = n.moduleSpecifier.text;
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) spec = n.arguments[0].text;
      else flag(n, "import() with a computed specifier — this check cannot see where it points");
    }
    if (spec !== null && DISGUISED(spec)) {
      flag(n, `imports ${spec} — only a plain relative path to a .js file may be imported`);
    } else if (spec !== null) {
      const to = target(rel, spec);
      if (to !== null && (to === "vendor" || to.startsWith("vendor/") || to.startsWith("../"))
          && !(Object.hasOwn(VENDOR_IMPORTERS, to) && VENDOR_IMPORTERS[to] === rel)) {
        const pairs = Object.entries(VENDOR_IMPORTERS).map(([bundle, mod]) => `${mod} for ${bundle}`).join(", ");
        flag(n, `imports ${spec} — a vendored bundle has one importer each: ${pairs}`);
      }
    }
    if (ts.isClassDeclaration(n) && n.name?.text === "Raw" &&
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      flag(n, "Raw is exported — anything able to construct it can bypass escaping");
    }
    if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === "Raw") {
      flag(n, "Raw is re-exported — anything able to construct it can bypass escaping");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// cumAI's and the landing's own modules: no vendored bundle.
for (const root of OTHER_ROOTS) {
  for (const file of walkFiles(root)) {
    const rel = relative(PUBLIC, file).split(sep).join("/");
    const sf = ts.createSourceFile(rel, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (n) => {
      let spec = null;
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) spec = n.arguments[0].text;
      if (spec !== null && DISGUISED(spec)) {
        findings.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  imports ${spec} — only a plain relative path to a .js file may be imported`);
      } else if (spec !== null && (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))) {
        const to = spec.startsWith("/") ? posix.normalize(spec.slice(1)) : posix.normalize(posix.join(posix.dirname(rel), spec));
        if (to === "vendor" || to.startsWith("vendor/")) {
          findings.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  imports ${spec} — no page but the app may reach a signer`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

if (findings.length) {
  console.error(`check-web: ${findings.length} violation(s)\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-web: ${walkFiles(ROOT).length} modules clean`);
