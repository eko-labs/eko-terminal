import { expect, it } from 'vitest';
import { evaluate } from '../src/index.js';
import { agent, approval, ASSET, deps, NOW, policy, request, verdict } from './fixtures.js';

// Node's global monotonic clock, declared here to keep the package free of Node typings.
declare const performance: { now(): number };

it('keeps p95 evaluation well below the 150 ms budget (§9.6)', () => {
  const req = { ...request, order: { ...request.order, notionalUsd: 2_001,
    tx: { to: ASSET as `0x${string}`, data: ('0x' + 'ab'.repeat(32_768)) as `0x${string}`, value: '0' } },
  context: { ...request.context!, reportedAt: new Date(NOW - 300_001).toISOString(), positions:
    Array.from({ length: 200 }, (_, i) => ({ instrument: `coin-${i}`, qty: 1, valueUsd: 100 })) } };
  const cached = { ...deps, approvalFor: () => ({ ...approval, status: 'approved' as const }) };
  const denial = { ...deps, verdictFor: () => ({ ...verdict, level: 'danger' as const }) };
  const run = () => {
    const allowed = evaluate(req, policy, agent, cached);
    const denied = evaluate(req, { ...policy, maxPositionUsd: 1, maxDailyLossUsd: 0 }, agent, denial);
    return [allowed.decision, denied.decision];
  };
  for (let i = 0; i < 100; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < 500; i++) {
    const start = performance.now();
    const decisions = run();
    samples.push(performance.now() - start);
    expect(decisions).toEqual(['allow', 'deny']);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
  expect(p95).toBeLessThan(30);
});
