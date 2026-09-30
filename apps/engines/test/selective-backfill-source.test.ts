import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256 } from 'viem';
import { atomicPilotJson } from '../src/coverage-pilot-store.js';
import { PONS_LAUNCH_TOPIC } from '../src/launch-enumeration.js';
import { selectiveBackfillMain } from '../src/selective-backfill-cli.js';
import { BackfillAttemptStore, backfillMethodWeights, logRangeLimited } from '../src/selective-backfill-source.js';
import { SelectiveBackfillManifestSchema, initialBackfillCheckpoint, runSelectiveBackfill,
  type BackfillIO, type SelectiveBackfillManifest } from '../src/selective-backfill.js';
import { D, DAY, FACTORY, addr, candidate, cursorAt, dispatched, hash, hourlyTimestamps, measuredBudget, measuredRun, owner,
  syntheticChain } from './backfill-chain-fixtures.js';

const coin = addr(0x400), transfer = hash(0x800);
/** One launch at D+6h with token logs inside and after its seven-day follow-up. */
function pilotChain() {
  return syntheticChain(hourlyTimestamps(), [{ block: 30, token: coin }, { block: 50, token: addr(0x401) }],
    { extraLogs: [{ block: 31, address: coin, topics: [transfer] }, { block: 100, address: coin, topics: [transfer] },
      { block: 24 + 7 * 24, address: coin, topics: [transfer] }] });
}
function pilotManifest(chain: ReturnType<typeof syntheticChain>, budget = measuredBudget()): SelectiveBackfillManifest {
  const watermark = cursorAt(chain, chain.head), creation = cursorAt(chain, 30);
  return SelectiveBackfillManifestSchema.parse({ version: 'selective-backfill-048.1', validation: 'measured', sourceRevision: hash(0x900),
    availability: { id: hash(0x901), sourceId: 'sample-launch-source', sourceRevision: hash(0x900), replayMode: 'retrospective',
      cut: { cursor: watermark, acquisitionSequence: '0' }, watermark, acquiredAt: '2026-10-19T00:00:00Z' },
    startSec: String(D), mode: 'pilot7', historyMetadata: false, metadataFilters: [{ addresses: [FACTORY], topics: [PONS_LAUNCH_TOPIC] }],
    selected: [{ launch: { coin, creation, knownAt: { cursor: creation, acquisitionSequence: '0' } }, untilSec: String(D + 7 * DAY),
      filters: [{ addresses: [coin], topics: [transfer] }], reason: 'sample' }], budget });
}
async function backfill(chain: ReturnType<typeof syntheticChain>, m: SelectiveBackfillManifest) {
  const run = measuredRun(chain, m.budget), result = await runSelectiveBackfill(m, initialBackfillCheckpoint(m, candidate, owner), run.start().io, candidate, owner);
  return { result, run, checkpoint: run.persisted()! };
}

