import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TELEMETRY_BODY_LIMIT, TelemetryEventSchema, TelemetrySchema, CLIENT_METRICS } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { metrics } from '../src/obs/metrics.js';
import { LatencyStore, TELEMETRY_RETENTION_MS } from '../src/obs/telemetry.js';
import * as errors from '../src/obs/errors.js';
import { latencySamples } from '../src/db/schema.js';

const common = { ts: 1_800_000_000_000, route: '/radar', sessionId: '11111111-1111-4111-8111-111111111111',
  buildSha: 'abcdef0', tier: 'listener', trial: false, demo: false, device: 'desktop' };
const event = (name: string, props?: object, extra: object = {}) => ({ ...common, name, ...(props ? { props } : {}), ...extra });
const privateText = `0x${'a'.repeat(40)} Bearer fixture-placeholder /private/fixture-path?key=fixture-placeholder`;
let built: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  metrics.reset();
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
    DEMO_SECRET: 'telemetry-fixture-placeholder'.repeat(2) }), { startBackground: false });
});
afterAll(async () => { await built.close(); metrics.reset(); });
const post = (payload: object, url = '/v1/telemetry', headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
  built.app.inject({ method: 'POST', url, payload, headers, remoteAddress });

describe('CA-24 offline injection and migrated storage (no browser latency evidence)', () => {
  it('preserves the specified event inventory and closed props', () => {
    const names = TelemetryEventSchema.options.map(s => s.shape.name.value);
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['landing_view', 'trade_confirmed', 'first_preflight_seen', 'approval_decided', 'drop_demo_played']));
    expect(CLIENT_METRICS).toEqual(expect.arrayContaining(['ui.scan_to_verdict_ms', 'ui.quote_roundtrip_ms', 'ui.chart_load_ms', 'ui.approval_open_ms', 'ui.ws_event_to_paint_ms']));
  });
  it('rejects unknown fields/names, private context, oversize arrays and out-of-range values atomically', async () => {
    const invalid = [
      { wallet: privateText }, { events: [event(privateText)] }, { events: [event('page_view', { wallet: privateText })] },
      { events: [event('page_view', undefined, { account: privateText })] },
      { events: [event('page_view', undefined, { route: `/coin/${privateText}` })] },
      { events: [event('page_view', undefined, { sessionId: privateText })] },
      { events: [event('trade_confirmed', { venue: 'pons_curve', sizeBucket: privateText })] },
      { events: [event('guard_warning_ack', { codes: [privateText] })] },
      { events: Array.from({ length: 51 }, () => event('page_view')) },
      { samples: Array.from({ length: 51 }, () => ({ metric: 'ws.rtt_ms', value: 1 })) },
      { samples: [{ metric: `ui.${privateText}`, value: 1 }] }, { samples: [{ metric: 'ws.rtt_ms', value: -1 }] },
      { samples: [{ metric: 'ws.rtt_ms', value: 600_001 }] }, { samples: [{ metric: 'ws.rtt_ms', value: 1, labels: { wallet: privateText } }] },
      { error: { message: 'x'.repeat(501) } }, { error: { stack: 'x'.repeat(4001) } }, { error: { url: 'x'.repeat(301) } },
      { error: { kind: privateText } }, { error: { order: privateText } },
    ];
    for (const payload of invalid) {
      const r = await post({ samples: [{ metric: 'ws.rtt_ms', value: 19 }], ...payload });
      expect(r.statusCode).toBe(422); expect(r.json().error).toBe('bad_request'); expect(r.body).not.toContain(privateText);
    }
    expect(metrics.summary().find(s => s.metric === 'ws.rtt_ms')!.count).toBe(0);
    expect(TelemetrySchema.safeParse({ samples: [{ metric: 'ws.rtt_ms', value: Infinity }] }).success).toBe(false);
    const oversized = await post({ padding: 'x'.repeat(TELEMETRY_BODY_LIMIT) });
    expect(oversized.statusCode).toBe(413);
    const malformed = await built.app.inject({ method: 'POST', url: '/v1/telemetry', payload: `{"${privateText}":`, headers: { 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(422); expect(malformed.body).not.toContain(privateText);
  });
  it('drops error text, session/build identifiers and headers before storage or error reporting', async () => {
    const report = vi.spyOn(errors, 'reportError');
    try {
      const r = await post({ events: [event('page_view'), event('bags_scanned', { holdings: 12, danger: 2 })],
        samples: [{ metric: 'ui.quote_roundtrip_ms', value: 123.4 }],
        error: { message: privateText, stack: privateText, url: privateText } }, '/v1/telemetry',
      { authorization: 'Bearer fixture-placeholder', cookie: 'eko_sid=fixture-placeholder' });
      expect(r.statusCode).toBe(200);
      const response = await built.app.inject('/v1/metrics'); expect(response.statusCode).toBe(200);
      expect(response.json().telemetry).toContainEqual(expect.objectContaining({ metric: 'telemetry.event.page_view', count: 1 }));
      const rows = await built.ctx.dbh.db.select().from(latencySamples);
      const stored = JSON.stringify(rows);
      for (const value of [privateText, common.sessionId, common.buildSha, 'fixture-placeholder']) expect(stored).not.toContain(value);
      expect(rows.find(r => r.metric === 'telemetry.event.bags_scanned')!.labels).toEqual({ route: '/radar', tier: 'listener', trial: 'false', device: 'desktop', holdings: '10-99', danger: '1-9' });
      expect(rows.find(r => r.metric === 'telemetry.error.client_error')!.valueMs).toBe(1);
      expect(report).not.toHaveBeenCalled();
    } finally { report.mockRestore(); }
  });
  it('preserves durations and separates client-declared and signed demo sessions from launch data', async () => {
    const token = createDemoToken([], built.ctx.cfg.DEMO_SECRET!);
    expect((await post({ events: [event('first_preflight_seen', { secondsSinceKey: 42.25 }),
      event('approval_decided', { decision: 'approved', secondsToDecide: 2.5 })] })).statusCode).toBe(200);
    expect((await post({ events: [event('page_view', undefined, { demo: true })], samples: [{ metric: 'ui.quote_roundtrip_ms', value: 9, demo: true }] })).statusCode).toBe(200);
    expect((await post({ events: [event('page_view')], samples: [{ metric: 'ui.quote_roundtrip_ms', value: 11 }], error: { message: privateText } }, '/v1/telemetry', { cookie: `eko_demo=${token}` })).statusCode).toBe(200);
    const aggregates = (await built.app.inject('/v1/metrics')).json().telemetry;
    expect(aggregates).toContainEqual(expect.objectContaining({ metric: 'telemetry.duration.first_preflight_seen.secondsSinceKey_s', p50: 42.25 }));
    expect(aggregates).toContainEqual(expect.objectContaining({ metric: 'telemetry.duration.approval_decided.secondsToDecide_s', p50: 2.5 }));
    expect(aggregates).toContainEqual(expect.objectContaining({ metric: 'demo.telemetry.event.page_view', count: 2 }));
    expect(aggregates).toContainEqual(expect.objectContaining({ metric: 'ui.quote_roundtrip_ms', count: 1, p50: 123.4 }));
    // Browser samples cannot certify the operational launch gate.
    expect((await built.ctx.monitoring.checks(false)).quote.state).toBe('unavailable');
  });
  it('retains operational paths and applies the same redaction to legacy ingress', async () => {
    expect((await built.app.inject('/api/health/live')).statusCode).toBe(200);
    expect((await built.app.inject('/api/metrics')).statusCode).toBe(200);
    expect((await post({ error: { message: privateText, stack: privateText } }, '/api/telemetry')).statusCode).toBe(200);
    expect((await post({ error: { message: privateText, wallet: privateText } }, '/api/telemetry')).statusCode).toBe(422);
  });
  it('enforces 120 requests per IP per minute despite cookie rotation', async () => {
    for (let i = 0; i < 120; i++) expect((await post({}, '/v1/telemetry', { cookie: `eko_sid=fixture-${i}` }, '192.0.2.1')).statusCode).toBe(200);
    const denied = await post({}, '/v1/telemetry', {}, '192.0.2.1');
    expect(denied.statusCode).toBe(429); expect(denied.json().error).toBe('rate_limited');
    expect((await post({}, '/v1/telemetry', {}, '192.0.2.2')).statusCode).toBe(200);
  });
  it('aggregates persisted observations after store recreation and expires only telemetry', async () => {
    const db = built.ctx.dbh.db, now = Date.now();
    const store = new LatencyStore(db);
    store.record('telemetry.event.landing_view', 1, {}, now - TELEMETRY_RETENTION_MS - 1);
    store.record('telemetry.event.landing_view', 1, {}, now);
    store.record('ui.chart_load_ms', 10, {}, now - TELEMETRY_RETENTION_MS - 1);
    store.record('demo.ws.rtt_ms', 10, {}, now - TELEMETRY_RETENTION_MS - 1);
    store.record('fixture.operational_ms', 10, {}, now - TELEMETRY_RETENTION_MS - 1);
    await store.flush(now);
    const reopened = new LatencyStore(db);
    const rows = await reopened.aggregate(now);
    expect(rows).toContainEqual(expect.objectContaining({ metric: 'telemetry.event.landing_view', count: 1 }));
    expect(rows.some(r => r.metric === 'ui.chart_load_ms' || r.metric === 'demo.ws.rtt_ms')).toBe(false);
    expect((await db.select().from(latencySamples)).some(r => r.metric === 'fixture.operational_ms')).toBe(true);
    for (let i = 0; i < 5010; i++) reopened.record('ws.rtt_ms', i, {}, now);
    await reopened.flush(now);
    expect((await reopened.aggregate(now)).find(r => r.metric === 'ws.rtt_ms')!.count).toBe(5000);
  });
});
