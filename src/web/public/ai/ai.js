// cumAI at /ai as the demo's console (stage C, C5; C-D8, C-D9, C-D11): a top
// bar with a command palette and chips, a sidebar with the Build group only
// (Playground, Models, Docs), the panel, and an inspector hosted by
// clankchan. The demo sets the look; every word and number follows the specs
// and the live gateway.
//
// Every value from the gateway goes through `html`, which escapes it, or
// textContent. No style is written inline: the page's policy allows none,
// so the bars' widths are set through CSSOM.
import { $, $$, html, paint } from "../js/core/dom.js";
import { tokens, usd } from "../landing/live.js";
import { createGateway } from "./gateway.js";
import { createLogin } from "./login.js";
import { GATEWAY, QUICK, fetchModels, fetchPictureModels, hitIn, initial, modelView, paletteModels, scale, tabOf, thousandCalls } from "./models.js";
import { createPlayground } from "./playground.js";
import { dollars, picturesLeft, picturesOffered, picturesPerDay, short } from "./state.js";
import { ago, counts, fetchStatus, firstToken, lasted, speed, statusView, worst } from "./status.js";
import { FACES, HOST, STATUS } from "./words.js";

const BASE_URL = `${GATEWAY}/v1`;
const S = {
  /** @type {any[] | null | undefined} */ rows: undefined,
  /** GET /v1/images/models (X15c): null while pictures aren't served. */
  /** @type {any[] | null | undefined} */ pics: undefined,
  tab: "",
  /** @type {string | null} */ selected: null,
  quick: "All", fam: "All", sortKey: "id", sortDir: 1,
  /** @type {Element | null} */ lastFocus: null,
  /** @type {any} */ play: null,
  /** @type {any} */ pg: null,
  /** GET /v1/status: undefined while loading, null when it didn't answer (C5b). */
  /** @type {any} */ status: undefined,
  statusAt: 0,
  stFilter: "all",
};
/** How often the Status tab reads again, at most. */
const STATUS_EVERY_MS = 60_000;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const OPEN = ["in", "out"];

/** The nearest element matching `sel`, from an event's target, or null (the document has no closest). */
const near = (t, sel) => /** @type {HTMLElement | null} */ (typeof t?.closest === "function" ? t.closest(sel) : null);

/** Copy some text, or say it could not. */
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// -------------------------------------------------------------- the host --

let face = "";
/** clankchan's face and line for a state (words.js HOST). Never a model's words. */
function host(name, ...args) {
  const make = HOST[name];
  if (!make) return;
  const [f, line] = make(...args);
  if (f !== face && FACES[f]) {
    face = f;
    // Beside this module in a release (/v/<sha>/art/…), as the page's own <img> is.
    const src = new URL(`../art/${FACES[f][0]}.webp`, import.meta.url).href;
    for (const img of $$("[data-host-img]")) {
      img.src = src;
      img.alt = img.dataset.hostImg === "big" ? `clankchan, ${FACES[f][1]}` : "";
    }
  }
  for (const p of $$("[data-host-line]")) p.textContent = line;
}

function hostForTab() {
  if (S.tab === "playground") return S.pg?.hostLine();
  if (S.tab === "docs") return host("docs");
  if (S.tab === "status") return statusHost();
  if (S.rows === undefined) return host("loading");
  return S.rows ? host("models", S.rows.length) : host("modelsDown");
}

// ------------------------------------------------------------ inspector --

const ib = (title, inner, right = html``) => html`<div class="cai-ib"><div class="cai-ib-h"><span>${title}</span>${right}</div>${inner}</div>`;
const kvm = (pairs) => html`<dl class="cai-kvm">${pairs.map(([k, v, amber]) => html`<div><dt>${k}</dt><dd class="${amber ? "amber" : ""}">${v}</dd></div>`)}</dl>`;
const freeTag = html`<span class="cai-freetag">free</span>`;
const rowOf = (id) => (S.rows ?? []).find((r) => r.id === id) ?? null;
const isFree = (id) => !!S.play && OPEN.includes(S.play.state) && id === S.play.model;

