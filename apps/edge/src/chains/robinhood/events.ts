import { decodeEventLog, getAddress, parseAbi, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { v4PoolId, type V4PoolKey } from '@eko/chain';
import type { CoinState } from '../../tracker.js';
import type { Trade } from '../../market.js';
import type { RobinhoodAddresses } from './addresses.js';
import { PONS_TERMS } from './profile.js';

/**
 * Pons on Robinhood Chain (4663), read from logs alone. A launch is the factory's TokenLaunched; each launch gets its own
 * bonding-curve contract, which emits CurveBuy and CurveSell; graduation is the curve buying its last sellable token and
 * the factory seeding a Uniswap v4 pool (native ETH / coin) with the registry's Pons hook. The old indexer detected it
 * the same way (apps/indexer/src/decode.ts: a v4 Initialize whose hook is `pons.v4Hook`). After graduation the coin
 * trades on that pool and the tracker's generic v4 Swap handling takes over.
 *
 * Decoders follow packages/chain/src/launchpads/pons.ts (decodePonsResult) and its verified ABI
 * (packages/chain/abi/pons/events.json). Checked against a full launch-to-graduation capture
 * (apps/edge/test/fixtures/robinhood/pons-graduation.json): the curve's real quote reserve rebuilt from its trades
 * equals the 4.2 ETH (+6 wei) it hands the factory at graduation, and the tokens sold equal its sellable inventory.
 */

/**
 * The three events, typed. The same signatures as the verified ABI (packages/chain/abi/pons/events.json, exported as
 * ponsFactoryAbi and ponsCurveAbi, which are untyped JSON); the test checks the selectors match.
 */
export const ponsEventsAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);
export const TOKEN_LAUNCHED_TOPIC = toEventSelector(ponsEventsAbi[0]);
export const CURVE_BUY_TOPIC = toEventSelector(ponsEventsAbi[1]);
export const CURVE_SELL_TOPIC = toEventSelector(ponsEventsAbi[2]);
export const v4InitializeAbi = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
export const INITIALIZE_TOPIC = toEventSelector(v4InitializeAbi[0]);
/** A topic holding the zero address: native ETH as a v4 pool's currency0. */
export const NATIVE_TOPIC = `0x${'0'.repeat(64)}` as Hex;
/** The pool id a pre-graduation coin carries (CoinState.poolId is not optional). */
export const NO_POOL_ID = `0x${'0'.repeat(64)}` as Hex;

export interface LogFilter { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }

/**
 * The eth_getLogs filters for one tick, besides the tracker's own (every ERC-20 Transfer, and every v4 Swap on the
 * PoolManager, which covers graduated coins):
 * - launches and curve trades in one topic-OR call with no address: curves are one contract per coin (about 45 new ones
 *   an hour), too many to list. Only TokenLaunched from the factory and trades from a curve it announced are kept.
 *   Without an address the public RPC allows 30,000 blocks a call (profile.ts).
 * - v4 Initialize on the PoolManager with native ETH as currency0 (the hook is not indexed; it is checked in decode).
 */
export function robinhoodLogQueries(addrs: Pick<RobinhoodAddresses, 'poolManager'>): LogFilter[] {
  return [
    { topics: [[TOKEN_LAUNCHED_TOPIC, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]] },
    { address: addrs.poolManager, topics: [INITIALIZE_TOPIC, null, NATIVE_TOPIC] },
  ];
}

/** Where a log sits, for ids and ordering. `ts` is the log's blockTimestamp when the provider gives one. */
export interface LogPlace { block: number; tx: Hex; logIndex: number; ts: number | null }
export type RobinhoodEvent = LogPlace & (
  | { kind: 'launch'; token: Address; creator: Address; curve: Address; quote: Address; launchConfigId: bigint;
      /** Total supply, all minted to the curve in the launch transaction (PONS_TERMS); null for a launch config not seen. */
      supply: bigint | null; graduationThreshold: bigint;
      /** TokenLaunched carries neither; the tracker reads them in batches after launch. */
      name: string | null; symbol: string | null }
  | { kind: 'curve_trade'; curve: Address;
      /** The coin, when the caller's curve lookup knows this curve; null otherwise. */
      token: Address | null; side: 'buy' | 'sell';
      /** The curve's caller (often the Pons router) and who received the output. */
      trader: Address; recipient: Address;
      /** Native ETH (wei) as the trader saw it: gross paid in on a buy, net paid out on a sell. */
      native: bigint; tokens: bigint; fee: bigint; tax: bigint;
      /** Pons' trade events carry no reserves: applyRobinhoodEvent rebuilds them from the trades. */
      reserves: null }
  | { kind: 'graduated'; token: Address; key: V4PoolKey; poolId: Hex; manager: Address; sqrtPriceX96: bigint; tick: number }
);

export interface RawRobinhoodLog { address: string; topics: Hex[]; data: Hex; blockNumber: Hex | string; transactionHash: Hex; logIndex: Hex | string | number; blockTimestamp?: Hex | string }

