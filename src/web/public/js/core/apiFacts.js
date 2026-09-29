// The free data API, as its docs page states it (X21). Plain data, no DOM:
// the Data API section (pages/apiDocs.js) renders it, and a server test
// (src/server/apiDocs.test.ts) checks it against the code that enforces it,
// so a changed limit, a new field or a new stream event fails a test until
// the docs say so too.

/** Requests a minute, per client. The shared, all-clients limits are not published (X21 D3). */
export const API_LIMITS = {
  check: { perMin: 6, burst: 3 },
  ledger: { perMin: 10, burst: 3, distinctPerHour: 30 },
  read: { perMin: 300 },
  streams: 6,
  /** An IPv4 address gets this multiple of the `read` and stream allowances: it is often many people. */
  ipv4Factor: 4,
};

/** @typedef {{ name: string, what: string }} Field */

/** The fields of a board row: `/api/launches`, and `/events`' `snapshot` and `row`. */
export const ROW_FIELDS = /** @type {Field[]} */ ([
  { name: "pairToken", what: "The ERC-20 the curve trades against, or null for native ETH. cumTrade trades ETH-paired launches only." },
  { name: "token", what: "The token's address." },
  { name: "curve", what: "Its bonding curve's address." },
  { name: "creator", what: "The address that launched it." },
  { name: "name", what: "Its name, as the token contract says." },
  { name: "symbol", what: "Its symbol." },
  { name: "logo", what: "Its logo's IPFS URI, as the creator set it." },
  { name: "block", what: "The block it launched in." },
  { name: "launchedAt", what: "When it launched, unix seconds." },
  { name: "band", what: "The verdict's key: one of the four bands under Verdicts." },
  { name: "score", what: "The risk score, 0 to 100." },
  { name: "findings", what: "What the checks found (as in /api/check)." },
  { name: "sellable", what: "Whether a simulated sell went through: true or false, or null when the check could not run (it runs again soon)." },
  { name: "devBuyPct", what: "What the creator bought in the launch block, % of supply." },
  { name: "bundlePct", what: "What other wallets bought in the launch block, % of supply." },
  { name: "top10Pct", what: "What the ten largest holders hold, % of supply." },
  { name: "holders", what: "How many addresses hold it." },
  { name: "priorLaunches", what: "How many tokens the creator launched before." },
  { name: "priorDead", what: "How many of those raised less than 0.1 ETH." },
  { name: "raised", what: "ETH paid into the curve." },
  { name: "threshold", what: "The ETH at which the curve graduates." },
  { name: "progress", what: "raised ÷ threshold." },
  { name: "phantomEth", what: "ETH seeded into the curve at launch, never paid in, so no sell can reach it." },
  { name: "feeBps", what: "The curve's fee, basis points." },
  { name: "tokensPerEth", what: "The spot price: tokens for 1 ETH, before fees and impact." },
  { name: "fdvEth", what: "Market cap in ETH at that price." },
  { name: "graduated", what: "Whether it has bonded and trades on Uniswap V4." },
  { name: "readyToGraduate", what: "Whether the curve has filled and waits to graduate." },
  { name: "v4", what: "Once bonded, its pool: { poolId, liquidity, lpFee }. Otherwise null." },
  { name: "updatedAt", what: "When this row last changed, unix milliseconds." },
  { name: "status", what: "\"analysing\", \"ready\" or \"error\". Only a ready row has a verdict." },
  { name: "error", what: "Only when status is \"error\": why the check could not finish." },
]);

