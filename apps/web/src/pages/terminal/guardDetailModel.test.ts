import { describe, expect, it } from 'vitest';
import { CoinCardV2Schema, GuardAssessmentV2Schema, GuardCoverageSchema, GUARD_CHECK_IDS, GUARD_CHECK_TIERS, type Metric } from '@eko/shared';
import { assessment, card as rawCard, coverage, missingCoverage, factor, observed } from '../../../../../packages/shared/test/fixtures/contracts/guard-v2';
import { guardDetailModel } from './guardDetailModel';

function clearRating() {
  return GuardAssessmentV2Schema.parse({ ...assessment, mode: 'active', level: 'lower', observedLevel: 'lower',
    baseScore: 0, score: 0, historyPoints: 0, scoreIsLowerBound: false, familyPoints: { E: 0, O: 0, Ff: 0, C: 0, I: 0 }, reasons: [],
    factors: [{ ...factor, state: 'not_matched', eligiblePoints: 0, assignedPoints: 0, calibration: 'released' }],
    completeness: { buyCriticalComplete: true, lowerTierComplete: true, missing: [] },
    checks: GUARD_CHECK_IDS.map(id => ({ id, tier: GUARD_CHECK_TIERS[id], status: 'complete', coverage, evidenceIds: [], failureCode: null })),
  });
}
describe('buyer rating detail model', () => {
  it('shows only explicit negative findings as fine on a fully checked clear rating', () => {
    const guard = clearRating(), model = guardDetailModel(null, guard);
    expect(model.flagged).toEqual([]);
    expect(model.fine.map(r => r.id)).toEqual(['factor.execution_cost.0']);
    expect(model.pending).toEqual([]); expect(model.excluded).toEqual([]);
    expect(model.sections.every(s => s.pending === 0 && s.flagged === 0)).toBe(true);
    expect(model.sections.reduce((n, s) => n + s.measured, 0)).toBe(8);
    expect(model.technical.assessment).toBe(guard);
  });
  it('orders decisive danger before scored flags and keeps suppressed matched flags', () => {
    const guard = GuardAssessmentV2Schema.parse({ ...assessment, decisiveIds: ['sell_block'], observedLevel: 'high', level: 'high',
      factors: [{ ...factor, assignedPoints: 0, suppressionCode: 'family_max' }], baseScore: 0, score: 0, familyPoints: { E: 0, O: 0, Ff: 0, C: 0, I: 0 } });
    const model = guardDetailModel(null, guard);
    expect(model.flagged.map(r => r.id)).toEqual(['decisive.sell_block', 'factor.execution_cost.0']);
    expect(model.flagged[1].value).toEqual(guard.factors[0]);
    expect(model.fine).toEqual([]);
    expect(model.sections.map(s => s.id)).toEqual(['sell']);
    expect(model.sections[0].flagged).toBe(2);
  });
  it('collapses a brand-new coin with no completed results into reason groups', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: { ...assessment, factors: [], reasons: [], baseScore: 0, score: 0, familyPoints: { E: 0, O: 0, Ff: 0, C: 0, I: 0 } } });
    const model = guardDetailModel(card);
    expect(model.flagged).toEqual([]); expect(model.fine).toEqual([]); expect(model.sections).toEqual([]);
    expect(model.pending.length).toBeGreaterThan(100);
    expect(model.notRun.map(g => g.reason)).toEqual(['missing', 'simulation', 'wallets']);
    expect(model.notRun.flatMap(g => g.rows)).toHaveLength(model.pending.length);
    expect(new Set(model.pending.map(r => r.id)).size).toBe(model.pending.length);
    expect(model.technical.card).toBe(card);
  });
  it('does not invent a rating or fine result when a rating is absent', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: null });
    const model = guardDetailModel(card);
    expect(model.flagged).toEqual([]); expect(model.fine).toEqual([]); expect(model.sections).toEqual([]);
    expect(model.technical.assessment).toBeNull();
    expect(guardDetailModel(null)).toMatchObject({ flagged: [], fine: [], pending: [], sections: [], technical: { card: null, assessment: null } });
  });
  it('does not turn an unknown factor or its reason into a negative or flagged finding', () => {
    const guard = clearRating();
    guard.factors[0].state = 'unknown'; guard.reasons = GuardAssessmentV2Schema.parse(assessment).reasons;
    const model = guardDetailModel(null, guard);
    expect(model.flagged).toEqual([]); expect(model.fine).toEqual([]);
    expect(model.pending).toHaveLength(1); expect(model.pending[0].text).toBe('');
  });
  it('separates every named failure from proven non-applicability', () => {
    const guard = clearRating();
    const statuses = ['missing', 'stale', 'failed', 'unsupported', 'missing', 'missing', 'missing', 'not_applicable'] as const;
    const failures = ['missing', 'stale', 'failed', 'unsupported', 'unreconciled', 'uncalibrated', 'reference_entry_unavailable', null] as const;
    guard.checks = guard.checks.map((c, i) => ({ ...c, status: statuses[i], failureCode: failures[i], coverage: GuardCoverageSchema.parse(statuses[i] === 'not_applicable' ? coverage : missingCoverage), evidenceIds: [assessment.codeHash] }));
    const model = guardDetailModel(null, guard);
    expect(model.pending).toHaveLength(7); expect(model.excluded).toHaveLength(1);
    expect(model.notRun.map(g => g.reason)).toEqual(['simulation', 'stale', 'failed', 'unsupported', 'unreconciled', 'uncalibrated', 'reference_entry_unavailable', 'not_applicable']);
    expect(model.fine).toHaveLength(1);
  });
  it('keeps numeric observations and bounded values out of fine findings', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: null });
    card.liquidity.headlineDepth2Usd = observed('depth2', '25', 'usd') as typeof card.liquidity.headlineDepth2Usd;
    card.supply.top10RawPct = { ...observed('topAddress10', '12', 'pct'), status: 'lower_bound', coverage: missingCoverage, failureCode: 'missing' } as typeof card.supply.top10RawPct;
    const model = guardDetailModel(card);
    expect(model.fine).toEqual([]);
    expect(model.sections.map(s => s.id)).toEqual(['holders', 'pool']);
    expect(model.sections.every(s => s.measured === 1)).toBe(true);
  });
  it('retains size and account context, and treats entry and sell restrictions as flags', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: null });
    card.tradeability.quotes[0].entry = observed('entry', 'entry_limited', 'status') as typeof card.tradeability.quotes[0]['entry'];
    card.tradeability.quotes[1].sellability = observed('sellability', 'executable', 'status') as typeof card.tradeability.quotes[1]['sellability'];
    const model = guardDetailModel(card);
    expect(model.flagged[0].text).toContain('$100 · EOA');
    expect(model.fine[0].text).toContain('$100 · Smart account');
    expect(model.sections[0]).toMatchObject({ flagged: 1, fine: 1 });
  });
  it('uses collection coverage rather than treating empty arrays as fine', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: null, collectionCoverage: { pools: coverage, rawTop10: missingCoverage } });
    const model = guardDetailModel(card);
    expect(model.pending.some(r => r.id === 'supply.rawTop10')).toBe(true);
    expect(model.sections.flatMap(s => s.rows).find(r => r.id === 'identity.pools')?.status).toBe('checked');
    expect(model.fine).toEqual([]);
    expect(model.pending.some(r => /evidenceIds|memberIds|outcomeIds/.test(r.id))).toBe(false);
  });
  it('keeps unknown compound children pending and the input unchanged', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, verdict: null });
    card.tradeability.quotes[0].feeBreakdown = { ...card.tradeability.quotes[0].feeBreakdown,
      ...observed('feeBreakdown', { total: observed('feeTotal', '1', 'pct'), ordinary: rawCard.tradeability.quotes[0].venueCostPct }, 'compound') } as typeof card.tradeability.quotes[0]['feeBreakdown'];
    const before = JSON.stringify(card), model = guardDetailModel(card);
    expect(model.pending.some(r => r.id.endsWith('feeBreakdown.value.ordinary'))).toBe(true);
    expect(model.fine).toEqual([]); expect(JSON.stringify(card)).toBe(before);
    expect((model.sections[0].rows[0].value as Metric<unknown>).status).toBe('observed');
  });
});
