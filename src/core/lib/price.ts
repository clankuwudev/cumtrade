/**
 * ETH/USD spot, for display only.
 *
 * Everything this process *enforces* — trade caps, the sniper budget, the
 * graduation threshold — is denominated in ETH, because that is what the
 * contracts and the limit checks actually use. This price never enters those
 * paths. It exists so a market cap can be read in the unit people think in.
 *
 * Deliberately not on the RPC budget: it is a plain HTTPS call to a public
 * price endpoint, cached, and a failure degrades to showing ETH rather than
 * showing a wrong number.
 */

const URL_ = process.env.ETH_PRICE_URL ?? "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const TTL_MS = Number(process.env.ETH_PRICE_TTL_MS ?? 60_000);

let cached: number | null = null;
let fetchedAt = 0;
let inflight: Promise<number | null> | null = null;
let failures = 0;

async function pull(): Promise<number | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(URL_, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { data?: { amount?: string } };
    const usd = Number(body?.data?.amount);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("no usable amount in response");

    cached = usd;
    fetchedAt = Date.now();
    if (failures) {
      console.log(`[price] ETH/USD recovered: $${usd.toFixed(2)}`);
      failures = 0;
    }
    return usd;
  } catch (e) {
    // Warn once per outage rather than every minute. A stale price is still
    // shown — it is a display figure, and last-known beats blank.
    if (failures === 0) {
      console.warn(`[price] ETH/USD unavailable, showing ${cached ? "last known" : "ETH"}:`,
        (e as Error).message);
    }
    failures++;
    return cached;
  } finally {
    inflight = null;
  }
}

/** Last known price, refreshed in the background once the cache goes stale. */
export function ethUsd(): number | null {
  if (Date.now() - fetchedAt > TTL_MS && !inflight) inflight = pull();
  return cached;
}

/** Resolve a price, waiting for the first fetch if there has never been one. */
export async function ethUsdReady(): Promise<number | null> {
  if (cached === null) return (inflight ??= pull());
  return ethUsd();
}

export const priceState = () => ({
  ethUsd: cached,
  ageSec: cached === null ? null : Math.round((Date.now() - fetchedAt) / 1000),
  stale: cached !== null && Date.now() - fetchedAt > TTL_MS * 3,
});
