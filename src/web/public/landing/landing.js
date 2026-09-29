// Companion-first landing: model data, legacy navigation and local avatar footage.
import { fetchModels, fillCount, forwardTarget, summarize, tokens, usd } from "./live.js";

// An old link to the app goes to the app (N-D7), before anything else runs,
// and so does one pasted into the address bar while the landing is open.
const forward = forwardTarget(location.hash);
if (forward) location.replace(forward);
else start();
addEventListener("hashchange", () => {
  const to = forwardTarget(location.hash);
  if (to) location.replace(to);
});

function start() {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- the live count and prices ---------- */
  fetchModels().then((body) => {
    const live = summarize(body);
    if (!live) return;
    for (const el of $$("[data-count-tpl]")) el.textContent = fillCount(el.dataset.countTpl, live.count);
    if (live.featured.length === 0) return;
    // Built from text, never from markup: the ids come over the network.
    const cell = (text, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = text; return td; };
    $("#featured").replaceChildren(...live.featured.map((m) => {
      const tr = document.createElement("tr");
      tr.append(cell(m.id, "mid"), cell(m.maker, "fam"), cell(usd(m.input), "r"), cell(usd(m.output), "r"), cell(tokens(m.context), "r"));
      return tr;
    }));
    $("#prices").hidden = false;
  });

  /* ---------- code tabs + copy ---------- */
  const selectText = (el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  $$("[data-codeset]").forEach((set) => set.addEventListener("click", (e) => {
    const t = e.target.closest("button[data-lang]");
    if (t) {
      $$("button[data-lang]", set).forEach((b) => b.setAttribute("aria-selected", String(b === t)));
      $$("pre[data-lang]", set).forEach((p) => { p.hidden = p.dataset.lang !== t.dataset.lang; });
    }
    const c = e.target.closest("[data-copy]");
    if (c) {
      const pre = $$("pre[data-lang]", set).find((p) => !p.hidden);
      const done = (ok) => { c.textContent = ok ? "Copied" : "Selected, press Ctrl+C"; setTimeout(() => { c.textContent = "Copy"; }, 1800); };
      try { navigator.clipboard.writeText(pre.textContent).then(() => done(true), () => { selectText(pre); done(false); }); }
      catch { selectText(pre); done(false); }
    }
  }));

  /* ---------- nav world: light over the sky, dark from dusk on ---------- */
  const nav = $("#nav");
  const onScroll = () => {
    nav.classList.toggle("scrolled", scrollY > 12);
    const y = nav.offsetHeight / 2, d = $(".dusk").getBoundingClientRect();
    const dark = $("#dark").getBoundingClientRect().top <= y || (d.top <= y && y - d.top > d.height * 0.7);
    nav.dataset.world = dark ? "dark" : "light";
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- local avatar: visible, muted, pausable, reduced-motion aware ---------- */
  const video = $("#cumos-video"), motion = $("#cumos-motion");
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let userWantsMotion = !preference.matches, visible = false;
  video.muted = true;
  motion.hidden = false;
  const label = () => { motion.textContent = video.paused ? "Play animation" : "Pause animation"; };
  const sync = () => {
    if (userWantsMotion && visible && !document.hidden) video.play().catch(label);
    else video.pause();
  };
  video.addEventListener("play", label);
  video.addEventListener("pause", label);
  video.addEventListener("error", () => { motion.hidden = true; });
  motion.addEventListener("click", () => { userWantsMotion = video.paused; sync(); });
  preference.addEventListener("change", () => { userWantsMotion = !preference.matches; sync(); });
  document.addEventListener("visibilitychange", sync);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0.15 }).observe(video);
  label();
}
