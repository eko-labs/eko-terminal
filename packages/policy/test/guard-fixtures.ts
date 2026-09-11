// Synthetic policy fixtures only; no measured coverage or calibration promotion.
import { GuardAssessmentV2Schema, GUARD_CHECK_IDS, GUARD_CHECK_TIERS } from '@eko/shared';
import type { CheckId, GuardAssessmentV2, ObservedLevel, Verdict } from '@eko/shared';
import { assessment, coverage, missingCoverage, factor } from '../../shared/test/fixtures/contracts/guard-v2.js';
import { ASSET, verdict, NOW } from './fixtures.js';

export function guardFixture(observed: ObservedLevel = 'lower', gaps: CheckId[] = [],
  status: Exclude<GuardAssessmentV2['checks'][number]['status'], 'complete' | 'not_applicable'> = 'missing',
  decisive = false): GuardAssessmentV2 {
  const critical = !gaps.some(id => GUARD_CHECK_TIERS[id] === 'buy_critical');
  const lower = !gaps.some(id => GUARD_CHECK_TIERS[id] === 'lower_tier');
  const score = decisive ? 0 : observed === 'high' ? 60 : observed === 'elevated' ? 30 : 0;
  const cursor = { ...assessment.cursor, timestampSec: String(NOW / 1000) };
  return GuardAssessmentV2Schema.parse({ ...assessment, cursor, availabilityCut: { ...assessment.availabilityCut, cursor }, coin: ASSET, mode: 'active',
    observedLevel: observed, level: observed === 'high' ? 'high' : !critical ? 'incomplete' : !lower ? 'elevated' : observed,
    levelFloorReason: critical && !lower && observed === 'lower' ? 'lower_tier_gap' : null,
    completeness: { buyCriticalComplete: critical, lowerTierComplete: lower, missing: gaps },
    checks: GUARD_CHECK_IDS.map(id => ({ id, tier: GUARD_CHECK_TIERS[id],
      status: gaps.includes(id) ? status : 'complete', coverage: gaps.includes(id) ? missingCoverage : coverage,
      evidenceIds: [], failureCode: gaps.includes(id) ? status : null })),
    factors: score ? [{ ...factor, eligiblePoints: score, assignedPoints: score, calibration: 'released' }] : [],
    baseScore: score, score, historyPoints: 0, familyPoints: { E: score, O: 0, Ff: 0, C: 0, I: 0 },
    decisiveIds: decisive ? ['sell_block'] : [], reasons: [], scoreIsLowerBound: gaps.length > 0,
  });
}

export function cachedGuard(guard = guardFixture()): Verdict {
  // Legacy fields remain genuine; the V2 adapter must not infer its level from legacy prose or aliases.
  return { ...verdict, guardV2: guard };
}
