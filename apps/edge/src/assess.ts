import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { SellProbe, V4PoolKey } from '@eko/chain';
import { assembleVerdict, evaluatePlaybooks, marketCapContext, partialHistoryReason, type CardSources, type HistoryView, type Simulation } from '@eko/playbooks';
import type { PlaybookMatch, Verdict } from '@eko/shared';
import type { CoinState, Rpc } from './tracker.js';
import type { ChainAdapter } from './chains/types.js';
import { flowStats, type FlowStats, type FunderLookup } from './holders.js';
import { findSnipers, SNIPER_BLOCKS } from './snipers.js';
import { transferCoverage, type Coverage } from './coverage.js';
import { flowActivity } from './flow-stats.js';

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
  /** The sell check can never run on this pool (Probed.sellCheckUnavailable): named on the card, not waited for. */
  sellCheckUnavailable?: 'token_quoted_pool';
  /** Holders, early buyers and the deployer's trading, from the coin's transfers. */
  stats: FlowStats;
  matches: PlaybookMatch[]; verdict: Verdict;
  /** Whether the launch liquidity was found locked or removable (JudgeFacts.liquidity); absent when nothing is claimed. */
  lp?: 'locked' | 'removable';
  /** From when EKO holds the coin's transfers (coverage.ts): when not from launch, holder and early-buyer checks did not
   *  run and the card names those figures missing. Absent on checks made before it was kept. */
  history?: Coverage;
  /** Native currency in the coin's pool, read on chain (Probed.poolReserve); absent where only EKO's net of trades says. */
  poolNative?: number;
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
  /**
   * The sell check can never run on this coin's pool, so it is not waited for: a pool quoted in a token (the probe pays
   * in native currency), which EKO checks but does not trade. Set only by a chain that knows it (Robinhood's
   * more_launchpads pools); a coin whose probe merely failed or has not run leaves it unset and stays Pending.
   */
  sellCheckUnavailable?: 'token_quoted_pool';
  /**
   * The coin's pool read on chain at the probe block, where the chain can read it (a Pons graduate's v4 pool): the
   * native currency it holds (whole units) and its price (native per 1e18 base units). It backs the price (fake_mcap)
   * and is the liquidity the card shows, whatever part of the coin's history EKO holds.
   */
  poolReserve?: { native: number; price: number };
}
/** Whether a check still owes its sell test: none ran, or it could not answer, and the pool is not one it can never run on. */
export const sellCheckOutstanding = (p: Pick<Probed, 'probe' | 'sellCheckUnavailable'>) => p.probe ? p.probe.status === 'unavailable' : !p.sellCheckUnavailable;

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
  const { antiSnipeActive, antiSnipe, feeBps, liquidity: locked, hook, runUp, backing } = chain.facts(coin, p, nowSec);
  const hypeUsd = ctx.hypeUsd;
  const asOfBlock = Math.max(ctx.head, p.block);
  const simulations: Simulation[] = probe && probe.status !== 'unavailable' ? [{
    id: `${probe.routeId}@${probe.block}`, sizeUsd: 1000, block: p.block, buyOk: probe.status !== 'buy_failed', sellOk: probe.status === 'sellable',
    returnedInputShare: probe.spentWei && probe.returnedWei && BigInt(probe.spentWei) > 0n ? Number(BigInt(probe.returnedWei) * 10000n / BigInt(probe.spentWei)) / 10000 : 0,
    traceDigest: keccak256(stringToHex(JSON.stringify({ routeId: probe.routeId, block: probe.block, status: probe.status, reason: probe.reason }))),
    ...(probe.reason === 'sell_reverted' && probe.revert ? { revert: probe.revert } : {}),
  }] : [];
  const excluded = chain.excluded(coin);
  const window = chain.profile.playbooks.bundle_dump;
  const stats = flowStats(coin, { excluded, hypeUsd, ...(ctx.funders ? { funders: ctx.funders } : {}),
    launch: { firstBlocks: window.firstBlocks, minWallets: window.minWallets, ...(chain.publicRouters ? { publicRouters: chain.publicRouters } : {}) } });
  const hasHook = !!key && key.hooks !== '0x0000000000000000000000000000000000000000';
  // Holders, the deployer's balance, bundles, early buyers and snipers are sums over the coin's transfers: on a history
  // that does not start at the launch they are a sliver of the truth, so those checks are not fed at all (a missing
  // source is no match) and the verdict says so below.
  const history = transferCoverage(coin, nowSec), whole = history.complete;
  // Trading in a window is known only when EKO's trades cover all of it.
  const covered = (sec: number) => whole || history.since <= nowSec - sec;
  const sumSince = (sec: number) => coin.trades.reduce((n, t) => t.ts > nowSec - sec ? n + t.hype : n, 0);
  const buyers24h = hypeUsd && covered(86_400) ? flowActivity(coin, '24h', { nowSec, hypeUsd }, { excluded })?.buyers ?? null : null;
  // Backing from EKO's own net of trades needs the whole history; read from the pool on chain it does not.
  const market = backing && hypeUsd && (whole || backing.source === 'pool') ? { mcapUsd: backing.mcap * hypeUsd, backingUsd: backing.paidIn * hypeUsd,
    volume24hUsd: covered(86_400) ? backing.volume24h * hypeUsd : null, volume1hUsd: covered(3600) ? sumSince(3600) * hypeUsd : null, buyers24h,
    holders: whole ? stats.holderCount : null, evidence: backing.evidence } : null;
  const sources: CardSources = {
    ...(whole ? { holders: stats.holders, earlyBuyers: stats.earlyBuyers, dev: stats.dev,
      ...(stats.bundles.length ? { bundles: stats.bundles } : {}), ...(stats.copyTraders.length ? { copyTraders: stats.copyTraders } : {}) } : {}),
    coin: coin.token, deployer: coin.creator, asOfBlock, asOfSec: nowSec, createdAtSec: coin.ts, createdAtBlock: coin.block,
    launchpad: coin.launchpad, name, symbol, antiSnipeActive, simulations, sniperWindowSec: chain.profile.sniperBlocks * chain.profile.blockTimeSec, ...(runUp ? { runUp } : {}),
    // Without an ETH price no market cap is claimed, so fake_mcap stays silent rather than guessing.
    ...(market ? { marketCap: market } : {}),
    ...(p.taxPct ? { taxes: { buyPct: p.taxPct.buy, sellPct: p.taxPct.sell, mutable: null, changes: [] } } : {}),
    ...(locked ? { liquidity: { positions: [{ owner: locked.owner, controlledBy: locked.controlledBy ?? 'other' as const, share: 1, status: locked.status,
      evidence: [{ kind: 'address' as const, ref: locked.owner, label: locked.label }] }], priorRemovals: [],
      // The wallet that was given the launch position took (part of) it out: removable_liquidity's pull.
      ...(locked.pulled ? { pulled: { share: locked.pulled.share, by: 'provider' as const, wallet: locked.owner, evidence: locked.pulled.evidence } } : {}) } } : {}),
    ...(key ? { pools: [{ id: coin.poolId, feeBps, liquidityShare: 1, deepest: true, defaultRoute: true, evidence: [] }] } : {}),
    ...(key && hasHook ? { hook: {
      address: key.hooks, ...hookBits(key.hooks), reviewed: hook.reviewed, sourceVerified: hook.sourceVerified, quoteSimGapPct: null,
      buyFeePct: hook.buyFeePct, sellFeePct: hook.sellFeePct, evidence: [{ kind: 'address' as const, ref: key.hooks, label: hook.label }] } } : {}),
  };
  const snipers = whole ? findSnipers(coin, excluded, p.tips, chain.profile.sniperBlocks) : undefined;
  const matches = evaluatePlaybooks({ ...sources, ...(snipers ? { snipers } : {}), history: ctx.history ?? { launches: [] } }, chain.profile.playbooks);
  const receiptId = `pending:${coin.token.toLowerCase()}:${asOfBlock}`;
  const assembled = assembleVerdict(matches, { coin: coin.token, asOfBlock, receipt: { id: receiptId, hash: keccak256(stringToHex(receiptId)), status: 'pending' } });
  const probeRan = simulations.length > 0;
  // A pool the sell check can never run on is graded by the checks that do run (an unreviewed hook already makes such a
  // coin Monitor); with no finding at all it stays Pending, since Clear needs the honeypot check.
  const graded = probeRan || (!!p.sellCheckUnavailable && assembled.level !== 'clear');
  const at = new Date(nowSec * 1000).toISOString();
  const level = (!graded || antiSnipeActive) && assembled.level !== 'danger' ? 'pending' : assembled.level;
  // The level stays what the checks that ran say (pending keeps its meaning for trading). A partial history is named:
  // a machine-readable flag with the time EKO's history starts, and a plain line (first on a Clear level, which clients
  // then show as Partly checked). An older coin that simply trades little gets its context line (never a flag).
  const partial = whole ? null : partialHistoryReason(coin.ts, history.since);
  const quiet = marketCapContext(sources, chain.profile.playbooks.fake_mcap);
  const reasons = [...(partial && level === 'clear' ? [partial] : []), ...assembled.reasons, ...(partial && level !== 'clear' ? [partial] : []), ...(quiet ? [quiet] : [])];
  const verdict: Verdict = {
    ...assembled, reasons,
    // Without a probe the required honeypot check has not run: pending, never Clear (antiSnipe is its own reason).
    // Inside an early-buy window the honeypot rule is skipped (the fee is not a trap), so Clear would be unearned.
    level,
    evaluatedPlaybooks: probeRan ? undefined : ['agent_bait', 'malicious_hook', 'fee_trap_pool', 'removable_liquidity'],
    ...(whole ? {} : { historyPartial: { since: new Date(history.since * 1000).toISOString() } }),
    lastChecked: { block: asOfBlock, at },
  };
  if (!verdict.evaluatedPlaybooks) delete verdict.evaluatedPlaybooks;
  return { coin: coin.token, block: asOfBlock, at, name, symbol, key, config, currentBuyFeePips, antiSnipe, ...(p.taxPct !== undefined ? { taxPct: p.taxPct } : {}), probe, probeUsd: p.probeUsd, stats, matches, verdict, ...(locked ? { lp: locked.status } : {}),
    ...(p.sellCheckUnavailable ? { sellCheckUnavailable: p.sellCheckUnavailable } : {}), history, ...(p.poolReserve ? { poolNative: p.poolReserve.native } : {}) };
}

/** A full check now: probe, then judge. */
export async function assess(coin: CoinState, block: bigint, deps: AssessDeps): Promise<Assessment> {
  const probed = await deps.chain.probe(coin, block, deps);
  return judge(coin, probed, { chain: deps.chain, hypeUsd: deps.hypeUsd(), nowSec: Math.floor((deps.now?.() ?? Date.now()) / 1000), head: probed.block });
}
