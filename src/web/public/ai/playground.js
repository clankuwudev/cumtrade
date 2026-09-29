// cumAI's Playground (stage C, C5; X20 A8, A9; C-D3 to C-D5): sign in with
// a wallet, and chat with the free model, a little each day. It draws its
// panel for each state playState() names, and tells the page (the host, the
// chips, the inspector) what changed through `onChange`.
//
// - A reply is set as text, never as HTML, and code fences get a monospace
//   block: no answer can put a live link or a script on the page.
// - A recovery phrase is stopped here, before it leaves (F12); the gateway
//   checks again.
// - One reply at a time: the box is disabled while one streams, and Stop
//   ends it. The history sent is the newest turns that fit (A8).
// - Nothing is saved: a reload or a closed tab clears the chat.
// - Picture mode (X15c), when the gateway offers free pictures: a prompt and
//   a shape make one picture, drawn from a blob: URL once its bytes are an
//   image, with Download. The URLs are revoked when the thread is cleared.
import { $, $$, html, paint } from "../js/core/dom.js";
import { maker } from "../landing/live.js";
import { GatewayRefusal, HISTORY_BYTES, PICTURE_PROMPT_CHARS, PICTURE_SIZES, trimHistory } from "./gateway.js";
import { initial } from "./models.js";
import { addCall, dollars, emptySession, kb, looksLikePhrase, picturesLeft, picturesOffered, picturesPerDay, playState, replyParts, short } from "./state.js";
import { discoverOwn, ownAccount, ownSigner, tradingSigner } from "./wallets.js";
import { ACTIONS, PICTURE, PLAY, SUGGEST, SUGGEST_PICTURES, refusal, tooLong } from "./words.js";


/** Set before Google or X take the visitor away, so the sign-in carries on when they come back. This tab only. */
export const AFTER_LOGIN = "cumai.after-login";

/**
 * @param {{
 *   root: HTMLElement,
 *   gateway: ReturnType<typeof import("./gateway.js").createGateway>,
 *   login: ReturnType<typeof import("./login.js").createLogin>,
 *   own: { list: { uuid: string, name: string, provider: any }[] | null },
 *   host: (name: string, ...args: unknown[]) => void,
 *   onChange: (snapshot: object) => void,
 *   active: () => boolean,
 * }} o
 */
