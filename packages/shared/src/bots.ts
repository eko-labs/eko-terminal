import type { ParamSpec, StrategyCategory } from './strategies.js';

// ───────────────────────────── AI providers ─────────────────────────────

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'mistral' | 'groq' | 'openrouter';

export interface ModelInfo {
  id: string;
  label: string;
  tier: 'fast' | 'balanced' | 'flagship';
  /** USD per 1M tokens. null = not verified; budgets then use a conservative fallback. */
  inputPerM: number | null;
  outputPerM: number | null;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  envKey: string;
  docsUrl: string;
  /** How structured output is enforced for this provider. */
  structuredOutput: string;
  models: ModelInfo[];
}

/** Model IDs and prices verified against provider docs on 2026-09-28. */
export const AI_PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://platform.claude.com/docs/en/build-with-claude/structured-outputs',
    structuredOutput: 'output_config.format (JSON Schema), official SDK',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'flagship', inputPerM: 5, outputPerM: 25 },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'flagship', inputPerM: 4, outputPerM: 20 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'balanced', inputPerM: 2, outputPerM: 10 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast', inputPerM: 1, outputPerM: 5 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    docsUrl: 'https://developers.openai.com/api/docs/guides/structured-outputs',
    structuredOutput: 'Responses API text.format json_schema (strict)',
    models: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', tier: 'fast', inputPerM: 0.1, outputPerM: 0.5 },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', tier: 'balanced', inputPerM: 2, outputPerM: 10 },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'flagship', inputPerM: 10, outputPerM: 50 },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    envKey: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/generate-content/structured-output',
    structuredOutput: 'generateContent responseFormat JSON Schema',
    models: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast', inputPerM: null, outputPerM: null },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'balanced', inputPerM: null, outputPerM: null },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    envKey: 'XAI_API_KEY',
    docsUrl: 'https://docs.x.ai/developers/model-capabilities/text/structured-outputs',
    structuredOutput: 'Responses API text.format json_schema (strict)',
    models: [
      { id: 'grok-4.3', label: 'Grok 4.3', tier: 'fast', inputPerM: 1.25, outputPerM: 2.5 },
      { id: 'grok-4.7', label: 'Grok 4.7', tier: 'flagship', inputPerM: 2, outputPerM: 6 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/guides/json_mode',
    structuredOutput: 'JSON mode (json_object) + server-side schema validation',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', tier: 'fast', inputPerM: null, outputPerM: null },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'flagship', inputPerM: null, outputPerM: null },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    docsUrl: 'https://docs.mistral.ai/studio/conversations/structured-output/custom',
    structuredOutput: 'Chat Completions response_format json_schema (strict)',
    models: [
      { id: 'mistral-small-2603', label: 'Mistral Small 4', tier: 'fast', inputPerM: 0.15, outputPerM: 0.6 },
      { id: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', tier: 'flagship', inputPerM: 1.5, outputPerM: 7.5 },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    docsUrl: 'https://console.groq.com/docs/structured-outputs',
    structuredOutput: 'Chat Completions json_schema strict (supported models only)',
    models: [{ id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (Groq)', tier: 'balanced', inputPerM: null, outputPerM: null }],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/docs/guides/features/structured-outputs',
    structuredOutput: 'Chat Completions json_schema with provider.require_parameters',
    models: [],
  },
];

export const PROVIDER_BY_ID: Record<ProviderId, ProviderInfo> = Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p])) as Record<
  ProviderId,
  ProviderInfo
>;

// ───────────────────────────── AI gateway ─────────────────────────────

/**
 * One OpenAI-compatible gateway key (PPQ.ai by default) can serve every provider that has no
 * direct key. Model ids and USD prices (gateway prices, markup included) are taken from PPQ's
 * live catalog snapshot of 2026-09-28; the gateway may change them.
 */
export const GATEWAY_DEFAULT_BASE_URL = 'https://api.ppq.ai';

export const GATEWAY_MODELS: (ModelInfo & { provider: ProviderId })[] = [
  { provider: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'balanced', inputPerM: 2.11, outputPerM: 10.55 },
  { provider: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'flagship', inputPerM: 5.275, outputPerM: 26.375 },
  { provider: 'anthropic', id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', tier: 'fast', inputPerM: 1.055, outputPerM: 5.275 },
  { provider: 'openai', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'balanced', inputPerM: 2.11, outputPerM: 10.55 },
  { provider: 'openai', id: 'gpt-6-astra-pro', label: 'GPT-6 Astra Pro', tier: 'flagship', inputPerM: 10.55, outputPerM: 52.75 },
  { provider: 'openai', id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'fast', inputPerM: 0.1055, outputPerM: 0.633 },
  { provider: 'google', id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'balanced', inputPerM: 0.375, outputPerM: 1.875 },
  { provider: 'google', id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast', inputPerM: 0.15, outputPerM: 1.25 },
  { provider: 'xai', id: 'grok-4.6', label: 'Grok 4.6', tier: 'flagship', inputPerM: 2.11, outputPerM: 6.33 },
  { provider: 'xai', id: 'x-ai/grok-4.3', label: 'Grok 4.3', tier: 'fast', inputPerM: 1.31875, outputPerM: 2.6375 },
  { provider: 'deepseek', id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', tier: 'fast', inputPerM: 0.2321, outputPerM: 0.6963 },
  { provider: 'deepseek', id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'flagship', inputPerM: 0.44552439, outputPerM: 0.89104878 },
  { provider: 'mistral', id: 'mistralai/mistral-small-2603', label: 'Mistral Small 4', tier: 'fast', inputPerM: 0.15825, outputPerM: 0.633 },
  { provider: 'mistral', id: 'mistralai/mistral-medium-3-5', label: 'Mistral Medium 3.5', tier: 'flagship', inputPerM: 1.5825, outputPerM: 7.9125 },
  { provider: 'groq', id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', tier: 'balanced', inputPerM: 0.15825, outputPerM: 0.633 },
];

/** Model used per provider when it is served through the gateway (override with GATEWAY_MODEL_<PROVIDER>). */
export const GATEWAY_DEFAULT_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  google: 'google/gemini-3.8-flash',
  xai: 'grok-4.6',
  deepseek: 'deepseek/deepseek-v4.1-flash',
  mistral: 'mistralai/mistral-small-2603',
  groq: 'openai/gpt-oss-120b',
};

/** Price entry for a model id on the route it is called through, if known. */
export function modelInfo(provider: ProviderId, model: string, route: 'direct' | 'gateway' = 'direct'): ModelInfo | undefined {
  const direct = PROVIDER_BY_ID[provider]?.models.find((m) => m.id === model);
  const gateway = GATEWAY_MODELS.find((m) => m.id === model);
  return route === 'gateway' ? (gateway ?? direct) : (direct ?? gateway);
}

/** Model ids a bot may pin for a provider (direct catalog plus gateway catalog). */
export function allowedModels(provider: ProviderId): string[] {
  return [...(PROVIDER_BY_ID[provider]?.models.map((m) => m.id) ?? []), ...GATEWAY_MODELS.filter((m) => m.provider === provider).map((m) => m.id)];
}

/** Used when a model's price is not verified — deliberately pessimistic so budgets err on the safe side. */
export const FALLBACK_PRICE_PER_M = { input: 15, output: 75 };

export interface StrategyMeta {
  id: string;
  version: string;
  name: string;
  category: StrategyCategory;
  summary: string;
  description: string;
  params: ParamSpec[];
  dataInputs: string[];
}
