// The hosted process must not be able to load a key.
//
// Not "is not configured with one": it must have no import path to the code
// that reads, holds or uses one. Everything that can sign, spend or trade on
// its own lives under src/self/. This resolves the import graph from
// src/entry/hosted.ts, the way TypeScript does, and fails if:
//
//   - any file reachable from it is under src/self/ — it prints the chain of
//     imports that got there, so the fix is obvious
//   - any file reachable from it is under src/gateway/: the gateway owns the
//     credit ledger (ledger.sqlite), which has one writer. The gateway's own
//     entry, src/entry/gateway.ts (X6's G11), and anything under src/gateway/
//     may reach it; no other entry may. Run on the gateway's entry, the check
//     still forbids src/self/ and every signing name
//   - any reachable file of ours imports from viem/accounts, or names
//     privateKeyToAccount, mnemonicToAccount, signTransaction or signMessage
//
// Type-only imports count. A type imported from src/self/ is the design
// leaking, even though it erases at runtime.
//
// src/self/guard.ts is the runtime half: it throws if a self module is ever
// evaluated in a hosted process, for anything this cannot see.
//
//   node scripts/check-boundary.mjs [entry]
import ts from "typescript";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SRC = resolve(REPO, "src") + sep;
const SELF = resolve(REPO, "src", "self") + sep;
const GATEWAY = resolve(REPO, "src", "gateway") + sep;
const ENTRY = resolve(REPO, process.argv[2] ?? "src/entry/hosted.ts");
const GATEWAY_ENTRY = resolve(REPO, "src", "entry", "gateway.ts");
const FORBIDDEN_DIRS = ENTRY.startsWith(GATEWAY) || ENTRY === GATEWAY_ENTRY ? [SELF] : [SELF, GATEWAY];
const forbidden = (f) => FORBIDDEN_DIRS.some((d) => f.startsWith(d));
const FORBIDDEN_MODULES = new Set(["viem/accounts"]);
const FORBIDDEN_NAMES = new Set(["privateKeyToAccount", "mnemonicToAccount", "signTransaction", "signMessage"]);

const rel = (f) => relative(REPO, f).split(sep).join("/");
const norm = (f) => resolve(f);

const configPath = ts.findConfigFile(REPO, ts.sys.fileExists, "tsconfig.json");
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, REPO);
const options = parsed.options;
const program = ts.createProgram({ rootNames: [ENTRY], options });

/** Every module specifier in a file: static, re-export, side-effect, dynamic and type-position imports. */
function specifiers(sf) {
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ node: n, text: n.moduleSpecifier.text });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword &&
               n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      out.push({ node: n, text: n.arguments[0].text });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ node: n, text: n.argument.literal.text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// Breadth-first from the entry, over our own files, remembering who imported
// each one first so a violation can print the shortest chain to it.
const parent = new Map([[norm(ENTRY), null]]);
const queue = [norm(ENTRY)];
const findings = [];
const at = (sf, n) => `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

while (queue.length) {
  const file = queue.shift();
  const sf = program.getSourceFile(file);
  if (!sf) { findings.push(`${rel(file)}  could not be read`); continue; }

  for (const { node, text } of specifiers(sf)) {
    if (FORBIDDEN_MODULES.has(text)) findings.push(`${at(sf, node)}  imports ${text}`);
    const target = ts.resolveModuleName(text, file, options, ts.sys).resolvedModule?.resolvedFileName;
    if (!target) continue;
    const t = norm(target);
    if (!t.startsWith(SRC) || parent.has(t)) continue;
    parent.set(t, file);
    queue.push(t);
  }

  const names = (n) => {
    if (ts.isIdentifier(n) && FORBIDDEN_NAMES.has(n.text)) findings.push(`${at(sf, n)}  names ${n.text}`);
    ts.forEachChild(n, names);
  };
  names(sf);
}

const chain = (file) => {
  const links = [];
  for (let f = file; f; f = parent.get(f)) links.unshift(rel(f));
  return links.join(" → ");
};
for (const file of parent.keys()) {
  if (forbidden(file)) findings.push(`reaches ${rel(file)}\n      ${chain(file)}`);
}

// The walk above follows our own resolution. The compiler's own view of the
// program is the cross-check: nothing forbidden may be in it either.
for (const sf of program.getSourceFiles()) {
  const f = norm(sf.fileName);
  if (forbidden(f) && !parent.has(f)) findings.push(`reaches ${rel(f)} (found by the compiler, not the walk)`);
}

const ours = [...parent.keys()].length;
if (findings.length) {
  console.error(`check-boundary: ${rel(ENTRY)} — ${findings.length} violation(s)\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-boundary: ${rel(ENTRY)} reaches ${ours} of our modules, none under ${FORBIDDEN_DIRS.map((d) => rel(d) + "/").join(" or ")}`);
