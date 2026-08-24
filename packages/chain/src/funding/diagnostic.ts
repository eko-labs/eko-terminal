import { decodeEventLog } from 'viem';
import type { Hex } from 'viem';
import { erc20Abi } from '../abis.js';
import type { AcquiredTraceBlock } from '../launchpads/trace-acquisition.js';
import type { UsageRow } from '../rpc/usage.js';
import { FundingFlowSchema, successfulFunding } from './provider.js';
import type { FundingFlow } from './provider.js';

/** Reuse task-043 acquisition. Failed parents and non-transferring delegate/static frames never fund. */
export function fundingFromTraceBlock(block: AcquiredTraceBlock, quoteAssets: readonly string[],
  settlement: (flow: FundingFlow) => FundingFlow['settlement'] = () => 'unresolved') {
  const flows: FundingFlow[] = [], gaps: string[] = [];
  if (block.status !== 'complete') return { flows, gaps: [block.status], diagnosticOnly: true as const };
  for (const tx of block.transactions) {
    for (const f of tx.frames) {
      if (!f.successful || !f.call.to || !['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(f.call.type) || BigInt(f.call.value ?? '0x0') === 0n) continue;
      const flow = FundingFlowSchema.parse({ transactionHash: tx.transaction.hash, position: `call:${f.path}`,
        cursor: { ...tx.cursor, boundary: 'after_tx', transactionIndex: Number(BigInt(tx.transaction.transactionIndex)), executionOrdinal: f.ordinal },
        stream: f.parent === null ? 'native_external' : 'native_internal', asset: null, from: f.call.from, to: f.call.to,
        raw: BigInt(f.call.value!).toString(), transactionSuccessful: true, ancestorsSuccessful: true, settlement: 'external' });
      if (successfulFunding(flow)) flows.push(flow);
    }
    // Receipt logs are successful settlement, but wrap/economic attribution needs acquired reconciliation.
    for (const l of tx.logs) {
      if (!quoteAssets.map(a => a.toLowerCase()).includes(l.address)) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, ...l, topics: l.topics as [Hex, ...Hex[]] });
        if (event.eventName !== 'Transfer' || event.args.value === 0n) continue;
        const flow = FundingFlowSchema.parse({ transactionHash: tx.transaction.hash, position: `log:${l.logIndex}`,
          cursor: { ...tx.cursor, boundary: 'after_tx', transactionIndex: Number(BigInt(tx.transaction.transactionIndex)), executionOrdinal: l.ordinal },
          stream: 'quote', asset: l.address, from: event.args.from, to: event.args.to, raw: event.args.value.toString(),
          transactionSuccessful: tx.receipt.status === '0x1', ancestorsSuccessful: true, settlement: 'unresolved' });
        flow.settlement = settlement(flow);
        if (flow.settlement === 'unresolved') gaps.push('quote_settlement_unresolved');
        if (successfulFunding(flow)) flows.push(flow);
      } catch { gaps.push('quote_log_unsupported'); }
    }
    if (tx.bindingStatus !== 'complete') gaps.push(`quote_binding_${tx.bindingStatus}`);
  }
  return { flows, gaps: [...new Set(gaps)], diagnosticOnly: true as const };
}

