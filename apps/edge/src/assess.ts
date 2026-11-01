import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { runSellProbe, v4PoolId, type ElysiumRegistry, type SellProbe, type V4PoolKey } from '@eko/chain';
import { assembleVerdict, CONFIG_V1, evaluatePlaybooks, type CardSources, type HistoryView, type PlaybookConfig, type Simulation } from '@eko/playbooks';
import type { PlaybookMatch, Verdict } from '@eko/shared';
import type { CoinState, Rpc } from './tracker.js';
import { flowStats, type FlowStats, type FunderLookup } from './holders.js';
import { findSnipers, SNIPER_BLOCKS } from './snipers.js';

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
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);

/**
 * The playbook settings used on Elysium: version 1, except that a single eth_call probe can reach Danger on its own.
 * EKO's Robinhood setting waits for a deeper simulation from a plain wallet, which needs debug_trace; Elysium's public
 * RPC has none. Montra tokens are factory clones with no transfer code of their own, so a contract probe that cannot
 * sell is not a probe artefact. Revisit once a traced deep simulation is available.
 */
export const ELYSIUM_PLAYBOOK_CONFIG: PlaybookConfig = { ...CONFIG_V1, honeypot: { minLossPct: 95, requireDeepSim: false } };

export interface MontraPoolConfig {
  totalFeePips: number; lpFeePips: number; protocolFeePips: number; liquiditySealed: boolean; seeded: boolean; feeLocked: boolean;
  earlyBuyFeeUntil: number; stage: number;
}
export interface Assessment {
  coin: Address; block: number; at: string; name: string; symbol: string;
  key: V4PoolKey | null; config: MontraPoolConfig | null; currentBuyFeePips: number | null;
  antiSnipe: { taxPct: number; endsInSec: number } | null;
  /** Tax launchpad coins: the hook's current buy and sell tax (%). */
  taxPct?: { buy: number; sell: number } | null;
  probe: SellProbe | null; probeUsd: number;
  /** Holders, early buyers and the deployer's trading, from the coin's transfers. */
  stats: FlowStats;
  matches: PlaybookMatch[]; verdict: Verdict;
}

/**
 * Contracts that hold or route a coin without being holders: the PoolManager, every launchpad hook, Montra's factory and
 * router, and the contract that launched this coin.
 */
export function excludedFor(registry: ElysiumRegistry, coin?: Pick<CoinState, 'launcher'>): Address[] {
  return [registry.address('uniswapV4.poolManager'), registry.address('montra.hook'), registry.address('montra.factory'), registry.address('montra.router'),
    registry.address('flaunchFork.hook'), registry.address('otherLaunchpads.taxLaunchHook'), registry.address('unbrandedLauncher.poolManager'),
    registry.address('unbrandedLauncher.hook'), ...(coin?.launcher ? [coin.launcher] : [])];
}

/** The permission bits of a v4 hook are the low 14 bits of its address; the four return-delta bits are the lowest. */
export function hookBits(hook: Address) { const v = Number(BigInt(hook) & 0x3fffn); return { permissionBits: v, returnDeltaPermissionBits: v & 0xf }; }

async function multicall(rpc: Rpc, multicall3: Address, calls: { target: Address; data: Hex }[], block: bigint | 'latest') {
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls.map(c => ({ target: c.target, allowFailure: true, callData: c.data }))] });
  const out = await rpc.request({ method: 'eth_call', params: [{ to: multicall3, data }, block === 'latest' ? block : `0x${block.toString(16)}`] }) as Hex;
  return decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: out });
}

