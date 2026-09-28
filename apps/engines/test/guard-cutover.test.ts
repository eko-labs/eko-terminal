import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hashing from 'viem';
import { referenceDigest } from '@eko/chain';
import { GUARD_GATE_IDS } from '@eko/playbooks';
import { GUARD_CHECK_IDS, GuardReceiptPayloadSchema, ReceiptItemSchema, Bytes32Schema,
  guardReceiptRevisionKey, createGuardReceiptCodec, canonicalize } from '@eko/shared';
import { resolveRepeat } from '@eko/policy';
import { guardBuyGate } from '../../../packages/policy/src/guard.js';
import { guardFixture, cachedGuard } from '../../../packages/policy/test/guard-fixtures.js';
import { policy, ASSET, NOW } from '../../../packages/policy/test/fixtures.js';
import proofs from '../../../packages/shared/test/fixtures/receipts/guard-v2.json';
import { liveShadowFixture } from './live-shadow-fixtures.js';
import { reportLiveShadowFixtures } from '../src/live-shadow.js';
import { GuardReleaseManifestSchema, SignalReleaseManifestSchema, GuardSwitchStateSchema,
  INACTIVE_GUARD_SWITCH, EMPTY_GUARD_RELEASE_INVENTORY, GUARD_CUTOVER_VERSION,
  GUARD_RELEASE_CONSUMERS, GUARD_RELEASE_VENUES, guardConsumerSwitch, verifyGuardConsumerAcks,
  prepareGuardSwitch, selectReleasedGuard as selectRecordedGuard, guardReleaseCacheKey, prepareGuardPolicySettings,
  type GuardReleaseManifest, type GuardSwitchState, type GuardReleaseInventory } from '../src/guard-cutover.js';

const hash = (n: number) => Bytes32Schema.parse(`0x${n.toString(16).padStart(64, '0')}`);
// All manifests, acceptance inventories and authorizations below are synthetic
// release-process doubles. They establish no measured acceptance or release.
function manifest(n = 63): GuardReleaseManifest {
  const a = guardFixture();
  return GuardReleaseManifestSchema.parse({ version: GUARD_CUTOVER_VERSION, kind: 'guard', origin: 'measured',
    status: 'accepted', chainId: 4663, pins: { sourceRevision: hash(n), codeHash: a.codeHash,
      parametersHash: a.parametersHash, serviceRegistryHash: a.serviceRegistryHash, profileHash: a.profileHash,
      calibrationManifestHash: a.calibrationManifestHash, datasetHash: hash(2), labelSetHash: hash(3),
      rulesVersion: a.rulesVersion, identityVersion: a.identityVersion, measurementVersion: a.measurementVersion,
      outcomeVersion: a.outcomeVersion }, acceptanceHash: hash(n + 1), lockedTestHash: hash(4), liveShadowHash: hash(5),
    compatibility: { legacyReadProofHash: hash(6), policyReplayHash: hash(7),
      consumers: GUARD_RELEASE_CONSUMERS.map(consumer => ({ consumer, artifactHash: hash(8) })) },
    attributionMethod: 'qualified_control_v2', lowerEnabled: true, historyEnabled: false, bucketsEnabled: false,
    factors: ['execution_cost'], decisive: ['sell_block'], checks: [...GUARD_CHECK_IDS],
    gates: GUARD_GATE_IDS.map(id => ({ id, passed: true, artifactHash: hash(9) })),
    coverage: GUARD_RELEASE_VENUES.flatMap(venue => ([100, 1000] as const).flatMap(sizeUsd =>
      (['eoa', 'smart_account'] as const).map(accountClass => ({ venue, sizeUsd, accountClass,
        status: 'supported', checks: [...GUARD_CHECK_IDS], profileHash: a.profileHash, evidenceHash: hash(10), gaps: [] })))),
    live: { coveredDurationSec: 604800, launches: 5000, pendingEntrants: 0, requiredFollowupComplete: true,
      pilotTargetsAccepted: true, budgetAccepted: true } });
}
const inventoryFor = (m: GuardReleaseManifest, operation: 'cutover' | 'rollback' = 'cutover', generation = 0,
  released = false): GuardReleaseInventory => ({ accepted: [{ manifestHash: referenceDigest(m),
    acceptanceHash: m.acceptanceHash, candidateRevision: m.pins.sourceRevision, released }], revoked: [],
  authorizations: [{ operation, targetHash: referenceDigest(m), expectedGeneration: generation, authorizationHash: hash(11) }] });
