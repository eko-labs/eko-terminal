/**
 * In-process latency metrics. Each metric keeps a bounded ring buffer of recent samples
 * and reports count / p50 / p90 / p99. Samples are also flushed to the latency_samples
 * table so measurements survive restarts and can be analysed later.
 */
export const METRIC_DESCRIPTIONS: Record<string, string> = {
  'http.rate_limit_rejections': 'HTTP requests refused by a rate limiter',
  'market.lag_ms': 'Exchange event time → server receipt (market-data freshness)',
  'market.candle_close_to_eval_ms': 'Bar close → strategy evaluation started',
  'signal.publish_ms': 'Bar close → signal persisted and broadcast',
  'ai.inference_ms': 'Model request → validated response (off the execution path)',
  'harness.preflight_ms': 'Preflight request → policy result',
  'simulation.failure': 'Attempted execution simulation failure (1) or success (0)',
  'scan.response_ms': 'Scan HTTP request → response (includes pending; excludes completion gate)',
  'scan.pair_to_complete_verdict_ms': 'New pair → persisted verdict with all required checks complete',
  'queue.completion_ms': 'Enqueued work → persisted output (including incomplete output)',
  'quote.latency_ms': 'Quote request received → quote returned',
  'order.submit_server_ms': 'Order request received → paper fill or tx record persisted',
  'order.confirm_ms': 'Transaction submitted → confirmed on-chain',
  'ui.signal_arrival_to_paint_ms': 'Signal received over WebSocket → marker painted (client)',
  'ui.click_to_card_ms': 'Click on signal → execution card interactive (client)',
  'ui.click_to_submit_ms': 'Execution card opened → order submitted (client)',
  'ui.quote_roundtrip_ms': 'Quote request sent → quote rendered (client)',
  'ui.scan_to_verdict_ms': 'Scan submitted → verdict rendered (client)',
  'ui.ws_event_to_paint_ms': 'WebSocket event received → painted (client)',
  'ui.chart_load_ms': 'Chart data received → chart ready (client)',
  'ui.approval_open_ms': 'Approval link opened → buttons ready (client)',
  'ws.rtt_ms': 'WebSocket ping round trip (client)',
  'alerts.discovery_to_ws_ms': 'Committed alert source discovered → owner WebSocket send (excludes pre-discovery delay)',
};

interface Series {
  samples: number[];
  idx: number;
  count: number;
  last: number | null;
  lastAt: number | null;
}

const CAP = 512;

export interface MetricSummary {
  metric: string;
  description: string;
  count: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  last: number | null;
  lastAt: number | null;
}

type Sink = (metric: string, value: number, labels: Record<string, string>, at: number) => void;

class Metrics {
  private series = new Map<string, Series>();
  private sink: Sink | null = null;
  private totals = new Map<string, { metric: string; labels: Record<string, string>; count: number }>();
  increment(metric: string, labels: Record<string, string>) {
    const id = JSON.stringify([metric, labels]), previous = this.totals.get(id);
    if (previous) previous.count++;
    else this.totals.set(id, { metric, labels: { ...labels }, count: 1 });
    this.observe(metric, 1, labels);
  }
  counters() { return [...this.totals.values()].map(row => ({ ...row, labels: { ...row.labels } })); }
  counterPrometheus() {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return '# TYPE eko_http_rate_limit_rejections_total counter\n' + this.counters().filter(row => row.metric === 'http.rate_limit_rejections').map(row =>
      `eko_http_rate_limit_rejections_total{${Object.entries(row.labels).map(([key, value]) => `${key}="${escape(value)}"`).join(',')}} ${row.count}\n`).join('');
  }

  setSink(s: Sink) {
    this.sink = s;
  }

  observe(metric: string, value: number, labels: Record<string, string> = {}) {
    if (!Number.isFinite(value) || value < 0) return;
    let s = this.series.get(metric);
    if (!s) {
      s = { samples: [], idx: 0, count: 0, last: null, lastAt: null };
      this.series.set(metric, s);
    }
    if (s.samples.length < CAP) s.samples.push(value);
    else {
      s.samples[s.idx] = value;
      s.idx = (s.idx + 1) % CAP;
    }
    s.count++;
    s.last = value;
    s.lastAt = Date.now();
    this.sink?.(metric, value, labels, s.lastAt);
  }

  summary(): MetricSummary[] {
    const out: MetricSummary[] = [];
    const names = new Set([...Object.keys(METRIC_DESCRIPTIONS), ...this.series.keys()]);
    for (const metric of names) {
      const s = this.series.get(metric);
      const sorted = s ? [...s.samples].sort((a, b) => a - b) : [];
      const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
      out.push({
        metric,
        description: METRIC_DESCRIPTIONS[metric] ?? metric,
        count: s?.count ?? 0,
        p50: q(0.5),
        p90: q(0.9),
        p95: q(0.95),
        p99: q(0.99),
        mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
        last: s?.last ?? null,
        lastAt: s?.lastAt ?? null,
      });
    }
    return out.sort((a, b) => a.metric.localeCompare(b.metric));
  }

  reset() {
    this.series.clear(); this.totals.clear();
  }
}

export const metrics = new Metrics();

export function timer() {
  const t0 = performance.now();
  return () => performance.now() - t0;
}
