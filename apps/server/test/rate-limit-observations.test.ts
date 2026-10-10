import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '../src/obs/metrics.js';
import { installRateLimitObservations, pluginRejectionObserver, RATE_LIMIT_COUNTER, RateLimitObservations } from '../src/obs/rate-limits.js';
import { addressLimit } from '../src/http/address-limit.js';
afterEach(() => { metrics.reset(); metrics.setSink(() => {}); });
describe('anonymous limiter observations', () => {
  it('counts global, route and address refusals by pattern and actual key kind without identity data', async () => {
    metrics.reset(); const sink = vi.fn(); metrics.setSink(sink);
    const log = vi.fn(), observer = new RateLimitObservations(log);
    const app = Fastify(); installRateLimitObservations(app, observer);
    await app.register(rateLimit, { global: true, max: 1, timeWindow: '1 minute', keyGenerator: req => req.headers.cookie ?? req.ip,
      onExceeded: pluginRejectionObserver(observer, req => !!req.headers.cookie) });
    app.get('/coins/:coin', async () => ({ ok: true }));
    app.get('/route/:coin', { config: { rateLimit: { max: 1 } } }, async () => ({ ok: true }));
    app.get('/address-route/:coin', { config: { rateLimitKeyKind: 'address', rateLimit: { max: 1, keyGenerator: req => req.ip } } }, async () => ({ ok: true }));
    app.get('/address/:coin', { config: { rateLimit: false }, onRequest: addressLimit(app, 1) }, async () => ({ ok: true }));
    await app.ready();
    try {
      const cookie = 'eko_sid=sample-cookie-placeholder', ip = '203.0.113.7';
      for (const url of ['/coins/first', '/route/first', '/address-route/first', '/address/first']) {
        const headers = { cookie };
        expect((await app.inject({ url, headers, remoteAddress: ip })).statusCode).toBe(200);
        expect((await app.inject({ url: url.replace('first','second'), headers, remoteAddress: ip })).statusCode).toBe(429);
      }
      await app.inject({ url: '/coins/first', remoteAddress: '203.0.113.8' });
      expect((await app.inject({ url: '/coins/third', remoteAddress: '203.0.113.8' })).statusCode).toBe(429);
      const counters = metrics.counters().filter(row => row.metric === RATE_LIMIT_COUNTER);
      expect(counters).toEqual(expect.arrayContaining([
        { metric: RATE_LIMIT_COUNTER, labels: {limiter:'global',route:'/coins/:coin',keyKind:'session'}, count:1 },
        { metric: RATE_LIMIT_COUNTER, labels: {limiter:'global',route:'/coins/:coin',keyKind:'address'}, count:1 },
        { metric: RATE_LIMIT_COUNTER, labels: {limiter:'route',route:'/route/:coin',keyKind:'session'}, count:1 },
        { metric: RATE_LIMIT_COUNTER, labels: {limiter:'route',route:'/address-route/:coin',keyKind:'address'}, count:1 },
        { metric: RATE_LIMIT_COUNTER, labels: {limiter:'address',route:'/address/:coin',keyKind:'address'}, count:1 },
      ]));
      expect(metrics.summary().find(row => row.metric === RATE_LIMIT_COUNTER)?.count).toBe(5);
      observer.flush(); expect(log).toHaveBeenCalledOnce();
      const output = JSON.stringify([counters, sink.mock.calls, log.mock.calls, metrics.counterPrometheus()]);
      for (const value of [cookie, ip, '203.0.113.8', 'first', 'second', 'third']) expect(output).not.toContain(value);
      expect(metrics.counterPrometheus()).toContain('eko_http_rate_limit_rejections_total{limiter="global",route="/coins/:coin",keyKind="session"} 1');
    } finally { await app.close(); }
  });
  it('emits at most one aggregate log per minute and keeps counts across flushes', () => {
    let now = 0; const log = vi.fn(), observer = new RateLimitObservations(log, () => now);
    for (let i=0;i<100;i++) observer.reject('global', '/v1/coins/:address', 'session');
    observer.flush(); expect(log).toHaveBeenCalledOnce(); expect(log.mock.calls[0][0].counters[0].count).toBe(100);
    observer.reject('route', '/v1/trade/quote', 'session'); observer.flush(); expect(log).toHaveBeenCalledOnce();
    now=60000; observer.flush(); observer.flush(); expect(log).toHaveBeenCalledTimes(2);
    expect(metrics.counters().reduce((sum,row)=>sum+row.count,0)).toBe(101);
  });
});
