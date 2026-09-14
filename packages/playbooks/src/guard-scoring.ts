import { keccak256, stringToHex } from 'viem';
import { canonicalize } from '@eko/policy';
import { guardDecisionBody, GuardScoreInputSchema, GuardScoreResultSchema, GuardReasonV2Schema, GUARD_CHECK_IDS, GUARD_CHECK_TIERS, GUARD_FACTOR_IDS,
  compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { GuardScoreInput, GuardScoreObservation, GuardScoreResult, GuardAssessmentCheck, GuardReasonV2, FactorId,
  CheckId } from '@eko/shared';
import { GUARD_PARAMETERS_HASH } from './guard-registry.js';
import { CONFIG_GUARD_V2 } from '../config/guard-v2.js';
import { evaluateGuardFactor, compareGuardDecimals } from './guard-factors.js';
import { allocateGuardFactors, familyMaxima, GUARD_FAMILY_ORDER } from './guard-allocation.js';
import type { GuardCompatibility } from './guard-allocation.js';
import { evaluateHistoryBoosterV2 } from './history-v2.js';

/**
 * Hash canonical Guard score input with keccak256/string encoding. Pure trusted-input operation
 * without auth; canonicalization failures throw and no release gate is implied.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export const guardScoreHash = (value: unknown): `0x${string}` => keccak256(stringToHex(canonicalize(value)));
interface ReleaseEntry<Id> { readonly id: Id; readonly status: string; readonly acceptanceArtifact: string | null }
export interface GuardScoringRegistry {
  readonly mode: string; readonly lowerEnabled: boolean; readonly boosterEnabled: boolean;
  readonly rulesVersion: string; readonly identityVersion: string; readonly measurementVersion: string; readonly outcomeVersion: string;
  readonly factors: readonly ReleaseEntry<FactorId>[]; readonly checks: readonly ReleaseEntry<CheckId>[];
  readonly decisive: readonly ReleaseEntry<string>[]; readonly compatibility: GuardCompatibility;
}
const released = (entry: ReleaseEntry<unknown> | undefined) => entry?.status === 'released' && !!entry.acceptanceArtifact;
const pct = new Set<FactorId>(['execution_cost', 'operator_hold', 'coordinated_hold', 'coordinated_union', 'top10_float',
  'launch_linked_hold', 'principal_origin_hold', 'early_origin_hold', 'persistent_sniper_hold', 'authenticated_dominance',
  'horizon_release', 'current_sell_pressure', 'campaign_pressure', 'mutable_control', 'removable_depth', 'exercised_control', 'cycling']);
const reasonCodes: Record<FactorId, GuardReasonV2['code']> = {
  execution_cost: 'EXIT_COST', thin_depth: 'DEPTH', operator_hold: 'GROUP_HELD', coordinated_hold: 'GROUP_HELD', coordinated_union: 'GROUP_HELD',
  top10_float: 'TOP_HOLDERS', launch_linked_hold: 'GROUP_HELD', principal_origin_hold: 'GROUP_HELD', early_origin_hold: 'EARLY_BUYERS',
  persistent_sniper_hold: 'GROUP_HELD', authenticated_dominance: 'GROUP_HELD', horizon_release: 'GROUP_HELD',
  current_sell_pressure: 'SELL_PRESSURE', campaign_pressure: 'SELL_PRESSURE', harmful_selling: 'SELL_PRESSURE', operator_dump: 'ATTRIBUTED_DUMP',
  mutable_control: 'CONTROL', arbitrary_control: 'CONTROL', removable_depth: 'CONTROL', exercised_control: 'CONTROL', cycling: 'CYCLING', agent_instruction: 'TEXT_INSTRUCTION',
};
/** §§5–6: pure facts -> maximum justified assignment -> history -> independent tier overlay.
 * @remarks
 * Evaluate schema-bounded Guard checks/factors/coverage and calibration inputs into a
 * deterministic assessment. Trusted caller supplies captured evidence and release state; no
 * account auth or I/O. Validation failures throw or produce explicit incomplete assessments as
 * specified by the implementation; a candidate score alone is not active release evidence.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function evaluateGuardV2(raw: GuardScoreInput, registry: GuardScoringRegistry = CONFIG_GUARD_V2): GuardScoreResult {
  const input = GuardScoreInputSchema.parse(raw), { cursor, availabilityCut } = input;
  if (cursor.boundary !== 'block_end' || compareGuardCursors(cursor, availabilityCut.cursor) > 0) throw new Error('Guard score needs captured block-end state');
  if (input.mode === 'active' && (registry.mode !== 'active' || GUARD_CHECK_IDS.some(id => !released(registry.checks.find(c => c.id === id)))))
    throw new Error('Unreleased candidate checks cannot form an active registry');
  const available = (m: { cursor: typeof cursor; knownAt: typeof availabilityCut }) => compareGuardCursors(m.cursor, cursor) <= 0 &&
    compareGuardCursors(m.cursor, m.knownAt.cursor) <= 0 && guardKnownBy(m.knownAt, availabilityCut);
  const missing = (id: CheckId): GuardAssessmentCheck => ({ id, tier: GUARD_CHECK_TIERS[id], status: 'missing', evidenceIds: [], failureCode: 'missing',
    coverage: { scopeId: `guard-${id}`, from: null, through: cursor, complete: false, gaps: ['missing'], methodVersion: registry.measurementVersion,
      coveredUnits: null, excludedUnits: null, topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [] } });
  const unique = (ids: string[], label: string) => { if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`); };
  unique(input.observations.map(o => o.id), 'Guard observation'); unique(input.checks.map(c => c.id), 'Guard check'); unique(input.decisive.map(d => d.id), 'decisive fact');
  const observations = input.observations.filter(o => [o.primary, o.secondary, o.qualification].filter(m => m !== null).every(available)).sort((a,b)=>a.id.localeCompare(b.id));
  for (const o of observations) validateObservation(o, input);
  const factors = GUARD_FACTOR_IDS.map(id => {
    const f = evaluateGuardFactor(id, observations.find(o => o.id === id)), entry = registry.factors.find(f => f.id === id);
    if (input.mode === 'active' && !released(entry)) return { ...f, assignedPoints: 0, suppressionCode: 'unreleased' as const };
    return { ...f, calibration: released(entry) ? 'released' as const : 'shadow' as const };
  });
  const proofs = new Map(observations.filter(o => o.mechanism !== null).map(o => [o.id, o.mechanism!]));
  const assigned = allocateGuardFactors(factors, proofs, registry.compatibility), familyPoints = familyMaxima(assigned);
  const baseScore = Math.min(100, Object.values(familyPoints).reduce((a, b) => a + b, 0));
  const historyResult = evaluateHistoryBoosterV2({ coin: input.coin, cursor, availabilityCut, baseScore, factors: assigned,
    mode: input.mode === 'active' ? 'active' : 'shadow', booster: input.shadowBooster && input.mode !== 'active' ? 'shadow' : 'disabled', source: input.historySource });
  const checks = GUARD_CHECK_IDS.map(id => {
    // History completion is never a caller's manually asserted zero/good history flag.
    if (id === 'operator_history') return historyResult.check;
    const check = input.checks.find(c => c.id === id);
    if (!check?.coverage.through || compareGuardCursors(check.coverage.through, cursor) !== 0) return missing(id);
    return check;
  });
  for (const d of input.decisive) {
    const expected = d.id === 'severe_cost' ? 'EXIT_COST' : d.id === 'liquidity_withdrawn' ? 'CONTROL' : 'SELL_RESTRICTION';
    if (d.reason.code !== expected) throw new Error('Decisive reason template mismatch');
  }
  for (const i of input.informational) if (!['CLONE','EXEMPTIONS','ENTRY_LIMIT','SAME_BLOCK','ORIGIN_SALE'].includes(i.reason.code))
    throw new Error('Unsupported informational reason');
  const gaps = checks.filter(c => !['complete', 'not_applicable'].includes(c.status));
  const buyCriticalComplete = !gaps.some(c => c.tier === 'buy_critical'), lowerTierComplete = !gaps.some(c => c.tier === 'lower_tier');
  const decisive = input.decisive.filter(d => available(d.proof) && compareGuardCursors(d.proof.cursor, cursor) === 0 &&
    d.proof.status === 'observed' && d.proof.value && d.proof.coverage.complete &&
    (input.mode !== 'active' || released(registry.decisive.find(e => e.id === d.id)))).sort((a,b)=>a.id.localeCompare(b.id));
  const severe = assigned.find(f => f.id === 'execution_cost' && f.eligiblePoints >= 60 && f.suppressionCode !== 'unreleased');
  const decisiveIds = [...new Set([...decisive.map(d => d.id), ...(severe && (input.mode !== 'active' || released(registry.decisive.find(d => d.id === 'severe_cost'))) ? ['severe_cost' as const] : [])])];
  const score = historyResult.score, observedLevel = decisiveIds.length || score >= 60 ? 'high' : score >= 30 ? 'elevated' : 'lower';
  const level = observedLevel === 'high' ? 'high' : !buyCriticalComplete ? 'incomplete' : !lowerTierComplete ? 'elevated' : observedLevel;
  if (input.mode === 'active' && level === 'lower' && !registry.lowerEnabled) throw new Error('Active Lower is not released');
  const weighted = assigned.filter(f => f.state === 'matched' || f.state === 'not_matched' &&
    !['operator_dump','harmful_selling','horizon_release'].includes(f.id) &&
    (['top10_float','early_origin_hold','current_sell_pressure','campaign_pressure'].includes(f.id) ||
      observations.some(o=>o.id===f.id && o.qualification?.status==='observed' && o.qualification.coverage.complete && o.qualification.value)))
    .sort((a, b) => Number(b.id === 'execution_cost' && decisiveIds.includes('severe_cost')) - Number(a.id === 'execution_cost' && decisiveIds.includes('severe_cost')) ||
      b.assignedPoints - a.assignedPoints || GUARD_FAMILY_ORDER.indexOf(a.family) - GUARD_FAMILY_ORDER.indexOf(b.family) || a.id.localeCompare(b.id));
  const scoredReasons = weighted.map(f => ({ reason: GuardReasonV2Schema.parse({code:f.template,factorId:f.id,parameters:f.parameters,evidenceIds:f.evidenceIds}),
    points:f.assignedPoints, family:GUARD_FAMILY_ORDER.indexOf(f.family), id:f.id as string,
    decisive:f.id==='execution_cost' && decisiveIds.includes('severe_cost') }));
  if(historyResult.reason?.code==='HISTORY') scoredReasons.push({reason:historyResult.reason,points:historyResult.historyPoints,
    family:GUARD_FAMILY_ORDER.indexOf(historyResult.reason.parameters.exposureType==='execution'?'E':historyResult.reason.parameters.exposureType==='ownership'?'O':'C'),id:'history',decisive:false});
  scoredReasons.sort((a,b)=>Number(b.decisive)-Number(a.decisive)||b.points-a.points||a.family-b.family||a.id.localeCompare(b.id));
  const reasons: GuardReasonV2[] = [...decisive.map(d=>d.reason),...scoredReasons.map(r=>r.reason),
    ...input.informational.filter(available).sort((a,b)=>guardScoreHash(a).localeCompare(guardScoreHash(b))).map(i=>i.reason),
    ...gaps.map(c => GuardReasonV2Schema.parse({ code: 'INCOMPLETE', factorId: null,
      parameters: { checkNames: [c.id], coverageCode: c.failureCode, retryCode: c.failureCode === 'uncalibrated' ? 'calibration_accepted' : 'coverage_available' }, evidenceIds: c.evidenceIds }))];
  const evidenceIds = [...new Set([...checks.flatMap(c => c.evidenceIds), ...assigned.flatMap(f => f.evidenceIds), ...reasons.flatMap(r => r.evidenceIds)])].sort();
  const deterministicInput = { ...input, observations, checks, decisive, informational: input.informational.filter(available).sort((a,b)=>guardScoreHash(a).localeCompare(guardScoreHash(b))),
    versions: { rules: registry.rulesVersion, identity: registry.identityVersion, measurement: registry.measurementVersion, outcome: registry.outcomeVersion },
    parametersHash: registry===CONFIG_GUARD_V2 ? GUARD_PARAMETERS_HASH : guardScoreHash({ configuration: CONFIG_GUARD_V2, registry }), compatibility: registry.compatibility };
  const snapshotHash = guardScoreHash(deterministicInput);
  const compatibilityHash = guardScoreHash(registry.compatibility);
  const core = { schemaVersion: 'guard-2', coin: input.coin, chainId: cursor.chainId, cursor, availabilityCut, mode: input.mode,
    rulesVersion: registry.rulesVersion, identityVersion: registry.identityVersion, measurementVersion: registry.measurementVersion, outcomeVersion: registry.outcomeVersion,
    codeHash: input.codeHash, parametersHash: registry===CONFIG_GUARD_V2 ? GUARD_PARAMETERS_HASH : guardScoreHash({ configuration: CONFIG_GUARD_V2, registry }), serviceRegistryHash: input.serviceRegistryHash,
    profileHash: input.profileHash, calibrationManifestHash: input.calibrationManifestHash, referenceSizesUsd: [100, 1000], benchmarkHorizonSec: 3600,
    level, observedLevel, levelFloorReason: buyCriticalComplete && !lowerTierComplete && observedLevel === 'lower' ? 'lower_tier_gap' : null,
    completeness: { buyCriticalComplete, lowerTierComplete, missing: gaps.map(c => c.id) }, checks, factors: assigned, baseScore,
    historyPoints: historyResult.historyPoints, score, scoreIsLowerBound: gaps.length > 0 || assigned.some(f => f.state === 'unknown') || observations.some(o => [o.primary,o.secondary].some(m => m?.status.endsWith('_bound') || m?.errorBounds !== undefined)),
    familyPoints, decisiveIds, reasons, history: historyResult.history, snapshotHash, supersedes: null };
  const decisionHash = guardScoreHash(guardDecisionBody({ ...core, decisionHash: snapshotHash, evidenceRoot: snapshotHash } as Parameters<typeof guardDecisionBody>[0]));
  // This source-reference digest is not a registry Merkle root. The storage layer
  // replaces the internal calculation reference with an immutable recorded envelope.
  const evidenceRoot = guardScoreHash({ method: 'shadow-evidence-ids-2.0.0', evidenceIds });
  const payloadHash = guardScoreHash({ ...core, decisionHash, evidenceRoot });
  return GuardScoreResultSchema.parse({ assessment: { ...core, decisionHash, evidenceRoot,
    receipt: { status: 'recorded', id: `calculation:${payloadHash}`, payloadHash } },
    deterministicInput, allocation: { compatibility: registry.compatibility, compatibilityHash, selectedIds: assigned.filter(f => f.assignedPoints > 0).map(f => f.id) } });
}

function validateObservation(o: GuardScoreObservation, input: GuardScoreInput) {
  for (const m of [o.primary, o.secondary, o.qualification]) {
    if (!m) continue;
    if (compareGuardCursors(m.cursor, input.cursor) !== 0 || m.throughSec !== input.cursor.timestampSec) throw new Error('Stale Guard scoring metric');
    if (m.coverage.through && compareGuardCursors(m.coverage.through, input.cursor) !== 0) throw new Error('Guard metric coverage boundary mismatch');
  }
  if (o.reason.code !== reasonCodes[o.id]) throw new Error('Guard reason template disagrees with factor');
  if(o.id==='execution_cost' && o.reason.code==='EXIT_COST' && ![100,1000].includes(o.reason.parameters.sizeUsd)) throw new Error('Guard factor requires executable reference size');
  if (o.reason.factorId !== o.id) throw new Error('Guard reason factor disagrees with observation');
  const p = o.reason.parameters;
  if(o.reason.code==='GROUP_HELD') {
    const p=o.reason.parameters, qualified=o.qualification?.status==='observed' && o.qualification.coverage.complete && o.qualification.value===true;
    if(!qualified && (['principal','operator'].includes(p.groupType) || p.linkClass==='control'))
      throw new Error('Unqualified candidate cannot claim operator control');
    if(qualified && ['operator_hold','authenticated_dominance','horizon_release'].includes(o.id) &&
      (!['principal','operator'].includes(p.groupType) || p.linkClass!=='control'))throw new Error('Operator reason requires authenticated control');
    if(qualified && ['coordinated_hold','coordinated_union'].includes(o.id) &&
      (p.groupType!=='coordination' || p.linkClass!=='coordination'))throw new Error('Coordination reason cannot imply operator control');
    if(o.id==='principal_origin_hold' && (p.groupType!=='origin' || p.linkClass!=='origin'))throw new Error('Origin reason cannot imply control');
  }

  if (o.primary?.value !== null && o.primary?.value !== undefined) {
    const v = o.primary.value;
    if(o.id!=='execution_cost' && compareGuardDecimals(v,'0')<0) throw new Error('Negative Guard factor input');
    if('rawPct' in p && v !== (p.groupPct!==null && compareGuardDecimals(p.groupPct,p.rawPct)>0?p.groupPct:p.rawPct)) throw new Error('Guard top10 needs maximum raw/control share');
    if('sellDepthUsd' in p) {
      const depths=[p.sellDepthUsd,p.buyDepthUsd].filter((d):d is string=>d!==null).sort(compareGuardDecimals);
      if(v!==depths[0])throw new Error('Guard depth needs minimum directional depth');
    }
    if (('costPct' in p && p.costPct !== v) || ('floatPct' in p && p.floatPct !== v) ||
      ('heldPct' in p && p.heldPct !== v) || ('rawPct' in p && p.rawPct !== v && p.groupPct !== v) ||
      ('sellDepthUsd' in p && p.sellDepthUsd !== v && p.buyDepthUsd !== v) || ('soldPct' in p && ['current_sell_pressure', 'campaign_pressure'].includes(o.id) && p.soldPct !== v) ||
      ('sharePct' in p && p.sharePct !== v)) throw new Error('Guard reason value disagrees with metric');
  }
  if (o.secondary?.value && (('pressurePct' in p && p.pressurePct !== o.secondary.value) ||
    ('volumeUsd' in p && p.volumeUsd !== o.secondary.value))) throw new Error('Guard secondary reason value disagrees with metric');
  if (o.secondary && o.secondary.status !== 'unknown' && o.secondary.status !== 'not_applicable') {
    const expected = ['current_sell_pressure', 'campaign_pressure', 'harmful_selling'].includes(o.id) ? 'pct' : o.id === 'cycling' ? 'usd' : 'seconds';
    if (o.secondary.value!==null && compareGuardDecimals(o.secondary.value,'0')<0)throw new Error('Negative Guard secondary input');
    if (o.secondary.unit !== expected) throw new Error('Guard secondary unit mismatch');
  }
  if (o.primary && o.primary.status !== 'unknown' && o.primary.status !== 'not_applicable') {
    const expected = pct.has(o.id) ? 'pct' : o.id === 'thin_depth' ? 'usd' : 'seconds';
    if (o.id !== 'agent_instruction' && o.primary.unit !== expected) throw new Error('Guard factor unit mismatch');
    if (CONFIG_GUARD_V2.factors.find(f => f.id === o.id)!.family === 'O' && o.primary.denominatorKind !== (o.id === 'horizon_release' ? 'other' : 'F'))
      throw new Error('Ownership requires current liquid float denominator');
  }
  if ((o.id === 'current_sell_pressure' || o.id === 'campaign_pressure' || o.id === 'cycling') && o.windowSec !== null) {
    for (const m of [o.primary, o.secondary]) if (m && m.fromSec !== (BigInt(input.cursor.timestampSec) - BigInt(o.windowSec)).toString())
      throw new Error('Guard campaign needs exact full window');
  }
  if(o.primary?.value!==null && o.primary?.value!==undefined && o.id==='mutable_control' &&
    o.primary.denominatorKind !== (o.controlKind==='mint'?'S':'other')) throw new Error('Guard bounded control denominator mismatch');
  if(o.primary?.value!==null && o.primary?.value!==undefined && ['current_sell_pressure','campaign_pressure'].includes(o.id) && o.primary.denominatorKind!=='F')
    throw new Error('Guard sold share requires opening F');
  if (o.id === 'operator_dump' && o.reason.code === 'ATTRIBUTED_DUMP' && o.reason.parameters.interventionType !== 'sell_only')
    throw new Error('Operator dump requires sell-only intervention');
  if (o.id === 'arbitrary_control' && o.reason.code === 'CONTROL' && !['mint', 'blacklist', 'sell_pause', 'transfer_upgrade'].includes(o.reason.parameters.capability))
    throw new Error('Unsupported arbitrary control capability');
}