const active = (m: GuardReleaseManifest, generation = 1): Extract<GuardSwitchState, { mode: 'active' }> => ({ version: GUARD_CUTOVER_VERSION,
  mode: 'active', generation, guardManifestHash: referenceDigest(m), signalManifestHash: null, guardPolicyVersion: 2 });
const acks = (state: GuardSwitchState) => GUARD_RELEASE_CONSUMERS.map(consumer => ({ consumer, ...guardConsumerSwitch(state) }));
function cutover(m = manifest(), inventory = inventoryFor(m), acknowledgements: unknown = acks(active(m))) {
  return prepareGuardSwitch({ current: INACTIVE_GUARD_SWITCH, expectedGeneration: 0, operation: 'cutover',
    manifest: m, inventory, acknowledgements });
}
const context = { venue: 'pons_curve', sizeUsd: 100, accountClass: 'eoa' } as const;
const record = (assessment: unknown, m: GuardReleaseManifest) => ({ assessment, sourceRevision: m.pins.sourceRevision,
  context: { routeId: null, sizeUsd: null, accountClass: null }, manifestId: hash(45), deterministicInput: {},
  dependencyIds: [], recordedAt: '2026-10-02T00:00:00Z', runId: 'fixture-run' });
function selectReleasedGuard(s: GuardSwitchState, m: GuardReleaseManifest | null, i: GuardReleaseInventory,
  a: unknown, c: Parameters<typeof selectRecordedGuard>[4]) {
  return selectRecordedGuard(s, m, i, m ? record(a, m) : null, c);
}

