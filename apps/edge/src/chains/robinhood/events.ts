import { decodeEventLog, getAddress, parseAbi, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { v4PoolId, type V4PoolKey } from '@eko/chain';
import type { CoinState } from '../../tracker.js';
import type { Trade } from '../../market.js';
import type { RobinhoodAddresses } from './addresses.js';
import { openPriceAt } from '../../graduation.js';
import { PANGEA_TERMS, PONS_TERMS } from './profile.js';

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
/**
 * Pangea's launch record, logged by its launcher after it opened the coin's pool (profile.ts PANGEA_TERMS). The event's
 * name and ABI are not published: the layout is read from all 62 launches to block 117,470,682. Topics: launch id, coin,
 * creator (the transaction's sender on all 62). Data, four words: the v4 pool id, a per-launch contract, the launch
 * position's upper tick (int24, one above the opening tick on all 58 native pools), and a flag whose meaning is not
 * known (it is not the quote: 39 of the 58 native pools have it set).
 */
export const PANGEA_POOL_TOPIC = '0xbdca3fcdb296a15c842ff17efa2156eea58d30d1f6ca44c2b3ab375503e540ca' as Hex;
/**
 * long.xyz's launch record: its (Doppler) Airlock's Create(asset, numeraire, initializer, poolOrHook), the last log of each
 * launch transaction (profile.ts LONGXYZ). It names the coin and its numeraire; the pool's key comes from its Initialize.
 */
export const longCreateAbi = parseAbi(['event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)']);
export const LONG_CREATE_TOPIC = toEventSelector(longCreateAbi[0]);
/**
 * The unbranded launcher's launch record (profile.ts UNBRANDED_LAUNCHER). Name and ABI not published; layout read from all
 * 62 launches in the 24 hours to block 117,533,644. Topics: creator (the transaction's sender on all 62), coin, pool id.
 * Data, five words: the launch position's PositionManager token id, the pool fee, its tick spacing, the native ETH the
 * launch put in the pool, and the supply.
 */
export const UNBRANDED_LAUNCH_TOPIC = '0x03f29fb2049a216108887bac46b54b1f8d8db31efb6e3cc67bb6a63f2441e84f' as Hex;
export const v4ModifyLiquidityAbi = parseAbi(['event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)']);
/** Every liquidity change on the PoolManager: the third per-span query, for launch positions a wallet holds. */
export const MODIFY_LIQUIDITY_TOPIC = toEventSelector(v4ModifyLiquidityAbi[0]);
/** The launch records the tracker applies before the rest of a span (each creates a coin). */
export const ROBINHOOD_LAUNCH_TOPICS: readonly Hex[] = [TOKEN_LAUNCHED_TOPIC, PANGEA_POOL_TOPIC, LONG_CREATE_TOPIC, UNBRANDED_LAUNCH_TOPIC];
export const isRobinhoodLaunch = (log: { topics: readonly Hex[] }) => ROBINHOOD_LAUNCH_TOPICS.includes(log.topics[0] as Hex);
/** A native-ETH Pangea pool's key: the only key whose id can equal the pool id the launch logs. */
export const pangeaPoolKey = (token: Address, hook: Address): V4PoolKey =>
  ({ currency0: zeroAddress, currency1: getAddress(token), fee: PANGEA_TERMS.fee, tickSpacing: PANGEA_TERMS.tickSpacing, hooks: getAddress(hook) });
/** The pool id a pre-graduation coin carries (CoinState.poolId is not optional). */
export const NO_POOL_ID = `0x${'0'.repeat(64)}` as Hex;

export interface LogFilter { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }

/**
 * The eth_getLogs filters for one tick, besides the tracker's own (every ERC-20 Transfer, and every v4 Swap on the
 * PoolManager, which covers graduated coins):
 * - launches and curve trades in one topic-OR call with no address: curves are one contract per coin (about 45 new ones
 *   an hour), too many to list. Only TokenLaunched from the factory and trades from a curve it announced are kept.
 *   Without an address the public RPC allows 30,000 blocks a call (profile.ts). The launch records of Pangea, long.xyz
 *   and the unbranded launcher ride in the same call (each kept only from its own contract), so following them costs no
 *   extra call: their pools' swaps and their transfers come in through the tracker's own Swap and Transfer calls.
 * - v4 Initialize on the PoolManager with native ETH as currency0 (the hook is not indexed; it is checked in decode): a
 *   Pons graduation, or the pool of a coin a launch record announced (long.xyz's key, every coin's opening price).
 * - v4 ModifyLiquidity on the PoolManager: a launch position a wallet holds being added to or taken out (unbranded).
 */
export function robinhoodLogQueries(addrs: Pick<RobinhoodAddresses, 'poolManager'>, opts: DecodeOptions = {}): LogFilter[] {
  return [
    { topics: [[TOKEN_LAUNCHED_TOPIC, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, PANGEA_POOL_TOPIC, LONG_CREATE_TOPIC, UNBRANDED_LAUNCH_TOPIC]] },
    // With token-quoted pools followed (DecodeOptions), every Initialize: a long.xyz pool keyed in a token has a token as
    // currency0 or currency1 (about 2,600 Initialize logs a day on the PoolManager in all).
    opts.quotedPools ? { address: addrs.poolManager, topics: [INITIALIZE_TOPIC] } : { address: addrs.poolManager, topics: [INITIALIZE_TOPIC, null, NATIVE_TOPIC] },
    { address: addrs.poolManager, topics: [MODIFY_LIQUIDITY_TOPIC] },
  ];
}

/**
 * Whether token-quoted pools are followed (flag more_launchpads): long.xyz launches whose numeraire is a token (WETH,
 * USDG, a stock token) and their pools' Initialize. Off, decoding is exactly as before: native ETH only.
 */
export interface DecodeOptions { quotedPools?: boolean }

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
  /** A coin that trades in its own v4 pool from launch (no curve, no graduation): Pangea, long.xyz, unbranded. */
  | { kind: 'pool_launch'; launchpad: PoolLaunchpad; token: Address;
      /** What the pool is quoted in: native ETH (zero), or the token a long.xyz launch names as its numeraire. */
      quote: Address;
      /** The launching wallet; the coin itself where the record names none (long.xyz: no deployer identified). */
      creator: Address; launcher: Address;
      /** Null until the pool's Initialize (long.xyz); NO_POOL_ID with it. */
      key: V4PoolKey | null; poolId: Hex;
      /** A tick the opening price sits just below (Pangea's launch position), when the record gives one. */
      openTick: number | null;
      /** A launch position the creator holds (unbranded): its salt and the native ETH the launch put in. */
      launchPosition: { owner: Address; salt: Hex; seed: bigint } | null }
  /** A v4 pool opened with a hook other than Pons': a launch record's pool (key, opening price), if tracked. Native-ETH
   *  pools, and with DecodeOptions.quotedPools long.xyz's token-quoted pools, whose coin may be either currency: `token`
   *  is currency1, the key has both. */
  | { kind: 'pool_init'; token: Address; key: V4PoolKey; poolId: Hex; tick: number }
  /** Liquidity added (delta > 0) or taken out of a position on the PoolManager. */
  | { kind: 'liquidity'; poolId: Hex; salt: Hex; delta: bigint }
);
export type PoolLaunchpad = 'pangea' | 'longxyz' | 'unbranded';

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
export function decodeRobinhoodLog(log: RawRobinhoodLog, addrs: Pick<RobinhoodAddresses, 'factory' | 'hook' | 'poolManager'> & Partial<Pick<RobinhoodAddresses, PoolLaunchAddress>>,
  curveToken?: (curve: Address) => Address | null, opts: DecodeOptions = {}): RobinhoodEvent | null {
  const t0 = log.topics[0];
  try {
    if (t0 === PANGEA_POOL_TOPIC) return decodePangeaLaunch(log, addrs);
    if (t0 === LONG_CREATE_TOPIC) return decodeLongCreate(log, addrs, opts);
    if (t0 === UNBRANDED_LAUNCH_TOPIC) return decodeUnbrandedLaunch(log, addrs);
    if (t0 === MODIFY_LIQUIDITY_TOPIC) {
      if (!same(log.address, addrs.poolManager) || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{256}$/.test(log.data)) return null;
      return { kind: 'liquidity', ...place(log), poolId: log.topics[1]!.toLowerCase() as Hex, salt: word(log.data, 3).toLowerCase() as Hex, delta: BigInt.asIntN(256, BigInt(word(log.data, 2))) };
    }
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
      // A token-quoted pool only with quoted pools followed, and only long.xyz's (its Doppler hook): nothing else is read.
      if (args.currency0 !== zeroAddress && !(opts.quotedPools && addrs.longHook && same(args.hooks, addrs.longHook))) return null;
      const key: V4PoolKey = { currency0: getAddress(args.currency0), currency1: getAddress(args.currency1), fee: args.fee, tickSpacing: args.tickSpacing, hooks: getAddress(args.hooks) };
      // The rebuilt key must hash to the logged id, as for every launchpad on Elysium (launchpads.ts).
      if (v4PoolId(key).toLowerCase() !== args.id.toLowerCase()) return null;
      if (!same(args.hooks, addrs.hook)) return { kind: 'pool_init', ...place(log), token: key.currency1, key, poolId: args.id.toLowerCase() as Hex, tick: args.tick };
      return { kind: 'graduated', ...place(log), token: key.currency1, key, poolId: args.id, manager: getAddress(log.address), sqrtPriceX96: args.sqrtPriceX96, tick: args.tick };
    }
  } catch { return null; }
  return null;
}

