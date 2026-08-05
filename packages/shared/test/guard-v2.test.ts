import { describe, expect, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { GuardAssessmentV2Schema, CoinCardV2Schema, createGuardMetric, RawAmountSchema, RationalSchema, DecimalSchema, UnsignedDecimalSchema, GuardReasonV2Schema, GuardFactorSchema, GuardAssessmentCheckSchema, ReceiptRefV2Schema, GuardCursorSchema, GuardCoverageSchema, CoinCardSchema, VerdictSchema, PlaybookMatchSchema, projectGuardLevelToV1, projectGuardAssessmentToV1, projectGuardReasonToV1, NegotiatedCoinCardSchema, NegotiatedGuardVerdictSchema, GUARD_REASON_CODES } from '../src/contracts/index.js';
import type { GuardReasonV2, Metric } from '../src/contracts/index.js';
import { assessment, card, coverage, missingCoverage, observed, unknown, raw, hash, cursor, check, factor, feeComponents } from './fixtures/contracts/guard-v2.js';
import v1 from './fixtures/contracts/v1.json';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const metric = createGuardMetric(RawAmountSchema);
const complete = () => ({ ...clone(assessment), checks: assessment.checks.map((c) => ({ ...c, status: 'complete', coverage: coverage as typeof missingCoverage, failureCode: null as string | null })), completeness: { buyCriticalComplete: true, lowerTierComplete: true, missing: [] } });
describe('Guard exact quantities and availability', () => {
  it('retains raw integers above Number precision and distinct signed cash', () => {
    expect(RawAmountSchema.parse(raw)).toEqual(raw);
    for (const bad of ['-1', '01', '1.0', '1e18', '', 1]) expect(RawAmountSchema.safeParse({ ...raw, raw: bad }).success).toBe(false);
    for (const bad of ['-0', '0.0', '01', '1.20', '1e2', '+1', '.1', 'NaN']) expect(DecimalSchema.safeParse(bad).success).toBe(false);
    for (const good of ['0', '1', '-1', '0.01', '-0.01', '123456789012345678901234567890.123456789']) expect(DecimalSchema.parse(good)).toBe(good);
    expect(UnsignedDecimalSchema.safeParse('-0.1').success).toBe(false);
    expect(RationalSchema.parse({ numerator: '-123456789012345678901', denominator: '7' }).denominator).toBe('7');
    for (const denominator of ['0', '-1', '1.5', '01']) expect(RationalSchema.safeParse({ numerator: '1', denominator }).success).toBe(false);
  });
  it('requires an amount for observed/bounded status, explicit null for missing, and complete coverage for zero', () => {
    const knownZero = observed('total', { ...raw, raw: '0' }, 'raw');
    expect(metric.parse(knownZero).value).toEqual({ ...raw, raw: '0' });
    expect(metric.parse(unknown('total', 'raw')).value).toBeNull();
    for (const status of ['observed', 'lower_bound', 'upper_bound']) {
      expect(metric.safeParse({ ...knownZero, status, value: null }).success).toBe(false);
      expect(metric.safeParse({ ...knownZero, status, coverage: missingCoverage }).success).toBe(false);
      const { value: _, ...absent } = knownZero;
      expect(metric.safeParse({ ...absent, status }).success).toBe(false);
    }
    expect(metric.safeParse({ ...unknown('total', 'raw'), value: raw }).success).toBe(false);
    expect(metric.safeParse({ ...unknown('total', 'raw'), failureCode: null }).success).toBe(false);
    expect(metric.safeParse({ ...unknown('total', 'raw'), status: 'not_applicable', failureCode: null }).success).toBe(true);
    expect(metric.safeParse({ ...knownZero, id: 'invented_metric' }).success).toBe(false);
  });
  it('retains rational evidence and rejects zero/missing/negative or mismatched denominators', () => {
    const pct = createGuardMetric(DecimalSchema);
    const sample = { ...observed('soldFloatPct', '50', 'pct'), numerator: { ...raw, raw: '1' }, denominator: { ...raw, raw: '2' }, denominatorKind: 'F' };
    expect(pct.parse(sample)).toEqual(sample);
    for (const denominator of [null, '0', '-1', { ...raw, raw: '0' }, { ...raw, decimals: 6 }, { ...raw, asset: `0x${'cd'.repeat(20)}` }]) expect(pct.safeParse({ ...sample, denominator }).success).toBe(false);
    expect(pct.safeParse({ ...sample, numerator: null }).success).toBe(false);
    for (const status of ['lower_bound', 'upper_bound']) expect(pct.parse({ ...sample, status, coverage: missingCoverage }).status).toBe(status);
    expect(pct.safeParse({ ...sample, errorBounds: { lower: { numerator: '2', denominator: '1' }, upper: { numerator: '1', denominator: '1' } } }).success).toBe(false);
    expect(pct.parse({ ...unknown('soldFloatPct', 'pct'), denominator: '0', denominatorKind: 'F' }).value).toBeNull();
  });
  it('rejects malformed boundaries, intervals and contradictory completed coverage', () => {
    expect(GuardCursorSchema.safeParse({ ...cursor, boundary: 'before_tx' }).success).toBe(false);
    expect(GuardCursorSchema.parse({ ...cursor, boundary: 'after_tx', transactionIndex: 0, executionOrdinal: 1 }).boundary).toBe('after_tx');
    expect(GuardCursorSchema.safeParse({ ...cursor, transactionIndex: 0 }).success).toBe(false);
    expect(GuardCoverageSchema.safeParse({ ...coverage, gaps: ['missing'] }).success).toBe(false);
    expect(GuardCoverageSchema.safeParse({ ...coverage, through: { ...cursor, blockNumber: '122' } }).success).toBe(false);
    expect(metric.safeParse({ ...observed('total', raw, 'raw'), knownAt: { cursor: { ...cursor, blockNumber: '122' }, acquisitionSequence: '0' } }).success).toBe(false);
  });
});

describe('Guard schema/level compatibility, no policy cutover', () => {
  it('preserves full V1 cards, verdicts and info matches, including their original receipt', () => {
    expect(CoinCardSchema.parse(v1.CoinCard)).toEqual(v1.CoinCard);
    expect(VerdictSchema.parse(v1.Verdict)).toEqual(v1.Verdict);
    expect(PlaybookMatchSchema.parse({ ...v1.PlaybookMatch, level: 'info' }).level).toBe('info');
    expect(VerdictSchema.safeParse({ ...v1.Verdict, level: 'info' }).success).toBe(false);
    for (const key of ['coin', 'level', 'reasons', 'playbooks', 'receipt', 'schemaVersion', 'asOfBlock']) {
      const missing: Record<string, unknown> = { ...v1.Verdict }; delete missing[key];
      expect(VerdictSchema.safeParse(missing).success).toBe(false);
    }
  });
  it('projects all four new levels without fabricating legacy playbooks', () => {
    for (const [level, legacy] of [['lower', 'clear'], ['elevated', 'monitor'], ['high', 'danger'], ['incomplete', 'pending']] as const) {
      expect(projectGuardLevelToV1(level)).toBe(legacy);
      const input = level === 'incomplete' ? clone(assessment) : complete();
      const score = level === 'high' ? 60 : level === 'elevated' ? 30 : 10;
      Object.assign(input, { level, observedLevel: level === 'incomplete' ? 'lower' : level, score, baseScore: score, familyPoints: { E: score, O: 0, Ff: 0, C: 0, I: 0 }, factors: [] });
      const projected = projectGuardAssessmentToV1(GuardAssessmentV2Schema.parse(input), { playbooks: [], receipt: VerdictSchema.parse(v1.Verdict).receipt, asOfBlock: 123, evaluatedPlaybooks: [], beta: { apeScore: 1 } });
      expect(projected.level).toBe(legacy); expect(projected.playbooks).toEqual([]);
      expect(projected.schemaVersion).toBe('verdict-1+guard-2');
      expect(projected.receipt).toEqual(v1.Verdict.receipt);
      expect(projected.beta).toEqual({ apeScore: 1 });
      expect(projected.reasons[0]).toContain('5% venue round-trip cost');
      expect(projected.reasons[0]).toContain('gas unavailable');
      expect(VerdictSchema.parse(projected)).toEqual(projected);
    }
  });
  it('enforces High priority and the two distinct missing-tier overlays', () => {
    expect(GuardAssessmentV2Schema.parse(assessment).level).toBe('incomplete');
    const lowerGap = complete();
    lowerGap.checks = lowerGap.checks.map((c) => c.id === 'recent_funding' ? { ...c, status: 'missing', coverage: missingCoverage, failureCode: 'missing' } : c);
    Object.assign(lowerGap, { level: 'elevated', levelFloorReason: 'lower_tier_gap', completeness: { buyCriticalComplete: true, lowerTierComplete: false, missing: ['recent_funding'] } });
    expect(GuardAssessmentV2Schema.parse(lowerGap).observedLevel).toBe('lower');
    expect(GuardAssessmentV2Schema.safeParse({ ...lowerGap, level: 'lower' }).success).toBe(false);
    expect(GuardAssessmentV2Schema.parse({ ...assessment, level: 'high', observedLevel: 'high', decisiveIds: ['sell_block'] }).level).toBe('high');
    expect(GuardAssessmentV2Schema.safeParse({ ...assessment, level: 'lower' }).success).toBe(false);
    expect(GuardAssessmentV2Schema.safeParse({ ...assessment, checks: assessment.checks.slice(1) }).success).toBe(false);
    expect(GuardAssessmentCheckSchema.safeParse({ ...check, tier: 'lower_tier' }).success).toBe(false);
    expect(GuardAssessmentCheckSchema.safeParse({ ...check, status: 'not_applicable', coverage, failureCode: null }).success).toBe(false);
    expect(GuardAssessmentCheckSchema.parse({ ...check, status: 'not_applicable', coverage, failureCode: null, evidenceIds: [hash] }).status).toBe('not_applicable');
    expect(GuardAssessmentV2Schema.safeParse({ ...complete(), mode: 'active' }).success).toBe(false);
  });
  it('allows partial V2 unknown issuer and negotiates version explicitly', () => {
    expect(CoinCardV2Schema.parse(card).identity.principal.value).toBeNull();
    expect(CoinCardV2Schema.parse(card).identity.factoryDeployer.value).toBeNull();
    expect(CoinCardSchema.safeParse({ ...v1.CoinCard, identity: { ...v1.CoinCard.identity, deployer: null } }).success).toBe(false);
    expect(NegotiatedCoinCardSchema.parse({ version: 2, card }).version).toBe(2);
    expect(NegotiatedCoinCardSchema.parse({ version: 2, card: null }).card).toBeNull();
    expect(NegotiatedCoinCardSchema.safeParse({ version: 1, card }).success).toBe(false);
    expect(NegotiatedGuardVerdictSchema.parse({ version: 1, verdict: v1.Verdict }).version).toBe(1);
    expect(NegotiatedGuardVerdictSchema.safeParse({ version: 2, verdict: v1.Verdict }).success).toBe(false);
    expect(CoinCardV2Schema.safeParse({ ...card, tradeability: { ...card.tradeability, quotes: card.tradeability.quotes.slice(1) } }).success).toBe(false);
  });
  it('rejects undeclared trusted nested fields and invented reasons/factors/receipts', () => {
    expect(CoinCardV2Schema.safeParse({ ...card, control: { ...card.control, arbitrary: true } }).success).toBe(false);
    expect(CoinCardV2Schema.safeParse({ ...card, identity: { ...card.identity, name: { ...card.identity.name, html: 'text' } } }).success).toBe(false);
    expect(GuardFactorSchema.safeParse({ ...factor, id: 'serial_deployer' }).success).toBe(false);
    expect(GuardFactorSchema.safeParse({ ...factor, family: 'I' }).success).toBe(false);
    expect(GuardReasonV2Schema.safeParse({ code: 'TEXT_INSTRUCTION', factorId: 'agent_instruction', parameters: { actionEnum: 'send', prose: 'extra' }, evidenceIds: [] }).success).toBe(false);
    expect(GuardReasonV2Schema.safeParse({ code: 'TEXT_INSTRUCTION', factorId: null, parameters: { actionEnum: 'execute_shell' }, evidenceIds: [] }).success).toBe(false);
    expect(ReceiptRefV2Schema.safeParse({ ...assessment.receipt, root: hash }).success).toBe(false);
    expect(ReceiptRefV2Schema.safeParse({ ...assessment.receipt, status: 'anchored' }).success).toBe(false);
    expect(ReceiptRefV2Schema.parse({ ...assessment.receipt, status: 'anchored', root: hash, batchId: 1, proof: [], txHash: hash }).status).toBe('anchored');
    expect(createGuardMetric(z.strictObject({ total: z.number() })).safeParse(observed('feeBreakdown', { total: 5, arbitrary: 1 }, 'compound')).success).toBe(false);
    expect(createGuardMetric(z.unknown()).safeParse(observed('feeBreakdown', feeComponents, 'compound')).success).toBe(true);
  });
  it('exports discriminated reason and metric types', () => {
    expectTypeOf<Extract<GuardReasonV2, { code: 'TEXT_INSTRUCTION' }>['parameters']>().toEqualTypeOf<{ actionEnum: 'buy' | 'approve' | 'transfer' | 'send' | 'bypass_checks' | 'change_policy' }>();
    expectTypeOf<Extract<Metric<string>, { status: 'unknown' }>['value']>().toEqualTypeOf<null>();
    expect(GUARD_REASON_CODES.length).toBe(19);
    expect(projectGuardReasonToV1(GuardReasonV2Schema.parse({ code: 'INCOMPLETE', factorId: null, parameters: { checkNames: ['recent_funding'], coverageCode: 'missing', retryCode: 'coverage_available' }, evidenceIds: [] }))).toContain('Not fully checked: recent_funding');
  });
});
