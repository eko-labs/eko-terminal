import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { RequestControl, MARKET_SPACING_MS, READS_PER_MINUTE, resourceKey } from './requestControl';
import { requestPauseUntil, retryDeadline } from './rateNotice';
const json = (value: unknown, status = 200, retry?: string) => new Response(JSON.stringify(value), { status, headers: retry ? { 'retry-after': retry } : undefined });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('bounded browser reads', () => {
  it('coalesces busy Guard notifications, both reconnect channels, and immediate retries with a minimum gap per resource', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async (_url: string, _init: RequestInit) => json({ retained: true })), api = createApi('/v1', transport);
    const waves: Promise<unknown>[] = [];
    for (let second = 0; second < 60; second++) {
      // Three card events each second; two independently subscribed coin panels.
      for (let event = 0; event < 3; event++) for (const path of ['/v2/coins/demo', '/v2/coins/demo/verdict', '/coins/demo', '/coins/demo/candles?tf=5m&from=0&to=' + second, '/coins/demo/markers?from=0&to=' + second]) waves.push(api.request(path));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(transport.mock.calls.filter(([url]) => url === '/v2/coins/demo').length).toBeLessThanOrEqual(Math.ceil(60000 / MARKET_SPACING_MS) + 1);
    expect(transport.mock.calls.filter(([url]) => url.includes('/candles')).length).toBeLessThanOrEqual(Math.ceil(60000 / MARKET_SPACING_MS) + 1);
    await vi.advanceTimersByTimeAsync(5000); await Promise.all(waves);
    expect(transport.mock.calls.every(([, init]) => !init.signal?.aborted)).toBe(true);
  });
  it('bounds changing Feed coins and page navigation, including quotes, to 150 requests in a rolling minute', async () => {
    vi.useFakeTimers(); const transport = vi.fn(async () => json({ ok: true }));
    const api = createApi('/v1', transport);
    const jobs = Array.from({ length: 300 }, (_, i) => api.request(`/coins/demo-${i}`));
    await vi.advanceTimersByTimeAsync(0); expect(transport).toHaveBeenCalledTimes(READS_PER_MINUTE);
    await vi.advanceTimersByTimeAsync(59999); expect(transport).toHaveBeenCalledTimes(READS_PER_MINUTE);
    await vi.advanceTimersByTimeAsync(1); await Promise.all(jobs); expect(transport).toHaveBeenCalledTimes(300);
  });
  it('backs off errors rather than retrying at once', async () => {
    vi.useFakeTimers(); const transport = vi.fn(async () => json({}, 500)); const api = createApi('/v1', transport);
    await expect(api.request('/v2/pairs')).rejects.toMatchObject({ status: 500 });
    const retry = api.request('/v2/pairs').catch(e => e); await vi.advanceTimersByTimeAsync(9999);
    expect(transport).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); await retry;
    const again = api.request('/v2/pairs').catch(e => e); await vi.advanceTimersByTimeAsync(19999);
    expect(transport).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(1); await again;
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('does not fetch while hidden and lets one subscriber cancel without cancelling another', async () => {
    vi.useFakeTimers(); const doc = new EventTarget() as EventTarget & { visibilityState: string }; doc.visibilityState = 'hidden'; vi.stubGlobal('document', doc);
    const transport = vi.fn(async () => json({ ok: true })), api = createApi('/v1', transport), ac = new AbortController();
    const cancelled = api.request('/coins/demo', { signal: ac.signal }).catch(e => e);
    const active = api.request('/coins/demo'); ac.abort(); await vi.advanceTimersByTimeAsync(60000);
    expect(transport).not.toHaveBeenCalled(); expect(await cancelled).toMatchObject({name:'AbortError'});
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await active;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps timeframe and history start distinct but coalesces moving chart end times', () => {
    expect(resourceKey('/coins/demo/candles?tf=5m&from=0&to=10')).toBe(resourceKey('/coins/demo/candles?to=20&from=0&tf=5m'));
    expect(resourceKey('/coins/demo/candles?tf=1h&from=0')).not.toBe(resourceKey('/coins/demo/candles?tf=5m&from=0'));
    expect(resourceKey('/coins/demo/candles?tf=5m&from=10')).not.toBe(resourceKey('/coins/demo/candles?tf=5m&from=0'));
  });
  it('reads seconds and HTTP dates, retries a 429 only once, and shares the pause across clients', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    expect(retryDeadline('24')).toBe(124000); expect(retryDeadline(new Date(124000).toUTCString())).toBe(124000);
    const transport = vi.fn().mockResolvedValueOnce(json({ message: 'Limit reached' }, 429, '24')).mockResolvedValueOnce(json({ name: 'Demo coin' }));
    const api = createApi('/v1', transport); const result = api.request('/coins/demo');
    await vi.advanceTimersByTimeAsync(0); expect(requestPauseUntil()).toBe(124000);
    const otherTransport = vi.fn(async () => json({ ok: true }));
    const other = createApi('/v1', otherTransport, new RequestControl(requestPauseUntil)).request('/v2/pairs');
    await vi.advanceTimersByTimeAsync(23999); expect(transport).toHaveBeenCalledTimes(1); expect(otherTransport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ name: 'Demo coin' }); await other;
    const repeated = vi.fn(async () => json({error:'bad_request',message:'Rate limit exceeded'}, 429, '1'));
    const failed = createApi('/v1', repeated).request('/coins/demo').catch(e => e);
    await vi.advanceTimersByTimeAsync(1000); expect(await failed).toMatchObject({status:429,code:'rate_limited'});
    await vi.advanceTimersByTimeAsync(60000); expect(repeated).toHaveBeenCalledTimes(2);
  });
  it('does not replay order or sign-in mutations after a 429', async () => {
    const transport = vi.fn(async () => json({}, 429, '24')); const api = createApi('/v1', transport);
    for (const path of ['/trade/order', '/auth/siwe/verify', '/telemetry']) await expect(api.request(path, { body: {} })).rejects.toMatchObject({ status: 429 });
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