const MAX_TICK = 887_272;
const word = (data: Hex, i: number) => `0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}` as Hex;
const topicAddress = (topic: Hex | undefined) => topic && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? getAddress(`0x${topic.slice(26)}`) : null;

/**
 * A Pangea launch record (PANGEA_POOL_TOPIC), or null: from another contract, malformed, or a pool not keyed native ETH /
 * coin with Pangea's hook (its logged pool id must equal that key's id, so a token-quoted launch drops out).
 */
type PoolLaunchAddress = 'pangeaLauncher' | 'pangeaHook' | 'longAirlock' | 'longHook' | 'unbrandedLauncher';
function decodePangeaLaunch(log: RawRobinhoodLog, addrs: Partial<Pick<RobinhoodAddresses, PoolLaunchAddress>>): RobinhoodEvent | null {
  if (!addrs.pangeaLauncher || !addrs.pangeaHook || !same(log.address, addrs.pangeaLauncher)) return null;
  if (log.topics.length !== 4 || !/^0x[0-9a-fA-F]{256}$/.test(log.data)) return null;
  const token = topicAddress(log.topics[2]), creator = topicAddress(log.topics[3]);
  if (!token || !creator || token === zeroAddress) return null;
  const key = pangeaPoolKey(token, addrs.pangeaHook), poolId = word(log.data, 0);
  if (v4PoolId(key).toLowerCase() !== poolId.toLowerCase()) return null;
  const tick = BigInt.asIntN(256, BigInt(word(log.data, 2)));
  if (tick < -BigInt(MAX_TICK) || tick > BigInt(MAX_TICK)) return null;
  return { kind: 'pool_launch', launchpad: 'pangea', ...place(log), token, quote: zeroAddress, creator, launcher: getAddress(addrs.pangeaLauncher), key,
    poolId: poolId.toLowerCase() as Hex, openTick: Number(tick), launchPosition: null };
}

