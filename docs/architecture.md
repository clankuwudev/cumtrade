# Architecture — clank.trade on Robinhood Chain

Everything here was derived by on-chain reconnaissance (bytecode dispatch
walking + selector resolution + live `eth_call`). **No contract source is
verified on the explorer**, so names marked INFERRED matched by selector only.

## Chain

| | |
|---|---|
| Name | Robinhood Chain (Arbitrum Orbit L2) |
| Chain ID | `4663` (`0x1237`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` (behind Cloudflare for non-browser clients) |
| Gas token | ETH |

### Infrastructure constraints (these define what a sniper can and cannot do)

| Property | Observed | Consequence |
|---|---|---|
| Public mempool | **None** — `txpool_content` / `txpool_status` return "does not exist" | Classic mempool front-running is impossible. You cannot see a buy before it lands. |
| WebSocket / `eth_subscribe` | Not on the public node; **supported by Alchemy** (`WS_URL`, used for launches) | The board hears launches live; it does not yet hear trades (D1). |
| Block time | **~0.1s**: about 10 blocks a second (39,759 blocks in ~66 min, measured 2026-09-23; several blocks share a 1s timestamp) | A 15s snipe window is ~150 blocks. The venue's history (from block 63,917,462) is about a week of blocks. |
| Gas price | ~0.065 gwei, `maxPriorityFeePerGas` = **0** | Gas bidding buys you nothing. Orbit sequencers order **first-come-first-served by arrival time**. **Latency to the sequencer is the only edge.** |
| `eth_simulateV1` | **Supported** (state persists across calls) | Enables atomic buy→sell honeypot proof. |
| State overrides on `eth_call` | Supported | Enables balance/code overrides. |
| `debug_traceCall` | Not available | No opcode-level tracing. |
| `eth_getLogs` limits | Public node: refuses over 10,000 matched logs, times out wide queries (~2 s of work), rate-limits per IP (~200–300 calls a minute). Alchemy PAYG (the site's app, from 2026-09-23): any range under 10,000 logs, or up to 5,000 blocks with no limit. Alchemy free tier: 10 blocks. Refusals: the public node answers HTTP 200, -32000 "logs matched by query exceeds limit of 10000"; Alchemy answers HTTP 400, -32602 "Log response size exceeded…", and 401 "Must be authenticated!" for a bad key. | History must be read once and followed, not re-scanned on demand (spec D1). Until then, `LOGS_RPC_URL` sends every log request to Alchemy, with the public node behind it on a refusal or an outage; each has its own gate (`logGate.ts`, D1.0). |

## Contracts

### LaunchFactory — `0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1`

Ownable2Step. Deploys the token and its dedicated bonding curve in one tx.

- `launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)` — `0xf35abbcf`
- `launchTokenFor(..., address, address[])` — `0xd6a0eef5`. **CORRECTED:**
  the trailing `address[]` is `snipeTaxExemptions`, not a recipient list —
  addresses exempt from the opening snipe tax, per Pons v2 docs, which this
  factory appears to be a deployment of. It distributes nothing.
- `getLaunch(address)`, `getLaunchedToken(address)`, `tokenForCurve(address)`
- **`getLaunchedToken(token)` is the registry, not a bool.** It returns 15
  words: token, curve, creator (twice), 0, graduation threshold, V4 fee
  (3000), tick spacing (200), 0, 0, status (2 once graduated), 0, 0, 0, 1. For
  an address the factory never launched, it returns 480 zero bytes rather than
  reverting. Read live for all 28 launches on 2026-09-16.
- `graduate(address)`, `createGraduatedPool(address)`
- Governance: `owner()`, `setSnipeTaxStartBps()`, `setSnipeTaxSeconds()`, `setFeeDestination()`, `setLaunchEnabled()`, `addLaunchConfig()`
- Graduation target is **Uniswap V4**: `poolManager()`, `positionManager()`, `memeHook()`, `permit2()`, `locker()`

Launch event topic0 — `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`
with `(token, curve, creator)` indexed and `graduationThreshold` in the data.
**This is the event a sniper watches.**

Live values: `launchFee` = 0, `snipeTaxStartBps` = 0, `snipeTaxSeconds` = 15,
`MAX_CURVE_FEE_BPS` = 1000, owner `0x77cB92c2…4c3D`.

### BondingCurve — one per token (e.g. `0x2e19ba20…00a7`)

Constant-product AMM over **virtual + real** reserves. Holds the entire 1B supply at launch.

```
spot price      = tokenReserve / quoteReserve
tokenReserve    = virtualTokenReserve + realTokenReserve
quoteReserve    = phantomQuote      + realQuoteReserve
tokensOut(dx)   = tokenReserve - (tokenReserve * quoteReserve) / (quoteReserve + dx*(1-fee))
```

- Trading: `buy(uint256,uint256,address)` **payable** `0x59a87bc1`, `sell(uint256,uint256,address)` `0xd04c6983`
- Quotes return a 5-tuple `(amountIn, amountInAfterFee, fee, amountOut, snipeTax)`
- Anti-snipe: `snipeTaxStartBps()` decaying to 0 over `snipeTaxSeconds()`, per-buyer via `currentSnipeTaxBps(address)`, with `snipeTaxExempt(address)`
- Lifecycle: `state()`, `graduated()`, `readyToGraduate()`, `graduationThreshold()`, `launchedAt()`
- Custom error `0x3d5b7999` = `InsufficientRealReserve()` — a sell that exceeds real ETH in the curve

Standard launch parameters (launch config 0): supply 1e27, fee 100 bps,
phantom quote 1.68 ETH, virtual token reserve 86,428,571.43, graduation
threshold ≈ **4.2764 ETH** raised.

### LaunchToken — one per launch

Immutable ERC20 with exactly **18 selectors**:

```
name symbol decimals totalSupply balanceOf allowance approve transfer
transferFrom burn burnFrom curve() factory() creator() description()
logo() + 2 metadata getters
```

**Correction:** the token has no `factory()` or `creator()`. Their selectors
(`0xc45a0155`, `0x02d05d3f`) are not in the bytecode, so calling them reverts
on every live token (all 28, 2026-09-16). The two names in the list above were
guesses for `0x536dac9b` and `0xd5f39488`, which are unidentified. Ask the
curve and the factory's registry instead.

**There is no `mint`, no `owner`, no `pause`, no blacklist and no
fee-on-transfer hook in the deployed bytecode.** Token-level rug vectors do
not exist on this launchpad; all risk is distribution- and curve-level.

Each token has a **unique codehash** (constructor args are baked in as
immutables), so authenticity is verified by **selector set + factory wiring**,
never by codehash comparison.

## Checker design

1. **Authenticity** — the factory's registry entry
   `getLaunchedToken(token)` names this token **with this curve**. That is the
   check that decides. `curve.token() == token` and
   `curve.factory() == canonical` corroborate it, but any contract can make
   those claims. Catches impersonation, the highest-impact failure mode,
   including a fake curve whose `token()` names a real token.
2. **Bytecode profile** — selector set vs the canonical 18. Any *extra*
   selector is critical (modified contract); any *missing* one is high.
3. **Sellability** — atomic `buy → approve → sell` through `eth_simulateV1`.
   A plain `eth_call` cannot prove this: the buy would not persist and the sell
   reverts with `InsufficientRealReserve` on any curve that has not raised yet.
4. **Distribution** — Transfer-log replay → balances. Separates the creator's
   routine dev-buy from a **third-party bundle in the launch block**, which
   implies coordination with the creator.
5. **Economics** — spot price, FDV, graduation progress, fee, snipe-tax state.
