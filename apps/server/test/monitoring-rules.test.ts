import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNames, LaunchMonitor, metricNames } from '../src/obs/launch.js';
// @ts-expect-error Repo-local operational script has no TypeScript declaration.
import { validateRules } from '../../../infra/monitoring/validate-rules.mjs';

const catalogue = {
  metrics: ['up', 'eko_launch_value', 'eko_measurement_available', 'eko_check_available', 'eko_check_active', 'eko_check_healthy',
    'eko_trading_live', 'eko_trading_live_changes_total', 'eko_incidents_total'],
  measurements: metricNames, checks: checkNames,
};
const load = async () => JSON.parse(await readFile(new URL('../../../infra/monitoring/launch-alerts.json', import.meta.url), 'utf8'));
describe('offline Prometheus launch rule parsing', () => {
  it('parses all expressions, durations, vector matching and fixed metric/check selectors', async () => {
    const rules = await load();
    const exported = await new LaunchMonitor({ query: async () => ({ rows: [] }) }).prometheus(false);
    for (const name of catalogue.metrics.filter(n => n !== 'up')) expect(exported).toContain(`# TYPE ${name} `);
    expect(validateRules(rules, catalogue)).toBe(rules);
  });
  it.each(['eko_missing_metric > 0', 'eko_launch_value{metric="missing"} > 0',
    'eko_launch_value{metric=~"quote_ms|missing"} > 0', 'increase(eko_incidents_total) > 0',
    'eko_launch_value{metric="quote_ms" > 0', 'time() and eko_trading_live',
    'eko_trading_live >', 'eko_check_active{check="missing"} == 1'])('rejects invalid PromQL %s', async expr => {
    const rules = await load(); rules.groups[0].rules[0].expr = expr;
    expect(() => validateRules(rules, catalogue)).toThrow();
  });
  it('rejects invalid rule structure and duplicate alert names', async () => {
    for (const mutate of [
      (r: any) => { r.groups[0].rules[0].for = 'soon'; },
      (r: any) => { r.groups[0].rules[0].labels.severity = 'unknown'; },
      (r: any) => { r.groups[0].rules.push(r.groups[0].rules[0]); },
    ]) { const rules = await load(); mutate(rules); expect(() => validateRules(rules, catalogue)).toThrow(); }
  });
});

it('renders actual Alertmanager receiver file with placeholder endpoints, protected permissions and exclusive creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eko-receiver-fixture-'));
  const target = join(directory, 'receivers.json');
  const script = fileURLToPath(new URL('../../../infra/monitoring/render-alertmanager.mjs', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [script, target], { env: {
    OPS_ALERT_WEBHOOK_URL: 'https://ops.eko.example/webhook', ONCALL_ALERT_WEBHOOK_URL: 'https://oncall.eko.example/webhook',
  } });
  try {
    const result = await run();
    expect(result.stdout).not.toContain('https://'); expect(result.stderr).toBe('');
    const rendered = JSON.parse(await readFile(target, 'utf8'));
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(rendered)).not.toContain('${');
    const names = rendered.receivers.map((r: { name: string }) => r.name);
    for (const route of [rendered.route, ...rendered.route.routes]) expect(names).toContain(route.receiver);
    expect(rendered.receivers[1].webhook_configs).toEqual([
      { url: 'https://ops.eko.example/webhook', send_resolved: true },
      { url: 'https://oncall.eko.example/webhook', send_resolved: true },
    ]);
    await expect(run()).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(rendered);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
