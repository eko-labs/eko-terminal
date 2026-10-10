// Cached server timing only; includes SQL/crypto, excludes queue waits and RPC.
import { performance } from 'node:perf_hooks';
import { preflightFixture } from './preflight-fixture.js';
const f = await preflightFixture();
try {
  const a = await f.owner(), req = await f.req(a.agentId), service = f.service();
  for (let i = 0; i < 10; i++) await service.run(a, { ...req, clientOrderRef: `fixture-warmup-${i}` });
  const timings: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const result = await service.run(a, { ...req, clientOrderRef: `fixture-timing-${i}` });
    if (result.decision !== 'allow') throw new Error('Unexpected fixture denial');
    timings.push(performance.now() - start);
  }
  timings.sort((a,b) => a-b);
  const p95 = timings[94]!;
  console.log(JSON.stringify({ origin: 'offline_fixture', node: process.version, samples: 100, warmup: 10,
    p95_ms: p95, target_ms: 150, includes: 'hashing, SQL transaction, evaluation, encryption, commitment publication and commit',
    acquisition_queue_rpc_ms: 0, upstream_requests: 0, cost_usd: 0 }));
  if (p95 >= 150) throw new Error('Cached server p95 target failed');
} finally { await f.close(); }