export interface FundingPrices {
  /** Explicit verified vendor price; RPC nominal pricing never applies to indexed pages. */
  indexedPageNanoUsd: bigint | null;
  rpcUnitNanoUsd: bigint; rpcPriceEvidence: string | null;
  weights: { fullBlock: bigint; receipts: bigint; trace: bigint; canonicalCheck: bigint };
}
export type FundingCostCategory = 'indexed_pages' | 'confirmations' | 'block_traces' | 'anvil_upstream';
/** Actual RPC attempts come from RpcMeter usage rows, including retries/batch subrequests. */
export class FundingCostMeter {
  readonly counts: Record<FundingCostCategory, { calls: number; units: number; nanoUsd: bigint }> = {
    indexed_pages: { calls: 0, units: 0, nanoUsd: 0n }, confirmations: { calls: 0, units: 0, nanoUsd: 0n },
    block_traces: { calls: 0, units: 0, nanoUsd: 0n }, anvil_upstream: { calls: 0, units: 0, nanoUsd: 0n },
  };
  constructor(private readonly prices: FundingPrices, private readonly capNanoUsd: bigint, private readonly approvalRef: string | null) {
    validatePrices(prices);
    if (capNanoUsd < 0n) throw new Error('Invalid funding cap');
  }
  get totalNanoUsd() { return Object.values(this.counts).reduce((n, r) => n + r.nanoUsd, 0n); }
  async admitPage() {
    const price = this.prices.indexedPageNanoUsd;
    if (!this.approvalRef || price === null || this.totalNanoUsd + price > this.capNanoUsd) throw new Error('Funding page price/approval/cap unavailable');
    const row = this.counts.indexed_pages; row.calls++; row.units++; row.nanoUsd += price;
  }
  /** Snapshots must cover only this job's requests, or a dedicated shared diagnostic session. */
  recordRpcDelta(before: UsageRow[], after: UsageRow[], category: 'acquisition' | 'anvil_upstream') {
    for (const row of after) {
      const old = before.find(r => r.provider === row.provider && r.method === row.method);
      const calls = row.calls - (old?.calls ?? 0), units = row.units - (old?.units ?? 0);
      if (calls < 0 || units < 0) throw new Error('RPC usage snapshot reset; checkpoint by day');
      const target = this.counts[category === 'anvil_upstream' ? category : row.method.startsWith('debug_trace') ? 'block_traces' : 'confirmations'];
      target.calls += calls; target.units += units;
      // Public requests still consume units; only paid-provider attempts have marginal paid cost.
      if (row.provider === 'paid') target.nanoUsd += BigInt(units) * this.prices.rpcUnitNanoUsd;
    }
  }
}
function validatePrices(p: FundingPrices) {
  if (p.rpcUnitNanoUsd < 0n || p.indexedPageNanoUsd !== null && p.indexedPageNanoUsd < 0n || Object.values(p.weights).some(w => w < 1n)) throw new Error('Invalid funding pricing');
}
export interface FundingBlockInterval { from: string; through: string }
export function unionFundingIntervals(input: readonly FundingBlockInterval[]): FundingBlockInterval[] {
  const values = input.map(i => {
    if (!/^(0|[1-9]\d*)$/.test(i.from) || !/^(0|[1-9]\d*)$/.test(i.through) || BigInt(i.from) > BigInt(i.through)) throw new Error('Invalid funding block interval');
    return { from: BigInt(i.from), through: BigInt(i.through) };
  }).sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  const union: typeof values = [];
  for (const interval of values) {
    const last = union.at(-1);
    if (last && interval.from <= last.through + 1n) { if (interval.through > last.through) last.through = interval.through; }
    else union.push({ ...interval });
  }
  return union.map(i => ({ from: i.from.toString(), through: i.through.toString() }));
}
/** Preparation only. Task-043's four-request acquisition is costed conservatively, once per union block. */
export function planFundingDiagnostic(input: { intervals: FundingBlockInterval[]; prices: FundingPrices;
  approvalRef: string | null; remainingCapNanoUsd: bigint; remainingCheckpointUnits: bigint }) {
  validatePrices(input.prices);
  if (input.remainingCapNanoUsd < 0n || input.remainingCheckpointUnits < 0n) throw new Error('Invalid diagnostic budget');
  const union = unionFundingIntervals(input.intervals);
  const unitsPerBlock = Object.values(input.prices.weights).reduce((n, w) => n + w, 0n);
  const costPerBlock = unitsPerBlock * input.prices.rpcUnitNanoUsd;
  const totalBlocks = union.reduce((n, i) => n + BigInt(i.through) - BigInt(i.from) + 1n, 0n);
  const approved = !!input.approvalRef && !!input.prices.rpcPriceEvidence;
  const moneyBlocks = costPerBlock === 0n ? totalBlocks : input.remainingCapNanoUsd / costPerBlock;
  const checkpointBlocks = input.remainingCheckpointUnits / unitsPerBlock;
  let available = approved ? (moneyBlocks < checkpointBlocks ? moneyBlocks : checkpointBlocks) : 0n;
  const selected: FundingBlockInterval[] = [], remaining: FundingBlockInterval[] = [];
  for (const i of union) {
    const size = BigInt(i.through) - BigInt(i.from) + 1n, take = available < size ? available : size;
    if (take > 0n) selected.push({ from: i.from, through: (BigInt(i.from) + take - 1n).toString() });
    if (take < size) remaining.push({ from: (BigInt(i.from) + take).toString(), through: i.through });
    available -= take;
  }
  const blocks = selected.reduce((n, i) => n + BigInt(i.through) - BigInt(i.from) + 1n, 0n);
  return { status: approved ? 'prepared' as const : 'unavailable' as const, diagnosticOnly: true, liveFundingComplete: false,
    union, selected, remaining, blocks, requestUnits: blocks * unitsPerBlock, estimatedNanoUsd: blocks * costPerBlock,
    pricing: input.prices, approvalRef: input.approvalRef, nextBlock: remaining[0]?.from ?? null,
    categories: { confirmations: blocks * (input.prices.weights.fullBlock + input.prices.weights.receipts + input.prices.weights.canonicalCheck),
      blockTraces: blocks * input.prices.weights.trace, indexedPages: 0n, anvilUpstream: 0n },
    gaps: approved ? ['diagnostic_coverage_only', ...(remaining.length ? ['cap_or_checkpoint'] : [])] : ['approval_or_rpc_price_unverified'] };
}
