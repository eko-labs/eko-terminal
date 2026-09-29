import { expect, it } from 'vitest';
import { evaluateGuardV2 } from '@eko/playbooks';
import { guardScoreHash } from '@eko/playbooks';
import { IncrementalGuardCache, GuardChainTimeQueue } from '../src/incremental-guard.js';
import { input, observation, address } from '../../../packages/playbooks/test/scoring-fixtures.js';
const source = '1'.repeat(64), candidate = '2'.repeat(64);
const context = { sourceRevision: source, route: 'fixture-route', sizeRaw: '100', account: address(20) };
const timer = (id: string, dueSec: string, kind: 'expiry' | 'maturity' | 'probe' = 'expiry') => ({ id, dueSec, kind,
  chainId: 4663, coin: address(1), sourceRevision: source, inputRef: '3'.repeat(64), dependencyIds: ['4'.repeat(64)] });
it('caches captured arithmetic, keeps incomplete results incomplete and isolates inputs/results', () => {
  const cache = new IncrementalGuardCache(), i = input([observation('operator_hold', 12)]);
  i.checks = [];
  const expected = evaluateGuardV2(i), r = cache.evaluate(i, context, [address(20)]);
  expect(r).toEqual(expected); expect(r.assessment.completeness.buyCriticalComplete).toBe(false);
  expect(cache.evaluate(i, context, [address(20)])).toBe(r);
  expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  i.observations.length = 0; expect(r.assessment.baseScore).toBe(35);
  expect(() => { r.assessment.score = 99; }).toThrow();
});
it('invalidates all wallet-dependent tokens, isolates chains and all source/context/cursor revisions', () => {
  const cache = new IncrementalGuardCache(), a = input(), b = input(); b.coin = address(2);
  cache.evaluate(a, context, [address(20)]); cache.evaluate(b, context, [address(20)]);
  expect(cache.affectedCoins(1, [address(20)])).toEqual([]);
  expect(cache.invalidateWallets(4663, [address(20)])).toEqual([address(1), address(2)]);
  expect(cache.stats().entries).toBe(0); expect(cache.stats().reverseWallets).toBe(0);
  cache.evaluate(a, context); cache.evaluate(a, { ...context, route: 'other-route' });
  cache.evaluate(a, { ...context, sourceRevision: '5'.repeat(64) });
  const fork = JSON.parse(JSON.stringify(a).replaceAll(a.cursor.blockHash, `0x${'6'.repeat(64)}`));
  cache.evaluate(fork, context); expect(cache.stats().entries).toBe(4);
  cache.invalidateSource(source); expect(cache.stats().entries).toBe(1);
});
it('bounds retained hot-token cache and restores deterministic results and reverse dependencies', () => {
  const cache = new IncrementalGuardCache({ entries: 2, bytes: 200000, dependenciesPerEntry: 2 });
  const i = input(); cache.evaluate(i, context, [address(20)]);
  const cp = cache.checkpoint(candidate), restored = IncrementalGuardCache.restore(JSON.parse(JSON.stringify(cp)), candidate, source);
  expect(restored.evaluate(i, context, [address(20)])).toEqual(cache.evaluate(i, context, [address(20)]));
  expect(restored.affectedCoins(4663, [address(20)])).toEqual([i.coin]);
  for (let n = 0; n < 100; n++) cache.evaluate(i, { ...context, sizeRaw: String(n) }, [address(20)]);
  expect(cache.stats().entries).toBe(2); expect(cache.stats().bytes).toBeLessThanOrEqual(200000);
  expect(cache.stats().reverseWallets).toBe(1);
  const tiny = new IncrementalGuardCache({ entries: 2, bytes: 1, dependenciesPerEntry: 1 });
  expect(tiny.evaluate(i, context)).toEqual(evaluateGuardV2(i)); expect(tiny.stats().entries).toBe(0);
  expect(() => IncrementalGuardCache.restore(cp, '7'.repeat(64), source)).toThrow();
  expect(() => IncrementalGuardCache.restore(cp, candidate, '7'.repeat(64))).toThrow();
  const changed = structuredClone(cp); changed.entries[0].input.checks = []; expect(() => IncrementalGuardCache.restore(changed, candidate, source)).toThrow();
  expect(() => cache.evaluate({ ...i, mode: 'active' }, context)).toThrow('shadow');
});
it('orders no-trade expiry/maturity/probe jobs by exact chain time and stable IDs; failure remains pending', () => {
  const q = new GuardChainTimeQueue(4663, source, 3);
  q.enqueue(timer('probe', '9007199254740993', 'probe')); q.enqueue(timer('maturity', '100', 'maturity')); q.enqueue(timer('expiry', '100'));
  expect(q.enqueue(timer('expiry', '100'))).toBe(false);
  expect(() => q.enqueue(timer('overflow', '1'))).toThrow('capacity');
  expect(() => q.enqueue(timer('expiry', '101'))).toThrow('conflict');
  q.advance('99'); expect(q.peekDue()).toBeNull(); q.advance('100'); expect(q.peekDue()?.id).toBe('expiry');
  const cp = q.checkpoint(candidate), resumed = GuardChainTimeQueue.restore(JSON.parse(JSON.stringify(cp)), candidate, source, 4663);
  expect(resumed.peekDue()).toEqual(q.peekDue()); expect(resumed.peekDue()).toEqual(q.peekDue());
  resumed.acknowledge('expiry'); expect(resumed.peekDue()?.id).toBe('maturity'); resumed.acknowledge('maturity');
  expect(resumed.peekDue()).toBeNull(); resumed.advance('9007199254740993'); expect(resumed.peekDue()?.id).toBe('probe');
  expect(() => resumed.advance('100')).toThrow('backwards');
  expect(resumed.invalidateDependencies(['4'.repeat(64)])).toEqual(['probe']); expect(resumed.stats().pending).toBe(0);
  expect(() => GuardChainTimeQueue.restore(cp, candidate, source, 1)).toThrow();
  cp.clockSec = '101'; expect(() => GuardChainTimeQueue.restore(cp, candidate, source, 4663)).toThrow();
});
it('arbitrary heap deletions retain ordering across deterministic restart, and reject forged checkpoints', () => {
  const q = new GuardChainTimeQueue(4663, source, 200);
  for (let n = 0; n < 100; n++) q.enqueue(timer(`job-${n}`, String((n * 7919) % 100)));
  for (let n = 0; n < 100; n += 3) q.acknowledge(`job-${n}`);
  q.advance('100'); const r = GuardChainTimeQueue.restore(q.checkpoint(candidate), candidate, source, 4663);
  const drained = [];
  while (r.peekDue()) { const t = r.peekDue()!; drained.push(t); r.acknowledge(t.id); }
  expect(drained.map(t => Number(t.dueSec))).toEqual(drained.map(t => Number(t.dueSec)).sort((a, b) => a - b));
  const cp = q.checkpoint(candidate); cp.timers.push(cp.timers[0]);
  const { digest: _, ...body } = cp; cp.digest = guardScoreHash(body);
  expect(() => GuardChainTimeQueue.restore(cp, candidate, source, 4663)).toThrow();
});

