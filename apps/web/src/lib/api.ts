import { ApiErrorSchema, type ErrorCode } from '@eko/shared';
import type { z } from 'zod';
import { setApiUnavailable } from './connection';
import { RequestControl, MARKET_SPACING_MS, resourceKey, pause, waitVisible } from './requestControl';
import { noteRateLimit, requestPauseUntil, retryDeadline } from './rateNotice';

export const API_BASE = (import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE || '/v1').replace(/\/$/, '');
export const MOCKS = import.meta.env.VITE_MOCKS === '1';
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface ApiOptions { method?: string; body?: unknown; signal?: AbortSignal; keepalive?: boolean; background?: boolean }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}, readonly retryAt = 0) {
    super(message);
    this.name = 'ApiError';
  }
}
const statusCode = (status: number): ErrorCode => ({
  400: 'bad_request', 401: 'wallet_auth_required', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 402: 'payment_required', 429: 'rate_limited',
} as Record<number, ErrorCode>)[status] ?? 'internal_error';

export function apiUrl(base: string, path: string) {
  const root = base.replace(/\/$/, '');
  return path.startsWith('/api/') ? path : path.startsWith('/v2/') ? `${root.replace(/\/v1$/, '')}${path}` : `${root}/${path.replace(/^\/?v1\//, '').replace(/^\//, '')}`;
}

export function createApi(base = API_BASE, transport: FetchTransport = (url, init) => fetch(url, init), control = new RequestControl()) {
  async function send(path: string, opts: ApiOptions = {}): Promise<unknown> {
    const legacy = path.startsWith('/api/');
    const url = apiUrl(base, path);
    let res: Response;
    try {
      res = await transport(url, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'include', cache: 'no-store', signal: opts.signal, ...(opts.keepalive ? { keepalive: true } : {}),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      setApiUnavailable(true);
      throw new ApiError(0, legacy ? 'network' : 'internal_error', 'Cannot reach the EKO server. Check your connection.');
    }
    let retryAt = res.status === 429 ? retryDeadline(res.headers.get('retry-after')) : 0;
    let body: unknown;
    try { const text = await res.text(); body = text ? JSON.parse(text) : {}; }
    catch { if (retryAt) noteRateLimit(retryAt); setApiUnavailable(res.status >= 500); throw new ApiError(res.status, res.ok ? 'internal_error' : statusCode(res.status), 'Invalid server response.', {}, retryAt); }
    if (retryAt) {
      if (!res.headers.has('retry-after') && body && typeof body === 'object' && 'retryAfterSec' in body && typeof body.retryAfterSec === 'number') retryAt = retryDeadline(String(body.retryAfterSec));
      noteRateLimit(retryAt);
    }
    const parsed = res.ok ? null : ApiErrorSchema.safeParse(body);
    // A 5xx that names a product state (trading_paused, sim_unavailable, stale_data…) came from a reachable
    // server, so it must not raise the global "Cannot reach EKO" banner; bare or internal 5xx still do.
    setApiUnavailable(res.status >= 500 && !(parsed?.success && parsed.data.error !== 'internal_error'));
    if (!res.ok && parsed) {
      const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      // Legacy codes are required by the retained trade flow; new responses use ErrorCode.
      const code = res.status === 429 ? 'rate_limited' : parsed.success ? parsed.data.error : legacy && typeof raw.error === 'string' ? raw.error : statusCode(res.status);
      throw new ApiError(res.status, code, parsed.success ? parsed.data.message : typeof raw.message === 'string' ? raw.message : `Request failed (${res.status})`, raw, retryAt);
    }
    return body;
  }
  async function request(path: string, opts: ApiOptions = {}, validate?: (value: unknown) => void): Promise<unknown> {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    // Quotes are read operations. Never replay sign-in, orders or other mutations.
    const quote = /\/(trade\/quote|api\/quotes)$/.test(path);
    if (method !== 'GET' && !quote && !opts.background) return send(path, opts);
    const key = resourceKey(apiUrl(base, path)) + (quote || opts.background ? JSON.stringify(opts.body) : '');
    const market = /\/(coins|pairs|radar|feed|ghost-reports)(\/|\?|$)/.test(path);
    return control.run(key, async signal => {
      const read = async () => { const result = await send(path, { ...opts, signal }); validate?.(result); return result; };
      try { return await read(); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || (method !== 'GET' && !quote)) throw error;
        await pause(Math.max(0, error.retryAt - Date.now()), signal);
        await waitVisible(signal);
        await control.admission(signal);
        return read();
      }
    }, opts.signal, market ? MARKET_SPACING_MS : 1000);
  }
  return {
    request,
    async parse<T>(path: string, schema: z.ZodType<T>, opts?: ApiOptions): Promise<T> {
      const parsed = schema.safeParse(await request(path, opts, value => {
        if (!schema.safeParse(value).success) throw new ApiError(502, 'internal_error', 'The server response did not match the shared contract.');
      }));
      if (!parsed.success) throw new ApiError(502, 'internal_error', 'The server response did not match the shared contract.');
      return parsed.data;
    },
  };
}
const client = createApi(API_BASE, async (url, init) => (import.meta.env.DEV ? MOCKS : import.meta.env.VITE_MOCKS === '1')
  ? (await import('../mocks/transport')).mockFetch(url, init)
  : fetch(url, init), new RequestControl(requestPauseUntil));
export const fetchParsed = client.parse;
/** Compatibility entry point for retained trading helpers. New APIs use fetchParsed. */
export async function api<T>(path: string, opts?: ApiOptions): Promise<T> { return await client.request(path, opts) as T; }

export const isRateLimited = (error: unknown) => error instanceof ApiError && error.status === 429;