function inspPlay() {
  const p = S.play;
  // Picture mode (X15c): the picture model, and today's pictures, not chat's.
  const pic = p?.state === "in" && p.mode === "picture" ? picturesOffered(p.free) : null;
  if (pic) {
    const price = S.pics?.find((m) => m.id === pic.model)?.tiers.find(([t]) => t === pic.tier)?.[1];
    const left = picturesLeft(pic) ?? picturesPerDay(pic);
    return [
      ib("Model", kvm([["id", pic.model, true], ["size", String(pic.tier ?? "—")], ...(price == null ? [] : [["per picture", dollars(price)]])]), freeTag),
      ib("This session", html`${kvm([["calls", String(p.session.calls)], ["cost", dollars(p.session.cost), true]])}<p>Not saved. A reload or a closed tab clears it.</p>`),
      ib("Today's pictures", html`${kvm([["left", `${left} of ${picturesPerDay(pic)}`, true], ["resets", "00:00 UTC"], ["account", short(p.account?.address)]])}<div class="cai-acts"><button class="cai-small-btn" type="button" data-act="sign-out">Sign out</button></div>`),
    ];
  }
  const r = rowOf(p?.model);
  const blocks = [ib("Model", kvm([
    ["id", p?.model ?? "—", true],
    ...(r ? [["maker", r.maker], ["input", `${usd(r.in)}/M`], ["output", `${usd(r.out)}/M`], ["context", tokens(r.ctx)], ["max out", tokens(r.max)]] : []),
  ]), p && OPEN.includes(p.state) ? freeTag : html``)];
  if (p?.state === "in") {
    blocks.push(ib("This session", html`${kvm([["calls", String(p.session.calls)], ["tokens", String(p.session.tokens)], ["cost", dollars(p.session.cost), true]])}<p>Not saved. A reload or a closed tab clears it.</p>`));
    if (p.last) blocks.push(ib("Last call", kvm([["tokens", p.last.tokens == null ? "—" : String(p.last.tokens)], ["cost", dollars(p.last.cost ?? NaN), true], ["time", `${p.last.secs.toFixed(1)} s`]])));
    blocks.push(ib("Today's allowance", html`${kvm([["left", dollars(p.free?.left_usd), true], ["resets", "00:00 UTC"], ["account", short(p.account?.address)]])}<div class="cai-acts"><button class="cai-small-btn" type="button" data-act="sign-out">Sign out</button></div>`));
  }
  return blocks;
}

/** A model's state, as the Status tab reads it, or null before it has. */
const stateOf = (id) => S.status?.models?.find((m) => m.id === id) ?? null;
const stp = (state) => html`<span class="cai-stp ${state}"><i class="cai-sdot ${state}"></i>${STATUS.label[state]}</span>`;

function inspModel(r) {
  const free = isFree(r.id);
  const st = stateOf(r.id);
  return [
    ...(st ? [ib("Status", kvm([["state", stp(st.state)], ["first token", firstToken(st.firstTokenMs)], ["speed", speed(st.tokensPerS)],
      ["checked", ago(st.checkedAt, S.status.generatedAt)]]))] : []),
    ib(r.maker, html`${kvm([["id", r.id, true], ["input", `${usd(r.in)}/M`], ["output", `${usd(r.out)}/M`], ["context", tokens(r.ctx)], ["max out", tokens(r.max)], ["1k calls*", usd(thousandCalls(r))]])}
      <p>*1,000 calls of 1,000 tokens in and 500 out.</p>
      <div class="cai-acts"><button class="cai-small-btn" type="button" data-copy="${r.id}">Copy id</button>${free
        ? html`<a class="cai-small-btn" href="#/playground">Open in Playground</a>`
        : html`<button class="cai-small-btn" type="button" disabled>Needs a key: next</button>`}</div>`, free ? freeTag : html``),
    ib("Call it", html`<pre>curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $CUM_KEY" \\
  -d '{"model": "${r.id}", "messages": [...]}'</pre>`),
  ];
}

function inspDocs() {
  const toc = $$("#cai-main .ai-dsec").map((s) => html`<a href="#/docs" data-ai-jump="${s.id}">${s.querySelector("h2")?.firstChild?.textContent?.trim() ?? s.id}</a>`);
  return [
    ib("On this page", html`<nav class="cai-toc" aria-label="On this page">${toc}</nav>`),
    ib("Base URL", html`<pre>${BASE_URL}</pre><div class="cai-acts"><button class="cai-small-btn" type="button" data-copy="${BASE_URL}">Copy</button></div>`),
  ];
}

