import { launchMetricNames, writeLaunchMeasurement, type SqlClient } from '@eko/db';
import { z } from 'zod';

// Finite metric names are the entire label space. No arbitrary labels or text enter this store.
export const MeasurementSchema = z.strictObject({
  metric: z.enum(launchMetricNames),
  value: z.number().finite().nonnegative(),
}).superRefine((v, ctx) => {
  if ((v.metric.startsWith('role_') || ['simulation_failure', 'backup_success'].includes(v.metric)) && v.value !== 0 && v.value !== 1)
    ctx.addIssue({ code: 'custom', message: 'Binary measurement required', path: ['value'] });
});
export type Measurement = z.infer<typeof MeasurementSchema>;
export type Metric = Measurement['metric'];
export const metricNames = MeasurementSchema.shape.metric.options;
type Sample = { value: number; at: number };
type Row = { metric: Metric; samples: Sample[]; updated_at: number };
export type Check = { state: 'healthy' | 'unhealthy' | 'unavailable' | 'inactive'; value: number | null };
const latency = new Set<Metric>(['head_lag_ms', 'queue_completion_ms', 'pair_to_complete_verdict_ms', 'quote_ms', 'preflight_ms', 'receipt_commit_lag_s']);
export const checkNames = ['api', 'indexer', 'engines', 'mcp', 'oauth', 'guard', 'scan', 'telegram', 'x', 'farcaster', 'receipts', 'head', 'indexer_lag', 'queue', 'quote', 'preflight', 'simulation', 'backup', 'daily_burn'] as const;
/**
 * Head lag that is an incident, not a latency miss: the index is stale, so the live sell check (fresh
 * ETH/USD from indexed swaps) refuses every buy. A stalled indexer keeps raising this measurement:
 * `collect()` derives it from the newest indexed block and the indexer's watchdog reports it each minute.
 */
export const headLagIncidentMs = 600_000;
export type CheckName = typeof checkNames[number];