export function createPlayground({ root, gateway, login, own, host, onChange, active }) {
  const body = $("#pg-body", root);
  const S = {
    /** @type {any} */ free: undefined,
    /** @type {any} */ account: null,
    state: "loading",
    chooser: false,
    /** @type {{ address: string, sign: (m: string) => Promise<string> } | null} */ trading: null,
    /** The trading wallet's address when last logged in, to know a logout of it. */
    /** @type {string | null} */ lastTrading: null,
    signing: false,
    /** @type {{ role: string, content: string }[]} */ history: [],
    session: emptySession(),
    /** @type {{ tokens: number | null, cost: number | null, secs: number } | null} */ last: null,
    /** @type {AbortController | null} */ streaming: null,
    /** @type {string | null} */ failed: null,
    /** @type {any} */ carried: null,
    /** "text" or "picture" (X15c). */
    mode: "text",
    /** The shape the next picture is asked for. */
    ratio: PICTURE_SIZES[0],
    /** @type {AbortController | null} */ making: null,
    /** @type {string | null} */ picFailed: null,
    /** The pictures' blob: URLs, revoked when their thread is cleared. */
    /** @type {string[]} */ urls: [],
  };
  const offer = () => (S.state === "in" ? picturesOffered(S.free) : null);
  const picMode = () => S.mode === "picture" && !!offer();
  const perDay = () => picturesPerDay(offer());
  /** Whole pictures left today, or null before the gateway says (or when what it says can't be so). */
  const picsLeft = () => picturesLeft(offer());
  const busy = () => !!S.streaming || !!S.making;
  /** The free model's id, as the gateway names it, or null before it answers. */
  const freeModel = () => (typeof S.free?.model === "string" ? S.free.model : null);
  const model = () => freeModel() ?? "the free model";

  const tell = () => onChange({
    state: S.state, free: S.free, account: S.account, session: S.session, last: S.last, model: freeModel(), streaming: busy(), mode: S.mode,
  });

  /** Her line for this state, when the Playground is the tab shown. */
  function hostLine() {
    if (!active()) return;
    const st = S.state;
    if (st === "in" && picMode()) return picsLeft() === 0 ? host("noPictures") : host("pictures", picsLeft() ?? perDay());
    if (st === "in") return host("in", dollars(S.free?.left_usd));
    if (st === "preview-denied") return host("previewDenied");
    if (st === "out" || (S.chooser && st === "preview")) return host("out");
    if (st === "preview") return host("preview");
    if (st === "loading") return host("loading");
    if (st === "down") return host("down");
    return host("off");
  }

  // --------------------------------------------------------- the bar --

  function drawBar() {
    const p = offer();
    if (!p && S.mode === "picture") S.mode = "text";
    const m = picMode() ? p.model : freeModel();
    $("#pg-model-av", root).textContent = m ? initial(maker(m)) : "·";
    $("#pg-model-id", root).textContent = m ?? "The free model";
    $("#pg-model-sub", root).textContent = m ? `${maker(m)} · ${picMode() ? "free pictures" : "the free model"}` : "—";
    const modes = $("#pg-mode", root);
    modes.hidden = !p;
    if (p) {
      paint(modes, PICTURE.modes.map(([k, label]) => html`<button type="button" data-pg-mode="${k}" aria-pressed="${String(S.mode === k)}" ${busy() ? "disabled" : ""}>${label}</button>`));
    }
    const left = $("#pg-left", root);
    left.hidden = S.state !== "in";
    left.textContent = S.state !== "in" ? "" : picMode()
      ? PICTURE.left(picsLeft() ?? perDay(), perDay()) : PLAY.left(dollars(S.free.left_usd));
    $("#pg-new", root).hidden = S.state !== "in";
    const out = $("#pg-out", root);
    out.hidden = !S.account || !["in", "preview-denied"].includes(S.state);
    $("#pg-who", root).textContent = out.hidden ? "" : short(S.account.address);
  }

  // ------------------------------------------------------- the states --

  const center = (tag, title, line, extra = html``) => html`<div class="cai-center"><div class="cai-center-in">
    <span class="cai-mono-s">${tag}</span><h3>${title}</h3>${line ? html`<p>${line}</p>` : html``}${extra}</div></div>`;
  const noteSlot = html`<div class="cai-notes" id="pg-notes"></div>`;

  function drawOff(extra = html``) {
    paint(body, center(PLAY.offTag, PLAY.offTitle, PLAY.offLine, html`<div class="cai-center-acts">
      <a class="cai-btn cai-btn-light" href="#/models">Models</a><a class="cai-btn cai-btn-ghost" href="#/docs">Docs</a></div>${extra}${noteSlot}`));
  }

  /**
   * The trading wallet's part of the chooser: sign in with it when logged in,
   * or log in to it here, as on cumOS (C5c), with Google, X or a wallet.
   */
  function tradingPart() {
    const l = login.state.login;
    const wallets = own.list ?? [];
    if (!l.here) return html`<p class="cai-small">${PLAY.tradingNowhere}</p>`;
    if (S.trading) return html`<button type="button" data-pg="trading"><span>Trading wallet</span><code>${short(S.trading.address)}</code></button>`;
    if (l.phase !== "idle") return html`<button type="button" disabled><span>Trading wallet</span><code>${PLAY.tradingBusy}</code></button>`;
    return html`<div class="cai-pick-group"><span class="cai-mono-s">${PLAY.tradingLogIn}</span><div class="cai-pick-row">
      <button type="button" data-pg="login" data-method="google">Google</button><button type="button" data-pg="login" data-method="x">X</button>${wallets.map((w) =>
        html`<button type="button" data-pg="login" data-method="wallet" data-uuid="${w.uuid}">${w.name}</button>`)}</div></div>`;
  }

  function drawChooser() {
    const ownRows = own.list === null
      ? html`<button type="button" disabled><span>Your wallet</span><code>…</code></button>`
      : own.list.length
        ? own.list.map((w, i) => html`<button type="button" data-pg="own" data-i="${i}"><span>${w.name}</span><code>Your wallet</code></button>`)
        : html`<p class="cai-small">${PLAY.ownNone}</p>`;
    paint(body, center(PLAY.outTag, PLAY.outTitle, PLAY.outLine, html`<div class="cai-pick">${tradingPart()}
      <span class="cai-mono-s cai-pick-h">${PLAY.ownHead}</span>${ownRows}</div>
      <p class="cai-small">${PLAY.outTerms} <a href="/trade#/learn/terms" class="cai-lnk">terms</a>.</p>${noteSlot}`));
    carryNote();
  }

  function drawChat() {
    paint(body, html`<div class="cai-thread" id="pg-thread"></div><div class="cai-thread" id="pg-pics" hidden></div>
      <div class="cai-dock"><form class="cai-composer" id="pg-form">
        <p class="cai-warn" role="note"><span class="cai-warn-i" aria-hidden="true">!</span><span><b>${PLAY.warn[0]}</b> ${PLAY.warn[1]}</span></p>
        <div class="cai-box"><label for="pg-prompt" class="sr" id="pg-prompt-l">Message</label><textarea id="pg-prompt" rows="2" placeholder="${`Message ${model()}`}"></textarea>
          <div class="cai-box-foot"><span class="cai-hint" id="pg-hint">${PLAY.hint}</span><div class="cai-shapes" id="pg-shapes" role="group" aria-label="${PICTURE.shape}" hidden>${PICTURE_SIZES.map((r) =>
            html`<button type="button" data-pg-ratio="${r}" aria-pressed="${String(r === S.ratio)}">${r}</button>`)}</div><span class="cai-bytes num" id="pg-bytes" hidden></span><button class="cai-send" type="submit" id="pg-send" disabled>Send</button></div></div>
        <p class="cai-under" id="pg-under">${PLAY.under}</p>
      </form></div>`);
    drawFresh();
    drawFreshPics();
    applyMode();
  }

  /** The composer and the thread shown, for the mode: chat's, or Picture mode's (X15c). */
  function applyMode() {
    const pic = picMode();
    const th = $("#pg-thread", root), pics = $("#pg-pics", root), ta = $("#pg-prompt", root);
    if (!th || !pics || !ta) return;
    th.hidden = pic;
    pics.hidden = !pic;
    $("#pg-shapes", root).hidden = !pic;
    $("#pg-hint", root).hidden = pic;
    $("#pg-prompt-l", root).textContent = pic ? PICTURE.placeholder : "Message";
    ta.placeholder = pic ? PICTURE.placeholder : `Message ${model()}`;
    $("#pg-under", root).textContent = pic ? PICTURE.label : PLAY.under;
    for (const b of $$("[data-pg-ratio]", root)) b.setAttribute("aria-pressed", String(b.dataset.pgRatio === S.ratio));
    setBusy(busy());
  }

  /** Picture mode's empty thread: a start, and anything that stops a picture before one is asked. */
  function drawFreshPics() {
    const th = $("#pg-pics", root);
    if (!th) return;
    const p = offer();
    paint(th, html`<div class="cai-suggest"><span class="cai-mono-s">${PICTURE.newTag(p?.model ?? "the picture model")}</span><h3>${PICTURE.newTitle}</h3><p>${PICTURE.newLine(perDay())}</p>
      <div class="cai-sugs">${SUGGEST_PICTURES.map((s) => html`<button type="button" data-sug>${s}</button>`)}</div></div>`);
    if (picsLeft() === 0) notice(th, refusal({ code: "free_allowance_used" }, { picture: true, perDay: perDay() }));
    else if (p?.open === false) notice(th, refusal({ code: "free_tier_exhausted" }));
  }

  /** Every picture's URL let go, and Picture mode's thread started again. */
  function clearPictures() {
    for (const u of S.urls) URL.revokeObjectURL(u);
    S.urls = [];
    S.picFailed = null;
    drawFreshPics();
  }

  /** The empty thread: a start, and anything the gateway says before a first message (F7, the budget). */
  function drawFresh() {
    const th = $("#pg-thread", root);
    if (!th) return;
    paint(th, html`<div class="cai-suggest"><span class="cai-mono-s">${PLAY.newTag(model())}</span><h3>${PLAY.newTitle}</h3><p>${PLAY.newLine}</p>
      <div class="cai-sugs">${SUGGEST.map((s) => html`<button type="button" data-sug>${s}</button>`)}</div></div>`);
    const f = S.free;
    if (f?.eligible === false) {
      const code = f.reason === "ip_limit" ? "free_tier_ip_limit" : f.reason === "chain_unavailable" ? "chain_unavailable" : "free_tier_not_eligible";
      notice(th, refusal({ code }));
    } else if (f?.open === false) {
      notice(th, refusal({ code: "free_tier_exhausted", extra: { opens_at: f.opens_at } }));
    }
  }

  function draw() {
    drawBar();
    const st = S.state;
    if (st === "loading") paint(body, center("Playground", PLAY.loadingTitle, ""));
    else if (st === "down") {
      paint(body, center("Playground", refusal({ code: "network" }).say, "", html`${noteSlot}<div class="cai-center-acts"><button class="cai-btn cai-btn-light" type="button" data-pg="${ACTIONS.RETRY}">Retry</button></div>`));
    } else if (st === "off") drawOff();
    else if (st === "preview") {
      if (S.chooser) drawChooser();
      else drawOff(html`<p class="cai-small">${PLAY.previewAsk} <button class="cai-linkbtn" type="button" data-pg="show-signin">Sign in</button></p>`);
    } else if (st === "preview-denied") {
      drawOff(html`<p class="cai-small">${PLAY.previewDenied(short(S.account?.address))} <button class="cai-linkbtn" type="button" data-pg="sign-out">Sign out</button></p>`);
    } else if (st === "out") drawChooser();
    else if (st === "in" && !$("#pg-form", root)) drawChat();
    else if (st === "in") applyMode();
    hostLine();
    tell();
  }

  // --------------------------------------------------------- the notes --

  /** A refusal: its one sentence, when it clears, and its one action. */
  function notice(into, r) {
    const act = r.action === ACTIONS.SIGN_IN ? "Sign in"
      : r.action === ACTIONS.NEW_CHAT ? "New chat"
        : r.action === ACTIONS.RETRY_PICTURE ? "Try again (uses a picture)"
        : r.action === ACTIONS.RETRY ? "Retry"
          : r.action === ACTIONS.ADD_ETH ? "How to add ETH" : null;
    const el = document.createElement("div");
    el.className = "cai-notice";
    el.setAttribute("role", "alert");
    paint(el, html`<p>${r.say}${r.when ? html` <span class="cai-when">Clears at ${r.when}.</span>` : html``}</p>
      ${act ? html`<button class="cai-small-btn" type="button" data-pg="${r.action}">${act}</button>` : html``}`);
    into.append(el);
    el.scrollIntoView?.({ block: "nearest" });
    return el;
  }

  /** A refusal outside the chat: in the state's own notes. */
  function centerNote(e) {
    const slot = $("#pg-notes", root);
    if (!slot) return;
    slot.replaceChildren();
    notice(slot, refusal(e));
  }

  /** A session that ended mid-chat: its note is shown again once the sign-in is drawn. */
  function carryNote() {
    if (!S.carried) return;
    const e = S.carried;
    S.carried = null;
    centerNote(e);
  }

  // ---------------------------------------------------------- the chat --

  /**
   * One turn of the conversation (polished at the user's "polish this also"):
   * a small header over it (the model's mark and id, or "you"), then the
   * words. Yours sit on the right in a bubble; the model's on the left, at a
   * readable measure.
   */
  function turn(th, who, cls) {
    const el = document.createElement("div");
    el.className = `cai-turn ${cls}`;
    const head = cls === "model"
      ? html`<div class="cai-turn-h"><span class="ai-av cai-turn-av" aria-hidden="true">${initial(maker(who))}</span><span class="cai-who">${who}</span></div>`
      : html`<div class="cai-turn-h"><span class="cai-who">${who}</span></div>`;
    paint(el, html`${head}<div class="cai-body"></div>`);
    th.append(el);
    return el;
  }

  /** The prompt each reply answered, for its Retry. */
  const promptOf = new WeakMap();

  /** A reply's text, as text: prose, and code in a monospace block. */
  function paintReply(el, text, typing) {
    const nodes = replyParts(text).map((p) => {
      const n = document.createElement(p.code ? "pre" : "span");
      if (p.code) n.className = "cai-pre";
      n.textContent = p.text;
      return n;
    });
    if (typing) {
      const caret = document.createElement("span");
      caret.className = "cai-caret";
      nodes.push(caret);
    }
    el.replaceChildren(...nodes);
  }

  /**
   * Under a reply, one quiet line: its tokens, cost and time, then Copy, and
   * Retry on the newest reply only (it resends that prompt). The actions show
   * on hover and focus, and always on a touch screen.
   */
  function meta(el, { tokens, cost, secs, stopped }, prompt) {
    const m = document.createElement("div");
    m.className = "cai-meta";
    const facts = [tokens == null ? null : `${tokens} tokens`, cost == null ? null : dollars(cost), `${secs.toFixed(1)} s`, stopped ? "stopped" : null]
      .filter(Boolean).join(" · ");
    paint(m, html`<span>${facts}</span><span class="cai-meta-acts"><button type="button" data-pg="copy-reply">Copy</button><button type="button" data-pg="retry-reply">Retry</button></span>`);
    el.append(m);
    promptOf.set(el, prompt);
    for (const b of $$("[data-pg=retry-reply]", root)) if (!el.contains(b)) b.remove();
  }

  function setBusy(on) {
    const send = $("#pg-send", root), ta = $("#pg-prompt", root);
    if (!send || !ta) return;
    // A picture can't be stopped: once asked for, it is made and counts.
    send.textContent = S.making ? PICTURE.making : S.streaming ? "Stop" : picMode() ? PICTURE.make : "Send";
    send.classList.toggle("stop", !!S.streaming);
    ta.disabled = on;
    $("#pg-new", root).disabled = on;
    for (const b of $$("[data-pg-mode], [data-pg-ratio]", root)) /** @type {HTMLButtonElement} */ (b).disabled = on;
    updateBytes();
  }

  const bytesOf = (s) => new TextEncoder().encode(s).length;
  /**
   * The box's size note and Send: the note only once a draft passes three
   * quarters of what the playground takes, amber near it and red past it;
   * Send only with something to send, or as Stop while a reply runs.
   */
  function updateBytes() {
    const ta = $("#pg-prompt", root), out = $("#pg-bytes", root), send = $("#pg-send", root);
    if (!ta || !out || !send) return;
    if (picMode()) {
      // A picture's prompt is counted in characters, as the gateway counts it.
      const n = ta.value.length, share = n / PICTURE_PROMPT_CHARS;
      out.hidden = share < 0.75;
      out.textContent = out.hidden ? "" : `${n.toLocaleString("en-US")} of ${PICTURE_PROMPT_CHARS.toLocaleString("en-US")} characters`;
      out.classList.toggle("warn", share >= 0.9 && share <= 1);
      out.classList.toggle("bad", share > 1);
      send.disabled = !!S.making || !!S.streaming || !ta.value.trim();
      return;
    }
    const share = bytesOf(ta.value) / HISTORY_BYTES;
    out.hidden = share < 0.75;
    out.textContent = out.hidden ? "" : PLAY.used(kb(bytesOf(ta.value)).replace(" KB", ""), kb(HISTORY_BYTES));
    out.classList.toggle("warn", share >= 0.9 && share <= 1);
    out.classList.toggle("bad", share > 1);
    send.disabled = !!S.making || (!S.streaming && !ta.value.trim());
  }

  async function send(text) {
    const th = $("#pg-thread", root);
    if (!th || busy()) return;
    if (looksLikePhrase(text)) {
      notice(th, refusal({ code: "looks_like_recovery_phrase" }));
      host("phrase");
      return;
    }
    const next = [...S.history, { role: "user", content: text }];
    const fit = trimHistory(next);
    if (fit.tooLong) {
      notice(th, { say: tooLong(fit.tooLong, HISTORY_BYTES), action: null, when: null });
      return;
    }
    if (th.querySelector(".cai-suggest")) th.replaceChildren();
    paintReply($(".cai-body", turn(th, "you", "user")), text, false);
    const reply = turn(th, model(), "model");
    const out = $(".cai-body", reply);
    paintReply(out, "", true);
    th.scrollTop = th.scrollHeight;
    S.streaming = new AbortController();
    S.failed = null;
    setBusy(true);
    host("typing", model());
    tell();
    const t0 = performance.now();
    try {
      const r = await gateway.chat(fit.messages, {
        model: model(), signal: S.streaming.signal,
        onDelta: (_p, soFar) => { paintReply(out, soFar, true); th.scrollTop = th.scrollHeight; },
      });
      paintReply(out, r.text, false);
      const secs = (performance.now() - t0) / 1000;
      S.last = { tokens: r.tokens, cost: r.cost, secs };
      S.session = addCall(S.session, { tokens: r.tokens ?? 0, cost: r.cost ?? 0 });
      S.history = r.text ? [...next, { role: "assistant", content: r.text }] : next;
      meta(reply, { tokens: r.tokens, cost: r.cost, secs, stopped: r.stopped }, text);
      if (r.stopped) host("stopped");
      else host("done", dollars(r.cost ?? NaN));
    } catch (e) {
      reply.remove();
      S.failed = text;
      const r = refusal(e instanceof GatewayRefusal ? e : { code: "network" });
      notice(th, r);
      host("refused");
      if (e?.code === "not_signed_in" || e?.code === "terms_changed") {
        // The sign-in comes next, with this note, in a preview as when open.
        S.account = null;
        S.carried = e;
        S.chooser = true;
      }
    } finally {
      S.streaming = null;
      setBusy(false);
      $("#pg-prompt", root)?.focus();
      // What is left today, as the gateway now counts it.
      void refresh({ quiet: true });
    }
  }

  function newChat() {
    if (busy()) return;
    if (picMode()) {
      clearPictures();
      host("fresh");
      tell();
      return;
    }
    S.history = [];
    S.failed = null;
    drawFresh();
    host("fresh");
    tell();
  }

  // ------------------------------------------------------- the pictures --

  /**
   * The picture's file name's time, "20260925-143012", from the page's own
   * clock: the answer's `created` is not trusted, since a malformed one made
   * the name throw after the picture was drawn, and a drawn picture was then
   * shown as a failure with a Retry that spent another.
   */
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

  /**
   * One free picture (X15c): the prompt as your turn, then the model's turn
   * with a progress line counting the seconds, which becomes the picture,
   * its shape, cost and time, and Download. A refusal takes the turn's place.
   */
  async function makePicture(prompt) {
    const th = $("#pg-pics", root);
    const p = offer();
    if (!th || !p || busy()) return;
    if (looksLikePhrase(prompt)) {
      notice(th, refusal({ code: "looks_like_recovery_phrase" }));
      host("phrase");
      return;
    }
    if (prompt.length > PICTURE_PROMPT_CHARS) {
      notice(th, { say: PICTURE.tooLong(prompt.length, PICTURE_PROMPT_CHARS), action: null, when: null });
      return;
    }
    if (th.querySelector(".cai-suggest")) th.replaceChildren();
    paintReply($(".cai-body", turn(th, "you", "user")), prompt, false);
    const reply = turn(th, p.model, "model");
    const out = $(".cai-body", reply);
    const ratio = S.ratio;
    const [w, h] = ratio.split(":").map(Number);
    const wait = document.createElement("div");
    wait.className = "cai-pic-wait";
    wait.style.setProperty("aspect-ratio", `${w} / ${h}`);
    paint(wait, html`<p class="cai-making" role="status"><span class="cai-making-dot" aria-hidden="true"></span><span>${PICTURE.progress}</span><span class="num" data-secs>0 s</span></p>`);
    out.replaceChildren(wait);
    th.scrollTop = th.scrollHeight;
    S.making = new AbortController();
    S.picFailed = null;
    setBusy(true);
    drawBar();
    host("drawing", p.model);
    tell();
    const t0 = performance.now();
    const secsEl = $("[data-secs]", wait);
    const tick = setInterval(() => { secsEl.textContent = `${Math.floor((performance.now() - t0) / 1000)} s`; }, 1000);
    const left = S.making.signal;
    try {
      const r = await gateway.picture({ prompt, size: ratio, signal: left });
      const url = URL.createObjectURL(new Blob([r.bytes], { type: r.type }));
      S.urls.push(url);
      const img = document.createElement("img");
      img.className = "cai-pic";
      img.alt = PICTURE.alt(prompt);
      img.src = url;
      img.style.setProperty("aspect-ratio", `${w} / ${h}`);
      // The picture's height is known once it loads: the thread follows it down then.
      img.addEventListener("load", () => { th.scrollTop = th.scrollHeight; }, { once: true });
      out.replaceChildren(img);
      const secs = (performance.now() - t0) / 1000;
      S.last = { tokens: null, cost: r.cost, secs };
      S.session = addCall(S.session, { tokens: 0, cost: r.cost ?? 0 });
      if (r.left !== null && S.free?.pictures) S.free = { ...S.free, pictures: { ...S.free.pictures, left_today: r.left } };
      const m = document.createElement("div");
      m.className = "cai-meta";
      const facts = [ratio, r.cost == null ? null : dollars(r.cost), `${secs.toFixed(1)} s`].filter(Boolean).join(" · ");
      const ext = r.type === "image/jpeg" ? "jpg" : r.type === "image/webp" ? "webp" : "png";
      paint(m, html`<span>${facts}</span><span class="cai-meta-acts cai-meta-on"><a class="cai-dl" href="${url}" download="${`cumai-${stamp()}.${ext}`}">${PICTURE.download}</a></span>`);
      reply.append(m);
      th.scrollTop = th.scrollHeight;
      host("drawn");
    } catch (e) {
      reply.remove();
      if (left.aborted) return;
      S.picFailed = prompt;
      const refused = e instanceof GatewayRefusal ? e : new GatewayRefusal("network", "");
      // A free failure can count (the X15 red team): the answer says how many are left, and a fall means it did.
      const before = picsLeft();
      const after = refused.extra?.pictures_left;
      if (Number.isSafeInteger(after) && S.free?.pictures) {
        if (before !== null && after < before) refused.extra.counted = true;
        S.free = { ...S.free, pictures: { ...S.free.pictures, left_today: after } };
      }
      if (e?.code === "free_allowance_used" && S.free?.pictures) S.free = { ...S.free, pictures: { ...S.free.pictures, left_today: 0 } };
      const said = refusal(refused, { picture: true, perDay: perDay() });
      // Never a Try again that can only be refused: none is left.
      notice(th, said.action === ACTIONS.RETRY_PICTURE && picsLeft() === 0 ? { ...said, action: null } : said);
      host("refused");
      if (e?.code === "not_signed_in" || e?.code === "terms_changed") {
        S.account = null;
        S.carried = e;
        S.chooser = true;
      }
    } finally {
      clearInterval(tick);
      S.making = null;
      setBusy(false);
      drawBar();
      $("#pg-prompt", root)?.focus();
      void refresh({ quiet: true });
    }
  }

  // ---------------------------------------------------------- sign-in --

  async function signIn(kind, i) {
    if (S.signing) return;
    S.signing = true;
    host("signing", kind === "own");
    try {
      let signer;
      if (kind === "trading") {
        signer = S.trading;
      } else {
        const w = own.list?.[Number(i)];
        if (!w) return;
        signer = ownSigner(w.provider, await ownAccount(w.provider));
      }
      if (!signer) return;
      await gateway.signIn(signer);
      S.chooser = false;
      await refresh();
    } catch (e) {
      centerNote(e instanceof GatewayRefusal ? e : { code: "wallet_declined" });
      host("refused");
    } finally {
      S.signing = false;
    }
  }

  /**
   * Sign out of cumAI. Signed in with the trading wallet, that is a logout of
   * it too, as cumOS's Log out: in every tab, cumOS's included.
   */
  async function signOut() {
    S.streaming?.abort();
    S.making?.abort();
    const was = S.account?.address;
    try { await gateway.signOut(); } catch { /* signed out already, or the gateway is down: the refresh says which */ }
    if (was && S.trading && same(was, S.trading.address)) await login.session.logout();
    S.history = [];
    S.chooser = false;
    await refresh();
  }

  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  /** Log in to the trading wallet here (C5c). Google and X leave the page, and the sign-in carries on when they return. */
  async function logIn(method, uuid) {
    let away = false;
    try {
      if (method !== "wallet") {
        try { sessionStorage.setItem(AFTER_LOGIN, "1"); away = true; } catch { /* the visitor signs in by hand on return */ }
      }
      const address = await login.session.login(method, uuid ? { uuid } : {});
      if (address) {
        await syncTrading();
        if (S.trading) await signIn("trading");
      }
    } catch (e) {
      if (away) try { sessionStorage.removeItem(AFTER_LOGIN); } catch { /* nothing kept */ }
      centerNote({ code: "login_failed", message: String(e?.message ?? e) });
      host("refused");
    }
  }

  /**
   * Whether this load is Google or X sending back a login this tab began: the
   * address carries their answer, and the flag is set. Asked once. A flag
   * left by a login abandoned on their page is dropped on any other load, so
   * a later login elsewhere never signs in here unasked.
   */
  let cameBack = (() => {
    try {
      const p = new URL(globalThis.location.href).searchParams;
      return !!(p.get("code") && p.get("flow_id"));
    } catch {
      return false;
    }
  })();
  if (!cameBack) {
    try { sessionStorage.removeItem(AFTER_LOGIN); } catch { /* nothing kept */ }
  }
  function returned() {
    if (!cameBack) return false;
    cameBack = false;
    try {
      const v = sessionStorage.getItem(AFTER_LOGIN);
      sessionStorage.removeItem(AFTER_LOGIN);
      return v === "1";
    } catch {
      return false;
    }
  }

  /** The trading wallet, as the session has it now. */
  async function syncTrading() {
    const f = login.session.facade();
    S.trading = f ? await tradingSigner(f).catch(() => null) : null;
    if (S.trading) S.lastTrading = S.trading.address;
    if (S.state === "out" || S.chooser) drawChooser();
    if (S.trading && returned() && S.state !== "in") await signIn("trading");
  }

  /** A logout of the trading wallet, here or in any tab: signed in to cumAI with it, that ends too. */
  async function tradingOut() {
    S.trading = null;
    if (S.lastTrading && S.account && same(S.account.address, S.lastTrading)) {
      try { await gateway.signOut(); } catch { /* the refresh says */ }
      await refresh();
    } else if (S.state === "out" || S.chooser) drawChooser();
  }

  let seenSession = "";
  login.session.on((type) => {
    if (type === "out") { void tradingOut(); return; }
    if (type === "error") { centerNote({ code: "login_failed" }); return; }
    const key = `${login.state.login.here}|${login.state.login.phase}|${login.state.trading?.address ?? ""}`;
    if (key === seenSession) return;
    seenSession = key;
    void syncTrading();
  });

  async function findOwn() {
    if (own.list !== null) return;
    own.list = await discoverOwn();
    if (S.state === "out" || S.chooser) drawChooser();
  }

  // ---------------------------------------------------------- refresh --

  async function refresh({ quiet = false } = {}) {
    let free = null;
    let account = null;
    try { free = await gateway.status(); } catch { free = null; }
    if (free) {
      try { account = await gateway.whoami(); } catch { account = null; }
    }
    const before = S.state;
    S.free = free;
    S.account = account;
    S.state = playState(free, account);
    if (S.state === "out" || S.chooser) void findOwn();
    if (quiet && before === S.state) {
      drawBar();
      if (S.state === "in") applyMode();
      tell();
      return;
    }
    if (before === "in" && S.state !== "in") {
      S.history = [];
      for (const u of S.urls) URL.revokeObjectURL(u);
      S.urls = [];
      S.mode = "text";
    }
    draw();
  }

  // ----------------------------------------------------------- events --

  root.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const sug = t.closest?.("[data-sug]");
    if (sug) {
      const ta = $("#pg-prompt", root);
      ta.value = sug.textContent;
      updateBytes();
      ta.focus();
      return;
    }
    const mode = /** @type {HTMLElement | null} */ (t.closest?.("[data-pg-mode]"));
    if (mode) {
      if (busy()) return;
      S.mode = mode.dataset.pgMode === "picture" && offer() ? "picture" : "text";
      drawBar();
      applyMode();
      hostLine();
      tell();
      $("#pg-prompt", root)?.focus();
      return;
    }
    const ratio = /** @type {HTMLElement | null} */ (t.closest?.("[data-pg-ratio]"));
    if (ratio) {
      if (busy() || !PICTURE_SIZES.includes(ratio.dataset.pgRatio)) return;
      S.ratio = ratio.dataset.pgRatio;
      applyMode();
      return;
    }
    const b = /** @type {HTMLElement | null} */ (t.closest?.("[data-pg]"));
    if (!b) return;
    const act = b.dataset.pg;
    if (act === "copy-reply") {
      const body = b.closest(".cai-turn")?.querySelector(".cai-body");
      void navigator.clipboard?.writeText(body?.textContent ?? "").then(() => { b.textContent = "Copied"; }, () => { b.textContent = "Select it"; })
        .finally(() => setTimeout(() => { b.textContent = "Copy"; }, 1500));
      return;
    }
    if (act === "retry-reply") {
      // The newest exchange, asked again: it leaves the thread and the history, then goes once more.
      const reply = b.closest(".cai-turn");
      const prompt = reply ? promptOf.get(reply) : null;
      if (!prompt || S.streaming) return;
      reply.previousElementSibling?.remove();
      reply.remove();
      S.history = S.history.slice(0, -2);
      void send(prompt);
      return;
    }
    if (act === "trading") void signIn("trading");
    else if (act === "login") void logIn(b.dataset.method, b.dataset.uuid);
    else if (act === "own") void signIn("own", b.dataset.i);
    else if (act === "show-signin" || act === ACTIONS.SIGN_IN) {
      S.chooser = true;
      if (S.state === "in") S.state = "out";
      draw();
      void findOwn();
    } else if (act === "sign-out") void signOut();
    else if (act === ACTIONS.NEW_CHAT) newChat();
    else if (act === ACTIONS.RETRY || act === ACTIONS.RETRY_PICTURE) {
      if (S.state === "down") void refresh();
      else if (b.closest("#pg-pics") || act === ACTIONS.RETRY_PICTURE) {
        if (!S.picFailed) return;
        b.closest(".cai-notice")?.remove();
        void makePicture(S.picFailed);
      } else if (S.failed) {
        b.closest(".cai-notice")?.remove();
        void send(S.failed);
      }
    } else if (act === ACTIONS.ADD_ETH) {
      const addr = S.trading?.address;
      const box = b.closest(".cai-notice");
      if (!box) return;
      b.remove();
      const p = document.createElement("p");
      p.className = "cai-small";
      if (addr && S.account?.address?.toLowerCase() === addr.toLowerCase()) {
        paint(p, html`${PLAY.addEth} <code class="cai-code-i">${addr}</code> <button class="cai-small-btn" type="button" data-copy="${addr}">Copy</button>`);
      } else {
        paint(p, html`Open <a class="cai-lnk" href="/trade">cumTrade</a> to see your trading wallet's address, and send it a few cents of ETH on Robinhood Chain.`);
      }
      box.append(p);
    }
  });
  $("#pg-new", root).addEventListener("click", newChat);
  $("#pg-out", root).addEventListener("click", () => void signOut());
  root.addEventListener("input", (e) => { if (/** @type {HTMLElement} */ (e.target).id === "pg-prompt") updateBytes(); });
  root.addEventListener("keydown", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.id === "pg-prompt" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#pg-form", root)?.requestSubmit();
    }
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    if (S.making) return;
    if (S.streaming) {
      S.streaming.abort();
      return;
    }
    const ta = $("#pg-prompt", root);
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    updateBytes();
    void (picMode() ? makePicture(text) : send(text));
  });

  return {
    refresh,
    newChat,
    signOut,
    hostLine,
    get snapshot() {
      return { state: S.state, free: S.free, account: S.account, session: S.session, last: S.last, model: freeModel(), streaming: busy(), mode: S.mode };
    },
    focus() { $("#pg-prompt", root)?.focus(); },
  };
}
