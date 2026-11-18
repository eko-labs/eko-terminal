import type { Address, Chain, Hex } from 'viem';
import type { V4PoolKey } from '@eko/chain';
import type { PlaybookConfig } from '@eko/playbooks';
import type { ChainKey, SupportedChainId } from '@eko/shared';
import type { Assessment, Probed } from '../assess.js';
import type { Explorer } from '../explorer.js';
import type { NativeUsd } from '../hype.js';
import type { Trade } from '../market.js';
import type { CoinState, RawLog, Rpc } from '../tracker.js';

/**
 * One chain per deployment (EKO_CHAIN, chains/index.ts). The profile is what the rest of the edge needs to know about
 * that chain as data; the adapter below is the code that differs. Everything else (the tracker core, judge and
 * playbooks, holders, funders, outcomes, accounts, agents, MCP, history, ws, relay and the order book) is shared.
 */
export interface ChainProfile {
  key: ChainKey; id: SupportedChainId;
  /** As users read it: "Elysium", "Robinhood Chain". */
  name: string;
  native: 'HYPE' | 'ETH';
  chain: Chain;
  publicRpc: string;
  /** The explorer people open, and its Etherscan-compatible API (historian, funder tracer); null when scripts cannot
   *  use it (Robinhood Chain's Blockscout answers a Cloudflare challenge): the historian then stays off by default. */
  explorerUrl: string; explorerApi: string | null;
  /** Average block time: turns seconds of history into blocks and stamps logs that carry no timestamp. */
  blockTimeSec: number;
  /** eth_getLogs span the tracker starts with (halved on a "too many" reply), and its start-up replay when not
   *  BACKFILL_SEC worth of blocks. */
  tracker: { chunk: number; backfillBlocks?: number };
  /** Calls a minute the public RPC takes without answering 429 (the metered client paces to it). */
  publicRpm: number;
  /** The historian's first block: the main launchpad's deployment. */
  historianFromBlock: number;
  playbooks: PlaybookConfig;
  /** The native coin in USD: Hyperliquid's public mids (no key), read by symbol. */
  price: { url: string; symbol: string };
  /** Mission Control's approval venue (the shared contract's enum) and the scoreboard's outcome and identity version. */
  venue: 'elysium' | 'rhc'; outcomeVersion: string;
  mcp: { name: string; title: string };
  text: ChainText;
}

export interface LogFilter { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }

/** Fragments of user- and agent-facing text: "EKO follows {launches} on {name}". */
export interface ChainText {
  /** "Montra launches" */
  launches: string;
  /** "Montra token" */
  token: string;
  /** "Montra coins" */
  coins: string;
  /** The launchpad's fee on early buys: "Montra's early-buy fee". */
  earlyFee: string;
  /** How a prepared trade executes: "Uniswap v4". */
  tradeVenue: string;
}

/** What a chain's log handlers may do to the tracker (tracker.ts). */
export interface TrackerCore {
  coin(address: string): CoinState | undefined;
  /** By pool id, or by any other id the coin was linked under (a bonding curve's address). */
  coinByPool(id: string): CoinState | undefined;
  /** Keep a new coin, index it by its pool id (and curve), announce it. False when it is already tracked. */
  launch(coin: CoinState, log: RawLog): boolean;
  /** Index a coin under another id: its v4 pool id once it graduates. */
  link(id: string, coin: CoinState): void;
  /** Record one trade of the coin (and a graduation it causes). */
  trade(coin: CoinState, trade: Trade, log: RawLog): void;
  /** Mark it graduated, once. */
  graduate(coin: CoinState, ts: number, log: RawLog): void;
  /** Base of the market-cap graduation line (graduation.ts). */
  openMcapHype: number;
}

/** The chain-specific parts of a verdict: the early-buy window, the pool's fee, who holds the liquidity, the hook. */
export interface JudgeFacts {
  antiSnipeActive: boolean;
  antiSnipe: { taxPct: number; endsInSec: number } | null;
  /** The pool's fee, for its pools[] entry. */
  feeBps: number;
  /** Who holds the launch liquidity, where that is known (documented or verified source); null makes no claim. */
  liquidity: { owner: Address; status: 'locked' | 'removable'; label: string } | null;
  /** How EKO knows the pool's hook, and the fee it takes. Used only when the pool has one. */
  hook: { label: string; reviewed: boolean; sourceVerified: boolean; buyFeePct: number | null; sellFeePct: number | null };
}

