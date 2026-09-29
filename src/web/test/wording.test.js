// What a verdict may say (public-release F5.1).
//
// A band is what the automated checks found on chain. The checks cannot show
// that a token is safe, so the page never says so: the CLEAN band reads "No
// issues found", nothing is called "clean", "safe" or "worth a look", and a
// hosted page says "Automated checks, not advice" under every large band.
//
// Two kinds of test. A scan of every string in the client and every word in
// app.html, so a later change cannot bring the old words back anywhere. And
// the renderers themselves, painting into a stub page, so the words and the
// note are checked where a reader sees them, in each mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, rows, sessionLog } from "../public/js/core/store.js";
import { ABOUT_HREF, BANDS, VERDICT_NOTE, bandLabel, bandOf, verdictNote } from "../public/js/core/domain.js";
import { renderLaunches, setBoardView, shownBy } from "../public/js/pages/launches.js";
import { checks, renderToken, runCheck } from "../public/js/pages/token.js";

const dom = stubDom();

/** Words that promise more than a check can show. */
const PROMISES = [
  /\bclean\b/i,
  /worth a look/i,
  /\bsafe(r|st|ly|ty)?\b/i,
  /\bguarantee/i,
  /\brisk[- ]free\b/i,
  /\bno risk\b/i,
  /\blegit\b/i,
];
const promise = (text) => PROMISES.find((re) => re.test(text)) ?? null;

// ------------------------------------------------------------ the words --

test("the CLEAN band reads 'No issues found'; its key and class stay CLEAN", () => {
  assert.deepEqual(BANDS.CLEAN, ["CLEAN", "No issues found"]);
  assert.deepEqual(bandOf({ status: "ready", graduated: false, band: "CLEAN" }), ["CLEAN", "No issues found"]);
  assert.equal(bandLabel("CLEAN"), "No issues found");
  assert.equal(bandLabel("HIGH RISK"), "High risk");
  assert.equal(bandLabel("SOMETHING NEW"), "SOMETHING NEW", "an unknown band prints as it came");
});

test("no band's words promise anything", () => {
  for (const [, words] of Object.values(BANDS)) assert.equal(promise(words), null, words);
});

test("the note is hosted only, and links to the About page", () => {
  S.mode = "self";
  assert.equal(verdictNote(), "", "a self page gains nothing");
  S.mode = "hosted";
  try {
    assert.equal(verdictNote().s, `<a class="vnote" href="${ABOUT_HREF}">${VERDICT_NOTE}</a>`);
    assert.equal(VERDICT_NOTE, "Automated checks, not advice");
    // About's Verdicts section, under Learn since U6.
    assert.equal(ABOUT_HREF, "#/learn/verdicts");
  } finally {
    S.mode = "self";
  }
});

// ------------------------------------------------------------ the scan --

const JS_ROOT = fileURLToPath(new URL("../public/js/", import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : name.endsWith(".js") ? [p] : [];
});

/** Every string and every piece of template text in a module, with its line. */
function stringsIn(file, kind = ts.ScriptKind.JS) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      out.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The uses allowed by name. Each is about the bot's own arm switch in self
 * mode, "Safe" meaning dry run, or is not words at all. None describes a
 * token. A new use, or a changed one, fails until it is added here with its
 * reason. A sentence saying what a verdict does NOT mean (F5.3's About page)
 * is added the same way.
 */
const ALLOWED = [
  { file: "pages/shell.js", text: "safe", why: "the arm card's class name" },
  { file: "pages/shell.js", text: "Both switches start safe.", why: "the bot's two arm switches, after unlock" },
  { file: "pages/shell.js", text: "Sniper safe", why: "the toast when the sniper is disarmed" },
  { file: "pages/sniper.js", text: "safe", why: "the arm hero's class name" },
  { file: "trade.js", text: "Trading is in safe mode", why: "self's buy button while manual trading is disarmed" },
];

test("no string in the client calls a token clean or safe, or promises anything", () => {
  const seen = new Set();
  const found = [];
  for (const file of walk(JS_ROOT)) {
    const rel = relative(JS_ROOT, file).split(sep).join("/");
    for (const { text, line } of stringsIn(file)) {
      if (text === "CLEAN") continue; // the band key, compared and never shown
      const hit = promise(text);
      if (!hit) continue;
      const ok = ALLOWED.find((a) => a.file === rel && a.text === text);
      if (ok) { seen.add(ok); continue; }
      found.push(`${rel}:${line}  ${JSON.stringify(text.trim().slice(0, 100))}  (${hit})`);
    }
  }
  assert.deepEqual(found, [], "words that promise more than a check can show:\n  " + found.join("\n  "));
  const stale = ALLOWED.filter((a) => !seen.has(a));
  assert.deepEqual(stale, [], "allowed uses that no longer exist; remove them from ALLOWED");
});

const PAGE = readFileSync(fileURLToPath(new URL("../public/app.html", import.meta.url)), "utf8");

/** app.html's visible words: text between tags, with the tag before it, and the attributes people read. */
function pageWords(page) {
  const out = [];
  for (const m of page.matchAll(/(<[^>]*>)([^<]+)/g)) {
    const text = m[2].replace(/\s+/g, " ").trim();
    if (text) out.push({ text, tag: m[1] });
  }
  for (const m of page.matchAll(/\s(title|placeholder|aria-label|alt)="([^"]*)"/g)) out.push({ text: m[2], tag: m[0] });
  return out;
}

test("no word in app.html calls a token clean or safe", () => {
  // "Safe" is allowed only as the arm switch's own state: the elements shown
  // while the sniper is disarmed (.safeonly).
  const armState = (w) => w.text === "Safe" && /class="[^"]*\bsafeonly\b/.test(w.tag);
  const found = pageWords(PAGE).filter((w) => promise(w.text) && !armState(w)).map((w) => w.text);
  assert.deepEqual(found, []);
});

