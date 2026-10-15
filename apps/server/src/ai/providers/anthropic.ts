import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, InferenceRequest, InferenceResult } from '../types.js';
import { ProviderError, parseJsonText } from '../types.js';

/**
 * Anthropic Messages API via the official SDK.
 * Structured output: output_config.format (JSON Schema). Thinking stays adaptive with
 * effort "low" (this is a short, bounded analysis). Server-side fallbacks ("default")
 * re-run a policy-declined request on Anthropic's recommended fallback model.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly name = 'Anthropic';
  readonly configured: boolean;
  private client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    readonly defaultModel = 'claude-opus-5',
  ) {
    this.configured = Boolean(apiKey);
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null;
  }

  async infer(req: InferenceRequest): Promise<InferenceResult> {
    if (!this.client) throw new ProviderError('unconfigured', 'Anthropic API key not configured');
    const t0 = performance.now();
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
        },
        { timeout: req.timeoutMs },
      );
    } catch (err) {
      throw mapSdkError(err);
    }
    if (res.stop_reason === 'refusal') throw new ProviderError('refused', 'Anthropic: request declined by safety classifiers', { retryable: false });
    if (res.stop_reason === 'max_tokens') throw new ProviderError('truncated', 'Anthropic: output truncated at max_tokens', { retryable: false });
    const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
    return {
      output: parseJsonText('Anthropic', text),
      model: res.model,
      inputTokens: res.usage.input_tokens ?? null,
      outputTokens: res.usage.output_tokens ?? null,
      latencyMs: performance.now() - t0,
    };
  }
}

function mapSdkError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError('auth', 'Anthropic: authentication failed', { status: err.status });
  if (err instanceof Anthropic.RateLimitError) {
    const ra = err.headers?.get?.('retry-after');
    // A spend-cap 429 carries no retry-after and must not be retried.
    if (!ra) return new ProviderError('quota', 'Anthropic: rate or spend limit reached', { status: 429, retryable: false });
    return new ProviderError('rate_limited', 'Anthropic: rate limited', { status: 429, retryAfterMs: Number(ra) * 1000 });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError)
    return new ProviderError('bad_request', `Anthropic: ${err.message}`, { status: err.status });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'Anthropic: request timed out');
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', `Anthropic: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 529 || status >= 500) return new ProviderError('overloaded', `Anthropic: service unavailable (${status})`, { status });
    return new ProviderError('unknown', `Anthropic: ${err.message}`, { status });
  }
  return new ProviderError('unknown', `Anthropic: ${(err as Error)?.message ?? String(err)}`);
}
