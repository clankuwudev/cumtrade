<div align="center">

<img src="src/web/public/apple-touch-icon.png" alt="clankchan" width="96" height="96" />

# cumTrade

<a href="https://clankuwu.com/trade">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&duration=2800&pause=900&color=A78BFA&center=true&vCenter=true&width=680&lines=A+trading+terminal+for+clank.trade+launches;Every+launch+checked+on+chain%2C+live;Real+candles+from+every+trade+since+launch;One-click+trades+from+a+trading+wallet;Robinhood+Chain" alt="Typing SVG" />
</a>

[![License: MIT](https://img.shields.io/badge/license-MIT-a78bfa?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-a78bfa?style=for-the-badge&logo=nodedotjs&logoColor=white)](#stack)
[![Chain](https://img.shields.io/badge/chain-Robinhood%20Chain-a78bfa?style=for-the-badge)](#stack)
[![Website](https://img.shields.io/badge/website-clankuwu.com-a78bfa?style=for-the-badge&logo=googlechrome&logoColor=white)](https://clankuwu.com/trade)
[![X](https://img.shields.io/badge/follow-%400xzer0ai-a78bfa?style=for-the-badge&logo=x&logoColor=white)](https://x.com/0xzer0ai)

[![viem](https://img.shields.io/badge/chain%20client-viem-a78bfa?style=flat-square)](#stack)
[![Charts](https://img.shields.io/badge/charts-TradingView%20Lightweight%20Charts-a78bfa?style=flat-square)](#stack)
[![CSP](https://img.shields.io/badge/page-strict%20CSP%20%2B%20Trusted%20Types-a78bfa?style=flat-square)](#security)
[![Verifiable](https://img.shields.io/badge/live%20site-verifiable%20byte%20for%20byte-a78bfa?style=flat-square)](#check-the-live-site-against-this-repository)

</div>

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:a78bfa,100:09090b&height=3&section=header" width="100%" />

This repository is the full source of **cumTrade**, the trading terminal at [clankuwu.com/trade](https://clankuwu.com/trade), for tokens launched on [clank.trade](https://clank.trade) on Robinhood Chain (chain ID 4663): the server, the page, the deploy, and the tools that prove the live site was built from this code.

- **A board** of new launches, each checked on chain the moment it appears, with a verdict.
- **A page for every token:** candlestick charts, holders, trades, and the full check.
- **Trading** from your own browser wallet, or from a trading wallet that signs without a pop-up.
- **Positions for any address,** rebuilt from chain events, with live value.

> [!WARNING]
> **Beta.** This is new software, and it has bugs. Keep only trading money in your trading wallet: an amount you are ready to lose. A verdict is what automated checks found on chain; it is not financial advice, and it cannot show that you will be able to sell later.
>
> **Not affiliated with clank.trade.** cumTrade is an independent project. clank.trade has not reviewed or endorsed it.

Website: [clankuwu.com](https://clankuwu.com) · Terminal: [clankuwu.com/trade](https://clankuwu.com/trade) · X: [@0xzer0ai](https://x.com/0xzer0ai)

## Table of contents

- [What the check looks at](#what-the-check-looks-at)
- [The trading wallet](#the-trading-wallet)
- [Check the live site against this repository](#check-the-live-site-against-this-repository)
- [Stack](#stack)
- [Run it locally](#run-it-locally)
- [Repository layout](#repository-layout)
- [Vendored bundles](#vendored-bundles)
- [Design notes](#design-notes)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## What the check looks at

Every launch on the board, and any address pasted into the search, goes through the same check before money goes in.

| Check | What it reads |
| --- | --- |
| **Authenticity** | The token and its curve were made by clank.trade's factory. Catches impersonators. |
| **Bytecode** | The token's code matches the standard launch token's. |
| **Sellability** | A buy and then a sell, simulated on chain against the live curve. |
| **Distribution** | The creator's own buy, other buys in the launch block, and the top ten holders. |
| **Creator record** | What the creator's earlier launches raised, and how many died. |
| **Economics** | Price, market cap, fees, the snipe tax, and progress to graduation. |

A verdict is one of **No issues found**, **Caution**, **High risk** or **Avoid**. "No issues found" means only that these checks found nothing.

Before you sign a trade, the page checks the plan the server sent (which contract it calls, what it approves, and the price) against its own reads of the chain. A server that lies about a trade is caught before anything is signed.

## The trading wallet

You log in with a browser wallet, a Google account or an X account. The page then gets a trading wallet from Coinbase's embedded wallet service. You fund it once from your own wallet; after that, trades are signed with no pop-up.

- **We never hold its key.** Coinbase holds it, tied to your login. At setup you export it once, as a backup.
- **Withdraw all** goes only to the wallet you logged in with, and nowhere else. A Google or X login exports the key instead, with **Back up key**.
- **The server cannot sign.** It has no code that can hold a key, and `npm run typecheck` fails if it ever imports any.
- **The page signs only cumTrade's own trades,** on chain 4663, under fee and gas ceilings, at most 12 a minute.

What that does not protect you from: whoever deploys a site can ship a page that signs anything while you are logged in. That is true of every web wallet, which is why the next section exists, and why only trading money belongs in a trading wallet.

## Check the live site against this repository

Every release is built from one commit, and the page's footer shows which. Anyone can rebuild it and compare it with what [clankuwu.com](https://clankuwu.com) serves, byte for byte:

```bash
git clone https://github.com/clankuwudev/cumtrade && cd cumtrade
npm ci
npm run vendor:wallet
npm run verify:live -- https://clankuwu.com --ref HEAD
```

It checks all three pages and every header they carry (their content security policy included), every script, stylesheet and font under `/v/<sha>/`, the release manifest, and that nothing the API answers can act as a page. It exits 1 and names every difference.

This repository's history starts at one commit of its own, so `--ref HEAD` compares content, not commit IDs.

## Stack

| Item | Value |
| --- | --- |
| Runtime | Node.js 22, TypeScript (run with `tsx`, checked with `tsc`) |
| Chain | Robinhood Chain (chain ID 4663), via [viem](https://viem.sh) |
| Venue | [clank.trade](https://clank.trade): bonding curves that graduate into Uniswap V4 |
| Index | A chain index in SQLite (`node:sqlite`): every launch, holder and trade, followed live |
| Page | Plain ES modules, no framework, no build step; one Trusted Types policy |
| Charts | [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/), vendored |
| Trading wallet | [Coinbase Developer Platform](https://www.coinbase.com/developer-platform) embedded wallets, vendored |
| Serving | Caddy in front of Node: Caddy serves the pages and scripts, Node answers only the API |

## Run it locally

You need Node 22.9 or later.

```bash
npm ci
cp .env.hosted.example .env.hosted
npm start
```

Then open http://localhost:8790.

- `.env.hosted.example` explains each setting. `PUBLIC_ORIGIN` must be the address you open. Leave `RPC_URL` and `WS_URL` blank to use the chain's public node, which is rate-limited.
- The trading wallet needs the SDK bundle ([below](#vendored-bundles)) and a Coinbase Developer Platform project that allows your origin. The page takes the project only from `src/web/public/js/wallet/projects.js`, by exact origin. Without one there is no trading wallet, and the rest of the page still works.

```bash
npm run typecheck    # types, the page's rules, and the server's boundary
npm run test:web     # the page
npm run test:vendor  # both vendored bundles rebuild to the committed hashes
```

Every `test:` script runs without a `.env` file. `test:attribution` runs its live case only when `RPC_URL` is set, and `test:release` builds a release from a commit, so it needs a git checkout.

## Repository layout

```
.
├── README.md
├── LICENSE
├── src/
│   ├── entry/hosted.ts          # the server's entry point
│   ├── core/                    # chain code: the checker, markets, positions, the chain index
│   ├── server/                  # the HTTP server, its routes and API, and their tests
│   └── web/
│       ├── public/
│       │   ├── app.html         # the terminal
│       │   ├── landing/         # clankuwu.com
│       │   ├── ai/              # cumAI's page
│       │   ├── js/              # the page's modules
│       │   ├── vendor/          # the chart bundle, and the wallet bundle's hash
│       │   └── fonts/           # self-hosted, with their licences
│       └── test/                # the page's tests
├── deploy/                      # Caddy, the systemd unit, deploy / activate / uninstall
├── scripts/                     # the release build, verify-live, the checks, the bundle builds
└── docs/
    ├── architecture.md          # the chain and the contracts the checks rely on
    └── deploy.md                # hosting it on a server
```

## Vendored bundles

Both third-party bundles the page loads are built from pinned inputs by a script in this repository, and the same inputs give the same bytes.

- **Charts:** `src/web/public/vendor/charts.js` is TradingView Lightweight Charts 5.2.1 (Apache-2.0), built by `npm run vendor:charts` and committed with its hash and licences. Its built-in logo is turned off, because it writes HTML the page's Trusted Types policy refuses; the page shows TradingView's attribution notice and link under every chart instead.
- **Trading wallet:** Coinbase publishes `@coinbase/cdp-core` with no licence, so its bundle is not included. `npm run vendor:wallet` builds it and rewrites `src/web/public/vendor/wallet.js.sha256`; if `git diff` shows nothing, your bundle is the one the site serves.

```bash
npm run vendor:wallet
git diff --exit-code src/web/public/vendor/wallet.js.sha256
```

Both builds refuse a bundle that runs a string as code, or that is over its size budget.

## Design notes

1. **Node never writes a page.** Caddy serves the pages, their policies and every script from the release on disk. A compromised Node process can lie in its API answers, which the page's verifier catches, but it cannot change the page or serve one of its own.
2. **Releases are immutable.** Each release lives under its own commit (`/v/<sha>/`), so a tab opened on one release keeps loading that release's modules after the next deploy.
3. **The server holds no key.** Signing lives in the browser, at Coinbase. The boundary is enforced by the type check, not by convention.
4. **The page verifies the server.** Every trade plan is re-derived from the page's own chain reads before it is signed.
5. **One chain index, shared.** Launches, holders and trades come from one live chain follower that every page reads, and candles are cut from every trade since launch.
6. **Deploys come from one machine.** No CI job, server pull or build on the server can ship code; a stolen CI secret cannot deploy.

## Security

- The page runs under an enforced content security policy with `script-src 'self'`, no inline scripts, and `require-trusted-types-for 'script'` with a single policy, used only by the page's markup builder, which escapes every value it interpolates.
- Every response carries `nosniff` and `no-referrer`; API answers are `no-store` and sandboxed.
- Hosted requests pass a gate (host, method, fetch site, origin, content type) and per-client rate limits.
- `npm run check:trusted-types` loads every page in headless Chrome and fails on any Trusted Types violation.
- The live site can be compared with this source at any time: see [above](#check-the-live-site-against-this-repository).

If you find a security issue, please report it privately to [@0xzer0ai](https://x.com/0xzer0ai) instead of opening a public issue.

## Contributing

Issues and pull requests are welcome.

## License

- cumTrade: MIT, see [LICENSE](LICENSE)
- Fonts in `src/web/public/fonts/`: SIL Open Font License 1.1, each licence beside its font
- TradingView Lightweight Charts™ (bundled in `vendor/charts.js`): Apache-2.0, © 2025 TradingView, Inc., see `src/web/public/vendor/charts.LICENSES.txt`
- The wallet SDK bundle you build is covered by Coinbase's terms, not by this licence

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:a78bfa,100:09090b&height=100&section=footer" width="100%" />

If this project is useful to you, consider starring the repository.
</div>
