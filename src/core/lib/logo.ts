/**
 * Token logos, proxied.
 *
 * Every launch token carries a `logo()` string and on this pad they are all
 * `ipfs://<cid>`, which no browser loads natively. Something has to turn that
 * into an https URL.
 *
 * Doing it in the page would mean the browser talking directly to a public
 * gateway, handing it your IP and the exact list of tokens you are looking at.
 * Doing it here means the browser only ever talks to localhost.
 *
 * The more important reason is that `logo()` is a string chosen by whoever
 * deployed the token, and fetching an attacker-supplied URL from inside this
 * process is a server-side request forgery primitive pointed at your own
 * loopback interface — including at this server's own trading endpoints. So the
 * contract's string is never fetched. Only the CID is taken out of it, and the
 * URL is rebuilt here against a gateway this file chooses.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { thumbnail } from "./thumb.js";

/**
 * Gateways, in preference order.
 *
 * More than one because the obvious defaults are not dependable: ipfs.io and
 * dweb.link both answer 429 under any real board load, and cloudflare-ipfs.com
 * no longer resolves at all. On 2026-09-27 Pinata, ipfs.io, dweb.link and
 * nftstorage.link all answered the VM 429 after a restart refetched the
 * board, while Filebase served a 1.6 MB logo in 0.09 s, so it goes first (P1f). A CID is content-addressed, so every gateway
 * returns identical bytes and falling through them costs only latency.
 *
 * They are tried in order rather than raced — racing would multiply a rate
 * limit by the number of gateways — and the one that last worked is tried
 * first, so a board of eighteen tokens pays the search once.
 */
const GATEWAYS = (process.env.IPFS_GATEWAYS ?? [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
].join(",")).split(",").map((g) => g.trim()).filter(Boolean);

let preferred = 0;

/**
 * Per image. Generous because these are not thumbnails: the logos on this pad
 * are routinely ~1MB webp, and a 512KB cap silently rejected most of the board
 * while looking exactly like a gateway failure.
 */
const MAX_BYTES = Number(process.env.LOGO_MAX_BYTES ?? 4 * 1024 * 1024);
/** Per gateway. Pinata regularly takes >6s on a cold CID. */
const TIMEOUT_MS = Number(process.env.LOGO_TIMEOUT_MS ?? 9000);
/**
 * Cache budget in bytes, not entries. What's cached is the thumbnail (a few
 * KB), so this holds thousands of logos, where it held under a hundred of the
 * ~1MB originals and the board kept fetching them again.
 */
const MAX_CACHE_BYTES = Number(process.env.LOGO_CACHE_BYTES ?? 96 * 1024 * 1024);

export type Logo = { body: Buffer; type: string };

const cache = new Map<string, Logo>();
/** Negative results too, so a broken CID is not re-fetched on every render. */
const failed = new Map<string, number>();
// Short, because the usual cause is a gateway rate limit rather than a bad
// CID, and a 10-minute lockout turns a transient 429 into a permanently
// blank card for that token.
const FAIL_TTL_MS = Number(process.env.LOGO_FAIL_TTL_MS ?? 90_000);

const inflight = new Map<string, Promise<Logo | null>>();

/**
 * Thumbnails on disk (P1f), when LOGO_DIR names a directory: a restart or a
 * deploy empties the memory cache, and refetching a whole board at once is
 * what gets the gateways to answer 429. Each file is named by the SHA-256 of
 * the CID path, so nothing from the contract reaches a file name, and holds
 * the type, a newline and the bytes. At most LOGO_DISK_MAX files are kept,
 * the oldest going first.
 */
const DIR = process.env.LOGO_DIR || null;
const DISK_MAX = Number(process.env.LOGO_DISK_MAX ?? 20_000);
const fileOf = (path: string) => join(DIR!, createHash("sha256").update(path).digest("hex"));
let writes = 0;

function fromDisk(path: string): Logo | null {
  if (!DIR) return null;
  try {
    const raw = readFileSync(fileOf(path));
    const nl = raw.indexOf(10);
    if (nl <= 0 || nl > 40) return null;
    const type = raw.subarray(0, nl).toString("latin1");
    if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(type)) return null;
    return { type, body: raw.subarray(nl + 1) };
  } catch {
    return null;
  }
}

