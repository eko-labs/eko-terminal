import type { AIProvider, InferenceRequest, InferenceResult } from '../types.js';
import { ProviderError, fetchJson, parseJsonText } from '../types.js';

interface GeminiBody {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

/** Gemini API generateContent with generationConfig.responseFormat (JSON Schema). */
export class GeminiProvider implements AIProvider {
  readonly id = 'google' as const;
  readonly name = 'Google Gemini';
  readonly configured: boolean;
  constructor(
    private apiKey: string | undefined,
    readonly defaultModel = 'gemini-3.8-flash',
  ) {
    this.configured = Boolean(apiKey);
  }

  async infer(req: InferenceRequest): Promise<InferenceResult> {
    if (!this.apiKey) throw new ProviderError('unconfigured', 'Gemini API key not configured');
    const t0 = performance.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    const body = (await fetchJson(
      this.name,
      url,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: { responseFormat: { text: { mimeType: 'application/json', schema: req.schema } } },
        }),
      },
      req.timeoutMs,
    )) as GeminiBody;
    if (body.promptFeedback?.blockReason) throw new ProviderError('refused', `Gemini: prompt blocked (${body.promptFeedback.blockReason})`, { retryable: false });
    const cand = body.candidates?.[0];
    if (cand?.finishReason === 'MAX_TOKENS') throw new ProviderError('truncated', 'Gemini: output truncated', { retryable: false });
    if (cand?.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason))
      throw new ProviderError('refused', `Gemini: generation stopped (${cand.finishReason})`, { retryable: false });
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    const u = body.usageMetadata;
    return {
      output: parseJsonText(this.name, text),
      model: body.modelVersion ?? req.model,
      inputTokens: u?.promptTokenCount ?? null,
      outputTokens: u ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : null,
      latencyMs: performance.now() - t0,
    };
  }
}
