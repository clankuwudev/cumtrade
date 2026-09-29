import type { Address } from "viem";
import { VENUE, FACTORIES, genesisFloor, robinhood } from "../chain.js";
import { client, logRoute, tailRoute } from "./client.js";
import { tokenAbi } from "../abi.js";
import { openIndexStore, type IndexStore } from "./indexStore.js";
import { createFollower, type Committed, type Follower } from "./follower.js";
import { attachFollower, followerCommitted, launchSource } from "./launchIndex.js";
import { useIndexedHolders } from "../checker/analyze.js";
import { useIndexedPools } from "../market/v4.js";
import { POOL_MANAGER } from "../record/prices.js";

/**
 * topic0 of the factory event in the transaction that creates a graduated
 * token's V4 pool, topic1 the token. Inferred from the chain: on all three
 * graduations so far (CABO, AGI, CLANKCAT) it follows the graduation event
 * (0xcdb72f15…) by a few hundred blocks, in the block of the pool's
 * Initialize (D1.3).
 */
const POOL_CREATED_TOPIC = "0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259";

/**
 * The process's chain index (spec D1.1): the store on disk, the follower
 * that fills it, and the launch index reading from both. An entry opens it
 * before its backfill; the store is closed when the process exits.
 *
 * If the file cannot be opened at all (a read-only directory, say), the
 * process carries on without it: the launch index scans for itself, as it
 * did before D1, and the reason is logged. Losing the index is slower, not
 * wrong.
 */

let current: { store: IndexStore; follower: Follower } | null = null;
const listeners = new Set<(w: Committed) => void>();

/** The venue a file indexes: a file for any other is rebuilt. */
const venueKey = () =>
  `${VENUE.key}:${robinhood.id}:${FACTORIES.map((f) => f.address.toLowerCase()).sort().join(",")}`;

export function openChainIndex(path: string): Follower | null {
  if (current) return current.follower;
  let store: IndexStore;
  try {
    store = openIndexStore(path, { venue: venueKey() });
  } catch (e) {
    console.error(`[index] could not open ${path}; the launch index scans for itself: ${(e as Error).message}`);
    return null;
  }
  const follower = createFollower({
    store,
    floor: genesisFloor(),
    launches: launchSource(),
    pools: { manager: POOL_MANAGER, createdTopic: POOL_CREATED_TOPIC },
    tail: tailRoute,
    wide: logRoute,
    followMs: Number(process.env.FOLLOW_MS ?? 2_000),
    // Read at the cursor block through the fast provider, folded into one
    // multicall per token (D1.5).
    drift: {
      everyMs: Number(process.env.INDEX_DRIFT_MS ?? 600_000),
      balances: async (token, owners, block) => {
        const got = await Promise.all(owners.map((o) => client.readContract({
          address: token as Address, abi: tokenAbi, functionName: "balanceOf", args: [o as Address], blockNumber: block,
        }) as Promise<bigint>));
        return new Map(owners.map((o, i) => [o, got[i]!]));
      },
      supply: (token, block) => client.readContract({
        address: token as Address, abi: tokenAbi, functionName: "totalSupply", blockNumber: block,
      }) as Promise<bigint>,
    },
    onCommit: (w) => {
      followerCommitted({ to: w.to, launches: w.launches });
      for (const fn of listeners) {
        try { fn(w); } catch (e) { console.error("[index] a commit listener failed:", (e as Error).message); }
      }
    },
  });
  attachFollower(follower, store.launches());
  useIndexedHolders((token) => follower.holders(token));
  useIndexedPools((token) => store.pools(token));
  current = { store, follower };
  // Every way out that runs JavaScript: a signal handler that calls exit
  // (self's wallet has one), an exit of our own, the end of the event loop.
  process.once("exit", () => {
    follower.stop();
    store.close();
  });
  const s = store.stats();
  const cursor = follower.cursor();
  console.log(`  index   ${path} · ${s.launches} launch(es), ${s.withHolders} with holders`
    + `${cursor !== null ? ` · read to block ${cursor}` : " · empty, reading history"}`);
  return follower;
}

/** Whether this process has an index. Without one, everything scans for itself. */
export const hasChainIndex = () => current !== null;

/**
 * A token's holders and supply from the index (D1.2), if its Transfers are
 * in up to the cursor; null for one the index has not caught up yet.
 */
export function indexedHolders(token: string) {
  return current?.follower.holders(token) ?? null;
}

/**
 * What a ledger for `address` reads from the index (D1.4), or null without
 * an index or before its first round.
 */
export function indexedLedgerInput(address: string) {
  return current?.follower.ledgerOf(address) ?? null;
}

/**
 * A token's curve trades from the index, with their receipts and its
 * graduation block (p-sell-verdict.md P4a), or null without an index or
 * before its first round.
 */
export function indexedTokenTrades(token: string) {
  return current?.follower.tokenTrades(token) ?? null;
}

/**
 * Every address the index's curve trades name, less the curves, at the
 * cursor (X29a), or null without an index or before its first round.
 */
export function indexedTraders() {
  return current?.follower.traders() ?? null;
}

/**
 * Graduated tokens and each token's newest curve-trade block, for the board's
 * dead-launch rule (B6), or null without an index.
 */
export function indexedActivity() {
  return current?.store.activity() ?? null;
}

/** Every launch the index holds, oldest first: each curve's token (X29a). Empty without an index. */
export function indexedLaunches() {
  return current?.store.launches() ?? [];
}

/** The follower's cursor, or null without an index or before its first round. */
export function indexCursor(): bigint | null {
  return current?.follower.cursor() ?? null;
}

/**
 * The follower's health for /healthz (D1.5). Every field null without an
 * index, so the answer keeps one shape.
 */
export function indexHealth() {
  return current?.follower.health() ?? { followerLagBlocks: null, building: null, followerRoundAgeSec: null };
}

/** Called after every window the follower commits. Returns the unsubscribe. */
export function onIndexCommit(fn: (w: Committed) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Something happened on chain: read it soon (the websocket, board.ts). */
export function wakeFollower() {
  current?.follower.wake();
}
