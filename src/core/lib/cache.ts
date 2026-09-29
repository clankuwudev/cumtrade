/**
 * Small in-process cache split by how the underlying value can change.
 *
 * Most of what the checker reads is fixed at deploy time — a token's name,
 * a curve's fee, its graduation threshold, its phantom reserve. Re-reading
 * those on every refresh is the bulk of the call volume, and none of it can
 * ever return a different answer.
 *
 * Both maps are bounded (public-release B4.1b): least recently used goes
 * first past `CACHE_MAX_ENTRIES` each. Every value here can be read again,
 * so dropping one costs a read, never a wrong answer. Without the bound, a
 * key nobody asks for again stayed forever, and hosted checks of addresses
 * that are never asked again (B5.1's `check:` answers) would grow it without
 * limit.
 */
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 20_000);

const perm = new Map<string, unknown>();
const ttl = new Map<string, { v: unknown; exp: number }>();
const inflight = new Map<string, Promise<unknown>>();
/** Entries dropped to keep a map at its bound, since boot. */
let evicted = 0;

/** Write as the newest entry. A Map iterates oldest first, so the bound drops from the front. */
function put<V>(m: Map<string, V>, key: string, v: V) {
  m.delete(key);
  m.set(key, v);
  while (m.size > MAX_ENTRIES) {
    m.delete(m.keys().next().value as string);
    evicted++;
  }
}

/** A read that hits makes the entry the newest. */
function touch<V>(m: Map<string, V>, key: string, v: V) {
  m.delete(key);
  m.set(key, v);
}

/** Value can never change once deployed. Cached until the cache is full. */
export async function immutable<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (perm.has(key)) {
    const v = perm.get(key) as T;
    touch(perm, key, v);
    return v;
  }
  return dedupe(key, async () => {
    const v = await load();
    put(perm, key, v);
    return v;
  });
}

/** Value changes, but not so fast that a short cache is wrong. */
export async function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = ttl.get(key);
  if (hit) {
    if (hit.exp > Date.now()) {
      touch(ttl, key, hit);
      return hit.v as T;
    }
    // Expired: gone now, not whenever it would next be written.
    ttl.delete(key);
  }
  return dedupe(key, async () => {
    const v = await load();
    put(ttl, key, { v, exp: Date.now() + ms });
    return v;
  });
}

/**
 * Collapse concurrent identical work. Without this, a burst of launches on the
 * dashboard starts the same scan several times over.
 */
export function dedupe<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = load().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p as Promise<T>;
}

/** Populate a TTL entry directly, for values fetched in bulk elsewhere. */
export function seed<T>(key: string, value: T, ms: number) {
  put(ttl, key, { v: value, exp: Date.now() + ms });
}

/** Drop an entry so the next read goes back to the source. */
export function forget(key: string) {
  perm.delete(key);
  ttl.delete(key);
}

export function cacheStats() {
  return { permanent: perm.size, ttl: ttl.size, inflight: inflight.size, evicted };
}

export function clearCache() {
  perm.clear();
  ttl.clear();
}
