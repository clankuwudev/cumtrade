// What a share card says (docs/specs/share-cards.md, C2). Pure: the record
// and its candles go in, a card comes out, and drawing it is draw.js's job.

/** clankchan's reactions the cards may use, in the order the chips show them. */
export const REACTIONS = [
  ["e12-laughing", "laughing"], ["e05-smug", "smug"], ["e08-sparkle", "sparkle"], ["e01-manic", "manic"],
  ["e03-crying", "crying"], ["e06-screaming", "screaming"], ["e02-hollow", "hollow"], ["e04-sweating", "sweating"],
  ["e07-deadpan", "deadpan"], ["e11-shock", "shock"], ["e09-rage", "rage"], ["e10-sleepy", "sleepy"],
];

export const FOOTER = "est. values · not financial advice · not affiliated with clank.trade";

const MINUS = "−";

/** ETH with as many places as the size deserves, and a sign when asked. */
export function fmtEth(v, signed = false) {
  const a = Math.abs(v);
  const dp = a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4;
  const s = a.toFixed(dp) + " ETH";
  if (!signed) return (v < 0 ? MINUS : "") + s;
  return (v < 0 ? MINUS : "+") + s;
}

/** Dollars, whole, with a sign when asked; null without a price. */
export function fmtUsd(eth, ethUsd, signed = false) {
  if (!ethUsd) return null;
  const v = eth * ethUsd;
  const s = "$" + Math.round(Math.abs(v)).toLocaleString("en-US");
  return (v < 0 ? MINUS : signed ? "+" : "") + s;
}

/** "47×" for a big move, "2.4×" for a small one. */
export function fmtMultiple(x) {
  return (x >= 10 ? Math.floor(x).toString() : x.toFixed(1)) + "×";
}

export const shortAddress = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

/** @type {Intl.DateTimeFormatOptions} */
const DAYFMT = { month: "short", day: "numeric", timeZone: "UTC" };
export const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-US", DAYFMT);

const COLOR = { grn: "#3fd68c", red: "#ff5f57", amb: "#ffb340", vio: "#c4b5fd", tx2: "#a2a2aa" };

/**
 * The record card: the whole wallet.
 *
 * @param {any} rec   /api/record's reply
 * @param {any} daily /api/record/candles?kind=record's reply
 * @param {number | null} ethUsd
 */
export function recordCard(rec, daily, ethUsd) {
  const t = rec.totals, j = rec.judged;
  const net = t.realised;
  const firsts = rec.positions.map((p) => p.first), lasts = rec.positions.map((p) => p.last);
  const usd = fmtUsd(net, ethUsd, true);
  return {
    kind: "record",
    address: shortAddress(rec.address),
    dates: rec.positions.length ? `${fmtDay(Math.min(...firsts))} – ${fmtDay(Math.max(...lasts))}` : "",
    kicker: `TRACK RECORD · ${t.positions} POSITION${t.positions === 1 ? "" : "S"}`,
    verdict: { label: "NET P&L", color: net >= 0 ? COLOR.grn : COLOR.red },
    big: { value: net, format: "eth-signed", color: net >= 0 ? COLOR.grn : COLOR.red },
    sub: `${fmtEth(t.spent)} in · ${fmtEth(t.back)} out${usd ? ` · ${usd}` : ""}`,
    stats: [
      { label: "PAPERHANDED", value: fmtEth(j.paperhanded, true), color: j.paperhanded > 0 ? COLOR.amb : COLOR.tx2, est: true },
      { label: "FUMBLED AT THE TOP", value: fmtEth(j.fumbled, true), color: j.fumbled > 0 ? COLOR.red : COLOR.tx2, est: true },
      { label: "WORTH NOW IF HELD", value: fmtEth(j.worthIfHeld), color: COLOR.vio, est: true },
    ],
    chart: {
      label: "net ETH from trading, day by day",
      scale: "linear",
      candles: daily.candles,
      marks: [],
      best: null,
      zero: true,
    },
    art: defaultArt({ kind: "record", net, fumbled: j.fumbled }),
    footer: FOOTER,
  };
}

const VERDICTS = {
  paperhand: { label: "PAPERHANDED", color: COLOR.amb },
  fumble: { label: "FUMBLED THE TOP", color: COLOR.red },
  good: { label: "GOOD SELL", color: COLOR.grn },
  holding: { label: "HOLDING", color: COLOR.vio },
  unpriced: { label: "CLOSED", color: COLOR.tx2 },
};

