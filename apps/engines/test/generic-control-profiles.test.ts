import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { binary, migrate, migrateEngines, GuardSourceStore, GuardMeasurementStore, guardManifestId, guardStorageHash, guardRowsKnownAt } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { ChainDb } from '@eko/db';
import { GenericControlFork, SerializedMeteredForkLease, inspectGenericControls, referenceDigest } from '@eko/chain';
import type { ControlProfile } from '@eko/chain';
import type { GuardStoredEvidence, GuardAvailabilityManifest } from '@eko/shared';
import { controlCardMeasurement, persistControlProfile, loadControlProfiles } from '../src/control-profiles.js';
import { projectCoinCardV2 } from '../../server/src/read/guard-card.js';
import { archiveFixture, forkFixture, coin, cursor, hash, timelock, recipeFor } from '../../../packages/chain/test/control-fixtures.js';

let db: ChainDb;
beforeAll(async () => {
  db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db);
  await db.insert('chain_blocks', { number: cursor.blockNumber, block: cursor.blockNumber, hash: binary(cursor.blockHash), parent_hash: binary(hash('synthetic-parent')), ts: new Date(Number(cursor.timestampSec) * 1000) });
}, 30000);
afterAll(async () => { await db?.close(); });
async function profile(options: { noOp?: boolean; delay?: number; inert?: boolean } = {}) {
  const fixture = archiveFixture({ inert: options.inert, roleContract: !!options.delay });
  const s = await inspectGenericControls(fixture.clients, { coin, cursor, launchpad: 'other', roleTargets: options.delay ? [timelock] : [] });
  const f = forkFixture(s, options);
  const plan = recipeFor(s, options.delay ? { authority: timelock, queue: { target: timelock, data: '0x12345678', value: '0' }, delaySec: options.delay } : {});
  return new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [plan]);
}
const cut = { cursor, acquisitionSequence: '1' };
const acquiredAt = '2026-10-02T00:00:00.000Z';
const read = (m: GuardAvailabilityManifest) => ({ coin, chainId: 4663, manifestId: m.id, state: cursor, availability: m.cut });
async function capture(sequence: number) {
  const key = { sourceId: 'synthetic-control-capture', sourceRevision: guardStorageHash({ sequence }), replayMode: 'production' as const,
    cut: { cursor, acquisitionSequence: String(sequence) }, watermark: cursor };
  const m = { ...key, id: guardManifestId(key), acquiredAt }; await new GuardSourceStore(db).putManifest(m);
  const content = new TextEncoder().encode(JSON.stringify({ fixture: 'reviewed-effect-only', sequence })), digest = keccak256(toHex(content));
  const row: GuardStoredEvidence = { chainId: 4663, coin, manifestId: m.id, sourceRevision: m.sourceRevision, sourceItemId: 'synthetic-control-review',
    cursor, knownAt: m.cut, acquiredAt, methodVersion: '2.1.0', dependencyIds: [],
    evidence: { id: digest, kind: 'state', cursor, knownAt: m.cut, payloadHash: digest, objectRef: digest, supersedes: null } };
  const review = await new GuardSourceStore(db).putEvidence(row, content);
  return { m, reviewId: review.id as `0x${string}` };
}
function withReview(p: ControlProfile, reviewId: `0x${string}`) {
  const body = { schemaVersion: p.schemaVersion, inspection: p.inspection, confirmations: p.confirmations.map(c => ({ ...c, recipe: { ...c.recipe, reviewEvidenceIds: [reviewId] } })) };
  return { ...body, id: referenceDigest(body) };
}

