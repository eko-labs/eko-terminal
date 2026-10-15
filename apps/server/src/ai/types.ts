import type { ProviderId } from '@eko/shared';

export interface InferenceRequest {
  system: string;
  user: string;
  /** JSON Schema the output must satisfy (also validated server-side with zod). */
  schema: Record<string, unknown>;
  schemaName: string;
  model: string;
  timeoutMs: number;
  /** Optional hard output ceiling for capped consumers such as Swarm. */
  maxOutputTokens?: number;
}

export interface InferenceResult {
  /** Parsed JSON object returned by the model (still untrusted — validate before use). */
  output: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** Actual USD cost when the provider reports it (gateway usage accounting). */
  costUsd?: number | null;
}

export type ProviderErrorCode =
  | 'unconfigured'
  | 'rate_limited'
  | 'overloaded'
  | 'auth'
  | 'quota'
  | 'bad_request'
  | 'refused'
  | 'truncated'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly opts: { status?: number; retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.opts.retryable ?? ['rate_limited', 'overloaded', 'timeout', 'network'].includes(this.code);
  }
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly defaultModel: string;
  /** 'gateway' when served through the shared AI gateway; direct otherwise. */
  readonly route?: 'direct' | 'gateway';
  readonly via?: string | null;
  infer(req: InferenceRequest): Promise<InferenceResult>;
}

/** Map an HTTP failure to a typed provider error. */
export function httpError(provider: string, status: number, body: string, headers: Headers): ProviderError {
  const ra = headers.get('retry-after');
  const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : undefined;
  // Router errors can carry account identifiers; never surface them.
  const snippet = body.replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"[redacted]"').slice(0, 400);
  const quota = /credit|quota|spend[_ ]limit|billing|insufficient/i.test(body);
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider}: authentication failed (${status})`, { status });
  if (status === 402 || (status === 429 && quota)) return new ProviderError('quota', `${provider}: quota or billing limit reached`, { status, retryable: false });
  if (status === 429) return new ProviderError('rate_limited', `${provider}: rate limited`, { status, retryAfterMs });
  if (status === 529 || status === 503 || status === 502 || status === 500 || status === 504)
    return new ProviderError('overloaded', `${provider}: service unavailable (${status})`, { status, retryAfterMs });
  if (status === 400 || status === 404 || status === 422) return new ProviderError('bad_request', `${provider}: request rejected (${status}): ${snippet}`, { status });
  return new ProviderError('unknown', `${provider}: HTTP ${status}: ${snippet}`, { status });
}

export async function fetchJson(provider: string, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new ProviderError('timeout', `${provider}: timed out after ${timeoutMs} ms`);
    throw new ProviderError('network', `${provider}: network error: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw httpError(provider, res.status, text, res.headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('parse', `${provider}: response was not JSON`);
  }
}

export function parseJsonText(provider: string, text: string | undefined | null): unknown {
  if (!text || !text.trim()) throw new ProviderError('parse', `${provider}: empty response content`);
  try {
    return JSON.parse(text);
  } catch {
    // Some JSON-mode providers wrap output in a code fence.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    throw new ProviderError('parse', `${provider}: model output was not valid JSON`);
  }
}
