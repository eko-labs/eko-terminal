import { describe, expect, it } from 'vitest';
import { getAddress, toEventSelector } from 'viem';
import { createKlikAdapter, decodeKlikResult, klikSupport } from '../src/index.js';
import { ponsFactoryAbi } from '../src/abis.js';
import { logOf } from './helpers.js';
import provenance from './fixtures/4663/klik-provenance.json' with { type: 'json' };

// Synthetic negative cases only; these are not Klik events or emitter evidence.
const emitter = getAddress(`0x${'ab'.repeat(20)}`);
const tx = { from: emitter, to: null };
const log = logOf({ address: emitter, topics: [toEventSelector(ponsFactoryAbi.find(item => item.type === 'event')!)], data: '0x' });

describe('Klik unsupported adapter', () => {
  it('registers through the existing interface with explicit unsupported coverage', () => {
    const adapter = createKlikAdapter();
    expect(adapter.id).toBe('klik');
    expect(adapter.addresses()).toEqual([]);
    expect(klikSupport).toMatchObject({ id: 'klik', chainId: 4663, status: 'unsupported', registryKeys: [], addresses: [], eventAbi: [], supportedEvents: [] });
    expect(Object.values(klikSupport.capabilities).every(value => value === false)).toBe(true);
    expect(klikSupport.recentBackfill).toEqual({ stream: 'logs:klik', status: 'unsupported', filters: [], coverageComplete: false });
    for (const method of ['curveState', 'antiSnipe', 'quoteBuy', 'quoteSell', 'buildBuy', 'buildSell']) expect(adapter).not.toHaveProperty(method);
  });

  it('rejects other ABIs, all unverified emitters and malformed data without throwing', () => {
    for (const candidate of [log, { ...log, address: getAddress(`0x${'cd'.repeat(20)}`) }, { ...log, topics: [] as [] }, { ...log, data: '0xff' as const }]) {
      expect(decodeKlikResult(candidate, tx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
      expect(createKlikAdapter().decode(candidate, tx)).toEqual([]);
    }
  });

  it('emits no ingest writes on duplicate replay, removed logs or a replacement block', () => {
    const adapter = createKlikAdapter();
    const original = { ...log, blockNumber: 123n, blockHash: `0x${'12'.repeat(32)}` as const };
    const replacement = { ...original, blockHash: `0x${'34'.repeat(32)}` as const };
    expect([original, original, { ...original, removed: true }, replacement].flatMap(l => adapter.decode(l, tx))).toEqual([]);
  });

  it('records bounded live attempts separately from synthetic decoder fixtures', () => {
    expect(provenance.evidenceKind).toBe('live-verification-attempt');
    expect(provenance.chainId).toBe(4663);
    expect(provenance.conclusion).toBe('unsupported');
    expect(provenance.requestCounts).toEqual({ rpc: 3, web: 3 });
    expect(provenance.requests.filter(r => r.method !== 'GET')).toHaveLength(3);
    expect(provenance.requests.filter(r => r.method === 'GET')).toHaveLength(3);
    expect(provenance.requests.find(r => r.method === 'eth_getBlockByNumber')?.result).toEqual(provenance.pinnedBlock);
    expect(provenance.deployment).toEqual({ factory: null, transactionHash: null, codeHash: null, abiSource: null, eventLogs: [] });
    expect(klikSupport.provenance).toBe('packages/chain/test/fixtures/4663/klik-provenance.json');
  });
});
