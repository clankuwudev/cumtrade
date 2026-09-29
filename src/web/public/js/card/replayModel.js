// What a trade replay shows (docs/specs/trade-replay.md, V2). Pure: a Track
// record row and /api/record/replay's reply go in, and out comes everything
// the video draws at each candle. The timeline is here too, so the drawing
// only asks "where are we at t".

import { REACTIONS, defaultArt, fmtDay, fmtEth, shortAddress } from "./model.js";

const MINUS = "−";

/** Dollars, signed when asked: "$2,204" below $10k, "$12.3K" above. */
export function money(usd, signed = false) {
  const a = Math.abs(usd);
  const body = a >= 10_000 ? `$${(a / 1000).toFixed(a >= 100_000 ? 0 : 1)}K` : `$${Math.round(a).toLocaleString("en-US")}`;
  // Nothing to sign: a few cents either way is "$0", never "−$0".
  if (body === "$0") return body;
  return (usd < 0 ? MINUS : signed ? "+" : "") + body;
}

/** A multiple: "54×", "6.5×". */
export const times = (x) => (x >= 10 ? Math.floor(x) + "×" : x.toFixed(1) + "×");

export const SHAPES = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** Seconds. Motion ends at `end` and the last frame holds to `total`. */
export const TIMELINE = {
  intro: [0, 0.6], entry: [0.6, 2.4], move: [2.4, 6.2], exit: [6.2, 7.2], missed: [7.2, 9.4], result: [9.4, 10.5],
  end: 10.5, total: 12.5,
};

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The video's words for the trader: "you" on your own wallet, plain on anyone else's (p-sell-verdict.md P4). */
const WORDS = {
  own: { sold: "YOU SOLD HERE", held: "IF YOU HELD", got: "YOU GOT", since: "SINCE YOU SOLD" },
  other: { sold: "SOLD HERE", held: "IF HELD", got: "GOT", since: "SINCE THE SELL" },
};

/**
 * @param {any} row   a Track record position, or a hosted ledger row (card/model.js ledgerCardRow)
 * @param {any} r     /api/record/replay's reply, or hosted's /api/replay
 * @param {string} address
 * @param {"9:16" | "1:1"} shape
 * @param {boolean} [own] whether the address is the viewer's own
 */
