import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { Bytes32Schema, guardKnownBy, GUARD_FACTOR_IDS } from '@eko/shared';
import { AcquisitionDefinitionSchema, prepareAcquisition } from './acquisition-run.js';
import { LabelAssignmentInputSchema, SignedDecisionSchema, importLabelDecisions } from './label-completion.js';
import { DevelopmentFitInputSchema, DEVELOPMENT_FIT_VERSION, developmentGrid, preregisterDevelopmentFit,
  freezeDevelopmentTruths, validateDevelopmentTruth, developmentTruthValue, projectDevelopmentScore } from './development-fit.js';
import { benchmarkFidelityGate } from './buyer-benchmark.js';
import { independentWilsonAudit, lockedPrimaryMetrics, weightedComponentRate } from './locked-test-statistics.js';

export const LOCKED_TEST_VERSION = 'locked-test-061.1' as const;
const registrationSchema = z.strictObject({ version: z.literal(LOCKED_TEST_VERSION), cohortHash: Bytes32Schema,
  freezeHash: Bytes32Schema.nullable(), truthHash: Bytes32Schema, sensitivityHash: Bytes32Schema, targetHash: Bytes32Schema,
  auditDeclarationHash: Bytes32Schema, labelsInspected: z.literal(false), resamples: z.literal(2000), hash: Bytes32Schema });
const parameters = z.strictObject({ lower: z.number(), high: z.number(), enabled: z.array(z.enum(GUARD_FACTOR_IDS)),
  weights: z.record(z.enum(GUARD_FACTOR_IDS), z.number()), compatibility: z.literal('maximum_compatible_assignment'),
  familyMax: z.literal(true), historyEnabled: z.literal(false), bucketsEnabled: z.literal(false), parametersHash: Bytes32Schema });
export const DevelopmentFreezeSchema = z.strictObject({ version: z.literal(DEVELOPMENT_FIT_VERSION), candidateRevision: Bytes32Schema,
  cohortHash: Bytes32Schema, methodHash: Bytes32Schema, gridHash: Bytes32Schema, truthHash: Bytes32Schema,
  labelSetHash: Bytes32Schema, calibrationHash: Bytes32Schema, parametersHash: Bytes32Schema.nullable(), parameters: parameters.nullable(),
  status: z.enum(['development_frozen_awaiting_untouched_test', 'no_eligible_development_candidate']),
  acceptedCandidate: z.null(), heldOutTestRequired: z.literal(true), mode: z.literal('shadow'), active: z.literal(false),
  released: z.literal(false), historyEnabled: z.literal(false), bucketsEnabled: z.literal(false), freezeHash: Bytes32Schema });
const metric = z.number().finite().nonnegative().nullable();
// TODO(spec): §9.4 has no offline locked-report wire format or pilot target
// envelope. Use engines-local fixture preparation only; measured acceptance
// requires an independently verified frozen evidence workflow and release review.
export const LockedTestInputSchema = z.strictObject({ version: z.literal(LOCKED_TEST_VERSION), origin: z.literal('fixture'),
  registration: registrationSchema,
  acquisition: AcquisitionDefinitionSchema, freeze: DevelopmentFreezeSchema.nullable(),
  labels: z.strictObject({ assignment: LabelAssignmentInputSchema, decisions: z.array(SignedDecisionSchema), previous: z.array(SignedDecisionSchema) }),
  truthHash: Bytes32Schema, truths: DevelopmentFitInputSchema.shape.truths, features: DevelopmentFitInputSchema.shape.features,
  fidelity: DevelopmentFitInputSchema.shape.fidelity, audits: DevelopmentFitInputSchema.shape.audits,
  independentAuditKinds: z.array(z.enum(['factual', 'attribution', 'text', 'restriction'])),
  factualFixtureEvidence: DevelopmentFitInputSchema.shape.factualFixtureEvidence,
  sensitivities: z.array(DevelopmentFitInputSchema.shape.truths.element.extend({
    entryDelaySec: z.union([z.literal(5), z.literal(30), z.literal(60), z.literal(300)]),
    exitHoldSec: z.union([z.literal(300), z.literal(3600), z.literal(86400), z.literal(604800)]),
  })),
  operations: z.strictObject({ pilotTargetHash: Bytes32Schema.nullable(), parity: z.strictObject({
    matchedSnapshots: z.number().int().nonnegative(), criticalErrors: z.number().int().nonnegative(),
    ekoUnanswerableFraction: z.number().min(0).max(1).nullable(), comparatorUnanswerableFraction: z.number().min(0).max(1).nullable() }).nullable(),
    rows: z.array(z.strictObject({ venue: z.string().regex(/^[a-z0-9_]+$/), ageSec: z.number().int().nonnegative(),
      scanMs: metric, enrichmentMs: metric, probeMs: metric, attributionMs: metric, alertMs: metric,
      criticalCompletionMs: metric, lowerCompletionMs: metric, preflightMs: metric })),
    frozenPerformanceHash: Bytes32Schema.nullable(), frozenEvaluations: z.number().int().nonnegative(),
    evaluationsPerSec: metric, evaluatorRpcCalls: z.number().int().nonnegative().nullable(), boundedMemoryResume: z.boolean().nullable(),
  }),
});
export type LockedTestInput = z.infer<typeof LockedTestInputSchema>;
/** Persist before inspection. A self-reported flag is preparation, not proof of
 * external blindness; measured workflow attestation remains unavailable. */
