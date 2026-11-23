import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { ponsCurveAbi, readPonsProfile, runSellProbe, v4PoolId, type PonsProfileClient, type SellPair, type SellProbe, type SellRoute } from '@eko/chain';
import { readTips, type Probed } from '../../assess.js';
import type { CoinState, Rpc } from '../../tracker.js';
import type { RobinhoodAddresses } from './addresses.js';
import type { RobinhoodCoinState } from './events.js';
import { PONS_LOCK } from './profile.js';

const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
/**
 * The deployed curve's getters beyond the verified event ABI: reserves and graduation flags as the old server read them
 * (EKO-RH apps/server/src/exec/pons-routes.ts), and the launch's anti-snipe snapshot (selectors in the old research notes,
 * docs/guard/research/pons-executable-notes.md: a 99% buy tax decaying to zero over 3 seconds from launchedAt).
 */
export const ponsCurveReadAbi = parseAbi([
  'function realQuoteReserve() view returns (uint256)', 'function sellableTokens() view returns (uint256)',
  'function graduated() view returns (bool)', 'function readyToGraduate() view returns (bool)',
  'function token() view returns (address)', 'function pairToken() view returns (address)', 'function factory() view returns (address)',
  'function launchedAt() view returns (uint256)', 'function snipeTaxSeconds() view returns (uint256)',
]);
/** The Pons factory, locker and Uniswap PositionManager reads of the lock proof (EKO-RH apps/server/src/exec/pons-graduation.ts). */
const factoryAbi = parseAbi(['function locker() view returns (address)', 'function positionManager() view returns (address)', 'function memeHook() view returns (address)']);
const lockerAbi = parseAbi(['function lockedPositions(address token) view returns (uint256)']);
const posmAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'function getApproved(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)', 'function poolManager() view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)']);
const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
/** v4's PoolManager keeps pools in a mapping at slot 6; a pool's slot0 is the first word of its state and its in-range
 *  liquidity the fourth (v4-core StateLibrary). */
const POOLS_SLOT = 6n, LIQUIDITY_OFFSET = 3n;
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const at = (block: bigint) => `0x${block.toString(16)}`;

/** One aggregate3 eth_call; each result is decoded by its own reader, a failed or malformed one is null. */
async function batch(rpc: Rpc, multicall3: Address, block: bigint, calls: { target: Address; data: Hex }[]) {
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls.map(c => ({ target: c.target, allowFailure: true, callData: c.data }))] });
  const out = await rpc.request({ method: 'eth_call', params: [{ to: multicall3, data }, at(block)] }) as Hex;
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: out });
  return <T>(i: number, read: (data: Hex) => T): T | null => { const r = results[i]; if (!r?.success) return null; try { return read(r.returnData); } catch { return null; } };
}

/** A Pons curve's terms and state at the probe block. Percentages are of the trade's quote leg. */
export interface PonsTerms {
  curve: Address; feePct: number; creatorTaxPct: number;
  /** The launch's buy tax right now (99% in the launch second, zero after about 3 s). */
  antiSnipe: { taxPct: number; endsInSec: number } | null;
  /** keccak256 of the token's runtime code (every Pons token so far is one 3,248-byte template). */
  tokenCodeHash: Hex;
  realQuoteReserve: bigint; realTokenReserve: bigint; graduated: boolean; readyToGraduate: boolean;
}
/** Whether a graduated coin's pool liquidity is provably locked at the block: the old server's proof, unchanged. */
export interface PonsLockFacts { locked: boolean; tokenId: bigint; liquidity: bigint; locker: Address | null }
/** Probed (assess.ts), plus what the Pons curve and the graduation lock say. */
export interface RobinhoodProbed extends Probed { pons: PonsTerms | null; lock: PonsLockFacts | null }

export interface RobinhoodProbeDeps {
  rpc: Rpc; addrs: RobinhoodAddresses;
  /** ETH in USD (price.ts), null while unknown. */
  ethUsd: () => number | null;
  now?: () => number;
  /** Reviewed code hashes of the locker and PositionManager (tests pass their own). */
  pins?: { locker: Hex; positionManager: Hex };
  /** A pool quoted in a token (long.xyz in a stock token, WETH or USDG; more_launchpads): the token, where it keeps
   *  balances, and the probe's size in its base units (about $1,000), or null while either is unknown. */
  quoteProbe?: (coin: RobinhoodCoinState) => Promise<{ pair: SellPair; amount: bigint } | null>;
}
/** The probe without a price: 0.25 ETH (about $450 in November 2026). */
export const FALLBACK_PROBE_WEI = 25n * 10n ** 16n;