/**
 * A trade card: one position.
 *
 * @param {any} row  one of /api/record's positions
 * @param {any} c    /api/record/candles?token='s reply
 * @param {string} address
 * @param {number | null} ethUsd
 */
export function tradeCard(row, c, address, ethUsd) {
  const v = VERDICTS[row.verdict] ?? VERDICTS.unpriced;
  const venue = row.venue === "clank" ? "CLANK.TRADE" : row.venue === "pons" ? "PONS" : "UNISWAP";
  const back = row.ethBack;
  let big, sub;
  if (row.verdict === "paperhand" && row.soldNow !== null && back > 0) {
    const x = row.soldNow / back;
    big = x >= 2
      ? { text: fmtMultiple(x), color: v.color, count: x, format: "multiple" }
      : { value: row.soldNow - back, format: "eth-signed", color: v.color };
    sub = `sold for ${fmtEth(back)} · worth ${fmtEth(row.soldNow)} now`;
  } else if (row.verdict === "fumble" && row.bestExit) {
    big = { value: row.bestExit.eth - back, format: "eth-signed", color: v.color };
    sub = `sold for ${fmtEth(back)} · the top was ${fmtEth(row.bestExit.eth)}${
      row.bestExit.at ? ` on ${fmtDay(row.bestExit.at)}` : ""}`;
  } else if (row.verdict === "holding") {
    big = { value: row.heldNow ?? 0, format: "eth", color: v.color };
    sub = `${fmtEth(row.ethSpent)} in · still holding`;
  } else {
    big = { value: row.realised, format: "eth-signed", color: row.realised >= 0 ? COLOR.grn : COLOR.red };
    const pct = row.ethSpent > 0 ? (row.realised / row.ethSpent) * 100 : 0;
    sub = `${pct >= 0 ? "+" : MINUS}${Math.abs(pct).toFixed(1)}% · sold for ${fmtEth(back)}${
      row.soldNow !== null ? ` · worth ${fmtEth(row.soldNow)} now` : ""}`;
  }
  const usd = fmtUsd(row.realised, ethUsd, true);
  return {
    kind: "trade",
    address: shortAddress(address),
    dates: row.last - row.first > 86_400_000 ? `${fmtDay(row.first)} – ${fmtDay(row.last)}` : fmtDay(row.first),
    kicker: `${row.symbol} · ${venue}`,
    verdict: v,
    big,
    sub,
    stats: [
      { label: "PUT IN", value: fmtEth(row.ethSpent), color: "#f2f2f4" },
      { label: "GOT OUT", value: fmtEth(back), color: "#f2f2f4" },
      { label: "P&L", value: fmtEth(row.realised, true) + (usd ? ` (${usd})` : ""),
        color: row.realised >= 0 ? COLOR.grn : COLOR.red },
    ],
    chart: {
      label: `${row.symbol} price, ETH per token`,
      scale: "log",
      candles: c.candles,
      marks: c.marks,
      best: row.verdict === "fumble" || row.verdict === "paperhand" ? c.best : null,
      zero: false,
      // What the tokens would fetch, on the markers: the chart is the price,
      // and a thin pool can show a high price that would still pay little.
      nowEth: row.sold > 0 ? row.soldNow : row.heldNow,
    },
    art: defaultArt({ kind: "trade", verdict: row.verdict, realised: row.realised, multiple: row.soldNow !== null && back > 0 ? row.soldNow / back : 0 }),
    footer: FOOTER,
  };
}

// ------------------------------------------------------------- hosted --
// A trade card from the hosted Portfolio (p-sell-verdict.md, P3): an
// /api/ledger position becomes the row tradeCard() takes, so the card is
// drawn exactly as the track record's is.

/** Every clank.trade launch mints this many tokens; the board's FDV is 1e9 / tokens per ETH. */
const LAUNCH_SUPPLY = 1e9;

/**
 * An /api/ledger position as a tradeCard() row. The card is about the sell,
 * so what went in is the cost of what was sold: a whole position once
 * closed, the sold part of one still open. There is no best exit on hosted.
 *
 * @param {any} p a position from /api/ledger, with P1's sellVerdict and soldNowEth
 */
