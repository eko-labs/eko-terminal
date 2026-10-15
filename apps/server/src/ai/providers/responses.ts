import type { ProviderId } from '@eko/shared';
import type { AIProvider, InferenceRequest, InferenceResult } from '../types.js';
import { ProviderError, fetchJson, parseJsonText } from '../types.js';

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string };
  model?: string;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * OpenAI-style Responses API (`POST /v1/responses`) — used for OpenAI and xAI.
 * Structured output: text.format = { type: "json_schema", strict: true }.
 * store:false so prompts/outputs are not retained by the provider's response store.
 */
export class ResponsesProvider implements AIProvider {
  readonly configured: boolean;
  constructor(
    readonly id: ProviderId,
    readonly name: string,
    private baseUrl: string,
    private apiKey: string | undefined,
    readonly defaultModel: string,
  ) {
    this.configured = Boolean(apiKey);
  }

  async infer(req: InferenceRequest): Promise<InferenceResult> {
    if (!this.apiKey) throw new ProviderError('unconfigured', `${this.name} API key not configured`);
    const t0 = performance.now();
    const body = (await fetchJson(
      this.name,
      `${this.baseUrl}/responses`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          store: false,
          input: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          text: { format: { type: 'json_schema', name: req.schemaName, strict: true, schema: req.schema } },
        }),
      },
      req.timeoutMs,
    )) as ResponsesBody;
    if (body.status === 'incomplete') {
      throw new ProviderError('truncated', `${this.name}: incomplete response (${body.incomplete_details?.reason ?? 'unknown'})`, { retryable: false });
    }
    const message = body.output?.find((o) => o.type === 'message');
    const refusal = message?.content?.find((c) => c.type === 'refusal');
    if (refusal) throw new ProviderError('refused', `${this.name}: model refused`, { retryable: false });
    const text = message?.content?.find((c) => c.type === 'output_text')?.text;
    return {
      output: parseJsonText(this.name, text),
      model: body.model ?? req.model,
      inputTokens: body.usage?.input_tokens ?? null,
      outputTokens: body.usage?.output_tokens ?? null,
      latencyMs: performance.now() - t0,
    };
  }
}
