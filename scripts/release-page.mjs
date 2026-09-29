// What a hosted release serves, and how its page is rendered — public-release H1.2.
//
// Two scripts must agree on this, so it is written once:
//   scripts/release-hosted.mjs  builds a release with it;
//   scripts/verify-live.mjs     rebuilds the expected release with it, from the
//                               source at the live page's sha, and compares.
//
// In production Caddy serves, from the release's own files (deploy/Caddyfile):
//   /                          the landing, page/landing.html, its policy from page/landing-policy.txt
//   /trade and /console        the app, page/index.html, its policy from page/policy.txt
//   /ai                        cumAI, page/ai.html, its policy from page/ai-policy.txt
//   /os, /cumOS, /cumos, /terminal  a 301 to /trade (L1 N-D9; P2b)
//   /v/<sha>/<path>            src/web/public/<path>: modules, stylesheets, fonts, art, texts
//   /release-manifest.json     this release's manifest
// and Node answers only /healthz, /events and /api/*. Node never writes a page.
import ts from "typescript";
import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Where the page's files live in the source and in a release. */
export const PUBLIC = "src/web/public/";

/**
 * The file types served under /v/<sha>/. None of them is a document: a page
 * served from there would carry none of the page's headers. The build fails
 * on any other type in src/web/public/ that NOT_SERVED does not name.
 */
export const SERVED_TYPES = [".js", ".css", ".woff2", ".txt", ".png", ".webp", ".mp4"];

/** In src/web/public/ but never under /v/<sha>/, and why. */
export const NOT_SERVED = [
  [/\.d\.ts$/, "type declarations for the page's type check; nothing runs them"],
  [/^vendor\/wallet\.js\.sha256$/, "the vendored bundle's pin, checked from the source"],
  [/^vendor\/charts\.js\.sha256$/, "the chart bundle's pin, checked from the source"],
  [/^app\.html$/, "the app page itself, which a release serves from page/index.html"],
  [/^landing\/index\.html$/, "the landing page itself, which a release serves from page/landing.html"],
  [/^ai\/index\.html$/, "cumAI's page itself, which a release serves from page/ai.html"],
];

/**
 * The release's two pages (L1). Each has its source in src/web/public/, its
 * file and policy file in the release, the paths it answers on (as the hosted
 * routes and the Caddyfile both match them), and the function in
 * src/server/http.ts that lists every header it carries.
 */
export const PAGES = [
  { name: "landing", source: "landing/index.html", file: "page/landing.html", policyFile: "page/landing-policy.txt",
    paths: ["/"], headers: "landingPageHeaders" },
  { name: "app", source: "app.html", file: "page/index.html", policyFile: "page/policy.txt",
    paths: ["/trade", "/console"], headers: "hostedPageHeaders" },
  // cumAI, a page of its own (L1 L4b; N-D6, changed by the user), rendered as the landing is.
  { name: "ai", source: "ai/index.html", file: "page/ai.html", policyFile: "page/ai-policy.txt",
    paths: ["/ai"], headers: "aiPageHeaders" },
];
/** The app's old names, each a 301 to /trade. A browser keeps the fragment across it (N-D9). */
export const RENAMED_PATHS = ["/os", "/cumOS", "/cumos", "/terminal"];
export const MANIFEST_FILE = "release-manifest.json";

/** The footer slot in app.html, and what a local run shows in it. */
const RELEASE_SLOT = '<span class="mo" id="release">local</span>';

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The one module a page's source starts, by its path under src/web/public/. */
export function entryModule(html, name) {
  const m = [...html.matchAll(/<script type="module" src="\/([^"]+)"><\/script>/g)];
  if (m.length !== 1) throw new Error(`${name} has ${m.length} module scripts, expected 1`);
  return m[0][1];
}

/**
 * Every module a page's entry imports statically, directly or through the
 * others (P1a), in the order a breadth-first walk meets them, without the
 * entry. The browser otherwise finds each module only once the one importing
 * it has arrived: about 20 round trips in a row for the app. A dynamic
 * import() is not followed (the wallet bundle loads only when it is used), and
 * a module the source holds only by its pin is a leaf. The modules name each
 * other by relative path; any other specifier fails the build.
 */
