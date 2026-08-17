import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { FundingAcquisition, FundingValueLedger, MemoryFundingCache } from '../src/funding/acquisition.js';
import { FundingFlowSchema, FundingRangeSchema, fundingFlowId, testFundingCapability, unavailableFundingCapability } from '../src/funding/provider.js';
import type { FundingCapability, FundingFlow, FundingPage, FundingProbe, FundingProvider, FundingRange, FundingStream } from '../src/funding/provider.js';
import { FundingCostMeter, fundingFromTraceBlock, planFundingDiagnostic, unionFundingIntervals } from '../src/funding/diagnostic.js';
import type { FundingPrices } from '../src/funding/diagnostic.js';
import { erc20Abi } from '../src/abis.js';
import { address, hash, cursor, fakeAcquisition, traceFixture } from './fixtures/trace-principals.js';

const quote = address(20), receiver = address(21);
const range: FundingRange = { address: receiver, from: { ...cursor, blockNumber: '120', blockHash: hash(120), timestampSec: '99900' },
  through: cursor, quoteAssets: [quote], origin: { kind: 'bounded' } };
function flow(stream: FundingStream = 'native_external', n = 1): FundingFlow {
  return { transactionHash: hash(n), position: stream === 'quote' ? 'log:1' : stream === 'native_internal' ? 'call:0.1' : 'call:0',
    cursor: { ...cursor, transactionIndex: n, executionOrdinal: n, boundary: 'after_tx' }, stream, asset: stream === 'quote' ? quote : null,
    from: address(22), to: receiver, raw: '100', transactionSuccessful: true, ancestorsSuccessful: true, settlement: 'external' };
}
const probes = (): FundingProbe[] => (['funding_only', 'internal', 'failed', 'reverted_parent', 'quote', 'wrap', 'pagination', 'interval_boundaries'] as const)
  .map(name => ({ name, passed: true, evidenceHash: hash(200), expected: name === 'funding_only' ? [flow()] : name === 'internal' ? [flow('native_internal')] : name === 'quote' ? [flow('quote')] : [],
    observed: name === 'funding_only' ? [flow()] : name === 'internal' ? [flow('native_internal')] : name === 'quote' ? [flow('quote')] :
      name === 'failed' ? [{ ...flow(), transactionSuccessful: false }] : name === 'reverted_parent' ? [{ ...flow('native_internal'), ancestorsSuccessful: false }] :
        name === 'wrap' ? [{ ...flow('quote'), settlement: 'same_account_wrap' as const }] : [] }));
const source = { sourceId: 'fixture-index', sourceRevision: 'candidate-1' };
// Synthetic measured-mode records test acceptance branches; they are not live provider evidence.
const capability = (): FundingCapability => testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'measured', probes());
function provider(overrides?: (page: FundingPage) => FundingPage): FundingProvider & { requests: string[] } {
  const requests: string[] = [];
  return { ...source, requests, async page(r) {
    requests.push(`${r.stream}:${r.sequence}`);
    const p: FundingPage = { sourceRevision: source.sourceRevision, range: r.range, stream: r.stream, asset: r.asset,
      sequence: r.sequence, requestCursor: r.cursor, nextCursor: r.sequence === 0 ? 'page-1' : null,
      intervalComplete: r.sequence === 1, payloadHash: hash(100 + r.sequence), flows: [flow(r.stream, r.sequence + 1)] };
    return overrides ? overrides(p) : p;
  } };
}
const acquisition = (p = provider(), c = capability(), cache = new MemoryFundingCache()) => new FundingAcquisition(p, c, cache, async () => undefined);
const prices: FundingPrices = { indexedPageNanoUsd: 500000n, rpcUnitNanoUsd: 6000n, rpcPriceEvidence: 'fixture-price',
  weights: { fullBlock: 1n, receipts: 1n, trace: 1n, canonicalCheck: 1n } };

describe('indexed funding capability', () => {
  it('tests successful funding-only/internal/quote and rejects failed parents and wrapping', () => {
    expect(capability().usable).toBe(true);
    const bad = probes(); bad[0].observed[0].raw = '99';
    expect(testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'measured', bad).usable).toBe(false);
    const failed = probes(); failed[2].observed[0].transactionSuccessful = true;
    expect(testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'measured', failed).gaps).toContain('failed');
    const internal = probes(); internal[3].observed[0].ancestorsSuccessful = true;
    expect(testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'measured', internal).gaps).toContain('reverted_parent');
  });
  it('does not certify fixtures, absent positive controls, or top-level-only history', () => {
    expect(testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'fixture', probes()).usable).toBe(false);
    expect(testFundingCapability(source, ['native_external'], 'measured', probes()).usable).toBe(false);
    const empty = probes(); empty[1].expected = []; empty[1].observed = [];
    expect(testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'measured', empty).usable).toBe(false);
  });
});

