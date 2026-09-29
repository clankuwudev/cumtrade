/**
 * The track record's arithmetic (docs/specs/track-record.md, T1).
 *
 * One row per transaction goes in, one row per token comes out. Pure: the
 * rows are read off the chain elsewhere, so every rule here is tested on
 * made-up data.
 *
 * All amounts are wei or raw token units, as decimal strings in storage and
 * bigint in here. Nothing is priced here: what the tokens are worth is T2's.
 */

/** A token moving in one transaction, seen from the wallet. */
export type Leg = {
  dir: "in" | "out";
  token: string;
  symbol: string;
  raw: string;
  decimals: number;
};

/** One transaction that moved something into or out of the wallet. */
export type TxRow = {
  hash: string;
  block: number;
  /** Block time, ms. */
  at: number;
  /** Sent by the wallet itself; false when someone else's transaction paid it. */
  mine: boolean;
  to: string | null;
  /** ETH the wallet sent as the transaction's value. */
  ethOut: string;
  /** ETH that arrived, measured from the balance either side of the block. */
  ethIn: string;
  /** Paid by the wallet: zero on someone else's transaction. */
  gas: string;
  /** Another of the wallet's transactions is in the same block, so `ethIn` is shared. */
  sharedBlock: boolean;
  legs: Leg[];
};

export type Kind =
  /** Tokens in, ETH out. */
  | "buy"
  /** Tokens out, ETH back. */
  | "sell"
  /** Tokens out, nothing back: a transfer to another wallet. */
  | "sent"
  /** Tokens in and out in one transaction. Not an ETH trade. */
  | "swap"
  /** Someone else's transaction delivered tokens: an airdrop, a transfer in. */
  | "received"
  /** ETH arrived from outside. */
  | "eth-in"
  /** ETH sent, and nothing came back on this chain: a bridge, another wallet. */
  | "eth-out"
  /** Approvals and the like: only gas. */
  | "other";

export function classify(t: TxRow): Kind {
  const into = t.legs.some((l) => l.dir === "in");
  const out = t.legs.some((l) => l.dir === "out");
  if (!t.mine) return into ? "received" : "eth-in";
  if (into && out) return "swap";
  if (into) return "buy";
  if (out) return BigInt(t.ethIn) > 0n ? "sell" : "sent";
  return BigInt(t.ethOut) > 0n ? "eth-out" : "other";
}

export type Fill = { hash: string; block: number; at: number; kind: Kind; raw: string; eth: string };

/** A token the wallet has bought at least once. */
export type Position = {
  token: string;
  symbol: string;
  decimals: number;
  buys: number;
  sells: number;
  /** Raw units. */
  bought: string;
  sold: string;
  /** Delivered by someone else's transaction. */
  received: string;
  /** Sent away for nothing. */
  sent: string;
  /** bought + received - sold - sent, floored at zero. */
  held: string;
  /** Wei. */
  ethSpent: string;
  ethBack: string;
  gas: string;
  /** ethBack - ethSpent - gas: signed wei. */
  realised: string;
  first: number;
  last: number;
  /** Block of the last sell, where a best exit is measured from. */
  lastSellBlock: number | null;
  /** A transaction's ETH was shared out between several tokens. */
  split: boolean;
  /** A fill's ETH was measured across a block the wallet sent other transactions in. */
  sharedBlock: boolean;
  fills: Fill[];
};

/** A token that only ever arrived, never bought. Selling it is a conversion, not a trade. */
export type Received = {
  token: string; symbol: string; decimals: number; held: string; first: number;
  sells: number; sold: string; ethBack: string;
};

/** Everything that is not a position, counted so the page can say what it left out. */
export type Flows = {
  ethOut: { count: number; wei: string };
  ethIn: { count: number; wei: string };
  received: number;
  /** Received tokens that were then sold: ETH in, but no cost to set it against. */
  soldReceived: { count: number; wei: string };
  swaps: number;
  /** Gas on transactions that belong to no position: approvals of tokens never bought, and the like. */
  overheadGas: string;
};

