import { AI_PROVIDERS, GATEWAY_DEFAULT_MODELS, GATEWAY_MODELS, PROVIDER_BY_ID, type ProviderHealth, type ProviderId } from '@eko/shared';
import type { Config } from '../config.js';
import { metrics } from '../obs/metrics.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { ChatCompletionsProvider } from './providers/chat.js';
import { GeminiProvider } from './providers/gemini.js';
import { ResponsesProvider } from './providers/responses.js';
import { ProviderError, type AIProvider, type InferenceRequest, type InferenceResult } from './types.js';

/** `${base}/v1/chat/completions`, tolerating a base that already ends in /v1. */
export function gatewayChatUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/** Short display name for a gateway host: api.ppq.ai → "PPQ". */
export function gatewayLabel(base: string): string {
  let host = base;
  try {
    host = new URL(base).hostname;
  } catch {
    /* keep raw */
  }
  if (/(^|\.)ppq\.ai$/i.test(host)) return 'PPQ';
  return host.replace(/^api\./i, '');
}

/** Providers the gateway may stand in for (OpenRouter is itself a router and stays direct-only). */
const GATEWAY_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'mistral', 'groq'];

function gatewayModel(cfg: Config, id: ProviderId): string {
  const override: Partial<Record<ProviderId, string | undefined>> = {
    anthropic: cfg.GATEWAY_MODEL_ANTHROPIC,
    openai: cfg.GATEWAY_MODEL_OPENAI,
    google: cfg.GATEWAY_MODEL_GOOGLE,
    xai: cfg.GATEWAY_MODEL_XAI,
    deepseek: cfg.GATEWAY_MODEL_DEEPSEEK,
    mistral: cfg.GATEWAY_MODEL_MISTRAL,
    groq: cfg.GATEWAY_MODEL_GROQ,
  };
  return override[id] || GATEWAY_DEFAULT_MODELS[id] || 'openai/gpt-oss-120b';
}

interface HealthState {
  lastError: string | null;
  lastErrorAt: number | null;
  lastLatencyMs: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  /** Circuit breaker: skip calls until this time after repeated failures. */
  openUntil: number;
}

export class ProviderRegistry {
  readonly providers = new Map<ProviderId, AIProvider>();
  private health = new Map<ProviderId, HealthState>();
  onHealthChange: (() => void) | null = null;

  readonly gateway: { configured: boolean; baseUrl: string; via: string };

