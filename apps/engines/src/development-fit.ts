import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, RationalSchema,
  GuardScoreInputSchema, GUARD_FACTOR_IDS, guardKnownBy, type GuardScoreInput, type GuardScoreResult, type FactorId } from '@eko/shared';
import { CONFIG_GUARD_V2, GUARD_PARAMETERS_HASH, evaluateGuardV2, evaluateHistoryBoosterV2 } from '@eko/playbooks';
import { allocateGuardFactors, familyMaxima } from '../../../packages/playbooks/src/guard-allocation.js';
import { AcquisitionDefinitionSchema, prepareAcquisition, type AcquisitionDefinition } from './acquisition-run.js';
import { LabelAssignmentInputSchema, SignedDecisionSchema, importLabelDecisions } from './label-completion.js';
import { BenchmarkFidelityMatchSchema, benchmarkFidelityGate } from './buyer-benchmark.js';
import { BenchmarkEntrySchema, BenchmarkExitSchema } from './buyer-benchmark-input.js';
import { developmentMetrics, selectDevelopmentCandidate, type DevelopmentMetricRow } from './development-fit-statistics.js';

export const DEVELOPMENT_FIT_VERSION = 'development-fit-060.1' as const;
const heuristicIds = GUARD_FACTOR_IDS;
const scales = [80, 100, 120] as const;
const parameters = (lower: number, high: number, enabled: readonly FactorId[], weights: Record<FactorId, number>) => ({
  lower, high, enabled: [...enabled].sort(), weights, compatibility: 'maximum_compatible_assignment',
  familyMax: true, historyEnabled: false, bucketsEnabled: false,
});
/** Finite declared schedules, never a data-driven grid expansion. */
export function developmentGrid() {
  const schedules: { enabled: readonly FactorId[]; weights: Record<FactorId, number> }[] = [];
  const base = Object.fromEntries(heuristicIds.map(id => [id, 100])) as Record<FactorId, number>;
  for (const scale of scales) schedules.push({ enabled: heuristicIds, weights: Object.fromEntries(heuristicIds.map(id => [id, scale])) as Record<FactorId, number> });
  for (const id of heuristicIds) {
    for (const scale of [80, 120]) schedules.push({ enabled: heuristicIds, weights: { ...base, [id]: scale } });
    schedules.push({ enabled: heuristicIds.filter(f => f !== id), weights: base });
  }
  // Fixed small/subset schedules make simplicity selectable without enumerating
  // every Boolean combination of factors or choosing subsets from labels.
  for (const id of heuristicIds) schedules.push({ enabled: [id], weights: base });
  for (let length = 2; length < heuristicIds.length; length++) schedules.push({ enabled: heuristicIds.slice(0, length), weights: base });
  for (const family of ['E', 'O', 'Ff', 'C', 'I']) schedules.push({ enabled: heuristicIds.filter(id => CONFIG_GUARD_V2.factors.find(f => f.id === id)!.family === family), weights: base });
  schedules.push({ enabled: [], weights: base });
  const candidates = [25, 30, 35].flatMap(lower => [55, 60, 65].flatMap(high => schedules.map(s => {
    const value = parameters(lower, high, s.enabled, s.weights);
    return { ...value, parametersHash: referenceDigest(value) };
  })));
  return [...new Map(candidates.map(p => [p.parametersHash, p])).values()].sort((a, b) => a.parametersHash.localeCompare(b.parametersHash));
}
export type DevelopmentParameters = ReturnType<typeof developmentGrid>[number];
// TODO(spec): §9.4 leaves the finite Cartesian search extent and offline wire
// format unspecified. Predeclare uniform/one-factor +/-20%, leave-one-factor-out
// fixed prefixes/families/singletons and facts-only schedules; do not attempt the full 3^22 weight product.
// Precision/recall tie-breaks use the minimum across the four primary cohorts,
// a conservative choice where §9.4 does not prescribe an aggregate.
// This local projection is never an active registry or a production verdict.
const method = {
  version: DEVELOPMENT_FIT_VERSION, baselineParametersHash: GUARD_PARAMETERS_HASH,
  truth: { entryDelaySec: 60, maximumEntryDelaySec: 300, exitHoldSec: 3600, hurtReturnLtePct: -30,
    failure: 'first_valid_scheduled_token_failure', providerGaps: 'censored', sevenDayFitting: false },
  weights: 'nearest_integer_half_up', grid: 'uniform_and_one_factor_80_100_120_fixed_subsets_leave_one_out_facts_only',
  selection: ['fewest_enabled_heuristic_factors', 'highest_high_precision', 'highest_high_only_recall', 'minimum_starting_deviation', 'parameters_hash_ascending'],
  bootstrap: { resamples: 2000, confidencePct: 95, grouping: '058_transitive_components_unresolved_combined', seed: 'preregistration_hash' },
  history: 'disabled_pending_independent_study_diagnostic_only', buckets: 'disabled_pending_conservation',
  developmentCountGate: 'nonempty_defined_intervals_no_credit_toward_untouched_test_minima',
  test: 'locked_labels_and_features_rejected', acceptance: 'requires_separate_untouched_test_and_release_gates',
} as const;
const PreregistrationSchema = z.strictObject({ version: z.literal(DEVELOPMENT_FIT_VERSION), cohortHash: Bytes32Schema,
  methodHash: Bytes32Schema, gridHash: Bytes32Schema, labelsInspected: z.literal(false), hash: Bytes32Schema });
