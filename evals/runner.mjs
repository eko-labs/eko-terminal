import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanLatencyReport } from '../scripts/scan-latency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const classes = ['honeypot', 'tax-trap', 'hook', 'fee-trap', 'clone', 'wash', 'clean-v3', 'clean-v4', 'clean-pons'];
export const digest = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => digest(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function localPath(base, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Repository-relative path required');
  const full = resolve(base, path);
  let current = base;
  for (const part of relative(base, full).split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink evidence forbidden');
  }
  return full;
}

/** Content-address the actual worktree, including uncommitted packet source, without retaining home paths or git identities. */
export function candidateSnapshot(base = root) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim();
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: base, encoding: 'utf8' }).split('\0').filter(Boolean))]
    .filter(path => !path.startsWith('evals/reports/') && path !== 'docs/tasks/087-launch-eval-runner-report.md').sort();
  const entries = files.map(path => {
    try { return { path, sha256: digest(readFileSync(localPath(base, path))) }; }
    catch (error) { if (error.code === 'ENOENT') return { path, deleted: true }; throw error; }
  });
  return { revision, sourceHash: hashJson(entries), files: entries };
}

/** Only evidence-backed labels count. Multiple classes/pins of one coin never inflate the distinct coin denominator. */
export function labelInventory(input, base) {
  if (input.schemaVersion !== 1 || !Array.isArray(input.coins)) throw new Error('Invalid label inventory');
  const byClass = Object.fromEntries(classes.map(c => [c, 0])), seen = new Set(), rejected = [];
  for (const [index, row] of input.coins.entries()) {
    const key = `${row.chainId}:${String(row.coin).toLowerCase()}`;
    let valid = row.chainId === 4663 && /^0x[a-fA-F0-9]{40}$/.test(row.coin) &&
      /^[1-9][0-9]*$/.test(row.blockNumber) && /^0x[a-fA-F0-9]{64}$/.test(row.blockHash) &&
      classes.includes(row.class) && row.source === 'observed' && row.labelVersion &&
      Array.isArray(row.evidence) && row.evidence.length > 0;
    if (valid) {
      try { valid = row.evidence.every(e => sha(e.sha256) && digest(readFileSync(localPath(base, e.path))) === e.sha256); }
      catch { valid = false; }
    }
    if (!valid || seen.has(key)) { rejected.push(index); continue; }
    seen.add(key); byClass[row.class]++;
  }
  return { total: seen.size, required: 200, byClass, missingClasses: classes.filter(c => byClass[c] === 0), rejected,
    passed: seen.size >= 200 && rejected.length === 0 && classes.every(c => byClass[c] > 0) };
}

