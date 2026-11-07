import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditBudgets } from '../check-web-budgets.mjs';
const make = () => [
  { file: 'entry.js', entry: true, modules: ['apps/web/src/main.tsx'], imports: ['shared.js'], dynamicImports: ['shell.js'] },
  { file: 'shared.js', modules: [], imports: [] },
  { file: 'shell.js', modules: ['apps/web/src/TerminalApp.tsx'], imports: ['shared.js'], dynamicImports: ['coin.js', 'feed.js'] },
  { file: 'coin.js', modules: ['apps/web/src/pages/terminal/Coin.tsx'], imports: ['chart.js'] },
  { file: 'chart.js', modules: ['apps/web/src/components/chart/ChartStage.tsx', 'apps/web/src/components/chart/chartCore.ts'], imports: [] },
  { file: 'feed.js', modules: ['apps/web/src/pages/terminal/Feed.tsx'], imports: ['shared.js'] },
];
const small = () => Buffer.from('console.log("fixture");');
// Deterministic incompressible bytes exercise actual gzip accounting, not string length.
function bytes(length) { let state = 1234567; return Buffer.from(Array.from({ length }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; })); }
test('counts static shared transfers once, excludes deferred routes, checks chart ownership', () => {
  const result = auditBudgets(make(), small);
  assert.equal(result.failures.length, 0);
  assert.equal(result.shell, result.landing + result.sizes['shell.js']);
  assert.deepEqual(result.landingChunks, ['entry.js', 'shared.js']);
});
test('rejects all size budgets independently with actual gzip', () => {
  const result = auditBudgets(make(), file => bytes(file === 'entry.js' ? 91_000 : file === 'shell.js' ? 130_000 : file === 'feed.js' ? 81_000 : 10));
  assert.ok(result.failures.some(f => f.startsWith('Landing')));
  assert.ok(result.failures.some(f => f.startsWith('Shell')));
  assert.ok(result.failures.some(f => f.startsWith('feed.js:')));
});
test('rejects transitive wallet/stream leakage and charts in another route', () => {
  const graph = make(); graph[1].modules = ['node_modules/@wagmi/core/index.js', 'apps/web/src/lib/realtime.ts']; graph[5].imports.push('chart.js');
  const failures = auditBudgets(graph, small).failures;
  assert.ok(failures.some(f => f.includes('wallet or stream')));
  assert.ok(failures.some(f => f.includes('non-coin view')));
});
test('does not silently pass an absent or incomplete build', () => { assert.throws(() => auditBudgets([], small), /Incomplete/); });

test('service-worker install cannot prefetch deferred wallet/chart/route JS', () => {
  const result = auditBudgets(make(), small, ['entry.js', 'shared.js', 'shell.js', 'chart.js']);
  assert.ok(result.failures.some(f => f === 'Deferred JS in service-worker precache: chart.js'));
  assert.equal(auditBudgets(make(), small, ['entry.js', 'shared.js', 'shell.js']).failures.length, 0);
});