function inspStatus() {
  const pr = S.status?.probe;
  const how = !S.status ? html`<p>${STATUS.down}</p>`
    : pr?.on && pr.everyMinutes && pr.budgetUsdDay != null
      ? html`<p>${STATUS.from}, ${STATUS.every(pr.everyMinutes)}, ${STATUS.budget(pr.budgetUsdDay, pr.spentUsdToday ?? 0)}.</p>`
      : html`<p>${STATUS.noChecks}</p>`;
  return [
    ib("Legend", html`<dl class="cai-kvm">${["live", "degraded", "down", "unknown"].map((k) => html`<div><dt>${stp(k)}</dt><dd>${STATUS.legend[k]}</dd></div>`)}</dl>`),
    ib("How it's measured", how),
  ];
}

function renderInsp() {
  const el = $("#cai-insp-body");
  if (!el) return;
  const r = S.tab === "models" && S.selected ? rowOf(S.selected) : null;
  const blocks = S.tab === "playground" ? inspPlay()
    : S.tab === "docs" ? inspDocs()
      : S.tab === "status" ? inspStatus()
      : r ? inspModel(r) : [ib("Model", html`<p>Pick a row to see its numbers here.</p>`)];
  paint(el, blocks);
}
const inspVisible = () => {
  const el = $(".cai-insp");
  return !!el && getComputedStyle(el).display !== "none";
};

// --------------------------------------------------------- chips, status --

/** The top bar's chips and the sidebar's status box, from the playground's state. */
function drawChrome() {
  const p = S.play;
  const st = p?.state ?? "loading";
  $("#hdr-free").hidden = st !== "in";
  $("#hdr-free-v").textContent = st === "in" ? dollars(p.free?.left_usd) : "";
  const wallet = $("#hdr-wallet");
  wallet.hidden = !p?.account || !["in", "preview-denied"].includes(st);
  $("#hdr-wallet-v").textContent = wallet.hidden ? "" : short(p.account.address);
  // The gateway answers when any of its reads did; the status says how well.
  const gw = S.status?.services?.find((x) => x.id === "gateway")?.state;
  const answering = gw || S.rows || (st !== "down" && st !== "loading") ? true : S.rows === null && st === "down" ? false : null;
  $("#st-gateway").textContent = gw && gw !== "operational" ? gw : answering === null ? "…" : answering ? "live" : "not answering";
  $("#st-gateway-dot").className = answering === false || gw === "down" ? "r" : gw === "degraded" ? "a" : "g";
  $("#st-play").textContent = ({ in: "open", out: "open", preview: "preview", "preview-denied": "preview", off: "opens soon" })[st] ?? "…";
  $("#st-play-dot").className = OPEN.includes(st) ? "g" : "a";
}

function onPlay(snap) {
  S.play = snap;
  drawChrome();
  if (S.tab === "playground") renderInsp();
  if (S.rows) drawTable();
  // The picture list is served only with pictures on: asked for once /v1/free names them.
  if (snap.free?.pictures && S.pics === undefined) {
    S.pics = null;
    void fetchPictureModels().then((pics) => {
      S.pics = pics;
      drawPictures();
    });
  }
  drawPictures();
}

// -------------------------------------------------------------- the tabs --

function showTab() {
  const tab = tabOf(location.hash);
  const changed = tab !== S.tab;
  S.tab = tab;
  for (const a of $$("[data-ai-tab]")) a.setAttribute("aria-selected", String(a.dataset.aiTab === tab));
  for (const p of $$("[data-ai-panel]")) p.hidden = p.dataset.aiPanel !== tab;
  closeDrawer();
  // A bare address, or one this page doesn't know, reads as the first tab without a new entry.
  if (location.hash !== `#/${tab}` && !location.hash.startsWith(`#/${tab}?`)) history.replaceState(null, "", `#/${tab}`);
  if (changed) $("#cai-main").scrollTop = 0;
  renderInsp();
  hostForTab();
  if (tab === "status" && Date.now() - S.statusAt >= STATUS_EVERY_MS) void loadStatus();
}

