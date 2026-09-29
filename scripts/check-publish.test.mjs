// The publish check — public-release O1.2.
//
// Builds small trees in a temporary directory and plants, one at a time, each
// thing the check must stop. Nothing here is real: every address, hash, path,
// email and key the check should catch is made at runtime, so this file passes
// the check it tests.
//
//   npm run test:publish
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, fromDir, loadDenylist, parseDenylist, pinHash, synthetic } from "./check-publish.mjs";

const SCRIPT = fileURLToPath(new URL("./check-publish.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const hex = (bytes) => randomBytes(bytes).toString("hex");
const OPERATOR = `0x${hex(20)}`;     // stands in for a denylisted address
const OPERATOR_TX = `0x${hex(32)}`;  // and a denylisted transaction
const HANDLE = `handle-${hex(4)}`;   // and a denylisted name
const STRANGER = `0x${hex(20)}`;     // a real-looking address nobody has reviewed
const NOREPLY = ["publisher", "users.noreply.github.com"].join("@");
// Planted source is written with IMPORT for the keyword, so that the check's
// closure rule does not read this file's strings as its own imports.
const src = (s) => s.replaceAll("IMPORT", ["im", "port"].join(""));

const root = mkdtempSync(join(tmpdir(), "clank-publish-test-"));
const denyFile = join(root, "denylist.txt");
writeFileSync(denyFile, `# made up for the test\n${OPERATOR}  # hot wallet\n${OPERATOR_TX}  # a trade\n${HANDLE}\n`);
const deny = loadDenylist(denyFile);

const base = (over = {}) => ({
  "scripts/publish-files.json": JSON.stringify({
    include: [
      { path: "src/**", why: "code" }, { path: "docs/**", why: "docs" },
      { path: "fixtures/**", why: "fixtures" }, { path: "scripts/*.json", why: "the lists" },
      { path: "package.json", why: "scripts" }, ...(over.include ?? []),
    ],
    exclude: [],
    optional: over.optional ?? [],
    rename: over.rename ?? [],
  }),
  "scripts/publish-allowlist.json": JSON.stringify({
    constants: [], thirdParty: over.thirdParty ?? [], files: over.files ?? [], lines: over.lines ?? [],
  }),
  "src/entry/hosted.ts": src('IMPORT { x } from "./lib.js";\nexport const y = x;\n'),
  "src/entry/lib.ts": "export const x = 1;\n",
  "package.json": JSON.stringify({ scripts: { start: "tsx src/entry/hosted.ts" } }),
});
let n = 0;
function tree(files) {
  const dir = join(root, `t${++n}`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}
const run = (files, opts = {}) => check(fromDir(tree(files)), { denylist: deny, ...opts });
const kinds = (r) => [...new Set(r.failures.map((f) => f.kind))].join(",") || "none";
const stops = (name, files, kind, opts) => {
  const r = run(files, opts);
  ok(name, r.failures.some((f) => f.kind === kind), `${kinds(r)}: ${r.failures.map((f) => `${f.where} ${f.what}`).join(" | ").slice(0, 160)}`);
  return r;
};
const passes = (name, files, opts) => {
  const r = run(files, opts);
  ok(name, r.failures.length === 0, r.failures.map((f) => `${f.kind} ${f.where} ${f.what}`).join(" | ").slice(0, 200));
};
const withLib = (body, over) => ({ ...base(over), "src/entry/lib.ts": `export const x = 1;\n${body}\n` });

try {
  console.log("\nthe denylist fails closed");
  ok("no denylist is a failure", !!loadDenylist(undefined).error);
  ok("an unreadable one is a failure", !!loadDenylist(join(root, "absent.txt")).error);
  writeFileSync(join(root, "empty.txt"), "# nothing\n");
  ok("an empty one is a failure", !!loadDenylist(join(root, "empty.txt")).error);
  ok("…unless it is allowed to be empty, for CI in the published tree",
    !loadDenylist(join(root, "empty.txt"), { allowEmpty: true }).error && !loadDenylist(undefined, { allowEmpty: true }).error);
  ok("a denylist inside the repository is refused", /inside the repository/.test(loadDenylist(join(REPO, "denylist.txt")).error ?? ""));
  ok("entries parse with their line and label", JSON.stringify(parseDenylist(`# c\n${OPERATOR} # hot\n\nName Here\n`)) ===
    JSON.stringify([{ line: 2, label: "hot", kind: "hex", value: OPERATOR.slice(2) }, { line: 4, label: "", kind: "text", value: "name here" }]));
  {
    const r = check(fromDir(tree(base())), { denylist: loadDenylist(undefined) });
    ok("a check with no denylist fails even on a clean tree", r.failures.some((f) => f.kind === "denylist"));
  }

  console.log("\na clean tree");
  passes("passes", base());

  console.log("\nthe operator's own values");
  const upper = `0x${OPERATOR.slice(2).toUpperCase()}`;
  const r1 = stops("a denylisted address, in any case", withLib(`// ${upper}`), "denylist");
  ok("…and the report names it by line and label, never by value",
    r1.failures.some((f) => f.what === "denylist line 2 (hot wallet)") && !JSON.stringify(r1.failures).includes(OPERATOR.slice(2)));
  stops("…padded into a log topic", withLib(`// 0x${"0".repeat(24)}${OPERATOR.slice(2)}`), "denylist");
  stops("its truncated form, 0x1234…abcd", withLib(`// ${OPERATOR.slice(0, 6)}…${OPERATOR.slice(-4)}`), "denylist");
  stops("…and 0x123456...abcd", withLib(`// ${OPERATOR.slice(0, 8)}...${OPERATOR.slice(-4)}`), "denylist");
  stops("…and a bare prefix, as a short address shows it", withLib(`const creator = "${OPERATOR.slice(0, 6)}";`), "denylist");
  stops("a denylisted transaction", { ...base(), "fixtures/f.json": JSON.stringify({ tx: OPERATOR_TX }) }, "denylist");
  stops("a denylisted name", { ...base(), "docs/a.md": `by ${HANDLE.toUpperCase()}\n` }, "denylist");
  stops("…even inside a pinned fixture",
    { ...base({ files: [{ path: "fixtures/f.json", sha256: pinHash(Buffer.from(OPERATOR)), why: "r" }] }), "fixtures/f.json": OPERATOR }, "denylist");
  stops("a denylisted value on the allowlist", base({ thirdParty: [{ value: OPERATOR, why: "no" }] }), "denylist");

  console.log("\nunknown hex");
  stops("an unlisted real-looking address", withLib(`const a = "${STRANGER}";`), "unknown hex");
  stops("an unlisted 64-hex hash", withLib(`const h = "0x${hex(32)}";`), "unknown hex");
  stops("a bare 64-hex digest", { ...base(), "docs/a.md": `sha256 ${hex(32)}\n` }, "unknown hex");
  passes("…the address passes once it is on the allowlist, with a reason",
    withLib(`const a = "${STRANGER}";\nconst t = "0x${"0".repeat(24)}${STRANGER.slice(2)}";`, { thirdParty: [{ value: STRANGER, why: "reviewed" }] }));
  stops("…but not without the reason", withLib(`const a = "${STRANGER}";`, { thirdParty: [{ value: STRANGER }] }), "allowlist");
  passes("synthetic addresses, small numbers and ABI words pass",
    withLib(`const a = "0x${"0".repeat(35)}c1a4e", e = "0x${"e".repeat(40)}";\n` +
      `const d = "0x59a87bc1${(10n ** 16n).toString(16).padStart(64, "0")}${"0".repeat(59)}a11ce";`));
  ok("synthetic() tells a pattern from an identifier", synthetic("0".repeat(35) + "c1a4e") && synthetic("ab".repeat(20)) && !synthetic(STRANGER.slice(2)));
  passes("a decimal number is not hex", withLib(`const MAX = 1461446703485210103287273052203988822378723970342n;`));
  {
    const body = JSON.stringify({ a: `0x${hex(20)}`, b: `0x${hex(32)}` });
    passes("a reviewed fixture pinned by hash passes whatever hex it holds",
      { ...base({ files: [{ path: "fixtures/f.json", sha256: pinHash(Buffer.from(body)), why: "recorded" }] }), "fixtures/f.json": body });
    stops("…until it changes", { ...base({ files: [{ path: "fixtures/f.json", sha256: pinHash(Buffer.from(body)), why: "recorded" }] }), "fixtures/f.json": `${body} ` }, "pin");
    ok("a pin ignores line endings", pinHash(Buffer.from("a\r\nb\r\n")) === pinHash(Buffer.from("a\nb\n")));
  }

  console.log("\npersonal data");
  const winHome = ["C:", "Users", "someone", "clankbot"].join("\\");
  stops("a Windows home path", withLib(`// ${winHome}`), "personal");
  stops("…with escaped backslashes", withLib(`const p = "${winHome.replaceAll("\\", "\\\\")}";`), "personal");
  stops("a Unix home path", { ...base(), "docs/a.md": `see ${["", "home", "someone", "x"].join("/")}\n` }, "personal");
  stops("an email address", { ...base(), "docs/a.md": `mail ${["jane", "mail.com"].join("@")}\n` }, "personal");
  passes("…but not a placeholder or a noreply one", { ...base(), "docs/a.md": `dev@example.com, ${NOREPLY}, logo@2x.png\n` });
  stops("a public IP address", { ...base(), "docs/a.md": `server ${[8, 8, 4, 4].join(".")}\n` }, "personal");
  passes("…but not loopback, private or documentation ranges", { ...base(), "docs/a.md": "127.0.0.1 10.1.2.3 192.168.1.10 198.51.100.7 203.0.113.9\n" });
  passes("…or one on a reviewed line", { ...base({ lines: [{ file: "docs/a.md", text: "fake hop", why: "made up" }] }), "docs/a.md": `fake hop ${[8, 8, 4, 4].join(".")}\n` });
  stops("a key block", { ...base(), "docs/a.md": `${"-".repeat(5)}BEGIN OPENSSH PRIVATE KEY${"-".repeat(5)}\n` }, "personal");
  stops("a KEY= with a value", { ...base(), "docs/a.md": `${"API_KEY"}=abc123\n` }, "personal");
  stops("…or a PASSPHRASE=, even inside a string", withLib(`const f = "A=1\\n${"WALLET_PASSPHRASE"}=hunter2\\n";`), "personal");
  passes("…but not an empty one, or code that assigns an object", { ...base(), "docs/a.md": `${"API_KEY"}=\nconst OUTCOME_KEY = { a: 1 };\n` });

  console.log("\nthe curated list");
  stops("a file outside the list", { ...base(), "notes.md": "hi\n" }, "unlisted");
  stops("a file on the never-list, even when the list includes it", { ...base(), "src/self/wallet/keystore.ts": "export {};\n" }, "never");
  stops("…the private progress notes", { ...base(), "docs/progress.md": "notes\n" }, "never");
  stops("…an environment file", { ...base(), "src/.env": "A=1\n" }, "never");
  stops("a tree without the hosted entry", Object.fromEntries(Object.entries(base()).filter(([p]) => !p.startsWith("src/entry/hosted"))), "list");
  stops("an unpinned binary", { ...base(), "src/web/logo.png": Buffer.from([137, 80, 78, 71, 0, 1, 2]) }, "binary");
  stops("a file over 1 MB", { ...base(), "docs/big.md": "a".repeat(1024 * 1024 + 1) }, "size");
  {
    const readme = { include: [{ path: "README.public.md", why: "the public README" }], rename: [{ from: "README.public.md", to: "README.md", why: "r" }] };
    passes("a renamed file passes under its published name", { ...base(readme), "README.md": "# hi\n" });
    stops("…but not under its own name", { ...base(readme), "README.public.md": "# hi\n" }, "unlisted");
    stops("a rename onto a name the list publishes anyway",
      { ...base({ ...readme, include: [...readme.include, { path: "README.md", why: "the private one" }] }), "README.md": "# hi\n" }, "list");
    stops("a rename onto the never-list",
      { ...base({ include: readme.include, rename: [{ from: "README.public.md", to: "docs/progress.md", why: "r" }] }) }, "never");
  }

  console.log("\nthe tree must build and test on its own");
  stops("an import of an unpublished file", withLib(src('IMPORT { k } from "../self/wallet/keystore.js";')), "closure");
  stops("a new URL(…, import.meta.url) of one", withLib(src('const u = new URL("../../server/routes/self.ts", IMPORT.meta.url);')), "closure");
  passes("…unless it is listed as optional, with a reason",
    withLib(src('const u = new URL("../server/routes/self.ts", IMPORT.meta.url);'),
      { optional: [{ from: "src/entry/lib.ts", needs: "src/server/routes/self.ts", why: "skips without it" }] }));
  stops("an npm script naming an unpublished file",
    { ...base(), "package.json": JSON.stringify({ scripts: { start: "tsx src/entry/self.ts" } }) }, "closure");

  console.log("\na git directory");
  {
    const dir = tree(base());
    const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    g("add", "-A");
    g("-c", "user.name=Jane", "-c", `user.email=${["jane", "example.org"].join("@")}`, "commit", "-q", "-m", "First");
    const r = check(fromDir(dir), { denylist: deny, identity: NOREPLY });
    ok("an email in a commit other than the noreply identity fails", r.failures.some((f) => f.kind === "git" && /author email/.test(f.what)), kinds(r));
  }
  {
    const dir = tree(base());
    const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    g("add", "-A");
    g("-c", "user.name=clankchan", "-c", `user.email=${NOREPLY}`, "commit", "-q", "-m", "Publish");
    const clean = check(fromDir(dir), { denylist: deny, identity: NOREPLY });
    ok("one commit by the noreply identity passes", clean.failures.length === 0, clean.failures.map((f) => f.what).join(" | "));
    writeFileSync(join(dir, "src", "entry", "lib.ts"), "export const x = 2;\n");
    ok("uncommitted changes fail", check(fromDir(dir), { denylist: deny, identity: NOREPLY }).failures.some((f) => f.kind === "git"));
    g("-c", "user.name=clankchan", "-c", `user.email=${NOREPLY}`, "commit", "-q", "-am", `Thanks ${HANDLE}`);
    const r = check(fromDir(dir), { denylist: deny, identity: NOREPLY });
    ok("a denylisted name in a commit message fails", r.failures.some((f) => f.kind === "denylist" && f.where.startsWith("commit")), kinds(r));
    // Ignored files are not published, so they are not checked.
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    g("add", ".gitignore");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.js"), `// ${STRANGER}\n`);
    ok("…and in git, only the committed files are the tree", fromDir(dir).files.has(".gitignore") && !fromDir(dir).files.has("node_modules/x/i.js"));
  }

  console.log("\nthe command line");
  {
    const dir = tree(base());
    const env = { ...process.env };
    delete env.CLANK_PUBLISH_DENYLIST;
    const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", env });
    const none = cli(dir);
    ok("with no denylist it exits non-zero and says why", none.status === 1 && /no denylist/.test(none.stdout), `exit ${none.status}`);
    ok("with one it passes a clean tree", cli(dir, "--denylist", denyFile).status === 0);
    const bad = tree({ ...base(), "docs/a.md": `${OPERATOR}\n` });
    const out = cli(bad, "--denylist", denyFile);
    ok("…fails a planted one, and prints no denylisted value", out.status === 1 && !out.stdout.toLowerCase().includes(OPERATOR.slice(2)));
    ok("--allow-empty-denylist runs the other checks alone", cli(dir, "--allow-empty-denylist").status === 0);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n\x1b[32mall publish checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
