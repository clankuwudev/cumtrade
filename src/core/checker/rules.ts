import type { Address } from "viem";
import { BLOCKS_PER_SECOND, FACTORIES, VENUE, factoryAt } from "../chain.js";
import type { Analysis } from "./analyze.js";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Finding = { severity: Severity; title: string; detail: string };

const WEIGHT: Record<Severity, number> = {
  critical: 60, high: 25, medium: 10, low: 4, info: 0,
};

const eq = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

export type Derived = ReturnType<typeof derive>;

/** Economics derived from the constant-product curve (virtual + real reserves). */
export function derive(a: Analysis) {
  const supply = Number(a.totalSupply) / 1e18;
  // Spot price is reserve ratio; this is what the UI shows as "1 ETH = N TOKEN".
  const tokensPerEth = Number(a.tokenReserve) / Number(a.quoteReserve);
  const ethPerToken = 1 / tokensPerEth;
  const fdvEth = supply * ethPerToken;
  const progress = a.gradThreshold > 0n
    ? Number(a.realQuote) / Number(a.gradThreshold)
    : 0;
  const circulating = Number(a.totalSupply - a.realToken) / 1e18;
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(a.launchedAt));

  const held = a.holders.reduce((s, h) => s + h.balance, 0n);
  const creatorBal = a.holders.find((h) => eq(h.address, a.creator))?.balance ?? 0n;
  // Holder shares are of TOTAL supply, as clank.trade and the explorer show
  // them (the user, 2026-09-23). Of circulating, early in a curve every share
  // read several times larger than anywhere else.
  const share = (v: bigint) => (supply > 0 ? (Number(v) / 1e18 / supply) * 100 : 0);
  // The sniper's own rules keep the circulating basis they were tuned on.
  const circShare = (v: bigint) => (circulating > 0 ? (Number(v) / 1e18 / circulating) * 100 : 0);
  const top10 = a.holders.slice(0, 10).reduce((s, h) => s + h.balance, 0n);

  // A buy landing in the launch block itself is bundled with the deploy.
  // The creator's own dev-buy is routine; a THIRD PARTY in the launch block
  // means a coordinated bundle, which is the stronger signal.
  const bundled = a.holders.filter((h) => h.firstBlock === a.launchBlock && h.firstBlock > 0n);
  const creatorBundle = bundled.filter((h) => eq(h.address, a.creator));
  const foreignBundle = bundled.filter((h) => !eq(h.address, a.creator));
  // The snipe-tax window in blocks, at the chain's ~10 a second (D1.0). At
  // the 4 a second this assumed, a 15s window was judged over 6s of blocks.
  const snipeWindowBlocks = BigInt(Number(a.snipeSecs) * BLOCKS_PER_SECOND);
  const sniped = a.holders.filter(
    (h) => h.firstBlock > a.launchBlock && h.firstBlock <= a.launchBlock + snipeWindowBlocks,
  );

  return {
    supply, tokensPerEth, ethPerToken, fdvEth, progress, circulating, ageSec,
    held, creatorBal, creatorPct: share(creatorBal), top10Pct: share(top10),
    bundled, creatorBundle, foreignBundle, sniped,
    bundledPct: share(bundled.reduce((s, h) => s + h.balance, 0n)),
    // What the launch block's wallets bought there, not what they hold now:
    // a creator who has bought more or sold since shows the same figure.
    creatorBundlePct: share(creatorBundle.reduce((s, h) => s + h.firstIn, 0n)),
    foreignBundlePct: share(foreignBundle.reduce((s, h) => s + h.firstIn, 0n)),
    creatorBundleCircPct: circShare(creatorBundle.reduce((s, h) => s + h.firstIn, 0n)),
    foreignBundleCircPct: circShare(foreignBundle.reduce((s, h) => s + h.firstIn, 0n)),
    snipedPct: share(sniped.reduce((s, h) => s + h.balance, 0n)),
    share,
  };
}