/** `/api/check`'s `stats`: the figures from the same analysis as its findings. Null means not known. */
export const STATS_FIELDS = /** @type {Field[]} */ ([
  { name: "curve", what: "The bonding curve." },
  { name: "creator", what: "The address that launched it." },
  { name: "launchedAt", what: "Unix seconds." },
  { name: "launchBlock", what: "The block it launched in." },
  { name: "holders", what: "How many addresses hold it." },
  { name: "devBuyPct", what: "What the creator bought in the launch block, % of supply." },
  { name: "creatorPct", what: "What the creator holds now, % of supply." },
  { name: "bundlePct", what: "What other wallets bought in the launch block, % of supply." },
  { name: "top10Pct", what: "The ten largest holders, % of supply." },
  { name: "priorLaunches", what: "Tokens the creator launched before." },
  { name: "priorDead", what: "Of those, how many raised less than 0.1 ETH." },
  { name: "raised", what: "ETH paid into the curve." },
  { name: "threshold", what: "ETH at which it graduates." },
  { name: "progress", what: "raised ÷ threshold; 1 once graduated." },
  { name: "fdvEth", what: "Market cap in ETH. A bonded token's comes from its V4 pool." },
  { name: "tokensPerEth", what: "Tokens for 1 ETH at spot." },
  { name: "feeBps", what: "The curve's fee, basis points." },
  { name: "sellable", what: "Whether a simulated sell went through: true or false, or null when the check could not run (it runs again soon)." },
  { name: "graduated", what: "Whether it has bonded." },
  { name: "readyToGraduate", what: "Whether the curve has filled." },
  { name: "v4", what: "Its V4 pool once bonded, or null." },
]);

/** The call on each `/api/ledger` position's sells (p-sell-verdict.md, P1). */
export const SELL_FIELDS = /** @type {Field[]} */ ([
  { name: "sellVerdict", what: "On every position, open or closed: \"paperhand\" when the tokens it sold would fetch more today than the sells got, by at least 10% of what they got and 0.0005 ETH; \"good\" when they would not; \"holding\" when it has sold nothing; \"unpriced\" when they cannot be valued now; null when what the sells got is unknown." },
  { name: "soldNowEth", what: "On every position: what the tokens it sold would net today in one sale, in ETH, the way an open position is valued. Null when it has sold nothing, cannot be valued, or its proceeds are unknown. Refreshed once a minute." },
]);

/** `/api/ledger`'s `totals`. */
export const TOTALS_FIELDS = /** @type {Field[]} */ ([
  { name: "realizedEth", what: "ETH received from sells, over every position counted." },
  { name: "realizedPnlEth", what: "What those sells made or lost against the cost of what was sold." },
  { name: "openValueEth", what: "What the open positions would net today, where they could be valued." },
  { name: "openCostEth", what: "What the open positions cost." },
  { name: "excluded", what: "Positions left out of the realised figures because their proceeds are unknown." },
]);

/** Each of `/api/trades`' trades, and the `trade` event's (with its token). */
export const TRADE_FIELDS = /** @type {Field[]} */ ([
  { name: "tx", what: "The transaction." },
  { name: "block", what: "Its block." },
  { name: "logIndex", what: "The trade's place in that block." },
  { name: "at", what: "The block's time, unix milliseconds." },
  { name: "atEstimated", what: "True when the block's time is not read yet and at is worked out from the blocks around it." },
  { name: "side", what: "\"buy\" or \"sell\"." },
  { name: "eth", what: "ETH paid in (a buy) or taken out (a sell), fees included." },
  { name: "tokens", what: "Whole tokens bought or sold." },
  { name: "price", what: "ETH per whole token, before the fee. Null if it cannot be worked out." },
  { name: "trader", what: "Who signed the transaction. A router's trade names its user, not the router." },
  { name: "traderFromEvent", what: "True until the signer is read: trader is then the buy's recipient or the sell's caller, which for a router sell is the router." },
]);

