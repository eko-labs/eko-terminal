import { canonicalize } from '@eko/policy';
import { GuardHistoryInputSchema, GuardHistoryResultSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { Address, AvailabilityCut, GuardCoverage, GuardCursor, GuardHistoryAttribution, GuardHistoryInput,
  GuardHistoryResult, GuardHistorySource, Metric, MetricId } from '@eko/shared';
import { CONFIG_GUARD_V2 } from '../config/guard-v2.js';

const parameter = (id: string) => CONFIG_GUARD_V2.parameters.find(p => p.id === id)!;
const [windowSec, horizonSec, minimumBad, lowerRate, upperRate, recencySec, minimumBase, lowerPoints, upperPoints] =
  parameter('history_booster').value as readonly number[];
const confirmationLag = BigInt(parameter('confirmation_lag').value as number);
const recentFundingSec = BigInt((parameter('recent_funder').value as readonly number[])[0]);
const collectionSec = BigInt((parameter('collector').value as readonly number[])[1]);
const methodVersion = CONFIG_GUARD_V2.rulesVersion;
type Assessment = GuardHistorySource['assessments'][number];
type Outcome = GuardHistorySource['outcomes'][number];
const time = (cursor: GuardCursor) => BigInt(cursor.timestampSec);

/** Guard §§4.1/5.2–5.3. Pure captured inputs; never loads legacy history, SQL, RPC or wall time. */
export function evaluateHistoryBoosterV2(raw: GuardHistoryInput): GuardHistoryResult {
  const input = GuardHistoryInputSchema.parse(raw), { cursor, availabilityCut, source } = input;
  if (cursor.boundary !== 'block_end' || compareGuardCursors(cursor, availabilityCut.cursor) > 0)
    throw new Error('History requires a captured completed block-end cursor');
  const T = time(cursor), start = T > BigInt(windowSec) ? T - BigInt(windowSec) : 0n;
  const available = (at: GuardCursor, known: AvailabilityCut) => compareGuardCursors(at, cursor) <= 0 &&
    compareGuardCursors(at, known.cursor) <= 0 && guardKnownBy(known, availabilityCut);
  const active = input.factors.filter(f => input.mode !== 'active' || f.calibration === 'released');
  if (new Set(active.map(f => f.id)).size !== active.length) throw new Error('Duplicate current history-gate factor');
  const families = ['E', 'O', 'Ff', 'C', 'I'] as const;
  const base = Math.min(100, families.reduce((n, family) => n + Math.max(0, ...active.filter(f => f.family === family).map(f => f.assignedPoints)), 0));
  if (base !== input.baseScore) throw new Error('History base must equal current assigned family maxima');
  const exposure = active.find(f => f.assignedPoints > 0 && ['E', 'O', 'C'].includes(f.family));
  const gaps = new Set<GuardHistoryResult['gaps'][number]>(), evidence = new Set<string>();
  const op = source?.operator;
  const effective = (from: GuardCursor, through: GuardCursor | null, at: GuardCursor) => compareGuardCursors(from, at) <= 0 &&
    (through === null || compareGuardCursors(at, through) <= 0);
  const operatorKnown = op !== undefined && available(op.effectiveFrom, op.knownAt) &&
    effective(op.effectiveFrom, op.effectiveThrough, cursor) && op.group.kind === 'control' &&
    op.group.graphVersion === CONFIG_GUARD_V2.identityVersion && op.group.memberIds.includes(op.principal);
  if (!operatorKnown) gaps.add('operator_unresolved');
  const serviceFree = op !== undefined && op.serviceStatus === 'not_service' &&
    !op.group.memberIds.some(a => op.serviceAddresses.includes(a));
  if (op && !serviceFree) gaps.add('service_scope');
  if (op) for (const id of op.evidenceIds) evidence.add(id);
  const covers = (coverage: GuardCoverage, from: GuardCursor, through: GuardCursor) => coverage.complete && coverage.from !== null &&
    coverage.through !== null && compareGuardCursors(coverage.from, from) <= 0 && compareGuardCursors(coverage.through, through) >= 0 &&
    compareGuardCursors(coverage.through, cursor) <= 0;
  const enumerationKnown = source !== null && available(source.enumeration.coverage.through ?? cursor, source.enumeration.knownAt);
  const enumerated = enumerationKnown && source!.enumeration.coverage.complete && source!.enumeration.coverage.from !== null &&
    time(source!.enumeration.coverage.from!) <= start && covers(source!.enumeration.coverage, source!.enumeration.coverage.from!, cursor);
  if (!enumerated) gaps.add('enumeration_missing');

  const proofValid = (p: GuardHistoryAttribution | null, at: GuardCursor, actor?: Address): boolean => {
    if (!operatorKnown || !serviceFree || !p || p.operatorGroupId !== op!.group.id || p.principal !== op!.principal ||
      !available(p.effectiveFrom, p.knownAt) || !effective(p.effectiveFrom, p.effectiveThrough, at) ||
      actor !== undefined && p.actor !== actor || op!.serviceAddresses.includes(p.actor)) return false;
    if (p.kind === 'authenticated_principal') return p.actor === op!.principal;
    if (p.kind === 'authenticated_control') return op!.group.memberIds.includes(p.actor);
    if (p.kind !== 'reviewed_closed_loop' || !p.loop) return false;
    const l = p.loop;
    return l.reviewed && l.serviceFree && l.funder === l.collector && op!.group.memberIds.includes(l.funder) &&
      !op!.serviceAddresses.includes(l.funder) && l.fundingBps !== null && l.fundingBps >= 9000 && l.collectionBps !== null && l.collectionBps >= 9000 &&
      available(l.collectedAt, p.knownAt) && compareGuardCursors(l.fundedAt, l.boughtAt) < 0 && compareGuardCursors(l.boughtAt, l.soldAt) <= 0 &&
      compareGuardCursors(l.soldAt, l.collectedAt) <= 0 && compareGuardCursors(l.soldAt, at) === 0 &&
      time(l.boughtAt) - time(l.fundedAt) <= recentFundingSec && time(l.collectedAt) - time(l.soldAt) <= collectionSec &&
      covers(l.fundingCoverage, l.fundedAt, l.boughtAt) && covers(l.collectionCoverage, l.soldAt, l.collectedAt);
  };
  const unique = <R>(rows: R[], key: (r: R) => string) => {
    const result = new Map<string, R>();
    for (const row of rows) { const id = key(row), prior = result.get(id);
      if (prior && canonicalize(prior) !== canonicalize(row)) throw new Error('Conflicting duplicate history record');
      result.set(id, row);
    }
    return [...result.values()];
  };
  const launches = unique((source?.launches ?? []).filter(l => available(l.launchedAt, l.knownAt) && l.coin !== input.coin &&
    time(l.launchedAt) > start && time(l.launchedAt) <= T), l => l.coin).sort((a, b) => compareGuardCursors(a.launchedAt, b.launchedAt) || a.coin.localeCompare(b.coin));
  const assessments = unique((source?.assessments ?? []).filter(a => available(a.confirmationThrough, a.knownAt)), a => a.id);
  const outcomes = unique((source?.outcomes ?? []).filter(o => available(o.eventCursor, o.outcome.knownAt)), o => o.outcome.id);
  const superseded = new Set(outcomes.flatMap(o => o.outcome.supersedes ? [o.outcome.supersedes] : []));
  const outcomesById = new Map(outcomes.filter(o => !superseded.has(o.outcome.id)).map(o => [o.outcome.id, o]));
  let eligibleMature = 0, assessedMature = 0, badMature = 0;
  const adverse: Outcome[] = [], outcomeIds = new Set<`0x${string}`>();
  const validAssessment = (a: Assessment, launchedAt: GuardCursor) => a.firstBoundaryAfterHorizon && compareGuardCursors(a.entryCursor, launchedAt) === 0 &&
    a.maturityCursor.boundary === 'block_end' && time(a.maturityCursor) >= time(launchedAt) + BigInt(horizonSec) &&
    a.confirmationThrough.boundary === 'block_end' && time(a.confirmationThrough) >= time(a.maturityCursor) + confirmationLag &&
    a.canonicalRechecked && a.calibrated && a.outcomeVersion === CONFIG_GUARD_V2.outcomeVersion && a.identityVersion === CONFIG_GUARD_V2.identityVersion &&
    covers(a.coverage, launchedAt, a.confirmationThrough);
  const validOutcome = (o: Outcome, a: Assessment) => o.calibrated && o.outcomeVersion === a.outcomeVersion && o.identityVersion === a.identityVersion &&
    o.outcome.coin === a.coin && o.outcome.horizonSec === horizonSec && o.outcome.status === 'confirmed_under_policy' &&
    compareGuardCursors(o.outcome.entryCursor, a.entryCursor) === 0 && o.outcome.maturityCursor !== null &&
    compareGuardCursors(o.outcome.maturityCursor, a.maturityCursor) === 0 && available(o.outcome.maturityCursor, o.outcome.knownAt) &&
    time(o.outcome.knownAt.cursor) >= time(a.maturityCursor) + confirmationLag && compareGuardCursors(o.eventCursor, a.maturityCursor) <= 0 &&
    compareGuardCursors(o.eventCursor, a.entryCursor) >= 0 && covers(o.outcome.coverage, a.entryCursor, a.maturityCursor) &&
    guardKnownBy(o.outcome.knownAt, a.knownAt);
  for (const launch of launches) {
    if (!operatorKnown || !serviceFree) continue;
    if (launch.attribution && available(launch.attribution.effectiveFrom, launch.attribution.knownAt) &&
      ['service', 'outsider'].includes(launch.attribution.kind)) continue;
    // Loop sale/collection can qualify a past launch only after those facts are actually known.
    const launchAttributionAt = launch.attribution?.kind === 'reviewed_closed_loop' ? launch.attribution.loop?.soldAt ?? launch.launchedAt : launch.launchedAt;
    if (!proofValid(launch.attribution, launchAttributionAt)) { gaps.add('launch_attribution_missing'); continue; }
    for (const id of launch.attribution!.evidenceIds) evidence.add(id);
    if (time(launch.launchedAt) + BigInt(horizonSec) > T) continue;
    eligibleMature++;
    const a = assessments.filter(a => a.coin === launch.coin)
      .sort((a, b) => compareGuardCursors(a.knownAt.cursor, b.knownAt.cursor) ||
        (BigInt(a.knownAt.acquisitionSequence) < BigInt(b.knownAt.acquisitionSequence) ? -1 : BigInt(a.knownAt.acquisitionSequence) > BigInt(b.knownAt.acquisitionSequence) ? 1 : a.id.localeCompare(b.id))).at(-1);
    const records = a?.outcomeIds.map(id => outcomesById.get(id));
    if (!a || !validAssessment(a, launch.launchedAt) || !records || records.some(o => !o || !validOutcome(o, a))) { gaps.add('assessment_missing'); continue; }
    const own = records.filter((o): o is Outcome => o !== undefined && ['dump', 'rug', 'restriction'].includes(o.outcome.kind) && o.outcome.attribution === 'operator');
    if (own.some(o => !proofValid(o.attribution, o.eventCursor,
      o.outcome.kind === 'restriction' ? o.outcome.controller.value ?? undefined : undefined) ||
      o.outcome.kind === 'restriction' && (o.outcome.controller.status !== 'observed' ||
        !available(o.outcome.controller.cursor, o.outcome.controller.knownAt) ||
        compareGuardCursors(o.outcome.controller.cursor, o.eventCursor) > 0 || !guardKnownBy(o.outcome.controller.knownAt, o.outcome.knownAt))))
      { gaps.add('assessment_missing'); continue; }
    if (records.some(o => o && ['dump', 'rug', 'restriction', 'harmful_disposition'].includes(o.outcome.kind) &&
      ['unknown', 'origin_unresolved'].includes(o.outcome.attribution))) { gaps.add('assessment_missing'); continue; }
    assessedMature++;
    for (const o of records as Outcome[]) { outcomeIds.add(o.outcome.id as `0x${string}`); for (const id of o.outcome.evidenceIds) evidence.add(id); }
    if (own.length) { badMature++; adverse.push(...own); for (const o of own) for (const id of o.attribution!.evidenceIds) evidence.add(id); }
  }
  const historyComplete = gaps.size === 0;
  const coverage = (scope: string, complete: boolean): GuardCoverage => ({
    scopeId: scope, from: enumerationKnown ? source!.enumeration.coverage.from : null, through: cursor,
    complete, gaps: complete ? [] : ['missing'], methodVersion, coveredUnits: null, excludedUnits: null,
    topLevelNative: false, internalNative: false, firstEverEstablished: false,
    sourceHashes: enumerationKnown ? source!.enumeration.coverage.sourceHashes : [],
  });
  const enumeration = coverage('history-enumeration', operatorKnown && serviceFree && enumerated && !gaps.has('launch_attribution_missing'));
  const assessment = coverage('history-assessment', historyComplete);
  const metric = <TValue>(id: MetricId, value: TValue | null, unit: Metric<TValue>['unit'], numerator: string | null = null,
    denominator: string | null = null): Metric<TValue> => ({
    id, unit, cursor, knownAt: availabilityCut, fromSec: start.toString(), throughSec: cursor.timestampSec,
    numerator, denominator, denominatorKind: denominator === null ? null : 'other', methodVersion, evidenceIds: [...evidence].sort(),
    coverage: assessment, ...(value === null ? { status: 'unknown', value: null, failureCode: 'missing' } : { status: 'observed', value, failureCode: null }),
  });
  adverse.sort((a, b) => compareGuardCursors(a.eventCursor, b.eventCursor) || a.outcome.id.localeCompare(b.outcome.id));
  const recent = adverse.at(-1);
  const recentEnough = recent !== undefined && T - time(recent.eventCursor) <= BigInt(recencySec);
  const candidatePoints = historyComplete && assessedMature > 0 && badMature >= minimumBad && base >= minimumBase && exposure &&
    recentEnough
    ? BigInt(badMature) * 100n >= BigInt(assessedMature) * BigInt(upperRate) ? upperPoints :
      BigInt(badMature) * 100n >= BigInt(assessedMature) * BigInt(lowerRate) ? lowerPoints : 0 : 0;
  // Registry remains unreleased. Explicit shadow experiments cannot affect active scores/orders.
  const historyPoints = input.mode === 'shadow' && input.booster === 'shadow' ? candidatePoints : 0;
  const history = { operatorGroup: operatorKnown && serviceFree ? op!.group : null, windowSec, horizonSec,
    from: enumeration.from ?? cursor, through: cursor, enumeration, assessment, eligibleMature, assessedMature, badMature,
    badRate: metric('badRate', historyComplete && assessedMature > 0 ? ratioDecimal(badMature, assessedMature) : null, 'ratio',
      historyComplete ? String(badMature) : null, historyComplete && assessedMature > 0 ? String(assessedMature) : null),
    recentAdverse: metric('recentAdverse', historyComplete && recentEnough ? recent!.outcome.id : null, 'hash'),
    booster: input.mode === 'shadow' && input.booster === 'shadow' ? 'shadow' : 'disabled', outcomeIds: [...outcomeIds].sort() };
  return GuardHistoryResultSchema.parse({ history, candidatePoints, historyPoints, score: Math.min(100, base + historyPoints),
    check: { id: 'operator_history', tier: 'lower_tier', status: historyComplete ? 'complete' : 'missing', coverage: assessment,
      evidenceIds: [...evidence].sort(), failureCode: historyComplete ? null : 'missing' }, gaps: [...gaps].sort(),
    reason: historyPoints > 0 ? { code: 'HISTORY', factorId: null, parameters: { badCount: badMature, matureCount: assessedMature,
      historyWindowSec: windowSec, exposureType: exposure!.family === 'E' ? 'execution' : exposure!.family === 'O' ? 'ownership' : 'control', historyPoints },
      evidenceIds: [...evidence].sort() } : null });
}

function ratioDecimal(numerator: number, denominator: number): string {
  const scale = 10n ** 36n, scaled = BigInt(numerator) * scale / BigInt(denominator);
  const tail = (scaled % scale).toString().padStart(36, '0').replace(/0+$/, '');
  return `${scaled / scale}${tail ? `.${tail}` : ''}`;
}