/** name() and symbol() for many tokens in one aggregate3 call; a failed read is an empty string. */
export async function readNames(rpc: Rpc, multicall3: Address, tokens: Address[], block: bigint | 'latest'): Promise<{ name: string; symbol: string }[]> {
  const results = await multicall(rpc, multicall3, tokens.flatMap(t => [
    { target: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'name' }) },
    { target: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' }) },
  ]), block);
  const text = (i: number, fn: 'name' | 'symbol') => { const r = results[i]; if (!r?.success) return ''; try { return decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: r.returnData }); } catch { return ''; } };
  return tokens.map((_, i) => ({ name: text(2 * i, 'name'), symbol: text(2 * i + 1, 'symbol') }));
}

export interface AssessDeps { rpc: Rpc; registry: ElysiumRegistry; hypeUsd: () => number | null; now?: () => number }

/** What the chain says about a coin at one block: the two eth_calls of a check, cached between checks. */
export interface Probed {
  block: number; at: string; name: string; symbol: string; key: V4PoolKey | null; config: MontraPoolConfig | null;
  currentBuyFeePips: number | null; probe: SellProbe | null; probeUsd: number;
  /** Priority fee (gwei) of each early buy transaction, for the launch-sniper evidence. */
  tips: Record<string, number>;
  /** Tax launchpad and unbranded-launcher coins: the hook's current buy and sell tax or fee (%). */
  taxPct?: { buy: number; sell: number } | null;
}

/**
 * The paid part of a check: name, pool key and Montra terms in one batched read, and the buy-then-sell probe for about
 * $1,000 of HYPE. Two eth_calls. Everything else (holders, early buyers, the deployer) is recomputed by `judge` from the
 * tracker's transfers whenever the coin trades, at no RPC cost.
 */
