/**
 * Token logos, shrunk (P1f): a PNG, a JPEG and a WebP come back as small WebP
 * thumbnails with their shape kept; a picture claiming too many pixels is
 * refused before it is decoded; a format with no decoder passes through only
 * while small; an SVG passes as it was; garbage is refused. The fixtures are
 * made here with the codecs' own encoders, no network.
 *
 *   npm run test:thumb
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { imageSize } from "image-size";
import encodeJpeg, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import encodePng, { init as initPngEnc } from "@jsquash/png/encode.js";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import { MAX_PIXELS, PASS_BYTES, THUMB_PX, fit, thumbnail } from "./thumb.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const req = createRequire(import.meta.url);
const wasm = (spec: string) => WebAssembly.compile(readFileSync(req.resolve(spec)));
await initPngEnc(await wasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"));
await initJpegEnc(await wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"));
await initWebpEnc(await wasm("@jsquash/webp/codec/enc/webp_enc.wasm"));

/** A noisy picture, so it compresses like a real logo rather than to nothing. */
function picture(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 255; data[i + 1] = (seed >> 8) & 255; data[i + 2] = (seed >> 16) & 255; data[i + 3] = 255;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
const buf = (ab: ArrayBuffer) => Buffer.from(ab);

console.log("\nthe shape");
ok("a square shrinks to the long side", JSON.stringify(fit(947, 947)) === JSON.stringify({ width: THUMB_PX, height: THUMB_PX }));
ok("a wide one keeps its shape", JSON.stringify(fit(1200, 600)) === JSON.stringify({ width: THUMB_PX, height: THUMB_PX / 2 }));
ok("a small one is never enlarged", JSON.stringify(fit(40, 30)) === JSON.stringify({ width: 40, height: 30 }));

console.log("\nshrunk to WebP");
const big = picture(947, 890);
for (const [name, type, body] of [
  ["PNG", "image/png", buf(await encodePng(big))],
  ["JPEG", "image/jpeg", buf(await encodeJpeg(big, { quality: 90 }))],
  ["WebP", "image/webp", buf(await encodeWebp(big, { quality: 90 }))],
] as const) {
  const t = await thumbnail({ body, type });
  const dims = t ? imageSize(t.body) : null;
  ok(`a 947x890 ${name} (${Math.round(body.length / 1024)} KB) becomes a ${THUMB_PX}-px WebP`,
    t?.type === "image/webp" && dims?.type === "webp" && dims.width === THUMB_PX && dims.height === Math.round(890 * THUMB_PX / 947),
    t ? `${dims?.width}x${dims?.height}, ${t.body.length} B` : "null");
  ok(`…and far smaller`, !!t && t.body.length < body.length / 10, t ? `${t.body.length} B` : "null");
}
const tiny = buf(await encodePng(picture(40, 30)));
const t40 = await thumbnail({ body: tiny, type: "image/png" });
ok("a small PNG is re-encoded at its own size", !!t40 && imageSize(t40.body).width === 40 && imageSize(t40.body).height === 30);

console.log("\nrefused before decoding");
{
  // A real PNG's header, its IHDR rewritten to 60000 x 60000: decoded, that is 14 GB.
  const bomb = Buffer.from(tiny);
  bomb.writeUInt32BE(60000, 16);
  bomb.writeUInt32BE(60000, 20);
  ok("the test's header does claim 60000 x 60000", imageSize(bomb).width === 60000);
  ok(`a picture over ${MAX_PIXELS} pixels is refused`, (await thumbnail({ body: bomb, type: "image/png" })) === null);
}
ok("garbage is refused", (await thumbnail({ body: Buffer.from("<html>429 Too Many Requests</html>"), type: "image/png" })) === null);
{
  // A header that says PNG, a body cut short: the decoder fails, nothing is served.
  const cut = buf(await encodePng(picture(300, 300))).subarray(0, 200);
  ok("a truncated PNG is refused", (await thumbnail({ body: cut, type: "image/png" })) === null);
}

console.log("\npassed through");
{
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 10, 0, 0, 0, 0]), Buffer.alloc(64)]);
  const small = await thumbnail({ body: gif, type: "image/gif" });
  ok("a small GIF, which has no decoder here, is served as it came", small?.body === gif && small.type === "image/gif");
  const large = Buffer.concat([gif, Buffer.alloc(PASS_BYTES)]);
  ok(`…but not one over ${PASS_BYTES / 1024} KB`, (await thumbnail({ body: large, type: "image/gif" })) === null);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  ok("an SVG is served as it was", (await thumbnail({ body: svg, type: "image/svg+xml" }))?.body === svg);
}

console.log(failures === 0 ? "\n\x1b[32mall thumbnail checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
