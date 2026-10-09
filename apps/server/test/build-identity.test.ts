import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { expectedConfigDigest, readBuildInfo, runtimeIdentity } from '../src/build-identity.js';
import { healthRoutes } from '../src/http/v1/health.js';
import contract from '../src/build-identity-contract.json' with { type: 'json' };
import { createHash } from 'node:crypto';

const caps = readFileSync(new URL('../config/trading-caps.yaml', import.meta.url), 'utf8');
const env = { NODE_ENV: 'test', SESSION_SECRET: 'fixture-session-secret', APP_ROLE: 'api', RUN_WORKER: 'false' };
const config = () => loadConfig(env);

it('hashes parsed defaults and equivalent representations, and detects effective changes', () => {
  const cfg = config();
  expect(expectedConfigDigest(env, caps)).toBe(runtimeIdentity(cfg).configDigest);
  expect(expectedConfigDigest({ ...env, LIVE_TRADING_ENABLED: '0', RPC_SESSION_BUDGET: '', RPC_WEIGHTS: '{}' }, caps)).toBe(runtimeIdentity(cfg).configDigest);
  for (const changed of [
    { TRADE_MAX_USD: '26' }, { TRUST_PROXY_HOPS: '1' }, { RPC_PAID_DAILY_BUDGET: '0' },
    { SERVE_WEB: 'true' }, { APP_ROLE: 'worker', RUN_WORKER: 'true' }, { FEE_BPS_DEFAULT: '1' },
  ]) expect(expectedConfigDigest({ ...env, ...changed }, caps)).not.toBe(runtimeIdentity(cfg).configDigest);
  expect(expectedConfigDigest(env, caps.replace('team: 25', 'team: 24'))).not.toBe(runtimeIdentity(cfg).configDigest);
  const first = { ...env, RPC_WEIGHTS: '{"eth_call":2,"eth_getLogs":3}' };
  const reordered = { ...env, RPC_WEIGHTS: '{"eth_getLogs":3,"eth_call":2}' };
  expect(expectedConfigDigest(first, caps)).toBe(expectedConfigDigest(reordered, caps));
});

it('never hashes secrets, credential URLs, cookie settings, paths or unknown env fields', async () => {
  const secrets = {
    SESSION_SECRET: 'changed-fixture-session-secret', DEMO_SECRET: 'fixture-demo-secret'.repeat(3),
    HARNESS_KEY_PEPPER: 'fixture-pepper'.repeat(3), JOURNAL_KEK: 'a'.repeat(64), JOURNAL_KEK_ID: 'fixture-key-id',
    DATABASE_URL: 'postgres://demo-account:fixture-password@db.invalid/sample',
    RPC_HTTP_URL: 'https://demo-account:fixture-password@rpc.invalid/?key=fixture-token',
    RPC_WS_URL: 'wss://demo-account:fixture-password@rpc.invalid/?key=fixture-token',
    RPC_PUBLIC_HTTP_URL: 'https://rpc.invalid/?key=fixture-token',
    GATEWAY_BASE_URL: 'https://demo-account:fixture-password@gateway.invalid/?key=fixture-token',
    GATEWAY_API_KEY: 'fixture-gateway-key', OPENAI_API_KEY: 'fixture-provider-key',
    ANTHROPIC_API_KEY: 'fixture-provider-key', GEMINI_API_KEY: 'fixture-provider-key',
    XAI_API_KEY: 'fixture-provider-key', DEEPSEEK_API_KEY: 'fixture-provider-key', MISTRAL_API_KEY: 'fixture-provider-key',
    GROQ_API_KEY: 'fixture-provider-key', OPENROUTER_API_KEY: 'fixture-provider-key',
    SENTRY_DSN: 'https://fixture-token@errors.invalid/1',
    PUBLIC_ORIGIN: 'https://app.other.invalid', SESSION_COOKIE_DOMAIN: 'other.invalid',
    WEB_DIST_DIR: '/fixture/other', PGLITE_DIR: '/fixture/other',
    EKO_SOURCE_REVISION: 'e'.repeat(40), UNREVIEWED_SECRET: 'fixture-unreviewed-secret',
  };
  const cfg = loadConfig({ ...env, ...secrets });
  const identity = runtimeIdentity(cfg);
  expect(identity.configDigest).toBe(runtimeIdentity(config()).configDigest);
  expect(expectedConfigDigest({ ...env, ...secrets }, caps)).toBe(identity.configDigest);
  const app = Fastify();
  try {
    await healthRoutes(app, async () => ({ day: '2026-10-03', today: [], refusedToday: 0, paidOpen: true, budgetLeft: 200000, sessionUnits: 0 }), cfg, async () => {});
    const response = await app.inject('/build');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(identity);
    expect(Object.keys(response.json()).sort()).toEqual(['build', 'configDigest', 'configVersion', 'role']);
    for (const value of Object.values(secrets)) expect(response.body).not.toContain(value);
    expect((await app.inject('/health')).json().ok).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/build' })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('reads pinned baked metadata, rejects invalid production metadata and never trusts env revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eko-build-identity-'));
  const file = pathToFileURL(join(directory, 'build-info.json'));
  const bundles = Object.fromEntries(contract.bundleFiles.map(name => [name, createHash('sha256').update(`fixture ${name}`).digest('hex')]));
  const build = { formatVersion: 1, sourceRevision: 'a'.repeat(40), bundles,
    bundleDigest: createHash('sha256').update(JSON.stringify(bundles)).digest('hex') };
  try {
    expect(() => readBuildInfo(true, file)).toThrow('Production build identity missing or invalid');
    for (const name of contract.bundleFiles) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), `fixture ${name}`);
    }
    writeFileSync(file, JSON.stringify(build));
    expect(readBuildInfo(true, file)).toEqual(build);
    expect(runtimeIdentity(loadConfig({ ...env, EKO_SOURCE_REVISION: 'f'.repeat(40) }), readBuildInfo(true, file)).build?.sourceRevision).toBe(build.sourceRevision);
    writeFileSync(new URL('index.js', file), 'changed image entry');
    expect(() => readBuildInfo(true, file)).toThrow('Production build identity missing or invalid');
    writeFileSync(new URL('index.js', file), 'fixture index.js');
    for (const changed of [
      { ...build, sourceRevision: null }, { ...build, sourceRevision: 'main' },
      { ...build, bundleDigest: 'c'.repeat(64) }, { ...build, secret: 'fixture-secret' },
      { ...build, bundles: { ...bundles, 'unknown.js': 'b'.repeat(64) } },
    ]) {
      writeFileSync(file, JSON.stringify(changed));
      expect(() => readBuildInfo(true, file)).toThrow('Production build identity missing or invalid');
    }
    expect(readBuildInfo(false, new URL('missing.json', file))).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
