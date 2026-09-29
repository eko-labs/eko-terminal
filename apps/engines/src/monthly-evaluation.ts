import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { CONFIG_GUARD_V2 } from '@eko/playbooks';
import { AddressSchema, Bytes32Schema, GUARD_CHECK_IDS } from '@eko/shared';
import { GuardReleaseManifestSchema, GuardReleaseInventorySchema } from './guard-cutover.js';
import { ProbabilityFrameSchema, drawStratifiedProbabilitySample } from './probability-sample.js';
import { LockedTestInputSchema, evaluateLockedFixtures } from './locked-test.js';

export const MONTHLY_EVALUATION_VERSION = 'monthly-evaluation-064.1' as const;
export const MONTHLY_QUOTAS = [35, 25, 25, 35, 80] as const;
export const MONTHLY_META_CASES = ['new_hooks_services', 'aged_wallets', 'staggered_buys',
  'dispersal', 'delayed_collectors', 'slow_campaigns'] as const;
const sec = z.number().int().nonnegative().safe();
const code = z.string().regex(/^[a-z0-9_:-]{1,120}$/);

/** UTC half-open boundaries, including leap years; no 30-day interval arithmetic. */
export function calendarMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1970 || Number(month.slice(0, 4)) > 9998)
    throw new Error('Expected calendar UTC month');
  const fromSec = Date.parse(`${month}-01T00:00:00Z`) / 1000;
  const end = new Date(fromSec * 1000); end.setUTCMonth(end.getUTCMonth() + 1);
  return { month, fromSec, untilSec: end.getTime() / 1000, nextMonth: end.toISOString().slice(0, 7) };
}
const change = z.strictObject({ field: code, beforeHash: Bytes32Schema, afterHash: Bytes32Schema,
  reason: code, receiptHashes: z.array(Bytes32Schema).min(1), developmentHash: Bytes32Schema.nullable(),
  validationHash: Bytes32Schema.nullable(), newHeldOutHash: Bytes32Schema.nullable() });
// TODO(spec): §9.5 supplies no maintenance wire format or stratum allocation.
// Freeze a local 35/25/25/35/80 design using §9.3 priority strata, and require
// externally reviewed evidence before changing semantics or publishing suspension.
export const MonthlyDefinitionSchema = z.strictObject({ version: z.literal(MONTHLY_EVALUATION_VERSION),
  origin: z.literal('fixture'), month: z.string(), sourceRevision: Bytes32Schema,
  manifest: GuardReleaseManifestSchema.nullable(), inventory: GuardReleaseInventorySchema,
  requiredHorizonsSec: z.array(z.union([z.literal(3600), z.literal(86400), z.literal(604800)])).min(1),
  entryDelaySec: z.literal(60), confirmationSec: sec,
  frame: ProbabilityFrameSchema.nullable(),
  challenges: z.array(z.strictObject({ coin: AddressSchema, kind: z.enum(['incident', 'negative_control']),
    metaCases: z.array(z.enum(MONTHLY_META_CASES)), receiptHashes: z.array(Bytes32Schema).min(1) })),
  sources: z.array(z.strictObject({ id: code, sourceRevision: Bytes32Schema, artifactHash: Bytes32Schema,
    status: z.enum(['captured', 'unavailable']), gaps: z.array(z.enum(GUARD_CHECK_IDS)) })),
  changes: z.array(change),
});
export const MonthlyTickSchema = z.strictObject({ throughSec: sec,
  followup: z.array(z.strictObject({ coin: AddressSchema, horizonSec: sec,
    coveredThroughSec: sec, confirmedThroughSec: sec, receiptHash: Bytes32Schema })),
  coverageFailures: z.array(z.strictObject({ check: z.enum(GUARD_CHECK_IDS), slice: code,
    reason: code, receiptHashes: z.array(Bytes32Schema).min(1) })),
  challengeReviews: z.array(z.strictObject({ coin: AddressSchema, status: z.enum(['pending', 'resolved']),
    independentReviewArtifactHash: Bytes32Schema })),
  evaluation: LockedTestInputSchema.nullable(),
});
export const MonthlyInputSchema = z.strictObject({ definition: MonthlyDefinitionSchema,
  ticks: z.array(MonthlyTickSchema).max(10000) });
export type MonthlyInput = z.infer<typeof MonthlyInputSchema>;

/** Captured application evaluation job only. No acquisition or active writer.
 * Synthetic trusted-inventory doubles exercise admission, never measured release. */
