import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressKey } from '../src/http/address-limit.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('client address keys for rate limits', () => {
  it('keeps IPv4 and IPv4-mapped addresses whole and groups other IPv6 by /64', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:0001:0002:ffff::9%eth0')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('64:ff9b:1:2::192.0.2.1')).toBe('64:ff9b:1:2::/64');
    expect(addressKey('2001:db8:1:3::1')).not.toBe(addressKey('2001:db8:1:2::1'));
    expect(addressKey(undefined)).toBe('unknown');
  });
});

describe('sign-in attempts share one per-address cap across v1 and legacy routes (offline)', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'true',
      SESSION_SECRET: 'sample-session-placeholder'.repeat(2) }), { startBackground: false });
  });
  afterAll(async () => { await built.close(); });

  it('refuses the 61st attempt from one IPv6 /64 whichever route and address in it is used', async () => {
    const address = (i: number) => `2001:db8:7:7::${(i % 50 + 1).toString(16)}`;
    // Separate guest sessions, so each route's per-session limit (20/min) never binds before the shared cap.
    const cookies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const minted = await built.app.inject({ url: '/v1/me', remoteAddress: address(i) });
      cookies.push(`eko_sid=${minted.cookies.find(c => c.name === 'eko_sid')!.value}`);
    }
    for (let i = 0; i < 61; i++) {
      const response = await built.app.inject({ method: 'POST', url: i % 2 ? '/api/auth/verify' : '/v1/auth/siwe/verify', remoteAddress: address(i),
        headers: { origin: 'http://localhost:5180', cookie: cookies[i % 4]! }, payload: {} });
      expect(response.statusCode === 429, `attempt ${i + 1}`).toBe(i >= 60);
    }
    const elsewhere = await built.app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', remoteAddress: '2001:db8:7:8::1', headers: { origin: 'http://localhost:5180' }, payload: {} });
    expect(elsewhere.statusCode).not.toBe(429);
  });
});
