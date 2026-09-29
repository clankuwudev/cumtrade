/**
 * Token logos kept on disk (P1f): a logo fetched once is shrunk, served, and
 * written under LOGO_DIR by the hash of its CID; a fresh process with no
 * working gateway still serves it from there; a damaged file is ignored, not
 * served. A local stand-in gateway, no network.
 *
 *   npm run test:logo
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

// A 1x1 PNG, from the gateway.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CID = "ipfs://bafybeia2vyour75yqvaktur6gj4mjluok4joddfxss274n3pdz4s3m2t4i";
let asked = 0;
const gateway = createServer((_req, res) => { asked++; res.writeHead(200, { "content-type": "image/png" }).end(PNG); });
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
const port = (gateway.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), "logo-"));
const LOGO = fileURLToPath(new URL("./logo.ts", import.meta.url)).replace(/\\/g, "/");
/** One logo() call in its own process, as after a restart: prints the type and size, or null. */
// Asynchronous: a synchronous spawn would stall this process, and with it the stand-in gateway.
const inProcess = (gateways: string) => new Promise<{ stdout: string; stderr: string }>((resolve) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
  `const { logo } = await import("file:///${LOGO.replace(/^\//, "")}");
   const l = await logo(${JSON.stringify(CID)});
   console.log(l ? l.type + " " + l.body.length : "null");`,
], { encoding: "utf8", env: { ...process.env, LOGO_DIR: dir, IPFS_GATEWAYS: gateways, LOGO_TIMEOUT_MS: "2000" } },
  (_e, stdout, stderr) => resolve({ stdout, stderr })));

try {
  console.log("\nfetched once, kept");
  const first = await inProcess(`http://127.0.0.1:${port}/ipfs/`);
  ok("the first process serves the shrunk logo", /^image\/webp \d+$/.test(first.stdout.trim()), first.stdout.trim() || first.stderr.slice(0, 300));
  ok("…asking the gateway once", asked === 1, `${asked}`);
  const files = readdirSync(dir);
  ok("…and keeps one file, named by a hash", files.length === 1 && /^[0-9a-f]{64}$/.test(files[0]!), files.join(","));

  console.log("\nafter a restart, with every gateway down");
  const second = await inProcess("http://127.0.0.1:1/ipfs/");
  ok("a fresh process serves it from disk", second.stdout.trim() === first.stdout.trim(), second.stdout.trim());
  ok("…without asking a gateway", asked === 1, `${asked}`);

  console.log("\na damaged file");
  writeFileSync(join(dir, files[0]!), "text/html\n<script>alert(1)</script>");
  const third = await inProcess("http://127.0.0.1:1/ipfs/");
  ok("a file whose type isn't an image is not served", third.stdout.trim() === "null", third.stdout.trim());
} finally {
  gateway.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n\x1b[32mall logo checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