function perfect(m) {
  return positive(m.total) && m.passed === m.total && m.failed === 0 && m.skipped === 0 && m.missing === 0;
}
function precision(m) {
  return nonnegative(m.truePositive) && nonnegative(m.falsePositive) && m.truePositive + m.falsePositive > 0 &&
    m.truePositive / (m.truePositive + m.falsePositive) >= .9 && m.regressions === 0 && m.missing === 0;
}
export function passBar(suite, evidence, inventory, candidate) {
  const m = evidence.metrics ?? {};
  switch (suite.bar) {
    case 'perfect': return perfect(m);
    case 'truth': return perfect(m) && inventory.passed;
    case 'precision': return precision(m);
    case 'injection': return perfect(m) && m.regressions === 0 && m.untrustedLeaks === 0 &&
      Number.isFinite(m.baitDetectionRate) && m.baitDetectionRate >= 0 && m.baitDetectionRate <= 1 &&
      Number.isFinite(m.swarmSteerRate) && m.swarmSteerRate >= 0 && m.swarmSteerRate <= 1;
    case 'fills': {
      const rows = evidence.observations;
      if (!positive(m.observedOrders) || m.classifiedOrders !== m.observedOrders || m.honeypotFills !== 0 || m.missing !== 0 ||
        !Array.isArray(rows) || rows.length !== m.observedOrders || new Set(rows.map(r => r.orderId)).size !== rows.length) return false;
      return rows.every(r => typeof r.orderId === 'string' && r.orderId.length > 0 &&
        ['honeypot', 'clean'].includes(r.label) && ['filled', 'refused'].includes(r.outcome) &&
        !(r.label === 'honeypot' && r.outcome === 'filled') &&
        (r.outcome !== 'filled' || (/^0x[a-f0-9]{64}$/.test(r.txHash) && /^0x[a-f0-9]{64}$/.test(r.blockHash))));
    }
    case 'latency': {
      const scan = scanLatencyReport(evidence.scanCohort, candidate.revision);
      return scan.passed && positive(m.preflightEligible) && Array.isArray(m.preflightMs) &&
        m.preflightMs.length === m.preflightEligible && m.preflightMs.every(n => Number.isFinite(n) && n >= 0) &&
        [...m.preflightMs].sort((a, b) => a - b)[Math.ceil(.95 * m.preflightEligible) - 1] < 150;
    }
    // TODO(spec): 061–063 have no machine-readable report schema yet. Consume their owned gate table unchanged
    // via this envelope; their producer must supply ALL required gate rows and their denominator checks.
    case 'guard': return sha(evidence.upstream?.datasetHash) && sha(evidence.upstream?.labelHash) && sha(evidence.upstream?.configHash) && evidence.packet === ({ 'guard-locked': '061', 'guard-shadow': '062', 'guard-cutover': '063' })[suite.id] &&
      evidence.accepted === true && evidence.complete === true && evidence.denominatorsVerified === true &&
      Array.isArray(evidence.gates) && evidence.gates.length > 0 && evidence.gates.every(g => g.status === 'passed');
    default: return false;
  }
}

export function acceptanceResult(suite, manifest, evidence, context) {
  const pending = suite.dependencies.filter(d => !manifest.dependencies.merged.includes(d));
  if (pending.length) return { status: 'pending', reason: 'Packet dependencies not merged', dependencies: pending };
  if (!evidence) return { status: 'pending', reason: 'Missing measured acceptance evidence' };
  try {
    if (evidence.candidate !== context.candidate.revision || evidence.sourceHash !== context.candidate.sourceHash ||
      evidence.configHash !== context.configHash || evidence.fixtureHash !== context.fixtureHash || evidence.datasetHash !== context.datasetHash ||
      evidence.source !== suite.source || !sha(evidence.datasetHash) || !Array.isArray(evidence.commands) || !evidence.commands.length ||
      evidence.commands.some(c => !Array.isArray(c.argv) || !c.argv.length || !c.argv.every(a => typeof a === 'string' && /^[\w./:@=-]+$/.test(a) && !isAbsolute(a) && !a.includes('..') && !a.includes('://')) || c.exitCode !== 0) ||
      !Array.isArray(evidence.artifacts) || !evidence.artifacts.length ||
      !evidence.artifacts.every(a => sha(a.sha256) && digest(readFileSync(localPath(context.base, a.path))) === a.sha256) ||
      !Number.isFinite(Date.parse(evidence.window?.from)) || !Number.isFinite(Date.parse(evidence.window?.to)) ||
      Date.parse(evidence.window.from) >= Date.parse(evidence.window.to)) throw new Error('Invalid provenance');
    return { status: passBar(suite, evidence, context.inventory, context.candidate) ? 'passed' : 'failed',
      reason: 'Measured evidence evaluated against spec pass bar', commands: evidence.commands,
      evidenceHash: hashJson(evidence), artifacts: evidence.artifacts.map(a => ({ sha256: a.sha256 })),
      upstream: suite.bar === 'guard' ? evidence.upstream : undefined,
      metrics: Object.fromEntries(['total', 'passed', 'failed', 'skipped', 'missing', 'truePositive', 'falsePositive',
        'regressions', 'untrustedLeaks', 'baitDetectionRate', 'swarmSteerRate', 'observedOrders', 'classifiedOrders',
        'honeypotFills', 'preflightEligible'].filter(k => typeof evidence.metrics?.[k] === 'number').map(k => [k, evidence.metrics[k]])) };
  } catch { return { status: 'failed', reason: 'Invalid, stale, incomplete or mismatched acceptance evidence' }; }
}