// ----------------------------------------------------------------- models --

function drawModels() {
  const rows = S.rows ?? [];
  $("#side-count").textContent = rows.length ? String(rows.length) : "";
  if (!rows.length) {
    $("#ai-tiles").hidden = true;
    paint($("#ai-rows"), html`<tr><td colspan="7" class="ai-empty">The model list isn't answering right now. Try again in a moment.</td></tr>`);
    $("#ai-count").textContent = "";
    return;
  }
  $("#ai-q").placeholder = `Search ${rows.length} models`;
  // The count is read live, never written in: the words hold a {n}.
  for (const el of $$("[data-ai-count]")) el.textContent = el.dataset.aiCount.replace("{n}", String(rows.length));
  const makers = [...new Set(rows.map((r) => r.maker))];
  const cheapest = rows.reduce((a, b) => (b.in < a.in ? b : a));
  const withCtx = rows.filter((r) => r.ctx);
  const longest = withCtx.reduce((a, b) => (b.ctx > a.ctx ? b : a), withCtx[0] ?? rows[0]);
  paint($("#ai-tiles"), [
    // Not "all live": the Status column says which answer now (the status book).
    ["Models", String(rows.length), "all priced, status per row"],
    ["Makers", String(makers.length), `${makers[0]} to ${makers.at(-1)}`],
    ["Cheapest input", `${usd(cheapest.in)}/M`, cheapest.id],
    ["Longest context", tokens(longest.ctx), longest.id],
  ].map(([k, v, s]) => html`<div class="ai-tile"><span>${k}</span><b class="num">${v}</b><small>${s}</small></div>`));
  $("#ai-tiles").hidden = false;
  paint($("#ai-quick"), Object.keys(QUICK).map((k) =>
    html`<button type="button" aria-pressed="${String(k === S.quick)}" data-ai-q="${k}">${k}</button>`));
  paint($("#ai-fams"), ["All", ...makers].map((f) =>
    html`<button type="button" aria-pressed="${String(f === S.fam)}" data-ai-fam="${f}">${f} <span class="num">${f === "All" ? rows.length : rows.filter((r) => r.maker === f).length}</span></button>`));
  drawTable();
}

/** The Models tab's picture models (X15c), with each size's price per picture. Hidden while the list isn't served. */
function drawPictures() {
  const rows = S.pics ?? [];
  $("#ai-pics").hidden = !rows.length;
  if (!rows.length) return;
  const freePic = picturesOffered(S.play?.free)?.model ?? null;
  paint($("#ai-pic-rows"), rows.map((r) => html`<tr>
    <td><div class="ai-mcell"><span class="ai-av">${initial(r.maker)}</span><div><b>${r.id}${r.id === freePic ? html`<span class="cai-freetag wide">Free in the playground</span>` : html``}</b><small>${r.maker}</small></div></div></td>
    <td class="r ai-mono">${r.tiers.map(([t, v], i) => html`${i ? " · " : ""}${t === "default" ? "" : `${t} `}${dollars(v)}`)}</td></tr>`));
}

function drawTable() {
  const rows = S.rows ?? [];
  if (!rows.length) return;
  const q = $("#ai-q").value;
  const list = modelView(rows, { quick: S.quick, fam: S.fam, q, sortKey: S.sortKey, sortDir: S.sortDir });
  const { pct, ctx } = scale(rows);
  const bar = (v, w, tone = "") => html`<div class="ai-bar${tone}"><i data-w="${w}"></i><span>${v}</span></div>`;
  const body = $("#ai-rows");
  if (list.length) {
    paint(body, list.map((r) => html`<tr data-ai-id="${r.id}" tabindex="0" aria-selected="${String(r.id === S.selected)}">
      <td><div class="ai-mcell"><span class="ai-av">${initial(r.maker)}</span><div><b>${r.id}${isFree(r.id) ? html`<span class="cai-freetag wide">Free in the playground</span>` : html``}</b><small>${r.maker}</small></div></div></td>
      <td>${stateOf(r.id) ? stp(stateOf(r.id).state) : html`<span class="ai-chev">—</span>`}</td>
      <td class="r">${bar(usd(r.in), pct(r.in))}</td>
      <td class="r">${bar(usd(r.out), pct(r.out), " out")}</td>
      <td class="r">${r.ctx ? bar(tokens(r.ctx), ctx(r.ctx), " ctx") : html`<span class="ai-chev">—</span>`}</td>
      <td class="r ai-mono">${tokens(r.max)}</td>
      <td class="r"><span class="ai-chev" aria-hidden="true">›</span></td></tr>`));
    // Through CSSOM, which the page's policy governs no more than a stylesheet.
    for (const i of $$("i[data-w]", body)) i.style.setProperty("--w", i.dataset.w);
  } else {
    paint(body, html`<tr><td colspan="7" class="ai-empty">No model matches “${q.trim()}” with these filters.</td></tr>`);
  }
  $("#ai-count").textContent = `${list.length} of ${rows.length}`;
  for (const b of $$("[data-ai-sort]")) {
    b.parentElement.setAttribute("aria-sort", b.dataset.aiSort === S.sortKey ? (S.sortDir > 0 ? "ascending" : "descending") : "none");
  }
  if (S.tab === "models") {
    if (!list.length) host("noMatch");
    else if (face === "shock") host("models", rows.length);
  }
}