export function ledgerCardRow(p) {
  const w = (v) => Number(v || 0) / 1e18;
  const spent = w(p.realizedCostWei), back = w(p.realizedWei);
  return {
    symbol: p.symbol, token: p.token, venue: "clank",
    verdict: p.sellVerdict || "unpriced",
    ethSpent: spent, ethBack: back, realised: back - spent,
    soldNow: p.soldNowEth ?? null,
    heldNow: p.valued ? p.nowEth ?? null : null,
    sold: Number(p.soldTokens || 0) > 0 ? 1 : 0,
    bestExit: null,
    first: p.openedAt, last: p.closed ? p.closed.at : p.openedAt,
  };
}

/**
 * Up to `n` candles of price per token from /api/history's points ([unix
 * seconds, market cap in ETH, raised]), from `from` to `to` (ms). An empty
 * stretch carries the last close as a flat candle, as the track record's do.
 *
 * @param {[number, number, number][]} points
 * @param {number} from
 * @param {number} to
 * @param {number} [n]
 */
export function historyCandles(points, from, to, n = 48) {
  const span = Math.max(1, (to - from) / n);
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const t0 = from + i * span, t1 = t0 + span;
    const inside = points.filter(([s]) => s * 1000 >= t0 && s * 1000 < t1).map(([, mc]) => mc / LAUNCH_SUPPLY);
    if (inside.length === 0) {
      if (prev !== null) out.push({ t0, t1, o: prev, h: prev, l: prev, c: prev });
      else {
        // Before the first point in the stretch: the last point before it, if any.
        const before = points.filter(([s]) => s * 1000 < t0);
        if (before.length) {
          prev = before[before.length - 1][1] / LAUNCH_SUPPLY;
          out.push({ t0, t1, o: prev, h: prev, l: prev, c: prev });
        }
      }
      continue;
    }
    const open = prev ?? inside[0];
    const c = inside[inside.length - 1];
    out.push({ t0, t1, o: open, h: Math.max(open, ...inside), l: Math.min(open, ...inside), c });
    prev = c;
  }
  return out;
}

/**
 * A hosted card's chart: candles from the site's price history, and the buy
 * and the sell as marks. The history keeps only a token's recent points, so a
 * position it does not reach back to the opening of gets no candles, and the
 * card says there is no price history to draw rather than show a partial one.
 *
 * @param {any} p a position from /api/ledger
 * @param {{ points?: [number, number, number][] } | null} hist /api/history's reply, or null
 * @param {number} [now]
 */
export function ledgerChart(p, hist, now = Date.now()) {
  const n = (v) => Number(v || 0);
  const bought = n(p.tokens) + n(p.soldTokens);
  const cost = n(p.costEth) + n(p.realizedCostWei);
  const marks = [];
  if (bought > 0 && cost > 0) marks.push({ kind: "buy", at: p.openedAt, price: cost / bought });
  if (p.closed && n(p.soldTokens) > 0 && n(p.realizedWei) > 0) {
    marks.push({ kind: "sell", at: p.closed.at, price: n(p.realizedWei) / n(p.soldTokens) });
  }
  const pts = hist && Array.isArray(hist.points) ? hist.points : [];
  const covered = pts.length >= 2 && pts[0][0] * 1000 <= p.openedAt;
  return { candles: covered ? historyCandles(pts, p.openedAt, now) : [], marks, best: null };
}

/** Which reaction a card opens with. */
export function defaultArt(r) {
  if (r.kind === "record") {
    if (r.net >= 0) return "e12-laughing";
    return r.fumbled > Math.abs(r.net) ? "e04-sweating" : "e02-hollow";
  }
  switch (r.verdict) {
    case "paperhand": return r.multiple >= 3 ? "e06-screaming" : "e03-crying";
    case "fumble": return "e02-hollow";
    case "good": return r.realised >= 0 ? "e05-smug" : "e07-deadpan";
    case "holding": return "e08-sparkle";
    default: return "e07-deadpan";
  }
}

/** The headline number's text at a fraction `k` of its count-up. */
export function bigText(big, k = 1) {
  if (big.format === "multiple") return fmtMultiple(Math.max(1, big.count * k));
  const v = big.value * k;
  return big.format === "eth-signed" ? fmtEth(v, true) : fmtEth(v);
}

/** A file-name slug for a card's download. */
export function slug(card) {
  const base = card.kind === "record" ? "track-record" : card.kicker.split(" · ")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `clank-uwu-model-${base}`;
}