/**
 * The paid part of a Robinhood check, the same shape as `probeCoin` (assess.ts) so `judge` can take it: name and symbol,
 * the curve's terms through readPonsProfile before graduation, the lock proof after it, and the buy-then-sell probe for
 * about $1,000 of ETH: the `pons_curve` route on the curve, then `uniswap_v4` on the Pons hook's pool. The public RPC
 * keeps state for only about 6,000 blocks, so `block` must be recent. Deep simulation stays off, as on Elysium.
 */
export async function probeRobinhoodCoin(coin: RobinhoodCoinState, block: bigint, deps: RobinhoodProbeDeps, priorTips: Record<string, number> = {}): Promise<RobinhoodProbed> {
  const { rpc, addrs } = deps, nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const curve = coin.curve && !coin.graduated ? coin.curve.address : null;
  // A Pons coin's pool from graduation; a pool-launched coin's (Pangea, long.xyz, unbranded) from launch: it has no curve.
  const key = (coin.graduated || coin.launchpad !== 'pons') && coin.key && v4PoolId(coin.key).toLowerCase() === coin.poolId.toLowerCase() ? coin.key : null;
  const enc = (target: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    ({ target, data: encodeFunctionData({ abi, functionName, args } as unknown as Parameters<typeof encodeFunctionData>[0]) });
  const curveCalls = curve ? [
    enc(curve, ponsCurveAbi, 'creatorTaxBps'), enc(curve, ponsCurveAbi, 'feeBps'), enc(curve, ponsCurveAbi, 'currentSnipeTaxBps', [coin.token]),
    ...(['realQuoteReserve', 'sellableTokens', 'graduated', 'readyToGraduate', 'token', 'pairToken', 'factory', 'launchedAt', 'snipeTaxSeconds'] as const)
      .map(fn => enc(curve, ponsCurveReadAbi, fn)),
  ] : [];
  // The lock proof is Pons' (its launch locker); other launchpads' positions are not in it.
  const lockCalls = key && coin.launchpad === 'pons' ? [enc(addrs.factory, factoryAbi, 'locker'), enc(addrs.factory, factoryAbi, 'positionManager'), enc(addrs.factory, factoryAbi, 'memeHook'),
    enc(PONS_LOCK.locker, lockerAbi, 'lockedPositions', [coin.token]), enc(PONS_LOCK.positionManager, posmAbi, 'poolManager')] : [];
  // A graduate's pool state: its price (slot0) and in-range liquidity, read from the PoolManager's storage.
  const state = key && coin.launchpad === 'pons' ? BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [coin.poolId as Hex, POOLS_SLOT]))) : null;
  const poolCalls = state !== null ? [state, state + LIQUIDITY_OFFSET].map(slot => enc(addrs.poolManager, managerAbi, 'extsload', [toHex(slot, { size: 32 })])) : [];
  const read = await batch(rpc, addrs.multicall3, block, [enc(coin.token, erc20Abi, 'name'), enc(coin.token, erc20Abi, 'symbol'), ...curveCalls, ...lockCalls, ...poolCalls]);
  const name = read(0, d => decodeFunctionResult({ abi: erc20Abi, functionName: 'name', data: d })) ?? coin.name ?? '';
  const symbol = read(1, d => decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data: d })) ?? coin.symbol ?? '';
  const uint = (i: number) => read(i, d => BigInt(d.slice(0, 66)));
  const addr = (i: number) => read(i, d => getAddress(`0x${d.slice(26, 66)}`));
  const bool = (i: number) => read(i, d => BigInt(d.slice(0, 66)) !== 0n);

  let pons: PonsTerms | null = null;
  if (curve) {
    const c = 2;
    const [creator, fee, snipe, realQuote, sellable, graduated, ready] = [uint(c), uint(c + 1), uint(c + 2), uint(c + 3), uint(c + 4), bool(c + 5), bool(c + 6)];
    const [token, pair, factory, launchedAt, snipeSec] = [addr(c + 7), addr(c + 8), addr(c + 9), uint(c + 10), uint(c + 11)];
    // The curve must be this coin's native-ETH curve from the registry's factory, or nothing it says is used.
    const own = same(token, coin.token) && same(factory, addrs.factory) && pair === zeroAddress;
    if (own && realQuote !== null && sellable !== null && graduated !== null && ready !== null) {
      // readPonsProfile checks the getters' range and that the token has code; its getters come from the batch above.
      const client: PonsProfileClient = {
        readContract: () => Promise.reject(new Error('Pons getters come from the batch')),
        readGetters: () => creator === null || fee === null || snipe === null ? Promise.reject(new Error('Pons getter failed')) : Promise.resolve([creator, fee, snipe] as const),
        getCode: async ({ address, blockNumber }) => await rpc.request({ method: 'eth_getCode', params: [address, at(blockNumber)] }) as Hex,
      };
      try {
        const profile = await readPonsProfile(client, coin.token, curve, block);
        const endsAt = launchedAt !== null && snipeSec !== null ? Number(launchedAt + snipeSec) : null;
        pons = { curve, feePct: profile.feePct, creatorTaxPct: profile.creatorTaxPct, tokenCodeHash: keccak256(profile.code),
          antiSnipe: profile.antiSnipeActive ? { taxPct: Number(snipe) / 100, endsInSec: endsAt === null ? 0 : Math.max(0, endsAt - nowSec) } : null,
          realQuoteReserve: realQuote, realTokenReserve: sellable, graduated, readyToGraduate: ready };
      } catch { /* invalid terms or a token without code: no Pons facts, and no probe below */ }
    }
  }

  let lock: PonsLockFacts | null = null;
  if (key && lockCalls.length) {
    const l = 2 + curveCalls.length;
    lock = await readLock(rpc, addrs, coin, key, block, { locker: addr(l), positionManager: addr(l + 1), hook: addr(l + 2), tokenId: uint(l + 3), manager: addr(l + 4) },
      deps.pins ?? { locker: PONS_LOCK.lockerCodeHash, positionManager: PONS_LOCK.positionManagerCodeHash }).catch(() => null);
  }

  // What backs a graduate's price: the ETH side of its pool at the pool's own price. Graduation puts one full-range
  // position in the pool, which holds L / sqrtP of currency0 (ETH) and L * sqrtP of the coin; the locked position's
  // liquidity is counted once the lock is proven (what nobody can take out), else the pool's in-range liquidity.
  let poolReserve: Probed['poolReserve'];
  if (poolCalls.length) {
    const p0 = 2 + curveCalls.length + lockCalls.length;
    const slot0 = read(p0, d => BigInt(d)), inRange = read(p0 + 1, d => BigInt(d) & ((1n << 128n) - 1n));
    const sqrtPriceX96 = slot0 === null ? 0n : slot0 & ((1n << 160n) - 1n);
    const liquidity = lock?.locked && lock.liquidity > 0n ? lock.liquidity : inRange;
    if (sqrtPriceX96 > 0n && liquidity !== null) poolReserve = ponsPoolReserve(sqrtPriceX96, liquidity);
  }

  // The probe: about $1,000 of ETH. On the curve only while it trades (a graduated or ready curve is closed for sells
  // and the pool takes over); on the pool only with a key that hashes to the coin's pool id. A Pangea pool takes the
  // same v4 route with empty hookData (its swaps through the Universal Router pass none; the probe sold on all five
  // pools tried, 2026-11-18).
  const ethUsd = deps.ethUsd();
  const sizeWei = ethUsd ? BigInt(Math.round(1000 / ethUsd * 1e6)) * 10n ** 12n : FALLBACK_PROBE_WEI;
  // A pool quoted in a token (long.xyz's stock-token, WETH and USDG pools) is probed with about $1,000 of that token, held
  // through a storage override of its balance; while its price or balance slot is unknown its sell check is named
  // missing rather than read as a failed sell.
  const tokenQuoted = !!key && key.currency0 !== zeroAddress && !!coin.quoteConverted;
  const quoted = tokenQuoted && deps.quoteProbe ? await deps.quoteProbe(coin).catch(() => null) : null;
  const route: SellRoute | null = pons && !pons.graduated && !pons.readyToGraduate ? { venue: 'pons_curve', coin: coin.token, curve: pons.curve }
    : key && key.currency0 === zeroAddress ? { venue: 'uniswap_v4', coin: coin.token, poolId: coin.poolId, manager: coin.manager, quoter: addrs.v4Quoter, key, hookData: '0x' }
    : key && quoted ? { venue: 'uniswap_v4', coin: coin.token, poolId: coin.poolId, manager: coin.manager, quoter: addrs.v4Quoter, key, hookData: '0x', quote: quoted.pair } : null;
  const probe: SellProbe | null = route ? await runSellProbe(rpc, route, quoted && route.venue === 'uniswap_v4' && route.quote ? quoted.amount : sizeWei, block) : null;

  // Fee and creator tax are charged on both legs of a curve trade; after graduation the pool's terms are the hook's.
  const taxPct = pons ? { buy: pons.feePct + pons.creatorTaxPct, sell: pons.feePct + pons.creatorTaxPct } : undefined;
  // readTips reads only the coin's launch, trades and transaction fields, which a Robinhood coin has as on Elysium.
  const tips = await readTips(rpc, coin as unknown as CoinState, priorTips);
  // A pool quoted in a token the chain converts (more_launchpads only) can never take the probe: named, not waited for.
  // Pons and Pangea coins, quoted in native ETH, never carry quoteConverted.
  const unavailable = !route && coin.quoteConverted && key && key.currency0 !== zeroAddress ? { sellCheckUnavailable: 'token_quoted_pool' as const } : {};
  return { block: Number(block), at: new Date(nowSec * 1000).toISOString(), name, symbol, key, config: null, currentBuyFeePips: null, probe,
    probeUsd: ethUsd ? 1000 : 0, tips, ...(taxPct ? { taxPct } : {}), pons, lock, ...(poolReserve ? { poolReserve } : {}), ...unavailable };
}