export function preregisterLockedTest(input: Pick<LockedTestInput, 'acquisition' | 'freeze' | 'truthHash' | 'sensitivities' | 'operations' | 'independentAuditKinds'>) {
  const body = { version: LOCKED_TEST_VERSION, cohortHash: prepareAcquisition(input.acquisition).manifestHash,
    freezeHash: input.freeze?.freezeHash ?? null, truthHash: input.truthHash, sensitivityHash: referenceDigest(input.sensitivities),
    targetHash: referenceDigest({ pilotTargetHash: input.operations.pilotTargetHash, frozenPerformanceHash: input.operations.frozenPerformanceHash }),
    auditDeclarationHash: referenceDigest(input.independentAuditKinds), labelsInspected: false as const, resamples: 2000 as const };
  return { ...body, hash: referenceDigest(body) };
}
const key = (r: { coin: string; sizeUsd: number; accountClass: string }) => `${r.coin}:${r.sizeUsd}:${r.accountClass}`;
const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
const p95 = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { observations: values.length, completed: known.length, missing: values.length - known.length,
    p95Ms: known.length ? known[Math.ceil(known.length * .95) - 1] : null };
};

/** Does not select, refit, import development counts, activate or release anything. */
export function evaluateLockedFixtures(raw: LockedTestInput, implementationRevision: string) {
  const input = LockedTestInputSchema.parse(raw); Bytes32Schema.parse(implementationRevision);
  if (input.acquisition.origin !== 'fixture') throw new Error('Measured acceptance is unavailable in fixture preparation');
  const cohort = prepareAcquisition(input.acquisition), registration = preregisterDevelopmentFit(input.acquisition);
  if (referenceDigest(input.acquisition) !== referenceDigest(input.labels.assignment.acquisition)) throw new Error('Label cohort mismatch');
  const selected = new Set(cohort.sample?.strata.flatMap(s => s.selected) ?? []);
  const members = cohort.assignments?.filter(a => selected.has(a.coin) && a.calendarSplit === 'locked_test' && a.disposition === 'included') ?? [];
  const byCoin = new Map<string, (typeof members)[number]>(members.map(a => [a.coin, a]));
  const cases = input.labels.assignment.cases;
  if (cases.some(c => !byCoin.has(c.coin))) throw new Error('Only untouched included test cases allowed');
  const allowed = new Set(cases.map(c => c.id));
  if ([...input.labels.decisions, ...input.labels.previous].some(d => !allowed.has(d.record.caseRevisionId))) throw new Error('Development/purged labels cannot enter locked evaluation');
  if (referenceDigest(input.registration) !== referenceDigest(preregisterLockedTest(input))) throw new Error('Locked preregistration mismatch; new untouched cohort required');
  const labels = importLabelDecisions(input.labels.assignment, input.labels.decisions, input.labels.previous);
  const effective = new Map(labels.cases.filter(c => byCoin.has(c.coin)).map(c => [c.coin, c]));
  const weight = (coin: string) => {
    const w = labels.plan.assignments.find(a => a.coin === coin)!.inclusionWeight;
    const value = Number(BigInt(w.numerator)) / Number(BigInt(w.denominator));
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid inclusion weight');
    return value;
  };
  const freeze = input.freeze;
  if (freeze) {
    const { freezeHash, ...body } = freeze;
    if (referenceDigest(body) !== freezeHash || freeze.cohortHash !== cohort.manifestHash ||
        freeze.methodHash !== registration.methodHash || freeze.gridHash !== registration.gridHash) throw new Error('Frozen candidate/cohort/method hash mismatch');
    if (freeze.parameters) {
      if (freeze.status !== 'development_frozen_awaiting_untouched_test' || freeze.parametersHash !== freeze.parameters.parametersHash ||
          !developmentGrid().some(p => referenceDigest(p) === referenceDigest(freeze.parameters))) throw new Error('Frozen parameters outside preregistered grid');
    } else if (freeze.parametersHash || freeze.status !== 'no_eligible_development_candidate') throw new Error('Missing frozen parameters');
  }
  const unique = (keys: string[]) => { if (new Set(keys).size !== keys.length) throw new Error('Duplicate locked evidence'); };
  unique(input.truths.map(key)); unique(input.features.map(key)); unique(input.audits.map(a => `${a.kind}:${a.coin}`));
  unique(input.audits.map(a => a.id)); unique(input.fidelity.map(f => f.id)); unique(input.independentAuditKinds);
  unique(input.sensitivities.map(t => `${key(t)}:${t.entryDelaySec}:${t.exitHoldSec}:${t.measurement}`));
  if (freezeDevelopmentTruths(input.truths) !== input.truthHash) throw new Error('Locked truth hash mismatch');
  const pinned = (coin: string, ids: string[], benchmark?: string) => {
    const c = cases.find(c => c.coin === coin);
    if (!byCoin.has(coin) || !c || ids.some(id => !c.evidenceIds.includes(id as `0x${string}`)) ||
        benchmark && !c.machineOutcome.benchmarkArtifactHashes.includes(benchmark as `0x${string}`)) throw new Error('Evidence outside pinned untouched test');
  };
  for (const t of input.truths) { pinned(t.coin, t.evidenceIds, t.benchmarkHash); validateDevelopmentTruth(t, byCoin.get(t.coin)!.launchSec); }
  for (const f of input.features) {
    const t = input.truths.find(t => key(t) === key(f));
    if (!byCoin.has(f.coin) || f.input.coin !== f.coin || f.input.mode !== 'shadow' || f.input.shadowBooster || !t?.entryCursor || !t.entryCut ||
        referenceDigest(t.entryCursor) !== referenceDigest(f.input.cursor) || referenceDigest(t.entryCut) !== referenceDigest(f.input.availabilityCut) ||
        t.configHash !== f.input.profileHash || f.input.calibrationManifestHash !== cohort.manifestHash ||
        !guardKnownBy(f.input.availabilityCut, input.acquisition.population!.frame.availabilityCut)) throw new Error('Prediction differs from matching frozen entry/config/cut');
  }
  for (const a of input.audits) pinned(a.coin, a.evidenceIds);
  for (const f of input.fidelity) { pinned(f.caseId, f.evidenceIds); if (f.origin !== 'fixture') throw new Error('Fidelity origin mismatch'); }
  for (const t of input.sensitivities) {
    pinned(t.coin, t.evidenceIds, t.benchmarkHash);
    if (t.entryDelaySec === 60 && t.exitHoldSec === 3600) throw new Error('Primary truth cannot be replaced by sensitivity');
    if (t.entryCursor && (t.entryCursor.boundary !== 'block_end' || t.entryCursor.chainId !== 4663 ||
        BigInt(t.entryCursor.timestampSec) < BigInt(byCoin.get(t.coin)!.launchSec) + BigInt(t.entryDelaySec) ||
        t.actualDelaySec !== String(BigInt(t.entryCursor.timestampSec) - BigInt(byCoin.get(t.coin)!.launchSec)) ||
        !t.entryCut || referenceDigest(t.entryCut.cursor) !== referenceDigest(t.entryCursor))) throw new Error('Sensitivity entry before declared delay/cut mismatch');
    if (t.entry.status === 'purchased') {
      if (!t.entryCursor || !t.exit || !t.exitDeadlineSec || t.exitDeadlineSec !== String(BigInt(t.entryCursor.timestampSec) + BigInt(t.exitHoldSec))) throw new Error('Sensitivity horizon mismatch');
      if (t.exitCursor && (t.exitCursor.boundary !== 'block_end' || t.exitCursor.chainId !== 4663 || BigInt(t.exitCursor.timestampSec) < BigInt(t.exitDeadlineSec))) throw new Error('Sensitivity exit before horizon');
      if (['executed', 'token_failure'].includes(t.exit.status) && !t.exitCursor || t.exit.status === 'executed' && !t.returnPct) throw new Error('Sensitivity exit evidence missing');
    } else if (t.exit || t.returnPct || t.exitCursor || t.exitDeadlineSec) throw new Error('Sensitivity entry failure cannot fabricate harm');
  }
  const seed = input.registration.hash;
  const primary = ([100, 1000] as const).flatMap(sizeUsd => (['eoa', 'contract'] as const).map(accountClass => {
    const diagnostics = members.map(a => {
      const t = input.truths.find(t => t.coin === a.coin && t.sizeUsd === sizeUsd && t.accountClass === accountClass);
      const f = input.features.find(f => f.coin === a.coin && f.sizeUsd === sizeUsd && f.accountClass === accountClass);
      const prediction = f && freeze?.parameters ? projectDevelopmentScore(f.input, freeze.parameters) :
        { level: 'incomplete' as const, complete: false, gapFloor: false, factualHigh: false, assignedFactors: [], missing: [freeze?.parameters ? 'features_missing' : 'no_frozen_candidate'] };
      const current = f ? f.input.decisive : [];
      const reviewed = ['agreed', 'adjudicated'].includes(effective.get(a.coin)?.status ?? 'pending') && effective.get(a.coin)?.effectiveAnswers?.outcomeMaturity === 'mature';
      const known = t ? developmentTruthValue(t) : null;
      return { coin: a.coin, groupId: a.groupId, weight: weight(a.coin), ...prediction,
        truth: reviewed ? known : null, machineTruthDiagnostic: known, labelsResolved: reviewed,
        criticalRestriction: t?.criticalRestriction ?? false, entryStatus: t?.entry.status ?? 'missing', exitStatus: t?.exit?.status ?? 'missing',
        entryFailureReason: t && t.entry.status !== 'purchased' ? t.entry.reason : null,
        exitFailureReason: t?.exit && 'reason' in t.exit ? t.exit.reason : null,
        unknownReason: !reviewed ? 'labels_missing_or_unresolved' : known === null ? t?.exit?.status ?? t?.entry.status ?? 'truth_missing' : null,
        venue: t?.venue ?? null, routeId: t?.routeId ?? null, configHash: t?.configHash ?? null, actualDelaySec: t?.actualDelaySec ?? null,
        currentFacts: current, factors: f?.input.observations ?? [],
        policy: { safe: prediction.level !== 'lower' || !prediction.complete, balanced: ['high', 'incomplete'].includes(prediction.level),
          degen: ['high', 'incomplete'].includes(prediction.level), otherPolicyChecksEvaluated: false },
      };
    });
    const metrics = lockedPrimaryMetrics(diagnostics, seed);
    const modes = (['safe', 'balanced', 'degen'] as const).map(mode => {
      const deny = diagnostics.filter(r => r.policy[mode]);
      const knownNonHurt = diagnostics.filter(r => r.truth === false);
      return { mode, allows: diagnostics.length - deny.length, denials: deny.length,
        falseRefusals: deny.filter(r => r.truth === false).length, unknownRefusals: deny.filter(r => r.truth === null).length,
        nonHurtDenominator: knownNonHurt.length, rate: weightedComponentRate(diagnostics.map(r => ({ ...r,
          numerator: r.policy[mode] && r.truth === false, denominator: r.truth === false })), seed),
        currentFactRefusals: deny.filter(r => r.factualHigh).length, fullPolicyFalseRefusals: null,
        interpretation: 'non_hurt_denials_are_benchmark_proxy; full_preflight_and_legitimate_current_fact_refusals_require_separate_review' };
    });
    return { sizeUsd, accountClass, entryDelaySec: 60, exitHoldSec: 3600, ...metrics, modes, diagnostics,
      entryUnavailable: diagnostics.filter(r => r.entryStatus === 'entry_unavailable').length,
      providerCensored: input.truths.filter(t => t.sizeUsd === sizeUsd && t.accountClass === accountClass &&
        (t.entry.status === 'censored' || t.exit?.status === 'censored')).length,
      missingTierCauses: count(diagnostics.flatMap(r => r.missing)) };
  }));
  const reviewedAudits = input.audits.map(a => {
    const answers = effective.get(a.coin)?.effectiveAnswers;
    const permitted = a.kind === 'attribution' ? a.assertedAnswer === 'operator' : a.kind === 'restriction' ? ['restriction', 'none_observed'].includes(a.assertedAnswer) : a.assertedAnswer === 'supported';
    if (!permitted) throw new Error('Audit assertion/question mismatch');
    const answer = a.kind === 'factual' ? answers?.factsAndRoles : a.kind === 'attribution' ? answers?.sellerControl : a.kind === 'text' ? answers?.reasonSupport : answers?.currentMechanism;
    return { ...a, groupId: byCoin.get(a.coin)!.groupId, weight: weight(a.coin),
      denominator: a.supported && answer !== undefined && answer !== 'unresolved', numerator: a.supported && answer === a.assertedAnswer, reviewedAnswer: answer ?? null };
  });
  const audits = (['factual', 'attribution', 'text', 'restriction'] as const).map(kind => {
    const rows = reviewedAudits.filter(a => a.kind === kind), usable = rows.filter(r => r.denominator);
    return { kind, assertions: rows.length, reviewed: usable.length, unknown: rows.length - usable.length,
      distinctCoins: new Set(usable.map(r => r.coin)).size, components: new Set(usable.map(r => r.groupId)).size,
      weighted: weightedComponentRate(rows, seed), independentWilson: independentWilsonAudit(usable, input.independentAuditKinds.includes(kind)) };
  });
  const fidelity = [...new Set(input.truths.map(t => t.venue))].sort().flatMap(venue => primary.map(c => benchmarkFidelityGate(input.fidelity, { venue, sizeUsd: c.sizeUsd, accountClass: c.accountClass })));
  const attribution = audits.find(a => a.kind === 'attribution')!;
  const factual = audits.find(a => a.kind === 'factual')!;
  const text = audits.find(a => a.kind === 'text')!;
  const restrictionRecall = weightedComponentRate(members.map(a => {
    const restricted = effective.get(a.coin)?.effectiveAnswers?.currentMechanism === 'restriction';
    return { groupId: a.groupId, weight: weight(a.coin), denominator: restricted,
      numerator: restricted && reviewedAudits.some(r => r.coin === a.coin && r.kind === 'restriction' && r.assertedAnswer === 'restriction' && r.numerator) };
  }), seed);
  const deterministicPass = input.factualFixtureEvidence !== null && input.factualFixtureEvidence.errors === 0 && input.factualFixtureEvidence.tierPolicyLegacyUntrustedNoLookaheadPassed;
  const sensitivityCoverage = ([5, 30, 60, 300] as const).flatMap(entryDelaySec => ([300, 3600, 86400] as const).flatMap(exitHoldSec =>
    primary.map(c => {
      const rows = entryDelaySec === 60 && exitHoldSec === 3600 ? input.truths : input.sensitivities.filter(t => t.entryDelaySec === entryDelaySec && t.exitHoldSec === exitHoldSec);
      const paths = rows.filter(t => t.sizeUsd === c.sizeUsd && t.accountClass === c.accountClass);
      return { entryDelaySec, exitHoldSec, sizeUsd: c.sizeUsd, accountClass: c.accountClass, expectedCoins: members.length,
        suppliedCoins: new Set(paths.map(t => t.coin)).size, missingCoins: members.length - new Set(paths.map(t => t.coin)).size,
        methods: count(paths.map(t => t.measurement)), knownMachineOutcomesDiagnostic: paths.filter(t =>
          t.entry.status === 'purchased' && (t.exit?.status === 'executed' && t.returnPct || t.exit?.status === 'token_failure' && t.exit.verifiedNoExit && t.exit.validScheduledState)).length };
    })));
  const missingLabels = members.filter(a => !['agreed', 'adjudicated'].includes(effective.get(a.coin)?.status ?? 'pending')).length;
  const blockers = [...(!freeze?.parameters ? ['no frozen candidate'] : []), ...(missingLabels || !members.length ? ['no labels'] : []), 'fixtures are not acceptance'];
  const gateTable = [
    { gate: 'frozen_candidate', numericalPass: !!freeze?.parameters, required: 'eligible immutable development freeze' },
    { gate: 'independent_labels', numericalPass: members.length > 0 && missingLabels === 0, required: 'all untouched test judgments resolved' },
    ...primary.flatMap(c => (['high', 'recall', 'lower'] as const).map(gate => ({ gate: `${gate}:${c.sizeUsd}:${c.accountClass}`, numericalPass: c.numericalGates[gate], required: c.requiredHeldOut }))),
    { gate: 'measurement_fidelity', numericalPass: fidelity.length > 0 && fidelity.every(f => f.passed), required: '30 diverse supported matches per venue/size/class; <=1%; no harm reversal' },
    { gate: 'deterministic_facts_contracts', numericalPass: deterministicPass, required: '38 C1 fixtures; zero errors; tier/policy/legacy/Untrusted/no-lookahead contracts' },
    { gate: 'general_factual_review', numericalPass: factual.assertions > 0 && factual.unknown === 0 && factual.weighted.point === 1, required: 'zero reviewed factual/role errors' },
    { gate: 'current_facts_cost_capability', numericalPass: false, required: 'separate reviewed blocked-exit/current-cost/capability audits; general role review cannot substitute' },
    { gate: 'attribution_control_history', numericalPass: attribution.distinctCoins >= 100 && attribution.components >= 30 &&
      (attribution.weighted.point ?? -1) >= .95 && (attribution.weighted.lower ?? -1) >= .9, required: '100 held-out positive assertions; 30 components; precision >=95%; lower CI >=90%; independent edge/outcome/history ablations still required' },
    { gate: 'critical_restrictions', numericalPass: deterministicPass && (restrictionRecall.point ?? -1) >= .95,
      required: '100% supported reproduced restriction fixtures; >=95% reviewed supported restriction recall; omissions reported' },
    { gate: 'instruction_classifier_precision', numericalPass: text.assertions > 0 && text.unknown === 0 && (text.weighted.point ?? -1) >= .95,
      required: 'reviewed precision >=95%; adversarial zero policy/execution influence and points caps separately required' },
    ...['instruction_adversarial_and_points', 'per_factor_promotion', 'parity', 'operational_readiness'].map(gate => ({ gate, numericalPass: false, required: 'independently verified measured evidence; unavailable in fixture preparation' })),
  ].map(g => ({ ...g, status: 'not_accepted' as const, acceptancePass: false }));
  const ops = input.operations;
  const fields = ['scanMs', 'enrichmentMs', 'probeMs', 'attributionMs', 'alertMs', 'criticalCompletionMs', 'lowerCompletionMs', 'preflightMs'] as const;
  const latency = [...new Set(ops.rows.map(r => `${r.venue}:${r.ageSec}`))].sort().map(slice => {
    const rows = ops.rows.filter(r => `${r.venue}:${r.ageSec}` === slice);
    return { slice, metrics: Object.fromEntries(fields.map(field => [field, p95(rows.map(r => r[field]))])) };
  });
  const report = { version: LOCKED_TEST_VERSION, origin: 'fixture', status: `not accepted: ${blockers.join(', ')}`,
    acceptedCandidate: null, mode: 'shadow', active: false, released: false, lowerEnabled: false, historyEnabled: false, bucketsEnabled: false,
    pins: { implementationRevision, sourceRevision: input.acquisition.population?.frame.sourceRevision ?? null,
      inputHash: referenceDigest(input), datasetHash: cohort.manifestHash, testTruthHash: input.truthHash, labelSetHash: labels.labelSetHash,
      configHashes: [...new Set(input.truths.map(t => t.configHash))].sort(), freezeHash: freeze?.freezeHash ?? null,
      candidateRevision: freeze?.parameters ? freeze.candidateRevision : null, parametersHash: freeze?.parametersHash ?? null,
      methodHash: registration.methodHash, calibrationHash: freeze?.calibrationHash ?? null, lockedRegistrationHash: input.registration.hash,
      evaluationMethodHash: referenceDigest({ version: LOCKED_TEST_VERSION, seed, resamples: 2000 }) },
    gateTable, blockers, primary, fidelity, audits, reviewedAudits, restrictionRecall, factualFixtureEvidence: input.factualFixtureEvidence,
    currentFactPrecision: { blockedExit: null, currentCost: null, capability: null, generalFactualReview: factual },
    attributionBreakdown: { control: attribution, outcomeAblation: null, edgeAblation: null, historyAblation: null, historyEnabled: false },
    suppressedFactors: { enabled: freeze?.parameters?.enabled ?? [], disabled: GUARD_FACTOR_IDS.filter(id => !freeze?.parameters?.enabled.includes(id)),
      history: 'disabled', buckets: 'disabled', unavailablePredictionRows: primary.flatMap(c => c.diagnostics).filter(r => r.level === 'incomplete').length },
    sensitivity: { rows: input.sensitivities, coverage: sensitivityCoverage, supplied: input.sensitivities.length, primaryCredit: 0,
      requiredDelaysSec: [5, 30, 60, 300], requiredFixedHorizonsSec: [300, 3600, 86400], sevenDaySensitivityOnly: true,
      stopTarget: 'unavailable_without_pinned_054_strategy_artifacts', retryAttempts: 'unavailable_without_pinned_054_retry_artifacts',
      lossThresholdsPct: [-10, -30, -50, -90],
      lossThresholdRates: primary.flatMap(c => [-10, -30, -50, -90].map(thresholdPct => ({ sizeUsd: c.sizeUsd, accountClass: c.accountClass, thresholdPct,
        rate: weightedComponentRate(c.diagnostics.map(r => {
          const t = input.truths.find(t => t.coin === r.coin && t.sizeUsd === c.sizeUsd && t.accountClass === c.accountClass);
          const blocked = t?.entry.status === 'purchased' && t.exit?.status === 'token_failure' && t.exit.verifiedNoExit && t.exit.validScheduledState;
          const known = r.labelsResolved && t?.entry.status === 'purchased' && (blocked || t.exit?.status === 'executed' && t.returnPct !== null);
          const hurt = blocked || !!t?.returnPct && BigInt(t.returnPct.numerator) <= BigInt(thresholdPct) * BigInt(t.returnPct.denominator);
          return { groupId: r.groupId, weight: r.weight, denominator: !!known, numerator: !!known && hurt };
        }), seed), primaryCredit: 0 }))),
      quoteUnitCashSensitivity: 'unavailable_without_pinned_cash_artifacts' },
    coverage: { allEnumeratedTokens: cohort.sample?.populationSize ?? 0, probabilitySample: cohort.sample?.sampleSize ?? 0,
      allTestPopulation: cohort.assignments?.filter(a => a.calendarSplit === 'locked_test').length ?? 0, evaluatedTestTokens: members.length,
      expectedPrimaryEntries: members.length * 4, suppliedPrimaryEntries: input.truths.length, missingPrimaryEntries: members.length * 4 - input.truths.length,
      knownReviewedPrimaryEntries: primary.reduce((n, c) => n + c.denominators.knownOutcomes, 0), missingLabelTokens: missingLabels,
      requiredIndependentTestJudgments: members.length * 2,
      submittedIndependentTestJudgments: labels.cases.filter(c => byCoin.has(c.coin)).reduce((n, c) => n + 2 - c.missingSlots.length, 0),
      sources: input.acquisition.sources, assignments: cohort.assignments, developmentCountCredit: 0, measuredTokens: 0,
      censoring: primary.map(c => ({ sizeUsd: c.sizeUsd, accountClass: c.accountClass, providerCensored: c.providerCensored,
        entryUnavailable: c.entryUnavailable, unknownReasons: count(c.diagnostics.flatMap(r => r.unknownReason ? [r.unknownReason] : [])) })) },
    operations: { ...ops, latency, targetsAccepted: false, parityAccepted: false, completionIsNotFastMissingResult: true },
    spend: { actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: null, capNanoUsd: input.acquisition.budget.capNanoUsd,
      paidCapAcceptance: false },
    nextAction: 'new_development_and_new_untouched_test_after_failed_gates; obtain_frozen_candidate_and_independent_labels',
    releaseEvidence: { frozenLiveShadowSeconds: null, frozenLiveShadowLaunches: null, releaseAuthorized: false },
  };
  return { ...report, reportHash: referenceDigest(report) };
}