export async function probeCoin(coin: CoinState, block: bigint, deps: AssessDeps, priorTips: Record<string, number> = {}): Promise<Probed> {
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

/**
 * Priority fees of the coin's early buys (first SNIPER_BLOCKS blocks, launch transaction excluded): one receipt per
 * transaction and one header per block, at most `cap` new transactions per check; fees already read are kept.
 */
export async function readTips(rpc: Rpc, coin: CoinState, prior: Record<string, number>, cap = 6): Promise<Record<string, number>> {
  const tips = { ...prior }, baseFees = new Map<string, bigint>();
  const todo = [...new Set(coin.trades.filter(t => t.side === 'buy' && t.block - coin.block <= SNIPER_BLOCKS && t.tx.toLowerCase() !== coin.tx.toLowerCase())
    .map(t => t.tx.toLowerCase()))].filter(tx => !(tx in tips)).slice(0, cap);
  for (const tx of todo) {
    try {
      const r = await rpc.request({ method: 'eth_getTransactionReceipt', params: [tx] }) as { blockNumber: Hex; effectiveGasPrice: Hex } | null;
      if (!r) continue;
      let base = baseFees.get(r.blockNumber);
      if (base === undefined) {
        const b = await rpc.request({ method: 'eth_getBlockByNumber', params: [r.blockNumber, false] }) as { baseFeePerGas?: Hex } | null;
        base = b?.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n; baseFees.set(r.blockNumber, base);
      }
      const tip = BigInt(r.effectiveGasPrice) - base;
      tips[tx] = Number(tip > 0n ? tip : 0n) / 1e9;
    } catch { /* evidence only: a missing fee leaves the sniper without one */ }
  }
  return tips;
}

/**
 * The verdict for a coin now: the cached probe plus holders, early buyers and the deployer's trading from the coin's
 * transfers. Pure. A probe that could not run, or Montra's early-buy window, leaves it pending: pending is never Clear.
 */
export interface JudgeContext {
  registry: ElysiumRegistry; hypeUsd: number | null; nowSec: number; head: number;
  /** The deployer's (and its crew's) earlier launches from the history store; none without one. */
  history?: HistoryView;
  /** Traced funders of early buyers (bundles); each wallet is its own funder without one. */
  funders?: FunderLookup;
}
export function judge(coin: CoinState, p: Probed, ctx: JudgeContext): Assessment {
  const { registry, nowSec } = ctx, { key, config, currentBuyFeePips, probe, name, symbol } = p;
  const hook = registry.address('montra.hook');
  const taxAntiSnipe = coin.launchpad === 'taxlaunch' && nowSec - coin.ts < TAX_LAUNCH_ANTI_SNIPE_SEC;
  const antiSnipeActive = (!!config && config.earlyBuyFeeUntil > nowSec && currentBuyFeePips !== null && currentBuyFeePips > config.totalFeePips) || taxAntiSnipe;
  const antiSnipe = taxAntiSnipe ? { taxPct: p.taxPct?.buy ?? 99, endsInSec: coin.ts + TAX_LAUNCH_ANTI_SNIPE_SEC - nowSec }
    : antiSnipeActive ? { taxPct: currentBuyFeePips! / 1e4, endsInSec: config!.earlyBuyFeeUntil - nowSec } : null;
  const hypeUsd = ctx.hypeUsd;
  const asOfBlock = Math.max(ctx.head, p.block);
  const isMontraHook = key?.hooks.toLowerCase() === hook.toLowerCase();
  const simulations: Simulation[] = probe && probe.status !== 'unavailable' ? [{
    id: `${probe.routeId}@${probe.block}`, sizeUsd: 1000, block: p.block, buyOk: probe.status !== 'buy_failed', sellOk: probe.status === 'sellable',
    returnedInputShare: probe.spentWei && probe.returnedWei && BigInt(probe.spentWei) > 0n ? Number(BigInt(probe.returnedWei) * 10000n / BigInt(probe.spentWei)) / 10000 : 0,
    traceDigest: keccak256(stringToHex(JSON.stringify({ routeId: probe.routeId, block: probe.block, status: probe.status, reason: probe.reason }))),
    ...(probe.reason === 'sell_reverted' && probe.revert ? { revert: probe.revert } : {}),
  }] : [];
  // Pool fee: Montra's configured total; otherwise the key's static fee (0x800000 marks a dynamic fee the hook sets).
  const feeBps = config ? config.totalFeePips / 100 : key && key.fee !== 0x800000 ? key.fee / 100 : 0;
  const excluded = excludedFor(registry, coin);
  const stats = flowStats(coin, { excluded, hypeUsd, ...(ctx.funders ? { funders: ctx.funders } : {}) });
  const hasHook = !!key && key.hooks !== '0x0000000000000000000000000000000000000000';
  // Where launch liquidity is known to be permanent: Montra (its docs), HyperForge (verified factory with no removal
  // path), the tax launchpad (verified hook reverts LiquidityLocked). The Flaunch fork's hook is unverified: no claim.
  const locked = coin.launchpad === 'montra' ? (config ? { owner: hook, status: isMontraHook ? 'locked' as const : 'removable' as const, label: 'Montra hook holds the launch liquidity' } : null)
    : coin.launchpad === 'hyperforge' ? { owner: coin.launcher, status: 'locked' as const, label: 'HyperForge factory holds the launch liquidity (verified: no removal path)' }
    : coin.launchpad === 'taxlaunch' && key ? { owner: key.hooks, status: 'locked' as const, label: 'Tax launchpad hook holds the liquidity (verified: removal reverts)' } : null;
  const hookLabel = isMontraHook ? 'Montra hook (registry-listed)' : coin.launchpad === 'flaunch' ? 'Flaunch-fork hook (unverified source)' : coin.launchpad === 'taxlaunch' ? 'Tax launchpad hook (verified source)'
    : coin.launchpad === 'unbranded' ? 'Unbranded launcher hook (unverified source; takes a fee on every trade)' : 'v4 hook';
  const sources: CardSources = {
    holders: stats.holders, earlyBuyers: stats.earlyBuyers, dev: stats.dev,
    coin: coin.token, deployer: coin.creator, asOfBlock, asOfSec: nowSec, createdAtSec: coin.ts, createdAtBlock: coin.block,
    launchpad: coin.launchpad, name, symbol, antiSnipeActive, simulations,
    ...(p.taxPct ? { taxes: { buyPct: p.taxPct.buy, sellPct: p.taxPct.sell, mutable: null, changes: [] } } : {}),
    // Montra seeds the whole supply as one position owned by its hook, which has no function that removes liquidity
    // (montramarkets.xyz/docs: "Taken out: Never"). `liquiditySealed` is a separate stage flag, not removability.
    ...(locked ? { liquidity: { positions: [{ owner: locked.owner, controlledBy: 'other' as const, share: 1, status: locked.status,
      evidence: [{ kind: 'address' as const, ref: locked.owner, label: locked.label }] }], priorRemovals: [] } } : {}),
    ...(key ? { pools: [{ id: coin.poolId, feeBps, liquidityShare: 1, deepest: true, defaultRoute: true, evidence: [] }] } : {}),
    ...(key && hasHook ? { hook: {
      address: key.hooks, ...hookBits(key.hooks),
      // TODO(review): Montra's registry-listed hook and the tax launchpad's verified hook take their documented fee or tax
      // through return deltas. They are treated as reviewed so their permission bits alone do not flag every coin; the
      // measured tax (tax_trap) and a sell fee above the buy fee (asymmetry) still do. Awaiting a human sign-off.
      reviewed: isMontraHook || coin.launchpad === 'taxlaunch', sourceVerified: coin.launchpad === 'taxlaunch', quoteSimGapPct: null,
      buyFeePct: p.taxPct ? p.taxPct.buy : currentBuyFeePips !== null ? currentBuyFeePips / 1e4 : null, sellFeePct: p.taxPct ? p.taxPct.sell : config ? config.totalFeePips / 1e4 : null,
      evidence: [{ kind: 'address' as const, ref: key.hooks, label: hookLabel }] } } : {}),
  };
  const snipers = findSnipers(coin, excluded, p.tips);
  const matches = evaluatePlaybooks({ ...sources, snipers, history: ctx.history ?? { launches: [] } }, ELYSIUM_PLAYBOOK_CONFIG);
  const receiptId = `pending:${coin.token.toLowerCase()}:${asOfBlock}`;
  const assembled = assembleVerdict(matches, { coin: coin.token, asOfBlock, receipt: { id: receiptId, hash: keccak256(stringToHex(receiptId)), status: 'pending' } });
  const probeRan = simulations.length > 0;
  const at = new Date(nowSec * 1000).toISOString();
  const verdict: Verdict = {
    ...assembled,
    // Without a probe the required honeypot check has not run: pending, never Clear (antiSnipe is its own reason).
    // Inside Montra's early-buy window the honeypot rule is skipped (the fee is not a trap), so Clear would be unearned.
    level: (!probeRan || antiSnipeActive) && assembled.level !== 'danger' ? 'pending' : assembled.level,
    evaluatedPlaybooks: probeRan ? undefined : ['agent_bait', 'malicious_hook', 'fee_trap_pool', 'removable_liquidity'],
    lastChecked: { block: asOfBlock, at },
  };
  if (!verdict.evaluatedPlaybooks) delete verdict.evaluatedPlaybooks;
  return { coin: coin.token, block: asOfBlock, at, name, symbol, key, config, currentBuyFeePips, antiSnipe, ...(p.taxPct !== undefined ? { taxPct: p.taxPct } : {}), probe, probeUsd: p.probeUsd, stats, matches, verdict };
}

/** A full check now: probe, then judge. */
export async function assess(coin: CoinState, block: bigint, deps: AssessDeps): Promise<Assessment> {
  const probed = await probeCoin(coin, block, deps);
  return judge(coin, probed, { registry: deps.registry, hypeUsd: deps.hypeUsd(), nowSec: Math.floor((deps.now?.() ?? Date.now()) / 1000), head: probed.block });
}