describe('069 typed capability projection and captured storage', () => {
  it('feeds the existing card adapter with changed-state positives and unknown untested powers', async () => {
    const p = await profile(), measurement = controlCardMeasurement(p, cut, p.id);
    const content = new TextEncoder().encode(JSON.stringify(measurement)), digest = keccak256(toHex(content));
    const card = projectCoinCardV2({ coin, cursor, cut, servedAtSec: 1001, name: 'Sample Token', symbol: 'DEMO',
      assessment: null, legacy: null, legacyRulesVersion: null, launch: null,
      measurements: [{ content: measurement, evidence: { id: p.id, kind: 'state', cursor, knownAt: cut, payloadHash: digest, objectRef: digest, supersedes: null } }] });
    expect(card.control.powers.find(p => p.capability === 'tax_raise')).toMatchObject({ reachable: { status: 'observed', value: true }, delaySec: { status: 'observed', value: '0' }, boundCode: 'unknown' });
    expect(card.control.powers.filter(p => p.capability !== 'tax_raise').every(p => p.reachable.status === 'unknown')).toBe(true);
    expect(card.control.currentController.status).toBe('unknown');
    expect(card.verdict).toBeNull(); expect(card.jobs?.find(j => j.kind === 'controls_hooks')?.status).toBe('missing');
    const later = projectCoinCardV2({ coin, cursor: { ...cursor, blockNumber: '101', timestampSec: '1001', blockHash: hash('later') }, cut: { cursor: { ...cursor, blockNumber: '101', timestampSec: '1001', blockHash: hash('later') }, acquisitionSequence: '2' }, servedAtSec: 1001,
      name: null, symbol: null, assessment: null, legacy: null, legacyRulesVersion: null, launch: null,
      measurements: [{ content: measurement, evidence: { id: p.id, kind: 'state', cursor, knownAt: cut, payloadHash: digest, objectRef: digest, supersedes: null } }] });
    expect(later.control.powers.every(p => p.reachable.status === 'unknown')).toBe(true);
  });
  it('never certifies absence from no-op setters or inert ownership', async () => {
    for (const options of [{ noOp: true }, { inert: true }]) {
      const p = await profile(options); const m = controlCardMeasurement(p, cut, p.id);
      expect(m.control?.powers?.every(p => p.reachable.status === 'unknown')).toBe(true);
    }
  });
  it.each([1800, 7200])('keeps timelocked %i-second capability time as a proved upper bound', async delay => {
    const p = await profile({ delay }); const power = controlCardMeasurement(p, cut, p.id).control!.powers![0];
    expect(power.reachable.value).toBe(true); expect(power.delaySec).toMatchObject({ status: 'upper_bound', value: String(delay) });
    expect(power.earliestExecution).toMatchObject({ status: 'upper_bound', value: String(1000 + delay) });
    expect(power.bound.status).toBe('unknown');
  });
  it('stores immutable versioned profiles plus adapter measurements, supersedes and cascades invalidation', async () => {
    const first = await capture(1), p1 = withReview(await profile(), first.reviewId);
    const ids1 = await persistControlProfile(db, p1, { manifest: first.m, knownAt: first.m.cut, acquiredAt, dependencyIds: [first.reviewId] });
    expect(await loadControlProfiles(db, read(first.m))).toEqual([p1]);
    expect(await persistControlProfile(db, p1, { manifest: first.m, knownAt: first.m.cut, acquiredAt, dependencyIds: [first.reviewId] })).toEqual(ids1);
    const next = await capture(2), p2 = withReview(await profile({ noOp: true }), next.reviewId);
    const ids2 = await persistControlProfile(db, p2, { manifest: next.m, knownAt: next.m.cut, acquiredAt, dependencyIds: [next.reviewId], previous: ids1 });
    expect(ids1.profileId).not.toBe(ids2.profileId);
    expect(await loadControlProfiles(db, read(next.m))).toEqual([p2]);
    const rows = await guardRowsKnownAt<GuardStoredEvidence>(db, 'guard_measurement_evidence', read(next.m));
    const projected = rows.find(r => r.id === ids2.measurementId)!;
    expect(projected.dependency_ids).toContain(ids2.profileId);
    // Relevant configuration/review replacement invalidates dependent profiles and projections without deleting history.
    const event = { causeId: hash('synthetic-configuration-replaced'), knownAt: next.m.cut, recordedAt: acquiredAt };
    const replacement = await capture(3);
    await new GuardSourceStore(db).supersede(next.reviewId, replacement.reviewId, { ...event, knownAt: replacement.m.cut });
    await new GuardMeasurementStore(db).invalidateDependencies({ ...event, knownAt: replacement.m.cut });
    const events = (await db.sql.query<{ target_id: string }>('SELECT target_id FROM guard_measurement_events')).rows;
    expect(events.some(e => e.target_id === ids2.profileId)).toBe(true);
    expect(events.some(e => e.target_id === ids2.measurementId)).toBe(true);
    expect(await loadControlProfiles(db, read(replacement.m))).toEqual([]);
    await new GuardMeasurementStore(db).invalidateReorg({ chainId: 4663, fromBlock: '100', causeId: hash('synthetic-reorg'), knownAt: next.m.cut, recordedAt: acquiredAt });
    expect(await loadControlProfiles(db, read(next.m))).toEqual([]);
  });
  it('refuses uncaptured review dependencies, future availability and corrupt profile identity', async () => {
    const current = await capture(4), p = await profile();
    await expect(persistControlProfile(db, p, { manifest: current.m, knownAt: current.m.cut, acquiredAt, dependencyIds: [] })).rejects.toThrow('dependencies');
    expect(() => controlCardMeasurement({ ...p, id: hash('corrupt') }, cut, p.id)).toThrow('hash');
    expect(() => controlCardMeasurement(p, { cursor: { ...cursor, blockNumber: '99' }, acquisitionSequence: '0' }, p.id)).toThrow('availability');
  });
});