/** Where a coin trades now: a launchpad's bonding curve before graduation, a v4 pool after. */
export type TradeRoute = { kind: 'curve'; curve: Address; token: Address } | { kind: 'v4'; key: V4PoolKey; token: Address };
export type ApprovalNeed = { kind: 'erc20'; token: Address; spender: Address; amount: string } | { kind: 'permit2'; token: Address; spender: Address; amount: string; expiration: number };
export interface SwapReceipt { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice?: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] }

/** A chain's trading: routes, quotes, the exact call, approvals and fills. Trading (trade.ts) owns everything else. */
export interface TradeVenue {
  /** Contracts a wallet calls, and those it approves (both listed in the public config). */
  routers: Address[]; spenders: Address[];
  permit2: Address;
  /** Refuse a coin before any RPC (throws with a status), e.g. one in a PoolManager EKO cannot route to. */
  precheck?(coin: CoinState): void;
  /** The route from a fresh check; throws with a status when there is none. */
  route(coin: CoinState, a: Assessment | undefined): TradeRoute;
  /** Output for an exact input. `gas` prices the network fee; `priceImpactBps` replaces EKO's own estimate when given. */
  quote(rpc: Rpc, route: TradeRoute, side: 'buy' | 'sell', amountIn: bigint): Promise<{ expectedOut: bigint; gas?: bigint; priceImpactBps?: number }>;
  /** The exact call for `wallet` (the order's own, which signs it). Its output goes to that wallet, never elsewhere. */
  build(route: TradeRoute, side: 'buy' | 'sell', amountIn: bigint, minOut: bigint, deadline: bigint, wallet: Address): { to: Address; data: Hex; value: bigint };
  /** Every approval the call needs; Trading drops those the wallet already gave. */
  approvals(route: TradeRoute, side: 'buy' | 'sell', amountIn: bigint, expiration: number): ApprovalNeed[];
  /** What a mined swap filled, read from its receipt (amounts before Trading's own balance check on sells). */
  fill(receipt: SwapReceipt, route: TradeRoute, side: 'buy' | 'sell', wallet: Address): { filledIn?: bigint; filledOut?: bigint } | null;
}

/**
 * The historian's chain-specific reads (historian.ts), all on the explorer: where launches are announced, which swaps
 * count per pool id (topic 1), and the logs that rebuild one launch's first day for the tracker to replay.
 */
export interface HistorianSource {
  launches: { address: Address; topic0: Hex };
  swaps: { address: Address; topic0: Hex };
  replayLogs(explorer: Explorer, launch: { token: Address; poolId: Hex; createdBlock: number }, end: number): Promise<RawLog[]>;
}

/** Everything chain-specific the edge calls. A deployment builds one (chains/index.ts). */
export interface ChainAdapter {
  readonly profile: ChainProfile;
  readonly multicall3: Address;
  // The tracker: what to fetch each span and how to read it.
  /** The chain's own eth_getLogs filters, each fetched per span beside the tracker's Swap and Transfer calls: launches,
   *  graduations, a launchpad's own trades. */
  readonly queries: LogFilter[];
  /** The PoolManagers whose v4 Swaps count for tracked pools. */
  readonly swapManagers: Address[];
  isLaunch(log: RawLog): boolean;
  /** Apply a log of `queries` (launch, graduation, a launchpad's trade record). */
  apply(log: RawLog, ts: number, t: TrackerCore): void;
  /** Whether a PoolManager Swap counts for this coin (its own manager; not a leg counted elsewhere). */
  countsSwap(coin: CoinState, log: RawLog): boolean;
  /** A coin with no graduation event of its own graduates on this trade. */
  graduatesOnTrade(coin: CoinState, openMcapHype: number): boolean;
  // Checks.
  /** Contracts that hold or route a coin without being holders. */
  excluded(coin?: Pick<CoinState, 'launcher' | 'curve'>): Address[];
  /** The paid part of a check (name, terms, the buy-then-sell probe, early-buy tips). */
  probe(coin: CoinState, block: bigint, deps: { rpc: Rpc; hypeUsd: () => number | null; now?: () => number }, priorTips?: Record<string, number>): Promise<Probed>;
  facts(coin: CoinState, p: Probed, nowSec: number): JudgeFacts;
  trade: TradeVenue;
  historian: HistorianSource;
  /** The native coin in USD, refreshed by the edge's loop. */
  price(rpc: Rpc): NativeUsd;
  /** Coins put back after a restart hold state as of the save, but the backfill replays from `block`: a chain whose
   *  coins carry running balances (a bonding curve's reserves) resets them to the chain's values at `block` here. */
  rebase?(coins: CoinState[], block: bigint, rpc: Rpc): Promise<void>;
}