function selectModel(id, from) {
  const r = rowOf(id);
  if (!r) return;
  S.selected = id;
  for (const tr of $$("#ai-rows tr[data-ai-id]")) tr.setAttribute("aria-selected", String(tr.dataset.aiId === id));
  if (inspVisible()) {
    renderInsp();
    return isFree(id) ? host("pickFree") : host("pick", r.id, usd(r.out));
  }
  openDrawer(r, from);
}

function openDrawer(r, from) {
  S.lastFocus = from ?? document.activeElement;
  const drawer = $("#ai-drawer");
  paint(drawer, html`<div class="ai-dr-top"><span class="ai-av ai-av-lg">${initial(r.maker)}</span><button class="cai-small-btn" type="button" data-ai-close>Close</button></div>
    <h2 id="ai-dr-title">${r.id}</h2>${inspModel(r)}`);
  drawer.hidden = $("#ai-scrim").hidden = false;
  $("[data-ai-close]", drawer).focus();
}

function closeDrawer() {
  const drawer = $("#ai-drawer");
  if (!drawer || drawer.hidden) return;
  drawer.hidden = $("#ai-scrim").hidden = true;
  if (S.lastFocus && document.contains(S.lastFocus)) /** @type {HTMLElement} */ (S.lastFocus).focus();
}

// ----------------------------------------------------------------- status --
//
// C5b (C-D10): only what GET /v1/status says. A model with nothing measured
// is "unknown", and the page says why; nothing is made up.

async function loadStatus() {
  S.statusAt = Date.now();
  S.status = await fetchStatus();
  drawStatus();
  drawChrome();
  if (S.rows) drawTable();
  if (S.tab === "status" || S.tab === "models") renderInsp();
  if (S.tab === "status") statusHost();
}

function statusHost() {
  if (S.status === undefined) return host("loading");
  if (!S.status) return host("statusOff");
  const c = counts(S.status.models);
  if (c.down) return host("statusDown", c.down);
  if (c.degraded) return host("statusSlow", c.degraded);
  if (c.live) return host("statusFine");
  return host("statusUnknown");
}

/** An incident's sentence: a model's, or a service's by its own rule. */
function incidentLine(i) {
  if (i.subject === "moderation") return STATUS.incident.moderationDegraded;
  if (i.subject === "supplier") return i.state === "down" ? STATUS.incident.supplierDown : STATUS.incident.supplierDegraded;
  return STATUS.incident[i.state];
}

