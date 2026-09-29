/**
 * Crash-safe JSON files.
 *
 * Every store in this project used to write with a bare `writeFileSync`, which
 * truncates the file and then fills it, and read with `JSON.parse` inside a
 * catch that returned an empty default. Those two choices compound: a process
 * killed mid-write leaves a torn file, the next read calls it empty, and the
 * next write saves "empty plus one change" over what was there. Reproduced
 * before this module existed — three positions and one torn write, then a
 * single buy, left a ledger containing only that buy. The same path reset the
 * daily spend cap to zero, so a torn `spend.json` let a trade through a limit
 * that was already nearly used.
 *
 * Note what this is NOT fixing: an in-process race. Every store is synchronous
 * end to end, and Node runs a synchronous read-modify-write to completion, so
 * two callbacks in one process cannot interleave a load and a save. The lock
 * here is for separate processes — the backfill CLI writes the same ledger the
 * server does.
 *
 * Three guarantees:
 *   - A write is atomic: temp file in the same directory, fsync, rename over.
 *     A reader sees the old file or the new one, never half of either.
 *   - An unreadable file is never treated as empty and overwritten. Its bytes
 *     are moved to `<file>.corrupt-<ms>` and the caller decides what that
 *     means — a ledger starts fresh with its history preserved, a spend cap
 *     fails closed.
 *   - `updateJson` holds a cross-process lock across read, change and write.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type ReadOpts<T> = {
  /** Reject a parsed value of the wrong shape as corrupt, not just bad JSON. */
  valid?: (v: unknown) => boolean;
  /** What to return once the unreadable file has been moved aside. */
  onCorrupt?: (quarantinedTo: string) => T;
};

export type WriteOpts = {
  /** JSON indentation. With one, a trailing newline is added as the stores always did. */
  space?: number;
  /**
   * File mode, applied when the temp file is created — so a secret never exists
   * on disk with default permissions, not even for the moment before a chmod.
   * No-op on most Windows filesystems.
   */
  mode?: number;
};

/** A lock older than this, or held by a process that no longer exists, is abandoned. */
const STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/** Locks this process holds, so a nested read inside `updateJson` does not wait on itself. */
const held = new Set<string>();

const sleepSync = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/**
 * Windows reports a file briefly held open by another process — an indexer, an
 * antivirus scan, the other side of a rename — as EPERM/EBUSY/EACCES rather
 * than waiting. Those clear in milliseconds; anything else is a real error.
 */
function retryFs<T>(fn: () => T, attempts = 20): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const c = errCode(e);
      if (i >= attempts || (c !== "EPERM" && c !== "EBUSY" && c !== "EACCES")) throw e;
      sleepSync(10);
    }
  }
}

function lockIsStale(lock: string): boolean {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age > STALE_MS) return true;
    const pid = Number(readFileSync(lock, "utf8").split(" ")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      // ESRCH: no such process. EPERM means it exists and is someone else's.
      return errCode(e) === "ESRCH";
    }
  } catch {
    return false; // vanished between checks — the next attempt will tell
  }
}

/** Run `fn` holding `<file>.lock`, created exclusively so only one process can. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  if (held.has(lock)) return fn();

  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST" && errCode(e) !== "EPERM") throw e;
      if (lockIsStale(lock)) {
        try { unlinkSync(lock); } catch { /* another process got there first */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${LOCK_WAIT_MS}ms waiting for ${lock}`);
      }
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }

  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    try { retryFs(() => unlinkSync(lock)); } catch { /* stale-lock recovery covers it */ }
  }
}

function parse<T>(raw: string, valid?: (v: unknown) => boolean): { ok: true; v: T } | { ok: false; why: string } {
  try {
    const v = JSON.parse(raw) as unknown;
    if (valid && !valid(v)) return { ok: false, why: "unexpected shape" };
    return { ok: true, v: v as T };
  } catch (e) {
    return { ok: false, why: (e as Error).message.slice(0, 80) };
  }
}

const readRaw = (file: string) => retryFs(() => readFileSync(file, "utf8"));

/**
 * Read a JSON file. Missing → `fallback`. Unreadable → moved aside, then
 * `onCorrupt` (default: `fallback`), loudly.
 *
 * An I/O error is thrown, not swallowed: "could not read" is not the same claim
 * as "is empty", and treating it as one is how the original bug worked.
 */
export function readJson<T>(file: string, fallback: T, opts: ReadOpts<T> = {}): T {
  if (!existsSync(file)) return fallback;
  const first = parse<T>(readRaw(file), opts.valid);
  if (first.ok) return first.v;

  // Re-check under the lock before quarantining: another process may be the
  // one that just replaced it, and moving a good file aside is its own bug.
  return withLock(file, () => {
    if (!existsSync(file)) return fallback;
    const again = parse<T>(readRaw(file), opts.valid);
    if (again.ok) return again.v;

    const to = `${file}.corrupt-${Date.now()}`;
    retryFs(() => renameSync(file, to));
    console.error(`[store] ${file} was unreadable (${again.why}). Its contents were moved ` +
      `to ${to} and nothing was overwritten.`);
    return opts.onCorrupt ? opts.onCorrupt(to) : fallback;
  });
}

/** Write atomically: a crash leaves the previous file intact, never a torn one. */
export function writeJson(file: string, data: unknown, opts: WriteOpts = {}): void {
  writeFileAtomic(file, JSON.stringify(data, null, opts.space) + (opts.space ? "\n" : ""), opts);
}

/**
 * The same guarantee for any text. Used for `.env` and the keystore, where a
 * torn write is not a lost ledger but a lost wallet: the keystore is the only
 * copy of the key, and `.env` holds the only passphrase that opens it.
 */
export function writeFileAtomic(file: string, body: string, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", opts.mode ?? 0o666);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    retryFs(() => renameSync(tmp, file));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Read, change and write under one cross-process lock.
 *
 * `fn` returns the new value, or `undefined` to leave the file untouched — so
 * a no-op mutation does not rewrite the file and bump its mtime.
 */
export function updateJson<T>(
  file: string, fallback: T, fn: (current: T) => T | undefined,
  opts: ReadOpts<T> & WriteOpts = {},
): T {
  return withLock(file, () => {
    const current = readJson(file, fallback, opts);
    const next = fn(current);
    if (next === undefined) return current;
    writeJson(file, next, opts);
    return next;
  });
}