export function staticImports(entry, source) {
  const seen = new Set([entry]), order = [], queue = [entry];
  while (queue.length) {
    const at = queue.shift();
    const bytes = source.read(`${PUBLIC}${at}`);
    if (!bytes) {
      if (at !== entry && source.pinned?.(`${PUBLIC}${at}`)) continue;
      throw new Error(`${at} is not in the source`);
    }
    const file = ts.createSourceFile(at, bytes.toString("utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    for (const st of file.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier) continue;
      const spec = st.moduleSpecifier.text;
      const path = posix.normalize(posix.join(posix.dirname(at), spec));
      if (!/^\.\.?\//.test(spec) || path.startsWith("../")) throw new Error(`${at} imports ${spec}, which is not a relative path inside the site`);
      if (!seen.has(path)) { seen.add(path); order.push(path); queue.push(path); }
    }
  }
  return order;
}

/** A page with a modulepreload link for each of `paths` (as they are named in the source) just before its head closes. */
export function withPreloads(html, paths, prefix = "/", name = "the page") {
  const n = html.split("</head>").length - 1;
  if (n !== 1) throw new Error(`${name} has ${n} copies of </head>, expected 1`);
  if (/rel="modulepreload"/.test(html)) throw new Error(`${name} already has modulepreload links; the release writes them`);
  const links = paths.map((p) => `<link rel="modulepreload" href="${prefix}${p}">\n`).join("");
  return html.replace("</head>", `${links}</head>`);
}

/**
 * Sort the paths under src/web/public/ (relative, with forward slashes) into
 * what is served under /v/<sha>/, what is left out on purpose, and what is
 * refused because nothing says whether it may be served.
 */
export function classifyPublic(paths) {
  const served = [], skipped = [], refused = [];
  for (const p of [...paths].sort()) {
    const why = NOT_SERVED.find(([re]) => re.test(p));
    if (why) skipped.push({ path: p, why: why[1] });
    else if (SERVED_TYPES.some((t) => p.endsWith(t))) served.push(p);
    else refused.push(p);
  }
  return { served, skipped, refused };
}

/**
 * The hosted page as a release serves it: app.html with its two asset tags
 * pointed at /v/<sha>/, stamped with its mode and without the session-token
 * slot (what src/server/routes/hosted.ts's page route does to it), with the
 * release's sha in its footer, and a modulepreload link for each of `preload`
 * (P1a). Every edit must land exactly once.
 */
export function renderPage(html, sha, preload = []) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  let page = html;
  for (const [from, to] of [
    // The only absolute asset URLs in the page: two stylesheets (the design,
    // and the phone rules of F5.7) and the entry module. The modules import
    // each other by relative path, so the whole graph resolves under the prefix.
    ['href="/app.css"', `href="/v/${sha}/app.css"`],
    ['href="/phone.css"', `href="/v/${sha}/phone.css"`],
    // The two icons, cropped from the mascot's avatar (the user, 2026-09-22).
    ['href="/favicon-32.png"', `href="/v/${sha}/favicon-32.png"`],
    ['href="/apple-touch-icon.png"', `href="/v/${sha}/apple-touch-icon.png"`],
    // The sidebar's mark is the same picture.
    ['src="/apple-touch-icon.png"', `src="/v/${sha}/apple-touch-icon.png"`],
    ['src="/js/main.js"', `src="/v/${sha}/js/main.js"`],
    // The hosted route's two edits (F1.1, F5.2).
    ["<body>", '<body data-mode="hosted">'],
    [RELEASE_SLOT, RELEASE_SLOT.replace(">local<", `>${sha}<`)],
  ]) {
    const n = page.split(from).length - 1;
    if (n !== 1) throw new Error(`app.html has ${n} copies of ${from}, expected 1`);
    page = page.replace(from, to);
  }
  const token = page.match(/<meta name="clank-token"[^>]*>\r?\n/g) ?? [];
  if (token.length !== 1) throw new Error(`app.html has ${token.length} session-token slots, expected 1`);
  return withPreloads(page.replace(token[0], ""), preload, `/v/${sha}/`, "app.html");
}

/**
 * The landing as a release serves it (L1): every asset it names by an
 * absolute path pointed at /v/<sha>/, and the release's sha in its footer.
 * Assets include link href, script/img src, video src/poster and source src;
 * `<a href="/trade">` is a page, and stays. Each of `preload` gets a
 * modulepreload link first (P1a), so it is one of those assets. Returns the
 * page and the paths of the assets it names, which the release checks it serves.
 *
 * The landing's own files refer to each other by relative path (its
 * stylesheet's fonts and art, its module's imports), so they resolve under
 * the prefix with no edit. It may not use srcset or an inline script.
 */
export function renderLanding(html, sha, name = "landing/index.html", preload = []) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const slots = html.split(RELEASE_SLOT).length - 1;
  if (slots !== 1) throw new Error(`${name} has ${slots} release slots, expected 1`);
  if (/\ssrcset=/i.test(html)) throw new Error(`${name} uses srcset, which the release does not rewrite`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`${name} has an inline script`);
  const assets = [];
  const page = withPreloads(html, preload, "/", name).replace(/<(?:link|script|img|video|source)\b[^>]*>/gi, (tag) => tag.replace(/\s(href|src|poster)="\/([^"/][^"]*)"/gi, (_m, attr, path) => {
    if (/^v\//.test(path) || /[?#]/.test(path)) throw new Error(`${name} names an asset the release cannot pin: /${path}`);
    assets.push(path);
    return ` ${attr}="/v/${sha}/${path}"`;
  }));
  return { page: page.replace(RELEASE_SLOT, RELEASE_SLOT.replace(">local<", `>${sha}<`)), assets };
}

/** The sha a rendered page names, from its footer and its module URL, or null if they disagree. */
export function pageSha(html) {
  const footer = html.match(/<span class="mo" id="release">([0-9a-f]{40})<\/span>/)?.[1];
  const module = html.match(/src="\/v\/([0-9a-f]{40})\/js\/main\.js"/)?.[1];
  return footer && footer === module ? footer : null;
}

/**
 * Each page's headers, from src/server/http.ts as it is at some commit:
 * transpiled on its own and imported, so the release and the live check read
 * the very constants the server would. http.ts imports only node:http, which
 * a data: module may import. A commit from before L1 has no landing headers,
 * and fails here. Keyed by page name, each `{ policy, headers }`.
 */
export async function pageHeaders(httpTs) {
  const js = ts.transpileModule(httpTs, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const out = {};
  for (const p of PAGES) {
    if (typeof mod[p.headers] !== "function") {
      throw new Error(`src/server/http.ts has no ${p.headers}(): this commit predates ${p.name === "landing" ? "L1" : "F5.6"}`);
    }
    const headers = mod[p.headers]();
    const policy = headers["content-security-policy"];
    if (typeof policy !== "string" || !policy || /[\r\n]/.test(policy)) {
      throw new Error(`${p.headers}() does not carry its policy as one line`);
    }
    out[p.name] = { policy, headers };
  }
  if (new Set(Object.values(out).map((x) => x.policy)).size !== PAGES.length) throw new Error("two pages carry the same policy");
  return out;
}

/**
 * The expected release, from a source that can list and read the files under
 * src/web/public/ and read src/server/http.ts. `source.read(path)` returns the
 * bytes or null. `source.pinned(path)`, when given, may vouch for a file the
 * source does not hold, by its sha256 (the published tree has the SDK
 * bundle's pin but not the bundle).
 *
 * Returns each page with its policy and headers (in PAGES' order), every
 * served file with its hash (and its bytes, when the source has them), what
 * was left out, and the manifest's text.
 */
export async function expectedRelease(source, sha) {
  const need = (p) => {
    const b = source.read(p);
    if (!b) throw new Error(`${p} is not in the source`);
    return b;
  };
  const headers = await pageHeaders(need("src/server/http.ts").toString("utf8"));
  // Each page preloads every module its entry imports statically (P1a).
  const html = Object.fromEntries(PAGES.map((p) => [p.name, need(`${PUBLIC}${p.source}`).toString("utf8")]));
  const preload = Object.fromEntries(PAGES.map((p) => [p.name, staticImports(entryModule(html[p.name], p.source), source)]));
  // The landing and cumAI are rendered the same way: their assets under /v/<sha>/, the sha in the footer.
  const statics = Object.fromEntries(["landing", "ai"].map((n) => {
    const src = PAGES.find((p) => p.name === n).source;
    return [n, { src, ...renderLanding(html[n], sha, src, preload[n]) }];
  }));
  const rendered = { landing: statics.landing.page, ai: statics.ai.page, app: renderPage(html.app, sha, preload.app) };
  const pages = PAGES.map((p) => ({ ...p, page: rendered[p.name], ...headers[p.name] }));
  const { served, skipped, refused } = classifyPublic(source.list());
  if (refused.length) {
    throw new Error(`src/web/public/ has files of a type a release does not serve: ${refused.join(", ")}. `
      + "Add the type to SERVED_TYPES only if it can never be a document, or name it in NOT_SERVED.");
  }
  const files = served.map((path) => {
    const bytes = source.read(`${PUBLIC}${path}`);
    if (bytes) return { path, sha256: sha256(bytes), bytes, from: "source" };
    const pin = source.pinned?.(`${PUBLIC}${path}`);
    if (pin) return { path, sha256: pin, bytes: null, from: "pin" };
    return { path, sha256: null, bytes: null, from: "missing" };
  });
  for (const st of Object.values(statics)) {
    const unserved = st.assets.filter((a) => !served.includes(a));
    if (unserved.length) throw new Error(`${st.src} names files a release does not serve: ${unserved.join(", ")}`);
  }
  const complete = files.every((f) => f.sha256);
  return {
    sha, pages, files, skipped,
    manifest: complete ? manifestText({ sha, pages, files }) : null,
  };
}

/**
 * The manifest: the sha, each page's paths, hash and headers, and every file
 * under /v/<sha>/ by hash. No build time, so one commit always gives the same
 * bytes.
 */
export function manifestText({ sha, pages, files }) {
  return JSON.stringify({
    about: "A hosted release (public-release H1.2, L1). Each of pages answers at each of its paths with "
      + "its headers; each of files is served at /v/<sha>/<path>. Every hash is sha256. Rebuild this "
      + "from the source at sha and compare it with the live site: node scripts/verify-live.mjs <origin>.",
    sha,
    pages: Object.fromEntries(pages.map((p) => [p.name, { paths: p.paths, sha256: sha256(Buffer.from(p.page, "utf8")), headers: p.headers }])),
    files: Object.fromEntries(files.map((f) => [f.path, f.sha256])),
  }, null, 2) + "\n";
}
