import { describe, expect, it, vi } from 'vitest';
import { PublicConfigSchema, ErrorCodeSchema } from '@eko/shared';
import { ApiError, createApi } from './api';
import { createConfig } from '../mocks/responses';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
describe('typed API boundary', () => {
  it('negotiates V2 on the same configured origin without nesting it under V1', async () => {
    for (const [base, expected] of [['/v1', '/v2/coins/demo'], ['https://api.example/v1/', 'https://api.example/v2/coins/demo'], ['/proxy/v1', '/proxy/v2/coins/demo']] as const) {
      const transport = vi.fn(async () => json({ version: 2 }));
      await createApi(base, transport).request('/v2/coins/demo');
      expect(transport).toHaveBeenCalledWith(expected, expect.objectContaining({ credentials: 'include', method: 'GET' }));
    }
  });
  it('uses one base, credentials and shared parsing, including nested normalization', async () => {
    const config = createConfig(); config.exampleScans = ['0xABABABABABABABABABABABABABABABABABABABAB'];
    const fetch = vi.fn(async () => json(config)); const api = createApi('https://api.example/v1/', fetch);
    const parsed = await api.parse('/config', PublicConfigSchema);
    expect(parsed.exampleScans[0]).toBe(config.exampleScans[0].toLowerCase());
    expect(fetch).toHaveBeenCalledWith('https://api.example/v1/config', expect.objectContaining({ method: 'GET', credentials: 'include' }));
    await api.parse('/v1/config', PublicConfigSchema, { body: { test: true }, method: 'PUT' });
    expect(fetch).toHaveBeenLastCalledWith('https://api.example/v1/config', expect.objectContaining({ method: 'PUT', body: '{"test":true}', headers: { 'content-type': 'application/json' } }));
  });
  it('rejects invalid JSON and mismatched successful response shapes', async () => {
    const api = createApi('/v1', async () => json({ flags: {} }));
    await expect(api.parse('/config', PublicConfigSchema)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
    await expect(createApi('/v1', async () => new Response('<html>bad</html>')).parse('/config', PublicConfigSchema)).rejects.toBeInstanceOf(ApiError);
    await expect(createApi('/v1', async () => new Response('null')).parse('/config', PublicConfigSchema)).rejects.toBeInstanceOf(ApiError);
  });
  it('retains every ErrorCode and standard error metadata', async () => {
    for (const code of ErrorCodeSchema.options) {
      const api = createApi('/v1', async () => json({ error: code, message: 'Fixture error', requiredTier: 'reader', retryAfterSec: 30 }, 403));
      await expect(api.parse('/config', PublicConfigSchema)).rejects.toMatchObject({ code, status: 403, body: { requiredTier: 'reader', retryAfterSec: 30 } });
    }
  });
  it('maps unrecognized errors by status and preserves cancellation', async () => {
    for (const [status, code] of [[401, 'wallet_auth_required'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [500, 'internal_error']] as const) {
      await expect(createApi('/v1', async () => json({ error: 'unknown', message: 'Failure' }, status)).request('/me')).rejects.toMatchObject({ status, code });
    }
    await expect(createApi('/v1', async () => { throw new Error('Network down'); }).request('/me')).rejects.toMatchObject({ status: 0, code: 'internal_error' });
    const abort = new DOMException('Aborted', 'AbortError');
    await expect(createApi('/v1', async () => { throw abort; }).request('/me')).rejects.toBe(abort);
  });
  it('keeps legacy SIWE URLs and trade error codes usable', async () => {
    const fetch = vi.fn(async () => json({ error: 'stale_price', message: 'Stale' }, 503));
    await expect(createApi('/v1', fetch).request('/api/auth/nonce')).rejects.toMatchObject({ code: 'stale_price' });
    expect(fetch).toHaveBeenCalledWith('/api/auth/nonce', expect.anything());
  });
});