function drawStatus() {
  const st = S.status;
  const dot = $("#side-st");
  dot.className = `cai-sdot ${st ? worst(st.models) : "unknown"}`;
  if (st === undefined) return;
  const note = $("#st-note");
  if (!st) {
    note.textContent = STATUS.down;
    for (const id of ["#st-big", "#st-svc", "#st-incidents", "#st-filter"]) paint($(id), html``);
    paint($("#st-rows"), html`<tr><td colspan="5" class="ai-empty">${STATUS.down}</td></tr>`);
    $("#st-count").textContent = "";
    return;
  }
  const c = counts(st.models);
  note.textContent = st.probe.on && st.probe.everyMinutes
    ? `${STATUS.from}, ${STATUS.every(st.probe.everyMinutes)}.`
    : STATUS.noChecks;
  paint($("#st-big"), html`<span class="cai-mono-s">Models right now</span>
    <div class="cai-st-n">${["live", "degraded", "down", "unknown"].map((k) => html`<b class="num ${k}">${String(c[k])}</b><span>${STATUS.label[k]}</span>`)}</div>
    <div class="cai-st-bar">${["live", "degraded", "down", "unknown"].map((k) => html`<i class="${k}" data-n="${String(c[k])}"></i>`)}</div>`);
  // Through CSSOM, as the Models bars: the page's policy allows no inline style.
  for (const i of $$("#st-big i[data-n]")) i.style.setProperty("flex-grow", i.dataset.n);
  paint($("#st-svc"), st.services.map((x) => html`<div class="cai-svc"><i class="cai-sdot ${x.state === "operational" ? "live" : x.state}"></i>
    <b>${STATUS.services[x.id][0]}</b><span>${STATUS.services[x.id][1]}</span><em class="${x.state}">${STATUS.label[x.state] ?? x.state}</em></div>`));
  paint($("#st-incidents"), st.incidents.length
    ? st.incidents.map((i) => html`<div class="cai-inc">${stp(i.state)}<b>${i.subject}</b><span class="cai-inc-w">${incidentLine(i)}</span>
      <em>${i.to ? `${lasted(i.from, i.to)}, over` : `${lasted(i.from, null, st.generatedAt)}, open`}</em></div>`)
    : html`<p class="ai-empty">${STATUS.noIncidents}</p>`);
  paint($("#st-filter"), [["all", "All"], ["live", "Live"], ["degraded", "Degraded"], ["down", "Down"], ["unknown", "Unknown"]].map(([k, n]) =>
    html`<button type="button" aria-pressed="${String(k === S.stFilter)}" data-st-f="${k}">${n} <span class="num">${String(k === "all" ? st.models.length : c[k])}</span></button>`));
  const list = statusView(st.models, S.stFilter);
  const maker = (id) => rowOf(id)?.maker ?? "";
  paint($("#st-rows"), list.length ? list.map((m) => html`<tr data-st-id="${m.id}" tabindex="0">
      <td><div class="ai-mcell"><span class="ai-av">${initial(maker(m.id))}</span><div><b>${m.id}</b><small>${maker(m.id)}</small></div></div></td>
      <td>${stp(m.state)}</td><td class="r ai-mono">${firstToken(m.firstTokenMs)}</td><td class="r ai-mono">${speed(m.tokensPerS)}</td>
      <td class="r ai-mono cai-dim">${ago(m.checkedAt, st.generatedAt)}</td></tr>`)
    : html`<tr><td colspan="5" class="ai-empty">No model is ${STATUS.label[S.stFilter] ?? S.stFilter} right now.</td></tr>`);
  $("#st-count").textContent = `${list.length} of ${st.models.length}`;
}

// ------------------------------------------------------ command palette --

const PAGES = [["Playground", "#/playground"], ["Models", "#/models"], ["Docs", "#/docs"], ["Status", "#/status"], ["Clank Uwu Model, home", "/"], ["cumTrade", "/trade"]];
/**
 * The palette (polished at the user's "Polish also this img"): pages, actions
 * and models, matched on a model's id or maker, never on a group's name.
 * Opened from the model chip, it lists the models alone.
 */
const P = {
  /** @type {{ g: string, n: string, run: () => void, model?: any }[]} */ items: [],
  idx: 0,
  /** @type {Element | null} */ back: null,
  /** "all", or "models" when opened from the model chip. */
  scope: "all",
};

function palActions() {
  /** @type {[string, () => void][]} */
  const acts = [
    ["New chat", () => { location.hash = "#/playground"; S.pg?.newChat(); }],
    ["Copy the base URL", () => { void copy(BASE_URL); }],
  ];
  if (S.play?.account) acts.push(["Sign out", () => { void S.pg?.signOut(); }]);
  return acts;
}

/** Some text with the part that matched marked, every part set as text. */
const marked = (text, hit) => (hit
  ? html`${text.slice(0, hit[0])}<mark>${text.slice(hit[0], hit[1])}</mark>${text.slice(hit[1])}`
  : html`${text}`);

