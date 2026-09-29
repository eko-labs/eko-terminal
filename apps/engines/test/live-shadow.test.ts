import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { referenceDigest } from '@eko/chain';
import { reportLiveShadowFixtures } from '../src/live-shadow.js';
import { liveShadowMain } from '../src/live-shadow-cli.js';
import { developmentGrid } from '../src/development-fit.js';
import { DevelopmentFreezeSchema } from '../src/locked-test.js';
import { liveShadowFixture, shadowTick, fixtureSnapshot, workloadFixture, followupTick, resealFreeze } from './live-shadow-fixtures.js';
import { hash, NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';

const report = (f: ReturnType<typeof liveShadowFixture>) => reportLiveShadowFixtures(f, hash(62));
describe('062 frozen offline shadow preparation', () => {
  it('keeps the 061 non-accepted state disabled with zero measured evidence and no release manifest', () => {
    const r = report(liveShadowFixture());
    expect(r).toMatchObject({ status: 'disabled_no_accepted_candidate', enabled: false, acceptedCandidate: null,
      active: false, released: false, releaseManifest: null, measured: { coveredDurationSec: 0, launches: 0, matureLaunches: 0 },
      spend: { actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: null },
      process: { running: false, continuationInstalled: false } });
    expect(r.gateTable.every(g => !g.acceptancePass)).toBe(true);
    expect(r.pins.candidateRevision).toBeNull();
  });
  it('requires duration AND launch count, never stopping on the first minimum', () => {
    for (const f of [workloadFixture(5000, 604799), workloadFixture(4999)]) {
      expect(report(f).status).toBe('fixture_collecting'); expect(report(f).fixture.enrollmentEndSec).toBeNull();
    }
    const r = report(workloadFixture());
    expect(r.status).toBe('fixture_followup'); expect(r.fixture.pendingLaunches).toBe(5000);
  });
  it('follows final entrants through entry delay, all horizons and confirmation with timer-only progress', () => {
    const f = workloadFixture(); f.ticks.push(followupTick(f, -1));
    expect(report(f).fixture.matureLaunches).toBe(0);
    const last = f.ticks.at(-1)!;
    const t = shadowTick(last.throughSec, last.throughSec + 1);
    t.followup = last.followup.map(r => ({ ...r, coveredThroughSec: t.throughSec, confirmedThroughSec: t.throughSec }));
    f.ticks.push(t); const r = report(f);
    expect(r).toMatchObject({ status: 'fixture_complete', enabled: false, releaseManifest: null });
    expect(r.fixture).toMatchObject({ matureLaunches: 5000, knownLaunches: 5000, coveredDurationSec: 604800 });
    expect(r.gateTable.at(-1)?.numericalPass).toBe(false); // no snapshots/coverage acceptance
  });
  it('does not credit source outages, overlapping coverage twice, or wall time alone', () => {
    const f = workloadFixture(), t = f.ticks[0];
    t.coverage[0].fromSec += 100; t.coverage.push({ ...t.coverage[0] });
    const r = report(f);
    expect(r.fixture.wallElapsedSec).toBe(604800); expect(r.fixture.coveredDurationSec).toBe(604700);
    expect(r.status).toBe('fixture_collecting');
  });
  it('retains missing/provider-censored follow-up as unknown even after elapsed maturity', () => {
    const f = workloadFixture(2); f.ticks.push(followupTick(f));
    f.ticks[1].followup[0].outcome = 'provider_censored'; f.ticks[1].followup.pop();
    const r = report(f);
    expect(r.fixture.knownLaunches).toBe(0); expect(r.fixture.matureLaunches).toBe(1);
    expect(r.fixture.entrants[0].horizons[0].outcome).toBe('provider_censored');
  });
  it('runs isolated API/buyer-level/Signal comparisons and reports missing completion separately', () => {
    const f = liveShadowFixture(true), s = fixtureSnapshot(f), original = referenceDigest(s);
    const t = shadowTick(f.definition.startSec, NOW + 1);
    t.launches.push({ coin: s.coin, launchSec: f.definition.startSec }); t.snapshots.push(s); f.ticks.push(t);
    const r = report(f), row = r.comparisons[0];
    expect(referenceDigest(s)).toBe(original);
    expect(row).toMatchObject({ apiPreview: { mode: 'shadow', activeBadge: false, level: 'high' }, guardDisagreement: true,
      policy: { applied: false, candidateDenials: { safe: true, balanced: true, degen: true } },
      signal: { readings: { risk: 0 } }, signalDisagreement: true });
    expect(row.policy.disagreements).toEqual(['safe', 'balanced', 'degen']);
    expect(r.operations.latency[0].metrics.criticalCompletionMs).toEqual({ observations: 1, completed: 0, missing: 1, p95Ms: null });
    expect(r.operations.serviceBotErrors).toEqual(['service_unresolved']);
  });
  it('names unsupported frozen Signal bands without forging a shared assessment', () => {
    const f = liveShadowFixture(true);
    const p = developmentGrid().find(p => p.enabled.length > 1 && p.weights.execution_cost === 80)!;
    f.definition.freeze!.parameters = DevelopmentFreezeSchema.shape.parameters.parse(p);
    f.definition.freeze!.parametersHash = p.parametersHash; resealFreeze(f);
    const t = shadowTick(f.definition.startSec, NOW + 1), s = fixtureSnapshot(f);
    t.launches.push({ coin: s.coin, launchSec: f.definition.startSec }); t.snapshots.push(s); f.ticks.push(t);
    const r = report(f); expect(r.comparisons[0].signal).toBeNull();
    expect(r.comparisons[0].signalGap).toBe('frozen_parameters_not_supported_by_shared_signal_contract');
  });
  it('latches gate regressions instead of hiding them after a later pass', () => {
    const f = liveShadowFixture(true), t = shadowTick(f.definition.startSec, NOW);
    t.gateChecks.push({ gate: 'parity', passed: false, evidenceHash: hash(70) }); f.ticks.push(t);
    const next = shadowTick(NOW, NOW + 1); next.gateChecks.push({ gate: 'parity', passed: true, evidenceHash: hash(71) }); f.ticks.push(next);
    expect(report(f).gateRegressions).toEqual(['parity']);
  });
  it('rejects paid/live inputs, frozen parameter tampering and active influence', () => {
    const f = liveShadowFixture(true); f.definition.freeze!.parameters!.high++;
    expect(() => report(f)).toThrow('changed fixture freeze');
    const g = liveShadowFixture(true), t = shadowTick(g.definition.startSec, NOW + 1), s = fixtureSnapshot(g);
    s.input.mode = 'active'; t.launches.push({ coin: s.coin, launchSec: g.definition.startSec }); t.snapshots.push(s); g.ticks.push(t);
    expect(() => report(g)).toThrow('isolation');
    const paid = liveShadowFixture(); paid.ticks.push({ ...shadowTick(NOW, NOW + 1), requestUnits: 1 } as never);
    expect(() => report(paid)).toThrow();
    expect(() => report({ ...liveShadowFixture(), definition: { ...liveShadowFixture().definition, origin: 'measured' } } as never)).toThrow();
  });
  it('rejects duplicate launches, endpoint entrants, post-enrollment launches and regressing clocks', () => {
    const f = workloadFixture(2); f.ticks[0].launches[1] = f.ticks[0].launches[0]; expect(() => report(f)).toThrow('Duplicate');
    const g = workloadFixture(1); g.ticks[0].launches[0].launchSec = g.ticks[0].throughSec; expect(() => report(g)).toThrow('out-of-window');
    const h = workloadFixture(), t = followupTick(h); t.launches.push({ ...h.ticks[0].launches[0], launchSec: t.throughSec - 1 });
    h.ticks.push(t); expect(() => report(h)).toThrow('out-of-window');
    const j = liveShadowFixture(); j.ticks.push(shadowTick(j.definition.startSec, j.definition.startSec)); expect(() => report(j)).toThrow('Non-progressing');
  });
  it('checkpoints once, verifies identical resume, appends progress and refuses changed immutable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eko-shadow-fixture-'));
    try {
      const source = join(root, 'input.json'), output = join(root, 'output'), f = liveShadowFixture();
      await writeFile(source, JSON.stringify(f)); const args = ['--fixture', source, output];
      expect(await liveShadowMain(args)).toMatchObject({ event: 'shadow_fixture_prepared', enabled: false });
      const first = await readFile(join(output, 'checkpoint.json'), 'utf8');
      expect(await liveShadowMain(args)).toMatchObject({ event: 'shadow_fixture_verified', replayed: false });
      expect(await readFile(join(output, 'checkpoint.json'), 'utf8')).toBe(first);
      f.ticks.push(shadowTick(f.definition.startSec, NOW)); await writeFile(source, JSON.stringify(f));
      expect(await liveShadowMain(args)).toMatchObject({ event: 'shadow_fixture_checkpointed' });
      expect((await readdir(output)).filter(n => n.endsWith('.checkpoint.json'))).toHaveLength(2);
      const changed = structuredClone(f); changed.ticks[0].coverage = []; changed.ticks.push(shadowTick(NOW, NOW + 1));
      await writeFile(source, JSON.stringify(changed)); await expect(liveShadowMain(args)).rejects.toThrow('append-only');
      await writeFile(source, JSON.stringify(f));
      const artifact = (await readdir(output)).find(n => n === `${referenceDigest(f)}.report.json`)!;
      await writeFile(join(output, artifact), '{}'); await expect(liveShadowMain(args)).rejects.toThrow('artifact changed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
