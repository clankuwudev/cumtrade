// The vendored trading-wallet SDK — public-release W1.1.
//
// Rebuilds scripts/vendor/wallet-entry.js with @coinbase/cdp-core, twice, in
// memory, and holds the result to the committed files: the same bytes, the
// same hash, the same licences. Then the rules the build enforces: TW10's
// budget, no code from strings, a licence for every package, and a facade that
// exports only what the spec lists. Nothing is written and nothing is fetched.
//
//   npm run test:vendor
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_GZIP_BYTES, FILES, NO_LICENCE_DECLARED, OUT_DIR, SDK, evalUses, installed, make, sha256,
} from "./vendor-wallet.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};
const committed = (name) => readFileSync(join(OUT_DIR, name));

console.log("\nthe build is reproducible and committed");
const a = await make();
const b = await make();
ok("two builds give identical bytes", a.code.equals(b.code), `${a.hash.slice(0, 16)} / ${b.hash.slice(0, 16)}`);
ok("…and identical licences", a.licencesText === b.licencesText);
const hashLine = committed(FILES.hash).toString("utf8");
ok("the committed hash is the build's", hashLine === `${a.hash}  ${FILES.bundle}\n`, hashLine.trim());
// The published source carries the hash but not the bundle or its licence
// notes: Coinbase's packages declare no licence, so the bundle is not
// republished (the user, 2026-09-22). A clone builds it with `npm run
// vendor:wallet`, and the hash above proves the build is the one we serve.
if (existsSync(join(OUT_DIR, FILES.bundle))) {
  ok("the committed wallet.js is the build, byte for byte", committed(FILES.bundle).equals(a.code));
  ok("…and hashes to its .sha256", sha256(committed(FILES.bundle)) === a.hash);
} else {
  console.log("  \x1b[90mskip  no wallet.js here: a published clone builds it with npm run vendor:wallet\x1b[0m");
}
if (existsSync(join(OUT_DIR, FILES.licences))) {
  ok("the committed LICENSES.txt is the build's", committed(FILES.licences).toString("utf8") === a.licencesText);
}

console.log("\npinned");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
for (const name of [SDK, "esbuild"]) {
  const want = pkg.devDependencies?.[name];
  ok(`${name} is an exact-pinned dev dependency`, /^\d+\.\d+\.\d+$/.test(want ?? ""), String(want));
  ok(`…and the installed ${name} is that version`, installed(name) === want, installed(name));
  ok("…and not a production dependency", !(name in (pkg.dependencies ?? {})));
}
ok("the bundle names the SDK version it came from", a.code.toString("utf8", 0, 300).includes(`${SDK} ${pkg.devDependencies[SDK]}`));

console.log("\nTW10 and the page's policy");
ok(`within the budget: ${(a.gz / 1000).toFixed(1)} KB gzipped of ${BUDGET_GZIP_BYTES / 1000} KB`, a.gz <= BUDGET_GZIP_BYTES,
  `${a.gz.toLocaleString("en-US")} bytes gzipped, ${a.code.length.toLocaleString("en-US")} minified`);
ok("no eval, Function constructor, string timer or WebAssembly compilation", a.evals.length === 0, a.evals.slice(0, 3).join(" | "));
ok("the build found no other problem", a.problems.length === 0, a.problems.join(" | "));

