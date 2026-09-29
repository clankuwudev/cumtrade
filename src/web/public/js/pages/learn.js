import { S } from "../core/store.js";
import { $, $$, html, paint } from "../core/dom.js";
import { aboutSections, isAboutSection } from "./about.js";

// ====================================================================== //
// Learn (u-redesign.md, U6)                                              //
// ====================================================================== //
//
// One docs page for two of app.html's sections: How it works (#pg-flow, the
// Flow page, every word and drawing) and About's sections (#pg-about). Both
// sit in one .learn grid beside one table of contents, and the router shows
// whichever the address names.
//
// About stays one long page, as its tests pin it: a contents link goes to
// #/learn/<id>, the router scrolls to that section, and the entry lights as
// its section scrolls by. The console has no About, so its Learn is How it
// works alone, with no contents beside it.

/** Learn's first section: the Flow page. */
export const HOW_IT_WORKS = "how-it-works";

/** About's sections that go under Legal rather than About. */
const LEGAL = ["terms", "privacy"];
/** About's sections that go under Developers: the data API's docs (X21). */
const DEVELOPERS = ["api"];

/** The contents in four groups. The About entries are About's own sections, labels and all. */
export const learnGroups = () => {
  /** @type {{ id: string, label: string, href?: string }[]} */
  const about = aboutSections().map(({ id, label }) => ({ id, label }));
  const elsewhere = [...LEGAL, ...DEVELOPERS];
  return [
    { title: "Learn", items: [{ id: HOW_IT_WORKS, label: "How it works" }] },
    { title: "About", items: about.filter((s) => !elsewhere.includes(s.id)) },
    // cumAI's API docs sit beside the data API's (X20 A11, L1 L4), on their own page.
    { title: "Developers", items: [...about.filter((s) => DEVELOPERS.includes(s.id)), { id: "ai-api", label: "AI API", href: "/ai#/docs" }] },
    { title: "Legal", items: about.filter((s) => LEGAL.includes(s.id)) },
  ];
};

/** The address of a contents entry. About's first section is the page's top, #/learn. */
export const learnHref = (id) => (id === "what" ? "#/learn" : "#/learn/" + id);

/** The contents as markup, `current` lit. */
export const learnToc = (current) => html`${learnGroups().map((g) => html`
  <p class="tocg">${g.title}</p>${g.items.map((s) => html`
  <a href="${s.href ?? learnHref(s.id)}" data-sec="${s.id}"${s.id === current ? html` aria-current="location"` : ""}>${s.label}</a>`)}`)}`;

/** The entry the address named, which the scroll-spy keeps when the page cannot scroll it to the top. */
let named = HOW_IT_WORKS;

/**
 * Draw the contents for the page the router shows: How it works on the Flow
 * page, and on About the section the address names (#/learn/terms), or About
 * itself. A self page has no contents.
 *
 * @param {string} page "flow" or "about"
 * @param {string} [arg] the section after #/learn/
 */
export function renderLearn(page, arg = "") {
  const toc = $("#learntoc");
  if (!toc) return;
  if (S.mode !== "hosted") { paint(toc, ""); return; }
  named = page === "flow" ? HOW_IT_WORKS : isAboutSection(arg) ? arg : "what";
  paint(toc, learnToc(named));
  showLit(named);
}

/** Light one entry, and keep it in view in the phone's strip without moving the page. */
function light(id) {
  for (const a of $$("#learntoc a")) {
    if (a.dataset.sec === id) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  }
  showLit(id);
}

function showLit(id) {
  const toc = $("#learntoc");
  const a = $(`#learntoc a[data-sec="${id}"]`);
  if (!a || !(toc.scrollWidth > toc.clientWidth)) return;
  toc.scrollLeft = a.offsetLeft - (toc.clientWidth - a.offsetWidth) / 2;
}

/** Room under the sticky top bar where a section counts as the one being read. */
const readLine = () => ($("#top")?.offsetHeight ?? 58) + 32;

/**
 * Which About section is being read: the last whose top has passed under the
 * top bar. At the foot of the page, where the last few cannot reach the top,
 * the one the address named wins while it is in view.
 */
function reading() {
  const secs = aboutSections();
  const line = readLine();
  let at = secs[0]?.id ?? "what";
  for (const s of secs) {
    const el = $("#about-" + s.id);
    if (el && el.getBoundingClientRect().top <= line) at = s.id;
  }
  const foot = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  const pinned = foot && isAboutSection(named) && $("#about-" + named);
  if (pinned) {
    const r = pinned.getBoundingClientRect();
    if (r.bottom > line && r.top < window.innerHeight) at = named;
  }
  return at;
}

/**
 * Once, at boot: the scroll-spy on About, and a contents link to the section
 * the address already names, which is no hash change, scrolling to it again.
 */
export function bindLearn(go) {
  let queued = false;
  const spy = () => {
    queued = false;
    if (S.mode === "hosted" && $("#shell").dataset.page === "about") light(reading());
  };
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
  window.addEventListener("scroll", later, { passive: true });
  window.addEventListener("resize", later, { passive: true });
  $("#learntoc")?.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || a.getAttribute("href") !== location.hash) return;
    e.preventDefault();
    go(location.hash.slice(2), false);
  });
}