function renderPal() {
  const q = $("#pal-q").value.trim();
  const onlyModels = P.scope === "models";
  /** @param {any[]} entry a page or an action, by its name first */
  const named = (entry) => !!hitIn(entry[0], q);
  const pages = onlyModels ? [] : q ? PAGES.filter(named) : PAGES;
  const acts = onlyModels ? [] : q ? palActions().filter(named) : palActions();
  // With no query, a few to start from: the free model and the live ones. With one, every match.
  const models = paletteModels(S.rows ?? [], (id) => stateOf(id)?.state ?? null, q, onlyModels ? 60 : q ? 12 : 5);
  P.items = [
    ...pages.map(([n, to]) => ({ g: "Go to", n, run: () => { if (to.startsWith("#")) location.hash = to; else location.assign(to); } })),
    ...models.map((m) => ({ g: "Models", n: m.row.id, model: m, run: () => { location.hash = "#/models"; selectModel(m.row.id); } })),
    ...acts.map(([n, f]) => ({ g: "Actions", n, run: f })),
  ];
  P.idx = Math.min(P.idx, Math.max(0, P.items.length - 1));
  const list = $("#pal-list");
  if (!P.items.length) {
    paint(list, html`<div class="cai-pal-empty">Nothing for “${q}”.</div>`);
    return;
  }
  let g = "";
  paint(list, P.items.map((it, i) => {
    const head = it.g !== g ? html`<div class="cai-pal-g">${(g = it.g)}</div>` : html``;
    const m = it.model;
    const body = m
      ? html`<i class="cai-sdot ${m.state}" title="${STATUS.label[m.state]}"></i><span class="cai-pal-id"><span class="cai-pal-n">${marked(m.row.id, m.hit)}</span><small>${m.row.maker}</small></span>${isFree(m.row.id)
        ? html`<span class="cai-freetag">free</span>` : html``}<small class="cai-pal-price">${usd(m.row.in)} / ${usd(m.row.out)}</small>`
      : html`<span class="cai-pal-id"><span class="cai-pal-n">${marked(it.n, hitIn(it.n, q))}</span></span>`;
    return html`${head}<button class="cai-pal-it" type="button" role="option" id="${`pal-${i}`}" data-i="${i}" aria-selected="${String(i === P.idx)}">${body}</button>`;
  }));
  $("#pal-q").setAttribute("aria-activedescendant", `pal-${P.idx}`);
}

/** Open the palette: everything, or the models alone (from the model chip). */
function openPal(scope = "all") {
  P.back = document.activeElement;
  P.scope = scope;
  $("#pal").hidden = $("#pal-scrim").hidden = false;
  $("#pal-q").value = "";
  $("#pal-q").placeholder = scope === "models" ? "Search the models by id or maker" : "Type a model, a maker, a page or an action";
  P.idx = 0;
  renderPal();
  $("#pal-q").focus();
}
function closePal() {
  if ($("#pal").hidden) return;
  $("#pal").hidden = $("#pal-scrim").hidden = true;
  if (P.back && document.contains(P.back)) /** @type {HTMLElement} */ (P.back).focus();
}
function runPal(i) {
  const it = P.items[i];
  closePal();
  it?.run();
}

// ---------------------------------------------------------------- events --