/**
 * A long.xyz launch (the Airlock's Create), or null: from another contract, malformed, or another initializer hook. Only a
 * native-ETH numeraire unless quoted pools are followed (937 launches in the 24 hours to block 117,565,292, 2 native; the
 * rest are quoted in stock tokens, WETH, USDG and other coins: the adapter keeps those it can price, price.ts). The key is
 * set by the pool's Initialize, logged earlier in the same transaction and applied after this record.
 */
function decodeLongCreate(log: RawRobinhoodLog, addrs: Partial<Pick<RobinhoodAddresses, PoolLaunchAddress>>, opts: DecodeOptions): RobinhoodEvent | null {
  if (!addrs.longAirlock || !addrs.longHook || !same(log.address, addrs.longAirlock)) return null;
  if (log.topics.length !== 2 || (log.topics[1] !== NATIVE_TOPIC && !opts.quotedPools)) return null;
  const quote = topicAddress(log.topics[1]);
  if (!quote) return null;
  const { args } = decodeEventLog({ abi: longCreateAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (!same(args.initializer, addrs.longHook) || args.asset === zeroAddress || same(args.asset, quote)) return null;
  const token = getAddress(args.asset);
  // The Create carries no creator, and launches arrive through bundlers and routers: no deployer is identified.
  return { kind: 'pool_launch', launchpad: 'longxyz', ...place(log), token, quote, creator: token, launcher: getAddress(addrs.longAirlock), key: null,
    poolId: NO_POOL_ID, openTick: null, launchPosition: null };
}

/**
 * An unbranded-launcher launch, or null: from another contract, malformed, or a key (native ETH / coin, the logged fee and
 * tick spacing, no hook) that does not hash to the logged pool id.
 */
function decodeUnbrandedLaunch(log: RawRobinhoodLog, addrs: Partial<Pick<RobinhoodAddresses, PoolLaunchAddress>>): RobinhoodEvent | null {
  if (!addrs.unbrandedLauncher || !same(log.address, addrs.unbrandedLauncher)) return null;
  if (log.topics.length !== 4 || !/^0x[0-9a-fA-F]{320}$/.test(log.data)) return null;
  const creator = topicAddress(log.topics[1]), token = topicAddress(log.topics[2]);
  if (!token || !creator || token === zeroAddress) return null;
  const fee = BigInt(word(log.data, 1)), tickSpacing = BigInt(word(log.data, 2));
  if (fee >= 1_000_000n || tickSpacing < 1n || tickSpacing > 32_767n) return null;
  const key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: zeroAddress };
  const poolId = log.topics[3]!.toLowerCase() as Hex;
  if (v4PoolId(key).toLowerCase() !== poolId) return null;
  return { kind: 'pool_launch', launchpad: 'unbranded', ...place(log), token, quote: zeroAddress, creator, launcher: getAddress(addrs.unbrandedLauncher), key, poolId,
    openTick: null, launchPosition: { owner: creator, salt: word(log.data, 0).toLowerCase() as Hex, seed: BigInt(word(log.data, 3)) } };
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
  launchpad: 'pons' | PoolLaunchpad;
  /** A Pons coin: null until graduation, then its Pons v4 pool's key. A pool-launched coin: its pool's key from launch
   *  (long.xyz: from its Initialize, in the launch transaction). */
  key: V4PoolKey | null;
  /** A Pons coin: NO_POOL_ID until graduation. A pool-launched coin: its pool's id. */
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

/** A quote token as the adapter prices it (price.ts QuotePrices.asset): ETH per whole unit, and how the API names it. */
export interface PricedQuote { symbol: string; decimals: number; kind: 'ETH' | 'USDG' | 'stock_token'; ethPer: number }
export interface ApplyOptions { addrs: Pick<RobinhoodAddresses, 'factory' | 'poolManager'> & Partial<Pick<RobinhoodAddresses, 'longHook'>>; ts?: number; maxTrades?: number;
  /** The price of a token-quoted launch's numeraire right now; without it (or with null) such a launch is not followed. */
  quote?: (token: Address) => PricedQuote | null }

/**
 * A swap in a token-quoted pool as the chart and volume read it: in ETH at the quote token's price when it is applied
 * (`ethPer`, ETH per whole quote unit), so the coin reads like a native pool's coin. Amounts are the swapper's deltas, as
 * for tradeFromSwap: a buy pays the quote in (negative) and takes the coin out. The coin's amounts stay in 18-decimal
 * units (CoinState.decimals scales displays only); the quote's own decimals are applied here.
 */
export function quotedSwapTrade(coinIsCurrency0: boolean, swap: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; sender: Address; tx: Hex; block: number; ts: number },
  quote: { decimals: number; ethPer: number }): Trade | null {
  const q = coinIsCurrency0 ? swap.amount1 : swap.amount0, c = coinIsCurrency0 ? swap.amount0 : swap.amount1;
  if (q === 0n || c === 0n || (q < 0n) === (c < 0n) || !(quote.ethPer > 0) || swap.sqrtPriceX96 <= 0n) return null;
  const abs = (v: bigint) => Number(v < 0n ? -v : v);
  const root = Number(swap.sqrtPriceX96) / 2 ** 96, token1Per0 = root * root;
  // Quote base units per coin base unit, then ETH per 1e18 coin base units.
  const quotePerCoin = coinIsCurrency0 ? token1Per0 : 1 / token1Per0;
  const priceHype = quotePerCoin * 10 ** (18 - quote.decimals) * quote.ethPer;
  if (!Number.isFinite(priceHype) || priceHype <= 0) return null;
  return { ts: swap.ts, block: swap.block, tx: swap.tx, sender: swap.sender, side: q < 0n ? 'buy' : 'sell',
    hype: abs(q) / 10 ** quote.decimals * quote.ethPer, tokens: abs(c) / 1e18, priceHype };
}

/**
 * Apply one event to a coin, without changing the one passed in: a launch builds a new coin (an existing one is returned
 * unchanged), a curve trade appends the trade and moves the curve's reserves, a graduation gives the coin its v4 key,
 * pool id and PoolManager. Returns undefined when the event concerns no coin it was given (a trade or graduation of a
 * coin launched before the window). `ts` is the block time; the log's own timestamp is used when it carried one.
 */
export function applyRobinhoodEvent(coin: RobinhoodCoinState | undefined, event: RobinhoodEvent, options: ApplyOptions): RobinhoodCoinState | undefined {
  const ts = event.ts ?? options.ts ?? 0;
  if (event.kind === 'pool_launch') {
    if (coin) return coin;
    // A token-quoted launch only while its numeraire is priced (price.ts): its trades are counted in ETH at that price.
    const priced = event.quote === zeroAddress ? null : options.quote?.(event.quote) ?? null;
    if (event.quote !== zeroAddress && !priced) return undefined;
    return {
      launchpad: event.launchpad, key: event.key, poolId: event.poolId, flipped: false,
      ...(priced ? { quoteConverted: { kind: priced.kind, symbol: priced.symbol, decimals: priced.decimals } } : {}),
      // The launch mints the whole supply; it is summed from that mint, which the tracker applies right after the launch
      // (launch records come first in a span), rather than assumed.
      supplyFromMints: true, supply: 0n,
      launcher: event.launcher, manager: getAddress(options.addrs.poolManager),
      token: event.token, creator: event.creator, quote: event.quote, configId: 0n,
      firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: event.creator, feeLocked: false,
      block: event.block, ts, tx: event.tx, trades: [], netHype: 0, sqrtPriceX96: null, graduated: false,
      // The price the creator opened at, shown (and the market cap measured) until the first swap.
      ...(event.openTick !== null ? { openPrice: openPriceAt(event.openTick, true) } : {}),
      ...(event.launchPosition ? { launchPosition: { ...event.launchPosition, liquidity: 0n, removed: 0n, removedTx: null } } : {}),
      name: null, symbol: null, flows: [],
    };
  }
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
  if (event.kind === 'pool_init') {
    // Only a coin a launch record announced, and only its own pool: long.xyz's key is set once, from its Doppler hook's
    // Initialize; every pool-launched coin takes its opening price from the Initialize while it has no trade. A
    // token-quoted coin's pool is keyed coin / quote in address order: the other currency must be its quote.
    if (coin.launchpad === 'pons') return coin;
    const coinIs0 = same(event.key.currency0, coin.token);
    if (!(coinIs0 ? same(event.key.currency1, coin.quote) : same(event.key.currency1, coin.token) && same(event.key.currency0, coin.quote))) return coin;
    const setKey = coin.launchpad === 'longxyz' && !coin.key && !!options.addrs.longHook && same(event.key.hooks, options.addrs.longHook);
    if (!setKey && event.poolId !== coin.poolId.toLowerCase()) return coin;
    let open: number | undefined;
    if (coin.quote === zeroAddress) open = openPriceAt(event.tick, true);
    else {
      // The tick is the quote per coin in base units (inverted when the coin is currency1), in ETH at today's quote price.
      const q = options.quote?.(coin.quote), raw = openPriceAt(event.tick, !coinIs0);
      if (q && Number.isFinite(raw) && raw > 0) open = raw * 10 ** (18 - q.decimals) * q.ethPer;
    }
    const openPrice = coin.openPrice ?? (coin.trades.length ? undefined : open);
    return { ...coin, ...(setKey ? { key: event.key, poolId: event.poolId, flipped: coinIs0 } : {}), ...(openPrice !== undefined ? { openPrice } : {}) };
  }
  if (event.kind === 'liquidity') {
    // Only the launch position the creator holds, in the coin's own pool.
    const p = coin.launchPosition;
    if (!p || event.poolId !== coin.poolId.toLowerCase() || event.salt !== p.salt.toLowerCase() || event.delta === 0n) return coin;
    return { ...coin, launchPosition: event.delta > 0n ? { ...p, liquidity: p.liquidity + event.delta }
      : { ...p, removed: p.removed - event.delta, removedTx: event.tx } };
  }
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
  // Graduation: the Pons hook's pool for this coin. Sticky; the first one counts. Never for a Pangea coin (it has no curve).
  if (coin.launchpad !== 'pons' || !same(event.token, coin.token) || coin.graduated) return coin;
  return { ...coin, key: event.key, poolId: event.poolId, manager: event.manager, flipped: false, graduated: true, graduatedTs: ts, sqrtPriceX96: event.sqrtPriceX96 };
}

/** Logs in chain order, launches first (a launch transaction logs its curve before TokenLaunched): the tracker's rule. */
export function orderRobinhoodLogs<L extends RawRobinhoodLog>(logs: readonly L[]): L[] {
  const order = (a: L, b: L) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex);
  return [...logs.filter(isRobinhoodLaunch).sort(order), ...logs.filter(l => !isRobinhoodLaunch(l)).sort(order)];
}
