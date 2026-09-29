// The console's own fonts (public-release F5.2): every file is the one
// fonts/SOURCES.txt says was downloaded, and the stylesheet asks for exactly
// those files by relative URL, so they resolve under a release's /v/<sha>/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const sources = readFileSync(`${PUBLIC}fonts/SOURCES.txt`, "utf8");
/** name → sha256, from the "  Name  from …\n    sha256 …" pairs. */
const recorded = Object.fromEntries(
  [...sources.matchAll(/^ {2}(\S+)\s+from .*\n {4}sha256 ([0-9a-f]{64})$/gm)].map((m) => [m[1], m[2]]));

test("SOURCES.txt records every file in fonts/, and nothing that is not there", () => {
  const files = readdirSync(`${PUBLIC}fonts`).filter((f) => f !== "SOURCES.txt").sort();
  assert.deepEqual(Object.keys(recorded).sort(), files);
});

test("every font and licence matches its recorded SHA-256", () => {
  for (const [name, sha] of Object.entries(recorded)) {
    const got = createHash("sha256").update(readFileSync(`${PUBLIC}fonts/${name}`)).digest("hex");
    assert.equal(got, sha, name);
  }
});

test("each family ships its OFL licence", () => {
  for (const f of ["SchibstedGrotesk-OFL.txt", "JetBrainsMono-OFL.txt", "Geist-OFL.txt", "GeistMono-OFL.txt", "HankenGrotesk-OFL.txt"]) {
    assert.match(readFileSync(`${PUBLIC}fonts/${f}`, "utf8"), /SIL Open Font License, Version 1\.1/);
  }
});

/**
 * Each page's stylesheet and the fonts it loads (L1 L2): the app's, and the
 * landing's, which sits one directory down and so reaches fonts/ by ../.
 */
const SHEETS = [
  ["app.css", "", ["SchibstedGrotesk-Variable.woff2", "JetBrainsMono-Regular.woff2", "JetBrainsMono-Medium.woff2"]],
  ["landing/landing.css", "../", ["Geist-Variable.woff2", "GeistMono-Variable.woff2", "HankenGrotesk-Variable.woff2"]],
];

test("each stylesheet loads exactly its own woff2 files, by relative URL, with swap", () => {
  for (const [sheet, up, want] of SHEETS) {
    const css = readFileSync(`${PUBLIC}${sheet}`, "utf8");
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    const fonts = urls.filter((u) => u.endsWith(".woff2"));
    assert.deepEqual([...new Set(fonts)].sort(), want.map((f) => `${up}fonts/${f}`).sort(), sheet);
    // Anything else a stylesheet names is one of our own images, by relative URL (cumAI's band, L1 L4).
    for (const u of urls.filter((x) => !x.endsWith(".woff2"))) {
      assert.match(u, /^[a-z0-9/_-]+\.webp$/, `${sheet}: ${u}`);
      assert.ok(existsSync(`${PUBLIC}${sheet.includes("/") ? sheet.replace(/[^/]+$/, "") : ""}${u}`), `${sheet}: ${u} exists`);
    }
    assert.equal(css.match(/@font-face\{[^}]*font-display:swap/g)?.length, want.length, sheet);
  }
});

test("between them, the stylesheets load every woff2 recorded, and nothing else", () => {
  const woff2 = Object.keys(recorded).filter((f) => f.endsWith(".woff2")).sort();
  assert.deepEqual(SHEETS.flatMap(([, , want]) => want).sort(), woff2);
});

test("neither page loads anything from Google, and neither carries an inline script", () => {
  for (const page of ["app.html", "landing/index.html"]) {
    const html = readFileSync(`${PUBLIC}${page}`, "utf8");
    assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/, page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, page);
  }
  assert.doesNotMatch(readFileSync(`${PUBLIC}landing/landing.css`, "utf8"), /googleapis|gstatic|@import/);
});