export function preregisterDevelopmentFit(raw: AcquisitionDefinition) {
  const cohort = prepareAcquisition(raw);
  const body = { version: DEVELOPMENT_FIT_VERSION, cohortHash: cohort.manifestHash,
    methodHash: referenceDigest(method), gridHash: referenceDigest(developmentGrid()), labelsInspected: false as const };
  return { ...body, hash: referenceDigest(body) };
}
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const group = { sizeUsd: z.union([z.literal(100), z.literal(1000)]), accountClass: z.enum(['eoa', 'contract']) };
const TruthSchema = z.strictObject({ coin: AddressSchema, ...group, venue: z.string().regex(/^[a-z0-9_]+$/),
  routeId: z.string().regex(/^[a-z0-9_-]+$/), configHash: Bytes32Schema, benchmarkHash: Bytes32Schema,
  entryDelaySec: z.literal(60), exitHoldSec: z.literal(3600), actualDelaySec: uint.nullable(),
  entryCursor: GuardCursorSchema.nullable(), entryCut: AvailabilityCutSchema.nullable(),
  exitDeadlineSec: uint.nullable(), exitCursor: GuardCursorSchema.nullable(),
  measurement: z.enum(['paper', 'persistent', 'real_fifo']), entry: BenchmarkEntrySchema,
  exit: BenchmarkExitSchema.nullable(), returnPct: RationalSchema.nullable(), criticalRestriction: z.boolean(), evidenceIds: z.array(Bytes32Schema).min(1) });
export type DevelopmentTruth = z.infer<typeof TruthSchema>;
export function freezeDevelopmentTruths(truths: DevelopmentTruth[]) { return referenceDigest(truths.map(t => TruthSchema.parse(t)).sort((a, b) => key(a).localeCompare(key(b)))); }
const key = (r: { coin: string; sizeUsd: number; accountClass: string }) => `${r.coin}:${r.sizeUsd}:${r.accountClass}`;
const AuditSchema = z.strictObject({ id: Bytes32Schema, coin: AddressSchema, kind: z.enum(['factual', 'attribution', 'text', 'restriction']),
  assertedAnswer: z.enum(['supported', 'operator', 'restriction', 'none_observed']), supported: z.boolean(), evidenceIds: z.array(Bytes32Schema).min(1) });
