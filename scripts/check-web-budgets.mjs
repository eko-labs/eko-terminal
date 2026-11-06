import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function auditBudgets(graph, read, precache) {
  const failures = [], sizes = Object.fromEntries(graph.map(c => [c.file, gzipSync(read(c.file), { level: 9 }).length]));
  const byFile = new Map(graph.map(c => [c.file, c]));
  const closure = (files) => {
    const seen = new Set();
    const visit = file => { if (seen.has(file)) return; const c = byFile.get(file); if (!c) throw new Error(`Missing chunk: ${file}`); seen.add(file); c.imports.forEach(visit); };
    files.forEach(visit); return [...seen];
  };
  const find = module => graph.filter(c => c.modules.some(m => m.endsWith(module))).map(c => c.file);
  const entry = graph.filter(c => c.entry).map(c => c.file);
  if (!entry.length || !find('apps/web/src/TerminalApp.tsx').length || !find('apps/web/src/pages/terminal/Coin.tsx').length) throw new Error('Incomplete build graph');
  const landing = closure(entry), shell = closure([...entry, ...find('apps/web/src/TerminalApp.tsx')]);
  if (precache) {
    for (const file of precache) if (!shell.includes(file)) failures.push(`Deferred JS in service-worker precache: ${file}`);
    for (const file of shell) if (!precache.includes(file)) failures.push(`Shell JS missing from service-worker precache: ${file}`);
  }
  const total = files => files.reduce((n, f) => n + sizes[f], 0);
  const assert = (ok, message) => { if (!ok) failures.push(message); };
  assert(total(landing) <= 90_000, `Landing ${total(landing)} > 90000 gzip bytes`);
  assert(total(shell) <= 220_000, `Shell ${total(shell)} > 220000 gzip bytes`);
  // Every chunk outside the initial shell is budgeted, including shared dependencies and dynamic vendors.
  const routes = graph.filter(c => !shell.includes(c.file));
  for (const c of routes) assert(sizes[c.file] <= 80_000, `${c.file}: ${sizes[c.file]} > 80000 gzip bytes`);
  const modules = files => files.flatMap(f => byFile.get(f).modules);
  assert(!modules(landing).some(m => /node_modules\/(?:wagmi|@wagmi)|apps\/web\/src\/lib\/(?:wallet|trade-wallet|realtime|ws)\./.test(m)), 'Landing includes wallet or stream modules');
  assert(!modules(shell).some(m => /node_modules\/(?:wagmi|@wagmi)|apps\/web\/src\/lib\/(?:wallet|trade-wallet)\./.test(m)), 'Initial public shell includes wallet modules');
  const chart = /apps\/web\/src\/components\/chart\/(?:ChartStage|chartCore)\./;
  assert(modules(closure(find('apps/web/src/pages/terminal/Coin.tsx'))).some(m => chart.test(m)), 'Coin chart missing');
  assert(!modules(shell).some(m => chart.test(m)), 'Chart in initial shell');
  for (const c of graph.filter(c => c.modules.some(m => /apps\/web\/src\/pages\/.*\.tsx$/.test(m)) && !c.modules.some(m => m.endsWith('pages/terminal/Coin.tsx')))) {
    assert(!modules(closure([c.file])).some(m => chart.test(m)), `Chart reachable from non-coin view: ${c.file}`);
  }
  return { units: 'decimal gzip bytes, level 9, each transfer counted once per static import closure', landing: total(landing), shell: total(shell), largestRoute: Math.max(...routes.map(c => sizes[c.file])), sizes, landingChunks: landing, shellChunks: shell, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const built = spawnSync('pnpm', ['--filter', '@eko/web', 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, EKO_SITE: `${root}apps/web/e2e/.artifacts/site-unavailable`, VITE_MOCKS: '0', VITE_API_URL: '/v1', VITE_API_BASE: '/v1', VITE_WS_URL: '' } });
  if (built.status !== 0) { process.stderr.write(built.stderr || built.stdout); process.exit(2); }
  const dist = `${root}apps/web/dist/`;
  const worker = readFileSync(`${dist}sw.js`, 'utf8');
  const precache = JSON.parse(worker.match(/const precache[^=]*= (\[[^;]+\]);/)[1]).filter(file => file.endsWith('.js')).map(file => file.slice(1));
  const result = auditBudgets(JSON.parse(readFileSync(`${dist}budget-graph.json`, 'utf8')), file => readFileSync(dist + file), precache);
  writeFileSync(`${dist}budget-result.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`Web gzip bytes: landing=${result.landing}/90000 shell=${result.shell}/220000 largest route=${result.largestRoute}/80000`);
  result.failures.forEach(f => console.error(f));
  process.exitCode = result.failures.length ? 1 : 0;
}
