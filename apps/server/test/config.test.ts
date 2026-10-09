import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const base = { DEMO_SECRET: 'demo-test-placeholder'.repeat(2), SESSION_SECRET: 'test-only-placeholder'.repeat(2), PGLITE_DIR: ':memory:' };

describe('EKO market configuration', () => {
  it('defaults proxy trust to zero and accepts only non-negative integer hop counts', () => {
    expect(loadConfig(base).TRUST_PROXY_HOPS).toBe(0);
    for (const value of ['0', '1', '2']) expect(loadConfig({ ...base, TRUST_PROXY_HOPS: value }).TRUST_PROXY_HOPS).toBe(Number(value));
    for (const value of ['', '-1', '1.5', 'true', 'NaN', 'Infinity', '1e2', ' 1 ', '9007199254740992']) {
      expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('defaults to demo outside production and accepts explicit demo in production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadConfig({ ...base, NODE_ENV }).MARKET_DATA_SOURCE).toBe('demo');
    }
    expect(loadConfig({ ...base, DATABASE_URL: 'postgresql://example.invalid/fixture', RUN_WORKER: 'false', BURN_WALLET_ADDRESS: `0x${'1'.repeat(40)}`, NODE_ENV: 'production', MARKET_DATA_SOURCE: 'demo' }).MARKET_DATA_SOURCE).toBe('demo');
  });

  it('accepts indexed onchain reads and keeps dev role local', () => {
    expect(loadConfig({ ...base, MARKET_DATA_SOURCE: 'onchain' }).MARKET_DATA_SOURCE).toBe('onchain');
    expect(() => loadConfig({ ...base, APP_ROLE:'dev', DATABASE_URL:'postgres://example.invalid/demo' })).toThrow('local PGlite only');
    expect(() => loadConfig({ ...base, APP_ROLE:'dev', NODE_ENV:'production' })).toThrow('local PGlite only');
  });

  it('rejects the retired feed and unknown sources', () => {
    for (const MARKET_DATA_SOURCE of ['coinbase', 'unknown']) {
      expect(() => loadConfig({ ...base, MARKET_DATA_SOURCE })).toThrow(/Invalid environment configuration/);
    }
  });

  it('serves indexed reads without a legacy market feed', async () => {
    const built = await buildApp(loadConfig({ ...base, MARKET_DATA_SOURCE:'onchain', LEGACY_API:'false' }), { startBackground:false });
    try { expect((await built.app.inject('/v1/radar')).json()).toEqual({rows:[],cursor:null,delayedSec:0,totals:{coins:0,clear:0,monitor:0,pending:0,danger:0,evaluatedToday:0,evaluatedByHour:Array(24).fill(0),dangerByHour:Array(24).fill(0)}}); expect(built.ctx.market.simulated).toBe(false); } finally { await built.close(); }
  });
});
