import type { Address } from "viem";
import { logRoute, type LogEndpointClient } from "./client.js";
import { FACTORIES, VENUE, genesisFloor } from "../chain.js";
import { isRateLimited } from "./logGate.js";
import { dedupe } from "./cache.js";
import type { Follower, LaunchSource } from "./follower.js";
import type { LaunchRow } from "./indexStore.js";

export type LaunchRecord = {
  token: Address; curve: Address; creator: Address; block: bigint;
  /**
   * The curve's graduation target, carried in the event's third data word on
   * both venues. Free at the moment of a launch, which is what makes it the
   * one economic signal a pre-filter can use before anything has traded
   * (pons-venue.md V5).
   */
  graduationThreshold: bigint;
};

/**
 * Shared, incrementally-maintained index of every launch the factory has ever
 * emitted.
 *
 * Before this, each analyse() ran two separate full-range eth_getLogs scans —
 * one to find the token's own launch block, one to find the creator's other
 * launches — so a dashboard backfill of N tokens meant 2N full-history scans of
 * the same data. Now the range is scanned once and topped up from the last
 * seen block.
 *
 * With the chain follower attached (spec D1.1, `attachFollower`), the
 * follower reads launches and this only keeps them in memory: loaded from the
 * index at boot, added to as each window is committed. Without it (the CLI,
 * tests, a process that could not open its index), it scans for itself.
 */
let records: LaunchRecord[] = [];
let scannedTo = 0n;
let lastSync = 0;
let follower: Follower | null = null;

/**
 * Blocks land every ~0.1s, so "is the head newer than my last scan?" is true
 * essentially always. Without a floor on how often we act on that, every
 * lookup triggers a fresh getBlockNumber + getLogs pair.
 */
const MIN_SYNC_MS = 5_000;

type RawLog = { topics: `0x${string}`[]; blockNumber: `0x${string}`; data: `0x${string}` };

/**
 * A range so small that a node refusing it is refusing for some other reason.
 * Below this the split gives up and lets the error through, rather than
 * turning one bad request into thousands.
 */
const MIN_WINDOW = 25_000n;

const hex = (n: bigint) => `0x${n.toString(16)}`;

async function getLogs(ep: LogEndpointClient, from: bigint, to: bigint): Promise<RawLog[]> {
  return (await ep.request({
    method: "eth_getLogs",
    params: [{
      // Every listed factory in one call: a node filters an address array
      // itself (B1.5). Never the topic alone: other launchpads on this chain
      // emit the very same event, and none of them is this venue.
      address: FACTORIES.map((f) => f.address),
      topics: [VENUE.launchTopic],
      fromBlock: hex(from),
      toBlock: hex(to),
    }],
  } as never)) as RawLog[];
}

/**
 * Every launch log in a range, splitting the range if the node will not serve
 * it whole.
 *
 * The public node caps how wide a scan may be, and the cap is not documented
 * or announced — it answers "Missing or invalid parameters" (current-issues
 * #2). One venue's history is 4M blocks and fits; the other's is 40M and does
 * not. Rather than guess a window, ask for the whole thing and halve on
 * refusal: a venue that fits pays one call, and one that does not pays the
 * fewest calls that do fit.
 *
 * A rate-limited refusal is NOT a range problem, and splitting on one would
 * turn a single 429 into a fan-out of them — exactly what B4.6 exists to stop.
 * So it is re-thrown for the gate to handle.
 */
async function fetchLogs(ep: LogEndpointClient, from: bigint, to: bigint): Promise<RawLog[]> {
  try {
    return await getLogs(ep, from, to);
  } catch (e) {
    if (isRateLimited(e)) throw e;
    if (to - from <= MIN_WINDOW) throw e;
    const mid = from + (to - from) / 2n;
    const [a, b] = [await fetchLogs(ep, from, mid), await fetchLogs(ep, mid + 1n, to)];
    return [...a, ...b];
  }
}

/**
 * The log endpoint's own head, and every launch up to it (D1.0).
 *
 * The cursor used to be the fast provider's head, read before a scan that ran
 * to the log node's "latest". Where the provider was ahead, the blocks
 * between the two heads were marked scanned and never read. Now one endpoint
 * names its head and is asked for exactly that range, so the cursor never
 * passes a block that endpoint did not answer for. If it fails, the next
 * endpoint on the route does both again.
 */
function scanTo(from: bigint | null): Promise<{ head: bigint; logs: RawLog[] }> {
  return logRoute.run(async (ep) => {
    const head = BigInt(await ep.request({ method: "eth_blockNumber" } as never) as string);
    if (from === null || head < from) return { head, logs: [] };
    return { head, logs: await fetchLogs(ep, from, head) };
  });
}

const dataWord = (data: string, i: number): bigint => {
  const at = 2 + i * 64;
  const word = data.slice(at, at + 64);
  return word.length === 64 ? BigInt(`0x${word}`) : 0n;
};

