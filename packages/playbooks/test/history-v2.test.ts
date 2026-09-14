import { describe, expect, it } from 'vitest';
import { GuardHistoryInputSchema, GuardHistoryResultSchema } from '@eko/shared';
import { evaluateHistoryBoosterV2, CONFIG_GUARD_V2, RULES_VERSION } from '../src/index.js';
import { NOW, actor, addLaunch, address, at, clone, coverage, factor, fixture, hash, known, principal, proof, service } from './history-fixtures.js';

describe('032 complete integer history denominator and release separation', () => {
  it.each([[6, 3, 10, '0.5'], [5, 4, 15, '0.8'], [4, 3, 10, '0.75'], [2, 2, 0, '1'], [7, 3, 0, '0.428571428571428571428571428571428571']] as const)(
    '%s mature / %s bad → %s points', (count, bad, points, rate) => {
      const result = evaluateHistoryBoosterV2(fixture(count, bad));
      expect(result).toMatchObject({ candidatePoints: points, historyPoints: points, score: 30 + points, gaps: [],
        check: { id: 'operator_history', tier: 'lower_tier', status: 'complete' }, history: { eligibleMature: count, assessedMature: count, badMature: bad,
          badRate: { value: rate, numerator: String(bad), denominator: String(count), unit: 'ratio' } } });
      expect(GuardHistoryResultSchema.safeParse(result).success).toBe(true);
      if (points) expect(result.reason).toMatchObject({ code: 'HISTORY', parameters: { badCount: bad, matureCount: count, historyPoints: points } });
    });
  it('complete young and positively empty history have no eligible denominator, but complete coverage', () => {
    for (const young of [false, true]) {
      const input = fixture(0); if (young) addLaunch(input.source, 0, NOW - 3599, 'survived');
      const result = evaluateHistoryBoosterV2(input);
      expect(result.history).toMatchObject({ eligibleMature: 0, assessedMature: 0, badMature: 0, badRate: { status: 'unknown', value: null } });
      expect(result.historyPoints).toBe(0); expect(result.check.status).toBe('complete'); expect(result.gaps).toEqual([]);
    }
  });
  it('default real input has zero booster and an explicit lower-tier history gap', () => {
    const { source: _, booster: __, ...current } = fixture(); const result = evaluateHistoryBoosterV2(current);
    expect(result).toMatchObject({ historyPoints: 0, candidatePoints: 0, score: 30, check: { status: 'missing' },
      history: { booster: 'disabled', badRate: { status: 'unknown' }, enumeration: { complete: false }, assessment: { complete: false } } });
    expect(result.gaps).toContain('enumeration_missing'); expect(result.reason).toBeNull();
  });
  it('disabled booster can coexist with complete coverage; shadow points cannot enter active scores', () => {
    const input = fixture(5, 4); input.booster = 'disabled';
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ candidatePoints: 15, historyPoints: 0, score: 30, check: { status: 'complete' }, history: { booster: 'disabled' } });
    input.mode = 'active'; input.booster = 'shadow'; input.factors.forEach(f => f.calibration = 'released');
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ candidatePoints: 15, historyPoints: 0, score: 30, history: { booster: 'disabled' } });
    expect(CONFIG_GUARD_V2.boosterEnabled).toBe(false); expect(RULES_VERSION).toBe('1.0.2');
  });
  it('one missing mature assessment or incomplete enumeration disables the whole denominator', () => {
    const input = fixture(); input.source.assessments.pop();
    const result = evaluateHistoryBoosterV2(input);
    expect(result.history).toMatchObject({ eligibleMature: 6, assessedMature: 5, badMature: 3, badRate: { value: null } });
    expect(result.historyPoints).toBe(0); expect(result.gaps).toContain('assessment_missing');
    const incomplete = fixture(); incomplete.source.enumeration.coverage.complete = false; incomplete.source.enumeration.coverage.gaps = ['missing'];
    expect(evaluateHistoryBoosterV2(incomplete)).toMatchObject({ historyPoints: 0, check: { status: 'missing' } });
    const short = fixture(); short.source.enumeration.coverage.from = at(NOW - 2591999);
    expect(evaluateHistoryBoosterV2(short).gaps).toContain('enumeration_missing');
  });
  it('current launch and exact 30-day lower endpoint are excluded; inside endpoint counts', () => {
    const input = fixture(0);
    addLaunch(input.source, 0, NOW - 2592000, 'dump'); addLaunch(input.source, 1, NOW - 2591999, 'dump');
    addLaunch(input.source, 2, NOW - 10000, 'dump'); input.source.launches[2].coin = input.coin;
    const result = evaluateHistoryBoosterV2(input);
    expect(result.history).toMatchObject({ eligibleMature: 1, assessedMature: 1, badMature: 1 });
  });
  it('uses one-hour eligibility, first completed horizon boundary, canonical recheck and 30-second confirmation', () => {
    const young = fixture(0); addLaunch(young.source, 0, NOW - 3600, 'dump');
    expect(evaluateHistoryBoosterV2(young)).toMatchObject({ history: { eligibleMature: 1, assessedMature: 0 }, historyPoints: 0 });
    for (const mutation of ['firstBoundary', 'canonical', 'confirmation', 'version', 'calibration', 'censored', 'horizon'] as const) {
      const input = fixture(), a = input.source.assessments[0], o = input.source.outcomes[0];
      if (mutation === 'firstBoundary') a.firstBoundaryAfterHorizon = false;
      if (mutation === 'canonical') a.canonicalRechecked = false;
      if (mutation === 'confirmation') a.confirmationThrough = a.maturityCursor;
      if (mutation === 'version') a.identityVersion = '1.0.0';
      if (mutation === 'calibration') o.calibrated = false;
      if (mutation === 'censored') o.outcome.status = 'censored';
      if (mutation === 'horizon') o.outcome.horizonSec = 86400;
      expect(evaluateHistoryBoosterV2(input), mutation).toMatchObject({ historyPoints: 0, check: { status: 'missing' } });
    }
  });
  it('deduplicates repeated launches, outcomes and multi-event / multi-reference bad labels', () => {
    const input = fixture(); input.source.launches.push(clone(input.source.launches[0]));
    input.source.outcomes.push(clone(input.source.outcomes[0]));
    const other = clone(input.source.outcomes[0]); other.outcome.id = hash(500); other.outcome.kind = 'restriction'; other.outcome.sizeUsd = 1000;
    input.source.outcomes.push(other); input.source.assessments[0].outcomeIds.push(other.outcome.id as `0x${string}`);
    expect(evaluateHistoryBoosterV2(input).history).toMatchObject({ eligibleMature: 6, assessedMature: 6, badMature: 3 });
    input.source.launches.at(-1)!.launchedAt = at(NOW - 21000);
    expect(() => evaluateHistoryBoosterV2(input)).toThrow('Conflicting duplicate');
  });

  it('latest incomplete assessment and superseded outcome disable, rather than resurrect, an older positive', () => {
    const input = fixture(), revision = clone(input.source.assessments[0]);
    revision.id = hash(2000); revision.knownAt = known(NOW); revision.calibrated = false; input.source.assessments.push(revision);
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ historyPoints: 0, check: { status: 'missing' } });
    revision.knownAt = known(NOW, '2');
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(10);
    const replacement = clone(input.source.outcomes[0]); replacement.outcome.supersedes = replacement.outcome.id;
    replacement.outcome.id = hash(3000); replacement.outcome.knownAt = known(NOW); replacement.outcome.status = 'censored';
    input.source.outcomes.push(replacement);
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    replacement.outcome.knownAt = known(NOW, '2');
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(10);
  });

  it('confirmed outcomes and controller facts cannot be known before their horizon or after the captured cut', () => {
    const input = fixture(); input.source.outcomes[0].outcome.knownAt = input.source.launches[0].knownAt;
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    const restriction = fixture(); restriction.source.outcomes[0].outcome.kind = 'restriction';
    restriction.source.outcomes[0].outcome.controller.knownAt = known(NOW, '2');
    expect(evaluateHistoryBoosterV2(restriction).historyPoints).toBe(0);
  });
});

