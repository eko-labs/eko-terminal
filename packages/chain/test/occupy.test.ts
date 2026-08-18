import { describe, expect, it } from 'vitest';
import { toEventSelector, type AbiEvent, type Address, type Log, type Transaction } from 'viem';
import { createOccupyAdapter, decodeOccupyResult, occupyManifest, loadRegistry, ponsFactoryAbi, erc20Abi } from '../src/index.js';
import provenance from './fixtures/4663/occupy/provenance.json';

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const tx = { from: address(1), to: address(2) } as Transaction;
const log: Log = { address: address(2), topics: [`0x${'ab'.repeat(32)}`], data: '0x', blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false };

describe('Occupy unsupported manifest, synthetic behavior only', () => {
  it('exports an unavailable adapter without addresses, reads or execution', () => {
    const adapter = createOccupyAdapter();
    expect(adapter.id).toBe('occupy');
    expect(adapter.addresses()).toEqual([]);
    for (const key of ['curveState', 'antiSnipe', 'quoteBuy', 'quoteSell', 'buildBuy', 'buildSell']) expect(adapter).not.toHaveProperty(key);
    expect(occupyManifest.status).toBe('unsupported');
    expect(occupyManifest.coverage).toEqual({ launch: false, trade: false, migration: false, curveState: false, quotes: false, control: false, custody: false, execution: false });
    expect(occupyManifest.supportedEvents).toEqual([]);
    expect(occupyManifest.supportedCalls).toEqual([]);
    expect(occupyManifest.backfill).toMatchObject({ enabled: false, phase: 'B', recentDays: 30, maxLogRangeBlocks: 10000 });
    for (const key of ['virtuals.bondingCurve', 'virtuals.VIRTUAL'] as const) expect(loadRegistry().addressOf(key)).toBeNull();
  });

  it('counts unknown and malformed-looking inputs without guessing an ABI', () => {
    const inputs: Log['topics'][] = [log.topics, [], [toEventSelector(ponsFactoryAbi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'TokenLaunched')!)], [toEventSelector(erc20Abi[0])]];
    for (const topics of inputs) {
      expect(decodeOccupyResult({ ...log, topics }, tx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
      expect(createOccupyAdapter().decode({ ...log, topics }, tx)).toEqual([]);
    }
  });

  it('does not manufacture events on replay, removed logs or a replacement fork', () => {
    const adapter = createOccupyAdapter();
    for (const input of [log, log, { ...log, removed: true }, { ...log, blockHash: `0x${'cd'.repeat(32)}` as const }]) expect(adapter.decode(input, tx)).toEqual([]);
  });

  it('separates failed public acquisition from synthetic fixtures and live evidence', () => {
    expect(provenance.requests).toMatchObject({ rpc: 1, web: 4, paidCost: 0, logRanges: [] });
    expect(provenance.liveEvidence).toMatchObject({ chainIdVerified: false, blockNumber: null, blockHash: null, transactionHashes: [], codeHashes: [], abi: null, logs: [] });
    expect(provenance.fixtureEvidence.origin).toBe('synthetic');
    expect(provenance.sources).toHaveLength(5);
    expect(occupyManifest.gaps).toEqual(expect.arrayContaining(['factory', 'template', 'event_abi', 'quote_asset', 'control', 'custody', 'execution']));
  });
});