export function replayModel(row, r, address, shape = "9:16", own = true) {
  const usdOn = (ms) => r.usdDay[dayKey(ms)] ?? r.usdNow ?? null;
  const seg = (list, name) => list.map((c) => ({ ...c, seg: name }));
  const candles = [...seg(r.segments.before, "before"), ...seg(r.segments.holding, "holding"), ...seg(r.segments.after, "after")];
  // The three stretches are grouped apart, so each one's first candle opens at
  // its own first trade. Open it where the last one closed instead, so the
  // chart is one line and no gap reads as a move.
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (c.seg !== prev.seg && c.o !== prev.c) {
      candles[i] = { ...c, o: prev.c, h: Math.max(c.h, prev.c), l: Math.min(c.l, prev.c) };
    }
  }
  const holdStart = r.segments.before.length;
  const holdEnd = holdStart + r.segments.holding.length - 1;
  const afterStart = holdEnd + 1;

  /** The candle a moment falls in: the last whose start is not after it. */
  const indexAt = (ms) => {
    let i = 0;
    for (let k = 0; k < candles.length; k++) if (candles[k].t0 <= ms) i = k;
    return i;
  };

  const buys = r.fills.filter((f) => f.kind === "buy");
  const sells = r.fills.filter((f) => f.kind === "sell");
  const sum = (list, k) => list.reduce((a, f) => a + (f[k] ?? 0), 0);
  const hasUsd = r.fills.every((f) => f.usd != null);
  const spentEth = sum(buys, "eth"), backEth = sum(sells, "eth");
  const boughtTokens = sum(buys, "tokens"), soldTokens = sum(sells, "tokens");
  const lastFill = r.fills.length ? r.fills[r.fills.length - 1].at : Date.now();
  const gasUsd = r.gasEth * (usdOn(lastFill) ?? 0);
  const investedUsd = hasUsd ? sum(buys, "usd") : null;
  const backUsd = hasUsd ? sum(sells, "usd") : null;
  const realisedEth = backEth - spentEth - r.gasEth;
  const realisedUsd = hasUsd ? backUsd - investedUsd - gasUsd : null;
  const avgEntry = boughtTokens > 0 ? spentEth / boughtTokens : null;

  // Live P&L at the close of each held candle: what is held at its price, plus
  // what already came back, less what went in.
  const live = candles.map((c, i) => {
    if (i < holdStart || i > holdEnd) return null;
    const upTo = (list) => list.filter((f) => f.at < c.t1);
    const b = upTo(buys), s = upTo(sells);
    const held = sum(b, "tokens") - sum(s, "tokens");
    const eth = held * c.c + sum(s, "eth") - sum(b, "eth");
    const rate = usdOn(c.t1);
    return { eth, usd: rate ? eth * rate : null, multiple: avgEntry ? c.c / avgEntry : null };
  });

  // If held, after the sell: the tokens sold at each close, scaled so today's
  // candle lands on the track record's own estimate (what the table says).
  const lastClose = candles.length ? candles[candles.length - 1].c : 0;
  // A graduated token's candles stop at graduation (hosted has curve trades
  // only), and today's value is on its pool: scaling would lift every candle
  // by the whole move since. The move is drawn as one step instead.
  const graduated = r.graduatedAt != null;
  const k = !graduated && row.soldNow != null && soldTokens > 0 && lastClose > 0 ? row.soldNow / (soldTokens * lastClose) : 1;
  const ifHeld = candles.map((c, i) => {
    if (i < afterStart) return null;
    const eth = soldTokens * c.c * k;
    const rate = i === candles.length - 1 ? r.usdNow : usdOn(c.t1);
    return { eth, usd: rate ? eth * rate : null, multiple: backEth > 0 ? eth / backEth : null };
  });

  const sold = sells.length > 0;
  const missed = sold && r.segments.after.length > 0 && row.soldNow != null;
  const multipleNow = backEth > 0 && row.soldNow != null ? row.soldNow / backEth : null;
  const venue = row.venue === "clank" ? "clank.trade" : row.venue === "pons" ? "Pons" : "Uniswap";

  return {
    shape, ...SHAPES[shape],
    symbol: row.symbol, venue, address: shortAddress(address), verdict: row.verdict,
    dates: row.last - row.first > 86_400_000 ? `${fmtDay(row.first)} – ${fmtDay(row.last)}` : fmtDay(row.first),
    candles, holdStart, holdEnd, afterStart,
    fills: r.fills.map((f) => ({ ...f, index: indexAt(f.at) })),
    entry: {
      usd: investedUsd, eth: spentEth, count: buys.length, index: buys.length ? indexAt(buys[0].at) : holdStart,
      price: buys.length ? buys[0].price : null,
    },
    exit: sold ? {
      usd: backUsd, eth: backEth, count: sells.length, index: indexAt(sells[sells.length - 1].at),
      price: sells[sells.length - 1].price,
    } : null,
    realised: { eth: realisedEth, usd: realisedUsd, pct: investedUsd ? (realisedUsd / investedUsd) * 100 : (realisedEth / spentEth) * 100 },
    live, ifHeld, missed,
    best: r.best && missed ? { ...r.best, index: indexAt(r.best.at) } : null,
    now: missed ? { eth: row.soldNow, usd: r.usdNow ? row.soldNow * r.usdNow : null, multiple: multipleNow } : null,
    holding: !sold,
    heldNow: row.heldNow,
    words: own ? WORDS.own : WORDS.other,
    // Since graduation: the curve's last value of what was sold, and when,
    // and today's price per token on the pool, where the step goes.
    graduation: graduated && missed && candles.length
      ? { at: r.graduatedAt, eth: soldTokens * lastClose, index: candles.length - 1,
        nowPrice: soldTokens > 0 ? row.soldNow / soldTokens : null } : null,
    art: defaultArt({ kind: "trade", verdict: row.verdict, realised: row.realised, multiple: multipleNow ?? 0 }),
    reactions: REACTIONS,
  };
}

/** How the video reads its money: dollars when every fill has a day's price, ETH otherwise. */
export const fmtMoney = (usd, eth, signed = false) => (usd != null ? money(usd, signed) : fmtEth(eth, signed));

/** The verdict line on the result. */
export function verdictLine(m) {
  if (m.holding) return { text: "STILL HOLDING", color: "#c4b5fd" };
  if (m.verdict === "paperhand" && m.now && m.now.multiple) {
    return { text: `PAPERHANDED · ${times(m.now.multiple)} SINCE`, color: "#ffb340" };
  }
  if (m.verdict === "fumble") return { text: "FUMBLED THE TOP", color: "#ff5f57" };
  if (m.verdict === "good") return { text: "GOOD SELL", color: "#3fd68c" };
  return { text: "CLOSED", color: "#a2a2aa" };
}

/**
 * The result's story, when there is one to lead with (p-sell-verdict.md P4c):
 * a paperhand leads with how many times over the tokens sold are worth now,
 * not with the small gain the sell made. Null: lead with the P&L.
 */
export function story(m) {
  if (m.verdict !== "paperhand" || !m.now || !m.now.multiple || m.now.multiple < 1) return null;
  return { multiple: m.now.multiple, since: m.words.since, now: fmtMoney(m.now.usd, m.now.eth) };
}

/** Where the timeline is at `sec`: the phase, and how far through it (0..1). */
export function phaseAt(sec, m) {
  const T = TIMELINE;
  const order = ["intro", "entry", "move", "exit", "missed", "result"];
  for (const name of order) {
    const [a, b] = T[name];
    if (sec < b) return { name, k: Math.max(0, (sec - a) / (b - a)) };
  }
  return { name: "hold", k: 1 };
}
