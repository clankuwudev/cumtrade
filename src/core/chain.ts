import { defineChain } from "viem";

/** Robinhood Chain — Arbitrum Orbit L2, native gas token ETH. */
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  // Canonical Multicall3, verified deployed on this chain. Declaring it lets
  // viem fold concurrent reads into a single aggregate3 eth_call — a provider
  // bills one request for that, versus one per read in a JSON-RPC batch.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * About how many blocks the chain makes a second: 39,759 in ~66 minutes,
 * measured 2026-09-23 (docs/architecture.md). Several blocks share a
 * one-second timestamp, so this is a rate, not a block time to divide by.
 */
export const BLOCKS_PER_SECOND = 10;

/** One LaunchFactory: it deploys a token and that token's bonding curve. */
export type Factory = {
  /** The factory contract. */
  address: string;
  /** Floors every log scan of this factory, so a node is never asked to walk
   *  history from before it existed. */
  genesisBlock: bigint;
  /** Which factory, in a log line or a finding. */
  label: string;
};

/**
 * A launchpad this bot can watch (docs/specs/pons-venue.md).
 *
 * clank.trade and Pons are two deployments of the same protocol on this chain,
 * one version apart. Everything that differs between them lives in one record
 * (V-D2), so a process cannot end up half-switched: reading the factory and
 * reading the genesis block are the same lookup.
 */
export type Venue = {
  /** The value `VENUE` takes. */
  key: "clank" | "pons";
  /** How the venue is named on screen and in a finding. */
  label: string;
  /**
   * Every LaunchFactory this venue has launched from (public-release B1.5).
   * A venue can move to a new factory at any time, as clank.trade did on
   * 2026-09-22, and its old launches keep trading. A token belongs to the
   * venue when its curve names one of these AND that factory's registry lists
   * the token with that curve. There is no single `factory` to fall back on:
   * every use has to say which one it means.
   */
  factories: readonly Factory[];
  /** topic0 of the factory's launch event: (token, curve, creator) indexed.
   *  The same on every factory: it is the same event. */
  launchTopic: string;
  /** What this venue's curve exposes (V2). Pons runs a later version of the
   *  same contract with three fewer views; each one has an exact stand-in, so
   *  this says which path to take rather than what to guess. */
  curve: {
    /** `state()` exists. Without it, graduation is the whole lifecycle. */
    state: boolean;
    /** `realTokenReserve()` exists. Without it, it is the curve's own token
     *  balance — verified equal on 10 of 10 clank curves. */
    realTokenReserve: boolean;
    /** `quoteBuy`/`quoteSell` exist, or a quote is simulated (V-D3). */
    quotes: "onchain" | "simulated";
  };
};

export const VENUES: Record<Venue["key"], Venue> = {
  clank: {
    key: "clank",
    label: "clank.trade",
    factories: [
      {
        address: "0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1",
        /** Found by bisecting eth_getCode. Its last launch was at 69,856,919,
         *  and it switched launching off at 69,870,401. Its tokens still trade. */
        genesisBlock: 63917462n,
        label: "clank.trade's first factory",
      },
      {
        address: "0x798daaa0707c1e538bb5acf0867ac0e1a84cccf2",
        /** Its first event, OwnershipTransferred from zero, which the
         *  constructor emits; it has no log in the million blocks before.
         *  Same owner and curve code as the first, but its own immutables:
         *  memeHook, locker, graduation executor and fee escrow all differ.
         *  Launches from 69,863,864. Verified on chain 2026-09-23. */
        genesisBlock: 69067760n,
        label: "clank.trade's second factory",
      },
    ],
    launchTopic: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
    curve: { state: true, realTokenReserve: true, quotes: "onchain" },
  },
  pons: {
    key: "pons",
    label: "Pons",
    factories: [
      {
        address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
        /** 2026-08-04, the earliest block a launch was found in by bisecting
         *  40,000-block log windows: this node serves no historical state, so
         *  eth_getCode cannot be bisected as clank's was. The factory may have
         *  been deployed earlier and idle, which costs one empty window. */
        genesisBlock: 27823666n,
        label: "the Pons factory",
      },
    ],
    launchTopic: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
    // 18 of our 25 curve functions are present, buy() and sell() unchanged.
    // Of the seven missing, these three are read on the judging path.
    curve: { state: false, realTokenReserve: false, quotes: "simulated" },
  },
};

/** Every name `VENUE` accepts, for the error a wrong one raises. */
export const VENUE_KEYS = Object.keys(VENUES) as Venue["key"][];

/** Exported so the refusal can be tested without reloading the module. */
export function selectVenue(raw: string | undefined): Venue {
  const name = (raw ?? "clank").trim().toLowerCase();
  const venue = (VENUES as Record<string, Venue | undefined>)[name];
  // A sniper pointed at nothing is worse than one that will not start, so an
  // unknown name is fatal rather than a silent fall back to the default.
  if (!venue) {
    throw new Error(`VENUE="${raw}" is not a venue this bot knows. Set one of: ${VENUE_KEYS.join(", ")}.`);
  }
  return venue;
}

/**
 * The venue this process watches. `VENUE` unset means clank.trade, as before.
 *
 * There is deliberately no `CLANK` export any more: a call site that kept
 * reading it would go on watching one factory while the rest of the process
 * watched the other, and nothing would say so.
 */
export const VENUE = selectVenue(process.env.VENUE);

/** The factories this process believes: the watched venue's, and no other. */
export const FACTORIES: readonly Factory[] = VENUE.factories;

/**
 * The listed factory at `address`, or undefined. The lookup every
 * authenticity check makes: an address that is not in the list is not the
 * venue, whatever else it says about itself.
 */
export function factoryAt(address: string | null | undefined, venue: Venue = VENUE): Factory | undefined {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return venue.factories.find((f) => f.address.toLowerCase() === a);
}

/** Where a scan across all of a venue's factories starts: the earliest genesis. */
export function genesisFloor(venue: Venue = VENUE): bigint {
  return venue.factories.reduce((m, f) => (f.genesisBlock < m ? f.genesisBlock : m), venue.factories[0]!.genesisBlock);
}
