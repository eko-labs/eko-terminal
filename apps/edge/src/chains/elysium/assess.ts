import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { runSellProbe, v4PoolId, type ElysiumRegistry, type SellProbe, type V4PoolKey } from '@eko/chain';
import { multicall, readTips, type MontraPoolConfig, type Probed } from '../../assess.js';
import type { CoinState, Rpc } from '../../tracker.js';
import type { JudgeFacts } from '../types.js';

export const montraReadAbi = parseAbi([
  'function poolKey(bytes32 poolId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function poolConfig(bytes32 poolId) view returns ((uint24 totalFeePips, uint24 lpFeePips, uint24 protocolFeePips, bool exists, bool quoteIsCurrency0, bool liquiditySealed, bool seeded, bool feeLocked, uint40 earlyBuyFeeUntil, int24 graduationTick, int24 lpLineTick, uint8 stage, uint32 lpCrossedAt, uint16 lpHeldSeconds, uint24 totalFeeMinPips, uint24 totalFeeMaxPips, address liquidityPolicy, int24 seedTickLower, int24 seedTickUpper, uint24 earlyBuyFeeStartPips, uint32 earlyBuyFeeWindow, uint128 seedLiquidity, address recipient))',
  'function currentBuyFeeRate(bytes32 poolId) view returns (uint256)',
]);
const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
/** The tax launchpad's verified hook: per-pool fee rates, RATE_SCALE 1e24 (quoteRate is the whole quote-side tax). */
export const taxHookAbi = parseAbi(['function effectiveFeeRates(bytes32 poolId, bool isBuy) view returns ((uint256 quoteRate, uint256 burnRate, uint256 protocolRate, uint256 creatorRate, uint256 dividendRate, uint256 integratorRate, uint256 surchargeRate) rate, bool exactOutputRestricted)']);
/** The tax launchpad's anti-snipe tax decays to the normal rate over 20 seconds (verified source); 30 leaves margin. */
export const TAX_LAUNCH_ANTI_SNIPE_SEC = 30;

/**
 * Contracts that hold or route a coin without being holders: the PoolManager, every launchpad hook, Montra's factory and
 * router, and the contract that launched this coin.
 */
export function excludedFor(registry: ElysiumRegistry, coin?: Pick<CoinState, 'launcher'>): Address[] {
  return [registry.address('uniswapV4.poolManager'), registry.address('montra.hook'), registry.address('montra.factory'), registry.address('montra.router'),
    registry.address('flaunchFork.hook'), registry.address('otherLaunchpads.taxLaunchHook'), registry.address('unbrandedLauncher.poolManager'),
    registry.address('unbrandedLauncher.hook'), ...(coin?.launcher ? [coin.launcher] : [])];
}

/**
 * The paid part of a check: name, pool key and Montra terms in one batched read, and the buy-then-sell probe for about
 * $1,000 of HYPE. Two eth_calls. Everything else (holders, early buyers, the deployer) is recomputed by `judge` from the
 * tracker's transfers whenever the coin trades, at no RPC cost.
 */