export const DevelopmentFitInputSchema = z.strictObject({ version: z.literal(DEVELOPMENT_FIT_VERSION),
  acquisition: AcquisitionDefinitionSchema, preregistration: PreregistrationSchema,
  labels: z.strictObject({ assignment: LabelAssignmentInputSchema, decisions: z.array(SignedDecisionSchema), previous: z.array(SignedDecisionSchema) }),
  truthHash: Bytes32Schema, truths: z.array(TruthSchema),
  features: z.array(z.strictObject({ coin: AddressSchema, ...group, input: GuardScoreInputSchema })),
  fidelity: z.array(BenchmarkFidelityMatchSchema), audits: z.array(AuditSchema),
  factualFixtureEvidence: z.strictObject({ artifactHash: Bytes32Schema, c1Scenarios: z.literal(38), errors: z.number().int().nonnegative(),
    tierPolicyLegacyUntrustedNoLookaheadPassed: z.boolean() }).nullable(),
});
export type DevelopmentFitInput = z.infer<typeof DevelopmentFitInputSchema>;
function truth(t: DevelopmentTruth): boolean | null {
  if (t.entry.status !== 'purchased' || !t.exit) return null;
  if (t.exit.status === 'token_failure') return t.exit.verifiedNoExit && t.exit.validScheduledState ? true : null;
  if (t.exit.status !== 'executed' || !t.returnPct) return null;
  return BigInt(t.returnPct.numerator) <= -30n * BigInt(t.returnPct.denominator);
}
function validateTruth(t: DevelopmentTruth, launchSec: string) {
  if (t.entryCursor) {
    const delay = BigInt(t.entryCursor.timestampSec) - BigInt(launchSec);
    if (t.entryCursor.boundary !== 'block_end' || t.entryCursor.chainId !== 4663 || delay < 60n || delay > 300n ||
      t.actualDelaySec !== delay.toString() || !t.entryCut || referenceDigest(t.entryCut.cursor) !== referenceDigest(t.entryCursor))
      throw new Error('Primary truth entry clock/cut mismatch');
  }
  if (t.entry.status === 'purchased') {
    if (!t.entryCursor || !t.exit || !t.exitDeadlineSec || t.exitDeadlineSec !== (BigInt(t.entryCursor.timestampSec) + 3600n).toString())
      throw new Error('Frozen primary scheduled exit required');
    if (t.exitCursor && (t.exitCursor.boundary !== 'block_end' || t.exitCursor.chainId !== 4663 || BigInt(t.exitCursor.timestampSec) < BigInt(t.exitDeadlineSec)))
      throw new Error('Exit before primary scheduled deadline');
    if ((t.exit.status === 'executed' || t.exit.status === 'token_failure') && !t.exitCursor) throw new Error('Observed exit needs scheduled state');
    if (t.exit.status === 'executed' && !t.returnPct) throw new Error('Executed exit needs frozen return');
  } else if (t.exit || t.returnPct || t.exitCursor || t.exitDeadlineSec) throw new Error('Unavailable entry cannot fabricate an invested loss');
}
export { truth as developmentTruthValue, validateTruth as validateDevelopmentTruth };