// The scanner's samples are only ever parsed, never run. They are assembled
// from parts so that no file in the repo spells them out.
console.log("\nthe scanner itself");
const EV = ["ev", "al"].join("");
const FN = ["Func", "tion"].join("");
const caught = [
  [`${EV}("1")`, "a direct call"],
  [`(0, ${EV})("1")`, "an indirect call"],
  [`const e = ${EV}; e("1")`, "eval as a value"],
  [`globalThis.${EV}("1")`, "eval off globalThis"],
  [`window["${EV}"]("1")`, "eval off window, by key"],
  [`new ${FN}("return 1")`, "the Function constructor with new"],
  [`${FN}("return 1")()`, "the Function constructor called"],
  [`new self.${FN}("x")`, "the Function constructor off self"],
  ["setTimeout(\"alert(1)\", 1)", "a string timer"],
  ["setInterval(`x${1}`, 1)", "a template timer"],
  ["WebAssembly.instantiate(bytes)", "WebAssembly.instantiate"],
  ["globalThis.WebAssembly.compile(bytes)", "WebAssembly.compile off a global"],
  ["new WebAssembly.Module(bytes)", "new WebAssembly.Module"],
];
for (const [src, what] of caught) ok(`caught: ${what}`, evalUses(src).length > 0, src);
const clean = [
  [`const s = "${EV}(1) and new ${FN}()"; // ${EV}()`, "strings and comments"],
  [`obj.${EV}(1); const o = { ${EV}: 1 }`, "a property named eval"],
  [`class A { ${EV}() {} }`, "a method named eval"],
  ["setTimeout(() => 1, 5)", "a function timer"],
  [`x.constructor === ${FN}`, "comparing with the Function constructor"],
];
for (const [src, what] of clean) ok(`not flagged: ${what}`, evalUses(src).length === 0, evalUses(src).join(" | "));

console.log("\nlicences");
ok("every bundled package has one", a.missing.length === 0, a.missing.join(", "));
ok("the no-licence exceptions are exactly Coinbase's two packages, and both still apply",
  a.stale.length === 0 && JSON.stringify(Object.keys(NO_LICENCE_DECLARED).sort()) === JSON.stringify(["@coinbase/cdp-api-client", "@coinbase/cdp-core"]),
  a.stale.join(", "));
for (const name of Object.keys(NO_LICENCE_DECLARED)) {
  ok(`LICENSES.txt says what governs ${name}`, a.licencesText.includes(`${name}@`) && a.licencesText.includes("Coinbase Developer Platform terms"));
}
for (const inlined of ["react", "zustand", "jose"]) {
  ok(`…and carries the licence of ${inlined}, which the SDK inlines`, a.licencesText.includes(`\n${inlined} (`));
}

console.log("\nthe facade");
const want = ["address", "completeLogin", "init", "loginWithWallet", "logout", "mountExport", "onAuthChange", "signGatewayMessage",
  "signTransaction", "startLogin"];
ok("wallet.js exports the ten functions and nothing else", JSON.stringify(a.exports) === JSON.stringify(want), a.exports.join(", "));
const entry = readFileSync(join(REPO, "scripts", "vendor", "wallet-entry.js"), "utf8");
ok("analytics are off", /disableAnalytics:\s*true/.test(entry));
ok("an EOA is made on login, never a smart account", /createOnLogin:\s*"eoa"/.test(entry) && !/createOnLogin:\s*"smart"/.test(entry));
ok("it signs for chain 4663 only", /const CHAIN_ID = 4663;/.test(entry) && /tx\.chainId !== CHAIN_ID/.test(entry));
// Stage C, C-D2: one message signer, and only for the gateway's sign-in.
const signerCalls = [...entry.matchAll(/\bsign(Evm|Solana)\w*\(/g)].map((m) => m[0]);
ok("it asks Coinbase to sign a message in one place only, inside signGatewayMessage",
  signerCalls.filter((c) => c === "signEvmMessage(").length === 1
    && /export async function signGatewayMessage[\s\S]*?signEvmMessage\(\{ evmAccount: from, message \}\)[\s\S]*?\n\}/.test(entry),
  signerCalls.join(", "));
ok("…and never for typed data, a raw hash or Solana",
  !/signEvmTypedData|signEvmHash|signSolana/.test(entry));
ok("…and never a key mint's message: only the sign-in statement is written in",
  entry.includes(`"Sign in to Clank Uwu Model's API and accept its terms. This costs nothing and moves nothing."`)
    && !/Create an API key/.test(entry));
ok("it never asks for Eject", /action:\s*"copy"/.test(entry) && !/showEject|"eject"/.test(entry));

console.log(failures === 0
  ? "\n\x1b[32mall vendor checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