describe('pinned interval paging and funding values', () => {
  it('shares concurrent work, resumes after page budget, and caches completed streams', async () => {
    const p = provider(), a = acquisition(p);
    const [one, same] = await Promise.all([a.acquire(range, 1), a.acquire(range, 1)]);
    expect(same).toEqual(one); expect(p.requests).toHaveLength(1); expect(one.status).toBe('partial');
    const done = await a.acquire(range); expect(done.status).toBe('complete'); expect(done.checkpoint.flows).toHaveLength(6);
    expect(done.firstObserved?.raw).toBe('100'); expect(done.firstEver).toBeNull();
    await a.acquire(range); expect(p.requests).toHaveLength(6);
  });
  it('retains accepted successful values on a missing page, then resumes the same cursor', async () => {
    let broken = true;
    const p = provider(page => page.stream === 'native_external' && page.sequence === 1 && broken ? { ...page, sequence: 2 } : page);
    const a = acquisition(p); const partial = await a.acquire(range);
    expect(partial.coverage.complete).toBe(false); expect(partial.checkpoint.flows.filter(f => f.stream === 'native_external')).toHaveLength(1);
    expect(partial.checkpoint.streams[0].cursor).toBe('page-1');
    broken = false; expect((await a.acquire(range)).status).toBe('complete');
    expect(p.requests.filter(r => r === 'native_external:0')).toHaveLength(1);
    expect(p.requests.filter(r => r === 'native_external:1')).toHaveLength(2);
  });
  it('resumes accepted evidence with a new acquisition instance and invalidates source/hash changes', async () => {
    const p = provider(), cache = new MemoryFundingCache();
    await acquisition(p, capability(), cache).acquire(range, 1);
    await acquisition(p, capability(), cache).acquire(range);
    expect(p.requests).toHaveLength(6);
    await acquisition(p, capability(), cache).acquire({ ...range, through: { ...range.through, blockHash: hash(900) } });
    expect(p.requests.length).toBeGreaterThan(6);
    const changed = { ...p, sourceRevision: 'candidate-2' };
    const result = await acquisition(changed, capability(), cache).acquire(range);
    expect(result.coverage.complete).toBe(false);
  });
  it('rejects terminal gaps, cursor cycles, wrong bounds, wrong order and conflicting values', async () => {
    const variants: ((p: FundingPage) => FundingPage)[] = [
      p => ({ ...p, nextCursor: null, intervalComplete: false }),
      p => p.sequence === 1 ? { ...p, nextCursor: 'page-1', intervalComplete: false } : p,
      p => ({ ...p, range: { ...p.range, through: { ...cursor, blockHash: hash(900) } } }),
      p => ({ ...p, flows: [flow(p.stream, 2), flow(p.stream, 1)] }),
      p => p.sequence === 1 ? { ...p, flows: [{ ...flow(p.stream), raw: '99' }] } : p,
    ];
    for (const v of variants) expect((await acquisition(provider(v)).acquire(range, 4)).coverage.complete).toBe(false);
  });
  it('filters failures/wraps, keeps unresolved settlement missing and quote coverage separate', async () => {
    const p = provider(page => ({ ...page, flows: [{ ...flow(page.stream, page.sequence + 1),
      transactionSuccessful: page.stream !== 'native_external', settlement: page.stream === 'quote' ? 'same_account_wrap' : 'external' }] }));
    const done = await acquisition(p).acquire(range);
    expect(done.checkpoint.flows.every(f => f.stream === 'native_internal')).toBe(true);
    expect(done.coverage.complete).toBe(true);
    const unknown = await acquisition(provider(page => ({ ...page, flows: page.flows.map(f => ({ ...f, settlement: 'unresolved' })) }))).acquire(range);
    expect(unknown.coverage.complete).toBe(false); expect(unknown.gaps).toContain('settlement_unresolved');
    const top = capability(); top.verifiedStreams = ['native_external', 'quote']; top.usable = false;
    const result = await acquisition(provider(), top).acquire(range);
    expect(result.coverage).toMatchObject({ topLevelNative: true, internalNative: false, quoteAssets: [quote], complete: false });
  });
  it('requires every source plus genesis/proved creation for first-ever, including a known empty interval', async () => {
    const a = acquisition(); expect((await a.acquire({ ...range, origin: { kind: 'proved_creation', evidenceHash: hash(500), noEarlierFunding: true } })).firstEver?.raw).toBe('100');
    expect(FundingRangeSchema.safeParse({ ...range, origin: { kind: 'genesis' } }).success).toBe(false);
    const fixture = testFundingCapability(source, ['native_external', 'native_internal', 'quote'], 'fixture', probes());
    const result = await acquisition(provider(), fixture).acquire({ ...range, origin: { kind: 'proved_creation', evidenceHash: hash(500), noEarlierFunding: true } });
    expect(result.firstEver).toBeNull(); expect(result.coverage.complete).toBe(false);
    const empty = await acquisition(provider(p => ({ ...p, flows: [] }))).acquire(range);
    expect(empty.coverage.complete).toBe(true); expect(empty.firstObserved).toBeNull(); expect(empty.coverage.firstEverEstablished).toBe(false);
  });
  it('publishes unavailable without an indexed source, rejects unverified quote assets, and bounds the cache', async () => {
    const p = provider(); const result = await acquisition(p, unavailableFundingCapability(source.sourceId, source.sourceRevision)).acquire(range);
    expect(result.status).toBe('unavailable'); expect(p.requests).toHaveLength(0);
    expect((await acquisition().acquire({ ...range, quoteAssets: [address(99)] })).coverage.complete).toBe(false);
    const cache = new MemoryFundingCache(1), a = acquisition(provider(), capability(), cache);
    await a.acquire(range);
    expect((await a.acquire({ ...range, origin: { kind: 'proved_creation', evidenceHash: hash(500), noEarlierFunding: true } })).coverage.complete).toBe(false);
  });
  it('conserves bigint units across launches and rejects later funding, wrong assets and duplicate conflicts', () => {
    const f = flow(), id = fundingFlowId(f), boughtAt = { ...f.cursor, transactionIndex: 5 };
    const ledger = new FundingValueLedger([f, f]);
    expect(ledger.consume(id, 90n, null, boughtAt)).toBe(10n);
    expect(() => ledger.consume(id, 11n, null, boughtAt)).toThrow();
    expect(() => ledger.consume(id, 1n, quote, boughtAt)).toThrow();
    expect(() => ledger.consume(id, 1n, null, f.cursor)).toThrow();
    expect(() => new FundingValueLedger([f, { ...f, raw: '101' }])).toThrow();
    expect(FundingFlowSchema.safeParse({ ...flow('native_internal'), position: 'call:0' }).success).toBe(false);
  });
});

