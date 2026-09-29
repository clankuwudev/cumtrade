import { S } from "../core/store.js";
import { api } from "../core/api.js";
import { $, html, paint } from "../core/dom.js";
import { closeOn, holdSheet, sheetHead, toast } from "../core/ui.js";
import { DURATION_MS, MOTION_MS, SIZE, drawCard } from "./draw.js";
import { REACTIONS, ledgerCardRow, ledgerChart, recordCard, slug, tradeCard } from "./model.js";
import { drawReplay } from "./replay.js";
import { TIMELINE, replayModel } from "./replayModel.js";
import { cardScore, renderScore, replayScore } from "./sound.js";

// The share dialog (docs/specs/share-cards.md C3, trade-replay.md V3, V4): a
// live preview, clankchan's reactions, the style (the card, or a replay of the
// trade in 9:16 or 1:1), the sound, and the two exports. Every style is a
// renderer with a size, a length, a draw(ms) and a score, so the preview, the
// PNG and the video share one path.

/** Whether the videos have sound. Remembered while the page is open. */
let soundOn = true;
const canSound = typeof OfflineAudioContext === "function" && typeof AudioContext === "function";

/** Loaded pictures of her, by name. A failed load is remembered as null, and the card draws without her. */
const arts = new Map();

function loadArt(name) {
  if (!name) return Promise.resolve(null);
  if (arts.has(name)) return Promise.resolve(arts.get(name));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { arts.set(name, img); resolve(img); };
    img.onerror = () => { arts.set(name, null); resolve(null); };
    // Beside the modules: /art/ here, /v/<sha>/art/ on a release.
    img.src = new URL(`../../art/${name}.webp`, import.meta.url).href;
  });
}

async function fontsReady() {
  await Promise.all([
    document.fonts.load(`800 64px 'Schibsted Grotesk'`),
    document.fonts.load(`400 20px 'Schibsted Grotesk'`),
    document.fonts.load(`400 20px 'JetBrains Mono'`),
    document.fonts.load(`500 20px 'JetBrains Mono'`),
    document.fonts.load(`700 20px 'JetBrains Mono'`),
  ]).catch(() => {});
}

/** A token's own picture for the replay's badge, or null: it draws its initials then. */
function loadLogo(token) {
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/api/logo?token=" + encodeURIComponent(token);
  });
}

/** A replay needs a chart to move along. */
const REPLAY_MIN_CANDLES = 2;

const ethUsdNow = () => (S.stats && S.stats.price ? S.stats.price.ethUsd : null);

/**
 * Open the dialog for the whole record, or for one position: the self
 * console's track record (share-cards.md).
 *
 * @param {{ token?: string }} [what]
 */
export async function openShare(what = {}) {
  const rec = S.record;
  if (!rec || !rec.address) return toast("err", "Nothing to share", "The track record has not been read yet.");
  const ethUsd = ethUsdNow();

  let card, row = null, replayData = null;
  if (what.token) {
    row = rec.positions.find((p) => p.token.toLowerCase() === what.token.toLowerCase());
    const [c, rp] = await Promise.all([
      api(`/api/record/candles?token=${encodeURIComponent(what.token)}&n=48`),
      api(`/api/record/replay?token=${encodeURIComponent(what.token)}`),
    ]);
    if (!row || c.status !== 200) return toast("err", "Could not build the card", c.data.error || "");
    card = tradeCard(row, c.data, rec.address, ethUsd);
    if (rp.status === 200) replayData = rp.data;
  } else {
    const r = await api("/api/record/candles?kind=record");
    if (r.status !== 200) return toast("err", "Could not build the card", r.data.error || "");
    card = recordCard(rec, r.data, ethUsd);
  }

  const candleCount = replayData
    ? replayData.segments.before.length + replayData.segments.holding.length + replayData.segments.after.length : 0;
  const canReplay = Boolean(row && replayData && candleCount >= REPLAY_MIN_CANDLES);
  return showShare({
    card,
    title: row ? `Share ${row.symbol}` : "Share your track record",
    replay: canReplay ? (shape) => replayModel(row, replayData, rec.address, shape) : null,
    replayWhy: !row ? "A replay is of one trade: open it from a row."
      : canReplay ? "" : "Not enough price history for this token yet; it fills in as the track record refreshes.",
    note: row ? "Dollar amounts use the ETH price on the day of each trade." : "",
    art: true,
    token: row ? row.token : null,
  });
}