test("the filter chip reads 'No issues found' and still filters on CLEAN", () => {
  assert.match(PAGE, /<button class="chip" type="button" data-f="CLEAN" aria-pressed="false">No issues found<span class="n"><\/span><\/button>/);
  assert.match(PAGE, /<option value="score">Lowest risk<\/option>/);
  // The chip's filter (U2 moved it from app.css into launches.js): CLEAN on its curve, and nothing else.
  const r = (over) => ({ status: "ready", graduated: false, band: "CLEAN", ...over });
  assert.ok(shownBy("CLEAN", r()));
  for (const other of [r({ band: "CAUTION" }), r({ band: "HIGH RISK" }), r({ band: "AVOID" }), r({ graduated: true }), r({ status: "analysing" })]) {
    assert.ok(!shownBy("CLEAN", other), JSON.stringify(other));
  }
});

test("the CLI prints 'NO ISSUES FOUND' for a CLEAN verdict", () => {
  const file = fileURLToPath(new URL("../../cli/check.ts", import.meta.url));
  const cli = readFileSync(file, "utf8");
  assert.match(cli, /CLEAN: "NO ISSUES FOUND"/);
  assert.match(cli, /VERDICT: \$\{LABEL\[s\.band\] \?\? s\.band\}/, "the verdict line prints the label, not the key");
  const found = stringsIn(file, ts.ScriptKind.TS).filter(({ text }) => promise(text)).map(({ text }) => text);
  assert.deepEqual(found, []);
});

// -------------------------------------------------------- the renderers --

const TOKEN = "0x00000000000000000000000000000000000070a1";
const OTHER = "0x00000000000000000000000000000000000070a2";
const row = (over = {}) => ({
  token: TOKEN, curve: "0x000000000000000000000000000000000000c0e1", creator: "0x000000000000000000000000000000000000c4ea",
  symbol: "TKN", name: "token", status: "ready", band: "CLEAN", score: 4, sellable: true, graduated: false, v4: null,
  fdvEth: 1.6, raised: 0.03, progress: 0.01, threshold: 4.2, holders: 12, devBuyPct: 2, bundlePct: 0,
  tokensPerEth: 6e8, feeBps: 100, priorLaunches: 0, priorDead: 0, findings: [], top10Pct: 40,
  block: 100, launchedAt: Math.floor(Date.now() / 1000) - 600, ...over,
});

/** Render with a blank page, a fresh board and the given mode. */
function fresh(mode, board = [row()]) {
  dom.reset();
  rows.clear();
  checks.clear();
  for (const r of board) rows.set(r.token.toLowerCase(), r);
  Object.assign(S, { mode, wallet: null, conn: null, openToken: null, heldFromLedger: null, boardReady: true });
  setBoardView({ f: "all", q: "", sort: "new", dir: 1 });
}

/** The board's rows as painted, newest first. */
const boardRows = () => dom.el("#lrows").appended.map((el) => el.markup);

