/**
 * Provider throughput governor.
 *
 * Alchemy rate-limits on compute units per second, not on request count. Our
 * boot burst is ~858 CU (18 eth_call + 15 eth_getCode + 2 eth_simulateV1); at
 * pool=8 concurrency that lands in about 1.6s, which is ~536 CU/s — over the
 * 500 CU/s cap. Cutting the number of calls did not fix that on its own,
 * because what matters is how tightly they are packed.
 *
 * Every provider-bound request takes tokens from a bucket priced in CU, so the
 * burst is spread instead of clipped. Total work is unchanged; it just arrives
 * at a rate the plan allows.
 */

/** Published Alchemy CU costs. Anything unlisted is charged as an eth_call. */
export const CU_COST: Record<string, number> = {
  eth_call: 26,
  eth_getLogs: 60,
  eth_simulateV1: 40,
  eth_sendRawTransaction: 50,
  eth_getCode: 20,
  eth_getBalance: 20,
  eth_getBlockByNumber: 20,
  eth_getBlockByHash: 20,
  eth_estimateGas: 20,
  eth_getTransactionReceipt: 15,
  eth_getTransactionByHash: 15,
  eth_blockNumber: 10,
  eth_subscribe: 10,
  eth_chainId: 0,
  eth_gasPrice: 10,
  eth_getTransactionCount: 20,
  // The track record's history read (docs/specs/track-record.md).
  alchemy_getAssetTransfers: 150,
};

export const cuOf = (method: string) => CU_COST[method] ?? 26;

type Waiter = { cost: number; release: () => void };

class CuBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
  }

  /**
   * Enough to release a waiter of this cost. A request dearer than the whole
   * burst (alchemy_getAssetTransfers is 150 against a 50 burst) could never be
   * released otherwise, and as the head of the queue it would hold back every
   * call behind it. It goes once the bucket is full, pays its full price, and
   * the balance runs negative, so the rate over time is still the rate.
   */
  private affords(cost: number) {
    return this.tokens >= Math.min(cost, this.burst);
  }

  take(cost: number): Promise<void> {
    this.refill();
    // Fast path: capacity to spare and nobody already queued.
    if (this.queue.length === 0 && this.affords(cost)) {
      this.tokens -= cost;
      return Promise.resolve();
    }
    return new Promise<void>((release) => {
      this.queue.push({ cost, release });
      this.schedule();
    });
  }

  /**
   * Tokens are deducted HERE, synchronously, at the moment a waiter is
   * released — not in the resumed take(). Deducting after the await lets the
   * scheduler free many waiters before any of them has paid, which measured as
   * 314 CU/s against a 250 ceiling. Each waiter also carries its own cost, so a
   * cheap call cannot be gated behind an expensive one's price.
   */
  private schedule() {
    if (this.timer) return;
    const step = () => {
      this.timer = null;
      this.refill();
      while (this.queue.length > 0 && this.affords(this.queue[0]!.cost)) {
        const w = this.queue.shift()!;
        this.tokens -= w.cost;
        w.release();
      }
      if (this.queue.length > 0) {
        const deficit = Math.min(this.queue[0]!.cost, this.burst) - this.tokens;
        this.timer = setTimeout(step, Math.max(10, (deficit / this.ratePerSec) * 1000));
      }
    };
    this.timer = setTimeout(step, 0);
  }

  stats() {
    this.refill();
    return { available: Math.round(this.tokens), waiting: this.queue.length, rate: this.ratePerSec };
  }
}

/**
 * Default 200 CU/s against a 500 CU/s plan cap.
 *
 * The budget is deliberately well under the cap because **this bucket is
 * per-process**. Running the dashboard, the manager and the sniper together
 * means three independent buckets, so the ceiling that matters is
 * RATE x (number of processes). At 200 that is 600 for all three — still tight,
 * so set ALCHEMY_CU_PER_SEC lower if you run several at once, or higher if the
 * dashboard is the only thing running.
 */
const RATE = Number(process.env.ALCHEMY_CU_PER_SEC ?? 200);

/**
 * Burst allowance, and it must be a FRACTION of the rate rather than equal to
 * it. A token bucket bounds any window of length T at `burst + rate * T`, so a
 * bucket that starts full with burst == rate permits 2x the rate in the first
 * second — measured at 420 CU/s against a nominal 200 cap before this was
 * split out. At rate/4 the worst case in any 1s window is 1.25x rate.
 */
const BURST = Number(process.env.ALCHEMY_CU_BURST ?? Math.max(25, RATE / 4));

const bucket = new CuBucket(RATE, BURST);

/** Rolling record of spend, for reporting observed CU/s. */
const spend: Array<{ t: number; cu: number }> = [];

export async function throttle(method: string): Promise<void> {
  const cost = cuOf(method);
  await bucket.take(cost);
  const now = Date.now();
  spend.push({ t: now, cu: cost });
  while (spend.length && now - spend[0]!.t > 60_000) spend.shift();
}

export function throughput() {
  const now = Date.now();
  const win = (ms: number) => {
    const from = now - ms;
    const cu = spend.filter((s) => s.t >= from).reduce((a, s) => a + s.cu, 0);
    return +(cu / (ms / 1000)).toFixed(1);
  };
  return {
    cuPerSec1s: win(1000),
    cuPerSec10s: win(10_000),
    cuPerSec60s: win(60_000),
    cuLastMinute: spend.reduce((a, s) => a + s.cu, 0),
    limit: RATE,
    burst: BURST,
    /** Hard ceiling this process can produce in any 1s window. */
    worstCase1s: RATE + BURST,
    bucket: bucket.stats(),
  };
}