export type TrackRecord = { positions: Position[]; received: Received[]; flows: Flows };

type Acc = Omit<Position, "bought" | "sold" | "received" | "sent" | "held" | "ethSpent" | "ethBack" | "gas" | "realised"> & {
  bought: bigint; sold: bigint; received: bigint; sent: bigint; ethSpent: bigint; ethBack: bigint; gas: bigint;
};

/**
 * Per-token rows from transactions.
 *
 * A transaction with several token legs shares its ETH and gas equally among
 * them, and the rows say so (`split`): exact for one leg, which is every trade
 * a launchpad makes. An approval's gas goes to the token it approved, when
 * that token is a position; otherwise it is overhead.
 */
export function build(txs: TxRow[]): TrackRecord {
  const byToken = new Map<string, Acc>();
  const acc = (l: Leg, at: number): Acc => {
    const k = l.token.toLowerCase();
    let a = byToken.get(k);
    if (!a) {
      a = {
        token: l.token, symbol: l.symbol, decimals: l.decimals, buys: 0, sells: 0,
        bought: 0n, sold: 0n, received: 0n, sent: 0n, ethSpent: 0n, ethBack: 0n, gas: 0n,
        first: at, last: at, lastSellBlock: null, split: false, sharedBlock: false, fills: [],
      };
      byToken.set(k, a);
    }
    a.first = Math.min(a.first, at);
    a.last = Math.max(a.last, at);
    return a;
  };

  const flows = { ethOutN: 0, ethOut: 0n, ethInN: 0, ethIn: 0n, received: 0, swaps: 0, overhead: 0n,
    soldReceivedN: 0, soldReceived: 0n };
  const approvals: TxRow[] = [];
  const sorted = [...txs].sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash));

  for (const t of sorted) {
    const kind = classify(t);
    const n = BigInt(Math.max(1, t.legs.length));
    const gas = BigInt(t.gas) / n;
    switch (kind) {
      case "buy":
      case "sell":
      case "sent":
        for (const l of t.legs) {
          const a = acc(l, t.at);
          const raw = BigInt(l.raw);
          a.gas += gas;
          if (n > 1n) a.split = true;
          if (t.sharedBlock) a.sharedBlock = true;
          let eth = 0n;
          if (kind === "buy") {
            eth = (BigInt(t.ethOut) - BigInt(t.ethIn)) / n;
            a.bought += raw; a.ethSpent += eth; a.buys++;
          } else if (kind === "sell") {
            eth = (BigInt(t.ethIn) - BigInt(t.ethOut)) / n;
            a.sold += raw; a.ethBack += eth; a.sells++;
            a.lastSellBlock = t.block;
          } else {
            a.sent += raw;
          }
          a.fills.push({ hash: t.hash, block: t.block, at: t.at, kind, raw: l.raw, eth: eth.toString() });
        }
        break;
      case "received":
        flows.received++;
        for (const l of t.legs) {
          const a = acc(l, t.at);
          a.received += BigInt(l.raw);
          a.fills.push({ hash: t.hash, block: t.block, at: t.at, kind, raw: l.raw, eth: "0" });
        }
        break;
      case "swap":
        flows.swaps++;
        flows.overhead += BigInt(t.gas);
        break;
      case "eth-in":
        flows.ethInN++;
        flows.ethIn += BigInt(t.ethIn);
        break;
      case "eth-out":
        flows.ethOutN++;
        flows.ethOut += BigInt(t.ethOut);
        flows.overhead += BigInt(t.gas);
        break;
      case "other":
        approvals.push(t);
        break;
    }
  }

  for (const t of approvals) {
    const a = t.to ? byToken.get(t.to.toLowerCase()) : undefined;
    if (a && a.buys > 0) a.gas += BigInt(t.gas);
    else flows.overhead += BigInt(t.gas);
  }

  const positions: Position[] = [];
  const received: Received[] = [];
  for (const a of byToken.values()) {
    const held = a.bought + a.received - a.sold - a.sent;
    if (a.buys === 0) {
      if (a.received > 0n || a.sells > 0) {
        received.push({ token: a.token, symbol: a.symbol, decimals: a.decimals,
          held: (held > 0n ? held : 0n).toString(), first: a.first,
          sells: a.sells, sold: a.sold.toString(), ethBack: a.ethBack.toString() });
        flows.soldReceivedN += a.sells;
        flows.soldReceived += a.ethBack;
        flows.overhead += a.gas;
      }
      continue;
    }
    positions.push({
      ...a,
      bought: a.bought.toString(), sold: a.sold.toString(), received: a.received.toString(),
      sent: a.sent.toString(), held: (held > 0n ? held : 0n).toString(),
      ethSpent: a.ethSpent.toString(), ethBack: a.ethBack.toString(), gas: a.gas.toString(),
      realised: (a.ethBack - a.ethSpent - a.gas).toString(),
    });
  }
  positions.sort((x, y) => x.first - y.first);
  received.sort((x, y) => x.first - y.first);

  return {
    positions, received,
    flows: {
      ethOut: { count: flows.ethOutN, wei: flows.ethOut.toString() },
      ethIn: { count: flows.ethInN, wei: flows.ethIn.toString() },
      received: flows.received,
      soldReceived: { count: flows.soldReceivedN, wei: flows.soldReceived.toString() },
      swaps: flows.swaps, overheadGas: flows.overhead.toString(),
    },
  };
}

