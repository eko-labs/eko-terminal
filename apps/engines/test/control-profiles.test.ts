import { describe, expect, it, vi } from 'vitest';
import { migrate, migrateEngines, binary, GuardSourceStore, GuardMeasurementStore, guardManifestId, guardRowsKnownAt } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { GUARD_CAPABILITIES } from '@eko/shared';
import type { GuardStoredEvidence } from '@eko/shared';
import { assessPonsControlProfile, controlProfileHash, controlStateFingerprint, controlCardMeasurements, type PonsControlInput, type ReviewedPonsTemplate } from '../src/control-profile.js';
import { runControlProbes, persistPonsControlProfile, acquirePonsGetterObservations, type ControlForkLease } from '../src/control-acquisition.js';
import { appendControlProfileObservations } from '../src/control-observations.js';
import { input as scoreInput, address, hash } from '../../../packages/playbooks/test/scoring-fixtures.js';
import { evaluateGuardV2 } from '@eko/playbooks';

/** Synthetic permission/config/effect fixtures; no deployed Pons implementation has been reviewed by these tests. */
function fixture(): { i: PonsControlInput; t: ReviewedPonsTemplate } {
  const cursor = scoreInput().cursor, knownAt = scoreInput().availabilityCut, coin = address(1), ids = [hash(1)];
  const verified = (n: number) => ({ status: 'verified' as const, address: address(n), codeHash: hash(n), evidenceIds: ids });
  const absent = { status: 'absent' as const, address: null, codeHash: null, evidenceIds: ids };
  const i: PonsControlInput = { schemaVersion: 'pons-control-input-2', origin: 'fixture', coin, decimals: 18, launchpad: 'pons', cursor, knownAt,
    pins: { token: verified(1), curve: verified(2), proxy: absent, implementation: verified(1), hook: absent, locker: absent,
      authorityHash: hash(20), authorityEvidenceIds: ids },
    configuration: { launchConfigId: '7', launchedAtSec: '10', decayEndSec: '19', decayPolicyHash: hash(21), feePolicyHash: hash(22),
      recipientScheduleHash: hash(23), configurationHash: hash(24), evidenceIds: ids },
    getters: { creatorTaxBps: '233', feeBps: '173', currentSnipeTaxBps: '0', launchedAtSec: '10', evidenceIds: ids },
    permissionCoverageComplete: true, probes: [], charges: [], evidenceIds: ids };
  const stateFingerprint = controlStateFingerprint(i);
  i.probes = GUARD_CAPABILITIES.map(capability => ({ capability, stateFingerprint, authority: address(3), permissionPathHash: hash(30),
    boundCode: 'absent', bound: null, delaySec: '0', earliestExecutionSec: cursor.timestampSec, revocable: false, queued: false, releaseUnits: null,
    success: false, beforeHash: hash(40), afterHash: hash(40), transactionHash: hash(41), absenceReviewed: true, evidenceIds: ids }));
  for (const accountClass of ['eoa', 'smart_account'] as const) for (const direction of ['buy', 'sell'] as const)
    i.charges.push({ direction, stateFingerprint, account: address(accountClass === 'eoa' ? 4 : 5), accountClass,
      sizeQuoteUnits: '1000', quoteAsset: address(0), quoteDebitUnits: direction === 'buy' ? '1000' : '0',
      reserveDeltaUnits: direction === 'buy' ? '940' : '1000', quoteCreditUnits: direction === 'sell' ? '940' : '0',
      payouts: [{ recipient: address(6), units: '60' }], breakdown: { ordinary: null, creator: null, temporary: null, hook: null }, evidenceIds: ids });
  const t: ReviewedPonsTemplate = { schemaVersion: 'pons-template-2', coin, origin: 'fixture', reviewed: true,
    stateFingerprint, sourceRevision: hash(60), evidenceIds: ids };
  return { i, t };
}
function power(i: PonsControlInput, cap: string) { return i.probes.find(p => p.capability === cap)!; }
const check = (s: ReturnType<typeof assessPonsControlProfile>, id: string) => s.checks.find(c => c.id === id)!;