export function projectDevelopmentScore(input: GuardScoreInput, p: DevelopmentParameters,
  ablation: 'baseline' | 'no_compatibility' | 'sum_factors' | 'history' = 'baseline', cached?: GuardScoreResult) {
  const result = cached ?? evaluateGuardV2({ ...input, mode: 'shadow', shadowBooster: false });
  const factors = result.assessment.factors.map(f => ({ ...f, suppressionCode: null,
    eligiblePoints: p.enabled.includes(f.id) ? Math.floor((f.eligiblePoints * p.weights[f.id] + 50) / 100) : 0,
    assignedPoints: 0 }));
  const proofs = new Map(input.observations.filter(o => o.mechanism !== null && result.assessment.factors.find(f => f.id === o.id)!.metricIds.length > 0)
    .map(o => [o.id, o.mechanism!]));
  const assigned = allocateGuardFactors(factors, proofs, ablation === 'no_compatibility'
    ? { ...CONFIG_GUARD_V2.compatibility, prohibitedSameMechanism: [] } : CONFIG_GUARD_V2.compatibility);
  const maxima = familyMaxima(assigned);
  const base = Math.min(100, ablation === 'sum_factors' ? factors.reduce((n, f) => n + f.eligiblePoints, 0) : Object.values(maxima).reduce((n, v) => n + v, 0));
  const history = ablation === 'history' ? evaluateHistoryBoosterV2({ coin: input.coin, cursor: input.cursor,
    availabilityCut: input.availabilityCut, baseScore: base, factors: assigned, mode: 'shadow', booster: 'shadow', source: input.historySource }) : null;
  const score = history?.score ?? base, factualHigh = result.assessment.decisiveIds.length > 0 || result.assessment.factors.some(f => f.id === 'arbitrary_control' && f.eligiblePoints >= 60);
  const observed = factualHigh || score >= p.high ? 'high' : score >= p.lower ? 'elevated' : 'lower';
  const completeness = result.assessment.completeness;
  const level: DevelopmentMetricRow['level'] = observed === 'high' ? 'high' : !completeness.buyCriticalComplete ? 'incomplete' : !completeness.lowerTierComplete ? 'elevated' : observed;
  return { level, observedLevel: observed, baseScore: base, score, factualHigh, assignedFactors: assigned,
    complete: completeness.buyCriticalComplete && completeness.lowerTierComplete,
    gapFloor: observed === 'lower' && level === 'elevated', missing: completeness.missing,
    history: history ? { points: history.historyPoints, gaps: history.gaps } : null };
}

/** Offline development only. Even measured development cannot accept/release a
 * candidate; untouched test and release evaluation belong to the following packet. */
