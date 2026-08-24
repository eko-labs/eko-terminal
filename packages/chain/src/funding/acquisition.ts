import { compareGuardCursors } from '@eko/shared';
import type { GuardCursor } from '@eko/shared';
import { FundingFlowSchema, FundingPageSchema, FundingRangeSchema, fundingFlowId, successfulFunding } from './provider.js';
import type { FundingCapability, FundingFlow, FundingPage, FundingProvider, FundingRange, FundingStream } from './provider.js';

export interface FundingCheckpoint {
  key: string; streams: { stream: FundingStream; asset: string | null; sequence: number; cursor: string | null; seenCursors: string[]; gaps: string[]; complete: boolean }[];
  flows: FundingFlow[]; pageHashes: string[];
}
/** Persist successful pages/checkpoints through the caller's existing evidence store if restart reuse is needed. */
export interface FundingCache {
  get(key: string): Promise<FundingCheckpoint | null>;
  put(key: string, checkpoint: FundingCheckpoint): Promise<void>;
}
export class MemoryFundingCache implements FundingCache {
  private readonly values = new Map<string, FundingCheckpoint>();
  constructor(private readonly maxRanges = 64) {
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 1) throw new Error('Invalid funding cache bound');
  }
  async get(key: string) { return structuredClone(this.values.get(key) ?? null); }
  async put(key: string, checkpoint: FundingCheckpoint) {
    if (!this.values.has(key) && this.values.size >= this.maxRanges) throw new Error('Funding cache full');
    this.values.set(key, structuredClone(checkpoint));
  }
}
export interface FundingResult {
  status: 'complete' | 'partial' | 'unavailable'; gaps: string[]; checkpoint: FundingCheckpoint;
  coverage: { topLevelNative: boolean; internalNative: boolean; quoteAssets: string[]; complete: boolean; firstEverEstablished: boolean };
  firstObserved: FundingFlow | null; firstEver: FundingFlow | null;
}
export class FundingAcquisition {
  private readonly active = new Map<string, Promise<FundingResult>>();
  constructor(private readonly provider: FundingProvider, private readonly capability: FundingCapability,
    private readonly cache: FundingCache, private readonly beforePage: () => Promise<void>) {}
  acquire(input: FundingRange, maxPages = 16): Promise<FundingResult> {
    const range = FundingRangeSchema.parse(input);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('Invalid funding page limit');
    const key = JSON.stringify([this.provider.sourceId, this.provider.sourceRevision, range]);
    const prior = this.active.get(key); if (prior) return prior;
    const job = this.fetch(range, key, maxPages).finally(() => this.active.delete(key));
    this.active.set(key, job); return job;
  }
  private async fetch(range: FundingRange, key: string, maxPages: number): Promise<FundingResult> {
    const checkpoint = await this.cache.get(key) ?? { key, streams: [
      { stream: 'native_external' as const, asset: null, sequence: 0, cursor: null, seenCursors: [], gaps: [], complete: false },
      { stream: 'native_internal' as const, asset: null, sequence: 0, cursor: null, seenCursors: [], gaps: [], complete: false },
      ...range.quoteAssets.map(asset => ({ stream: 'quote' as const, asset, sequence: 0, cursor: null, seenCursors: [], gaps: [], complete: false })),
    ], flows: [], pageHashes: [] };
    if (checkpoint.key !== key) throw new Error('Funding checkpoint scope mismatch');
    const gaps: string[] = [];
    const trusted = this.capability.validation === 'measured' &&
      this.capability.sourceId === this.provider.sourceId && this.capability.sourceRevision === this.provider.sourceRevision;
    let pages = 0;
    // Fixture capability can exercise paging, but can never establish production completeness.
    for (const state of checkpoint.streams) {
      if (!this.capability.streams.includes(state.stream)) { gaps.push(`source_missing:${state.stream}`); continue; }
      while (!state.complete && pages < maxPages) {
        try {
          await this.beforePage(); pages++;
          const page = FundingPageSchema.parse(await this.provider.page({ range, stream: state.stream, asset: state.asset, sequence: state.sequence, cursor: state.cursor }));
          this.validatePage(page, range, state);
          const prior = checkpoint.flows.filter(f => f.stream === state.stream && f.asset === state.asset).at(-1);
          if (prior && page.flows.some(f => compareGuardCursors(f.cursor, prior.cursor) < 0)) throw new Error('Funding pagination order mismatch');
          const flows = new Map(checkpoint.flows.map(f => [fundingFlowId(f), f]));
          for (const flow of page.flows.filter(successfulFunding)) {
            const id = fundingFlowId(flow), old = flows.get(id);
            if (old && JSON.stringify(old) !== JSON.stringify(flow)) throw new Error('Funding value conflict');
            flows.set(id, flow);
          }
          const next: FundingCheckpoint = { key, streams: checkpoint.streams.map(s => s === state ?
            { ...s, sequence: s.sequence + 1, cursor: page.nextCursor, seenCursors: page.nextCursor ? [...s.seenCursors, page.nextCursor] : s.seenCursors,
              gaps: [...new Set([...s.gaps, ...(page.flows.some(f => f.transactionSuccessful && f.ancestorsSuccessful && f.settlement === 'unresolved') ? ['settlement_unresolved'] : []),
                ...(page.nextCursor === null && !page.intervalComplete ? ['pagination_gap'] : [])])],
              complete: page.nextCursor === null && page.intervalComplete } : { ...s }),
          flows: [...flows.values()].sort((a, b) => compareGuardCursors(a.cursor, b.cursor) || fundingFlowId(a).localeCompare(fundingFlowId(b))),
          pageHashes: [...checkpoint.pageHashes, page.payloadHash] };
          // Store before advancing; a failed write keeps the last accepted resumable checkpoint.
          await this.cache.put(key, next);
          Object.assign(state, next.streams.find(s => s.stream === state.stream && s.asset === state.asset));
          checkpoint.flows = next.flows; checkpoint.pageHashes = next.pageHashes;
          if (page.nextCursor === null && !page.intervalComplete) { gaps.push('pagination_gap'); break; }
        } catch { gaps.push(`page_unavailable:${state.stream}`); break; }
      }
    }
    if (!trusted) gaps.push(...this.capability.gaps, 'provider_unverified');
    for (const state of checkpoint.streams) if (!this.capability.verifiedStreams.includes(state.stream) ||
      state.asset && !this.capability.verifiedQuoteAssets.includes(state.asset)) gaps.push(`source_unverified:${state.stream}:${state.asset ?? 'native'}`);
    if (checkpoint.streams.some(s => !s.complete)) gaps.push('interval_incomplete');
    gaps.push(...checkpoint.streams.flatMap(s => s.gaps));
    const topLevelNative = trusted && this.capability.verifiedStreams.includes('native_external') && checkpoint.streams.some(s => s.stream === 'native_external' && s.complete && !s.gaps.length);
    const internalNative = trusted && this.capability.verifiedStreams.includes('native_internal') && checkpoint.streams.some(s => s.stream === 'native_internal' && s.complete && !s.gaps.length);
    const quoteAssets = trusted && this.capability.verifiedStreams.includes('quote') ? checkpoint.streams.filter(s => s.stream === 'quote' && s.complete && !s.gaps.length &&
      this.capability.verifiedQuoteAssets.includes(s.asset!)).map(s => s.asset!) : [];
    const complete = topLevelNative && internalNative && quoteAssets.length === range.quoteAssets.length && gaps.length === 0;
    const firstEverEstablished = complete && range.origin.kind !== 'bounded';
    const firstObserved = checkpoint.flows[0] ?? null;
    return { status: complete ? 'complete' : checkpoint.pageHashes.length ? 'partial' : 'unavailable', gaps: [...new Set(gaps)], checkpoint,
      coverage: { topLevelNative, internalNative, quoteAssets, complete, firstEverEstablished }, firstObserved,
      firstEver: firstEverEstablished ? firstObserved : null };
  }
  private validatePage(page: FundingPage, range: FundingRange, state: FundingCheckpoint['streams'][number]) {
    if (page.sourceRevision !== this.provider.sourceRevision || JSON.stringify(page.range) !== JSON.stringify(range) ||
      page.stream !== state.stream || page.asset !== state.asset || page.sequence !== state.sequence || page.requestCursor !== state.cursor ||
      page.nextCursor !== null && page.nextCursor === state.cursor || page.intervalComplete && page.nextCursor !== null ||
      page.nextCursor === null && !page.intervalComplete) throw new Error('Funding pagination mismatch');
    if (page.nextCursor && state.seenCursors.includes(page.nextCursor)) throw new Error('Funding pagination cycle');
    for (const f of page.flows) {
      if (f.to !== range.address || f.stream !== state.stream || f.asset !== state.asset || f.cursor.chainId !== range.from.chainId ||
        BigInt(f.cursor.blockNumber) < BigInt(range.from.blockNumber) || BigInt(f.cursor.blockNumber) > BigInt(range.through.blockNumber) ||
        BigInt(f.cursor.timestampSec) < BigInt(range.from.timestampSec) || BigInt(f.cursor.timestampSec) > BigInt(range.through.timestampSec) ||
        f.cursor.blockNumber === range.from.blockNumber && f.cursor.blockHash !== range.from.blockHash ||
        f.cursor.blockNumber === range.through.blockNumber && f.cursor.blockHash !== range.through.blockHash) throw new Error('Funding page interval mismatch');
    }
    if (page.flows.some((f, i) => i > 0 && compareGuardCursors(page.flows[i - 1].cursor, f.cursor) > 0)) throw new Error('Funding page order mismatch');
  }
}

/** Raw asset units are consumed once across launches; no exchange-rate or control inference. */
export class FundingValueLedger {
  private readonly remaining = new Map<string, bigint>();
  private readonly flows = new Map<string, FundingFlow>();
  constructor(flows: readonly FundingFlow[]) {
    for (const input of flows) {
      const f = FundingFlowSchema.parse(input); if (!successfulFunding(f)) continue;
      const id = fundingFlowId(f), old = this.flows.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(f)) throw new Error('Funding value conflict');
      this.flows.set(id, f); this.remaining.set(id, BigInt(f.raw));
    }
  }
  consume(id: string, raw: bigint, asset: string | null, boughtAt: GuardCursor) {
    const f = this.flows.get(id), left = this.remaining.get(id);
    if (!f || left === undefined || raw <= 0n || raw > left || f.asset !== asset || f.cursor.chainId !== boughtAt.chainId ||
      compareGuardCursors(f.cursor, boughtAt) >= 0) throw new Error('Unconserved or post-purchase funding');
    this.remaining.set(id, left - raw); return left - raw;
  }
}