describe('039 pinned effective profiles (offline fixtures)', () => {
  it('accepts exact reviewed pins; unknown template and generic code never inherit', () => {
    const { i, t } = fixture(), s = assessPonsControlProfile(i, t);
    expect(s.control.powers.every(p => p.reachable.value === false && p.boundCode === 'absent')).toBe(true);
    expect(s.checks.every(c => c.status === 'complete')).toBe(true);
    for (const input of [i, { ...i, launchpad: 'other' as const }, { ...i, coin: address(9), pins: { ...i.pins, token: { ...i.pins.token, address: address(9) } } }]) {
      const unknown = assessPonsControlProfile(input, input === i ? undefined : t);
      expect(check(unknown, 'controls_hooks').status).toBe('unsupported');
      expect(unknown.control.powers.every(p => p.reachable.value === null)).toBe(true);
    }
  });
  it.each(['token', 'curve', 'proxy', 'implementation', 'hook', 'locker'] as const)('invalidates on changed %s pin', role => {
    const { i, t } = fixture(); i.pins[role] = { status: 'verified', address: address(99), codeHash: hash(99), evidenceIds: [hash(1)] };
    if (role === 'token') i.pins[role].address = i.coin;
    const s = assessPonsControlProfile(i, t); expect(s.templateRevision).toBeNull(); expect(check(s, 'effective_fees').status).toBe('unsupported');
  });
  it('invalidates config/authority/getter changes and unreviewed decay', () => {
    for (const change of ['config', 'authority', 'getter', 'decay']) {
      const { i, t } = fixture();
      if (change === 'config') i.configuration.configurationHash = hash(98);
      if (change === 'authority') i.pins.authorityHash = hash(98);
      if (change === 'getter') i.getters.feeBps = '200';
      if (change === 'decay') i.configuration.decayEndSec = null;
      expect(assessPonsControlProfile(i, t).checks.every(c => c.status === 'unsupported')).toBe(true);
    }
  });
  it('a no-op setter/getter and missing powers stay unknown, even if success is reported', () => {
    const { i, t } = fixture(), p = power(i, 'tax_raise'); p.success = true; p.boundCode = 'unrestricted';
    let s = assessPonsControlProfile(i, t); expect(s.control.powers[0].reachable.value).toBeNull();expect(check(s, 'effective_fees').status).toBe('unsupported');
    p.success = false; p.boundCode = 'absent'; p.absenceReviewed = false;
    expect(assessPonsControlProfile(i, t).control.powers[0].reachable.value).toBeNull();
    i.probes = []; s = assessPonsControlProfile(i, t); expect(s.control.powers).toHaveLength(8);
    expect(s.control.powers.every(p => p.reachable.value === null)).toBe(true);
  });
  it('records bounded, unrestricted and queued effects; horizon-external unlocks stay visible without current-float changes', () => {
    const { i, t } = fixture(), now = BigInt(i.cursor.timestampSec), mint = power(i, 'mint'), unlock = power(i, 'unlock');
    Object.assign(mint, { success: true, afterHash: hash(42), boundCode: 'unrestricted', bound: null, releaseUnits: '12', queued: true,
      delaySec: '3600', earliestExecutionSec: (now + 3600n).toString() });
    Object.assign(unlock, { success: true, afterHash: hash(43), boundCode: 'bounded', bound: '800', releaseUnits: '800', queued: true,
      delaySec: '3601', earliestExecutionSec: (now + 3601n).toString() });
    const s = assessPonsControlProfile(i, t);
    expect(s.control.releasableByHorizon.value?.raw).toBe('12');
    expect(s.control.queuedChanges).toHaveLength(2); expect(s.control.powers.find(p => p.capability === 'unlock')?.boundCode).toBe('bounded');
    expect(s).not.toHaveProperty('supply');
    expect(assessPonsControlProfile(i, t, 3601).control.releasableByHorizon.value?.raw).toBe('812');
  });
  it('reconciles effective total despite unknown decomposition and nonstandard getter fees', () => {
    const { i, t } = fixture(), s = assessPonsControlProfile(i, t);
    expect(s.charges.every(q => q.fees.total.value === '6' && q.fees.creator.value === null)).toBe(true);
    expect(check(s, 'effective_fees').status).toBe('complete'); expect(s.getters.feeBps).toBe('173');
    i.charges[0].payouts[0].units = '61';
    expect(check(assessPonsControlProfile(i, t), 'effective_fees').status).toBe('unsupported');
  });
  it('rejects inconsistent breakdown, missing direction/class and stale fork evidence', () => {
    const { i, t } = fixture(); i.charges[0].breakdown.creator = '61';
    expect(check(assessPonsControlProfile(i, t), 'effective_fees').status).toBe('unsupported');
    i.charges[0].breakdown.creator = null; i.charges.pop();
    expect(check(assessPonsControlProfile(i, t), 'effective_fees').status).toBe('unsupported');
    power(i, 'mint').stateFingerprint = hash(90);
    expect(check(assessPonsControlProfile(i, t), 'controls_hooks').status).toBe('unsupported');
  });
  it('runs actual fixture mutations serially with isolated reset and detects a no-op effective read', async () => {
    const { i, t } = fixture(); let state = 0;
    const lease: ControlForkLease = { reset: vi.fn(async () => { state = 0; }), fingerprint: async () => controlStateFingerprint(i),
      readEffect: async () => ({ balance: state }), execute: vi.fn(async ({ data }) => {
        if (data === '0x01') state = 100;
        return { success: true, transactionHash: hash(99), evidenceIds: [hash(1)] };
      }), close: vi.fn(async () => {}) };
    const plans = (['mint', 'tax_raise'] as const).map(capability => ({ capability, authority: address(3), permissionPathHash: hash(20),
      boundCode: 'unrestricted' as const, bound: null, delaySec: '0', earliestExecutionSec: i.cursor.timestampSec, revocable: false, queued: false,
      releaseUnits: null, absenceReviewed: false, target: i.coin, data: (capability === 'mint' ? '0x01' : '0x00') as `0x${string}`, value: '0' }));
    const probes = await runControlProbes(lease, i, plans);
    expect(lease.reset).toHaveBeenCalledTimes(2); expect(lease.close).toHaveBeenCalledTimes(1);
    i.probes = [...i.probes.filter(p => !plans.some(plan => plan.capability === p.capability)), ...probes];
    const s = assessPonsControlProfile(i, t);
    expect(s.control.powers.find(p => p.capability === 'mint')?.reachable.value).toBe(true);
    expect(s.control.powers.find(p => p.capability === 'tax_raise')?.reachable.value).toBeNull();
    await expect(runControlProbes({ ...lease, fingerprint: async () => hash(999) }, i, plans)).rejects.toThrow('mismatch');
  });
  it('does not complete shadow checks from fixtures; measured-envelope fixture tests bind profiles and horizon scoring', () => {
    const { i, t } = fixture(), scoring = scoreInput([]); scoring.checks = [];
    appendControlProfileObservations(scoring, assessPonsControlProfile(i, t), hash(70)); expect(scoring.checks).toHaveLength(0);
    // Synthetic transport is relabelled only to exercise the measured-envelope integration branch.
    i.origin = t.origin = 'measured'; Object.assign(power(i, 'mint'), { success: true, afterHash: hash(42), boundCode: 'unrestricted',
      delaySec: '3601', earliestExecutionSec: (BigInt(i.cursor.timestampSec) + 3601n).toString() });
    const s = assessPonsControlProfile(i, t); appendControlProfileObservations(scoring, s, hash(70));
    expect(scoring.profileHash).toBe(s.profileHash); expect(scoring.checks).toHaveLength(2);
    expect(evaluateGuardV2(scoring).assessment.baseScore).toBe(0);
    expect(() => appendControlProfileObservations(scoring, s, hash(70))).toThrow('Ambiguous');
    const corrupt = { ...s, profileHash: hash(999) }; expect(() => appendControlProfileObservations(scoreInput([]), corrupt, hash(70))).toThrow('hash');
  });
  it('within-horizon unrestricted capability scores shadow High; unknown revocability cannot complete it', () => {
    const { i, t } = fixture(); i.origin = t.origin = 'measured';
    Object.assign(power(i, 'mint'), { success: true, afterHash: hash(42), boundCode: 'unrestricted', delaySec: '3600',
      earliestExecutionSec: (BigInt(i.cursor.timestampSec) + 3600n).toString() });
    const scoring = scoreInput([]); scoring.checks = [];
    appendControlProfileObservations(scoring, assessPonsControlProfile(i, t), hash(70));
    expect(evaluateGuardV2(scoring).assessment).toMatchObject({ mode: 'shadow', level: 'high', baseScore: 60 });
    power(i, 'mint').revocable = null;
    expect(check(assessPonsControlProfile(i, t), 'controls_hooks').status).toBe('unsupported');
  });
  it('persists append-only measured envelopes and invalidates dependent profiles; fixtures cannot enter that store', async () => {
    const db = await openDb({ pgliteDir: ':memory:' });
    try {
      await migrate(db); await migrateEngines(db);
      const { i, t } = fixture(), key = { sourceId: 'profile-fixture', sourceRevision: hash(80), replayMode: 'production' as const,
        cut: i.knownAt, watermark: i.cursor }, manifest = { ...key, id: guardManifestId(key), acquiredAt: '2026-10-02T00:00:00.000Z' };
      const context = { manifest, acquiredAt: manifest.acquiredAt, dependencyIds: [hash(1)] };
      await expect(persistPonsControlProfile(db, i, t, context)).rejects.toThrow('Fixture');
      i.origin = t.origin = 'measured'; await new GuardSourceStore(db).putManifest(manifest);
      await db.insert('chain_blocks', { number: i.cursor.blockNumber, block: i.cursor.blockNumber, hash: binary(i.cursor.blockHash),
        parent_hash: binary(hash(79)), ts: new Date(Number(i.cursor.timestampSec) * 1000) });
      const content = new TextEncoder().encode('synthetic source proof'), payloadHash = controlProfileHash('synthetic source proof');
      // Guard payloads hash raw bytes; the returned source row ID is the dependency, distinct from its payload hash.
      const { keccak256, toHex } = await import('viem'), digest = keccak256(toHex(content));
      const leaf = await new GuardMeasurementStore(db).putEvidence({ chainId: 4663, coin: i.coin, manifestId: manifest.id,
        sourceRevision: manifest.sourceRevision, sourceItemId: 'profile-fixture-proof', cursor: i.cursor, knownAt: i.knownAt,
        acquiredAt: manifest.acquiredAt, methodVersion: '2.0.0', dependencyIds: [],
        evidence: { id: payloadHash, kind: 'state', cursor: i.cursor, knownAt: i.knownAt, payloadHash: digest, objectRef: digest, supersedes: null } }, content);
      const replace = (value: unknown): unknown => Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ?
        Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'evidenceIds' || k === 'authorityEvidenceIds' ? [leaf.id] : replace(v)])) : value;
      const measured = replace(i) as PonsControlInput, reviewed = replace(t) as ReviewedPonsTemplate;
      const fingerprint = controlStateFingerprint(measured); reviewed.stateFingerprint = fingerprint;
      measured.probes.forEach(p => { p.stateFingerprint = fingerprint; }); measured.charges.forEach(q => { q.stateFingerprint = fingerprint; });
      const recorded = await persistPonsControlProfile(db, measured, reviewed, { ...context, dependencyIds: [leaf.id as `0x${string}`] });
      expect(recorded.snapshot.checks.every(c => c.status === 'complete')).toBe(true);
      expect(controlCardMeasurements(recorded.snapshot).control!.powers).toHaveLength(8);
      expect(recorded.cardStored.data.dependencyIds).toEqual([recorded.stored.id]);
      expect((await db.sql.query('SELECT * FROM code_templates')).rows).toHaveLength(1);
      const cut = { chainId: 4663, coin: i.coin, manifestId: manifest.id, state: i.cursor, availability: i.knownAt };
      expect((await guardRowsKnownAt<GuardStoredEvidence>(db, 'guard_measurement_evidence', cut)).map(r => r.id)).toContain(recorded.stored.id);
      await new GuardMeasurementStore(db).invalidateReorg({ chainId: 4663, fromBlock: i.cursor.blockNumber, causeId: hash(90),
        knownAt: i.knownAt, recordedAt: manifest.acquiredAt });
      expect(await guardRowsKnownAt(db, 'guard_measurement_evidence', cut)).toEqual([]);
    } finally { await db.close(); }
  }, 30000);
  it('bounded getter acquisition rechecks code/block pins and observes launch time without assumed decay', async () => {
    const { i } = fixture(), calls: string[] = [];
    const archive = { getBlock: async () => { calls.push('block'); return { hash: i.cursor.blockHash, timestamp: BigInt(i.cursor.timestampSec) }; },
      getCode: async () => { calls.push('code'); return '0x6000'; }, readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName); return functionName === 'launchedAt' ? 10n : 173n;
      } };
    const result = await acquirePonsGetterObservations({ archive } as unknown as Parameters<typeof acquirePonsGetterObservations>[0], i.coin, address(2), i.cursor);
    expect(calls).toHaveLength(8); expect(result.getters.feeBps).toBe('173'); expect(result.getters.launchedAtSec).toBe('10');
    expect(result).not.toHaveProperty('decayEndSec');
  });
});
