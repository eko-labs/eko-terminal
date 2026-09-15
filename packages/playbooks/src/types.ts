import type { Address, EvidenceRef, Level, PlaybookId, PlaybookMatch, Verdict } from '@eko/shared';
import type { PlaybookConfig } from '../config/v1.js';

// TODO(spec): §6–7 do not define CardSources/HistoryView wire shapes. These are
// normalized, point-in-time inputs; absent optional sections mean unknown, not zero.
// Times are Unix seconds, fractions are 0..1, tax/gap values are percentage points.
export interface Simulation {
  id: string;
  sizeUsd: 100 | 1000 | 10000;
  block: number;
  buyOk: boolean;
  sellOk: boolean;
  returnedInputShare: number;
  traceDigest: string;
  revert?: string;
  // Classified acquired-position evidence; omitted for heritage/Pons inputs.
  confirmedBlockedExit?: boolean;
  contractRestricted?: boolean;
  deep?: Omit<Simulation, 'deep' | 'sizeUsd'>;
}

export interface PriorLaunch {
  coin: Address;
  createdAtSec: number;
  relation: 'deployer' | 'crew' | 'both';
  matches: { id: PlaybookId; level: Level }[];
  // Availability block is preserved when materializing observed horizon outcomes.
  outcomes: { validFromBlock?: number; horizon: '1h' | '24h' | '7d'; outcome: 'rugged' | 'honeypot' | 'dumped' | 'survived'; evidence: EvidenceRef[] }[];
  evidence: EvidenceRef[];
}
export interface HistoryView { crewId?: string; launches: PriorLaunch[] }

export interface CardSources {
  coin: Address;
  deployer: Address;
  asOfBlock: number;
  asOfSec: number;
  createdAtSec: number;
  createdAtBlock: number;
  launchpad: 'pons' | 'occupy' | 'flap' | 'klik' | 'montra' | 'flaunch' | 'hyperforge' | 'taxlaunch' | 'unbranded' | 'other';
  name: string;
  symbol: string;
  antiSnipeActive?: boolean;
  simulations?: Simulation[];
  taxes?: {
    buyPct: number | null; sellPct: number | null;
    // Mutable only with reviewed reachable permissions and a state-changing effect (Guard §3.4).
    mutable: boolean | null; setter?: EvidenceRef; owner?: Address;
    changes: { beforePct: number; afterPct: number; evidence: EvidenceRef }[];
  };
  liquidity?: {
    positions: { owner: Address; controlledBy: 'deployer' | 'crew' | 'other'; share: number;
      status: 'burned' | 'locked' | 'pons_locked' | 'removable'; evidence: EvidenceRef[] }[];
    depth2Usd?: number;
    priorRemovals: EvidenceRef[];
    priorRemovalCount?: number;
    /**
     * Liquidity the coin launched with has been taken out of the pool it trades in by the wallet that paid it in: the
     * identified deployer, or the wallet that provided the pool's first liquidity. `share` is the part of that wallet's
     * peak liquidity there that is gone (1 when none is left). Absent when it never removed any, or when liquidity
     * was added to another pool of the coin afterwards (a move, not a pull).
     */
    pulled?: { share: number; by: 'deployer' | 'provider'; wallet: Address; evidence: EvidenceRef[] };
  };
  pools?: { id: string; feeBps: number; liquidityShare: number; deepest: boolean; defaultRoute: boolean; evidence: EvidenceRef[] }[];
  curve?: {
    ageH: number; volumeUsd: number; progressUsd: number;
    clusters: { id: string; volumeShare: number; evidence: EvidenceRef[] }[];
    feeClaims: EvidenceRef[];
  };
  wash?: {
    washEstPct?: number; volumeUsd1h: number; traders1h: number;
    // Non-overlapping actor round trips in the same 1h window, supplied by Normalizer.
    roundTrips: { actor: Address; durationSec: number; netShare: number; volumeUsd: number; evidence: EvidenceRef[] }[];
  };
  trending?: { coin: Address; name: string; symbol: string; rank: number; createdAtSec: number; trendStartedAtSec: number; evidence: EvidenceRef[] }[];
  dominantPair?: { buyer: Address; seller: Address; share: number; evidence: EvidenceRef[] };
  pons?: {
    creatorTaxPct?: number; feePct?: number;
    exemptions: { wallet: Address; crewRugRuns: number; log: EvidenceRef }[];
    boughtShare: number; heldShare: number;
  };
  /**
   * Wallets that bought soon after launch. `funder` paid for the buy (a contract buying for several wallets groups them);
   * `boughtShare` is the supply this wallet bought then, `deployer` marks the launch's own deployer.
   */
  /**
   * Holders at the card's block, the curve, pools and burn addresses excluded: the top ten's share of supply (the
   * deployer included), the largest holder other than the deployer, and what the largest holders hold without ever
   * having bought (tokens transferred in: GMGN's "phishing" wallets). Shares are of total supply.
   */
  holders?: { top10Share: number; largestShare: number; largest: Address | null; transferredShare: number; transferredWallets: number; evidence: EvidenceRef[] };
  /** The deployer's own trading in this coin: USD in and out, supply sold, first sell (seconds after launch), held now. */
  dev?: { heldShare: number; cashInUsd: number; cashOutUsd: number; soldShare: number; firstSellSec: number | null; evidence: EvidenceRef[] };
  /**
   * A Pons coin still on its launch curve: the share of supply bought out of the curve (net of sells) at the card's
   * block, the share bought on net in the last hour, and the coin's age. Absent after graduation and off Pons.
   */
  runUp?: { outShare: number; hourShare: number; ageSec: number; evidence: EvidenceRef[] };
  /**
   * Launch-block snipers: wallets other than the deployer that bought within the first blocks of the launch (about a
   * second on Elysium), with the supply share each bought then and holds now, and the highest priority fee (gwei) any
   * of its sniping transactions paid (null when not read). Absent when not computed; an empty list means none.
   */
  snipers?: { wallet: Address; block: number; boughtShare: number; heldShare: number; tipGwei: number | null; evidence: EvidenceRef[] }[];
  earlyBuyers?: { wallet: Address; funder: Address; fundedAtSec: number; buyAtSec: number; buyBlock: number;
    heldShare: number; sellingIntoNetInflow: boolean; evidence: EvidenceRef[]; boughtShare?: number; deployer?: boolean }[];
  graduation?: { atSec: number; tx: EvidenceRef; insiderSells: {
    atSec: number; soldShare: number; priceImpactShare: number; evidence: EvidenceRef[];
  }[] };
  /**
   * The v4 hook of the pool the coin trades in. Permission bits are the low 14 bits of the hook's address (what it may
   * do); the quote gap and fees are measurements, null when not measured (no reference simulation ran).
   */
  hook?: {
    address: Address; reviewed: boolean; sourceVerified: boolean;
    permissionBits: number; returnDeltaPermissionBits: number;
    quoteSimGapPct: number | null; buyFeePct: number | null; sellFeePct: number | null; evidence: EvidenceRef[];
  };
  tokenText?: { ref: string; raw: string }[];
}

export interface PlaybookInput extends CardSources { history: HistoryView }
export interface Rule<K extends keyof PlaybookConfig = keyof PlaybookConfig> {
  id: K;
  evaluate(s: CardSources, h: HistoryView, cfg: PlaybookConfig[K]): PlaybookMatch | null;
}
export type VerdictMeta = Pick<Verdict, 'coin' | 'asOfBlock' | 'receipt'>;