/** Each of `/api/holders`' rows. */
export const HOLDER_FIELDS = /** @type {Field[]} */ ([
  { name: "address", what: "The holder, lowercase." },
  { name: "balance", what: "Whole tokens it holds." },
  { name: "pct", what: "That, % of the supply." },
  { name: "firstAt", what: "When it first held the token, unix milliseconds." },
  { name: "firstIn", what: "Whole tokens it received in that block." },
  { name: "roles", what: "Facts about it on the chain: \"creator\", \"launch-block\" (first held in the launch block), \"pool\" (the Uniswap V4 pool, once graduated) and \"received\" (holds tokens with no curve buy of its own). Often empty." },
  { name: "ethIn", what: "ETH into its curve buys of this token, fees included, as its /api/ledger counts them. Null for the pool." },
  { name: "ethOut", what: "ETH out of its curve sells of this token. Null for the pool." },
  { name: "nowEth", what: "What its balance is worth at the spot price: an estimate, before price impact and fees. Null for the pool, or when there is no price." },
  { name: "pnlEth", what: "ethOut + nowEth − ethIn, before gas. An estimate, as nowEth is." },
]);

/** Each of `/api/leaders`' rows. */
export const LEADER_FIELDS = /** @type {Field[]} */ ([
  { name: "rank", what: "Its place, from 1." },
  { name: "address", what: "The address, lowercase." },
  { name: "realizedPnlEth", what: "What its positions that closed in the window made or lost: ETH out of their sells less what they cost, fees included, gas not. What it is ranked by." },
  { name: "realizedEth", what: "ETH out of those sells." },
  { name: "costEth", what: "What those positions cost, fees included." },
  { name: "gasEth", what: "Gas its own transactions for those positions burned, in ETH. Not taken off realizedPnlEth." },
  { name: "closed", what: "How many positions closed in the window, as counted in realizedPnlEth." },
  { name: "wins", what: "How many of them made money." },
  { name: "winRate", what: "wins ÷ closed, from 0 to 1." },
  { name: "unknownProceeds", what: "Positions that closed in the window with no curve sell to price them, such as a sale on Uniswap after graduation or a transfer. Left out of every figure above." },
  { name: "paperhandRate", what: "Of its closed positions that can be priced now, the share whose tokens would fetch more than 10% more now (and at least 0.0005 ETH more) than its sells got: /api/ledger's sellVerdict \"paperhand\". From 0 to 1; null when none can be priced." },
  { name: "paperhandOf", what: "How many positions paperhandRate is of." },
  { name: "lastClosedAt", what: "When its last position in the window closed, unix milliseconds." },
]);

/** `/api/leaders?address=`: the answer, and each of its windows. */
export const STANDING_FIELDS = /** @type {Field[]} */ ([
  { name: "address", what: "The address asked about, lowercase." },
  { name: "asOfBlock", what: "Everything up to this block, as a string." },
  { name: "builtAt", what: "When the ranking was worked out, unix milliseconds." },
  { name: "windows", what: "Its standing in each window, below: 7d, 30d, then all." },
]);
export const STANDING_WINDOW_FIELDS = /** @type {Field[]} */ ([
  { name: "window", what: "\"7d\", \"30d\" or \"all\"." },
  { name: "rank", what: "Its rank in that window, or null when it is not ranked." },
  { name: "closed", what: "Its closed positions in the window, as rows count them; null when it is not ranked at all." },
  { name: "minClosed", what: "The closed positions a rank needs: 5." },
]);

/** Each of `/api/candles`' candles. */
export const CANDLE_FIELDS = /** @type {Field[]} */ ([
  { name: "t0", what: "Where it starts, unix milliseconds." },
  { name: "t1", what: "Where the next one starts." },
  { name: "o", what: "Open: where the one before closed. ETH per whole token, as are the rest." },
  { name: "h", what: "High." },
  { name: "l", what: "Low." },
  { name: "c", what: "Close: the last trade's price in it. A stretch with no trade repeats the last close." },
]);

/** What `/api/candles?tf=` adds at the top level. */
export const FRAME_TOP_FIELDS = /** @type {Field[]} */ ([
  { name: "tf", what: "The candle size asked for: 1s, 15s, 1m or 5m." },
  { name: "cap", what: "At most this many candles, the newest: 500." },
]);

