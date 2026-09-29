/**
 * Token logos, shrunk (P1f).
 *
 * A logo on clank.trade is whatever its deployer uploaded: routinely ~1 MB,
 * once 1.6 MB, for a ring 26 to 66 CSS pixels wide. Passed through as they
 * were, a first visit to the board pulled tens of megabytes across the ocean
 * to draw two hundred small circles. So each logo is decoded once, here, and
 * served as a WebP at most THUMB_PX on its long side: a few kilobytes.
 *
 * The codecs are WebAssembly (jSquash, from Squoosh), not a native module:
 * the release refuses `.node` files, and a decoder bug stays inside the WASM
 * sandbox's own memory. The bytes are still the deployer's, so:
 * - the header's dimensions are read before anything is decoded, and a
 *   picture over MAX_PIXELS is refused (a small file can claim to be 60000
 *   pixels square and ask for gigabytes);
 * - one decode runs at a time, so a board of new logos can't stack up
 *   decoded bitmaps in memory at once;
 * - a format with no decoder here (GIF, AVIF) passes through unchanged only
 *   while it's small, and an SVG passes through as before (the route gives it
 *   a policy that runs no script).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { imageSize } from "image-size";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDec } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import resize, { initResize } from "@jsquash/resize";

/** The long side of a thumbnail: the largest ring (66 px) on a 2x screen, and the share card's badge. */
export const THUMB_PX = 160;
/** Past this many pixels a logo is refused before decoding: 4096 x 4096 is 64 MB decoded. */
export const MAX_PIXELS = 4096 * 4096;
/** A logo with no decoder here is served as it came only up to this size. */
export const PASS_BYTES = 256 * 1024;

export type Picture = { body: Buffer; type: string };

const req = createRequire(import.meta.url);
const wasm = (spec: string) => WebAssembly.compile(readFileSync(req.resolve(spec)));

let ready: Promise<void> | null = null;
/** The codecs, compiled once, on the first logo. */
function codecs(): Promise<void> {
  ready ??= (async () => {
    await initPng(await wasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"));
    await initJpeg(await wasm("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"));
    await initWebpDec(await wasm("@jsquash/webp/codec/dec/webp_dec.wasm"));
    await initWebpEnc(await wasm("@jsquash/webp/codec/enc/webp_enc.wasm"));
    await initResize(await wasm("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"));
  })();
  return ready;
}

const DECODERS = { png: decodePng, jpg: decodeJpeg, webp: decodeWebp } as const;

/** One decode at a time (see above). */
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** The thumbnail's size: the long side at most THUMB_PX, the shape kept, never enlarged. */
export function fit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMB_PX / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A logo as it should be served: a WebP thumbnail, the original when it's an
 * SVG or a small picture this can't decode, or null when it can't be served
 * (too large, unreadable, or not what it says it is).
 */
export async function thumbnail(pic: Picture): Promise<Picture | null> {
  if (pic.type === "image/svg+xml") return pic;
  let dims: ReturnType<typeof imageSize>;
  try {
    dims = imageSize(pic.body);
  } catch {
    return null;
  }
  const { width, height, type } = dims;
  if (!width || !height || width * height > MAX_PIXELS) return null;
  const decode = type && Object.hasOwn(DECODERS, type) ? DECODERS[type as keyof typeof DECODERS] : null;
  if (!decode) return pic.body.length <= PASS_BYTES ? pic : null;
  try {
    return await serially(async () => {
      await codecs();
      const bytes = pic.body.buffer.slice(pic.body.byteOffset, pic.body.byteOffset + pic.body.byteLength) as ArrayBuffer;
      const img = await decode(bytes);
      if (!img || img.width !== width || img.height !== height) return null;
      const small = img.width <= THUMB_PX && img.height <= THUMB_PX ? img : await resize(img, fit(img.width, img.height));
      return { body: Buffer.from(await encodeWebp(small, { quality: 80 })), type: "image/webp" };
    });
  } catch {
    return null;
  }
}