describe('032 history strengthens present exposure only', () => {
  it.each([0, 29, 30])('base %s gate is inclusive at 30', base => {
    const input = fixture(); input.baseScore = base; input.factors = [factor('execution_cost', 'E', base)];
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(base >= 30 ? 10 : 0);
  });
  it('history-only and flow/integrity-only cannot create current risk', () => {
    const input = fixture(); input.baseScore = 0; input.factors = [];
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ score: 0, historyPoints: 0 });
    input.baseScore = 60; input.factors = [factor('campaign_pressure', 'Ff', 60), factor('operator_hold', 'O', 0)];
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ score: 60, historyPoints: 0 });
    input.baseScore = 10; input.factors = [factor('agent_instruction', 'I', 10)];
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
  });
  it('requires assigned positive current E/O/C, not suppressed eligible points, and caps score at 100', () => {
    const input = fixture(); input.baseScore = 60; input.factors = [factor('campaign_pressure', 'Ff', 60), factor('execution_cost', 'E', 0)];
    input.factors[1].eligiblePoints = 60;
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    input.baseScore = 95; input.factors = [factor('execution_cost', 'E', 60), factor('operator_hold', 'O', 35)];
    expect(evaluateHistoryBoosterV2(input).score).toBe(100);
    input.baseScore = 30;
    expect(() => evaluateHistoryBoosterV2(input)).toThrow('family maxima');
  });
  it('old events cannot become recent merely because collection or assessment was recorded recently', () => {
    const input = fixture(0);
    for (let i = 0; i < 3; i++) addLaunch(input.source, i, NOW - 604861 - i * 1000, 'dump');
    input.source.assessments.forEach(a => a.knownAt = known(NOW));
    const result = evaluateHistoryBoosterV2(input);
    expect(result.history.badMature).toBe(3); expect(result.historyPoints).toBe(0);
    input.source.outcomes[0].eventCursor = at(NOW - 604800);
    input.source.outcomes[0].attribution = proof(NOW - 604800);
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(15);
  });
});

