// cumAI's one way to the gateway for a signed-in visitor (X20 A4; stage C,
// C4): the free tier's status, who is signed in, sign-in and sign-out, and
// the streamed chat. Every call carries the session cookie
// (`credentials: "include"`), which the gateway answers with CORS for this
// site only. A refusal comes back as a GatewayRefusal with the gateway's
// code, so words.js can say it. The model list is models.js's, and needs no
// cookie.
//
// Nothing here draws: C5's page does. Nothing here touches a wallet either:
// a sign-in takes a signer ({ address, sign }) from wallets.js.
import { GATEWAY } from "./models.js";

/** How long a call that isn't a chat may take before it counts as unreachable. */
export const CALL_TIMEOUT_MS = 15_000;
/**
 * The history a chat sends, measured the way the gateway measures a free call
 * (its inputBound: the messages' JSON bytes, and 8 a message). The gateway
 * takes 8,000 with its own system prompt, so the page keeps to 6,500 (A8).
 */
export const HISTORY_BYTES = 6_500;

/** A refusal from the gateway, or "network" when it couldn't be reached. */
export class GatewayRefusal extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, extra?: Record<string, unknown> }} [o] */
  constructor(code, message, { status = 0, extra = {} } = {}) {
    super(message);
    this.name = "GatewayRefusal";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const unreachable = () => new GatewayRefusal("network", "the gateway could not be reached");

/** The gateway's error answer (OpenAI's shape: `{ error: { message, code, … } }`) as a refusal. */
async function refusalOf(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON: the status alone */ }
  const e = body && typeof body.error === "object" && body.error ? body.error : {};
  const { message, code, type: _type, ...extra } = e;
  const wait = Number(res.headers.get("retry-after"));
  if (Number.isFinite(wait) && wait > 0 && extra.retry_after_seconds === undefined) extra.retry_after_seconds = wait;
  // A free picture's refusal says how many are left, as its answer does: a failure can count (X15 red team).
  const left = res.headers.get("x-cum-free-pictures-left");
  if (left !== null && /^\d{1,4}$/.test(left.trim())) extra.pictures_left = Number(left.trim());
  return new GatewayRefusal(typeof code === "string" && code ? code : `http_${res.status}`,
    typeof message === "string" ? message : "", { status: res.status, extra });
}

/** The ratios a free picture may be asked for (the gateway's RATIOS), the first the default. */
export const PICTURE_SIZES = Object.freeze(["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"]);
/** The longest prompt a picture takes (the gateway's PROMPT_MAX_CHARS). */
export const PICTURE_PROMPT_CHARS = 4_000;
/** A picture takes 20–60 s, and the gateway gives up at 150 s; past this the page does too. */
export const PICTURE_TIMEOUT_MS = 180_000;

/**
 * A picture's type, by its first bytes: PNG, JPEG or WebP, else null. The
 * page draws nothing it can't name.
 * @param {Uint8Array} b
 */
export function pictureType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** The widest or tallest picture the page draws: a larger one could exhaust the tab's memory as it decodes. */
export const PICTURE_MAX_SIDE = 8192;

/**
 * A PNG's width and height from its header (IHDR), or null when the bytes
 * don't carry one where a PNG must.
 * @param {Uint8Array} b
 */
