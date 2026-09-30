// The homepage (CP3): the live model count, the savings calculator, the nav's
// light and dark, Yuna's greeting animation (the live cumOS section), and the
// $CUM contract's copy button. Everything is set as text; nothing builds markup.
import { calculatorRows, dollars, fetchModels, fillCount, forwardTarget, livePrices, monthCost, summarize } from "./live.js";
import { PRICE_BOOK } from "./prices.js";

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

  /* ---------- the live count: the words stand until the gateway answers ---------- */
  const gateway = fetchModels();
  gateway.then((body) => {
    const live = summarize(body);
    if (!live) return;
    for (const el of $$("[data-count-tpl]")) el.textContent = fillCount(el.dataset.countTpl, live.count);
  });

  /* ---------- nav world: light over the sky and cumAI, dark from the dusk on ---------- */
  const nav = $("#nav");
  const onScroll = () => {
    nav.classList.toggle("scrolled", scrollY > 12);
    const y = nav.offsetHeight / 2, d = $(".dusk").getBoundingClientRect();
    const dark = $("#dark").getBoundingClientRect().top <= y || (d.top <= y && y - d.top > d.height * 0.7);
    nav.dataset.world = dark ? "dark" : "light";
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Yuna's greeting: visible, muted, pausable, reduced-motion aware ---------- */
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

  /* ---------- the calculator: official prices from the book, cumAI's live when the gateway answers ---------- */
  const form = $("#calc"), select = $("#calc-model");
  if (form && select) {
    let rows = calculatorRows(PRICE_BOOK, null);
    const fill = () => {
      const keep = select.value || "claude-sonnet-5";
      const groups = new Map();
      select.replaceChildren();
      for (const [id, mk] of rows) {
        if (!groups.has(mk)) { const g = document.createElement("optgroup"); g.label = mk; groups.set(mk, g); select.append(g); }
        const o = document.createElement("option"); o.value = id; o.textContent = id; groups.get(mk).append(o);
      }
      select.value = rows.some(([id]) => id === keep) ? keep : (rows[0]?.[0] ?? "");
    };
    const show = () => {
      const row = rows.find(([id]) => id === select.value);
      if (!row) return;
      const m = monthCost(row[2], row[3], Number($("#calc-in").value), Number($("#calc-out").value));
      $("#c-off").textContent = dollars(m.official);
      $("#c-ours").textContent = dollars(m.ours);
      $("#c-save").textContent = m.save > 0 ? `${dollars(m.save)} a month` : "Nothing on this model";
      $("#c-year").textContent = m.save > 0 ? `${dollars(m.save * 12)} a year · ${m.pct}% less` : "";
    };
    fill();
    show();
    form.addEventListener("input", show);
    form.addEventListener("submit", (e) => e.preventDefault());
    gateway.then((body) => {
      const live = livePrices(body);
      if (!live) return;
      rows = calculatorRows(PRICE_BOOK, live);
      fill();
      show();
      const note = $("#calc-live");
      if (note) note.textContent = "cumAI prices are live from the gateway.";
    });
  }

  /* ---------- copy the $CUM contract; select it if the clipboard is refused ---------- */
  const copy = $("#copy-addr");
  if (copy) {
    copy.addEventListener("click", () => {
      const done = (text) => { copy.textContent = text; setTimeout(() => { copy.textContent = "Copy"; }, 1800); };
      const select = () => {
        const range = document.createRange();
        range.selectNodeContents(copy.previousElementSibling);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      };
      try {
        navigator.clipboard.writeText(copy.dataset.addr).then(() => done("Copied"), () => { select(); done("Selected"); });
      } catch { select(); done("Selected"); }
    });
  }
}