export function evaluateMonthlyFixtures(raw: MonthlyInput, implementationRevision: string) {
  const input = MonthlyInputSchema.parse(raw), d = input.definition;
  Bytes32Schema.parse(implementationRevision);
  const window = calendarMonth(d.month);
  const nextWindow = calendarMonth(window.nextMonth);
  const delay = d.entryDelaySec + Math.max(...d.requiredHorizonsSec) + d.confirmationSec;
  const evaluateAfterSec = window.untilSec + delay;
  const schedule = { ...window, evaluateAfterSec, nextMonth: window.nextMonth,
    nextScheduledApplicationJobSec: nextWindow.untilSec + delay, schedulerInstalled: false };
  const manifestHash = d.manifest ? referenceDigest(d.manifest) : null;
  const admitted = d.manifest && !d.inventory.revoked.includes(manifestHash!) && d.inventory.accepted.some(a =>
    a.manifestHash === manifestHash && a.acceptanceHash === d.manifest!.acceptanceHash &&
    a.candidateRevision === d.manifest!.pins.sourceRevision && a.released);
  const base = { version: MONTHLY_EVALUATION_VERSION, origin: 'fixture', implementationRevision,
    sourceRevision: d.sourceRevision, candidateRevision: d.manifest?.pins.sourceRevision ?? null,
    manifestHash, definitionHash: referenceDigest(d), schedule, enabled: false, released: false,
    activeChangesApplied: false, acceptedCandidate: null, actualRequests: 0, actualRequestUnits: 0,
    actualPaidNanoUsd: '0', pricingEvidence: null, measuredCoverage: 0,
    sources: d.sources, changes: d.changes, artifactsRetained: true };
  const seal = <T extends object>(body: T) => ({ ...body, reportHash: referenceDigest(body) });
  if (!admitted) return seal({ ...base, status: 'disabled_no_accepted_release', sample: null,
    gates: null, actions: [], nextAction: 'obtain_accepted_released_manifest_and_trusted_inventory' });
  if (!d.requiredHorizonsSec.includes(3600) || new Set(d.requiredHorizonsSec).size !== d.requiredHorizonsSec.length)
    throw new Error('Unique required horizons including primary outcome required');
  if (!d.frame || d.frame.origin !== 'fixture' || d.frame.chainId !== 4663 ||
      d.frame.fromSec !== String(window.fromSec) || d.frame.untilSec !== String(window.untilSec))
    throw new Error('Complete new calendar-month probability frame required');
  if (new Set(d.sources.map(s => s.id)).size !== d.sources.length ||
      new Set(d.changes.map(c => c.field)).size !== d.changes.length ||
      d.changes.some(c => c.beforeHash === c.afterHash)) throw new Error('Duplicate or unchanged source/change record');
  const sample = drawStratifiedProbabilitySample(d.frame, MONTHLY_QUOTAS);
  const selected = sample.strata.flatMap(s => s.selected);
  if (new Set(d.challenges.map(c => c.coin)).size !== d.challenges.length || d.challenges.some(c => selected.includes(c.coin)))
    throw new Error('Challenges must be separate from probability review');
  const coins = [...selected, ...d.challenges.map(c => c.coin)];
  if (!d.sources.some(s => s.status === 'captured' && s.sourceRevision === d.frame!.sourceRevision && s.artifactHash === referenceDigest(d.frame)))
    throw new Error('Pinned monthly population source artifact required');
  const launches = new Map(d.frame.members.map(m => [m.coin, Number(m.launchSec)]));
  const followup = new Map<string, MonthlyInput['ticks'][number]['followup'][number]>();
  const gaps: MonthlyInput['ticks'][number]['coverageFailures'] = d.sources.flatMap(s => s.gaps.map(check => ({
    check, slice: `source:${s.id}`, reason: s.status === 'unavailable' ? 'source_unavailable' : 'captured_source_coverage_gap',
    receiptHashes: [s.artifactHash] })));
  const challengeReviews = new Map<string, MonthlyInput['ticks'][number]['challengeReviews'][number]>();
  let through = window.fromSec;
  let gates: ReturnType<typeof evaluateLockedFixtures> | null = null;
  for (const tick of input.ticks) {
    if (tick.throughSec < through || tick.throughSec > Number(d.frame.availabilityCut.cursor.timestampSec))
      throw new Error('Nonmonotone progress or beyond captured availability');
    through = tick.throughSec;
    if (new Set(tick.followup.map(f => `${f.coin}:${f.horizonSec}`)).size !== tick.followup.length)
      throw new Error('Duplicate follow-up');
    for (const f of tick.followup) {
      if (!coins.includes(f.coin) || !d.requiredHorizonsSec.includes(f.horizonSec as 3600) ||
          f.coveredThroughSec > through || f.confirmedThroughSec > through)
        throw new Error('Follow-up outside frozen review or clock');
      const key = `${f.coin}:${f.horizonSec}`, prior = followup.get(key);
      if (prior && (f.coveredThroughSec < prior.coveredThroughSec || f.confirmedThroughSec < prior.confirmedThroughSec))
        throw new Error('Follow-up regression');
      followup.set(key, f);
    }
    for (const review of tick.challengeReviews) {
      if (!d.challenges.some(c => c.coin === review.coin) || challengeReviews.get(review.coin)?.status === 'resolved')
        throw new Error('Challenge review outside frozen cases or rewritten resolved artifact');
      challengeReviews.set(review.coin, review);
    }
    gaps.push(...tick.coverageFailures);
    if (tick.evaluation) {
      if (gates || through < evaluateAfterSec) throw new Error('Frozen gates run once after month follow-up');
      const e = tick.evaluation, freeze = e.freeze;
      if (!freeze?.parameters || freeze.candidateRevision !== d.manifest!.pins.sourceRevision ||
          freeze.parametersHash !== d.manifest!.pins.parametersHash ||
          freeze.calibrationHash !== d.manifest!.pins.calibrationManifestHash ||
          referenceDigest([...freeze.parameters.enabled].sort()) !== referenceDigest([...d.manifest!.factors].sort()) ||
          (['rulesVersion', 'identityVersion', 'measurementVersion', 'outcomeVersion'] as const)
            .some(k => CONFIG_GUARD_V2[k] !== d.manifest!.pins[k]) || d.changes.length)
        throw new Error('Semantic change requires development/validation and new held-out evidence; no retuning');
      const frame = e.acquisition.population?.frame;
      if (!frame || BigInt(frame.fromSec) < BigInt(window.fromSec) || BigInt(frame.untilSec) > BigInt(window.untilSec) ||
          frame.sourceRevision !== d.frame.sourceRevision || Number(frame.availabilityCut.cursor.timestampSec) > through ||
          frame.members.some(m => !selected.includes(m.coin) || launches.get(m.coin) !== Number(m.launchSec)) ||
          e.features.some(f => f.input.codeHash !== d.manifest!.pins.codeHash ||
            (['serviceRegistryHash', 'profileHash'] as const)
              .some(k => f.input[k] !== d.manifest!.pins[k])))
        throw new Error('Gate data must be later month probability members with frozen code');
      if (coins.some(coin => d.requiredHorizonsSec.some(h => {
        const f = followup.get(`${coin}:${h}`), deadline = (launches.get(coin) ?? window.untilSec - 1) + d.entryDelaySec + h;
        return !f || f.coveredThroughSec < deadline || f.confirmedThroughSec < deadline + d.confirmationSec;
      }))) throw new Error('Required outcome follow-up pending');
      gates = evaluateLockedFixtures(e, implementationRevision);
    }
  }
  const pendingFollowup = coins.flatMap(coin => d.requiredHorizonsSec.flatMap(h => {
    const f = followup.get(`${coin}:${h}`), deadline = (launches.get(coin) ?? window.untilSec - 1) + d.entryDelaySec + h;
    return !f || f.coveredThroughSec < deadline || f.confirmedThroughSec < deadline + d.confirmationSec ? [{ coin, horizonSec: h, deadlineSec: deadline }] : [];
  }));
  const evaluated = new Set(gates?.primary.flatMap(c => c.diagnostics.filter(r => r.labelsResolved).map(r => r.coin)) ?? []);
  const pendingLabels = coins.filter(c => !evaluated.has(c) && challengeReviews.get(c)?.status !== 'resolved');
  const failed = gates?.gateTable.filter(g => !g.numericalPass).map(g => g.gate) ?? [];
  const actions = [
    ...gaps.map(g => ({ action: 'suspend_coverage' as const, target: `${g.check}:${g.slice}`, reason: g.reason,
      gapsVisible: [g.check], receiptHashes: g.receiptHashes, applied: false })),
    ...(failed.length ? [{ action: 'disable_lower_pending_review' as const, target: 'lower',
      reason: 'frozen_maintenance_gates_failed', receiptHashes: [gates!.reportHash], applied: false }] : []),
    ...(failed.length ? d.manifest!.factors.map(target => ({ action: 'return_factor_to_shadow' as const,
      target, reason: 'frozen_maintenance_gates_failed', failedGates: failed, receiptHashes: [gates!.reportHash], applied: false })) : []),
  ];
  const metaCoverage = MONTHLY_META_CASES.map(id => ({ id, challenges: d.challenges.filter(c => c.metaCases.includes(id)).length }));
  return seal({ ...base, status: gates ? 'fixture_evaluated_not_accepted' : through < evaluateAfterSec || pendingFollowup.length ? 'awaiting_followup' : 'awaiting_labels_and_frozen_gates',
    sample, challenges: d.challenges, challengeReviews: [...challengeReviews.values()], pendingFollowup, pendingLabels, gates, actions, metaCoverage,
    drift: { baselineManifestHash: manifestHash, baselineGateArtifacts: d.manifest!.gates,
      laterPrimary: gates?.primary ?? null, laterAudits: gates?.audits ?? null,
      comparison: 'same_frozen_candidate_later_data', thresholdsChanged: false },
    coverage: { population: sample.populationSize, probabilityReviewed: sample.sampleSize,
      pendingLabels: pendingLabels.length, failures: gaps, gateCoverage: gates?.coverage ?? null },
    precision: gates?.primary.map(c => ({ sizeUsd: c.sizeUsd, accountClass: c.accountClass, metrics: c })) ?? null,
    nextAction: failed.length || gaps.length ? 'review_receipt_backed_suspension_through_authorized_release_process' :
      'complete_followup_independent_labels_and_missing_gate_evidence; no_auto_promotion' });
}