/**
 * Open the dialog for one position on the hosted Portfolio (p-sell-verdict.md,
 * P3): the same trade card, from /api/ledger. Any address can be shared, with
 * its short address on the card. Replay (P4b) comes from /api/replay, built
 * from the chain index's trades, when it has at least two candles.
 *
 * @param {any} p a position from /api/ledger
 * @param {string} address whose it is
 * @param {boolean} [own] whether it is the viewer's own wallet: the video says "you" only then
 */
export async function openLedgerShare(p, address, own = false) {
  if (!p || !p.sellVerdict || p.sellVerdict === "holding") {
    return toast("err", "Nothing to share", "This position has no sell to show.");
  }
  const q = new URLSearchParams({ address, token: p.token, opened: String(p.openedAt) });
  if (p.closed) q.set("closed", String(p.closed.at));
  const [h, rp] = await Promise.all([
    api("/api/history?token=" + encodeURIComponent(p.token)),
    api("/api/replay?" + q.toString()),
  ]);
  const chart = ledgerChart(p, h.status === 200 ? h.data : null);
  const row = ledgerCardRow(p);
  const card = tradeCard(row, chart, address, ethUsdNow());
  const data = rp.status === 200 ? rp.data : null;
  const candleCount = data ? data.segments.before.length + data.segments.holding.length + data.segments.after.length : 0;
  const canReplay = Boolean(data && candleCount >= REPLAY_MIN_CANDLES);
  return showShare({
    card,
    title: `Share ${p.symbol}`,
    replay: canReplay ? (shape) => replayModel(row, data, address, shape, own) : null,
    replayWhy: canReplay ? "" : rp.status === 429 ? "Too many replays just now; try again in a minute."
      : "The chain index has no trades of this position yet.",
    note: `The card's dollars use today's ETH price${canReplay ? "; the replay's use each trade's day" : ""}.${
      chart.candles.length ? "" : " The site's price history does not reach back to this trade, so the card has no chart."}`,
    art: true,
    token: p.token,
  });
}

/**
 * The dialog itself, for any card.
 *
 * @param {{
 *   card: any, title: string,
 *   replay: ((shape: "9:16" | "1:1") => any) | null, replayWhy: string,
 *   note: string, art: boolean, token?: string | null,
 * }} o
 */