describe('measured source for the selective backfill', () => {
  it('reconstructs a selected launch from measured headers, logs and parent state, metering the second state read', async () => {
    const chain = pilotChain(), { result, run, checkpoint } = await backfill(chain, pilotManifest(chain));
    expect(result).toMatchObject({ status: 'complete', enumerationComplete: true, validation: 'measured' });
    expect(result.launches.map(l => l.coin)).toEqual([coin, addr(0x401)]);
    expect(result.selected).toEqual([expect.objectContaining({ coin, from: '30', through: String(24 + 7 * 24 - 1), complete: true })]);
    const state = run.artifacts.get(result.selected[0].boundaryKey);
    expect(state).toMatchObject({ kind: 'boundary', cursor: cursorAt(chain, 29), methodVersion: '1.0.0',
      state: { codeHash: keccak256('0x'), codeBytes: 0, nativeBalanceRaw: '42' } });
    const tape = run.artifacts.get(result.selected[0].ranges[0].artifactKey);
    expect(tape?.kind === 'logs' && tape.events.map(e => e.cursor.blockNumber)).toEqual(['31', '100']); // follow-up end is exclusive
    expect(chain.calls.filter(c => ['eth_getCode', 'eth_getBalance'].includes(c.method)).map(c => c.params))
      .toEqual([[coin, '0x1d'], [coin, '0x1d']]);
    expect(checkpoint.requests.find(r => r.request.kind === 'boundary')?.extra).toEqual(['boundary']);
    expect(checkpoint.calls).toBe(chain.calls.length); expect(new Set(dispatched(chain)).size).toBe(chain.calls.length);
    expect(result.rpcNanoUsd).toBe(String(chain.calls.length * 6000));
  });
  it('records a provider state-read failure as missing boundary state and never as complete', async () => {
    const chain = pilotChain();
    chain.setFault(r => { if (r.method === 'eth_getBalance') throw new Error('missing trie node'); return undefined; });
    const { result } = await backfill(chain, pilotManifest(chain));
    expect(result).toMatchObject({ status: 'stopped', reason: 'coverage_gaps' });
    expect(result.gaps).toEqual([{ scope: coin, reason: 'boundary_unavailable', from: '29', through: '29' }]);
    expect(result.selected[0].complete).toBe(false);
  });
  it('requires a metered source for measured manifests and refuses unbound, public or unpriced attempts', async () => {
    const chain = pilotChain(), m = pilotManifest(chain), io = measuredRun(chain, m.budget).start().io;
    const unmetered: BackfillIO = { ...io, bindAttempts: undefined };
    expect(await runSelectiveBackfill(m, initialBackfillCheckpoint(m, candidate, owner), unmetered, candidate, owner))
      .toMatchObject({ status: 'failed', reason: 'acquisition_failed' });
    expect(chain.calls).toHaveLength(0);
    const store = new BackfillAttemptStore(backfillMethodWeights(m.budget.weights)), admit = vi.fn(async () => {});
    expect(await store.reserve('2026-10-19', 'paid', 'eth_getLogs', 1)).toMatchObject({ allowed: false });
    expect(String(store.takeRefusal())).toContain('outside a backfill request');
    store.bind(admit);
    expect(await store.reserve('2026-10-19', 'public', 'eth_getLogs', 1)).toMatchObject({ allowed: false });
    expect(await store.reserve('2026-10-19', 'paid', 'debug_traceBlockByNumber', 1)).toMatchObject({ allowed: false });
    expect(await store.reserve('2026-10-19', 'paid', 'eth_getLogs', 1)).toEqual({ allowed: true, total: 1 });
    expect(admit).toHaveBeenCalledTimes(1); expect(admit).toHaveBeenCalledWith('logs');
    expect(await store.today('2026-10-19')).toEqual([{ provider: 'paid', method: 'eth_getLogs', calls: 1, units: 1 }]);
  });
  it('treats only size and range refusals as dense, never load or transport failures', () => {
    for (const text of ['query returned more than 10000 results', 'Log response size exceeded.', 'block range is too large',
      'exceed maximum block range: 100000', 'Request exceeds defined limit.']) expect(logRangeLimited(new Error(text))).toBe(true);
    for (const text of ['429 Too Many Requests', 'rate limit exceeded', 'request timed out', 'internal error', 'missing trie node',
      'execution reverted']) expect(logRangeLimited(new Error(text))).toBe(false);
  });
  it('starts the measured driver only with recorded approval, pricing and an endpoint from the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-048-measured-test-'));
    try {
      const chain = pilotChain(), m = pilotManifest(chain), path = join(dir, 'manifest.json');
      await atomicPilotJson(path, m);
      vi.stubEnv('RPC_HTTP_URL', '');
      await expect(selectiveBackfillMain(['--measured', path, join(dir, 'out')])).rejects.toThrow('RPC_HTTP_URL');
      await atomicPilotJson(path, { ...m, budget: { ...m.budget, approvalRef: null } });
      await expect(selectiveBackfillMain(['--measured', path, join(dir, 'out')])).rejects.toThrow('approval');
      await expect(selectiveBackfillMain(['--measured', path, join(dir, 'out'), '--max-minutes', '0'])).rejects.toThrow('Usage');
      expect(chain.calls).toHaveLength(0);
    } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  });
});
