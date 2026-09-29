/**
 * The queue of refused launches — public-release B4.6.
 *
 * Fake gate, prefetch and analysis. No chain, no board.
 *
 *   npm run test:loggate
 */
import type { Address } from "viem";
import { LogsBusy } from "../core/lib/logGate.js";
import { createLogRetry, type Waiting } from "./logRetry.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""}`);
};

const launch = (n: number): Waiting => ({
  token: `0x${n.toString(16).padStart(40, "0")}` as Address,
  curve: `0x${(n + 1000).toString(16).padStart(40, "0")}` as Address,
  creator: `0x${"c".repeat(40)}` as Address,
  block: 100 + n,
});

/** A rig: the gate is a flag; prefetch and analyse record what they were given. */
function rig(opts: { pool?: number; prefetch?: (b: Waiting[]) => Promise<void>; analyse?: (w: Waiting) => Promise<void> } = {}) {
  const log = { prefetches: [] as number[], analysed: [] as string[], concurrent: 0, maxConcurrent: 0 };
  const state = { open: true };
  const q = createLogRetry({
    gateOpen: () => state.open,
    prefetch: opts.prefetch ?? (async (b) => { log.prefetches.push(b.length); }),
    analyse: opts.analyse ?? (async (w) => {
      log.concurrent++;
      log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
      await new Promise((r) => setTimeout(r, 1));
      log.analysed.push(w.token);
      log.concurrent--;
    }),
    pool: opts.pool ?? 8,
  });
  return { q, log, state };
}

console.log("\nwaiting and running");
{
  const { q, log, state } = rig();
  state.open = false;
  for (let i = 1; i <= 20; i++) q.defer(launch(i));
  q.defer(launch(3)); // the same launch twice waits once
  ok("20 launches wait, once each", q.size === 20, String(q.size));
  let r = await q.tick();
  ok("while the gate is closed, a tick does nothing", r.analysed === 0 && log.prefetches.length === 0 && q.size === 20);
  state.open = true;
  r = await q.tick();
  ok("once it opens, one tick analyses all of them", r.analysed === 20 && log.analysed.length === 20 && q.size === 0);
  ok("…one prefetch per `pool` of them, never one for the whole batch", log.prefetches.join() === "8,8,4", log.prefetches.join());
  ok("…no more than `pool` at a time", log.maxConcurrent <= 8, String(log.maxConcurrent));
  r = await q.tick();
  ok("an empty queue does nothing", r.analysed === 0 && log.prefetches.length === 3);
}

console.log("\nrefused again");
{
  const { q, log } = rig({ prefetch: async () => { throw new LogsBusy(30_000); } });
  for (let i = 1; i <= 5; i++) q.defer(launch(i));
  const r = await q.tick();
  ok("a refused prefetch analyses nothing", r.analysed === 0 && log.analysed.length === 0);
  ok("…and everything keeps waiting", q.size === 5);
}
{
  // The gate closes during the pass: the first chunk's analyses were refused.
  const state = { open: true };
  const q = createLogRetry({
    gateOpen: () => state.open,
    prefetch: async () => {},
    analyse: async (w) => {
      state.open = false; // a refusal closed the gate
      q.defer(w);         // and analyseInto put this one back
    },
    pool: 4,
  });
  for (let i = 1; i <= 10; i++) q.defer(launch(i));
  const r = await q.tick();
  ok("a refusal mid-pass stops the pass after that chunk", r.analysed === 4, String(r.analysed));
  ok("…and nothing is lost: all 10 still wait", q.size === 10, String(q.size));
}
{
  const { q, log } = rig({ prefetch: async () => { throw new Error("timeout"); } });
  for (let i = 1; i <= 3; i++) q.defer(launch(i));
  const r = await q.tick();
  ok("a prefetch that fails some other way still lets the analyses run", r.analysed === 3 && log.analysed.length === 3);
}

console.log("\nsmall scans, newest first");
{
  // The node refuses the third scan: the first two chunks are done, the rest wait.
  let scans = 0;
  const order: number[] = [];
  const q = createLogRetry({
    gateOpen: () => true,
    prefetch: async (b) => { if (++scans === 3) throw new LogsBusy(30_000); order.push(...b.map((w) => w.block)); },
    analyse: async () => {},
    pool: 4,
  });
  for (let i = 1; i <= 10; i++) q.defer(launch(i));
  const r = await q.tick();
  ok("a refusal partway keeps what was already analysed", r.analysed === 8 && q.size === 2, `${r.analysed} / ${q.size}`);
  ok("…the newest launches went first", order.join() === [...order].sort((a, b) => b - a).join() && order[0] === Math.max(...order), order.join());
}

console.log("\none pass at a time");
{
  let release!: () => void;
  const gatePrefetch = new Promise<void>((r) => { release = r; });
  const { q, log } = rig({ prefetch: async (b) => { log.prefetches.push(b.length); await gatePrefetch; } });
  for (let i = 1; i <= 3; i++) q.defer(launch(i));
  const first = q.tick();
  const second = await q.tick();
  ok("a tick while one is running does nothing", second.analysed === 0 && log.prefetches.length === 1);
  release();
  const r = await first;
  ok("…and the running one finishes the batch", r.analysed === 3);
}

console.log("\na launch that left the board (B4.1)");
{
  const { q, log } = rig();
  for (let i = 1; i <= 3; i++) q.defer(launch(i));
  q.forget(launch(2).token.toUpperCase().replace("0X", "0x"));
  ok("forget drops it, in any casing", q.size === 2 && !q.has(launch(2).token) && q.has(launch(1).token));
  await q.tick();
  ok("…and the next tick does not analyse it", log.analysed.length === 2 && !log.analysed.includes(launch(2).token),
    log.analysed.join(","));
}

console.log(failures === 0
  ? "\n\x1b[32mall retry queue checks passed\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
