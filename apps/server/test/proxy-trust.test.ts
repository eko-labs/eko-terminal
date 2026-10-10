import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADDRESS_REQUESTS_PER_MINUTE, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const peer = '192.0.2.50';
const client = '203.0.113.50';
const rpcBody = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
const forwarded = (i: number, trusted: boolean) => {
  const attacker = `198.51.${Math.floor(i / 250)}.${i % 250 + 1}`;
  return trusted ? `${attacker}, 198.51.100.200, ${client}`
    : i % 2 ? `${attacker}, ${client}` : attacker;
};

describe.each([false, true])('assembled API proxy trust (one trusted hop: %s; offline RPC stub)', trusted => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  let request: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
      SESSION_SECRET: 'sample-session-placeholder'.repeat(2),
      ...(trusted ? { TRUST_PROXY_HOPS: '1' } : {}) }), { startBackground: false });
    request = vi.spyOn(built.ctx.chains.get('robinhood-mainnet'), 'request').mockResolvedValue('0x1237');
    built.app.get('/fixture/client-identity', req => ({ ip: req.ip }));
  });
  afterAll(async () => { request.mockRestore(); await built.close(); });

  // Audit proof for rescore: exercise real buildApp wiring, schemas and endpoint limiters.
  it.each(['/v1/telemetry', '/v1/rpc'])('blocks forwarded-address rotation after 120 valid requests to %s', async url => {
    const before = request.mock.calls.length;
    for (let i = 0; i < 241; i++) {
      const response = await built.app.inject({ method: 'POST', url, remoteAddress: peer,
        headers: { 'x-forwarded-for': forwarded(i, trusted), cookie: `eko_sid=fixture-${i}` },
        payload: url === '/v1/rpc' ? rpcBody : {} });
      expect(response.statusCode).toBe(i < 120 ? 200 : 429);
      if (i < 120 && url === '/v1/rpc') expect(response.json().result).toBe('0x1237');
      expect(request.mock.calls.length).toBe(before + (url === '/v1/rpc' ? Math.min(i + 1, 120) : 0));
    }
    // A different genuine client gets its own bucket, even behind the same edge.
    const other = await built.app.inject({ method: 'POST', url,
      remoteAddress: trusted ? peer : '192.0.2.51',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.51' },
      payload: url === '/v1/rpc' ? rpcBody : {} });
    expect(other.statusCode).toBe(200);
    expect((await built.ctx.chains.meter.usage()).sessionUnits).toBe(0);
  });

  it('selects the socket peer by default and only the appended address with one trusted hop', async () => {
    for (const header of [client, `198.51.100.1, ${client}`, `198.51.100.1, 198.51.100.2, ${client}`]) {
      const response = await built.app.inject({ url: '/fixture/client-identity', remoteAddress: peer,
        headers: { 'x-forwarded-for': header } });
      expect(response.json().ip).toBe(trusted ? client : peer);
    }
    expect((await built.app.inject({ url: '/fixture/client-identity', remoteAddress: peer })).json().ip).toBe(peer);
  });

  it('enforces the global anonymous 600/min limit with rotating forwarded addresses', async () => {
    for (let i = 0; i < 605; i++) {
      const response = await built.app.inject({ url: '/v1/health', remoteAddress: '192.0.2.60',
        headers: { 'x-forwarded-for': forwarded(i, trusted).replace(client, '203.0.113.60') } });
      expect(response.statusCode).toBe(i < 600 ? 200 : 429); // Liveness remains available with disabled loops.
      if (i === 0) expect(response.json().loops.refresher).toEqual({ name: 'refresher', stale: true, periodSec: 0.25, lastCycleAt: null });
    }
  });

  it('caps one address across freshly minted guest sessions, and caps its sign-in attempts', async () => {
    const at = (n: number) => trusted ? { remoteAddress: peer, headers: { 'x-forwarded-for': `203.0.113.${n}` } as Record<string, string> }
      : { remoteAddress: `192.0.2.${n}`, headers: {} as Record<string, string> };
    const mint = async (n: number, count: number) => {
      const cookies: string[] = [];
      for (let i = 0; i < count; i++) {
        const minted = await built.app.inject({ url: '/v1/me', ...at(n) });
        expect(minted.statusCode).toBe(200);
        cookies.push(`eko_sid=${minted.cookies.find(c => c.name === 'eko_sid')!.value}`);
      }
      expect(new Set(cookies).size).toBe(count);
      return cookies;
    };
    // Each session keeps its own 600/min bucket, but the address stops at 1800/min across all of them.
    const cookies = await mint(70, 4);
    for (let i = 4; i < 1805; i++) {
      const response = await built.app.inject({ url: '/v1/health', ...at(70), headers: { ...at(70).headers, cookie: cookies[i % 4]! } });
      expect(response.statusCode).toBe(i < ADDRESS_REQUESTS_PER_MINUTE ? 200 : 429);
      if (i === 4) expect(response.json().ok).toBe(true);
    }
    // A failed signature can fall back to an on-chain check: 60 attempts per address, whatever the session.
    const signers = await mint(71, 4);
    for (let i = 0; i < 61; i++) {
      const response = await built.app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', ...at(71),
        headers: { ...at(71).headers, cookie: signers[i % 4]!, origin: 'http://localhost:5180' }, payload: {} });
      expect(response.statusCode === 429).toBe(i >= 60);
    }
  });
});
