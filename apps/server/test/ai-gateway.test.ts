import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry, gatewayChatUrl, gatewayLabel } from '../src/ai/registry.js';
import { ChatCompletionsProvider } from '../src/ai/providers/chat.js';
import { AnthropicProvider } from '../src/ai/providers/anthropic.js';
import { estimateCost } from '../src/ai/budget.js';
import { ProviderError } from '../src/ai/types.js';

const env = (extra: Record<string, string>) => loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'z'.repeat(40), ...extra } as NodeJS.ProcessEnv);
const req = { system: 's', user: 'u', schema: { type: 'object' }, schemaName: 'trading_signal', model: 'm', timeoutMs: 5000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI gateway provider selection (no network)', () => {
  it('serves every provider without a direct key through the gateway, keeping direct keys direct', () => {
    const reg = new ProviderRegistry(env({ GATEWAY_API_KEY: 'test-gateway-key-123', ANTHROPIC_API_KEY: 'direct-key', GATEWAY_MODEL_OPENAI: 'gpt-6-astra-pro' }));
    expect(reg.get('anthropic')).toBeInstanceOf(AnthropicProvider);
    expect(reg.route('anthropic')).toEqual({ route: 'direct', via: null, model: 'claude-opus-5' });
    expect(reg.route('openai')).toEqual({ route: 'gateway', via: 'PPQ', model: 'gpt-6-astra-pro' });
    expect(reg.route('google')).toEqual({ route: 'gateway', via: 'PPQ', model: 'google/gemini-3.8-flash' });
    expect(reg.route('xai')).toEqual({ route: 'gateway', via: 'PPQ', model: 'grok-4.6' });
    expect(reg.route('deepseek')).toEqual({ route: 'gateway', via: 'PPQ', model: 'deepseek/deepseek-v4.1-flash' });
    // OpenRouter is itself a router: never proxied through the gateway.
    expect(reg.route('openrouter').route).toBeNull();
    expect(reg.gateway).toMatchObject({ configured: true, via: 'PPQ' });
    const health = reg.healthList();
    expect(health.find((h) => h.id === 'openai')).toMatchObject({ configured: true, status: 'ok', route: 'gateway', via: 'PPQ' });
    expect(health.find((h) => h.id === 'openrouter')).toMatchObject({ configured: false, status: 'unconfigured', route: null });
  });

  it('uses Claude via the gateway by default and maps pinned direct-only models to the gateway default', () => {
    const reg = new ProviderRegistry(env({ GATEWAY_API_KEY: 'test-gateway-key-123' }));
    expect(reg.route('anthropic')).toEqual({ route: 'gateway', via: 'PPQ', model: 'claude-sonnet-5' });
    expect((reg.get('anthropic') as ChatCompletionsProvider).modeFor('claude-sonnet-5')).toBe('json_object');
    expect(reg.modelFor('openai', null)).toBe('gpt-5.6-sol');
    expect(reg.modelFor('openai', 'gpt-6-luna')).toBe('gpt-5.6-sol');
    expect(reg.modelFor('anthropic', 'claude-opus-5')).toBe('claude-opus-5');
  });

  it('without any key nothing is configured', () => {
    const reg = new ProviderRegistry(env({}));
    expect(reg.gateway.configured).toBe(false);
    expect(reg.healthList().every((h) => !h.configured && h.route === null)).toBe(true);
  });

  it('builds the chat URL and label from the base URL', () => {
    expect(gatewayChatUrl('https://api.ppq.ai')).toBe('https://api.ppq.ai/v1/chat/completions');
    expect(gatewayChatUrl('https://api.ppq.ai/')).toBe('https://api.ppq.ai/v1/chat/completions');
    expect(gatewayChatUrl('https://gw.example.com/v1')).toBe('https://gw.example.com/v1/chat/completions');
    expect(gatewayLabel('https://api.ppq.ai')).toBe('PPQ');
    expect(gatewayLabel('https://api.example.com')).toBe('example.com');
  });

  it('prices gateway models from the gateway catalog', () => {
    // claude-sonnet-5 via PPQ: $2.11 in / $10.55 out per MTok.
    expect(estimateCost('anthropic', 'claude-sonnet-5', 1_000_000, 0, 'gateway')).toBeCloseTo(2.11, 6);
    expect(estimateCost('anthropic', 'claude-sonnet-5', 1_000_000, 0, 'direct')).toBeCloseTo(2, 6);
    expect(estimateCost('google', 'google/gemini-3.8-flash', 0, 1_000_000, 'gateway')).toBeCloseTo(1.875, 6);
    // Unknown models use the pessimistic fallback.
    expect(estimateCost('openai', 'mystery-model', 1_000_000, 0)).toBe(15);
  });
});