export function fitDevelopment(raw: DevelopmentFitInput, candidateRevision: string) {
  const input = DevelopmentFitInputSchema.parse(raw);
  Bytes32Schema.parse(candidateRevision);
  const cohort = prepareAcquisition(input.acquisition), registration = preregisterDevelopmentFit(input.acquisition);
  if (referenceDigest(input.preregistration) !== referenceDigest(registration) ||
    referenceDigest(input.labels.assignment.acquisition) !== referenceDigest(input.acquisition)) throw new Error('Frozen preregistration/cohort mismatch');
  const dev = cohort.assignments?.filter(a => a.calendarSplit !== 'locked_test' && a.disposition === 'included' &&
    cohort.sample!.strata.some(s => s.selected.includes(a.coin))) ?? [];
  const byCoin = new Map<string, (typeof dev)[number]>(dev.map(a => [a.coin, a]));
  if (input.labels.assignment.cases.some(c => !byCoin.has(c.coin))) throw new Error('Locked/purged case payloads must remain outside development input');
  const allowedCases = new Set(input.labels.assignment.cases.filter(c => byCoin.has(c.coin)).map(c => c.id));
  // Reject before importing/comparing any answers, including prior ledger/test revisions.
  if ([...input.labels.decisions, ...input.labels.previous].some(d => !allowedCases.has(d.record.caseRevisionId)))
    throw new Error('Only included purged development judgments may enter fitting');
  const labels = importLabelDecisions(input.labels.assignment, input.labels.decisions, input.labels.previous);
  if (input.truthHash !== freezeDevelopmentTruths(input.truths)) throw new Error('Frozen truth hash mismatch');
  if (new Set(input.truths.map(key)).size !== input.truths.length || new Set(input.features.map(key)).size !== input.features.length ||
    (new Set(input.audits.map(a => a.id)).size !== input.audits.length || new Set(input.audits.map(a => `${a.kind}:${a.coin}`)).size !== input.audits.length) || new Set(input.fidelity.map(f => f.id)).size !== input.fidelity.length)
    throw new Error('Duplicate development evidence');
  for (const t of input.truths) {
    const a = byCoin.get(t.coin); if (!a) throw new Error('Truth outside included purged development');
    validateTruth(t, a.launchSec);
    const c = labels.plan.assignments.find(p => p.coin === t.coin)?.case;
    if (!c || !c.machineOutcome.benchmarkArtifactHashes.includes(t.benchmarkHash) || t.evidenceIds.some(id => !c.evidenceIds.includes(id)))
      throw new Error('Truth needs pinned benchmark and review evidence');
  }
  for (const f of input.features) {
    const t = input.truths.find(t => key(t) === key(f));
    if (!byCoin.has(f.coin) || f.input.coin !== f.coin || f.input.mode !== 'shadow' || f.input.shadowBooster ||
      !t?.entryCursor || !t.entryCut || referenceDigest(f.input.cursor) !== referenceDigest(t.entryCursor) ||
      referenceDigest(f.input.availabilityCut) !== referenceDigest(t.entryCut) ||
      f.input.profileHash !== t.configHash || f.input.calibrationManifestHash !== registration.cohortHash ||
      !guardKnownBy(f.input.availabilityCut, input.acquisition.population!.frame.availabilityCut)) throw new Error('Development feature does not match frozen entry cut/config/cohort');
  }
  for (const a of input.audits) {
    const pinned = labels.plan.assignments.find(p => p.coin === a.coin)?.case;
    if (!byCoin.has(a.coin) || !pinned || a.evidenceIds.some(id => !pinned.evidenceIds.includes(id))) throw new Error('Audit outside pinned development case evidence');
  }
  // Fidelity cases are development tokens, not arbitrary held-out comparison rows.
  for (const f of input.fidelity) {
    const c = labels.plan.assignments.find(p => p.coin === f.caseId)?.case;
    if (f.origin !== input.acquisition.origin || !byCoin.has(f.caseId) || !c || f.evidenceIds.some(id => !c.evidenceIds.includes(id)))
      throw new Error('Fidelity outside pinned development/origin');
  }
  const cohorts = ([100, 1000] as const).flatMap(sizeUsd => (['eoa', 'contract'] as const).map(accountClass => ({ sizeUsd, accountClass })));
  const effective = new Map(labels.cases.filter(c => byCoin.has(c.coin)).map(c => [c.coin, c]));
  const labelGaps = dev.filter(a => !['agreed', 'adjudicated'].includes(effective.get(a.coin)?.status ?? 'pending'));
  const expectedUnits = dev.length * 4, missingTruths = expectedUnits - input.truths.length;
  const fidelity = [...new Set(input.truths.map(t => t.venue))].sort().flatMap(venue => cohorts.map(c => benchmarkFidelityGate(input.fidelity, { venue, ...c })));
  const measured = input.acquisition.origin === 'measured';
  const fidelityPassed = fidelity.length > 0 && fidelity.every(f => f.passed);
  const reviewedAudits = input.audits.map(a => {
    const answers = effective.get(a.coin)?.effectiveAnswers;
    const answer = a.kind === 'factual' ? answers?.factsAndRoles : a.kind === 'attribution' ? answers?.sellerControl :
      a.kind === 'text' ? answers?.reasonSupport : answers?.currentMechanism;
    const permitted = a.kind === 'attribution' ? a.assertedAnswer === 'operator' : a.kind === 'restriction' ?
      ['restriction', 'none_observed'].includes(a.assertedAnswer) : a.assertedAnswer === 'supported';
    if (!permitted) throw new Error('Audit assertion does not match review question');
    return { ...a, supported: a.supported && answer !== undefined && answer !== 'unresolved',
      correct: answer === a.assertedAnswer, reviewedAnswer: answer ?? null };
  });
  const audit = (kind: (typeof input.audits)[number]['kind']) => {
    const rows = reviewedAudits.filter(a => a.kind === kind), usable = rows.filter(a => a.supported);
    const metric = developmentMetrics(usable.map(a => ({ coin: a.coin, groupId: byCoin.get(a.coin)!.groupId,
      weight: weight(a.coin), truth: a.correct, level: 'high', complete: true, gapFloor: false, factualHigh: false, criticalRestriction: false })), registration.hash);
    return { assertions: rows.length, supported: usable.length, errors: usable.filter(a => !a.correct).length,
      precision: metric.point.highPrecision, lowerCI: metric.intervals.highPrecision.lower,
      components: metric.independentGroups, distinctTokens: metric.knownHigh, unsupported: rows.length - usable.length };
  };
  function weight(coin: string) {
    const w = labels.plan.assignments.find(a => a.coin === coin)!.inclusionWeight;
    return Number(BigInt(w.numerator)) / Number(BigInt(w.denominator));
  }
  const audits = { factual: audit('factual'), attribution: audit('attribution'), text: audit('text'), restriction: audit('restriction') };
  const factsPassed = input.factualFixtureEvidence !== null && input.factualFixtureEvidence.errors === 0 &&
    input.factualFixtureEvidence.tierPolicyLegacyUntrustedNoLookaheadPassed && audits.factual.assertions > 0 &&
    audits.factual.unsupported === 0 && audits.factual.errors === 0;
  const attributionPassed = (audits.attribution.precision ?? -1) >= .95 && (audits.attribution.lowerCI ?? -1) >= .9 && audits.attribution.distinctTokens >= 100 && audits.attribution.components >= 30;
  const textPassed = (audits.text.precision ?? -1) >= .95 && audits.text.unsupported === 0 && audits.text.assertions > 0;
  const reviewedRestrictions = dev.filter(a => effective.get(a.coin)?.effectiveAnswers?.currentMechanism === 'restriction');
  const detectedRestrictions = reviewedRestrictions.filter(a => reviewedAudits.some(r => r.coin === a.coin && r.kind === 'restriction' &&
    r.assertedAnswer === 'restriction' && r.supported && r.correct));
  const restrictionRecall = reviewedRestrictions.length ? detectedRestrictions.reduce((n, a) => n + weight(a.coin), 0) /
    reviewedRestrictions.reduce((n, a) => n + weight(a.coin), 0) : null;
  const restrictionsPassed = (restrictionRecall ?? -1) >= .95 && audits.restriction.unsupported === 0;
  const blockers = [ ...(!measured ? ['fixture_only_no_measured_validation'] : []), ...(!dev.length ? ['empty_development'] : []),
    ...(labelGaps.length ? ['development_labels_pending'] : []), ...(missingTruths ? ['development_primary_units_missing'] : []),
    ...(!fidelityPassed ? ['measurement_fidelity_unpassed'] : []), ...(!factsPassed ? ['factual_gate_unpassed'] : []),
    ...(!attributionPassed ? ['attribution_gate_unpassed'] : []), ...(!textPassed ? ['text_gate_unpassed'] : []), ...(!restrictionsPassed ? ['restriction_gate_unpassed'] : []) ];
  const featureScores = new Map(input.features.map(f => [key(f), evaluateGuardV2(f.input)]));
  const metricCache = new Map<string, ReturnType<typeof developmentMetrics>>();
  const metrics = (p: DevelopmentParameters, split: 'fitting' | 'validation', ablation: Parameters<typeof projectDevelopmentScore>[2] = 'baseline') => cohorts.map(c => {
    const members = dev.filter(d => d.calendarSplit === split);
    const diagnostics = members.map(a => {
      const t = input.truths.find(t => t.coin === a.coin && t.sizeUsd === c.sizeUsd && t.accountClass === c.accountClass);
      const f = input.features.find(f => f.coin === a.coin && f.sizeUsd === c.sizeUsd && f.accountClass === c.accountClass);
      const prediction = f ? projectDevelopmentScore(f.input, p, ablation, featureScores.get(key(f))) : { level: 'incomplete' as const, complete: false, gapFloor: false, factualHigh: false, missing: ['features_missing'], history: null };
      const known = t ? truth(t) : null;
      return { coin: a.coin, groupId: a.groupId, weight: weight(a.coin), truth: known, level: prediction.level,
        complete: prediction.complete, gapFloor: prediction.gapFloor, factualHigh: prediction.factualHigh,
        criticalRestriction: t?.criticalRestriction ?? false, status: t?.entry.status ?? 'missing',
        policy: { safe: prediction.level === 'lower' && prediction.complete ? 'level_gate_continue' : 'level_gate_deny',
          balanced: ['high', 'incomplete'].includes(prediction.level) ? 'level_gate_deny' : 'level_gate_continue',
          degen: ['high', 'incomplete'].includes(prediction.level) ? 'level_gate_deny' : 'level_gate_continue',
          otherPolicyChecksEvaluated: false }, missing: prediction.missing, history: prediction.history };
    });
    const rows: DevelopmentMetricRow[] = diagnostics.map(({ coin, groupId, weight, truth, level, complete, gapFloor, factualHigh, criticalRestriction }) =>
      ({ coin, groupId, weight, truth, level, complete, gapFloor, factualHigh, criticalRestriction }));
    const digest = referenceDigest(rows), prior = metricCache.get(digest);
    const result = prior ?? developmentMetrics(rows, registration.hash); if (!prior) metricCache.set(digest, result);
    return { ...c, ...result, predictionHash: digest, entryUnavailable: diagnostics.filter(d => d.status === 'entry_unavailable').length,
      censoredOrUnsupported: diagnostics.filter(d => ['censored', 'unsupported'].includes(d.status)).length,
      missingTierCauses: Object.fromEntries([...new Set(diagnostics.flatMap(d => d.missing))].sort().map(id => [id, diagnostics.filter(d => (d.missing as string[]).includes(id)).length])),
      diagnostics };
  });
  const grid = developmentGrid();
  const trials = grid.map(p => {
    const validation = metrics(p, 'validation').map(({ diagnostics: _, ...summary }) => summary);
    const needsAttribution = p.enabled.some(id => CONFIG_GUARD_V2.factors.find(f => f.id === id)!.gate.includes('attribution'));
    const eligible = measured && dev.length > 0 && !labelGaps.length && !missingTruths && fidelityPassed && factsPassed && restrictionsPassed &&
      (!needsAttribution || attributionPassed) && (!p.enabled.includes('agent_instruction') || textPassed) &&
      validation.every(c => c.gates.high && c.gates.recall && c.gates.lower && c.missingOutcomes === 0);
    return { parameters: p, parametersHash: p.parametersHash, enabledHeuristicFactors: p.enabled.length,
      highPrecision: Math.min(...validation.map(c => c.point.highPrecision ?? -1)),
      highOnlyRecall: Math.min(...validation.map(c => c.point.highOnlyRecall ?? -1)),
      deviation: Math.abs(p.lower - 30) + Math.abs(p.high - 60) + heuristicIds.reduce((n, id) => n +
        (p.enabled.includes(id) ? CONFIG_GUARD_V2.factors.find(f => f.id === id)!.points.reduce<number>((sum, v) => sum + Math.abs(Math.floor((v * p.weights[id] + 50) / 100) - v), 0) : CONFIG_GUARD_V2.factors.find(f => f.id === id)!.points.reduce<number>((sum, v) => sum + v, 0)), 0),
      eligible, validation };
  });
  const promotionEvidence = trials.filter(t => t.eligible).map(t => {
    const factors = t.parameters.enabled.map(id => {
      const removed = { ...t.parameters, enabled: t.parameters.enabled.filter(f => f !== id) };
      const validation = metrics(removed, 'validation');
      const improves = t.validation.every((c, i) => (c.point.highPrecision ?? -1) >= (validation[i].point.highPrecision ?? -1) &&
        (c.point.highOnlyRecall ?? -1) >= (validation[i].point.highOnlyRecall ?? -1)) &&
        t.validation.some((c, i) => (c.point.highOnlyRecall ?? -1) > (validation[i].point.highOnlyRecall ?? -1) ||
          (c.point.highPrecision ?? -1) > (validation[i].point.highPrecision ?? -1));
      return { id, improves, validation, selectionEligible: false };
    });
    if (factors.some(f => !f.improves)) t.eligible = false;
    return { parametersHash: t.parametersHash, factors };
  });
  const selected = selectDevelopmentCandidate(trials);
  // Diagnostics always use preregistered starting parameters when gates fail;
  // no "best fixture" is substituted for an eligible development candidate.
  const baseline = grid.find(p => p.lower === 30 && p.high === 60 && p.enabled.length === heuristicIds.length && heuristicIds.every(id => p.weights[id] === 100))!;
  const diagnosticParameters = selected?.parameters ?? baseline;
  const ablations = (['no_compatibility', 'sum_factors', 'history'] as const).map(name => ({ name, selectionEligible: false,
    validation: metrics(diagnosticParameters, 'validation', name) }));
  const fitting = metrics(diagnosticParameters, 'fitting');
  const evidence = { registration, truthHash: input.truthHash, labelSetHash: labels.labelSetHash, cohortHash: cohort.manifestHash,
    inputHash: referenceDigest(input), fidelity, audits, reviewedAudits, restrictionRecall, factualFixtureEvidence: input.factualFixtureEvidence,
    blockers, trials, promotionEvidence, fitting, validation: metrics(diagnosticParameters, 'validation'), ablations, baselineParametersHash: baseline.parametersHash,
    actualValidation: { origin: input.acquisition.origin, measuredTokens: measured ? dev.length : 0, fixtureTokens: measured ? 0 : dev.length,
      developmentJudgments: labels.decisions.length, independentJudgments: labels.decisions.filter(d => d.kind === 'independent').length,
      requiredDevelopmentJudgments: dev.length * 2, missingDevelopmentJudgments: labels.cases.filter(c => byCoin.has(c.coin)).reduce((n, c) => n + c.missingSlots.length, 0), pendingDevelopmentTokens: labelGaps.length, expectedUnits, suppliedUnits: input.truths.length },
    coverage: { enumerated: cohort.sample?.populationSize ?? null, selected: cohort.sample?.sampleSize ?? null,
      remainingPrimarySample: cohort.remainingPrimarySample, purgedOrGroupHeldOut: cohort.assignments?.filter(a => a.disposition !== 'included').length ?? null,
      heldOutLabelsInspected: 0, heldOutFeaturesInspected: 0 }, method };
  const calibrationHash = referenceDigest(evidence);
  const freeze = { version: DEVELOPMENT_FIT_VERSION, candidateRevision, cohortHash: cohort.manifestHash,
    methodHash: registration.methodHash, gridHash: registration.gridHash, truthHash: input.truthHash, labelSetHash: labels.labelSetHash,
    calibrationHash, parametersHash: selected?.parametersHash ?? null, parameters: selected?.parameters ?? null,
    status: selected ? 'development_frozen_awaiting_untouched_test' : 'no_eligible_development_candidate',
    acceptedCandidate: null, heldOutTestRequired: true, mode: 'shadow', active: false, released: false,
    historyEnabled: false, bucketsEnabled: false };
  return { evidence, freeze: { ...freeze, freezeHash: referenceDigest(freeze) }, acceptedCandidate: null,
    blockers: [...blockers, ...(!selected ? ['no_candidate_meets_development_gates'] : []), 'untouched_test_and_release_pending'], mode: 'shadow', active: false, released: false };
}
