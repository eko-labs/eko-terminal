import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ChainClients } from '../src/exec/chain.js';
import { runtimeIdentity } from '../src/build-identity.js';

it('rehearses isolated config rollback without reversing migrations or losing receipts', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../../infra/railway/staging.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'eko-staging-rollback-'));
  // Deliberately do not inherit process.env or deployment secrets. No ports or providers.
  const retainedEnv = {
    ...catalog.commonEnvironment, ...catalog.services.api.environment,
    NODE_ENV: 'test', PGLITE_DIR: join(directory, 'database'),
    SERVE_WEB: 'false', LOG_LEVEL: 'silent', MIGRATIONS_DIR: undefined, TRADE_CAPS_FILE: undefined,
    SESSION_SECRET: 'rollback-fixture-placeholder'.repeat(3),
    DEMO_SECRET: 'rollback-fixture-demo-placeholder'.repeat(3),
  };
  const traffic = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture forbids network'));
  const probes = vi.spyOn(ChainClients.prototype, 'checkHealth').mockRejectedValue(new Error('Fixture forbids chain probes'));
  let running: Awaited<ReturnType<typeof buildApp>> | undefined;
  const ledgers = async () => {
    const db = running!.ctx.dbh.chain;
    const server = await db.sql.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
    const indexer = await db.sql.query('SELECT id FROM eko_indexer_migrations ORDER BY id');
    const engines = await db.sql.query('SELECT id FROM eko_engine_migrations ORDER BY id');
    return { server: server.rows, indexer: indexer.rows, engines: engines.rows };
  };
  try {
    running = await buildApp(loadConfig(retainedEnv), { startBackground: false });
    // Seed an immutable outbox item, not an invented on-chain commitment/proof.
    const payload = JSON.stringify({ fixture: 'sample-verdict', anchored: false });
    const receipt = ['sample-receipt', 'playbooks', 'verdict', 4663, 'sample-revision', 'sample-hash', 'sample-leaf', payload, payload, '2026-10-02T00:00:00Z'];
    await running.ctx.dbh.chain.sql.query(`INSERT INTO receipt_items
      (id,producer,kind,chain_id,revision_id,payload_hash,leaf,canonical_payload,data,recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, receipt);
    await running.ctx.dbh.chain.sql.query(`INSERT INTO feature_flags(key,enabled,audience)
      VALUES ('trading_live',false,'public'),('swarm_ranking',false,'public')`);
    const before = await ledgers();
    expect(before.server.length).toBeGreaterThan(0);
    expect(before.indexer.length).toBeGreaterThan(0);
    expect(before.engines.length).toBeGreaterThan(0);
    const receiptBefore = (await running.ctx.dbh.chain.sql.query('SELECT * FROM receipt_items')).rows;
    await running.close(); running = undefined;

    const started = performance.now();
    // A rejected config release cannot start a fallback service. Restore retained config.
    expect(() => loadConfig({ ...retainedEnv, FLAGS: 'unaccepted-fixture-flag' })).toThrow('Unknown FLAGS entry');
    running = await buildApp(loadConfig(retainedEnv), { startBackground: false });
    expect(await ledgers()).toEqual(before);
    expect((await running.ctx.dbh.chain.sql.query('SELECT * FROM receipt_items')).rows).toEqual(receiptBefore);
    const health = await running.app.inject('/v1/health');
    expect(health.statusCode).toBe(200); // Deployment liveness does not wait for role loops.
    expect(health.json()).toMatchObject({ ok: true, loops: { refresher: { name: 'refresher', stale: true, periodSec: 0.25, lastCycleAt: null } }, rpc: { sessionUnits: 0 } });
    const loopHealth = await running.app.inject('/v1/health/loops');
    expect(loopHealth.statusCode).toBe(503);
    expect(loopHealth.json()).toEqual(health.json());
    expect((await running.app.inject('/api/health/live')).statusCode).toBe(200);
    const identity = await running.app.inject('/v1/build');
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual(runtimeIdentity(running.ctx.cfg));
    expect(identity.headers['cache-control']).toBe('no-store');
    const config = await running.app.inject('/v1/config');
    expect(config.statusCode).toBe(200);
    expect(config.json().trading).toMatchObject({ liveEnabled: false, maxTradeUsd: 25 });
    expect(await running.ctx.tradeAccess.refusal(null, 1)).toMatchObject({ code: 'trading_paused' });
    expect(Object.values(config.json().flags).every(value => value === false)).toBe(true);
    expect((await running.ctx.dbh.chain.sql.query('SELECT enabled FROM feature_flags')).rows.every(row => row.enabled === false)).toBe(true);
    expect(traffic).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
    const elapsedMs = Math.ceil(performance.now() - started);
    expect(elapsedMs).toBeLessThan(catalog.rollbackTargetSeconds * 1000);
    process.stdout.write(JSON.stringify({ event: 'staging_rollback_fixture', sourceRevision: catalog.candidateRevision,
      coverage: 'same-binary rejected-config recovery; persistent PGlite; three ledgers and immutable receipt retained',
      elapsedMs, targetMs: catalog.rollbackTargetSeconds * 1000, providerCostUsd: 0,
      networkCalls: 0, ports: 0, deployed: false }) + '\n');
  } finally {
    await running?.close();
    traffic.mockRestore(); probes.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