const decode = (l: RawLog): LaunchRecord => ({
  token: `0x${l.topics[1]!.slice(26)}` as Address,
  curve: `0x${l.topics[2]!.slice(26)}` as Address,
  creator: `0x${l.topics[3]!.slice(26)}` as Address,
  block: BigInt(l.blockNumber),
  // Three words; the target is the third. Verified on a live log from both
  // factories, 2026-09-21.
  graduationThreshold: dataWord(l.data, 2),
});

/** Add launches not known yet, keeping block order. */
function merge(add: LaunchRecord[]) {
  if (add.length === 0) return;
  const seen = new Set(records.map((r) => r.token.toLowerCase()));
  let changed = false;
  for (const r of add) {
    if (seen.has(r.token.toLowerCase())) continue;
    seen.add(r.token.toLowerCase());
    records.push(r);
    changed = true;
  }
  if (changed) records.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
}

const fromRow = (r: LaunchRow): LaunchRecord => ({
  token: r.token as Address, curve: r.curve as Address, creator: r.creator as Address,
  block: r.block, graduationThreshold: r.threshold,
});

/**
 * Where the follower finds launches (D1.1): every listed factory's Launch
 * event. Never the topic alone: other launchpads emit the very same event.
 */
export function launchSource(): LaunchSource {
  return {
    factories: FACTORIES.map((f) => f.address),
    topic: VENUE.launchTopic,
    decode: (l) => {
      const r = decode(l as unknown as RawLog);
      return {
        token: r.token, curve: r.curve, creator: r.creator, factory: l.address,
        block: r.block, logIndex: Number(BigInt(l.logIndex)), threshold: r.graduationThreshold,
      };
    },
  };
}

/**
 * Serve launches from the follower (D1.1): what the index already holds now,
 * and each window as the follower commits it (`followerCommitted`).
 */
export function attachFollower(f: Follower, stored: LaunchRow[]) {
  follower = f;
  merge(stored.map(fromRow));
  scannedTo = f.cursor() ?? 0n;
}

/** What the follower just committed: its launches, and how far it has read. */
export function followerCommitted(w: { to: bigint; launches?: LaunchRow[] }) {
  merge((w.launches ?? []).map(fromRow));
  if (w.to > scannedTo) scannedTo = w.to;
}

/**
 * Refresh the index. The first call scans full history; later calls only pull
 * blocks newer than the last scan, so the steady-state cost is one cheap
 * getLogs regardless of how many tokens are being analysed.
 *
 * With the follower: its loop keeps the index current, so this only waits for
 * its first round, or runs a round when the loop is stopped (self mode's off
 * switch). A first round that fails throws, as a first scan does below.
 */
export async function syncIndex(force = false): Promise<LaunchRecord[]> {
  if (follower) {
    const f = follower;
    if (!force && f.caughtUp() && (f.running() || Date.now() - lastSync < MIN_SYNC_MS)) return records;
    lastSync = Date.now();
    try {
      await f.round();
    } catch (e) {
      if (!f.caughtUp()) throw e;
    }
    return records;
  }
  if (!force && scannedTo > 0n && Date.now() - lastSync < MIN_SYNC_MS) return records;
  return dedupe("launch-index-sync", async () => {
    let head: bigint;
    let logs: RawLog[];
    try {
      ({ head, logs } = await scanTo(scannedTo > 0n ? scannedTo + 1n : genesisFloor()));
      lastSync = Date.now();
      if (scannedTo > 0n && head <= scannedTo) return records;
    } catch (e) {
      lastSync = Date.now();
      // Never scanned: what we have is nothing, and an empty list would be a
      // lie. The board would read it as "no launches", and every creator check
      // as "no prior launches", which lets a serial creator through. Fail
      // instead, so the caller waits and tries again (public-release B4.6).
      if (scannedTo === 0n) throw e;
      // The public log endpoint is occasionally slow enough to time out.
      // Serve what we already have and try again on the next tick rather than
      // taking the caller down with us; `scannedTo` is left untouched so the
      // missed range is picked up next time.
      return records;
    }

    merge(logs.map(decode));
    scannedTo = head;
    return records;
  });
}

/**
 * Add a launch seen live over the websocket, so it is known before the next
 * scan. The cursor stays where it is (D1.0): a websocket launch says nothing
 * about the blocks before it, and moving the cursor to it skipped any launch
 * in between. The next scan reads that range and skips this one as seen.
 */
export function noteLaunch(r: LaunchRecord) {
  merge([r]);
}

export async function launchOf(token: Address): Promise<LaunchRecord | undefined> {
  const key = token.toLowerCase();
  let hit = records.find((r) => r.token.toLowerCase() === key);
  if (hit) return hit;
  await syncIndex();
  return records.find((r) => r.token.toLowerCase() === key);
}

export async function launchesByCreator(creator: Address, exclude?: Address): Promise<LaunchRecord[]> {
  await syncIndex();
  const c = creator.toLowerCase();
  const ex = exclude?.toLowerCase();
  return records.filter((r) => r.creator.toLowerCase() === c && r.token.toLowerCase() !== ex);
}

export async function allLaunches(): Promise<LaunchRecord[]> {
  await syncIndex();
  return records;
}

export function indexStats() {
  return {
    launches: records.length, scannedTo: scannedTo.toString(),
    ...(follower ? { follower: follower.state() } : {}),
  };
}
