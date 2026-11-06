import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const smokeIds = [
  'siwe-entitlements-ws', 'scan-share', 'guarded-quotes', 'mcp-code',
  'mcp-hosted-or-d0', 'receipt-proof', 'pons-fallback-fee', 'delete-harness-data',
  'telegram', 'phone-alert', 'final-team-trade',
];
export const dailyMetrics = [
  'refusals', 'refusalReasons', 'disputedVerdicts', 'uncheckedOrders', 'eligibleOrders',
  'simulationFailures', 'simulationAttempts', 'agents', 'preflights', 'scans', 'bagCards',
  'errors', 'requests', 'spendUsd', 'approvedBudgetUsd', 'labelTruePositive', 'labelFalsePositive',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const p95 = values => Array.isArray(values) && values.length > 0 && values.length <= 10000 &&
  values.every(v => Number.isFinite(v) && v >= 0) ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const combine = states => states.includes('failed') ? 'failed' : states.every(s => s === 'passed') ? 'passed' : 'pending';
const result = (status, reason) => ({ status, reason });
function rejectLinks(base, path) {
  let current = base;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink path refused'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

/** Fixed local JSON artifacts only; no sockets, subprocesses, credentials or raw log output. */
export function readArtifact(base, ref, budget = null) {
  if (!ref || !/^evals\/reports\/[a-zA-Z0-9_.-]+\.json$/.test(ref.path) || !sha(ref.sha256)) throw new Error('Invalid artifact reference');
  let path = base;
  for (const part of ref.path.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symlink artifact refused');
  }
  const size = lstatSync(path).size;
  if (size > 1048576 || budget && size > budget.remaining) throw new Error('Artifact exceeds bounded input size');
  if (budget) budget.remaining -= size;
  const bytes = readFileSync(path);
  if (hash(bytes) !== ref.sha256) throw new Error('Artifact checksum mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

// TODO(spec): Release/daily/smoke evidence has no interchange schema. Use bounded, hashed,
// candidate-bound producer records; these records are not an approval authority or a collector.
export function checkpoint(form, { candidate = null, manifest = null, read = () => { throw new Error(); }, now = new Date().toISOString() } = {}) {
  if (form.schemaVersion !== 1 || !stamp(now)) throw new Error('Invalid checkpoint input');
  const bound = !!candidate && /^[a-f0-9]{40}$/.test(candidate.revision) && sha(candidate.sourceHash) &&
    form.candidate?.revision === candidate.revision && form.candidate?.sourceHash === candidate.sourceHash;
  const checks = {};
  const records = {};
  function record(key, sources) {
    const ref = form.records?.[key];
    if (!ref) { checks[key] = result('pending', 'Missing producer evidence'); return null; }
    if (!bound) { checks[key] = result('pending', 'Current 087 candidate binding unavailable or mismatched'); return null; }
    try {
      const row = read(ref);
      if (row.schemaVersion !== 1 || row.kind !== key || row.candidate?.revision !== candidate.revision ||
        row.candidate?.sourceHash !== candidate.sourceHash || !stamp(row.window?.from) || !stamp(row.window?.to) ||
        Date.parse(row.window.from) >= Date.parse(row.window.to) || Date.parse(row.window.to) > Date.parse(now) ||
        !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) throw new Error();
      if (!sources.includes(row.source)) { checks[key] = result('pending', 'Fixture or unaccepted source'); return null; }
      records[key] = row;
      checks[key] = result('passed', 'Hashed producer record for current candidate');
      return row.data;
    } catch (error) { checks[key] = result(error.code === 'ENOENT' ? 'pending' : 'failed', 'Missing, invalid, stale, oversized or altered producer evidence'); return null; }
  }
  function requireData(key, sources, validate) {
    const data = record(key, sources);
    if (data) {
      try { if (!validate(data)) checks[key] = result('failed', 'Required observation or assertion failed'); }
      catch { checks[key] = result('failed', 'Malformed observation or assertion'); }
    }
    return data;
  }
  function evalGate(gate) {
    const key = `eval${gate}`, ref = form.records?.[key];
    if (!bound || !manifest) return checks[key] = result('pending', 'Integrate 087 and bind the current candidate');
    if (!ref) return checks[key] = result('pending', 'Missing 087 report; do not rerun completed unchanged evidence');
    try {
      const report = read(ref);
      if (report.schemaVersion !== 1 || report.gate !== gate || report.candidate?.revision !== candidate.revision ||
        report.candidate?.sourceHash !== candidate.sourceHash || ![report.configHash, report.fixtureHash, report.datasetHash].every(sha) ||
        !stamp(report.completedAt) || Date.parse(report.completedAt) > Date.parse(now) || !Array.isArray(report.results)) throw new Error();
      const selected = manifest.suites.filter(s => s.gates.includes(gate));
      const states = selected.map(suite => {
        const rows = report.results.filter(r => r.id === suite.id && r.kind === suite.kind);
        if (rows.length !== 1) return 'failed';
        if (suite.id === 'execution-v4' && manifest.v4 === 'quote-only' || suite.id === 'watcher' && !manifest.censusEnabled)
          return rows[0].status === 'skipped' ? 'passed' : 'failed';
        if (suite.kind === 'acceptance' && suite.dependencies.some(d => !manifest.dependencies.merged.includes(d))) return 'pending';
        return ['passed', 'pending', 'failed'].includes(rows[0].status) ? rows[0].status : 'failed';
      });
      if (!selected.length || report.results.some(r => r.status === 'failed')) states.push('failed');
      const status = combine(states);
      checks[key] = result(status === 'passed' && (report.passed !== true || report.exitCode !== 0) ? 'failed' : status,
        'Consumed 087 report and manifest; no eval execution');
    } catch (error) { checks[key] = result(error.code === 'ENOENT' ? 'pending' : 'failed', 'Missing, invalid, incomplete or stale 087 report'); }
    return checks[key];
  }
  evalGate('B'); evalGate('T');
  function decision(key, role, earliest = null) {
    const data = requireData(key, ['approval'], d => d.decision === 'go' && d.role === role && stamp(d.signedAt) &&
      Date.parse(d.signedAt) <= Date.parse(records[key].window.to) && Date.parse(d.signedAt) >= Date.parse(records[key].window.from) &&
      (!earliest || Date.parse(d.signedAt) >= Date.parse(earliest)));
    return data;
  }
  decision('decisionB', 'Dev A', '2026-10-06T00:00:00Z');
  decision('decisionT', 'Owner', '2026-10-12T17:00:00Z');
  decision('guardVetoClear', 'Dev A');
  for (const key of smokeIds) requireData(key, key === 'final-team-trade' ? ['live'] : ['staging', 'live'], d => d.status === 'passed' &&
    (key !== 'mcp-hosted-or-d0' || ['accepted-hosted', 'cut-to-d0'].includes(d.disposition)));
  requireData('rollback', ['staging', 'live'], d => Number.isFinite(d.seconds) && d.seconds >= 0 && d.seconds < 600 &&
    d.previousImageRetained === true && d.schemaCompatible === true && d.ledgersPreserved === true &&
    d.readinessPassed === true && d.tradingLive === false && d.liveTradingEnabled === false);
  const incidents = requireData('incidents', ['live', 'staging'], d => count(d.openSev1) && count(d.openSev2) && count(d.sev1SinceLaunch) &&
    d.openSev1 === 0 && d.openSev2 === 0);
  const beta = record('betaDaily', ['live']);
  let summary = null, miss = false;
  if (beta) {
    const rows = beta.orders;
    let replayPending = false;
    const valid = beta.coverageComplete === true && count(beta.confirmedOrders) && Array.isArray(rows) && rows.length <= 10000 && rows.length === beta.confirmedOrders &&
      new Set(rows.map(r => r.orderId)).size === rows.length && rows.every(r =>
        /^[a-f0-9-]{36}$/.test(r.orderId) && /^0x[a-f0-9]{64}$/.test(r.txHash) && /^0x[a-f0-9]{64}$/.test(r.blockHash) &&
        /^[0-9]+$/.test(r.actualAmount) && ['passed', 'failed', 'pending', 'unavailable'].includes(r.sellCheck) && sha(r.evidence?.sha256) && (() => {
          try {
            const e = read(r.evidence);
            return e.orderId === r.orderId && e.txHash === r.txHash && e.blockHash === r.blockHash &&
              e.amount === r.actualAmount && e.status === r.sellCheck &&
              (['passed', 'failed'].includes(r.sellCheck) ? e.origin === 'measured' : true);
          } catch (error) { if (error.code === 'ENOENT') replayPending = true; return false; }
        })());
    // A measured miss remains red even when another row or metric is incomplete.
    miss = Array.isArray(rows) && rows.some(r => r.sellCheck === 'failed');
    const scan = p95(beta.scanMs), verdict = p95(beta.verdictMs), preflight = p95(beta.preflightMs);
    const m = beta.metrics ?? {};
    const metricsComplete = dailyMetrics.every(k => k === 'refusalReasons'
      ? m[k] && Object.keys(m[k]).length <= 100 && Object.keys(m[k]).every(code => /^[a-z_]{1,64}$/.test(code)) && Object.values(m[k]).every(count) && Object.values(m[k]).reduce((a, b) => a + b, 0) === m.refusals
      : ['spendUsd', 'approvedBudgetUsd'].includes(k) ? Number.isFinite(m[k]) && m[k] >= 0 : count(m[k]));
    const denominators = metricsComplete && m.requests > 0 && m.errors <= m.requests && m.uncheckedOrders <= m.eligibleOrders &&
      m.simulationFailures <= m.simulationAttempts && beta.scanEligible === beta.scanMs?.length &&
      beta.verdictEligible === beta.verdictMs?.length && beta.preflightEligible === beta.preflightMs?.length && beta.preflightEligible === m.preflights;
    const pendingSell = valid ? rows.filter(r => ['pending', 'unavailable'].includes(r.sellCheck)).length : null;
    const incomplete = beta.coverageComplete !== true || beta.confirmedOrders == null || !Array.isArray(rows) || replayPending;
    checks.betaDaily = result(miss || !valid && !incomplete || metricsComplete && (!denominators || m.spendUsd > m.approvedBudgetUsd) ||
      scan !== null && scan > 5000 || preflight !== null && preflight >= 150 ? 'failed' :
      valid && metricsComplete && denominators && rows.length > 0 && pendingSell === 0 && scan !== null && verdict !== null && preflight !== null ? 'passed' : 'pending',
      'Complete confirmed-fill cohort and daily metrics; missing observations cannot become zero misses');
    summary = { confirmedOrders: valid ? rows.length : null, honeypotFills: valid && miss ? rows.filter(r => r.sellCheck === 'failed').length : valid && pendingSell === 0 && rows.length > 0 ? 0 : null,
      pendingSellChecks: pendingSell, scanP95Ms: scan, verdictP95Ms: verdict, preflightP95Ms: preflight,
      errorRate: denominators ? m.errors / m.requests : null, spendUsd: metricsComplete ? m.spendUsd : null,
      labelPrecision: metricsComplete && m.labelTruePositive + m.labelFalsePositive > 0 ? m.labelTruePositive / (m.labelTruePositive + m.labelFalsePositive) : null };
  }
  requireData('stopVerification', ['live', 'staging'], d => d.tradingLive === false && d.liveEnabled === false && d.ordersRefused === true &&
    (d.flagPathDoubt !== true || d.liveTradingEnabled === false));
  const launch = requireData('publicLaunch', ['live'], d => stamp(d.startedAt) && Date.parse(d.startedAt) <= Date.parse(records.publicLaunch.window.to) &&
    Date.parse(d.startedAt) >= Date.parse('2026-10-13T16:00:00Z'));
  const coverage = requireData('onCall', ['approval'], d => Array.isArray(d.shifts) && d.shifts.length > 0 && d.shifts.length <= 100 &&
    d.shifts.every(s => ['Dev A', 'Dev B'].includes(s.role) && s.reachable === true && stamp(s.from) && stamp(s.to) && Date.parse(s.from) < Date.parse(s.to)));
  if (coverage && checks.onCall.status === 'passed') {
    const start = Date.parse(launch?.startedAt ?? '2026-10-13T16:00:00Z'), end = start + 72 * 3600000;
    const points = [...new Set([start, end, ...coverage.shifts.flatMap(s => [Date.parse(s.from), Date.parse(s.to)]).filter(t => t > start && t < end)])].sort((a, b) => a - b);
    if (points.slice(0, -1).some(t => new Set(coverage.shifts.filter(s => Date.parse(s.from) <= t && Date.parse(s.to) > t).map(s => s.role)).size < 2))
      checks.onCall = result('failed', 'Two reachable roles required continuously for T through T+72h');
  }
  decision('decisionProduct', 'Owner', '2026-10-13T12:00:00Z');
  const capDecision = decision('decisionCapIncrease', 'Owner');
  const observationStart = launch?.startedAt, observationEnd = records.betaDaily?.window.to;
  const elapsed72h = !!observationStart && !!observationEnd && Date.parse(records.betaDaily.window.from) <= Date.parse(observationStart) &&
    Date.parse(observationEnd) - Date.parse(observationStart) >= 72 * 3600000;
  const capWindowCovered = elapsed72h && records.incidents && Date.parse(records.incidents.window.from) <= Date.parse(observationStart) &&
    Date.parse(records.incidents.window.to) >= Date.parse(observationEnd);
  const gateB = combine([checks.evalB.status, checks.decisionB.status]);
  const gateT = combine([gateB, checks.evalT.status, checks.decisionT.status, checks.guardVetoClear.status, checks.betaDaily.status, miss ? 'failed' : 'passed']);
  const product = combine([gateT, ...smokeIds.map(k => checks[k].status), checks.rollback.status, checks.incidents.status, checks.onCall.status, checks.decisionProduct.status,
    Date.parse(now) >= Date.parse('2026-10-13T16:00:00Z') ? 'passed' : 'pending']);
  const capIncrease = combine([product, checks.publicLaunch.status, checks.decisionCapIncrease.status,
    capWindowCovered ? 'passed' : 'pending', incidents?.sev1SinceLaunch === 0 ? 'passed' : incidents ? 'failed' : 'pending',
    capDecision && observationEnd && Date.parse(capDecision.signedAt) >= Date.parse(observationEnd) ? 'passed' : 'pending']);
  return { schemaVersion: 1, candidate: candidate ? { revision: candidate.revision, sourceHash: candidate.sourceHash } : null,
    bound, checkedAt: now, checks, summary, gates: { B: gateB, T: gateT, product, capIncrease, D0: 'pending' },
    goNoGo: product === 'passed' ? 'go recorded; external release authorization still required' : 'no-go',
    elapsed72h, ownerCapSignOff: checks.decisionCapIncrease.status, tradingMustBeOff: miss,
    stop: miss ? { required: true, verified: checks.stopVerification.status === 'passed', command: ['pnpm', 'ops', 'guard_miss'],
      note: '076 commits the stop atomically; this command only prepares the existing incident action. No restart.' } : null,
    nextExternalStep: product === 'passed' ? 'Lead review and separately authorized release' : 'Integrate 087 and acquire missing owning-packet evidence; keep rollout unavailable',
    providerRequests: 0, actualCostUsd: 0, state: 'prepared locally; no deployment or approval issued',
    exitCode: product === 'passed' ? 0 : 1 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' ||
    !/^(?:docs\/operations\/release-checkpoint|evals\/reports)\/[a-zA-Z0-9_.-]+\.json$/.test(args[1]) ||
    !/^evals\/reports\/088-[a-zA-Z0-9_.-]+\.json$/.test(args[3]) || args[1] === args[3]) throw new Error();
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  rejectLinks(base, args[1]); rejectLinks(base, args[3]);
  const formPath = join(base, args[1]);
  if (lstatSync(formPath).isSymbolicLink() || lstatSync(formPath).size > 1048576) throw new Error();
  const form = JSON.parse(readFileSync(formPath, 'utf8'));
  let candidate = null, manifest = null;
  // Consume the integrated 087 API; never copy its runner or rerun suites for a status report.
  if (lstatExists(join(base, 'evals/runner.mjs'))) {
    const runner = await import(pathToFileURL(join(base, 'evals/runner.mjs')).href);
    candidate = runner.candidateSnapshot(base);
    manifest = JSON.parse(readFileSync(join(base, 'evals/manifest.json'), 'utf8'));
  }
  const budget = { remaining: 16 * 1048576 }, cache = new Map();
  const report = checkpoint(form, { candidate, manifest, read: ref => {
    const key = JSON.stringify(ref);
    if (!cache.has(key)) cache.set(key, readArtifact(base, ref, budget));
    return cache.get(key);
  } });
  // Output is excluded by 087's existing candidate manifest. Never overwrite prior evidence.
  mkdirSync(join(base, 'evals/reports'), { recursive: true });
  writeFileSync(join(base, args[3]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ gates: report.gates, bound: report.bound, tradingMustBeOff: report.tradingMustBeOff, exitCode: report.exitCode }));
  process.exitCode = report.exitCode;
}
function lstatExists(path) { try { return lstatSync(path).isFile(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Checkpoint refused: invalid local input, runner, artifact or output.'); process.exitCode = 1;
});
