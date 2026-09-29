import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { referenceDigest } from '@eko/chain';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
import { probabilityFrame } from './sampling-fixtures.js';
import { monthlyFixture } from './monthly-evaluation-fixtures.js';
import { calendarMonth, MONTHLY_QUOTAS, evaluateMonthlyFixtures, MonthlyInputSchema } from '../src/monthly-evaluation.js';
import { drawStratifiedProbabilitySample, weightedSampleRate } from '../src/probability-sample.js';
import { monthlyEvaluationMain } from '../src/monthly-evaluation-cli.js';

it('uses exact UTC calendar months, leap days, year rollover and follow-up beyond month end', () => {
  for (const [month, days, next] of [['2024-02', 29, '2024-03'], ['2026-02', 28, '2026-03'],
    ['2026-04', 30, '2026-05'], ['2026-12', 31, '2027-01']] as const) {
    const w = calendarMonth(month);
    expect(w.untilSec - w.fromSec).toBe(days * 86400); expect(w.nextMonth).toBe(next);
    expect(new Date(w.fromSec * 1000).toISOString()).toBe(`${month}-01T00:00:00.000Z`);
  }
  for (const invalid of ['2026-00', '2026-13', '26-02', '1969-12', '9999-12']) expect(() => calendarMonth(invalid)).toThrow();
  const report = evaluateMonthlyFixtures(monthlyFixture(), hash('implementation'));
  expect(report.schedule.evaluateAfterSec).toBe(calendarMonth('2026-10').untilSec + 604890);
  expect(report.schedule.nextScheduledApplicationJobSec).toBe(calendarMonth('2026-11').untilSec + 604890);
});

it('draws a new 200-token probability design and preserves exact inclusion weights without challenge mixing', () => {
  const frame = probabilityFrame(), design = drawStratifiedProbabilitySample(frame, MONTHLY_QUOTAS);
  expect(design.sampleSize).toBe(200); expect(design.strata.map(s => s.n_h)).toEqual(MONTHLY_QUOTAS);
  expect(new Set(design.strata.flatMap(s => s.selected)).size).toBe(200);
  const rows = design.strata.flatMap(s => s.selected.map(coin => ({ coin, value: true, origin: 'probability' as const })));
  expect(weightedSampleRate(design, rows)).toEqual({ numerator: '1', denominator: '1' });
  expect(() => weightedSampleRate(design, rows.map(r => ({ ...r, origin: 'challenge' })))).toThrow();
  expect(() => drawStratifiedProbabilitySample(frame, [0, 25, 25, 35, 80])).toThrow();
  expect(drawStratifiedProbabilitySample(probabilityFrame([1, 1, 1, 1, 500]), MONTHLY_QUOTAS).strata.map(s => s.n_h)).toEqual([1, 1, 1, 1, 196]);
});

it('checks the prepared inactive job without any accepted manifest or data', async () => {
  const input = JSON.parse(await readFile(new URL('../../../docs/operations/guard-monthly/064-prepared.json', import.meta.url), 'utf8'));
  expect(evaluateMonthlyFixtures(input, hash('implementation'))).toMatchObject({ status: 'disabled_no_accepted_release', enabled: false, actualRequests: 0 });
});

it('remains disabled before accepted released inventory admission, including null, revoked and untrusted booleans', () => {
  for (const edit of [
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.manifest = null; },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.inventory.accepted = []; },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.inventory.accepted[0].released = false; },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.inventory.revoked = [referenceDigest(i.definition.manifest)]; },
  ]) {
    const input = monthlyFixture(); edit(input);
    expect(evaluateMonthlyFixtures(input, hash('implementation'))).toMatchObject({ status: 'disabled_no_accepted_release', enabled: false, gates: null });
  }
  expect(MonthlyInputSchema.safeParse({ ...monthlyFixture(), enabled: true }).success).toBe(false);
  expect(MonthlyInputSchema.safeParse({ ...monthlyFixture(), definition: { ...monthlyFixture().definition, origin: 'measured' } }).success).toBe(false);
});

