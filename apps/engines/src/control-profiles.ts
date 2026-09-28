import { keccak256, toHex } from 'viem';
import { GuardMeasurementStore, guardRowsKnownAt, type ChainDb, type GuardReadCut } from '@eko/db';
import { ControlProfileSchema, CONTROL_METHOD_VERSION, referenceDigest, controlStateChanged } from '@eko/chain';
import type { ControlProfile } from '@eko/chain';
import { GuardCardMeasurementSchema, GUARD_CAPABILITIES, guardKnownBy, compareGuardCursors } from '@eko/shared';
import type { GuardStoredEvidence, GuardAvailabilityManifest, AvailabilityCut, Metric, MetricId, PowerAssessment } from '@eko/shared';

/** Generic probes are positive evidence only. Neither a no-op nor inert owner proves a capability absent. */
export function controlCardMeasurement(raw: ControlProfile, knownAt: AvailabilityCut, evidenceId: `0x${string}`) {
  const p = ControlProfileSchema.parse(raw), s = p.inspection;
  if (referenceDigest({ schemaVersion: p.schemaVersion, inspection: s, confirmations: p.confirmations }) !== p.id) throw new Error('Control profile hash mismatch');
  if (referenceDigest({ roles: s.roles, configuration: s.configuration }) !== s.configurationHash ||
    referenceDigest({ methodVersion: s.methodVersion, coin: s.coin, cursor: s.cursor, path: s.path, roles: s.roles, selectors: s.selectors, configurationHash: s.configurationHash }) !== s.profileHash) throw new Error('Control inspection hash mismatch');
  if (compareGuardCursors(s.cursor, knownAt.cursor) > 0) throw new Error('Control profile precedes availability');
  const metric = <T>(id: MetricId, unit: Metric<T>['unit'], value: T | null): Metric<T> => ({
    id, unit, cursor: s.cursor, knownAt, numerator: null, denominator: null, denominatorKind: null,
    fromSec: null, throughSec: s.cursor.timestampSec, methodVersion: CONTROL_METHOD_VERSION, evidenceIds: [evidenceId],
    coverage: { scopeId: `generic-control-${id}`, from: s.cursor, through: s.cursor, complete: value !== null,
      gaps: value === null ? ['unsupported'] : [], methodVersion: CONTROL_METHOD_VERSION, coveredUnits: null, excludedUnits: null,
      topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [p.id] },
    ...(value === null ? { status: 'unknown' as const, value: null, failureCode: 'unsupported' as const } : { status: 'observed' as const, value, failureCode: null }),
  });
  const timedMetric = (id: MetricId, value: string | null, upper: boolean): Metric<string> => {
    const m = metric(id, 'seconds', value);
    return upper && m.status === 'observed' ? { ...m, status: 'upper_bound' } : m;
  };
  const powers: PowerAssessment[] = GUARD_CAPABILITIES.map(capability => {
    const c = p.confirmations.find(c => c.recipe.capability === capability && c.status === 'changed');
    const confirmed = c && c.recipe.implementationHash === s.implementationHash && c.recipe.configurationHash === s.configurationHash &&
      c.before !== null && c.after !== null && controlStateChanged(c.recipe, c.before, c.after) && c.elapsedSec !== null &&
      (c.recipe.delaySec === 0 || c.earlyRejected === true) && referenceDigest(c.trace) === c.traceHash;
    return { capability, reachable: metric('powers', 'boolean', confirmed ? true : null),
      authority: metric('currentController', 'address', confirmed ? c.recipe.authority : null),
      // TODO(spec): generic selector probes do not establish a ceiling or unrestricted domain; reviewed bounds need their own evidence adapter.
      boundCode: 'unknown', bound: metric<string>('controlBound', 'decimal', null),
      // A queued probe proves execution by the tested time, not the exact minimum delay.
      delaySec: timedMetric('controlDelay', confirmed ? (c.recipe.queue ? String(c.elapsedSec) : '0') : null, !!c?.recipe.queue),
      earliestExecution: timedMetric('earliestExecution', confirmed ? String(BigInt(s.cursor.timestampSec) + BigInt(c.elapsedSec!)) : null, true),
      implementationHash: s.implementationHash, configurationHash: s.configurationHash, evidenceIds: [evidenceId],
    };
  });
  return GuardCardMeasurementSchema.parse({ schemaVersion: 'guard-card-measurements-2', coin: s.coin, cursor: s.cursor, knownAt,
    // Tested callers are capability-specific; unresolved roles cannot establish a sole aggregate controller.
    control: { powers, currentController: metric('currentController', 'address', null) } });
}
/** Captured availability/dependencies are mandatory. No migration needed: 027's append-only measurements own profiles and projection. */
export async function persistControlProfile(db: ChainDb, raw: ControlProfile, input: {
  manifest: GuardAvailabilityManifest; knownAt: AvailabilityCut; acquiredAt: string; dependencyIds: `0x${string}`[];
  previous?: { profileId: `0x${string}`; measurementId: `0x${string}` };
}) {
  const profile = ControlProfileSchema.parse(raw), s = profile.inspection;
  if (!guardKnownBy(input.knownAt, input.manifest.cut) || await db.blockHash(BigInt(s.cursor.blockNumber)) !== s.cursor.blockHash) throw new Error('Control capture pin mismatch');
  const required = [...new Set(profile.confirmations.flatMap(c => c.recipe.reviewEvidenceIds))];
  if (required.some(id => !input.dependencyIds.includes(id))) throw new Error('Control review dependencies missing');
  const put = async (store: GuardMeasurementStore, sourceItemId: string, payload: unknown, dependencyIds: `0x${string}`[]) => {
    const content = new TextEncoder().encode(JSON.stringify(payload)), digest = keccak256(toHex(content));
    const row: GuardStoredEvidence = { chainId: s.cursor.chainId, coin: s.coin, manifestId: input.manifest.id,
      sourceItemId, sourceRevision: input.manifest.sourceRevision, cursor: s.cursor, knownAt: input.knownAt,
      acquiredAt: input.acquiredAt, methodVersion: CONTROL_METHOD_VERSION, dependencyIds,
      evidence: { id: digest, kind: 'state', cursor: s.cursor, knownAt: input.knownAt, payloadHash: digest, objectRef: digest, supersedes: null } };
    return store.putEvidence(row, content);
  };
  // Validate the projection before storing anything. Persistence is atomic with supersession.
  controlCardMeasurement(profile, input.knownAt, profile.id);
  return db.tx(async tx => {
    if (await tx.blockHash(BigInt(s.cursor.blockNumber)) !== s.cursor.blockHash) throw new Error('Control capture pin mismatch');
    const scoped = new GuardMeasurementStore(tx);
    // putEvidence uses nested database transactions, supported by ChainDb.
    const rawRow = await put(scoped, 'generic-control-profile', profile, input.dependencyIds);
    const projection = controlCardMeasurement(profile, input.knownAt, rawRow.id as `0x${string}`);
    const projectedRow = await put(scoped, 'generic-control-card', projection, [rawRow.id as `0x${string}`]);
    if (input.previous) {
      const event = { causeId: profile.id, knownAt: input.knownAt, recordedAt: input.acquiredAt };
      if (input.previous.profileId !== rawRow.id) await scoped.supersede(input.previous.profileId, rawRow.id, event);
      if (input.previous.measurementId !== projectedRow.id) await scoped.supersede(input.previous.measurementId, projectedRow.id, event);
    }
    return { profileId: rawRow.id as `0x${string}`, measurementId: projectedRow.id as `0x${string}` };
  });
}
/** Exact state only: upgrades, setters, ownership/role changes and reorgs require reacquisition, never reuse by code hash alone. */
export async function loadControlProfiles(db: ChainDb, cut: GuardReadCut) {
  const rows = await guardRowsKnownAt<GuardStoredEvidence>(db, 'guard_measurement_evidence', cut);
  return rows.filter(r => r.data.sourceItemId === 'generic-control-profile' && compareGuardCursors(r.data.cursor, cut.state) === 0).map(r => {
    const content = (r as typeof r & { content: Uint8Array }).content;
    if (keccak256(toHex(content)) !== r.payload_hash) throw new Error('Control content hash mismatch');
    return ControlProfileSchema.parse(JSON.parse(new TextDecoder().decode(content)));
  });
}