describe('gateway structured-output fallback', () => {
  const okBody = (content: string) => ({
    model: 'anthropic/claude-sonnet-5',
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost_details: { upstream_inference_cost: 0.001 } },
  });

  it('falls back json_schema → json_object when the router finds no endpoint for the parameters, and remembers it', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(b);
      const rf = b.response_format as { type: string } | undefined;
      if (rf?.type === 'json_schema')
        return new Response(JSON.stringify({ error: { message: 'No endpoints found for anthropic/claude-sonnet-5. Filter by Parameters removed amazon-bedrock/global' }, user_id: 'org_secret' }), { status: 404 });
      return new Response(`  \n${JSON.stringify(okBody('{"action":"abstain"}'))}`, { status: 200 });
    });
    const p = new ChatCompletionsProvider('anthropic', 'Anthropic', 'https://api.ppq.ai/v1/chat/completions', 'k', 'claude-sonnet-5', 'json_schema', { route: 'gateway', via: 'PPQ', formatFallback: true });
    const r = await p.infer({ ...req, model: 'claude-sonnet-5' });
    expect(r.output).toEqual({ action: 'abstain' });
    expect(r.costUsd).toBeCloseTo(0.001055, 9);
    expect(bodies.map((b) => (b.response_format as { type: string } | undefined)?.type)).toEqual(['json_schema', 'json_object']);
    expect(String((bodies[1]!.messages as { content: string }[])[0]!.content)).toMatch(/JSON Schema/);
    expect(p.modeFor('claude-sonnet-5')).toBe('json_object');
    await p.infer({ ...req, model: 'claude-sonnet-5' });
    expect(bodies).toHaveLength(3);
  });

  it('falls back to a prompt-only request when JSON mode is rejected too', async () => {
    const types: (string | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { response_format?: { type: string } };
      types.push(b.response_format?.type);
      if (b.response_format) return new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 });
      return new Response(JSON.stringify(okBody('```json\n{"action":"hold"}\n```')), { status: 200 });
    });
    const p = new ChatCompletionsProvider('xai', 'xAI', 'https://api.ppq.ai/v1/chat/completions', 'k', 'grok-4.6', 'json_schema', { route: 'gateway', formatFallback: true });
    const r = await p.infer({ ...req, model: 'grok-4.6' });
    expect(r.output).toEqual({ action: 'hold' });
    expect(types).toEqual(['json_schema', 'json_object', undefined]);
  });

  it('does not mask auth errors or missing models as format problems, and redacts account ids', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"invalid api key"},"user_id":"org_abc"}', { status: 401 }));
    const p = new ChatCompletionsProvider('openai', 'OpenAI', 'https://api.ppq.ai/v1/chat/completions', 'k', 'gpt-5.6-sol', 'json_schema', { route: 'gateway', formatFallback: true });
    await expect(p.infer({ ...req, model: 'gpt-5.6-sol' })).rejects.toMatchObject({ code: 'auth' });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"error":{"message":"The model nope does not exist"},"user_id":"org_abc"}', { status: 400 });
    });
    const err = (await p.infer({ ...req, model: 'nope' }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe('bad_request');
    expect(calls).toBe(1);
    expect(err.message).not.toMatch(/org_abc/);
  });
});

describe('mainnet configuration guards', () => {
  it('refuses live trading in production with a localhost SIWE origin', () => {
    const prod = { DATABASE_URL: 'postgresql://example.invalid/fixture', RUN_WORKER: 'false', BURN_WALLET_ADDRESS: `0x${'1'.repeat(40)}`, DEMO_SECRET: 'demo-test-placeholder'.repeat(2), NODE_ENV: 'production', MARKET_DATA_SOURCE: 'demo', SESSION_SECRET: 's'.repeat(40), LIVE_TRADING_ENABLED: 'true' };
    expect(() => loadConfig(prod as NodeJS.ProcessEnv)).toThrow(/PUBLIC_ORIGIN/);
    expect(loadConfig({ ...prod, PUBLIC_ORIGIN: 'https://eko.example' } as NodeJS.ProcessEnv).LIVE_TRADING_ENABLED).toBe(true);
    expect(loadConfig({ ...prod, LIVE_TRADING_ENABLED: 'false' } as NodeJS.ProcessEnv).LIVE_TRADING_ENABLED).toBe(false);
  });

  it('tolerates an empty GATEWAY_BASE_URL and defaults to PPQ', () => {
    expect(env({ GATEWAY_BASE_URL: '' }).GATEWAY_BASE_URL).toBe('https://api.ppq.ai');
  });
});