export function pngSize(b) {
  if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Base64 to bytes, or null when it isn't base64. */
function fromBase64(s) {
  if (typeof s !== "string" || !s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A header's number, or null. */
const headerNumber = (res, name) => {
  const v = res.headers.get(name);
  const n = v === null || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Utf-8 bytes of a string. */
const bytes = (s) => new TextEncoder().encode(s).length;

/** A history's size as the gateway counts it (G6's inputBound, without its fixed 64). */
export const sizeOf = (messages) => bytes(JSON.stringify(messages)) + 8 * messages.length;

/**
 * The newest turns that fit in `limit` (A8), oldest first. When the newest
 * message alone doesn't fit, nothing is sent: `{ tooLong: its size }`.
 * @param {{ role: string, content: string }[]} messages
 */
export function trimHistory(messages, limit = HISTORY_BYTES) {
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (sizeOf([messages[i], ...kept]) > limit) break;
    kept.unshift(messages[i]);
  }
  if (kept.length === 0 && messages.length > 0) return { messages: [], tooLong: sizeOf(messages.slice(-1)) };
  return { messages: kept, tooLong: null };
}

/**
 * One server-sent event's data: `[DONE]`, a parsed object, or null for a
 * comment or a line that isn't JSON (which is skipped, never shown).
 */
export function eventData(block) {
  const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
  if (data === "") return null;
  if (data === "[DONE]") return "[DONE]";
  try { return JSON.parse(data); } catch { return null; }
}

/**
 * @param {{ fetch?: typeof fetch, base?: string, timeoutMs?: number }} [o]
 */
export function createGateway({ fetch: fetchFn = (...a) => globalThis.fetch(...a), base = GATEWAY, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  /**
   * A call with the session cookie. A chat has no timeout of its own: the gateway's stream limits end it.
   * @param {string} path
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeout?: boolean }} [o]
   */
  async function call(path, { method = "GET", body, signal, timeout = true } = {}) {
    const signals = [signal, timeout ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    /** @type {RequestInit} */
    const init = { method, credentials: "include", cache: "no-store", signal: signals.length ? AbortSignal.any(signals) : undefined };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    try {
      return await fetchFn(`${base}${path}`, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw unreachable();
    }
  }

  /** A JSON answer, or its refusal. 204 is null. */
  async function answer(res) {
    if (!res.ok) throw await refusalOf(res);
    if (res.status === 204) return null;
    try { return await res.json(); } catch { throw unreachable(); }
  }

  return {
    /** `GET /v1/free`: whether the free tier is open to this visitor, and what is left today. */
    async status() {
      return answer(await call("/v1/free"));
    },

    /** `GET /v1/account`: the signed-in account, or null when no one is. */
    async whoami() {
      const res = await call("/v1/account");
      if (res.status === 401) return null;
      return answer(res);
    },

    /**
     * Sign in: the gateway writes the message, the signer signs it, and the
     * gateway sets the session cookie. A signer that throws a
     * GatewayRefusal passes it on; any other failure to sign reads as the
     * wallet declining.
     * @param {{ address: string, sign: (message: string) => Promise<string> }} signer
     */
    async signIn(signer) {
      const c = await answer(await call("/v1/auth/challenge", { method: "POST", body: { address: signer.address, action: "sign-in" } }));
      if (typeof c?.message !== "string") throw unreachable();
      let signature;
      try {
        signature = await signer.sign(c.message);
      } catch (e) {
        if (e instanceof GatewayRefusal) throw e;
        throw new GatewayRefusal("wallet_declined", String(e?.message ?? e));
      }
      return answer(await call("/v1/auth/sign-in", { method: "POST", body: { message: c.message, signature } }));
    },

    /** End the session. Signed out already is fine. */
    async signOut() {
      await answer(await call("/v1/auth/sign-out", { method: "POST" }));
    },

    /**
     * A streamed free chat. `onDelta(piece, soFar)` hears the reply as it
     * comes; the text is never HTML to this module or to the page (A8).
     * Aborting `signal` stops it: the answer is then `stopped`, with what
     * came. A refusal before or during the stream throws.
     * @param {{ role: string, content: string }[]} messages
     * @param {{ model: string, onDelta?: (piece: string, soFar: string) => void, signal?: AbortSignal }} o
     */
    async chat(messages, { model, onDelta = () => {}, signal } = /** @type {any} */ ({})) {
      let res;
      try {
        res = await call("/v1/chat/completions", { method: "POST", body: { model, messages, stream: true }, signal, timeout: false });
      } catch (e) {
        if (signal?.aborted) return { text: "", cost: null, tokens: null, requestId: null, stopped: true };
        throw e;
      }
      if (!res.ok) throw await refusalOf(res);
      const requestId = res.headers.get("x-cum-request-id");
      let text = "";
      let cost = null;
      let tokens = null;
      if (!res.body) throw unreachable();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      /** One event; true at [DONE]. */
      const take = (block) => {
        const ev = eventData(block);
        if (ev === "[DONE]") return true;
        if (!ev || typeof ev !== "object") return false;
        if (ev.error && typeof ev.error === "object") {
          const { message, code, type: _type, ...extra } = ev.error;
          throw new GatewayRefusal(typeof code === "string" && code ? code : "upstream_error", typeof message === "string" ? message : "", { extra });
        }
        const piece = ev.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece !== "") {
          text += piece;
          onDelta(piece, text);
        }
        if (typeof ev.usage?.cost === "number" && Number.isFinite(ev.usage.cost)) cost = ev.usage.cost;
        const used = Number(ev.usage?.total_tokens ?? (Number(ev.usage?.prompt_tokens) + Number(ev.usage?.completion_tokens)));
        if (Number.isSafeInteger(used) && used >= 0) tokens = used;
        return false;
      };
      try {
        for (let done = false; !done;) {
          const r = await reader.read();
          if (r.done) {
            buf += decoder.decode();
            if (buf.trim()) take(buf);
            break;
          }
          buf += decoder.decode(r.value, { stream: true });
          for (let m = buf.match(/\r?\n\r?\n/); m && !done; m = buf.match(/\r?\n\r?\n/)) {
            const block = buf.slice(0, m.index);
            buf = buf.slice(/** @type {number} */ (m.index) + m[0].length);
            done = take(block);
          }
        }
      } catch (e) {
        if (signal?.aborted) return { text, cost, tokens, requestId, stopped: true };
        if (e instanceof GatewayRefusal) throw e;
        throw unreachable();
      } finally {
        reader.releaseLock?.();
      }
      return { text, cost, tokens, requestId, stopped: false };
    },

    /**
     * A free picture (X15b, X15c): `{ prompt, size }` and nothing else, since
     * the free allowance takes one model at one tier. It answers when the
     * picture is made and checked, in 20–60 s. The answer's bytes must be an
     * image by their first bytes; anything else reads as unreachable.
     * @param {{ prompt: string, size: string, signal?: AbortSignal }} o
     * @returns {Promise<{ bytes: Uint8Array<ArrayBuffer>, type: string, created: number | null, cost: number | null, left: number | null, requestId: string | null }>}
     */
    async picture({ prompt, size, signal }) {
      const limit = AbortSignal.timeout(PICTURE_TIMEOUT_MS);
      const both = signal ? AbortSignal.any([signal, limit]) : limit;
      // Past the page's own limit, it is the gateway's timeout as far as anyone can tell.
      const late = (e) => (limit.aborted && !signal?.aborted ? new GatewayRefusal("upstream_timeout", "the picture was not ready in time") : e);
      let res;
      try {
        res = await call("/v1/images/generations", { method: "POST", body: { prompt, size }, timeout: false, signal: both });
      } catch (e) {
        throw late(e);
      }
      if (!res.ok) throw await refusalOf(res);
      let body;
      try { body = await res.json(); } catch (e) { throw limit.aborted ? late(e) : unreachable(); }
      const bytes = fromBase64(body?.data?.[0]?.b64_json);
      const type = bytes ? pictureType(bytes) : null;
      if (!bytes || !type) throw unreachable();
      if (type === "image/png") {
        const s = pngSize(bytes);
        if (!s || !s.width || !s.height || s.width > PICTURE_MAX_SIDE || s.height > PICTURE_MAX_SIDE) throw unreachable();
      }
      const cost = typeof body?.usage?.cost_usd === "number" && Number.isFinite(body.usage.cost_usd)
        ? body.usage.cost_usd : headerNumber(res, "x-cum-cost-usd");
      const left = headerNumber(res, "x-cum-free-pictures-left");
      return {
        bytes, type, cost,
        created: Number.isFinite(body?.created) ? body.created : null,
        left: left !== null && Number.isSafeInteger(left) && left >= 0 ? left : null,
        requestId: res.headers.get("x-cum-request-id"),
      };
    },
  };
}