export async function probeCoin(coin: CoinState, block: bigint, deps: { rpc: Rpc; registry: ElysiumRegistry; hypeUsd: () => number | null; now?: () => number }, priorTips: Record<string, number> = {}): Promise<Probed> {
  const { rpc, registry } = deps, nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const hook = registry.address('montra.hook'), montra = coin.launchpad === 'montra';
  // Montra's terms (pool key, fees, early-buy window) come from its hook; other launchpads gave their key at launch.
  const results = await multicall(rpc, registry.address('multicall3'), [
    { target: coin.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'name' }) },
    { target: coin.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' }) },
    ...(montra ? [
      { target: hook, data: encodeFunctionData({ abi: montraReadAbi, functionName: 'poolKey', args: [coin.poolId] }) },
      { target: hook, data: encodeFunctionData({ abi: montraReadAbi, functionName: 'poolConfig', args: [coin.poolId] }) },
      { target: hook, data: encodeFunctionData({ abi: montraReadAbi, functionName: 'currentBuyFeeRate', args: [coin.poolId] }) },
    ] : coin.launchpad === 'taxlaunch' ? [true, false].map(isBuy => ({ target: registry.address('otherLaunchpads.taxLaunchHook'),
      data: encodeFunctionData({ abi: taxHookAbi, functionName: 'effectiveFeeRates', args: [coin.poolId, isBuy] }) }))
    // The unbranded hook's pools(bytes32) record (selector 0xb5217bb4; unverified, layout read from mainnet): words 9
    // and 10 are the buy and sell fee in pips.
    : coin.launchpad === 'unbranded' ? [{ target: registry.address('unbrandedLauncher.hook'), data: `0xb5217bb4${coin.poolId.slice(2)}` as Hex }] : []),
  ], block);
  const read = <T>(i: number, fn: (data: Hex) => T): T | null => { const r = results[i]; if (!r?.success) return null; try { return fn(r.returnData); } catch { return null; } };
  const name = read(0, d => decodeFunctionResult({ abi: erc20Abi, functionName: 'name', data: d })) ?? coin.name ?? '';
  const symbol = read(1, d => decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data: d })) ?? coin.symbol ?? '';
  const keyRaw = montra ? read(2, d => decodeFunctionResult({ abi: montraReadAbi, functionName: 'poolKey', args: [coin.poolId], data: d })) : null;
  const key: V4PoolKey | null = montra ? (keyRaw && v4PoolId(keyRaw).toLowerCase() === coin.poolId.toLowerCase() ? keyRaw : null) : coin.key;
  const cfgRaw = montra ? read(3, d => decodeFunctionResult({ abi: montraReadAbi, functionName: 'poolConfig', args: [coin.poolId], data: d })) : null;
  const config: MontraPoolConfig | null = cfgRaw ? { totalFeePips: cfgRaw.totalFeePips, lpFeePips: cfgRaw.lpFeePips, protocolFeePips: cfgRaw.protocolFeePips,
    liquiditySealed: cfgRaw.liquiditySealed, seeded: cfgRaw.seeded, feeLocked: cfgRaw.feeLocked, earlyBuyFeeUntil: Number(cfgRaw.earlyBuyFeeUntil), stage: cfgRaw.stage } : null;
  const currentBuyFeePips = montra ? read(4, d => Number(decodeFunctionResult({ abi: montraReadAbi, functionName: 'currentBuyFeeRate', args: [coin.poolId], data: d }))) : null;
  // The probe: about $1,000 of HYPE (10 HYPE while the price is unknown), only on a native-quoted pool whose key matches.
  // Launch pools are thin, so the round trip at $1k is the exit cost a real buyer faces (the radar's "Exit at $1k").
  const hypeUsd = deps.hypeUsd();
  const probeHype = hypeUsd ? 1000 / hypeUsd : 10;
  let probe: SellProbe | null = null;
  if (key && key.currency0 === '0x0000000000000000000000000000000000000000') {
    // The probe buys and sells through the coin's own PoolManager. Uniswap's quoter serves only a side estimate (in a
    // try/catch in the probe), so a fork PoolManager without a quoter still gets a real buy-then-sell.
    probe = await runSellProbe(rpc, { venue: 'uniswap_v4', coin: coin.token, poolId: coin.poolId, manager: coin.manager,
      quoter: registry.address('uniswapV4.v4Quoter'), key, hookData: '0x' }, BigInt(Math.round(probeHype * 1e6)) * 10n ** 12n, block);
  }

  const taxOf = (i: number) => read(i, d => { const [r] = decodeFunctionResult({ abi: taxHookAbi, functionName: 'effectiveFeeRates', data: d });
    return Number(r.quoteRate + r.burnRate + r.dividendRate + r.surchargeRate) / 1e22; });
  const unbrandedFee = () => read(2, d => {
    const w = (i: number) => Number(BigInt(`0x${d.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`));
    const buy = w(9), sell = w(10);
    // The hook's own bounds are 1% to 10% (MIN_FEE_PIPS, MAX_FEE_PIPS): anything else is a misread, not a fee.
    return buy >= 10_000 && buy <= 100_000 && sell >= 10_000 && sell <= 100_000 ? { buy: buy / 1e4, sell: sell / 1e4 } : null;
  });
  const taxPct = coin.launchpad === 'taxlaunch' ? (() => { const buy = taxOf(2), sell = taxOf(3); return buy === null || sell === null ? null : { buy, sell }; })()
    : coin.launchpad === 'unbranded' ? unbrandedFee() : undefined;
  const tips = await readTips(rpc, coin, priorTips);
  return { block: Number(block), at: new Date(nowSec * 1000).toISOString(), name, symbol, key, config, currentBuyFeePips, probe, probeUsd: hypeUsd ? 1000 : 0, tips,
    ...(taxPct !== undefined ? { taxPct } : {}) };
}