it('reports missing/failed scans separately from complete latency, with named age/venue populations', async () => {
  const { reportGuardPerformance } = await import('../src/guard-performance.js');
  const report = reportGuardPerformance({ sourceRevision: source, candidateRevision: candidate, validation: 'fixture',
    evaluations: 100, elapsedMs: 1000, evaluatorRpc: 0, priorEvaluationsPerSec: 170, pilotTargetRef: null }, [
    { stage: 'scan', venue: 'pons_curve', ageSec: 0, queueMs: 1, workMs: 1, status: 'missing' },
    { stage: 'probe', venue: 'v4', ageSec: 86400, queueMs: 10000, workMs: 1, status: 'pending' },
    { stage: 'critical', venue: 'v3', ageSec: 3600, queueMs: 6000, workMs: 1, status: 'failed' },
    { stage: 'preflight', venue: 'pons_curve', ageSec: 300, queueMs: 0, workMs: 150, status: 'complete' },
  ]);
  expect(report.targetMet).toBe(false); expect(report.regressionPct).toBeLessThan(0);
  expect(report.operatingTargetStatus).toBe('unavailable'); expect(report.released).toBe(false);
  expect(report.budgets.find(b => b.stage === 'scan')).toMatchObject({ p95Ms: null, met: null, allRequiredComplete: false });
  expect(report.budgets.find(b => b.stage === 'preflight')).toMatchObject({ met: false });
  expect(report.groups.find(g => g.key === 'probe:v4:at_least_86400s')).toMatchObject({ pending: 1, completionP95Ms: null });
});
