import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '@eko/shared';
import { contractFixtures, createAlertSettings, createTradeQuoteRequest } from './fixtures';
import { createConfig, endpoints } from './responses';
import { createMockTransport } from './transport';
import { createApi } from '../lib/api';

describe('all frozen CA and FACTS fixtures', () => {
  for (const [name, entry] of Object.entries(contractFixtures)) it(name, () => {
    const fixture = entry.create();
    expect(entry.schema.parse(fixture)).toEqual(fixture);
    expect(entry.create()).toEqual(fixture);
    if (fixture && typeof fixture === 'object') expect(entry.create()).not.toBe(fixture);
  });
  it('covers every shared contract schema rather than silently missing new shapes', () => {
    // These schemas come from the legacy app, not the CA/FACTS contract set.
    const contractSchemas = new Set(Object.keys(contractFixtures).map((name) => `${name}Schema`));
    expect(contractSchemas.size).toBeGreaterThan(95);
    for (const key of ['CoinCardSchema', 'WsEventMapSchema', 'MeSchema', 'FlagsSchema', 'UnsignedTxSchema', 'ResearchJobSchema', 'LoopSpecSchema']) expect(contractSchemas.has(key)).toBe(true);
  });
});
describe('FACTS §7 responses and CA transport', () => {
  for (const endpoint of endpoints) it(`${endpoint.method} ${endpoint.path}`, () => {
    expect(endpoint.schema.parse(endpoint.create())).toEqual(endpoint.create());
  });
  it('starts offline with flags off, trading disabled, and distinct public wallets', async () => {
    const api = createApi('/v1', createMockTransport());
    const config = await api.parse('/config', shared.PublicConfigSchema);
    expect(config).toEqual(createConfig());
    expect(Object.values(config.flags).every((value) => !value)).toBe(true);
    expect(config.trading.liveEnabled).toBe(false);
    expect(config.wallets.burn).not.toBe(config.wallets.dev);
    expect(config.contracts.burnEngine).toBeUndefined();
  });
  it('keeps the offline session anonymous until a wallet signs the mock SIWE message', async () => {
    const api = createApi('/v1', createMockTransport());
    expect((await api.parse('/me', shared.MeSchema)).account.wallet).toBeUndefined();
    await api.parse('/auth/siwe/nonce', shared.SiweNonceSchema, { method: 'POST' });
    const wallet = '0x1111111111111111111111111111111111111111';
    await api.request('/auth/siwe/verify', { body: { message: `localhost wants you to sign in with your Ethereum account:\n${wallet}\n\n${shared.SIWE_STATEMENT}` } });
    expect((await api.parse('/me', shared.MeSchema)).account.wallet).toBe(wallet);
    await api.request('/auth/logout', { method: 'POST' });
    expect((await api.parse('/me', shared.MeSchema)).account.wallet).toBeUndefined();
  });
  it('validates scan requests, resolves deep links and reports unknown endpoints', async () => {
    const api = createApi('/v1', createMockTransport());
    await expect(api.parse('/scan', shared.ScanResultSchema, { body: {} })).rejects.toMatchObject({ status: 400 });
    expect((await api.parse('/scan/scan-1', shared.ScanResultSchema)).id).toBe('scan-1');
    await expect(api.request('/missing')).rejects.toMatchObject({ status: 404 });
    await expect(api.request('/api/missing')).rejects.toMatchObject({ status: 404 });
    const controller = new AbortController(); controller.abort();
    await expect(api.request('/config', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('serves deterministic binary OG image fixtures', async () => {
    const result = await createMockTransport()('/v1/og/scan/scan-1.png');
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await result.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]));
  });
  it('keeps alerts and Telegram linking available alongside trade quotes', async () => {
    const api = createApi('/v1', createMockTransport());
    const settings = { ...createAlertSettings(), telegram: true, agentTradeAboveUsd: 250 };
    await api.parse('/alerts/settings', shared.AlertSettingsSchema, { method: 'PUT', body: settings });
    const input = { ...createTradeQuoteRequest(), amountUsd: 25 };
    expect(await api.parse('/trade/quote', shared.TradeQuoteSchema, { body: input })).toMatchObject({ coin: input.coin, side: input.side, amountUsd: 25, guard: { decision: 'refuse' } });
    expect(await api.parse('/alerts/settings', shared.AlertSettingsSchema)).toEqual(settings);
    expect(await api.request('/alerts')).toEqual({ rows: [], cursor: null, seq: 0 });
    expect(await api.request('/telegram/link', { method: 'POST' })).toMatchObject({ url: 'https://t.me/demo_bot?start=demo-link-code', expiresAt: expect.any(String) });
  });
});