/** Capture only aggregate counts. Raw tool output can contain paths or secret-bearing provider errors. */
export async function runFixture(suite, base = root) {
  const temporary = mkdtempSync(join(tmpdir(), 'eko-launch-eval-'));
  const output = join(temporary, 'results.json');
  const argv = [...suite.command, '--reporter=json', `--outputFile=${output}`];
  try {
    const execution = await new Promise(done => {
      const child = spawn(argv[0], argv.slice(1), { cwd: base, env: { ...process.env, VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '2' }, stdio: 'ignore', shell: false });
      child.once('error', () => done({ exitCode: 1, signal: null }));
      child.once('close', (code, signal) => done({ exitCode: code ?? 1, signal }));
    });
    let counts = null;
    try {
      const r = readJson(output);
      counts = { total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests,
        skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0),
        missing: (suite.inputs ?? []).filter(path => !(r.testResults ?? []).some(t => t.name.replaceAll('\\', '/').endsWith('/' + path.split('/').slice(2).join('/')))).length };
    } catch { /* Missing output fails even when a command exits zero. */ }
    return { command: [...suite.command, '--reporter=json', '--outputFile=<temporary-results>'], ...execution, counts,
      status: execution.exitCode === 0 && counts && perfect(counts) ? 'passed' : 'failed', evidence: 'fixture-only' };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function evaluate({ manifest, gate, candidate, inventory, evidence = {}, configHash, fixtureHash, datasetHash, base = root, execute = runFixture, onResult = () => {} }) {
  if (!['B', 'T'].includes(gate) || manifest.schemaVersion !== 1 || !['quote-only', 'executable'].includes(manifest.v4)) throw new Error('Invalid stage/configuration');
  // This packet has no provider client and cannot turn an application schedule into a paid generation run.
  if (manifest.dependencies.merged.some(d => manifest.dependencies.pending.includes(d))) throw new Error('Conflicting dependency state');
  if (manifest.generation.enabled || manifest.generation.approvedBudgetUsd !== 0) throw new Error('Provider generation requires a separately authorized budgeted producer');
  const required = gate === 'B'
    ? ['normalizer', 'execution', 'receipts', 'guard-locked', 'guard-shadow', 'guard-cutover', 'staging', 'backfill', 'policies', 'restore']
    : ['normalizer', 'execution', 'receipts', 'guard-locked', 'guard-shadow', 'guard-cutover', 'harness', 'injection', 'playbooks', 'latency', 'product', 'honeypot-fills'];
  if (new Set(manifest.suites.map(s => s.id)).size !== manifest.suites.length || required.some(id =>
    !manifest.suites.some(s => s.id === id && s.kind === 'acceptance' && s.gates.includes(gate)))) throw new Error('Required stage acceptance suite omitted');
  const results = [];
  for (const suite of manifest.suites) {
    let result;
    if (!suite.gates.includes(gate)) result = { status: 'skipped', reason: 'Outside selected stage' };
    else if (suite.id === 'watcher' && !manifest.censusEnabled) result = { status: 'skipped', reason: 'Separate Census gate; headlines unavailable' };
    else if (suite.id === 'execution-v4' && manifest.v4 === 'quote-only') result = { status: 'skipped', reason: 'Quote-only v4; executable route unavailable' };
    else if (suite.kind === 'fixture') {
      try { result = await execute(suite, base); }
      catch { result = { status: 'failed', exitCode: 1, reason: 'Fixture runner failure' }; }
    } else result = acceptanceResult(suite, manifest, evidence[suite.id], { candidate, configHash, fixtureHash, datasetHash, inventory, base });
    const row = { id: suite.id, kind: suite.kind, bar: suite.bar ?? '100% fixtures', ...result };
    results.push(row); onResult(row);
  }
  const passed = results.every(r => r.status === 'passed' || r.status === 'skipped');
  return { schemaVersion: 1, gate, candidate, configHash, fixtureHash, datasetHash, inventory,
    providerRequests: 0, actualCostUsd: 0, results, passed, exitCode: passed ? 0 : 1,
    state: 'evaluated locally; no release authorization', completedAt: new Date().toISOString() };
}

function markdown(report) {
  return `# Gate ${report.gate} launch eval\n\nCandidate: \`${report.candidate.revision}\`; worktree SHA-256: \`${report.candidate.sourceHash}\`.\n\n` +
    `Result: **${report.passed ? 'passed' : 'red'}**, exit ${report.exitCode}. Fixture results do not certify measured launch acceptance.\n\n` +
    `Config: \`${report.configHash}\`; fixtures: \`${report.fixtureHash}\`; dataset: \`${report.datasetHash}\`.\n\n` +
    `Labeled observed coins: ${report.inventory.total}/200. Missing classes: ${report.inventory.missingClasses.join(', ') || 'none'}. Provider requests: 0; cost: $0.\n\n` +
    '| Suite | Evidence | Status | Reason |\n|---|---|---|---|\n' + report.results.map(r => `| ${r.id} | ${r.kind} | ${r.status} | ${r.reason ?? '100% fixture pass bar'} |`).join('\n') + '\n\nExact commands, exit codes, counts and hashes are retained in the adjacent JSON report.\n';
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--gate', '--report', '--evidence'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid invocation');
    options[args[i]] = args[i + 1];
  }
  const gate = options['--gate'];
  if (!['B', 'T'].includes(gate)) throw new Error('Select --gate B or --gate T');
  const manifest = readJson(join(root, 'evals/manifest.json'));
  const labels = readJson(localPath(root, manifest.labels));
  const candidate = candidateSnapshot();
  const fixtureFiles = candidate.files.filter(f => /(?:^|\/)(?:test|tests|fixtures|__fixtures__|mocks)\//.test(f.path) || /\.(?:test|spec)\./.test(f.path));
  const evidence = options['--evidence'] ? readJson(localPath(root, options['--evidence'])) : {};
  const reportPath = options['--report'] ?? `evals/reports/${new Date().toISOString().replaceAll(':', '-')}-${gate}.md`;
  if (!/^evals\/reports\/[a-zA-Z0-9_.-]+\.md$/.test(reportPath)) throw new Error('Reports must use evals/reports/<name>.md');
  const save = report => {
    mkdirSync(join(root, 'evals/reports'), { recursive: true });
    writeFileSync(join(root, reportPath.replace(/\.md$/, '.json')), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(root, reportPath), markdown(report));
  };
  const context = { manifest, gate, candidate, inventory: labelInventory(labels, root), configHash: hashJson({ manifest, files: candidate.files.filter(f => /(?:config|package\.json|pnpm-lock\.yaml)/.test(f.path)) }),
    fixtureHash: hashJson(fixtureFiles), datasetHash: hashJson(labels) };
  // Red checkpoint exists before executing anything; interrupted jobs never leave a green partial report.
  const checkpoint = { ...context, candidate, passed: false, exitCode: 1, results: [], state: 'running', actualCostUsd: 0, providerRequests: 0 };
  delete checkpoint.manifest;
  save(checkpoint);
  const report = await evaluate({ ...context, evidence, onResult: row => {
    checkpoint.results.push(row); save(checkpoint);
    console.log(`${row.id}: ${row.status}`);
  } });
  const after = candidateSnapshot();
  if (after.sourceHash !== candidate.sourceHash) {
    report.results.push({ id: 'candidate-drift', kind: 'acceptance', status: 'failed', reason: 'Worktree changed during evaluation' });
    report.passed = false; report.exitCode = 1;
  }
  save(report); console.log(`Gate ${gate}: ${report.passed ? 'passed' : 'red'}; ${reportPath}`); process.exitCode = report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Launch eval failed: invalid configuration, evidence or invocation.'); process.exitCode = 1;
});