  constructor(cfg: Config) {
    const gw = cfg.GATEWAY_API_KEY?.trim();
    this.gateway = { configured: Boolean(gw), baseUrl: cfg.GATEWAY_BASE_URL, via: gatewayLabel(cfg.GATEWAY_BASE_URL) };
    const add = (direct: AIProvider) => {
      let p = direct;
      if (!direct.configured && gw && GATEWAY_PROVIDERS.includes(direct.id)) {
        // PPQ routes Claude to endpoints without json_schema support (verified 2026-09-28), so start at JSON mode.
        const mode = direct.id === 'anthropic' ? 'json_object' : 'json_schema';
        p = new ChatCompletionsProvider(direct.id, PROVIDER_BY_ID[direct.id].name, gatewayChatUrl(cfg.GATEWAY_BASE_URL), gw, gatewayModel(cfg, direct.id), mode, {
          route: 'gateway',
          via: this.gateway.via,
          formatFallback: true,
        });
      }
      this.providers.set(p.id, p);
      this.health.set(p.id, { lastError: null, lastErrorAt: null, lastLatencyMs: null, lastSuccessAt: null, consecutiveFailures: 0, openUntil: 0 });
    };
    add(new AnthropicProvider(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL ?? 'claude-opus-5'));
    add(new ResponsesProvider('openai', 'OpenAI', 'https://api.openai.com/v1', cfg.OPENAI_API_KEY, cfg.OPENAI_MODEL ?? 'gpt-6-luna'));
    add(new GeminiProvider(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL ?? 'gemini-3.8-flash'));
    add(new ResponsesProvider('xai', 'xAI', 'https://api.x.ai/v1', cfg.XAI_API_KEY, cfg.XAI_MODEL ?? 'grok-4.3'));
    add(new ChatCompletionsProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com/chat/completions', cfg.DEEPSEEK_API_KEY, cfg.DEEPSEEK_MODEL ?? 'deepseek-flash', 'json_object'));
    add(new ChatCompletionsProvider('mistral', 'Mistral', 'https://api.mistral.ai/v1/chat/completions', cfg.MISTRAL_API_KEY, cfg.MISTRAL_MODEL ?? 'mistral-small-2603', 'json_schema'));
    add(new ChatCompletionsProvider('groq', 'Groq', 'https://api.groq.com/openai/v1/chat/completions', cfg.GROQ_API_KEY, cfg.GROQ_MODEL ?? 'openai/gpt-oss-120b', 'json_schema'));
    add(
      new ChatCompletionsProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', cfg.OPENROUTER_API_KEY, cfg.OPENROUTER_MODEL ?? 'openai/gpt-oss-120b', 'json_schema', {
        extraBody: { provider: { require_parameters: true } },
      }),
    );
  }

  get(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  isConfigured(id: ProviderId): boolean {
    return this.providers.get(id)?.configured ?? false;
  }

  /** Model to call for a bot: its pinned model unless the gateway does not serve that id. */
  modelFor(id: ProviderId, pinned: string | null | undefined): string {
    const p = this.providers.get(id);
    if (!p) return pinned ?? '';
    if (!pinned) return p.defaultModel;
    if (p.route === 'gateway' && !GATEWAY_MODELS.some((m) => m.id === pinned)) return p.defaultModel;
    return pinned;
  }

  /** How a provider is reached: its own key, the gateway, or not at all. */
  route(id: ProviderId): { route: 'direct' | 'gateway' | null; via: string | null; model: string | null } {
    const p = this.providers.get(id);
    if (!p?.configured) return { route: null, via: null, model: p?.defaultModel ?? null };
    return { route: p.route ?? 'direct', via: p.via ?? null, model: p.defaultModel };
  }

  /** Runs inference with at most one retry for retryable errors, inside the overall timeout. */
  async infer(id: ProviderId, req: InferenceRequest, options: { retry?: boolean } = {}): Promise<InferenceResult> {
    const p = this.providers.get(id);
    const h = this.health.get(id)!;
    if (!p || !p.configured) throw new ProviderError('unconfigured', `${id} is not configured`);
    if (Date.now() < h.openUntil) throw new ProviderError('overloaded', `${p.name} circuit open after repeated failures`, { retryable: false });
    const deadline = Date.now() + req.timeoutMs;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const r = await p.infer({ ...req, timeoutMs: Math.max(1000, deadline - Date.now()) });
        h.lastLatencyMs = r.latencyMs;
        h.lastSuccessAt = Date.now();
        h.consecutiveFailures = 0;
        h.lastError = null;
        metrics.observe('ai.inference_ms', r.latencyMs, { provider: id, model: r.model });
        this.onHealthChange?.();
        return r;
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('unknown', String((err as Error)?.message ?? err));
        const wait = Math.min(e.opts.retryAfterMs ?? 1500 * attempt, 8000);
        if (options.retry !== false && attempt < 2 && e.retryable && Date.now() + wait < deadline - 1000) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        h.lastError = `${e.code}: ${e.message}`;
        h.lastErrorAt = Date.now();
        if (['rate_limited', 'overloaded', 'timeout', 'network', 'auth', 'quota'].includes(e.code)) {
          h.consecutiveFailures++;
          if (h.consecutiveFailures >= 3) h.openUntil = Date.now() + Math.min(10 * 60_000, 60_000 * 2 ** (h.consecutiveFailures - 3));
        }
        this.onHealthChange?.();
        throw e;
      }
    }
  }

  healthList(): ProviderHealth[] {
    return AI_PROVIDERS.map((info) => {
      const p = this.providers.get(info.id);
      const h = this.health.get(info.id)!;
      let status: ProviderHealth['status'] = 'ok';
      if (!p?.configured) status = 'unconfigured';
      else if (Date.now() < h.openUntil) status = 'down';
      else if (h.lastErrorAt && (!h.lastSuccessAt || h.lastErrorAt > h.lastSuccessAt)) status = 'degraded';
      return {
        id: info.id,
        name: info.name,
        configured: Boolean(p?.configured),
        status,
        lastError: h.lastError,
        lastLatencyMs: h.lastLatencyMs,
        lastSuccessAt: h.lastSuccessAt,
        ...this.route(info.id),
      };
    });
  }

  /** Test hook: force a provider into an outage state. */
  simulateOutage(id: ProviderId, ms: number) {
    const h = this.health.get(id);
    if (!h) return;
    h.openUntil = Date.now() + ms;
    h.lastError = 'overloaded: simulated outage (test hook)';
    h.lastErrorAt = Date.now();
    this.onHealthChange?.();
  }
}
