import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Log, type Transaction } from 'viem';
import { createFlapAdapter, decodeFlapResult, flapManifest } from '../src/index.js';
import { abiPullTargets } from '../src/abi-pull.js';
import { loadRegistry } from '../src/registry.js';
import provenance from './fixtures/flap/provenance.json' with { type: 'json' };

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const log = (topic = keccak256(toHex('unknown-event'))): Log => ({
  address: address(1), topics: [topic], data: '0x', blockNumber: 1n,
  blockHash: keccak256(toHex('fixture-block')), transactionHash: keccak256(toHex('fixture-tx')),
  transactionIndex: 0, logIndex: 0, removed: false,
});
const tx = { from: address(2), to: address(1) } as Transaction;

describe('Flap unsupported evidence gate', () => {
  it('exports an explicit unsupported manifest and no operational capabilities', () => {
    const adapter = createFlapAdapter();
    expect(adapter.id).toBe('flap');
    expect(adapter.addresses()).toEqual([]);
    expect(flapManifest).toMatchObject({ id: 'flap', chainId: 4663, status: 'unsupported',
      reason: 'portal_launch_abi_unverified', liveApproved: false, registryEntries: [], eventFragments: [] });
    expect(Object.values(flapManifest.capabilities).every(v => v === false)).toBe(true);
    for (const method of ['curveState', 'antiSnipe', 'quoteBuy', 'quoteSell', 'buildBuy', 'buildSell']) {
      expect(adapter).not.toHaveProperty(method);
    }
    expect(() => abiPullTargets(loadRegistry(), 'flap')).toThrow('No verified addresses');
  });

  it('does not promote observed trade or migration topics without launch evidence', () => {
    for (const observation of provenance.observations) {
      const input = log(observation.topic as `0x${string}`);
      expect(decodeFlapResult(input)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
      expect(createFlapAdapter().decode(input, tx)).toEqual([]);
    }
  });

  it('emits nothing for unknown, malformed, wrong-emitter or removed logs', () => {
    for (const input of [log(), { ...log(), topics: [] }, { ...log(), data: '0x1234' },
      { ...log(), address: address(3) }, { ...log(), removed: true }]) {
      expect(createFlapAdapter().decode(input as Log, tx)).toEqual([]);
    }
  });

  it('cannot create inferred events through replay, ordering or reorg inputs', () => {
    const adapter = createFlapAdapter();
    const first = log(), later = { ...log(), blockNumber: 2n, logIndex: 1 };
    const replacement = { ...first, blockHash: keccak256(toHex('replacement-block')) };
    for (const sequence of [[first, later], [later, first], [first, first], [first, replacement]]) {
      expect(sequence.flatMap(l => adapter.decode(l, tx))).toEqual([]);
    }
    expect(adapter.addresses()).toEqual([]);
  });

  it('keeps live observations distinct from neutral fixtures and bounded coverage', () => {
    expect(provenance.origin).toBe('live-public-read-only');
    expect(provenance.pin.blockNumber).toBe('79253769');
    expect(provenance.budget).toMatchObject({ rpcRequests: 8, webRequests: 13, paidRequests: 0, costUsd: 0 });
    expect(provenance.rpc.requests).toHaveLength(provenance.budget.rpcRequests);
    expect(provenance.sources).toHaveLength(provenance.budget.webRequests);
    expect(provenance.deployments.every(d => d.status === 'code-present-only' && d.codeBytes > 0 && /^0x[0-9a-f]{64}$/.test(d.codeHash))).toBe(true);
    const query = provenance.rpc.requests.find(r => r.method === 'eth_getLogs')!;
    const filter = query.params[0] as { fromBlock: string; toBlock: string };
    expect(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n).toBe(10000n);
    expect(provenance.sources.some(s => s.url.includes('blockscout') && s.status === 403)).toBe(true);
    expect(flapManifest.requiredEvidence.length).toBeGreaterThan(0);
  });
});
