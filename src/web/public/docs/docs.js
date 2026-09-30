// The project docs (PD): the live model count, the contents that follow the
// reading, and the contract's copy button. Everything is set as text; nothing
// builds markup.
import { fetchModels, fillCount, summarize } from "../landing/live.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// The live count: the words stand until the gateway answers.
fetchModels().then((body) => {
  const live = summarize(body);
  if (!live) return;
  for (const el of $$("[data-count-tpl]")) el.textContent = fillCount(el.dataset.countTpl, live.count);
});

// Copy: the clipboard when the browser allows it, else select the address.
for (const b of $$("[data-copy]")) {
  b.addEventListener("click", () => {
    const done = (w) => { b.textContent = w; setTimeout(() => { b.textContent = "Copy"; }, 1600); };
    const select = () => {
      const code = b.closest(".addr")?.querySelector("code");
      if (!code) return;
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done("Selected");
    };
    try { navigator.clipboard.writeText(b.dataset.copy).then(() => done("Copied"), select); }
    catch { select(); }
  });
}

// Contents: light the section being read, in the rail and the phone menu.
const links = $$(".toc a[href^='#'], .toc-m a[href^='#']");
const sections = [...new Set(links.map((a) => a.getAttribute("href")))].map((h) => $(h)).filter(Boolean);
const now = $("#toc-m-now");
const label = Object.fromEntries($$(".toc-m a").map((a) => [a.getAttribute("href").slice(1), a.textContent]));
let current = "";
const light = (id) => {
  if (id === current) return;
  current = id;
  for (const a of links) {
    if (a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  }
  if (now) now.textContent = label[id] ?? "";
};
let queued = false;
const pick = () => {
  queued = false;
  if (!sections.length) return;
  const line = ($(".nav")?.offsetHeight ?? 68) + 72;
  let at = sections[0];
  for (const s of sections) if (s.getBoundingClientRect().top <= line) at = s;
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) at = sections[sections.length - 1];
  light(at.id);
};
addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(pick); } }, { passive: true });
addEventListener("resize", pick);
pick();

// The phone menu closes once a section is picked.
const menu = $("#toc-m");
menu?.addEventListener("click", (e) => { if (e.target.closest("nav a")) menu.open = false; });
