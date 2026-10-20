import { CLIENT_METRICS, type Telemetry } from '@eko/shared';
import { and, inArray, like, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { latencySamples } from '../db/schema.js';
import { metrics } from './metrics.js';

// TODO(spec): CA-24/GO-PLAN §14 do not set telemetry retention. Keep 30 days
// of aggregate inputs, never session IDs, build SHAs, client timestamps or error text.
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const telemetryRows = or(like(latencySamples.metric, 'telemetry.%'), like(latencySamples.metric, 'demo.%'), inArray(latencySamples.metric, [...CLIENT_METRICS]));
export class LatencyStore {
  private pending: (typeof latencySamples.$inferInsert)[] = [];
  private writing: Promise<void> = Promise.resolve();
  constructor(private db: Db) {}
  record(metric: string, valueMs: number, labels: Record<string, string>, at: number) {
    this.pending.push({ metric, valueMs, labels, at });
    if (this.pending.length > 5000) this.pending.splice(0, this.pending.length - 5000);
  }
  flush(now = Date.now()): Promise<void> {
    const batch = this.pending.splice(0);
    const write = this.writing.then(async () => {
      if (batch.length) await this.db.insert(latencySamples).values(batch);
      await this.db.delete(latencySamples).where(and(telemetryRows, lt(latencySamples.at, now - TELEMETRY_RETENTION_MS)));
    });
    this.writing = write.catch(() => undefined);
    return write;
  }
  async aggregate(now = Date.now()) {
    await this.flush(now);
    return this.db.select({
      metric: latencySamples.metric, count: sql<number>`count(*)::int`,
      p50: sql<number>`percentile_cont(0.5) within group (order by ${latencySamples.valueMs})`,
      p90: sql<number>`percentile_cont(0.9) within group (order by ${latencySamples.valueMs})`,
      p95: sql<number>`percentile_cont(0.95) within group (order by ${latencySamples.valueMs})`,
    }).from(latencySamples).where(telemetryRows).groupBy(latencySamples.metric).orderBy(latencySamples.metric);
  }
}

export function observeTelemetry(body: Telemetry, demoSession = false) {
  const observe = (metric: string, value: number, demo: boolean, labels: Record<string, string> = {}) =>
    metrics.observe(`${demoSession || demo ? 'demo.' : ''}${metric}`, value, labels);
  for (const sample of body.samples) observe(sample.metric, sample.value, !!sample.demo);
  for (const event of body.events) {
    const labels: Record<string, string> = { route: event.route, tier: event.tier, trial: String(event.trial), device: event.device };
    for (const [key, value] of Object.entries(event.props ?? {})) {
      if (key === 'secondsSinceKey' || key === 'secondsToDecide') {
        observe(`telemetry.duration.${event.name}.${key}_s`, value as number, event.demo);
      } else if (Array.isArray(value)) {
        // Individual closed codes keep labels bounded rather than allowing permutations.
        for (const code of new Set(value)) observe(`telemetry.code.${event.name}.${code}`, 1, event.demo);
      } else if (typeof value === 'number') {
        labels[key] = key === 'drop' ? String(value) : value === 0 ? '0' : value < 10 ? '1-9' : value < 100 ? '10-99' : '100+';
      } else labels[key] = String(value);
    }
    observe(`telemetry.event.${event.name}`, 1, event.demo, labels);
  }
  // Raw client errors are untrusted/private. Only a fixed category is retained;
  // do not pass error messages, stacks, URLs or account context to logs/Sentry.
  if (body.error) observe(`telemetry.error.${body.error.kind ?? 'client_error'}`, 1, !!body.error.demo);
}
