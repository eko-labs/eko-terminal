// Local cached timing evidence only; no acquisition, network, ports or release-gate claim.
import { performance } from 'node:perf_hooks';
import { evaluate } from '@eko/policy';
import { request, agent, deps, binding, observationFor, stateFor } from '../../../packages/policy/test/actual-fixtures.js';
import { policy } from '../../../packages/policy/test/fixtures.js';
import { cachedGuard } from '../../../packages/policy/test/guard-fixtures.js';
const b = binding(), q = observationFor(b), state = stateFor(b), verdict = cachedGuard();
const cached = { ...deps, verdictFor: () => verdict, actualOrderFor: () => ({ status: 'ready' as const, observation: q }), actualStateFor: () => state };
for (let i = 0; i < 500; i++) evaluate(request, policy, agent, cached);
const timings: number[] = [];
for (let i = 0; i < 5000; i++) {
  const started = performance.now(), result = evaluate(request, policy, agent, cached);
  timings.push(performance.now() - started);
  if (result.decision !== 'allow') throw new Error('Unexpected fixture denial');
}
timings.sort((a, b) => a - b);
const p95 = timings[Math.ceil(timings.length * .95) - 1]!;
console.log(JSON.stringify({ origin: 'offline_fixture', node: process.version, warmup: 500, n: 5000,
  p95_ms: p95, target_ms: 150, upstream_requests: 0 }));
if (p95 >= 150) throw new Error('Cached p95 target failed');