/**
 * A Pons pool (native ETH currency0, the coin currency1) at `sqrtPriceX96` with full-range `liquidity`: the ETH it holds
 * (L / sqrtP, in whole ETH; the full range's upper bound adds nothing measurable) and ETH per 1e18 base units of the
 * coin (1 / sqrtP²).
 */
export function ponsPoolReserve(sqrtPriceX96: bigint, liquidity: bigint): { native: number; price: number } {
  const native = Number((liquidity << 96n) / sqrtPriceX96) / 1e18, sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  return { native, price: 1 / (sqrtP * sqrtP) };
}

/**
 * The lock proof for a graduated coin at the block: the factory's hook, locker and PositionManager are the reviewed ones
 * (registry hook; code hashes pinned), the PositionManager serves this PoolManager, and the locker owns, with no
 * approval, a live position on exactly this pool. Any failed check is `locked: false`; provider failures reject.
 */
async function readLock(rpc: Rpc, addrs: RobinhoodAddresses, coin: RobinhoodCoinState, key: NonNullable<RobinhoodCoinState['key']>, block: bigint,
  f: { locker: Address | null; positionManager: Address | null; hook: Address | null; tokenId: bigint | null; manager: Address | null },
  pins: { locker: Hex; positionManager: Hex }): Promise<PonsLockFacts> {
  const none: PonsLockFacts = { locked: false, tokenId: 0n, liquidity: 0n, locker: null };
  if (!same(key.hooks, addrs.hook) || key.currency0 !== zeroAddress || !same(key.currency1, coin.token)) return none;
  // The batch read the pinned locker and PositionManager; the factory must still name exactly those.
  if (!same(f.hook, addrs.hook) || !same(f.locker, PONS_LOCK.locker) || !same(f.positionManager, PONS_LOCK.positionManager) || !same(f.manager, addrs.poolManager) || !f.tokenId) return none;
  const tokenId = f.tokenId;
  const [lockerCode, posmCode, read] = await Promise.all([
    rpc.request({ method: 'eth_getCode', params: [PONS_LOCK.locker, at(block)] }) as Promise<Hex>,
    rpc.request({ method: 'eth_getCode', params: [PONS_LOCK.positionManager, at(block)] }) as Promise<Hex>,
    batch(rpc, addrs.multicall3, block, (['ownerOf', 'getApproved', 'getPositionLiquidity', 'getPoolAndPositionInfo'] as const)
      .map(fn => ({ target: PONS_LOCK.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: fn, args: [tokenId] }) as Hex }))),
  ]);
  if (keccak256(lockerCode ?? '0x') !== pins.locker || keccak256(posmCode ?? '0x') !== pins.positionManager) return { ...none, tokenId };
  const owner = read(0, d => decodeFunctionResult({ abi: posmAbi, functionName: 'ownerOf', data: d }));
  const approved = read(1, d => decodeFunctionResult({ abi: posmAbi, functionName: 'getApproved', data: d }));
  const liquidity = read(2, d => decodeFunctionResult({ abi: posmAbi, functionName: 'getPositionLiquidity', data: d })) ?? 0n;
  const info = read(3, d => decodeFunctionResult({ abi: posmAbi, functionName: 'getPoolAndPositionInfo', data: d }));
  const locked = same(owner, PONS_LOCK.locker) && approved === zeroAddress && liquidity > 0n && !!info && same(v4PoolId(info[0]), coin.poolId);
  return { locked, tokenId, liquidity, locker: PONS_LOCK.locker };
}

/**
 * Contracts that hold or route a Robinhood coin without being holders: its curve (the whole unsold supply before
 * graduation), the Pons factory, router and hook, the PoolManager (the pool's tokens after it), the Pons locker, and
 * Pangea's launcher, liquidity manager and hook, long.xyz's Airlock and hook, and the unbranded launcher.
 */
export function robinhoodExcluded(coin: Pick<RobinhoodCoinState, 'curve'> | undefined, addrs: RobinhoodAddresses): Address[] {
  return [...(coin?.curve ? [coin.curve.address] : []), addrs.factory, addrs.router, addrs.hook, addrs.poolManager, PONS_LOCK.locker,
    // Pangea's launcher and liquidity manager pass the whole supply through at launch; its hook can hold fees.
    addrs.pangeaLauncher, addrs.pangeaLiquidityManager, addrs.pangeaHook, addrs.longAirlock, addrs.longHook, addrs.unbrandedLauncher];
}