/** Elysium's part of a verdict: Montra's early-buy fee and the tax launchpad's anti-snipe tax, fees, locks and hooks. */
export function elysiumFacts(registry: ElysiumRegistry, coin: CoinState, p: Probed, nowSec: number): JudgeFacts {
  const { key, config, currentBuyFeePips } = p, hook = registry.address('montra.hook');
  const taxAntiSnipe = coin.launchpad === 'taxlaunch' && nowSec - coin.ts < TAX_LAUNCH_ANTI_SNIPE_SEC;
  const antiSnipeActive = (!!config && config.earlyBuyFeeUntil > nowSec && currentBuyFeePips !== null && currentBuyFeePips > config.totalFeePips) || taxAntiSnipe;
  const antiSnipe = taxAntiSnipe ? { taxPct: p.taxPct?.buy ?? 99, endsInSec: coin.ts + TAX_LAUNCH_ANTI_SNIPE_SEC - nowSec }
    : antiSnipeActive ? { taxPct: currentBuyFeePips! / 1e4, endsInSec: config!.earlyBuyFeeUntil - nowSec } : null;
  const isMontraHook = key?.hooks.toLowerCase() === hook.toLowerCase();
  // Pool fee: Montra's configured total; otherwise the key's static fee (0x800000 marks a dynamic fee the hook sets).
  const feeBps = config ? config.totalFeePips / 100 : key && key.fee !== 0x800000 ? key.fee / 100 : 0;
  // Where launch liquidity is known to be permanent: Montra (its docs), HyperForge (verified factory with no removal
  // path), the tax launchpad (verified hook reverts LiquidityLocked). The Flaunch fork's hook is unverified: no claim.
  // Montra seeds the whole supply as one position owned by its hook, which has no function that removes liquidity
  // (montramarkets.xyz/docs: "Taken out: Never"). `liquiditySealed` is a separate stage flag, not removability.
  const liquidity = coin.launchpad === 'montra' ? (config ? { owner: hook, status: isMontraHook ? 'locked' as const : 'removable' as const, label: 'Montra hook holds the launch liquidity' } : null)
    : coin.launchpad === 'hyperforge' ? { owner: coin.launcher, status: 'locked' as const, label: 'HyperForge factory holds the launch liquidity (verified: no removal path)' }
    : coin.launchpad === 'taxlaunch' && key ? { owner: key.hooks, status: 'locked' as const, label: 'Tax launchpad hook holds the liquidity (verified: removal reverts)' } : null;
  const label = isMontraHook ? 'Montra hook (registry-listed)' : coin.launchpad === 'flaunch' ? 'Flaunch-fork hook (unverified source)' : coin.launchpad === 'taxlaunch' ? 'Tax launchpad hook (verified source)'
    : coin.launchpad === 'unbranded' ? 'Unbranded launcher hook (unverified source; takes a fee on every trade)' : 'v4 hook';
  return { antiSnipeActive, antiSnipe, feeBps, liquidity, hook: {
    // TODO(review): Montra's registry-listed hook and the tax launchpad's verified hook take their documented fee or tax
    // through return deltas. They are treated as reviewed so their permission bits alone do not flag every coin; the
    // measured tax (tax_trap) and a sell fee above the buy fee (asymmetry) still do. Awaiting a human sign-off.
    label, reviewed: isMontraHook || coin.launchpad === 'taxlaunch', sourceVerified: coin.launchpad === 'taxlaunch',
    buyFeePct: p.taxPct ? p.taxPct.buy : currentBuyFeePips !== null ? currentBuyFeePips / 1e4 : null, sellFeePct: p.taxPct ? p.taxPct.sell : config ? config.totalFeePips / 1e4 : null } };
}