describe('063 atomic cutover preparation (synthetic)', () => {
  it('ships inactive with an empty acceptance inventory and all slices incomplete', () => {
    const saved = JSON.parse(readFileSync(new URL('../../../docs/operations/guard-cutover/063-prepared.json', import.meta.url), 'utf8'));
    expect(GuardSwitchStateSchema.parse(saved.switch)).toEqual(INACTIVE_GUARD_SWITCH);
    expect(saved.acceptedReleaseManifest).toBeNull(); expect(saved.inventory).toEqual(EMPTY_GUARD_RELEASE_INVENTORY);
    expect(saved.coverage).toHaveLength(16);
    expect(saved.coverage.every((c: {status: string}) => c.status === 'incomplete')).toBe(true);
    expect(saved.released).toBe(false);
    expect(() => prepareGuardSwitch({ current: saved.switch, expectedGeneration: 0, operation: 'cutover',
      manifest: null, inventory: saved.inventory, acknowledgements: [] })).toThrow('accepted release manifest');
    const upstream = reportLiveShadowFixtures(liveShadowFixture(), hash(62));
    expect(upstream.releaseManifest).toBeNull(); expect(upstream.acceptedCandidate).toBeNull();
    expect(() => cutover(upstream as never)).toThrow();
  });
  it('requires exact externally admitted content, candidate and separate authorization', () => {
    const m = manifest(), i = inventoryFor(m);
    expect(() => cutover(m, EMPTY_GUARD_RELEASE_INVENTORY)).toThrow('trusted inventory');
    expect(() => cutover({ ...m, pins: { ...m.pins, codeHash: hash(17) } }, i)).toThrow('trusted inventory');
    expect(() => cutover(m, { ...i, accepted: [{ ...i.accepted[0], candidateRevision: hash(18) }] })).toThrow('trusted inventory');
    expect(() => cutover(m, { ...i, authorizations: [] })).toThrow('authorization');
    expect(() => cutover(m, { ...i, revoked: [referenceDigest(m)] })).toThrow('trusted inventory');
    expect(() => cutover({ ...m, origin: 'fixture' } as never)).toThrow();
  });
  it('prepares all consumers in one generation and rejects missing/mixed negotiation', () => {
    const m = manifest(), currentBytes = canonicalize(INACTIVE_GUARD_SWITCH), r = cutover(m);
    expect(r).toMatchObject({ prepared: true, released: false, next: active(m) });
    expect(canonicalize(INACTIVE_GUARD_SWITCH)).toBe(currentBytes);
    expect(verifyGuardConsumerAcks(r.next, r.consumers)).toBe(true);
    expect(new Set(r.consumers.map(c => c.manifestHash))).toEqual(new Set([referenceDigest(m)]));
    expect(r.consumers.every(c => c.guardPolicyVersion === 2 && c.signalVersion === 1)).toBe(true);
    expect(() => cutover(m, inventoryFor(m), r.consumers.slice(1))).toThrow('negotiation');
    for (const change of [{ schema: 'verdict-1' }, { cacheNamespace: hash(20) }, { guardPolicyVersion: 1 }, { signalVersion: 2 }]) {
      const bad = acks(active(m)); Object.assign(bad[0], change);
      expect(() => cutover(m, inventoryFor(m), bad)).toThrow('negotiation');
    }
    expect(() => prepareGuardSwitch({ current: r.next, expectedGeneration: 0, operation: 'cutover', manifest: m,
      inventory: inventoryFor(m), acknowledgements: r.consumers })).toThrow('generation');
  });
  it('requires legacy proof, every consumer, gate and live follow-up evidence', () => {
    for (const g of ['contracts', 'measurement_fidelity', 'high_precision', 'harm_recall', 'lower_harm',
      'attribution', 'restrictions', 'operations', 'parity', 'live_shadow']) {
      const m = manifest(); m.gates = m.gates.filter(row => row.id !== g);
      expect(GuardReleaseManifestSchema.safeParse(m).success).toBe(false);
    }
    const m = manifest(); m.compatibility.consumers.pop();
    expect(GuardReleaseManifestSchema.safeParse(m).success).toBe(false);
    for (const change of [{ launches: 4999 }, { coveredDurationSec: 604799 }, { pendingEntrants: 1 }, { requiredFollowupComplete: false }])
      expect(GuardReleaseManifestSchema.safeParse({ ...manifest(), live: { ...manifest().live, ...change } }).success).toBe(false);
    expect(GuardReleaseManifestSchema.safeParse({ ...manifest(), compatibility: { ...manifest().compatibility, legacyReadProofHash: null } }).success).toBe(false);
  });
  it('supports a narrower facts/gaps manifest, with Lower and unsupported classes disabled', () => {
    const m = manifest(); m.lowerEnabled = false; m.factors = [];
    m.checks = GUARD_CHECK_IDS.filter(id => ['reference_exit', 'effective_fees', 'controls_hooks', 'supply_float'].includes(id));
    m.gates = m.gates.filter(g => !['high_precision', 'harm_recall', 'lower_harm', 'attribution'].includes(g.id));
    m.coverage = m.coverage.map(c => c.venue === 'pons_curve' && c.accountClass === 'eoa' ?
      { ...c, checks: [...m.checks], gaps: GUARD_CHECK_IDS.filter(id => !m.checks.includes(id)) } :
      { ...c, status: 'incomplete', profileHash: null, evidenceHash: null, checks: [], gaps: [...GUARD_CHECK_IDS] });
    expect(GuardReleaseManifestSchema.safeParse(m).success).toBe(true);
    const lowerGaps = GUARD_CHECK_IDS.filter(id => !m.checks.includes(id));
    const partial = guardFixture('lower', lowerGaps);
    expect(selectReleasedGuard(active(m), m, inventoryFor(m, 'cutover', 0, true), partial, context).assessment).toEqual(partial);
    expect(selectReleasedGuard(active(m), m, inventoryFor(m, 'cutover', 0, true), guardFixture(), context).reason).toBe('guard_unreleased_assessment');
    expect(selectReleasedGuard(active(m), m, inventoryFor(m, 'cutover', 0, true), guardFixture(),
      { ...context, accountClass: 'smart_account' }).reason).toBe('guard_unsupported_slice');
    const bad = structuredClone(m); bad.coverage[0].checks = []; bad.coverage[0].gaps = [...GUARD_CHECK_IDS];
    expect(GuardReleaseManifestSchema.safeParse(bad).success).toBe(false);
    const hidden = structuredClone(m); hidden.coverage[1].gaps = [];
    expect(GuardReleaseManifestSchema.safeParse(hidden).success).toBe(false);
  });
  it('selects original active receipts only, rejecting mismatched pins and unaccepted factors', () => {
    const m = manifest(), i = inventoryFor(m, 'cutover', 0, true), a = guardFixture('high');
    expect(selectReleasedGuard(active(m), m, i, a, context).assessment).toEqual(a);
    expect(() => selectReleasedGuard(active(m), m, inventoryFor(m), a, context)).toThrow('trusted inventory');
    expect(selectReleasedGuard(active(m), m, i, { ...a, mode: 'shadow' }, context).reason).toBe('guard_unreleased_assessment');
    expect(selectReleasedGuard(active(m), m, i, { ...a, parametersHash: hash(25) }, context).reason).toBe('guard_unreleased_assessment');
    expect(selectRecordedGuard(active(m), m, i, { ...record(a, m), sourceRevision: hash(26) }, context).reason).toBe('guard_unreleased_assessment');
    const other = manifest(70);
    expect(selectReleasedGuard(active(other), m, i, a, context).reason).toBe('guard_manifest_mismatch');
    m.factors = [];
    expect(selectReleasedGuard(active(m), m, inventoryFor(m, 'cutover', 0, true), a, context).reason).toBe('guard_unreleased_assessment');
    expect(selectReleasedGuard(INACTIVE_GUARD_SWITCH, null, EMPTY_GUARD_RELEASE_INVENTORY, a, context).reason).toBe('guard_v2_inactive');
  });
  it('rolls back only to previous released V2 or critical-incomplete, keeping policy V2', () => {
    const prior = manifest(50), current = active(manifest());
    const next = active(prior, 2);
    const r = prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'rollback', manifest: prior,
      inventory: inventoryFor(prior, 'rollback', 1, true), acknowledgements: acks(next) });
    expect(r.next).toEqual(next);
    expect(() => prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'rollback', manifest: prior,
      inventory: inventoryFor(prior, 'rollback', 1, false), acknowledgements: acks(next) })).toThrow('trusted inventory');
    const rejected = { ...prior, attributionMethod: 'serial_exemptions' };
    expect(() => prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'rollback', manifest: rejected,
      inventory: inventoryFor(prior, 'rollback', 1, true), acknowledgements: acks(next) })).toThrow();
    const fallback: GuardSwitchState = { version: GUARD_CUTOVER_VERSION, generation: 2, mode: 'critical_incomplete',
      guardManifestHash: null, signalManifestHash: null, guardPolicyVersion: 2 };
    const inventory: GuardReleaseInventory = { accepted: [], revoked: [], authorizations: [{ operation: 'rollback',
      targetHash: null, expectedGeneration: 1, authorizationHash: hash(29) }] };
    expect(prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'rollback', manifest: null,
      inventory, acknowledgements: acks(fallback) }).next).toEqual(fallback);
    expect(selectReleasedGuard(fallback, null, inventory, guardFixture(), context).reason).toBe('guard_rollback_incomplete');
    expect(guardBuyGate(undefined, { ...policy, guardPolicyVersion: 2 }, ASSET, 4663, NOW).deny[0]).toMatch('guard_incomplete');
  });
  it('promotes Signal independently with accepted adapter checks and exact Guard binding', () => {
    const m = manifest(), current = active(m);
    const signal = SignalReleaseManifestSchema.parse({ version: GUARD_CUTOVER_VERSION, kind: 'signal',
      origin: 'measured', status: 'accepted', adapterVersion: 2, guardManifestHash: referenceDigest(m),
      adapterCodeHash: hash(30), sourceRevision: hash(31), acceptanceHash: hash(32), checksHash: hash(33),
      refreshSec: 15, legacyInputsPreserved: true });
    const target = referenceDigest(signal), next = { ...current, generation: 2, signalManifestHash: target };
    const i = inventoryFor(m, 'cutover', 0, true);
    i.accepted.push({ manifestHash: target, acceptanceHash: signal.acceptanceHash, candidateRevision: signal.sourceRevision, released: false });
    i.authorizations.push({ operation: 'signal', targetHash: target, expectedGeneration: 1, authorizationHash: hash(34) });
    expect(prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'signal', manifest: signal,
      inventory: i, acknowledgements: acks(next) }).next).toEqual(next);
    expect(() => prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'signal', manifest: signal,
      inventory: { ...i, accepted: i.accepted.slice(0, 1) }, acknowledgements: acks(next) })).toThrow('trusted inventory');
    const different = { ...signal, guardManifestHash: hash(35) }, changedHash = referenceDigest(different);
    i.accepted.push({ manifestHash: changedHash, acceptanceHash: signal.acceptanceHash, candidateRevision: signal.sourceRevision, released: false });
    expect(() => prepareGuardSwitch({ current, expectedGeneration: 1, operation: 'signal', manifest: different,
      inventory: i, acknowledgements: acks(next) })).toThrow('different or unreleased');
    const rollback = prepareGuardSwitch({ current: next, expectedGeneration: 2, operation: 'rollback', manifest: manifest(50),
      inventory: inventoryFor(manifest(50), 'rollback', 2, true), acknowledgements: acks(active(manifest(50), 3)) });
    expect(guardConsumerSwitch(rollback.next).signalVersion).toBe(1);
  });
  it('isolates cache by full cursor/availability/context/source, semantic pins and generation', () => {
    const m = manifest(), s = active(m), a = guardFixture();
    const key = guardReceiptRevisionKey(a, hash(40), m.pins.sourceRevision,
      { routeId: 'fixture-route', sizeUsd: '100', accountClass: 'eoa' });
    const original = guardReleaseCacheKey(s, key);
    for (const changed of [
      { ...key, cursor: { ...key.cursor, blockHash: hash(41) } },
      { ...key, availability: { ...key.availability, acquisitionSequence: '2' } },
      { ...key, context: { ...key.context, routeId: 'other-route' } },
      { ...key, context: { ...key.context, sizeUsd: '1000' } },
      { ...key, context: { ...key.context, accountClass: 'smart_account' } },
      { ...key, sourceRevision: hash(42) }, { ...key, parametersHash: hash(43) },
      { ...key, rulesVersion: '2.0.1' }, { ...key, mode: 'shadow' },
    ]) expect(guardReleaseCacheKey(s, changed)).not.toBe(original);
    expect(guardReleaseCacheKey({ ...s, generation: 2 }, key)).not.toBe(original);
    expect(guardReleaseCacheKey(INACTIVE_GUARD_SWITCH, key)).not.toBe(original);
  });
  it('appends policy version 2 without changing null choices or old final replays', () => {
    const legacy = { ...policy, mode: 'safe' as const, blockPlaybookLevel: null };
    const bytes = canonicalize(legacy), settings = prepareGuardPolicySettings(legacy, active(manifest()));
    expect(settings).toEqual({ ...legacy, version: 2, guardPolicyVersion: 2 });
    expect(canonicalize(legacy)).toBe(bytes);
    expect(guardBuyGate(cachedGuard(guardFixture('elevated')), settings, ASSET, 4663, NOW).deny[0]).toMatch('guard_elevated');
    for (const mode of ['safe', 'balanced', 'degen'] as const)
      expect(guardBuyGate(cachedGuard(guardFixture('high')), { ...settings, mode }, ASSET, 4663, NOW).deny[0]).toMatch('guard_high');
    const final = { preflightId: 'fixture-preflight', journalId: 'fixture-journal', policyVersion: 1,
      decision: 'allow' as const, reasons: [] };
    expect(resolveRepeat({ orderHash: hash(44), result: final }, hash(44), () => { throw new Error('Must retain final replay'); })).toEqual(final);
    expect(final).not.toHaveProperty('guardPolicyVersion');
    expect(prepareGuardPolicySettings(settings, active(manifest(50), 2))).toEqual(settings);
  });
  it('preserves canonical legacy and V2 proof payloads through switch and rollback', () => {
    const codec = createGuardReceiptCodec(hashing), before = canonicalize(proofs);
    cutover();
    const prior = manifest(50);
    prepareGuardSwitch({ current: active(manifest()), expectedGeneration: 1, operation: 'rollback', manifest: prior,
      inventory: inventoryFor(prior, 'rollback', 1, true), acknowledgements: acks(active(prior, 2)) });
    for (const [index, item] of proofs.items.entries()) {
      expect(canonicalize(item.payload)).toBe(item.canonicalPayload);
      expect(codec.verifyPublicProof(item.payload, ReceiptItemSchema.parse(item), proofs.proofs[index].map(n => Bytes32Schema.parse(n)),
        Bytes32Schema.parse(proofs.root))).toBe(true);
      if (item.case !== 'v1-verdict' && item.payload.schemaVersion === 'guard-receipt-2')
        expect(GuardReceiptPayloadSchema.parse(item.payload).decision.mode).toBe('shadow');
    }
    expect(canonicalize(proofs)).toBe(before);
  });
});