it('reports follow-up and independent labels pending; failed frozen gates prepare receipt-backed suspension without promotion', () => {
  const waiting = evaluateMonthlyFixtures(monthlyFixture(), hash('implementation'));
  expect(waiting).toHaveProperty('pendingFollowup');
  const input = monthlyFixture(true), result = evaluateMonthlyFixtures(input, hash('implementation'));
  expect(result).toMatchObject({ status: 'fixture_evaluated_not_accepted', enabled: false, released: false, acceptedCandidate: null,
    activeChangesApplied: false, actualRequestUnits: 0, actualPaidNanoUsd: '0', pendingFollowup: [] });
  if (!('pendingLabels' in result)) throw new Error('Expected fixture review');
  expect(result.pendingLabels.length).toBe(input.definition.frame!.members.length + 1);
  expect(result.gates!.gateTable.every(g => !g.acceptancePass)).toBe(true);
  expect(result.actions).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'suspend_coverage', gapsVisible: ['operator_history'], applied: false }),
    expect.objectContaining({ action: 'return_factor_to_shadow', target: 'execution_cost', receiptHashes: [result.gates!.reportHash], applied: false }),
  ]));
  expect(result.challenges).toHaveLength(1); expect(result.sample!.sampleSize).toBe(12);
});

it('rejects premature, changed, unrelated or repeated gate inspection and overlapping challenges', () => {
  for (const edit of [
    (i: ReturnType<typeof monthlyFixture>) => { i.ticks[0].throughSec = calendarMonth('2026-10').untilSec; i.ticks[0].followup = []; },
    (i: ReturnType<typeof monthlyFixture>) => { i.ticks[0].followup = []; },
    (i: ReturnType<typeof monthlyFixture>) => { i.ticks[0].evaluation!.freeze!.candidateRevision = hash('retuned'); },
    (i: ReturnType<typeof monthlyFixture>) => { i.ticks[0].evaluation!.features[0].input.codeHash = hash('changed-code'); },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.frame!.members[0].launchSec = i.definition.frame!.untilSec; },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.challenges[0].coin = i.definition.frame!.members[0].coin; },
    (i: ReturnType<typeof monthlyFixture>) => { i.definition.changes.push({ field: 'rules', beforeHash: hash('before'), afterHash: hash('after'), reason: 'method_changed',
      receiptHashes: [hash('reason')], developmentHash: null, validationHash: null, newHeldOutHash: null }); },
    (i: ReturnType<typeof monthlyFixture>) => { i.ticks.push(structuredClone(i.ticks[0])); },
  ]) { const input = monthlyFixture(true); edit(input); expect(() => evaluateMonthlyFixtures(input, hash('implementation'))).toThrow(); }
});

it('resumes partial publication, retains old generations, verifies identical resume and refuses rewritten inputs/artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eko-monthly-'));
  try {
    const source = join(dir, 'input.json'), output = join(dir, 'output'), input = monthlyFixture();
    await writeFile(source, JSON.stringify(input));
    await expect(monthlyEvaluationMain(['--fixture', source, output], () => { throw new Error('fixture interruption'); })).rejects.toThrow('fixture interruption');
    const first = await monthlyEvaluationMain(['--fixture', source, output]);
    const files = await readdir(output);
    expect(await monthlyEvaluationMain(['--fixture', source, output])).toMatchObject({ replayed: false, checkpointHash: first.checkpointHash });
    input.ticks.push({ throughSec: calendarMonth('2026-10').untilSec, followup: [], coverageFailures: [], challengeReviews: [], evaluation: null });
    await writeFile(source, JSON.stringify(input));
    const second = await monthlyEvaluationMain(['--fixture', source, output]);
    expect(second.checkpointHash).not.toBe(first.checkpointHash);
    for (const name of files) expect(await readdir(output)).toContain(name);
    const secondCheckpoint = JSON.parse(await readFile(join(output, `${second.checkpointHash}.checkpoint.json`), 'utf8'));
    expect(secondCheckpoint.prior).toBe(first.checkpointHash);
    input.ticks.push(monthlyFixture(true).ticks[0]); await writeFile(source, JSON.stringify(input));
    const complete = await monthlyEvaluationMain(['--fixture', source, output]);
    const checkpoint = JSON.parse(await readFile(join(output, `${complete.checkpointHash}.checkpoint.json`), 'utf8'));
    expect(checkpoint.prior).toBe(second.checkpointHash);
    input.ticks.push({ ...input.ticks[0], throughSec: input.ticks[1].throughSec }); await writeFile(source, JSON.stringify(input));
    await expect(monthlyEvaluationMain(['--fixture', source, output])).rejects.toThrow('Append-only');
    input.ticks.pop();
    input.definition.sourceRevision = hash('changed-definition'); await writeFile(source, JSON.stringify(input));
    await expect(monthlyEvaluationMain(['--fixture', source, output])).rejects.toThrow('mismatch');
    input.definition.sourceRevision = monthlyFixture().definition.sourceRevision; await writeFile(source, JSON.stringify(input));
    await writeFile(join(output, `${checkpoint.inputHash}.report.json`), '{}');
    await expect(monthlyEvaluationMain(['--fixture', source, output])).rejects.toThrow('changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