export function evaluate(a: Analysis, d: Derived): Finding[] {
  const f: Finding[] = [];
  const push = (severity: Severity, title: string, detail: string) =>
    f.push({ severity, title, detail });

  // --- authenticity: is this actually a launch from the venue we watch? ----
  //
  // The registry is the check that decides. The curve's own answers are claims
  // any contract can make, so they only corroborate.
  if (!eq(a.curveToken, a.token)) {
    push("critical", "Curve/token mismatch",
      `curve.token() = ${a.curveToken}, expected ${a.token}. This pairing is forged.`);
  }
  // The factory is the one the curve names, and only if it is listed. Its
  // registry is then the one that must name the token with this curve, so a
  // curve naming one listed factory cannot borrow another's registry entry.
  const own = factoryAt(a.curveFactory);
  if (!own) {
    push("critical", "Curve points at a foreign factory",
      a.curveFactory
        ? `curve.factory() = ${a.curveFactory}, which is not one of ${VENUE.label}'s factories (${FACTORIES.map((f) => f.address).join(", ")}).`
        : `curve.factory() reverted. A curve a ${VENUE.label} factory deployed names it.`);
  }
  if (!a.registered && eq(a.registry.token, a.token)) {
    push("critical", "Registered with a different curve",
      `The factory launched this token with curve ${a.registry.curve}, not ${a.curve}. Trading through this curve does not trade the real token.`);
  } else if (!a.registered) {
    push("critical", "Not registered with the factory",
      `${own ? `The registry of ${own.label} (${own.address})` : `No ${VENUE.label} factory's registry`} has no entry for ${a.token}. ${VENUE.label} did not launch this token.`);
  }

  // --- bytecode profile ----------------------------------------------------
  if (a.missing.length > 0) {
    push("high", "Missing canonical functions",
      `Token bytecode is missing ${a.missing.length} selector(s) present in a standard launch token: ${a.missing.join(", ")}.`);
  }
  if (a.extra.length > 0) {
    push("critical", "Unexpected functions in token bytecode",
      `Token exposes ${a.extra.length} selector(s) a canonical launch token does not have: ${a.extra.join(", ")}. Treat as a modified/malicious contract until each is identified.`);
  }
  if (a.missing.length === 0 && a.extra.length === 0) {
    push("info", "Token bytecode matches the canonical profile",
      "Exactly the standard 18 selectors. No mint, owner, pause, blacklist or fee-on-transfer hooks exist in the deployed code.");
  }

  // --- sellability ---------------------------------------------------------
  //
  // A graduated curve fails this by construction: liquidity has migrated to
  // Uniswap V4 and the bonding curve is no longer the venue, so a simulated
  // round trip against it reverts exactly as it would against a honeypot.
  // Scoring that as critical reads a completed graduation — the success case
  // this launchpad exists to reach — as the worst possible outcome. The
  // consequence is real but it is "not tradeable here", not "this is a trap",
  // and those are different questions with different answers.
  //
  // Only a sell that reverts after a good buy is critical. A check that could
  // not run (the node, the quote or the buy failing) says nothing about the
  // token either way, and is run again soon (current-issues.md #4).
  if (!a.sim.ok && a.sim.unknown && !a.graduated) {
    push("medium", "Sell check did not run",
      `The buy/sell simulation could not run (${a.sim.error}), so whether this can be sold is not known yet. It runs again on the next check.`);
  } else if (!a.sim.ok && !a.graduated) {
    push("critical", "Sell simulation failed",
      `Could not simulate a buy/sell round trip: ${a.sim.error}`);
  } else if (a.sim.ok && a.sim.roundTripBps < 9000) {
    const loss = (100 - a.sim.roundTripBps / 100).toFixed(2);
    push(a.sim.roundTripBps < 5000 ? "critical" : "medium", "High round-trip cost",
      `Buying then immediately selling 0.01 ETH returns ${(a.sim.roundTripBps / 100).toFixed(2)}% (${loss}% loss). Expect ~2% from the double fee plus curve slippage.`);
  }

  // --- curve configuration -------------------------------------------------
  const feeBps = Number(a.feeBps);
  if (feeBps > 200) {
    push(feeBps > 500 ? "high" : "medium", "Elevated curve fee",
      `feeBps = ${feeBps} (${(feeBps / 100).toFixed(2)}% per trade), vs the 100 bps standard.`);
  }
  const snipe = Number(a.snipeStart);
  if (snipe > 0) {
    push(snipe >= 2000 ? "high" : "medium", "Anti-snipe tax is active",
      `snipeTaxStartBps = ${snipe} (${(snipe / 100).toFixed(2)}%) decaying to 0 over ${a.snipeSecs}s after launch. Early buys are taxed.`);
  }
  // Paired with an ERC-20 rather than native ETH (V4R D3). The factory allows
  // approved pair tokens; cumTrade declines them until the user switches pair
  // tokens on, so the finding says exactly that.
  if (!a.isNative) {
    push("high", "Paired with an ERC-20",
      `Paired with an ERC-20 (${a.pairToken}): cumTrade trades ETH-paired launches only.`);
  }
  // Likewise: a graduated curve reports a non-trading state because it has
  // settled, which is the intended end state rather than a warning sign.
  if (Number(a.state) !== 0 && !a.graduated) {
    push("high", "Curve is not in the normal trading state",
      `state() = ${a.state}. Trading may be paused, migrating or settled.`);
  }
  if (a.graduated) {
    push("info", "Graduated — trading moved to Uniswap V4",
      "Liquidity has migrated to the V4 pool, the bonding curve is settled and its reserves " +
      "are drained, so curve price, progress and the curve sell simulation no longer mean " +
      "anything here. Buying and selling now go through the V4 pool the factory's hook " +
      "created, which is the one pool for this token that nobody else could have minted.");
  } else if (a.readyToGrad) {
    push("medium", "Ready to graduate",
      "Threshold reached — migration to Uniswap V4 can be executed at any moment. Expect a price/liquidity discontinuity.");
  }

  // --- distribution --------------------------------------------------------
  // Thresholds are of total supply. They were of circulating supply (5/20,
  // 15, 25/5, 30, 60/85) and are scaled to match: roughly 2.7x smaller, the
  // ratio on a curve a fifth of the way to graduation.
  if (d.creatorPct >= 2) {
    push(d.creatorPct >= 8 ? "high" : "medium", "Creator holds a large position",
      `Creator holds ${d.creatorPct.toFixed(2)}% of the supply and can sell into the curve at any time.`);
  }
  if (d.foreignBundle.length > 0) {
    push(d.foreignBundlePct >= 6 ? "high" : "medium", "Third-party bundle in the launch block",
      `${d.foreignBundle.length} non-creator wallet(s) acquired ${d.foreignBundlePct.toFixed(2)}% of the supply in the launch block itself — they were bundled with the deploy, which means coordination with the creator.`);
  }
  if (d.creatorBundle.length > 0) {
    const p = d.creatorBundlePct;
    push(p >= 10 ? "high" : p >= 2 ? "medium" : "info", "Creator dev-buy at launch",
      `Creator bought ${p.toFixed(2)}% of the supply in the launch block. A small dev-buy is routine; a large one is exit liquidity.`);
  }
  if (d.sniped.length > 0) {
    push(d.snipedPct >= 12 ? "medium" : "low", "Buys inside the snipe window",
      `${d.sniped.length} wallet(s) took ${d.snipedPct.toFixed(2)}% of the supply within ${a.snipeSecs}s of launch.`);
  }
  // With a tiny holder set "top 10 = 100%" is tautological, not a finding.
  if (d.top10Pct >= 22 && a.holders.length > 10) {
    push(d.top10Pct >= 32 ? "high" : "medium", "Concentrated holder base",
      `Top 10 of ${a.holders.length} wallets hold ${d.top10Pct.toFixed(2)}% of the supply.`);
  }
  if (a.holders.length <= 2) {
    push("low", "Almost no holders yet",
      `${a.holders.length} holder(s) with a non-zero balance. Nothing has traded — price is entirely virtual.`);
  }

  // --- creator track record ------------------------------------------------
  const prior = a.creatorLaunches;
  if (prior.length > 0) {
    const grads = prior.filter((p) => p.graduated).length;
    const dead = prior.filter((p) => !p.graduated && p.raised < 10n ** 17n).length;
    const tally = prior
      .map((p) => `$${p.symbol} ${(Number(p.raised) / 1e18).toFixed(3)} ETH${p.graduated ? " (graduated)" : ""}`)
      .join(", ");
    const sev: Severity =
      grads > 0 ? "info"
      : prior.length >= 3 && dead === prior.length ? "high"
      : prior.length >= 2 ? "medium"
      : "low";
    push(sev, `Serial creator: ${prior.length} prior launch(es)`,
      `${dead} of ${prior.length} stalled under 0.1 ETH raised, ${grads} graduated. Prior: ${tally}.`);
  }

  // --- governance surface --------------------------------------------------
  if (a.factoryOwner) {
    push("info", "Factory is owned",
      `Factory owner ${a.factoryOwner} can change protocol-level parameters (snipe tax defaults, fee destination, launch configs). Whether an existing curve reads these live or snapshotted them at launch is NOT verified — treat curve-level params as potentially mutable.`);
  }
  if (d.ageSec < 300) {
    push("low", "Very new launch",
      `Launched ${d.ageSec}s ago. Distribution data is thin and can change fast.`);
  }

  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return f.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity));
}

export function score(findings: Finding[]) {
  const raw = findings.reduce((s, x) => s + WEIGHT[x.severity], 0);
  const value = Math.min(100, raw);
  const band =
    findings.some((x) => x.severity === "critical") || value >= 60 ? "AVOID"
    : value >= 30 ? "HIGH RISK"
    : value >= 12 ? "CAUTION"
    : "CLEAN";
  return { value, band };
}
