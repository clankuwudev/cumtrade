/**
 * A made-up analysis the checker's rules can judge, for tests that run the
 * check or the board without a chain (`test:check`, `test:board`). Never
 * imported by a server entry.
 */
import type { Address } from "viem";
import type { Analysis } from "../core/checker/analyze.js";
import { VENUE } from "../core/chain.js";

const E = 10n ** 18n;

/** An address from a number, for readable fixtures. */
export const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** An analysis of `token` behind `curve`: a live, unbonded curve with one holder. */
export const fakeAnalysis = (token: Address, curve: Address, over: Record<string, unknown> = {}) => ({
  token, curve, name: "token", symbol: "TKN", decimals: 18, totalSupply: 1_000_000_000n * E, logo: "",
  curveToken: token, curveFactory: VENUE.factories[0]!.address, creator: who(0xc4ea),
  quoteReserve: 2_880_000_000_000_000_000n, tokenReserve: 786_000_000n * E,
  realQuote: 1_200_000_000_000_000_000n, realToken: 700_000_000n * E,
  virtualToken: 0n, phantom: 1_680_000_000_000_000_000n,
  gradThreshold: 4_276_400_000_000_000_000n, graduated: false, readyToGrad: false, state: 0,
  launchedAt: BigInt(Math.floor(Date.now() / 1000) - 3600), feeBps: 100n,
  snipeStart: 0n, snipeSecs: 15n, isNative: true, pairToken: who(0),
  registry: { token, curve }, registered: true, factoryOwner: null,
  sels: [], missing: [], extra: [], sim: { ok: true, roundTripBps: 9800 }, launchBlock: 100n,
  holders: [{ address: who(0xb1), balance: 220_000_000n * E, firstBlock: 500n, firstIn: 220_000_000n * E }],
  creatorLaunches: [],
  deep: true, ...over,
}) as unknown as Analysis;