const NOTE_AFTER_RISK = new RegExp(`Risk \\d+ of 100</div><a class="vnote" href="${ABOUT_HREF}">${VERDICT_NOTE}</a>`);

for (const mode of ["self", "hosted"]) {
  test(`${mode}: the board says 'No issues found', and nothing is clean or worth a look`, () => {
    fresh(mode, [row({ block: 101 }), row({ token: OTHER, symbol: "OTH", block: 100 })]);
    renderLaunches();

    // The summary line (U2) counts what had no issues found, in those words;
    // the four stat cards and their sniper's words are gone.
    const summary = textOf(dom.el("#lsum").markup);
    assert.match(summary, /^2 on the board 2 no issues found newest .+ ago .+ raised across the board$/);
    // Each launch is a row, which the chip filters by its band; the badge says the band in words.
    const painted = boardRows();
    assert.equal(painted.length, 2);
    for (const markup of painted) {
      assert.match(markup, /data-b="CLEAN"/);
      assert.match(markup, /<span class="bd band CLEAN" title="Risk 4 of 100[^"]*">No issues found<\/span>/);
    }

    for (const text of [summary, ...painted.map(textOf)]) assert.equal(promise(text), null, text);
    for (const gone of [/Cleared every gate/, /Blocked or skipped/, /interlock/]) assert.doesNotMatch(summary, gone);
  });

  test(`${mode}: the check's verdict reads 'No issues found', on the token page and in the session log`, async () => {
    // The Checker is the token page since U4: an address not on the board
    // gets the page, which runs the deep check and draws its verdict.
    fresh(mode, []);
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => ({ token: TOKEN, symbol: "TKN", name: "token", band: "CLEAN", score: 4, findings: [] }),
    });
    S.openToken = TOKEN;
    await runCheck(TOKEN);

    const res = dom.el("#tokbody").markup;
    assert.match(res, /<span class="bd CLEAN">No issues found<\/span>/);
    assert.equal(sessionLog[0].detail, "TKN — No issues found");
    assert.equal(promise(textOf(res)), null);
    if (mode === "hosted") assert.match(res, NOTE_AFTER_RISK);
    else assert.doesNotMatch(res, /vnote|not advice/);
  });

  test(`${mode}: the token page's band reads 'No issues found'`, () => {
    fresh(mode);
    S.openToken = TOKEN;
    renderToken();

    const page = dom.el("#tokbody").markup;
    assert.match(page, /<span class="bd CLEAN">No issues found<\/span>/);
    if (mode === "hosted") assert.match(page, NOTE_AFTER_RISK);
    else assert.doesNotMatch(page, /vnote|not advice/);
  });
}

test("hosted: the board's heading carries the note, and each row's band says it in its tooltip; self's do not", () => {
  // A table row has no room under its band (u-redesign.md, "Density vs.
  // warnings"): the note is in the board's heading, and on the badge.
  fresh("hosted");
  renderLaunches();
  assert.equal(dom.el("#lnote").markup, `<a class="vnote" href="${ABOUT_HREF}">${VERDICT_NOTE}</a>`);
  const [hostedRow] = boardRows();
  assert.match(hostedRow, new RegExp(`<span class="bd band CLEAN" title="Risk 4 of 100 · ${VERDICT_NOTE}">No issues found</span>`));

  fresh("self");
  renderLaunches();
  assert.equal(dom.el("#lnote").markup, "");
  assert.doesNotMatch(boardRows()[0], /vnote|not advice/);
});

test("hosted: a launch still being checked gets the note too", () => {
  fresh("hosted", [row({ status: "analysing", band: undefined, score: undefined })]);
  renderLaunches();
  assert.match(boardRows()[0], /<span class="bd band SCAN" title="analysing… · Automated checks, not advice">Checking<\/span>/);
});

test("hosted: the progress bar's marker says where graduation is close, not the console's exit guard", () => {
  for (const mode of ["hosted", "self"]) {
    fresh(mode);
    renderLaunches();
    // The board's graduation bar says it in its tooltip.
    const bar = boardRows()[0].match(/<span class="bgrad" title="([^"]*)"/)[1];
    S.openToken = TOKEN;
    renderToken();
    const page = textOf(dom.el("#tokbody").markup);
    for (const text of [bar, page]) {
      if (mode === "hosted") {
        assert.match(text, /Close to graduation at /);
        assert.doesNotMatch(text, /\bGuard\b/);
      } else {
        assert.match(text, /Guard at /);
      }
    }
  }
});