const num = (v: Hex | string | number) => Number(typeof v === 'number' ? v : BigInt(v));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const place = (log: RawRobinhoodLog): LogPlace => {
  const ts = log.blockTimestamp !== undefined ? num(log.blockTimestamp) : 0;
  return { block: num(log.blockNumber), tx: log.transactionHash, logIndex: num(log.logIndex), ts: ts > 0 ? ts : null };
};

/**
 * One log as a Robinhood event, or null when it is not one EKO follows. `curveToken` maps a curve to its coin (the
 * tracker's map of launched coins); with it, trades on curves it does not know are dropped. Launches quoted in an
 * ERC-20 (USDG, a stock token, another Pons coin) are skipped: EKO prices native-ETH curves only.
 */
export function decodeRobinhoodLog(log: RawRobinhoodLog, addrs: Pick<RobinhoodAddresses, 'factory' | 'hook' | 'poolManager'>,
  curveToken?: (curve: Address) => Address | null): RobinhoodEvent | null {
  const t0 = log.topics[0];
  try {
    if (t0 === TOKEN_LAUNCHED_TOPIC) {
      // Only the registry's factory announces Pons launches.
      if (!same(log.address, addrs.factory)) return null;
      const { args: a } = decodeEventLog({ abi: [ponsEventsAbi[0]], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      if (a.pairToken !== zeroAddress || a.graduationThreshold <= 0n) return null;
      return { kind: 'launch', ...place(log), token: getAddress(a.token), creator: getAddress(a.deployer), curve: getAddress(a.curve), quote: zeroAddress,
        launchConfigId: a.launchConfigId, supply: a.launchConfigId === PONS_TERMS.launchConfigId ? PONS_TERMS.supply : null,
        graduationThreshold: a.graduationThreshold, name: null, symbol: null };
    }
    if (t0 === CURVE_BUY_TOPIC || t0 === CURVE_SELL_TOPIC) {
      const curve = getAddress(log.address);
      const token = curveToken ? curveToken(curve) : null;
      if (curveToken && !token) return null;
      const event = decodeEventLog({ abi: [ponsEventsAbi[1], ponsEventsAbi[2]], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      const base = { kind: 'curve_trade' as const, ...place(log), curve, token, reserves: null };
      if (event.eventName === 'CurveBuy') { const a = event.args;
        return { ...base, side: 'buy', trader: getAddress(a.buyer), recipient: getAddress(a.recipient), native: a.quoteIn, tokens: a.tokensOut, fee: a.fee, tax: a.tax }; }
      const a = event.args;
      return { ...base, side: 'sell', trader: getAddress(a.seller), recipient: getAddress(a.recipient), native: a.quoteOut, tokens: a.tokensIn, fee: a.fee, tax: a.tax };
    }
    if (t0 === INITIALIZE_TOPIC) {
      // A pool id is unique only within its PoolManager; the hook is in the data, so it is checked here.
      if (!same(log.address, addrs.poolManager)) return null;
      const { args } = decodeEventLog({ abi: v4InitializeAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      if (args.currency0 !== zeroAddress || !same(args.hooks, addrs.hook)) return null;
      const key: V4PoolKey = { currency0: zeroAddress, currency1: getAddress(args.currency1), fee: args.fee, tickSpacing: args.tickSpacing, hooks: getAddress(args.hooks) };
      // The rebuilt key must hash to the logged id, as for every launchpad on Elysium (launchpads.ts).
      if (v4PoolId(key).toLowerCase() !== args.id.toLowerCase()) return null;
      return { kind: 'graduated', ...place(log), token: key.currency1, key, poolId: args.id, manager: getAddress(log.address), sqrtPriceX96: args.sqrtPriceX96, tick: args.tick };
    }
  } catch { return null; }
  return null;
}

/** The pre-graduation curve of a Pons coin: the fields the chain seam adds to CoinState. */
export interface PonsCurve {
  address: Address;
  /** Real (fee-free) native ETH the curve must hold to graduate (TokenLaunched). */
  graduationThreshold: bigint;
  /** Native ETH the curve holds from trades, fees and creator tax excluded (apps/engines/src/curve-progress.ts). */
  realQuoteReserve: bigint;
  /** Tokens a buy can still take before graduation (the curve's sellableTokens()). */
  realTokenReserve: bigint;
}
/** What a Robinhood coin adds to, or changes in, CoinState (tracker.ts). Merged by the integrator. */
export interface RobinhoodCoinFields {
  launchpad: 'pons';
  /** Null until graduation, then the Pons v4 pool's key. */
  key: V4PoolKey | null;
  /** NO_POOL_ID until graduation. */
  poolId: Hex;
  curve?: PonsCurve;
}
export type RobinhoodCoinState = Omit<CoinState, 'launchpad' | 'key' | 'poolId'> & RobinhoodCoinFields;

/** Curve accounting of one trade: buys add the net quote, sells remove the gross (apps/engines/src/curve-progress.ts). */
export function reserveDelta(e: { side: 'buy' | 'sell'; native: bigint; fee: bigint; tax: bigint }): bigint {
  return e.side === 'buy' ? e.native - e.fee - e.tax : -(e.native + e.fee + e.tax);
}

/**
 * A trade as the chart and volume read it. Amounts in native ETH (the field is named for Elysium's HYPE). The price
 * is the curve's own: gross quote less fee and tax per token, for buys and sells alike, so the two sides chart on one
 * line; what the trader paid or got is `hype`.
 */
export function curveTrade(e: Extract<RobinhoodEvent, { kind: 'curve_trade' }>, ts: number): Trade | null {
  if (e.tokens === 0n || e.native === 0n) return null;
  const curveQuote = e.side === 'buy' ? e.native - e.fee - e.tax : e.native + e.fee + e.tax;
  const tokens = Number(e.tokens) / 1e18;
  return { ts, block: e.block, tx: e.tx, sender: e.trader, side: e.side, hype: Number(e.native) / 1e18, tokens, priceHype: Number(curveQuote) / 1e18 / tokens };
}

export interface ApplyOptions { addrs: Pick<RobinhoodAddresses, 'factory' | 'poolManager'>; ts?: number; maxTrades?: number }

/**
 * Apply one event to a coin, without changing the one passed in: a launch builds a new coin (an existing one is returned
 * unchanged), a curve trade appends the trade and moves the curve's reserves, a graduation gives the coin its v4 key,
 * pool id and PoolManager. Returns undefined when the event concerns no coin it was given (a trade or graduation of a
 * coin launched before the window). `ts` is the block time; the log's own timestamp is used when it carried one.
 */
export function applyRobinhoodEvent(coin: RobinhoodCoinState | undefined, event: RobinhoodEvent, options: ApplyOptions): RobinhoodCoinState | undefined {
  const ts = event.ts ?? options.ts ?? 0;
  if (event.kind === 'launch') {
    if (coin) return coin;
    const supply = event.supply ?? 0n;
    return {
      launchpad: 'pons', key: null, poolId: NO_POOL_ID, flipped: false,
      // An unseen launch config: supply is summed from the mints (the tracker's Transfer handling), like Elysium's others.
      supplyFromMints: event.supply === null,
      launcher: getAddress(options.addrs.factory), manager: getAddress(options.addrs.poolManager),
      token: event.token, creator: event.creator, quote: event.quote, supply, configId: event.launchConfigId,
      firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: event.creator, feeLocked: false,
      block: event.block, ts, tx: event.tx, trades: [], netHype: 0, sqrtPriceX96: null, graduated: false,
      name: event.name, symbol: event.symbol, flows: [],
      curve: { address: event.curve, graduationThreshold: event.graduationThreshold, realQuoteReserve: 0n,
        realTokenReserve: event.supply === null ? 0n : PONS_TERMS.sellable(event.supply) },
    };
  }
  if (!coin) return undefined;
  if (event.kind === 'curve_trade') {
    // A trade counts only from the coin's own curve, and only before graduation (the curve closes then).
    if (!coin.curve || !same(coin.curve.address, event.curve) || coin.graduated || (event.token && !same(event.token, coin.token))) return coin;
    const trade = curveTrade(event, ts);
    if (!trade) return coin;
    const max = options.maxTrades ?? 5000;
    const trades = [...coin.trades, trade];
    if (trades.length > max) trades.splice(0, trades.length - max);
    const q = coin.curve.realQuoteReserve + reserveDelta(event);
    const t = coin.curve.realTokenReserve + (event.side === 'buy' ? -event.tokens : event.tokens);
    // A reserve below zero means history before the window: clamp rather than carry a negative balance.
    const curve: PonsCurve = { ...coin.curve, realQuoteReserve: q < 0n ? 0n : q, realTokenReserve: t < 0n ? 0n : t };
    // The creator's first buy is the first buy in the launch transaction.
    const first = event.side === 'buy' && coin.firstBuyIn === 0n && event.tx.toLowerCase() === coin.tx.toLowerCase();
    return { ...coin, trades, curve, netHype: coin.netHype + (trade.side === 'buy' ? trade.hype : -trade.hype),
      ...(first ? { firstBuyIn: event.native, firstBuyOut: event.tokens } : {}) };
  }
  // Graduation: the Pons hook's pool for this coin. Sticky; the first one counts.
  if (!same(event.token, coin.token) || coin.graduated) return coin;
  return { ...coin, key: event.key, poolId: event.poolId, manager: event.manager, flipped: false, graduated: true, graduatedTs: ts, sqrtPriceX96: event.sqrtPriceX96 };
}

/** Logs in chain order, launches first (a launch transaction logs its curve before TokenLaunched): the tracker's rule. */
export function orderRobinhoodLogs<L extends RawRobinhoodLog>(logs: readonly L[]): L[] {
  const order = (a: L, b: L) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex);
  const isLaunch = (l: L) => l.topics[0] === TOKEN_LAUNCHED_TOPIC;
  return [...logs.filter(isLaunch).sort(order), ...logs.filter(l => !isLaunch(l)).sort(order)];
}
