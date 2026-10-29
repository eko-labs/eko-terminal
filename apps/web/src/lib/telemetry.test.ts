import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetrySchema, telemetryRoute } from '@eko/shared';
import { createApi } from './api';
import { createMockTransport } from '../mocks/transport';

const privateText = `0x${'b'.repeat(40)} Bearer fixture-placeholder`;
const send = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); send.mockClear();
  vi.stubEnv('VITE_MOCKS', '0'); vi.stubEnv('VITE_API_URL', '/v1');
  vi.stubGlobal('fetch', send);
  vi.stubGlobal('location', { pathname: `/coin/0x${'b'.repeat(40)}`, search: '?key=fixture-placeholder' });
  vi.stubGlobal('sessionStorage', { getItem: () => privateText, setItem: vi.fn() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('client telemetry privacy and v1 transport (offline fixtures)', () => {
  it('does not bypass spacing on repeated page-hide sends', async () => {
    const t = await import('./telemetry');
    t.track('ws.rtt_ms',1); await t.flushTelemetry(true);
    for(let i=0;i<10;i++){t.track('ws.rtt_ms',i);await t.flushTelemetry(true);}
    expect(send).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(t.TELEMETRY_MIN_GAP_MS-1);
    expect(send).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
  });
  it('batches known durations and events through /v1 without private error text or route resources', async () => {
    const t = await import('./telemetry');
    t.track('ui.quote_roundtrip_ms', 123.45);
    t.track('ui.secret_fixture', 1); t.track('ws.rtt_ms', -1); t.track('ws.rtt_ms', Infinity); t.track('ws.rtt_ms', 600_001);
    t.trackEvent({ name: 'page_view' });
    t.trackEvent({ name: 'first_preflight_seen', props: { secondsSinceKey: 2.25 } });
    t.trackEvent({ name: 'approval_decided', props: { decision: 'approved', secondsToDecide: 3.5 } });
    t.reportClientError(new TypeError(privateText));
    await t.flushTelemetry();
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v1/telemetry');
    const body = JSON.parse(String(init.body)); expect(TelemetrySchema.safeParse(body).success).toBe(true);
    expect(body.samples).toEqual([{ metric: 'ui.quote_roundtrip_ms', value: 123.5, demo: false }]);
    expect(body.events[0].route).toBe('/coin/:address'); expect(body.events[0].sessionId).not.toBe(privateText);
    expect(body.events[1].props.secondsSinceKey).toBe(2.25); expect(body.events[2].props.secondsToDecide).toBe(3.5);
    expect(body.error).toEqual({ kind: 'type_error', demo: false });
    expect(String(init.body)).not.toContain(privateText); expect(String(init.body)).not.toContain('fixture-placeholder');
    expect(t.localStats('ui.quote_roundtrip_ms')?.count).toBe(1); expect(t.localStats('ui.secret_fixture')).toBeNull();
  });
  it('redacts untrusted thrown objects without invoking string coercion and drops unexpected props', async () => {
    const t = await import('./telemetry'), stringify = vi.fn(() => privateText);
    t.reportClientError({ toString: stringify, wallet: privateText });
    t.trackEvent({ name: 'page_view', props: { wallet: privateText } } as never);
    await vi.advanceTimersByTimeAsync(t.TELEMETRY_FLUSH_MS);
    expect(stringify).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.events).toEqual([]); expect(body.error.kind).toBe('client_error');
    expect(JSON.stringify(body)).not.toContain(privateText);
  });
  it('keeps timers and batches bounded while a send is pending and contains transport failures', async () => {
    // Cadence changed with the telemetry-flood fix: full batches drain one per TELEMETRY_MIN_GAP_MS, not every 5 s.
    const t = await import('./telemetry'), gap = t.TELEMETRY_MIN_GAP_MS;
    let release!: () => void;
    send.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return new Response('{"ok":true}'); });
    for (let i = 0; i < 300; i++) t.track('ws.rtt_ms', i);
    expect(send).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(gap - 1); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * gap); expect(send).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(10 * gap); expect(send).toHaveBeenCalledTimes(5);
    for (const call of send.mock.calls) {
      const body = JSON.parse(String((call as unknown as [string, RequestInit])[1].body));
      expect(body.samples.length).toBeLessThanOrEqual(50); expect(TelemetrySchema.safeParse(body).success).toBe(true);
    }
    expect(send.mock.calls.reduce((n, call) => n + JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).samples.length, 0)).toBe(240);
    expect(t.localStats('ws.rtt_ms')!.count).toBe(200);
    send.mockRejectedValueOnce(new Error('fixture transport unavailable'));
    t.track('ws.rtt_ms', 1); await t.flushTelemetry();
    await vi.advanceTimersByTimeAsync(t.TELEMETRY_FLUSH_MS); expect(send).toHaveBeenCalledTimes(6);
  });
  it('batches a browsing session instead of sending one request per ping or page view', async () => {
    // Before: a 5 s window against a 10 s WebSocket ping sent ~one POST per RTT sample and per navigation.
    const t = await import('./telemetry');
    for (let second = 0; second < 120; second++) {
      if (second % 10 === 0) t.track('ws.rtt_ms', 40 + second % 7);
      if (second % 15 === 3) t.trackEvent({ name: 'page_view' });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(send.mock.calls.length).toBeLessThanOrEqual(4);
    const sent = send.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as { samples: unknown[]; events: unknown[] });
    expect(sent.reduce((n, b) => n + b.samples.length, 0)).toBe(12); expect(sent.reduce((n, b) => n + b.events.length, 0)).toBe(8);
  });
  it('spaces sends under any burst and sends what is queued, with keepalive, when the page is hidden', async () => {
    const t = await import('./telemetry'), times: number[] = [];
    send.mockImplementation(async () => { times.push(Date.now()); return new Response('{"ok":true}'); });
    for (let burst = 0; burst < 5; burst++) { for (let i = 0; i < 120; i++) t.trackEvent({ name: 'page_view' }); await vi.advanceTimersByTimeAsync(2000); }
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(t.TELEMETRY_MIN_GAP_MS);
    send.mockClear(); t.track('ws.rtt_ms', 12);
    await t.flushTelemetry(true); expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(true);
  });
  it('uses v1-only telemetry and empty metrics fixtures in mock mode without fetch', async () => {
    vi.stubEnv('VITE_MOCKS', '1');
    const t = await import('./telemetry');
    t.track('ws.rtt_ms', 12); t.trackEvent({ name: 'page_view' }); t.reportClientError(privateText);
    await t.flushTelemetry(); expect(send).not.toHaveBeenCalled();
    const transport = vi.fn(createMockTransport()), client = createApi('/v1', transport);
    expect(await client.request('/telemetry', { body: { samples: [{ metric: 'ws.rtt_ms', value: 12, demo: true }] } })).toEqual({ ok: true });
    expect(transport.mock.calls[0]![0]).toBe('/v1/telemetry');
    expect(await client.request('/metrics')).toMatchObject({ metrics: [], telemetry: [] });
    await expect(client.request('/api/telemetry', { body: {} })).rejects.toMatchObject({ status: 404 });
    await expect(client.request('/telemetry', { body: { wallet: privateText } })).rejects.toMatchObject({ status: 422 });
    expect(send).not.toHaveBeenCalled();
  });
  it('normalizes dynamic paths, queries, fragments and unknown paths to bounded templates', () => {
    expect(telemetryRoute('/approve/fixture-placeholder?token=fixture-placeholder')).toBe('/approve/:id');
    expect(telemetryRoute('/coin/fixture-placeholder#order-context')).toBe('/coin/:address');
    expect(telemetryRoute('/unknown/fixture-placeholder')).toBe('other');
    expect(telemetryRoute('/radar?key=fixture-placeholder')).toBe('/radar');
  });
});
