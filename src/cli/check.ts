import type { Address } from "viem";
import { analyze } from "../core/checker/analyze.js";
import { derive, evaluate, score, type Finding } from "../core/checker/rules.js";
import { fmtEth, fmtNum, short } from "../core/lib/client.js";
import { robinhood } from "../core/chain.js";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", grey: "\x1b[90m",
};

const SEV: Record<Finding["severity"], string> = {
  critical: `${C.red}${C.bold}CRIT${C.reset}`,
  high: `${C.red}HIGH${C.reset}`,
  medium: `${C.yellow}MED ${C.reset}`,
  low: `${C.cyan}LOW ${C.reset}`,
  info: `${C.grey}INFO${C.reset}`,
};

const BAND: Record<string, string> = {
  AVOID: `${C.red}${C.bold}`,
  "HIGH RISK": `${C.red}`,
  CAUTION: `${C.yellow}`,
  CLEAN: `${C.green}`,
};

// The printed words for a band where they differ from its key. CLEAN means
// the checks found nothing, not that the token is safe (public-release F5.1).
const LABEL: Record<string, string> = {
  CLEAN: "NO ISSUES FOUND",
};

const h = (s: string) => `\n${C.bold}${s}${C.reset}`;
const row = (k: string, v: string) => `  ${C.grey}${k.padEnd(22)}${C.reset}${v}`;

function duration(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || !/^0x[0-9a-fA-F]{40}$/.test(arg)) {
    console.error("usage: npm run check -- <token-or-curve-address>");
    process.exit(1);
  }

  const t0 = Date.now();
  const a = await analyze(arg as Address);
  const d = derive(a);
  const findings = evaluate(a, d);
  const s = score(findings);

  console.log(
    `\n${C.bold}${C.magenta}${a.name}${C.reset} ${C.bold}($${a.symbol})${C.reset}` +
    `${C.grey}  — clank.trade / Robinhood Chain${C.reset}`,
  );
  console.log(row("token", `${a.token}`));
  console.log(row("curve", `${a.curve}`));
  console.log(row("creator", `${a.creator}`));
  console.log(row("explorer", `${C.grey}${robinhood.blockExplorers.default.url}/token/${a.token}${C.reset}`));

  console.log(h("ECONOMICS"));
  console.log(row("spot price", `${fmtNum(d.tokensPerEth)} ${a.symbol} per ETH`));
  console.log(row("FDV", `${d.fdvEth.toFixed(4)} ETH`));
  console.log(row("curve fee", `${(Number(a.feeBps) / 100).toFixed(2)}%`));
  console.log(row("snipe tax", Number(a.snipeStart) === 0
    ? `${C.green}disabled${C.reset} ${C.grey}(0 bps, ${a.snipeSecs}s window)${C.reset}`
    : `${(Number(a.snipeStart) / 100).toFixed(2)}% decaying over ${a.snipeSecs}s`));
  console.log(row("raised", `${fmtEth(a.realQuote)} / ${fmtEth(a.gradThreshold)} ETH`));

  const bars = Math.round(Math.min(1, d.progress) * 28);
  const bar = "█".repeat(bars) + C.grey + "░".repeat(28 - bars) + C.reset;
  console.log(row("graduation", `${bar} ${(d.progress * 100).toFixed(1)}%`));
  console.log(row("circulating", `${fmtNum(d.circulating)} / ${fmtNum(d.supply)}`));
  console.log(row("age", duration(d.ageSec)));
  console.log(row("status", a.graduated ? "graduated"
    : a.readyToGrad ? `${C.yellow}ready to graduate${C.reset}` : "on curve"));

  console.log(h("SELLABILITY"));
  if (a.sim.ok) {
    console.log(row("buy 0.01 ETH", `→ ${fmtNum(Number(a.sim.bought) / 1e18)} ${a.symbol} ${C.grey}(simulated on-chain)${C.reset}`));
    console.log(row("sell it back", `→ ${fmtEth(a.sim.quoteOut, 6)} ETH ${C.grey}(${(a.sim.roundTripBps / 100).toFixed(2)}% round trip)${C.reset}`));
    console.log(row("honeypot", `${C.green}no${C.reset} ${C.grey}— sell path executes${C.reset}`));
  } else if (a.sim.unknown) {
    console.log(row("honeypot", `${C.yellow}NOT CHECKED${C.reset} ${a.sim.error}`));
  } else {
    console.log(row("honeypot", `${C.red}SIMULATION FAILED${C.reset} ${a.sim.error}`));
  }

  console.log(h(`DISTRIBUTION  ${C.grey}(${a.holders.length} holders)${C.reset}`));
  console.log(row("creator", `${d.creatorPct.toFixed(2)}% of supply`));
  console.log(row("top 10", `${d.top10Pct.toFixed(2)}%`));
  console.log(row("launch-block buys", d.bundled.length === 0
    ? `${C.green}none${C.reset}`
    : `${C.yellow}${d.bundled.length} wallet(s), ${d.bundledPct.toFixed(2)}%${C.reset}`));
  console.log(row("snipe-window buys", d.sniped.length === 0
    ? "none" : `${d.sniped.length} wallet(s), ${d.snipedPct.toFixed(2)}%`));

  for (const [i, holder] of a.holders.slice(0, 5).entries()) {
    const tag = holder.address.toLowerCase() === a.creator.toLowerCase() ? ` ${C.magenta}[creator]${C.reset}` : "";
    const b = d.bundled.includes(holder) ? ` ${C.yellow}[bundled]${C.reset}` : "";
    console.log(`  ${C.grey}${String(i + 1).padStart(2)}.${C.reset} ${short(holder.address)}  ` +
      `${d.share(holder.balance).toFixed(2).padStart(6)}%  ${C.grey}${fmtNum(Number(holder.balance) / 1e18)}${C.reset}${tag}${b}`);
  }

  console.log(h("FINDINGS"));
  for (const x of findings) {
    console.log(`  ${SEV[x.severity]}  ${C.bold}${x.title}${C.reset}`);
    console.log(`        ${C.grey}${x.detail}${C.reset}`);
  }

  const col = BAND[s.band] ?? "";
  console.log(`\n${col}██ VERDICT: ${LABEL[s.band] ?? s.band}${C.reset}  ${C.grey}risk score ${s.value}/100 — analysed in ${Date.now() - t0}ms${C.reset}\n`);
}

main().catch((e) => {
  console.error(`${C.red}check failed:${C.reset}`, e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
