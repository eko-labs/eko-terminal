import type { ProviderId } from '@eko/shared';
import type { AIProvider, InferenceRequest, InferenceResult } from '../types.js';
import { ProviderError, fetchJson, parseJsonText } from '../types.js';

interface ChatBody {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_details?: { upstream_inference_cost?: number } };
}

/**
 * How JSON output is requested:
 *  json_schema — response_format json_schema (strict), where supported;
 *  json_object — JSON mode, schema given in the prompt;
 *  prompt      — no response_format at all, schema given in the prompt.
 * The server-side validator checks the result in every case.
 */
export type JsonMode = 'json_schema' | 'json_object' | 'prompt';

const NEXT_MODE: Record<JsonMode, JsonMode | null> = { json_schema: 'json_object', json_object: 'prompt', prompt: null };

export interface ChatOptions {
  extraBody?: Record<string, unknown>;
  route?: 'direct' | 'gateway';
  /** Gateway label shown to users, e.g. "PPQ". */
  via?: string | null;
  /**
   * Gateways route to many upstream models and not all accept every response_format.
   * When set, a 400 about the output format falls back json_schema → json_object → prompt,
   * and the mode that worked is remembered per model.
   */
  formatFallback?: boolean;
}

/**
 * A rejection caused by the requested output format rather than a bad key or model: a 400/422
 * about response_format, or a router 404 whose endpoints were all filtered out by parameters
 * (PPQ answers "No endpoints found for … Filter by Parameters …" when json_schema is unsupported).
 */
export function formatRejected(e: ProviderError): boolean {
  if (e.code !== 'bad_request') return false;
  if (e.opts.status === 404) return /no endpoints found|filter by parameters/i.test(e.message);
  if (/response_format|json_schema|json_object|structured|schema/i.test(e.message)) return true;
  return !/model/i.test(e.message);
}

/** PPQ bills upstream cost plus 5.5% (its catalog prices are upstream × 1.055). */
const GATEWAY_MARKUP = 1.055;

/**
 * OpenAI-compatible Chat Completions (DeepSeek, Mistral, Groq, OpenRouter and the AI gateway).
 */
export class ChatCompletionsProvider implements AIProvider {
  readonly configured: boolean;
  readonly route: 'direct' | 'gateway';
  readonly via: string | null;
  private learned = new Map<string, JsonMode>();

  constructor(
    readonly id: ProviderId,
    readonly name: string,
    private url: string,
    private apiKey: string | undefined,
    readonly defaultModel: string,
    private mode: JsonMode,
    private opts: ChatOptions = {},
  ) {
    this.configured = Boolean(apiKey);
    this.route = opts.route ?? 'direct';
    this.via = opts.via ?? null;
  }

  /** Mode currently used for a model (after any fallback). */
  modeFor(model: string): JsonMode {
    return this.learned.get(model) ?? this.mode;
  }

  async infer(req: InferenceRequest): Promise<InferenceResult> {
    if (!this.apiKey) throw new ProviderError('unconfigured', `${this.name} API key not configured`);
    const t0 = performance.now();
    const deadline = Date.now() + req.timeoutMs;
    let mode = this.modeFor(req.model);
    for (;;) {
      let body: ChatBody;
      try {
        body = await this.call(req, mode, Math.max(1000, deadline - Date.now()));
      } catch (err) {
        const next = NEXT_MODE[mode];
        if (!this.opts.formatFallback || !next || !(err instanceof ProviderError) || !formatRejected(err) || deadline - Date.now() < 2000) throw err;
        mode = next;
        continue;
      }
      if (this.opts.formatFallback) this.learned.set(req.model, mode);
      const choice = body.choices?.[0];
      const upstream = body.usage?.cost_details?.upstream_inference_cost;
      if (choice?.message?.refusal) throw new ProviderError('refused', `${this.name}: model refused`, { retryable: false });
      if (choice?.finish_reason === 'length') throw new ProviderError('truncated', `${this.name}: output truncated`, { retryable: false });
      return {
        output: parseJsonText(this.name, choice?.message?.content),
        model: body.model ?? req.model,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        latencyMs: performance.now() - t0,
        costUsd: this.route === 'gateway' && typeof upstream === 'number' && Number.isFinite(upstream) && upstream >= 0 ? upstream * GATEWAY_MARKUP : null,
      };
    }
  }

  private async call(req: InferenceRequest, mode: JsonMode, timeoutMs: number): Promise<ChatBody> {
    const response_format =
      mode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } }
        : mode === 'json_object'
          ? { type: 'json_object' }
          : undefined;
    const system = mode === 'json_schema' ? req.system : `${req.system}\n\nReturn ONLY a json object (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(req.schema)}`;
    return (await fetchJson(
      this.name,
      this.url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: req.user },
          ],
          ...(response_format ? { response_format } : {}),
          max_tokens: req.maxOutputTokens ?? 4096,
          ...this.opts.extraBody,
        }),
      },
      timeoutMs,
    )) as ChatBody;
  }
}