/** Mark the rows whose block holds another of the wallet's transactions. */
export function markSharedBlocks(txs: TxRow[]): TxRow[] {
  const mine = new Map<number, number>();
  for (const t of txs) if (t.mine) mine.set(t.block, (mine.get(t.block) ?? 0) + 1);
  return txs.map((t) => ({ ...t, sharedBlock: (mine.get(t.block) ?? 0) > 1 }));
}

/** Sums over the positions. Rows measured across a shared block are left out and counted. */
export function totals(ps: Position[]) {
  let spent = 0n, back = 0n, gas = 0n, left = 0;
  for (const p of ps) {
    if (p.sharedBlock) { left++; continue; }
    spent += BigInt(p.ethSpent); back += BigInt(p.ethBack); gas += BigInt(p.gas);
  }
  return {
    positions: ps.length - left, leftOut: left,
    spent: spent.toString(), back: back.toString(), gas: gas.toString(),
    realised: (back - spent - gas).toString(),
  };
}

/**
 * The record's running total as moments of ETH in and out: what each trade of
 * a position moved, less its gas, and each approval of a position's token as
 * its gas. Exactly what `totals` adds up, spread over time, so the last value
 * is the record's net. What is not a position (bridges, arrivals, received
 * tokens, swaps) is left out, as `totals` leaves it out.
 */
export function tradingFlows(txs: TxRow[]): { at: number; wei: bigint }[] {
  const r = build(txs);
  const counted = new Set(r.positions.filter((p) => !p.sharedBlock).map((p) => p.token.toLowerCase()));
  const out: { at: number; wei: bigint }[] = [];
  for (const t of txs) {
    const kind = classify(t);
    const n = BigInt(Math.max(1, t.legs.length));
    if (kind === "buy" || kind === "sell" || kind === "sent") {
      for (const l of t.legs) {
        if (!counted.has(l.token.toLowerCase())) continue;
        const gas = BigInt(t.gas) / n;
        const eth = kind === "buy" ? -((BigInt(t.ethOut) - BigInt(t.ethIn)) / n)
          : kind === "sell" ? (BigInt(t.ethIn) - BigInt(t.ethOut)) / n : 0n;
        out.push({ at: t.at, wei: eth - gas });
      }
    } else if (kind === "other" && t.to && counted.has(t.to.toLowerCase())) {
      out.push({ at: t.at, wei: -BigInt(t.gas) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
