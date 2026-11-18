import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { SellProbe, V4PoolKey } from '@eko/chain';
import { assembleVerdict, evaluatePlaybooks, type CardSources, type HistoryView, type Simulation } from '@eko/playbooks';
import type { PlaybookMatch, Verdict } from '@eko/shared';
import type { CoinState, Rpc } from './tracker.js';
import type { ChainAdapter } from './chains/types.js';
import { flowStats, type FlowStats, type FunderLookup } from './holders.js';
import { findSnipers, SNIPER_BLOCKS } from './snipers.js';

const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);

/** Montra's pool terms (Elysium); null on every other launchpad. */
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
  /** Whether the launch liquidity was found locked or removable (JudgeFacts.liquidity); absent when nothing is claimed. */
  lp?: 'locked' | 'removable';
}

/** The permission bits of a v4 hook are the low 14 bits of its address; the four return-delta bits are the lowest. */
export function hookBits(hook: Address) { const v = Number(BigInt(hook) & 0x3fffn); return { permissionBits: v, returnDeltaPermissionBits: v & 0xf }; }

/** Many reads in one Multicall3 aggregate3 call (each may fail on its own). */
export async function multicall(rpc: Rpc, multicall3: Address, calls: { target: Address; data: Hex }[], block: bigint | 'latest') {
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

export interface AssessDeps { rpc: Rpc; chain: ChainAdapter; hypeUsd: () => number | null; now?: () => number }

/** What the chain says about a coin at one block: the paid reads of a check (ChainAdapter.probe), cached between checks. */
export interface Probed {
  block: number; at: string; name: string; symbol: string; key: V4PoolKey | null; config: MontraPoolConfig | null;
  currentBuyFeePips: number | null; probe: SellProbe | null; probeUsd: number;
  /** Priority fee (gwei) of each early buy transaction, for the launch-sniper evidence. */
  tips: Record<string, number>;
  /** Tax launchpad and unbranded-launcher coins: the hook's current buy and sell tax or fee (%). */
  taxPct?: { buy: number; sell: number } | null;
  /** When the launch's early-buy window ends (unix s), where it is not in `config`: a probe taken before then is redone. */
  earlyUntil?: number;
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
 * transfers, and the chain's own facts (early-buy window, fee, liquidity, hook). Pure. A probe that could not run, or an
 * early-buy window, leaves it pending: pending is never Clear.
 */
export interface JudgeContext {
  chain: ChainAdapter; hypeUsd: number | null; nowSec: number; head: number;
  /** The deployer's (and its crew's) earlier launches from the history store; none without one. */
  history?: HistoryView;
  /** Traced funders of early buyers (bundles); each wallet is its own funder without one. */
  funders?: FunderLookup;
}
export function judge(coin: CoinState, p: Probed, ctx: JudgeContext): Assessment {
  const { chain, nowSec } = ctx, { key, config, currentBuyFeePips, probe, name, symbol } = p;
  const { antiSnipeActive, antiSnipe, feeBps, liquidity: locked, hook } = chain.facts(coin, p, nowSec);
  const hypeUsd = ctx.hypeUsd;
  const asOfBlock = Math.max(ctx.head, p.block);
  const simulations: Simulation[] = probe && probe.status !== 'unavailable' ? [{
    id: `${probe.routeId}@${probe.block}`, sizeUsd: 1000, block: p.block, buyOk: probe.status !== 'buy_failed', sellOk: probe.status === 'sellable',
    returnedInputShare: probe.spentWei && probe.returnedWei && BigInt(probe.spentWei) > 0n ? Number(BigInt(probe.returnedWei) * 10000n / BigInt(probe.spentWei)) / 10000 : 0,
    traceDigest: keccak256(stringToHex(JSON.stringify({ routeId: probe.routeId, block: probe.block, status: probe.status, reason: probe.reason }))),
    ...(probe.reason === 'sell_reverted' && probe.revert ? { revert: probe.revert } : {}),
  }] : [];
  const excluded = chain.excluded(coin);
  const stats = flowStats(coin, { excluded, hypeUsd, ...(ctx.funders ? { funders: ctx.funders } : {}) });
  const hasHook = !!key && key.hooks !== '0x0000000000000000000000000000000000000000';
  const sources: CardSources = {
    holders: stats.holders, earlyBuyers: stats.earlyBuyers, dev: stats.dev,
    coin: coin.token, deployer: coin.creator, asOfBlock, asOfSec: nowSec, createdAtSec: coin.ts, createdAtBlock: coin.block,
    launchpad: coin.launchpad, name, symbol, antiSnipeActive, simulations,
    ...(p.taxPct ? { taxes: { buyPct: p.taxPct.buy, sellPct: p.taxPct.sell, mutable: null, changes: [] } } : {}),
    ...(locked ? { liquidity: { positions: [{ owner: locked.owner, controlledBy: 'other' as const, share: 1, status: locked.status,
      evidence: [{ kind: 'address' as const, ref: locked.owner, label: locked.label }] }], priorRemovals: [] } } : {}),
    ...(key ? { pools: [{ id: coin.poolId, feeBps, liquidityShare: 1, deepest: true, defaultRoute: true, evidence: [] }] } : {}),
    ...(key && hasHook ? { hook: {
      address: key.hooks, ...hookBits(key.hooks), reviewed: hook.reviewed, sourceVerified: hook.sourceVerified, quoteSimGapPct: null,
      buyFeePct: hook.buyFeePct, sellFeePct: hook.sellFeePct, evidence: [{ kind: 'address' as const, ref: key.hooks, label: hook.label }] } } : {}),
  };
  const snipers = findSnipers(coin, excluded, p.tips);
  const matches = evaluatePlaybooks({ ...sources, snipers, history: ctx.history ?? { launches: [] } }, chain.profile.playbooks);
  const receiptId = `pending:${coin.token.toLowerCase()}:${asOfBlock}`;
  const assembled = assembleVerdict(matches, { coin: coin.token, asOfBlock, receipt: { id: receiptId, hash: keccak256(stringToHex(receiptId)), status: 'pending' } });
  const probeRan = simulations.length > 0;
  const at = new Date(nowSec * 1000).toISOString();
  const verdict: Verdict = {
    ...assembled,
    // Without a probe the required honeypot check has not run: pending, never Clear (antiSnipe is its own reason).
    // Inside an early-buy window the honeypot rule is skipped (the fee is not a trap), so Clear would be unearned.
    level: (!probeRan || antiSnipeActive) && assembled.level !== 'danger' ? 'pending' : assembled.level,
    evaluatedPlaybooks: probeRan ? undefined : ['agent_bait', 'malicious_hook', 'fee_trap_pool', 'removable_liquidity'],
    lastChecked: { block: asOfBlock, at },
  };
  if (!verdict.evaluatedPlaybooks) delete verdict.evaluatedPlaybooks;
  return { coin: coin.token, block: asOfBlock, at, name, symbol, key, config, currentBuyFeePips, antiSnipe, ...(p.taxPct !== undefined ? { taxPct: p.taxPct } : {}), probe, probeUsd: p.probeUsd, stats, matches, verdict, ...(locked ? { lp: locked.status } : {}) };
}

/** A full check now: probe, then judge. */
export async function assess(coin: CoinState, block: bigint, deps: AssessDeps): Promise<Assessment> {
  const probed = await deps.chain.probe(coin, block, deps);
  return judge(coin, probed, { chain: deps.chain, hypeUsd: deps.hypeUsd(), nowSec: Math.floor((deps.now?.() ?? Date.now()) / 1000), head: probed.block });
}