describe('032 attribution, recent links and frozen known-at cuts', () => {
  it.each(['dump', 'harmful_disposition', 'collapse', 'survived'] as const)('bot-only %s never enters principal bad history', kind => {
    const input = fixture(3, 3); input.source.outcomes.forEach(o => { o.outcome.kind = kind; o.outcome.attribution = 'non_operator'; o.attribution = null; });
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ historyPoints: 0, check: { status: 'complete' }, history: { badMature: 0, assessedMature: 3 } });
  });
  it.each(['origin', 'coordination', 'outsider', 'service', 'unresolved'] as const)('%s does not prove own-side selling', kind => {
    const input = fixture(); input.source.outcomes[0].attribution!.kind = kind;
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ historyPoints: 0, check: { status: 'missing' } });
  });
  it('counts qualified own-side removal and controller-linked restrictions but not collapse', () => {
    const input = fixture(3, 3); input.source.outcomes[1].outcome.kind = 'rug'; input.source.outcomes[2].outcome.kind = 'restriction';
    expect(evaluateHistoryBoosterV2(input).history.badMature).toBe(3);
    input.source.outcomes[2].outcome.controller.value = actor;
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    input.source.outcomes[2].outcome.kind = 'collapse';
    expect(evaluateHistoryBoosterV2(input).history.badMature).toBe(2);
  });
  it.each(['candidate', 'confirmed', 'unresolved'] as const)('shared-service %s scope never pools customers history', status => {
    const input = fixture(); input.source.operator.serviceStatus = status;
    expect(evaluateHistoryBoosterV2(input)).toMatchObject({ historyPoints: 0, candidatePoints: 0, history: { operatorGroup: null, badMature: 0 }, gaps: expect.arrayContaining(['service_scope']) });
  });
  it('stops infrastructure expansion and foreign operator identity while keeping per-user history', () => {
    const input = fixture(); input.source.operator.group.memberIds.push(service);
    expect(evaluateHistoryBoosterV2(input).gaps).toContain('service_scope');
    const separated = fixture(); separated.source.outcomes[0].attribution!.operatorGroupId = hash(999);
    expect(evaluateHistoryBoosterV2(separated).historyPoints).toBe(0);
    expect(evaluateHistoryBoosterV2(fixture()).historyPoints).toBe(10);
  });
  it('rejects legacy label injection and does not mutate the input', () => {
    const input = fixture(), original = JSON.stringify(input); evaluateHistoryBoosterV2(input);
    expect(JSON.stringify(input)).toBe(original);
    expect(GuardHistoryInputSchema.safeParse({ ...input, source: { ...input.source, legacyOutcomes: ['dumped', 'danger', 'clone'] } }).success).toBe(false);
    expect(GuardHistoryInputSchema.safeParse({ ...input, source: { ...input.source, outcomes: [{ outcome: 'dumped' }] } }).success).toBe(false);
  });
  it('full availability sequence and same-second execution order exclude later evidence', () => {
    const input = fixture(); input.source.outcomes[0].attribution!.knownAt = known(NOW, '2');
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    input.availabilityCut.acquisitionSequence = '2';
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(10);
    input.source.outcomes[0].attribution!.knownAt.cursor = at(NOW, 2);
    input.availabilityCut.cursor = at(NOW, 1); input.cursor = at(NOW - 1);
    input.source.enumeration.coverage.through = input.cursor; input.source.enumeration.knownAt = { ...input.availabilityCut };
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
  });
  it('later collector proof cannot rewrite earlier predictors; only reviewed recent material loops qualify', () => {
    const input = fixture(); const o = input.source.outcomes[0], sold = Number(o.eventCursor.timestampSec);
    const p = proof(sold, actor); p.kind = 'reviewed_closed_loop'; p.knownAt = known(NOW, '2');
    p.loop = { funder: principal, collector: principal, fundedAt: at(sold - 100), boughtAt: at(sold - 60), soldAt: o.eventCursor, collectedAt: at(sold + 100),
      fundingBps: 9000, collectionBps: 9000, nonServiceHops: 3, reviewed: true, serviceFree: true,
      fundingCoverage: coverage(sold - 100, sold - 60), collectionCoverage: coverage(sold, sold + 100) };
    o.attribution = p;
    expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(0);
    input.availabilityCut.acquisitionSequence = '2'; expect(evaluateHistoryBoosterV2(input).historyPoints).toBe(10);
    for (const mutation of ['old', 'afterBuy', 'lateSweep', 'dust', 'unreviewed', 'service', 'partial', 'foreignEndpoints', 'differentCollector'] as const) {
      const modified = clone(input), loop = modified.source.outcomes[0].attribution!.loop!;
      if (mutation === 'old') loop.fundedAt = at(sold - 21700);
      if (mutation === 'afterBuy') loop.fundedAt = loop.soldAt;
      if (mutation === 'lateSweep') loop.collectedAt = at(sold + 86401);
      if (mutation === 'dust') loop.fundingBps = 8999;
      if (mutation === 'unreviewed') loop.reviewed = false;
      if (mutation === 'service') loop.serviceFree = false;
      if (mutation === 'foreignEndpoints') { loop.funder = address(777); loop.collector = address(777); }
      if (mutation === 'differentCollector') loop.collector = actor;
      if (mutation === 'partial') { loop.fundingCoverage.complete = false; loop.fundingCoverage.gaps = ['missing']; }
      expect(evaluateHistoryBoosterV2(modified), mutation).toMatchObject({ historyPoints: 0, check: { status: 'missing' } });
    }
  });
});