async function showShare({ card, title, replay, replayWhy, note, art: withArt, token = null }) {
  await fontsReady();
  // The token's logo arrives when it arrives: the window never waits for it.
  // A token's picture is served as uploaded, a megabyte or more, and every
  // frame is drawn afresh, so it simply appears once loaded.
  /** @type {HTMLImageElement | null} */
  let logo = null;
  if (replay) void loadLogo(token).then((im) => { logo = im; });
  const canReplay = replay !== null;

  let style = canReplay ? "replay" : "card";
  /** @type {"9:16" | "1:1"} */
  let shape = "9:16";
  let artName = card.art;

  // One of the sheet family (U7, U8): the head with its ✕, the choices, the
  // preview, the small print, then one row of actions, the primary last.
  // Held (ui.js holdSheet): Esc closes it, Tab stays inside, and focus goes
  // back to the Share that opened it; nothing closes it while it records.
  const back = document.createElement("div");
  back.className = "modal share";
  paint(back, html`<div class="mbox sharebox" role="dialog" aria-modal="true" aria-labelledby="share-title" tabindex="-1">
      ${sheetHead("share-title", title)}
      <div class="sharemodes">
        <div class="seg sm" role="group" aria-label="Style">
          <button type="button" data-style="replay" ${canReplay ? "" : "disabled"} title="${replayWhy}">Replay</button>
          <button type="button" data-style="card">Card</button>
        </div>
        <div class="seg sm" role="group" aria-label="Shape" data-shapes>
          <button type="button" data-shape="9:16">9:16</button>
          <button type="button" data-shape="1:1">1:1</button>
        </div>
        <span class="sp"></span>
        <div class="sharechips">
          <button type="button" class="chip" data-sound ${canSound ? "" : "disabled"}
            title="${canSound ? "Sound in the preview and the video" : "This browser cannot make the sound"}">Sound</button>
        </div>
      </div>
      <div class="sharecv"></div>
      ${withArt ? html`<div class="sharechips" role="group" aria-label="clankchan's reaction">
        ${REACTIONS.map(([name, label]) => html`<button type="button" class="chip" data-art="${name}">${label}</button>`)}
        <button type="button" class="chip" data-art="">none</button>
      </div>` : ""}
      <p class="sheetnote">Shows <b>${card.address}</b>. Estimated values are marked est.${note ? ` ${note}` : ""}
        Click the preview to hold it on the last frame.${replayWhy && card.kind === "trade" ? ` ${replayWhy}` : ""}</p>
      <p class="sharestat" aria-live="polite"></p>
      <div class="mbtns sheetacts">
        <button class="btn" type="button" data-x>Close</button>
        <button class="btn" type="button" data-png>Download PNG</button>
        <button class="btn pri" type="button" data-mp4>Record video</button>
      </div>
    </div>`);
  document.body.appendChild(back);

  const canvas = document.createElement("canvas");
  $(".sharecv", back).appendChild(canvas);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const status = $(".sharestat", back);
  let art = await loadArt(artName);
  if (artName && !art) status.textContent = "clankchan's picture did not load; the card draws without her.";

  /** The current style as a renderer: its size, its length, a frame at `ms`, and its score. */
  const renderer = () => {
    if (style === "replay" && replay) {
      const m = replay(shape);
      return {
        w: m.w, h: m.h, durationMs: TIMELINE.total * 1000, name: `${slug(card)}-replay-${shape.replace(":", "x")}`,
        draw: (ms) => drawReplay(ctx, m, ms / 1000, art, logo),
        score: () => replayScore(m),
      };
    }
    return {
      w: SIZE, h: SIZE, durationMs: DURATION_MS, name: slug(card),
      draw: (ms) => drawCard(ctx, card, Math.min(1, ms / MOTION_MS), art),
      score: () => cardScore(card, DURATION_MS),
    };
  };

  // The sound: each renderer's score, rendered once into a buffer, and played
  // from the preview's own clock. It restarts at every loop of the preview, at
  // the second the picture is on, so the two cannot drift apart.
  const ac = canSound ? new AudioContext({ latencyHint: "interactive" }) : null;
  /** @type {Map<string, Promise<AudioBuffer | null>>} */
  const buffers = new Map();
  /** @type {AudioBuffer | null} */
  let buffer = null;
  /** @type {AudioBufferSourceNode | null} */
  let voice = null;
  const bufferFor = (r) => {
    if (!buffers.has(r.name)) buffers.set(r.name, renderScore(r.score()).catch(() => null));
    return /** @type {Promise<AudioBuffer | null>} */ (buffers.get(r.name));
  };
  const hush = () => {
    if (voice) { try { voice.stop(); } catch { /* already ended */ } voice.disconnect(); voice = null; }
  };
  /** Play the sound from `sec`, if it is on and there is a picture moving to go with it. */
  const playFrom = (sec) => {
    hush();
    if (!ac || !soundOn || !buffer || held || recording || !running) return;
    if (ac.state === "suspended") ac.resume().catch(() => {});
    voice = ac.createBufferSource();
    voice.buffer = buffer;
    voice.connect(ac.destination);
    // What starts now is heard a little later: start that far in.
    const late = (ac.outputLatency || 0) + (ac.baseLatency || 0);
    const at = sec + late;
    if (at < buffer.duration) voice.start(0, at);
  };

  // The preview loops the video until the dialog closes or records. A click
  // on it holds the last frame, which is what the PNG will be.
  let running = true, recording = false, held = false;
  let t0 = performance.now();
  let loop = -1;
  let R = renderer();
  const sync = () => {
    R = renderer();
    canvas.width = R.w;
    canvas.height = R.h;
    for (const b of back.querySelectorAll("[data-style]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-style") === style));
    for (const b of back.querySelectorAll("[data-shape]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-shape") === shape));
    for (const b of back.querySelectorAll("[data-art]")) b.setAttribute("aria-pressed", String((b.getAttribute("data-art") || null) === artName));
    /** @type {HTMLElement} */ ($("[data-sound]", back)).setAttribute("aria-pressed", String(canSound && soundOn));
    /** @type {HTMLElement} */ ($("[data-shapes]", back)).hidden = style !== "replay";
    t0 = performance.now();
    loop = -1;
    if (!ac) return;
    const want = R;
    hush();
    buffer = null;
    bufferFor(want).then((b) => {
      if (R !== want) return;
      buffer = b;
      loop = -1; // start it on the next frame, at the second the picture is on
    });
  };
  sync();
  const frame = (now) => {
    if (!running) return;
    if (!recording) {
      const ms = (now - t0) % R.durationMs;
      R.draw(held ? R.durationMs : ms);
      const n = Math.floor((now - t0) / R.durationMs);
      if (!held && n !== loop) { loop = n; playFrom(ms / 1000); }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  canvas.title = "Click to hold on the last frame, again to play";
  canvas.addEventListener("click", () => {
    held = !held;
    if (held) hush();
    else { t0 = performance.now(); loop = -1; }
  });

  let release = () => {};
  const close = () => {
    if (recording) return;
    running = false;
    hush();
    if (ac) ac.close().catch(() => {});
    release();
    back.remove();
  };
  back.addEventListener("click", async (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (recording) return;
    // A click is what a browser waits for before it lets a page make sound.
    if (ac && ac.state === "suspended" && soundOn) ac.resume().then(() => { loop = -1; }, () => {});
    if (el === back) { close(); return; }
    const snd = /** @type {HTMLElement | null} */ (el.closest("[data-sound]"));
    if (snd) {
      if (snd.hasAttribute("disabled")) return;
      soundOn = !soundOn;
      snd.setAttribute("aria-pressed", String(soundOn));
      if (soundOn) loop = -1; else hush();
      return;
    }
    const st = /** @type {HTMLElement | null} */ (el.closest("[data-style]"));
    if (st && !st.hasAttribute("disabled")) { style = st.dataset.style || "card"; sync(); return; }
    const sh = /** @type {HTMLElement | null} */ (el.closest("[data-shape]"));
    if (sh) { shape = sh.dataset.shape === "1:1" ? "1:1" : "9:16"; sync(); return; }
    const chip = /** @type {HTMLElement | null} */ (el.closest("[data-art]"));
    if (chip) {
      artName = chip.dataset.art || null;
      card.art = artName;
      art = await loadArt(artName);
      sync();
      return;
    }
    if (el.closest("[data-png]")) {
      R.draw(R.durationMs);
      canvas.toBlob((b) => b && save(b, `${R.name}.png`), "image/png");
      return;
    }
    if (el.closest("[data-mp4]")) {
      recording = true;
      hush();
      for (const b of back.querySelectorAll("button")) b.disabled = true;
      try {
        const sound = ac && soundOn ? await bufferFor(R) : null;
        if (ac && sound) await ac.resume();
        const out = await record(canvas, R, (p) => { status.textContent = `Recording… ${Math.round(p * 100)}% (keep this tab in front)`; },
          ac && sound ? { ac, buffer: sound } : null);
        save(out.blob, `${R.name}.${out.ext}`);
        const kind = out.ext === "mp4" ? "an MP4" : "a WebM";
        const quiet = soundOn && !out.sound ? ", without sound: this browser cannot record it" : "";
        status.textContent = out.smooth
          ? `Saved ${kind}${quiet}.${out.ext === "mp4" ? "" : " This browser records WebM only."}`
          : `Saved, but only ${out.fps} frames a second were drawn: the tab was probably in the background. Record again with it in front.`;
      } catch (err) {
        status.textContent = `Recording failed: ${/** @type {Error} */ (err).message}`;
      } finally {
        recording = false;
        loop = -1;
        for (const b of back.querySelectorAll("button")) b.disabled = false;
        for (const b of back.querySelectorAll("[data-style]")) if (b.getAttribute("data-style") === "replay" && !canReplay) b.setAttribute("disabled", "");
        if (!canSound) $("[data-sound]", back).setAttribute("disabled", "");
      }
    }
  });
  closeOn(back, close);
  release = holdSheet(back, close, $("[data-png]", back));
}

/** Hand a file to the browser to save. */
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** What a recording can be, best first: MP4 (H.264, and AAC for the sound) where the browser records it, WebM otherwise. */
const SILENT_TYPES = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
const SOUND_TYPES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2",
  "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"];

