// First, before anything that could load a self-mode module: see mode-hosted.ts.
import "./mode-hosted.js";
// Installed before any client import so every request is counted.
import { drainMeterWindow, installMeter, meterLine } from "../core/lib/meter.js";
installMeter();

import { wsClient, wsUrl } from "../core/lib/client.js";
import { VENUE } from "../core/chain.js";
import { ethUsdReady } from "../core/lib/price.js";
import { parsePublicOrigin } from "../server/origin.js";
import { PORT, TRUST_PROXY } from "../server/config.js";
import { backfill, refreshEconomics, refreshEvery, subscribe } from "../server/board.js";
import { hostedApp } from "../server/routes/hosted.js";
import { createLimiter } from "../server/rateLimit.js";
import { drainCsp } from "../server/cspReports.js";
import { drainLookups } from "../server/ledgerPayload.js";
import { openChainIndex } from "../core/lib/chainIndex.js";

// Hosted mode: the board, the checker and the page, with no key anywhere in
// this process's import graph. Nothing under src/self/ may be imported from
// here, directly or through anything this file imports.

// A self-mode variable here means someone copied the operator's config across,
// which is the likeliest way a key reaches a hosted server (H1). Nothing in
// this process would use it, but its presence is the mistake worth stopping.
const selfVars = ["KEYSTORE_PATH", "WALLET_PASSPHRASE", "WALLET_HOT", "PRIVATE_KEY"].filter((k) => process.env[k]);
if (selfVars.length > 0) {
  console.error(`\n  Refusing to start: ${selfVars.join(", ")} ${selfVars.length === 1 ? "is" : "are"} set.`);
  console.error("  Those belong to self mode. A hosted server's environment names no wallet.\n");
  process.exit(1);
}

// The one origin this site answers for. Every Host and every POST's Origin is
// held to it, so there is no default that would quietly accept anything.
let publicOrigin: string;
try {
  publicOrigin = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
} catch (e) {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exit(1);
}

const limiter = createLimiter();
const server = hostedApp({ port: PORT, publicOrigin, limiter });

// A line a minute, and only when there was something: what the limits refused,
// so H1's staging can tune them, the CSP reports F5.2 waits on, and the RPC
// calls by method, source and endpoint (D1.0). Counts by class, bucket,
// directive, method, source and endpoint. Never a client address or a URL.
const line = (counts: Map<string, number>) => [...counts].map(([what, n]) => `${what} ${n}`).join(" · ");
setInterval(() => {
  const refused = limiter.drain();
  if (refused.size > 0) console.log(`[rate-limit] refused in the last minute: ${line(refused)}`);
  // How many position lookups, and nothing about whose (B3.5).
  const lookups = drainLookups();
  if (lookups > 0) console.log(`[ledger] lookups in the last minute: ${lookups}`);
  const reports = drainCsp();
  if (reports.size > 0) console.log(`[csp] report-only violations in the last minute: ${line(reports)}`);
  const rpc = meterLine(drainMeterWindow());
  if (rpc) console.log(rpc);
}, 60_000).unref();

// Loopback until B1.4 gives hosted its configurable bind. The proxy in front
// (H1) is what the public reaches.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nclank hosted  ${publicOrigin}  (listening on http://127.0.0.1:${PORT})`);
  console.log(`  proxy   ${TRUST_PROXY ? "trusted: clients from X-Forwarded-For" : "none: clients from the socket"}`);
  console.log(`  feed    ${wsClient ? `websocket ${new URL(wsUrl!).host}` : "NONE (set WS_URL)"}`);
  console.log(`  venue   ${VENUE.label} · factories ${VENUE.factories.map((f) => f.address).join(", ")}`);
  console.log("  no wallet, sniper or exit manager in this process\n");
  void ethUsdReady().then((p) => {
    if (p) console.log(`  price   ETH $${p.toFixed(2)}\n`);
  });
  // The chain index first (D1.1): the backfill reads its launches from it.
  // On a server INDEX_DB is under /var/lib/clank, the one directory this
  // service may write.
  openChainIndex(process.env.INDEX_DB ?? "data/hosted-index.sqlite")?.start();
  subscribe();
  void backfill();
  setInterval(() => void refreshEconomics(), refreshEvery());
});

// systemd stops the service with SIGTERM. Exiting through process.exit runs
// the index's exit hook, which closes the file (chainIndex.ts).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));