describe('shared diagnostic preparation and independent cost accounting', () => {
  it('deduplicates overlapping/adjacent ranges and clips by approved cost and weighted checkpoint', () => {
    const intervals = [{ from: '100', through: '105' }, { from: '103', through: '110' }, { from: '111', through: '112' }, { from: '120', through: '122' }];
    expect(unionFundingIntervals(intervals)).toEqual([{ from: '100', through: '112' }, { from: '120', through: '122' }]);
    const plan = planFundingDiagnostic({ intervals, prices, approvalRef: 'fixture-approval', remainingCapNanoUsd: 10n * 24000n, remainingCheckpointUnits: 250000n });
    expect(plan).toMatchObject({ blocks: 10n, requestUnits: 40n, estimatedNanoUsd: 240000n, liveFundingComplete: false, nextBlock: '110' });
    expect(plan.selected).toEqual([{ from: '100', through: '109' }]);
    const weighted = planFundingDiagnostic({ intervals, prices: { ...prices, weights: { ...prices.weights, trace: 5n } },
      approvalRef: 'fixture-approval', remainingCapNanoUsd: 1000000000n, remainingCheckpointUnits: 16n });
    expect(weighted.blocks).toBe(2n); expect(weighted.categories.blockTraces).toBe(10n);
  });
  it('prepares no requests without recorded approval/pricing; unknown page pricing blocks admission', async () => {
    const plan = planFundingDiagnostic({ intervals: [{ from: '100', through: '110' }], prices, approvalRef: null, remainingCapNanoUsd: 1000000000n, remainingCheckpointUnits: 250000n });
    expect(plan.status).toBe('unavailable'); expect(plan.requestUnits).toBe(0n);
    expect(() => unionFundingIntervals([{ from: '5', through: '4' }])).toThrow();
    const meter = new FundingCostMeter({ ...prices, indexedPageNanoUsd: null }, 1000000000n, 'fixture-approval');
    await expect(meter.admitPage()).rejects.toThrow(); expect(meter.totalNanoUsd).toBe(0n);
    const capped = new FundingCostMeter(prices, 500000n, 'fixture-approval');
    await capped.admitPage(); await expect(capped.admitPage()).rejects.toThrow();
    expect(capped.counts.indexed_pages.calls).toBe(1);
  });
  it('counts actual fake RPC attempts through task-024, reuses traces and preserves failed/internal semantics', async () => {
    const f = traceFixture();
    f.root.value = '0x64'; f.transaction.value = '0x64';
    // A reverted subtree contains a superficially successful nested value transfer.
    f.root.calls!.push({ type: 'CALL', from: address(30), to: receiver, input: '0x', value: '0x64', error: 'revert',
      calls: [{ type: 'CALL', from: receiver, to: address(31), input: '0x', value: '0x64' }] });
    f.root.calls!.push({ type: 'DELEGATECALL', from: address(30), to: receiver, input: '0x', value: '0x64' });
    const fake = fakeAcquisition(f.responses), costs = new FundingCostMeter(prices, 1000000000n, 'fixture-approval');
    try {
      const before = (await fake.meter.usage()).today;
      const block = await fake.acquisition.acquire(cursor);
      costs.recordRpcDelta(before, (await fake.meter.usage()).today, 'acquisition');
      const native = fundingFromTraceBlock(block, []);
      expect(native.flows.some(f => f.stream === 'native_external' && f.raw === '100')).toBe(true);
      expect(native.flows.some(f => f.stream === 'native_internal')).toBe(true);
      expect(native.flows.some(f => f.to === receiver)).toBe(false);
      expect(costs.counts.confirmations.units).toBe(3); expect(costs.counts.block_traces.units).toBe(1);
      expect(costs.totalNanoUsd).toBe(24000n);
      await fake.acquisition.acquire(cursor); expect(fake.requests).toHaveLength(4);
    } finally { await fake.meter.close(); }
  });
  it('reconciles quote logs explicitly and suppresses wrap legs rather than inventing a funder', async () => {
    const f = traceFixture(), l = { address: quote, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: address(30), to: receiver } }),
      data: encodeAbiParameters(parseAbiParameters('uint256'), [100n]), position: 0 };
    f.root.calls!.push({ type: 'CALL', from: f.root.to!, to: quote, input: '0x', value: '0x0', logs: [l as never] });
    f.receipt.logs.push({ ...l, logIndex: '0x5', transactionHash: f.transaction.hash } as never);
    const fake = fakeAcquisition(f.responses);
    try {
      const block = await fake.acquisition.acquire(cursor);
      expect(fundingFromTraceBlock(block, [quote]).gaps).toContain('quote_settlement_unresolved');
      expect(fundingFromTraceBlock(block, [quote], () => 'same_account_wrap').flows.some(f => f.stream === 'quote')).toBe(false);
      expect(fundingFromTraceBlock(block, [quote], () => 'external').flows.filter(f => f.stream === 'quote')).toHaveLength(1);
    } finally { await fake.meter.close(); }
  });
  it('separates API pages, confirmations, weighted retries and Anvil upstream paid/public units', async () => {
    const meter = new FundingCostMeter(prices, 1000000000n, 'fixture-approval'); await meter.admitPage();
    meter.recordRpcDelta([], [{ provider: 'paid', method: 'debug_traceBlockByNumber', calls: 2, units: 10 },
      { provider: 'public', method: 'eth_getBlockByNumber', calls: 1, units: 1 }], 'acquisition');
    meter.recordRpcDelta([], [{ provider: 'paid', method: 'eth_getStorageAt', calls: 3, units: 3 }], 'anvil_upstream');
    expect(meter.counts.block_traces).toEqual({ calls: 2, units: 10, nanoUsd: 60000n });
    expect(meter.counts.confirmations.nanoUsd).toBe(0n); expect(meter.counts.anvil_upstream.nanoUsd).toBe(18000n);
    expect(meter.totalNanoUsd).toBe(578000n);
  });
});