/** Each of `/api/candles?tf=`'s candles. */
export const FRAME_CANDLE_FIELDS = /** @type {Field[]} */ ([
  { name: "t", what: "Where it starts, unix milliseconds: a multiple of its size." },
  { name: "o", what: "Open: where the one before closed. ETH per whole token, as are h, l and c." },
  { name: "h", what: "High." },
  { name: "l", what: "Low." },
  { name: "c", what: "Close: the last trade's price in it." },
  { name: "v", what: "Volume: the ETH traded in it, fees included." },
]);

/**
 * @typedef {{
 *   path: string, method: string, title: string, params: Field[], summary: string[],
 *   fields: Field[], nested?: { name: string, fields: Field[] }[],
 *   errors: { status: string, when: string }[], example: string, answer: string,
 * }} Endpoint
 */

/** @type {Endpoint[]} */
export const ENDPOINTS = [
  {
    path: "/api/check", method: "GET", title: "Check a token",
    params: [{ name: "addr", what: "A token's address, or its bonding curve's. The answer always names the token." }],
    summary: [
      "The same deep check the token page runs: the verdict, what it found, and the figures it found them in.",
      "An answer is kept for 60 seconds, so asking again within the minute returns the same one: checkedAt says when it was made.",
      "A check never puts a token on the board. onBoard says whether it is there already.",
    ],
    fields: [
      { name: "token", what: "The token's address." },
      { name: "symbol", what: "Its symbol." },
      { name: "name", what: "Its name." },
      { name: "band", what: "The verdict's key: one of the four bands under Verdicts." },
      { name: "score", what: "0 to 100. Any critical finding, or 60 and over, is AVOID." },
      { name: "findings", what: "A list of { severity, title, detail }. Severity is critical, high, medium, low or info." },
      { name: "stats", what: "The figures, below." },
      { name: "onBoard", what: "Whether the token is on the board." },
      { name: "checkedAt", what: "When this answer was made, unix milliseconds." },
    ],
    nested: [{ name: "stats", fields: STATS_FIELDS }],
    errors: [
      { status: "400", when: "addr is not an address." },
      { status: "500", when: "The address is not a clank.trade token or curve, or the chain could not be read." },
      { status: "503", when: "A chain node is refusing requests. Wait the retry-after seconds." },
    ],
    example: "curl '{base}/api/check?addr=0xcf5b720f33febDC1c9D4880b8317203b63fDF368'",
    answer: `{
  "token": "0xcf5b720f33febDC1c9D4880b8317203b63fDF368",
  "symbol": "CABO", "name": "Cabo",
  "band": "HIGH RISK", "score": 35,
  "findings": [
    { "severity": "high", "title": "Concentrated holder base",
      "detail": "Top 10 of 431 wallets hold 35.51% of the supply." }, …
  ],
  "stats": { "curve": "0xA9bF…245b", "holders": 431, "devBuyPct": 0.064, "raised": 0,
             "fdvEth": 67.37, "tokensPerEth": 14843414.4, "feeBps": 100, "graduated": true, … },
  "onBoard": true,
  "checkedAt": 1790669180000
}`,
  },
  {
    path: "/api/ledger", method: "GET", title: "An address's positions",
    params: [{ name: "address", what: "Any address." }],
    summary: [
      "Every clank.trade position the address has held, rebuilt from the chain's own events: what it paid, what it sold for, and what it holds now.",
      "No address you look up is written to any log.",
      "A client can look up 30 different addresses an hour. Looking the same ones up again does not count.",
    ],
    fields: [
      { name: "address", what: "The address asked about." },
      { name: "asOfBlock", what: "Everything up to this block, as a string." },
      { name: "builtAt", what: "When this answer was made, unix milliseconds." },
      { name: "partial", what: "True when some tokens were left out to keep the lookup bounded." },
      { name: "omittedTokens", what: "Those tokens, each { token, symbol, txs }." },
      { name: "open", what: "Positions still held. Each has the token, cost, tokens held, fees and gas as integer strings in wei, how sure the rebuild is (confidence), and, where it could be valued, nowEth, pnlPct and the rest of its value today." },
      { name: "closed", what: "Positions sold out, the same, with closed: { at, reason, proceedsEth, tokensSold, tx }." },
      { name: "totals", what: "The sums, below." },
    ],
    nested: [{ name: "totals", fields: TOTALS_FIELDS }, { name: "open[] and closed[], each", fields: SELL_FIELDS }],
    errors: [
      { status: "400", when: "address is not an address." },
      { status: "502", when: "The chain could not be read. Try again shortly." },
      { status: "503", when: "The chain's history node is refusing requests. Wait the retry-after seconds; what was read is kept." },
    ],
    example: "curl '{base}/api/ledger?address=YOUR_ADDRESS'",
    answer: `{
  "address": "YOUR_ADDRESS",
  "asOfBlock": "70373657", "builtAt": 1790152427543,
  "partial": false, "omittedTokens": [],
  "open": [ { "token": "0xcf5b…F368", "symbol": "CABO", "costEth": "50000000000000000",
              "tokens": "30000000000000000000000000", "confidence": "exact",
              "nowEth": 0.072, "pnlPct": 44, "sellVerdict": "holding", "soldNowEth": null, … } ],
  "closed": [ { "token": "0xFa31…06ec", "symbol": "AGI", "realizedWei": "9000000000000000",
                "closed": { "at": 1789500000000, "reason": "sold (reconstructed from chain history)", … },
                "sellVerdict": "good", "soldNowEth": 0.004, … } ],
  "totals": { "realizedEth": 0.1, "realizedPnlEth": 0.009, "openValueEth": 0.072,
              "openCostEth": 0.05, "excluded": 0 }
}`,
  },
  {
    path: "/api/history", method: "GET", title: "A token's price history",
    params: [{ name: "token", what: "A token's address." }],
    summary: [
      "The market cap over time, sampled: a point each time the token trades, and every two minutes. It starts when this site began watching the token, not at launch, and it is not every trade.",
      "A token not on the board has no history here: points is empty.",
    ],
    fields: [
      { name: "points", what: "A list of [unixSeconds, marketCapEth, raisedEth], oldest first." },
      { name: "since", what: "The first point's time, or null." },
      { name: "sampledOn", what: "\"trades\" (a point at each trade) or \"timer\"." },
      { name: "sampledMs", what: "How often the timed sample runs, milliseconds." },
      { name: "ethUsd", what: "The ETH price in dollars the site is using now." },
    ],
    errors: [{ status: "400", when: "token is not an address." }],
    example: "curl '{base}/api/history?token=0xcf5b720f33febDC1c9D4880b8317203b63fDF368'",
    answer: `{
  "points": [ [1790506319, 54.826, 0], [1790507519, 55.978, 0], … ],
  "since": 1790506319, "sampledOn": "trades", "sampledMs": 120000, "ethUsd": 2738.31
}`,
  },
  {
    path: "/api/trades", method: "GET", title: "A token's trades",
    params: [
      { name: "token", what: "A token's address." },
      { name: "limit", what: "How many, 50 unless given, at most 100." },
      { name: "before", what: "Optional: next from the page before, block:logIndex. Only trades before it." },
    ],
    summary: [
      "Every trade on the token's bonding curve, newest first, from the chain's own events.",
      "A token that has graduated trades on Uniswap after that, and those trades are not here yet: the list ends at graduation.",
      "The same trades arrive live as /events' trade event.",
    ],
    fields: [
      { name: "token", what: "The token's address, lowercase." },
      { name: "asOfBlock", what: "Everything up to this block, as a string." },
      { name: "graduatedAt", what: "When it graduated, unix milliseconds, or null." },
      { name: "trades", what: "The trades, below, newest first." },
      { name: "next", what: "The before to ask for the page after this one, or null at the first trade." },
    ],
    nested: [{ name: "trades[], each", fields: TRADE_FIELDS }],
    errors: [
      { status: "400", when: "token is not an address, or before is not block:logIndex." },
      { status: "404", when: "The index has not read this token up to now yet (indexed: false). Try again in a minute." },
    ],
    example: "curl '{base}/api/trades?token=0xcf5b720f33febDC1c9D4880b8317203b63fDF368&limit=2'",
    answer: `{
  "token": "0xcf5b720f33febdc1c9d4880b8317203b63fdf368",
  "asOfBlock": "75661576", "graduatedAt": 1789512482370,
  "trades": [
    { "tx": "0xec5b…c921", "block": 64019380, "logIndex": 21, "at": 1789512473000, "atEstimated": false,
      "side": "buy", "eth": 0.03804, "tokens": 1949827.4, "price": 1.9315e-8,
      "trader": "0x6240…e895", "traderFromEvent": false },
    { "tx": "0xf0b3…17ce", "block": 64018929, "logIndex": 52, "at": 1789512430000, "atEstimated": false,
      "side": "sell", "eth": 0.004821, "tokens": 253524.02, "price": 1.9209e-8,
      "trader": "0x170c…6858", "traderFromEvent": false }
  ],
  "next": "64018929:52"
}`,
  },
  {
    path: "/api/candles", method: "GET", title: "A token's price chart",
    params: [
      { name: "token", what: "A token's address." },
      { name: "n", what: "How many candles, 120 unless given, from 24 to 240." },
      { name: "tf", what: "Optional: 1s, 15s, 1m or 5m. Candles of that size instead, with volume; n is then ignored." },
    ],
    summary: [
      "The token's price from every curve trade, as candles of equal length from its launch to now, or to graduation for a token that has graduated.",
      "With tf: candles on fixed boundaries of that size, the newest 500. A stretch with no trade has no candle.",
      "Market cap is a price times supply: every launch mints a billion tokens.",
    ],
    fields: [
      { name: "token", what: "The token's address, lowercase." },
      { name: "asOfBlock", what: "Everything up to this block, as a string." },
      { name: "supply", what: "1000000000, the whole tokens every launch mints." },
      { name: "from", what: "The launch, unix milliseconds." },
      { name: "to", what: "Where the last candle ends: now, or graduation." },
      { name: "graduatedAt", what: "When it graduated, unix milliseconds, or null." },
      { name: "candles", what: "The candles, below, oldest first. Empty before the first trade." },
    ],
    nested: [
      { name: "candles[], each", fields: CANDLE_FIELDS },
      { name: "with tf, also at the top level", fields: FRAME_TOP_FIELDS },
      { name: "with tf, candles[], each", fields: FRAME_CANDLE_FIELDS },
    ],
    errors: [
      { status: "400", when: "token is not an address, n is not a number, or tf is not 1s, 15s, 1m or 5m." },
      { status: "404", when: "The index has not read this token up to now yet (indexed: false). Try again in a minute." },
    ],
    example: "curl '{base}/api/candles?token=0xcf5b720f33febDC1c9D4880b8317203b63fDF368&n=24'",
    answer: `{
  "token": "0xcf5b720f33febdc1c9d4880b8317203b63fdf368",
  "asOfBlock": "75661576", "supply": 1000000000,
  "from": 1789506057000, "to": 1789512482370, "graduatedAt": 1789512482370,
  "candles": [
    { "t0": 1789506057000, "t1": 1789506324723, "o": 1.547e-9, "h": 1.552e-9, "l": 1.547e-9, "c": 1.552e-9 }, …
  ]
}`,
  },
  {
    path: "/api/holders", method: "GET", title: "A token's holders",
    params: [
      { name: "token", what: "A token's address." },
      { name: "limit", what: "How many, largest first, 50 unless given, at most 100." },
    ],
    summary: [
      "Who holds the token, from the chain's own Transfers, less its bonding curve: what each holder is, and how each has done on it.",
      "Each holder's buys and sells are the ones /api/ledger books for that address. Values are at the spot price, so every one is an estimate, and P&L is before gas.",
      "A token that has graduated counts curve trades only: sells on Uniswap are not here yet, so they still count as held.",
    ],
    fields: [
      { name: "token", what: "The token's address, lowercase." },
      { name: "asOfBlock", what: "Everything up to this block, as a string." },
      { name: "supply", what: "Whole tokens in existence: minted less burned." },
      { name: "holders", what: "How many addresses hold it, not only the ones listed." },
      { name: "top10Pct", what: "What the ten largest hold, % of the supply, as /api/check has it." },
      { name: "graduatedAt", what: "When it graduated, unix milliseconds, or null." },
      { name: "pnl", what: "\"before gas\": what pnlEth leaves out." },
      { name: "rows", what: "The holders, below, largest first." },
    ],
    nested: [{ name: "rows[], each", fields: HOLDER_FIELDS }],
    errors: [
      { status: "400", when: "token is not an address, or limit is not a number." },
      { status: "404", when: "The index has not read this token up to now yet (indexed: false). Try again in a minute." },
    ],
    example: "curl '{base}/api/holders?token=0xcf5b720f33febDC1c9D4880b8317203b63fDF368&limit=2'",
    answer: `{
  "token": "0xcf5b720f33febdc1c9d4880b8317203b63fdf368",
  "asOfBlock": "75661596", "supply": 1000000000, "holders": 431, "top10Pct": 35.51,
  "graduatedAt": 1789512482370, "pnl": "before gas",
  "rows": [
    { "address": "0x8366…0951", "balance": 126948642.9, "pct": 12.69, "firstAt": 1789511769592,
      "firstIn": 5000000, "roles": ["pool"], "ethIn": null, "ethOut": null,
      "nowEth": null, "pnlEth": null },
    { "address": "0xd90a…dc3c", "balance": 35233312.3, "pct": 3.52, "firstAt": 1790114926107,
      "firstIn": 962379.46, "roles": ["received"], "ethIn": 0, "ethOut": 0,
      "nowEth": 2.3737, "pnlEth": 2.3737 }
  ]
}`,
  },
  {
    path: "/api/leaders", method: "GET", title: "The traders who made the most",
    params: [
      { name: "window", what: "\"7d\" unless given, \"30d\" or \"all\": positions that closed in the last 7 days, the last 30, or ever." },
      { name: "limit", what: "How many, best first, 50 unless given, at most 100." },
      { name: "address", what: "Optional: instead of the list, this address's standing in each window, as below." },
    ],
    summary: [
      "The addresses that have made the most on this venue's bonding curves, ranked by what their closed positions realised: after fees, before gas. An open position counts once it closes.",
      "A position counts in the window it closed in, its whole round trip there. An address needs 5 closed positions in the window to be ranked.",
      "Each address's figures are the ones /api/ledger gives for the same positions. Positions whose proceeds are unknown are left out and counted.",
      "It is worked out again at most once a minute. Some addresses are not ranked, and the answer does not say which.",
      "Past P&L on these curves only: what the chain shows for each address alone. Not advice.",
    ],
    fields: [
      { name: "window", what: "The window asked for." },
      { name: "asOfBlock", what: "Everything up to this block, as a string." },
      { name: "builtAt", what: "When the ranking was worked out, unix milliseconds." },
      { name: "traders", what: "Addresses with a position opened or closed in the window." },
      { name: "eligible", what: "How many of them are ranked: at least minClosed closed positions in the window." },
      { name: "minClosed", what: "The closed positions a rank needs: 5." },
      { name: "pnl", what: "\"after fees, before gas\": what realizedPnlEth counts." },
      { name: "rows", what: "The ranked addresses, below, best first." },
    ],
    nested: [
      { name: "rows[], each", fields: LEADER_FIELDS },
      { name: "With address: the answer", fields: STANDING_FIELDS },
      { name: "windows[], each", fields: STANDING_WINDOW_FIELDS },
    ],
    errors: [
      { status: "400", when: "window is not 7d, 30d or all, limit is not a number, or address is not an address." },
      { status: "404", when: "The index has not read the chain's trades yet (indexed: false). Try again in a minute." },
    ],
    example: "curl '{base}/api/leaders?window=all&limit=1'",
    answer: `{
  "window": "all", "asOfBlock": "70639931", "builtAt": 1790211130000,
  "traders": 518, "eligible": 42, "minClosed": 5, "pnl": "after fees, before gas",
  "rows": [
    { "rank": 1, "address": "0x3f9e…c41d", "realizedPnlEth": 0.682, "realizedEth": 2.914, "costEth": 2.232,
      "gasEth": 0.00052, "closed": 25, "wins": 14, "winRate": 0.56, "unknownProceeds": 3,
      "paperhandRate": 0.2, "paperhandOf": 25, "lastClosedAt": 1790190000000 }
  ]
}`,
  },
  {
    path: "/api/launches", method: "GET", title: "The board",
    params: [],
    summary: [
      "Every token on the board, each as one row: the newest 200 launches. Past 200, the oldest one that has not bonded drops off first.",
      "The same rows /events sends, all at once.",
    ],
    fields: ROW_FIELDS,
    errors: [],
    example: "curl '{base}/api/launches'",
    answer: `[
  { "token": "0xcf5b720f33febDC1c9D4880b8317203b63fDF368", "symbol": "CABO", "block": 63956162,
    "band": "HIGH RISK", "score": 35, "raised": 0, "progress": 0,
    "fdvEth": 67.37, "graduated": true, "v4": { "poolId": "0x7c30…a699", "lpFee": 3000, … }, "status": "ready", … },
  …
]`,
  },
  {
    path: "/events", method: "GET", title: "The board, live",
    params: [],
    summary: [
      "Server-Sent Events. Open it once and keep it open: every change to the board arrives as it happens.",
      "A comment line (: ping) every 20 seconds keeps the connection alive. A client can have 6 streams open.",
    ],
    fields: [],
    errors: [],
    example: "curl -N '{base}/events'",
    answer: `event: snapshot
data: [ { "token": "0xcf5b…F368", "symbol": "CABO", … }, … ]

event: launch
data: {"token":"0x3b0c…91f2","block":70374001}

event: row
data: { "token": "0x3b0c…91f2", "status": "analysing", … }

event: evict
data: {"token":"0x5B3D…Bb27"}

event: trade
data: { "token": "0xcf5b…f368", "side": "buy", "eth": 0.03804, "trader": "0x6240…e895", … }`,
  },
];

/** What `/events` sends, in the order a connection sees them first. */
export const EVENTS = /** @type {Field[]} */ ([
  { name: "snapshot", what: "Once, on connecting: the whole board, a list of rows." },
  { name: "row", what: "A row added or changed. Replace what you had for that token." },
  { name: "launch", what: "A new launch seen: { token, block }. Its row follows once it is checked." },
  { name: "ready", what: "The board finished loading after a restart: { count }." },
  { name: "evict", what: "A token left the board: { token }. Nothing happened to the token; the board only keeps the newest 200." },
  { name: "trade", what: "A curve trade in any token, once, a few seconds after it is final: { token } and a trade as in /api/trades. At most 200 at a time." },
]);

/** Dated changes to what this page describes, newest first. */
export const CHANGES = [
  { date: "2026-09-29", what: "/api/candles takes tf: fixed 1s, 15s, 1m or 5m candles with volume." },
  { date: "2026-09-24", what: "Added /api/leaders." },
  { date: "2026-09-23", what: "Added /api/holders." },
  { date: "2026-09-23", what: "sellable is null, not false, when the sell check could not run." },
  { date: "2026-09-23", what: "Added /api/trades, /api/candles and the trade event." },
  { date: "2026-09-23", what: "First published." },
];
