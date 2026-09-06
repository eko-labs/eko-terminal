import type { SqlClient } from './client.js';

// Shared fixed label space for API and worker collectors. Server migration 0010 must run first.
export const launchMetricNames = ['head_lag_ms', 'queue_completion_ms', 'pair_to_complete_verdict_ms', 'quote_ms', 'preflight_ms',
    'simulation_failure', 'receipt_commit_timestamp_s', 'receipt_commit_lag_s', 'ai_budget_ratio', 'x_budget_ratio',
    'backup_success', 'role_api', 'role_indexer', 'role_engines', 'role_mcp', 'role_oauth', 'role_guard',
    'role_scan', 'role_telegram', 'role_x', 'role_farcaster', 'role_receipts', 'burn_due_timestamp_s',
    'burn_confirmed_timestamp_s', 'post_fill_sell_failure', 'published_wallet_unexpected_outflow', 'burn_wrong_token', 'burn_unexpected_outflow',
    'registry_ownership_started_timestamp_s', 'registry_ownership_transferred_timestamp_s', 'registry_committer_changed_timestamp_s',
    'reference_price_timestamp_s', 'receipt_committer_balance_eth'] as const;
export type LaunchMetric = typeof launchMetricNames[number];
export async function writeLaunchMeasurement(sql: SqlClient, metric: LaunchMetric, value: number, at = Date.now()) {
  if (!launchMetricNames.includes(metric) || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(at) || at < 0)
    throw new Error('Invalid launch measurement');
  await appendSamples(sql, metric, [{ value, at }]);
}

async function appendSamples(sql: SqlClient, metric: LaunchMetric, samples: { value: number; at: number }[]) {
  await sql.query(`INSERT INTO launch_measurements(metric,samples,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(metric) DO UPDATE SET samples=(SELECT jsonb_agg(item ORDER BY n) FROM
      (SELECT item,n FROM jsonb_array_elements(launch_measurements.samples || EXCLUDED.samples)
        WITH ORDINALITY AS entries(item,n) ORDER BY n DESC LIMIT 512) bounded), updated_at=GREATEST(launch_measurements.updated_at,EXCLUDED.updated_at)`,
  [metric, JSON.stringify(samples), samples.at(-1)!.at]);
}

/** Metrics failures never alter the process's work or expose raw database errors. */
export function launchEmitter(sql: SqlClient, unavailable: () => void) {
  let reportedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  const buffers = new Map<LaunchMetric, { value: number; at: number }[]>();
  const suppressed = new Map<LaunchMetric, number>();
  const invalidated = new Set<LaunchMetric>();
  const report = () => { if (Date.now() - reportedAt > 30_000) { reportedAt = Date.now(); unavailable(); } };
  const flush = async () => {
    if (flushing) { await flushing; return flush(); }
    flushing = (async () => {
      const batch = [...buffers]; buffers.clear();
      for (const [metric, samples] of batch) {
        try { await appendSamples(sql, metric, samples); } catch { report(); }
      }
      // A dropped sample invalidates this window rather than biasing its quantile/rate.
      for (const metric of invalidated) {
        try { await sql.query('DELETE FROM launch_measurements WHERE metric=$1', [metric]); } catch { report(); }
      }
      invalidated.clear();
    })();
    try { await flushing; } finally { flushing = undefined; }
  };
  return {
    emit(metric: LaunchMetric, value: number) {
      if (!launchMetricNames.includes(metric) || !Number.isFinite(value) || value < 0) { report(); return; }
      const at = Date.now();
      if ((suppressed.get(metric) ?? 0) > at) return;
      const samples = buffers.get(metric) ?? [];
      if (samples.length >= 512) {
        buffers.delete(metric); suppressed.set(metric, at + 300_000); invalidated.add(metric); report();
      } else { samples.push({ value, at }); buffers.set(metric, samples); }
      if (!timer) {
        timer = setTimeout(() => { timer = undefined; void flush(); }, 100);
        timer.unref();
      }
    },
    drain: async () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      await flush();
      if (buffers.size || invalidated.size) await flush();
    },
  };
}