document.addEventListener("input", (e) => {
  const id = /** @type {HTMLElement} */ (e.target).id;
  if (id === "ai-q") drawTable();
  else if (id === "pal-q") { P.idx = 0; renderPal(); }
});
document.addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  const cp = near(t, "[data-copy]");
  if (cp) {
    const was = cp.textContent;
    void copy(cp.dataset.copy).then((ok) => { cp.textContent = ok ? "Copied" : "Select it"; setTimeout(() => { cp.textContent = was; }, 1500); });
    return;
  }
  if (near(t, "[data-act=sign-out]")) return void S.pg?.signOut();
  if (near(t, "#cmdk-open")) return openPal();
  if (near(t, "#pg-model")) return openPal("models");
  if (t.id === "pal-scrim") return closePal();
  const pi = near(t, ".cai-pal-it");
  if (pi) return runPal(Number(pi.dataset.i));
  const sf = near(t, "[data-st-f]");
  if (sf) { S.stFilter = sf.dataset.stF; return drawStatus(); }
  const st = near(t, "tr[data-st-id]");
  if (st) { location.hash = "#/models"; selectModel(st.dataset.stId); return; }
  const qb = near(t, "[data-ai-q]");
  if (qb) { S.quick = qb.dataset.aiQ; for (const b of $$("[data-ai-q]")) b.setAttribute("aria-pressed", String(b === qb)); return drawTable(); }
  const fb = near(t, "[data-ai-fam]");
  if (fb) { S.fam = fb.dataset.aiFam; for (const b of $$("[data-ai-fam]")) b.setAttribute("aria-pressed", String(b === fb)); return drawTable(); }
  const sb = near(t, "[data-ai-sort]");
  if (sb) { const k = sb.dataset.aiSort; S.sortDir = S.sortKey === k ? -S.sortDir : 1; S.sortKey = k; return drawTable(); }
  const tr = near(t, "tr[data-ai-id]");
  if (tr) return selectModel(tr.dataset.aiId, tr);
  if (near(t, "[data-ai-close]") || t.id === "ai-scrim") return closeDrawer();
  // Docs: the contents jump to a section, the code tabs switch language, Copy copies the one shown.
  const jump = near(t, "[data-ai-jump]");
  if (jump) {
    e.preventDefault();
    if (S.tab !== "docs") location.hash = "#/docs";
    document.getElementById(jump.dataset.aiJump)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    return;
  }
  const set = near(t, "[data-ai-codeset]");
  const lang = near(t, "button[data-ai-lang]");
  if (set && lang) {
    for (const b of $$("button[data-ai-lang]", set)) b.setAttribute("aria-selected", String(b === lang));
    for (const p of $$("pre[data-ai-lang]", set)) p.hidden = p.dataset.aiLang !== lang.dataset.aiLang;
    return;
  }
  const cpy = near(t, "[data-ai-copy]");
  if (set && cpy) {
    const pre = $$("pre[data-ai-lang]", set).find((p) => !p.hidden);
    void copy(pre?.textContent ?? "").then((ok) => { cpy.textContent = ok ? "Copied" : "Select and copy"; setTimeout(() => { cpy.textContent = "Copy"; }, 1800); });
  }
});
document.addEventListener("keydown", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (e.key === "Escape") { closePal(); closeDrawer(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if ($("#pal").hidden) openPal(); else closePal();
    return;
  }
  if (t.id === "pal-q") {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(1, P.items.length);
      P.idx = (P.idx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderPal();
      $(`#pal-${P.idx}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPal(P.idx);
    }
    return;
  }
  const tr = near(t, "tr[data-ai-id]");
  if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectModel(tr.dataset.aiId, tr); return; }
  const sr = near(t, "tr[data-st-id]");
  if (sr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); location.hash = "#/models"; selectModel(sr.dataset.stId); return; }
  const typing = /input|textarea|select/i.test(t?.tagName ?? "") || !$("#pal").hidden;
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/" && S.tab === "playground") { e.preventDefault(); S.pg?.focus(); }
  else if (e.key === "p" || e.key === "P") location.hash = "#/playground";
  else if (e.key === "m" || e.key === "M") location.hash = "#/models";
  else if (e.key === "d" || e.key === "D") location.hash = "#/docs";
});
addEventListener("hashchange", showTab);

// ------------------------------------------------------------------ boot --

/** The visitor's own wallets, once found: the chooser's, and the session's for a wallet login. */
const own = { list: null };
const login = createLogin({ wallets: () => own.list ?? [] });
S.pg = createPlayground({
  root: $("[data-ai-panel=playground]"),
  gateway: createGateway(),
  login,
  own,
  host,
  onChange: onPlay,
  active: () => S.tab === "playground",
});
showTab();
drawChrome();
void S.pg.refresh();
// cumOS's session, here too (C5c): a remembered login, or a return from Google or X.
void login.session.boot();
void loadStatus();
void fetchModels().then((rows) => {
  S.rows = rows;
  drawModels();
  drawChrome();
  // The status's rows name each model's maker from this list.
  if (S.status) drawStatus();
  renderInsp();
  if (S.tab !== "playground") hostForTab();
});