/**
 * Record a renderer, in real time, from the canvas, with its sound when one
 * is given and the browser can record it.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {any} R
 * @param {(p: number) => void} onProgress
 * @param {{ ac: AudioContext, buffer: AudioBuffer } | null} audio
 */
function record(canvas, R, onProgress, audio) {
  const soundType = audio ? SOUND_TYPES.find((x) => MediaRecorder.isTypeSupported(x)) : undefined;
  const type = soundType ?? SILENT_TYPES.find((x) => MediaRecorder.isTypeSupported(x));
  if (!type) return Promise.reject(new Error("this browser cannot record a canvas"));
  const video = canvas.captureStream(30);
  let stream = video;
  /** @type {AudioBufferSourceNode | null} */
  let voice = null;
  if (audio && soundType) {
    const dest = audio.ac.createMediaStreamDestination();
    voice = audio.ac.createBufferSource();
    voice.buffer = audio.buffer;
    voice.connect(dest);
    voice.connect(audio.ac.destination); // and heard while it records
    stream = new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }
  const rec = new MediaRecorder(stream, {
    mimeType: type, videoBitsPerSecond: 12_000_000, ...(voice ? { audioBitsPerSecond: 192_000 } : {}),
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  return new Promise((resolve, reject) => {
    rec.onerror = () => reject(new Error("the recorder stopped"));
    // A background tab gets a frame or so a second, and the recording
    // stutters: count what was drawn, so the dialog can say so.
    let drawn = 0;
    rec.onstop = () => {
      if (voice) voice.disconnect();
      for (const t of stream.getTracks()) t.stop();
      const fps = Math.round(drawn / (R.durationMs / 1000));
      resolve({ blob: new Blob(chunks, { type: type.split(";")[0] }), ext: type.startsWith("video/mp4") ? "mp4" : "webm",
        fps, smooth: fps >= 24, sound: Boolean(voice) });
    };
    R.draw(0);
    rec.start(250);
    // The sound and the first moving frame start together, a moment from now:
    // the audio clock is scheduled ahead, and the picture waits for it.
    const LEAD = 0.1;
    if (voice && audio) voice.start(audio.ac.currentTime + LEAD);
    const start = performance.now() + LEAD * 1000;
    const step = (now) => {
      const ms = Math.max(0, now - start);
      R.draw(Math.min(ms, R.durationMs));
      drawn++;
      onProgress(Math.min(1, ms / R.durationMs));
      if (ms < R.durationMs) requestAnimationFrame(step);
      else rec.stop();
    };
    requestAnimationFrame(step);
  });
}