export class LaunchMonitor {
  /**
   * Retain measurement SQL and clock. Host-only construction; no measurements are collected and no
   * ingestion authorization occurs here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(private sql: SqlClient, private now: () => number = Date.now) {}
  // Missing rows remain missing. These reads never call a chain provider.
  /**
   * Record API activity and derive head/receipt heartbeat/anchor timestamps from persisted rows,
   * deleting absent measurements. Host/public scrape caller, no chain provider or wallet auth; SQL
   * failures reject rather than inventing samples.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async collect() {
    await this.record({ metric: 'role_api', value: 1 });
    const head = (await this.sql.query<{ timestamp: string }>('SELECT EXTRACT(EPOCH FROM ts) AS timestamp FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0];
    if (head) await this.record({ metric: 'head_lag_ms', value: Math.max(0, this.now() - Number(head.timestamp) * 1000) });
    else await this.sql.query('DELETE FROM launch_measurements WHERE metric=$1', ['head_lag_ms']);
    const lease = (await this.sql.query<{ owner: string; age: string }>("SELECT owner,EXTRACT(EPOCH FROM clock_timestamp()-heartbeat_at) AS age FROM receipt_worker_lease WHERE owner<>''")).rows[0];
    if (lease) await this.record({ metric: 'role_receipts', value: Number(lease.age) <= 90 ? 1 : 0 });
    else await this.sql.query('DELETE FROM launch_measurements WHERE metric=$1', ['role_receipts']);
    const anchor = (await this.sql.query<{ at: string }>(`SELECT EXTRACT(EPOCH FROM a.recorded_at) AS at FROM receipt_commit_anchors a
      WHERE NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned')
      ORDER BY a.recorded_at DESC LIMIT 1`)).rows[0];
    if (anchor) await this.record({ metric: 'receipt_commit_timestamp_s', value: Number(anchor.at) });
    else await this.sql.query('DELETE FROM launch_measurements WHERE metric=$1', ['receipt_commit_timestamp_s']);
  }
  /**
   * Validate finite nonnegative measurements with binary constraints, then persist a clocked bounded
   * sample. Caller must authorize manual ingestion; this method itself has no admin check.
   * Schema/SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async record(input: Measurement) {
    const measurement = MeasurementSchema.parse(input);
    const at = this.now();
    await writeLaunchMeasurement(this.sql, measurement.metric, measurement.value, at);
  }
  /**
   * Project retained finite metrics with expiry, p95 latency, failure ratios or latest values.
   * Public operational read without auth; future/expired/missing samples yield unavailable and SQL
   * failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async snapshot(): Promise<Partial<Record<Metric, Check>>> {
    const rows = (await this.sql.query<Row>('SELECT metric,samples,updated_at FROM launch_measurements')).rows;
    const result: Partial<Record<Metric, Check>> = {};
    for (const row of rows) {
      if (!metricNames.includes(row.metric)) continue;
      // TODO(spec): Collector expiry cadence is unspecified; use conservative ops defaults.
      const ttl = row.metric === 'backup_success' ? 26 * 3600_000 : row.metric.startsWith('role_') ? 90_000 : 300_000;
      const age = this.now() - Number(row.updated_at);
      const window = row.samples.filter(s => s.at <= this.now() && this.now() - s.at <= ttl);
      if (age < 0 || age > ttl || !window.length) { result[row.metric] = { state: 'unavailable', value: null }; continue; }
      const values = window.map(s => s.value).sort((a, b) => a - b);
      const value = row.metric === 'simulation_failure' ? values.reduce((n, v) => n + v, 0) / values.length
        : latency.has(row.metric) ? values[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)]!
        : window.reduce((latest, sample) => sample.at >= latest.at ? sample : latest).value;
      result[row.metric] = { state: 'healthy', value };
    }
    return result;
  }
  /**
   * Combine fresh measurements into named operational checks with configured thresholds and explicit
   * inactive phase-dependent checks. Public operational read without auth; missing metrics stay
   * unavailable and SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async checks(burnActive: boolean, summonsActive = false): Promise<Record<CheckName, Check>> {
    const s = await this.snapshot();
    const limit = (metric: Metric, max: number, age = false, inclusive = true): Check => {
      const m = s[metric];
      if (!m || m.value === null) return { state: 'unavailable', value: null };
      const value = age ? this.now() / 1000 - m.value : m.value;
      return { state: value >= 0 && (inclusive ? value <= max : value < max) ? 'healthy' : 'unhealthy', value };
    };
    const role = (name: string): Check => {
      const m = s[`role_${name}` as Metric];
      return !m || m.value === null ? { state: 'unavailable', value: null }
        : { state: m.value === 1 ? 'healthy' : 'unhealthy', value: m.value };
    };
    const combine = (...checks: Check[]): Check => checks.find(c => c.state === 'unhealthy') ?? checks.find(c => c.state === 'unavailable') ?? checks[checks.length - 1]!;
    let burn: Check = { state: 'inactive', value: null };
    if (burnActive) {
      const due = s.burn_due_timestamp_s?.value;
      const confirmed = s.burn_confirmed_timestamp_s?.value;
      burn = due == null || confirmed == null ? { state: 'unavailable', value: null }
        : { state: confirmed >= due || this.now() / 1000 - due <= 3600 ? 'healthy' : 'unhealthy', value: Math.max(0, this.now() / 1000 - due) };
    }
    // TODO(spec): Farcaster has no runtime flag; require its heartbeat at token phase.
    const receipt = combine(role('receipts'), limit('receipt_commit_timestamp_s', 600, true, false));
    return { api: role('api'), indexer: role('indexer'), engines: role('engines'), mcp: role('mcp'), oauth: role('oauth'),
      guard: combine(role('guard'), limit('simulation_failure', .05)), scan: combine(role('scan'), limit('pair_to_complete_verdict_ms', 5000)),
      telegram: role('telegram'), x: summonsActive ? role('x') : { state: 'inactive', value: null }, farcaster: burnActive ? role('farcaster') : { state: 'inactive', value: null },
      receipts: receipt, head: combine(role('indexer'), limit('head_lag_ms', 5000)), indexer_lag: limit('head_lag_ms', headLagIncidentMs), queue: combine(role('engines'), limit('queue_completion_ms', Infinity)),
      quote: limit('quote_ms', 1500), preflight: limit('preflight_ms', 150, false, false), simulation: limit('simulation_failure', .05),
      backup: (() => { const m = s.backup_success; return !m || m.value === null ? { state: 'unavailable', value: null } : { state: m.value === 1 ? 'healthy' : 'unhealthy', value: m.value }; })(), daily_burn: burn };
  }
  /**
   * Render finite metric/check labels and read durable trading switch and action counts at scrape
   * time. Public operational read without auth; SQL failures reject. The trading gauge is the
   * durable flag only, not the host ceiling or live delivery evidence.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async prometheus(burnActive: boolean, summonsActive = false) {
    const snapshot = await this.snapshot();
    const checks = await this.checks(burnActive, summonsActive);
    const rows = (await this.sql.query<Row>('SELECT metric,samples,updated_at FROM launch_measurements')).rows;
    const lines = ['# TYPE eko_measurement_samples gauge', '# TYPE eko_measurement_available gauge', '# TYPE eko_launch_value gauge', '# TYPE eko_check_available gauge', '# TYPE eko_check_healthy gauge', '# TYPE eko_check_active gauge'];
    for (const metric of metricNames) {
      const m = snapshot[metric];
      const count = rows.find(row => row.metric === metric)?.samples.filter(sample => this.now() - sample.at <= 300_000 && sample.at <= this.now()).length ?? 0;
      lines.push(`eko_measurement_samples{metric="${metric}"} ${count}`);
      lines.push(`eko_measurement_available{metric="${metric}"} ${m?.value != null ? 1 : 0}`);
      if (m?.value != null) lines.push(`eko_launch_value{metric="${metric}"} ${m.value}`);
    }
    for (const [check, value] of Object.entries(checks)) {
      lines.push(`eko_check_available{check="${check}"} ${value.state === 'unavailable' ? 0 : 1}`);
      lines.push(`eko_check_active{check="${check}"} ${value.state === 'inactive' ? 0 : 1}`);
      lines.push(`eko_check_healthy{check="${check}"} ${value.state === 'healthy' || value.state === 'inactive' ? 1 : 0}`);
    }
    // Read durable controls at scrape time; no cached flags, wallet labels or incident payloads.
    const trading = (await this.sql.query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key='trading_live'")).rows[0];
    lines.push('# TYPE eko_trading_live gauge', `eko_trading_live ${trading?.enabled ? 1 : 0}`);
    const actions = (await this.sql.query<{ action: string; count: string }>(`SELECT action,COUNT(*) AS count FROM audit_log
      WHERE action IN ('trading.live_changed','ops.incident') GROUP BY action`)).rows;
    lines.push('# TYPE eko_trading_live_changes_total counter', '# TYPE eko_incidents_total counter');
    lines.push(`eko_trading_live_changes_total ${actions.find(row => row.action === 'trading.live_changed')?.count ?? 0}`);
    lines.push(`eko_incidents_total ${actions.find(row => row.action === 'ops.incident')?.count ?? 0}`);
    return lines.join('\n') + '\n';
  }
}