function toDisk(path: string, l: Logo): void {
  if (!DIR) return;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileOf(path), Buffer.concat([Buffer.from(l.type + "\n", "latin1"), l.body]));
    if (++writes % 200 === 0) prune();
  } catch (e) {
    console.warn(`[logo] could not keep a thumbnail on disk: ${(e as Error).message}`);
  }
}

function prune(): void {
  const files = readdirSync(DIR!).filter((f) => /^[0-9a-f]{64}$/.test(f));
  if (files.length <= DISK_MAX) return;
  const aged = files.map((f) => ({ f, t: statSync(join(DIR!, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of aged.slice(0, files.length - DISK_MAX)) unlinkSync(join(DIR!, f));
}

/**
 * Pull a usable CID + path out of whatever the contract returned.
 *
 * Anything that is not an ipfs URI is rejected outright rather than guessed at:
 * an http URL here would be exactly the SSRF case this exists to avoid, and a
 * token whose logo does not load simply falls back to its initials.
 */
export function ipfsPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s.toLowerCase().startsWith("ipfs://")) return null;

  let rest = s.slice(7).replace(/^ipfs\//i, "");
  // Strip any query or fragment; they have no meaning to a gateway path and
  // are the obvious place to try to smuggle something.
  rest = rest.split(/[?#]/)[0]!;
  if (!rest) return null;

  // base32 CIDv1 or base58 CIDv0, optionally followed by a simple path. No
  // dot segments, so nothing can climb out of /ipfs/.
  if (!/^[A-Za-z0-9]{46,120}(\/[A-Za-z0-9._-]+)*$/.test(rest)) return null;
  if (rest.includes("..")) return null;
  return rest;
}

async function pullFrom(gateway: string, path: string): Promise<Logo | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(gateway + path, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return null;

    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    // Only images. A gateway answering 200 with an HTML error page — which the
    // rate-limited ones do — must not get cached and served back as a logo.
    if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(type)) return null;

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return null;

    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_BYTES) return null;

    return { body, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Try the last gateway that worked, then the rest in order. */
async function pull(path: string): Promise<Logo | null> {
  for (let i = 0; i < GATEWAYS.length; i++) {
    const idx = (preferred + i) % GATEWAYS.length;
    const got = await pullFrom(GATEWAYS[idx]!, path);
    if (got) {
      if (idx !== preferred) {
        console.log(`[logo] switching to ${GATEWAYS[idx]}`);
        preferred = idx;
      }
      return got;
    }
  }
  return null;
}

export async function logo(raw: string): Promise<Logo | null> {
  const path = ipfsPath(raw);
  if (!path) return null;

  const hit = cache.get(path);
  if (hit) return hit;
  const kept = fromDisk(path);
  if (kept) {
    remember(path, kept);
    return kept;
  }

  const failedAt = failed.get(path);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) return null;

  // One fetch per CID even when a whole board of cards asks at once.
  const existing = inflight.get(path);
  if (existing) return existing;

  const job = (async () => {
    // Shrunk once on arrival (thumb.ts, P1f): the cache and every visitor get the thumbnail.
    const pulled = await pull(path);
    const got = pulled ? await thumbnail(pulled) : null;
    if (got) {
      remember(path, got);
      toDisk(path, got);
    } else {
      failed.set(path, Date.now());
    }
    inflight.delete(path);
    return got;
  })();

  inflight.set(path, job);
  return job;
}

/** Into the memory cache, oldest-first out once over budget (a Map keeps insertion order). */
function remember(path: string, got: Logo): void {
  cache.set(path, got);
  failed.delete(path);
  let total = 0;
  for (const l of cache.values()) total += l.body.length;
  while (total > MAX_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    total -= cache.get(oldest)!.body.length;
    cache.delete(oldest);
  }
}

export const logoStats = () => ({
  gateway: GATEWAYS[preferred],
  cached: cache.size,
  failed: failed.size,
  bytes: [...cache.values()].reduce((s, l) => s + l.body.length, 0),
});
