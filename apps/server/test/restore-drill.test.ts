import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ReceiptOutbox } from '@eko/db';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ChainClients } from '../src/exec/chain.js';
import { assertFreshRestoreTarget, captureInventory, compareInventories, digest, reclaimRestoreLeases, validateRestoreName } from '../src/ops/restore-checks.js';
import { runStream } from '../src/ops/backup-stream.js';
import type { SqlClient } from '@eko/db';

it('rejects aliases of the source cluster, mismatched source, existing targets and arbitrary names before restore DDL', async () => {
  const sql = (id: string, exists = false): SqlClient => ({ query: vi.fn(async (query: string) => ({ rows:
    query.includes('pg_control_system') ? [{ id }] : exists ? [{ present: true }] : [],
  })) as SqlClient['query'] });
  const source = sql('sample-source-cluster');
  await expect(assertFreshRestoreTarget(source, sql('sample-source-cluster'), 'eko_restore_sample', digest('sample-source-cluster'))).rejects.toThrow('distinct');
  await expect(assertFreshRestoreTarget(source, sql('sample-target-cluster'), 'eko_restore_sample', digest('wrong-source'))).rejects.toThrow('match backup');
  await expect(assertFreshRestoreTarget(source, sql('sample-target-cluster', true), 'eko_restore_sample', digest('sample-source-cluster'))).rejects.toThrow('already exists');
  await expect(assertFreshRestoreTarget(source, sql('sample-target-cluster'), 'eko_restore_sample', digest('sample-source-cluster'))).resolves.toBeUndefined();
  for (const name of ['eko', 'postgres', 'eko_restore_sample";', '../source']) expect(() => validateRestoreName(name)).toThrow('fresh database');
});

it('propagates producer, consumer and missing-tool failures without shell execution', async () => {
  await expect(runStream([{ command: process.execPath, args: ['-e', 'process.exit(2)'] }])).rejects.toThrow('pipeline failed');
  await expect(runStream([{ command: process.execPath, args: ['-e', 'process.stdout.write("fixture")'] },
    { command: process.execPath, args: ['-e', 'process.exit(3)'] }])).rejects.toThrow('pipeline failed');
  await expect(runStream([{ command: 'eko-fixture-missing-tool', args: [] }])).rejects.toThrow('pipeline failed');
});

it('restores an encrypted pre-deletion fixture into a fresh DB and reconnects real read services', async () => {
  const started = Date.now(), directory = await mkdtemp(join(tmpdir(), 'eko-restore-drill-'));
  const sourcePath = join(directory, 'source'), targetPath = join(directory, 'target'), ledgerPath = join(directory, 'current-destruction.log');
  await writeFile(ledgerPath, 'eko-journal-destruction-v1\n', { mode: 0o600 });
  const kek = randomBytes(32), backupKey = randomBytes(32);
  const fixtureEnv = { NODE_ENV: 'test', PGLITE_DIR: sourcePath, LOG_LEVEL: 'silent', SERVE_WEB: 'false', LEGACY_API: 'false',
    RPC_PAID_DAILY_BUDGET: '0', RPC_SESSION_BUDGET: '0',
    SESSION_SECRET: 'restore-fixture-session-placeholder'.repeat(3), DEMO_SECRET: 'restore-fixture-demo-placeholder'.repeat(3),
    HARNESS_KEY_PEPPER: 'restore-fixture-pepper-placeholder'.repeat(3), LAUNCH_WEEK_AGENT_LIMIT: '10',
    JOURNAL_KEK: kek.toString('hex'), JOURNAL_KEK_ID: 'fixture-kek', JOURNAL_TOMBSTONE_PATH: ledgerPath };
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No fixture network'));
  const chain = vi.spyOn(ChainClients.prototype, 'checkHealth').mockRejectedValue(new Error('No fixture chain'));
  let source: Awaited<ReturnType<typeof buildApp>> | undefined, target: typeof source;
  try {
    source = await buildApp(loadConfig(fixtureEnv), { startBackground: false });
    const owners = [];
    for (let i = 0; i < 2; i++) {
      const account = (await source.ctx.dbh.chain.sql.query<{ id: string }>("INSERT INTO accounts(kind) VALUES('wallet') RETURNING id")).rows[0]!;
      const agent = await source.ctx.harness.create(account.id, { name: 'Sample restore agent', kind: 'other', preset: 'balanced' }, 10);
      await source.ctx.journal.setConsent(account.id, true);
      await source.ctx.journal.append(account.id, agent.id, { kind: 'note', payload: { text: 'restore-drill-neutral-fixture' }, share: false });
      owners.push({ account: account.id, agent: agent.id });
    }
    const db = source.ctx.dbh.chain;
    await new ReceiptOutbox(db).recover();
    await db.setCursor('fixture', 42n, null);
    await db.sql.query("INSERT INTO ingest_ranges(stream,from_block,to_block,status,lease_owner,lease_until) VALUES('fixture',1,42,'leased','sample-worker','2099-01-01')");
    await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES('sample-card',decode('01','hex'),42,'sample-card-hash','{"fixture":true}')`);
    const before = await captureInventory(db.sql);
    expect(before.samples.receipt_items!.count).toBe(2);
    expect(before.samples.coin_cards!.count).toBe(1);
    expect(before.leasedRanges).toBe('1');
    await source.close(); source = undefined;
    const engine = new PGlite(sourcePath);
    await engine.waitReady;
    const dump = Buffer.from(await (await engine.dumpDataDir()).arrayBuffer());
    await engine.close();
    // Offline fixture encryption only. Production commands use age + pg_dump.
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', backupKey, iv);
    const encrypted = Buffer.concat([iv, cipher.update(dump), cipher.final(), cipher.getAuthTag()]); dump.fill(0);
    const file = join(directory, 'fixture-backup.enc');
    await writeFile(file, encrypted, { mode: 0o600, flag: 'wx' });
    const checksum = digest(encrypted.toString('hex'));
    source = await buildApp(loadConfig(fixtureEnv), { startBackground: false });
    await source.ctx.journal.deleteData(owners[1]!.account);
    const sourceAfterDeletion = await captureInventory(source.ctx.dbh.chain.sql);
    const bytes = await readFile(file);
    expect(digest(bytes.toString('hex'))).toBe(checksum);
    const decipher = createDecipheriv('aes-256-gcm', backupKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    const restored = await PGlite.create({ dataDir: targetPath, loadDataDir: new Blob([Uint8Array.from(plaintext)]) });
    // Check archive fidelity before boot refreshes derived read projections.
    expect(compareInventories(before, await captureInventory(restored))).toEqual([
      { assertion: 'counts', status: 'pass' }, { assertion: 'ledgers', status: 'pass' },
      { assertion: 'state', status: 'pass' }, { assertion: 'samples', status: 'pass' }, { assertion: 'leasedRanges', status: 'pass' },
    ]);
    plaintext.fill(0); await restored.close();
    target = await buildApp(loadConfig({ ...fixtureEnv, PGLITE_DIR: targetPath }), { startBackground: false });
    const afterBoot = await captureInventory(target.ctx.dbh.chain.sql);
    expect(afterBoot.ledgers).toEqual(before.ledgers);
    expect(afterBoot.state).toEqual(before.state);
    expect(afterBoot.samples).toEqual(before.samples);
    expect((await target.ctx.journal.page(owners[0]!.account, owners[0]!.agent)).rows[0]!.payload).toEqual({ text: 'restore-drill-neutral-fixture' });
    await expect(target.ctx.journal.page(owners[1]!.account, owners[1]!.agent)).rejects.toMatchObject({ code: 'forbidden' });
    // Old ciphertext AND wrapped key are present: the current ledger prevents revival.
    expect((await target.ctx.dbh.chain.sql.query('SELECT wrapped_dek FROM user_keys WHERE account_id=$1', [owners[1]!.account])).rows[0]!.wrapped_dek).not.toBeNull();
    expect(await reclaimRestoreLeases(target.ctx.dbh.chain.sql)).toBe(true);
    const damaged = structuredClone(before); damaged.samples.coin_cards!.sha256 = 'changed';
    expect(compareInventories(before, damaged).find(check => check.assertion === 'samples')!.status).toBe('fail');
    await target.close(); target = await buildApp(loadConfig({ ...fixtureEnv, PGLITE_DIR: targetPath }), { startBackground: false });
    const health = await target.app.inject('/v1/health');
    expect(health.statusCode).toBe(200); // Restored storage is reachable even with role loops disabled.
    expect(health.json().loops.refresher).toEqual({ name: 'refresher', stale: true, periodSec: 0.25, lastCycleAt: null });
    const loopHealth = await target.app.inject('/v1/health/loops');
    expect(loopHealth.statusCode).toBe(503);
    expect(loopHealth.json()).toEqual(health.json());
    expect((await target.app.inject('/api/health/live')).statusCode).toBe(200);
    expect((await target.app.inject('/v1/config')).json().trading.liveEnabled).toBe(false);
    const session = await target.ctx.auth.createSession(owners[0]!.account);
    const cookie = `eko_sid=${encodeURIComponent(target.app.signCookie(session))}`;
    expect((await target.app.inject({ url: `/v1/agents/${owners[0]!.agent}/journal`, headers: { cookie } })).statusCode).toBe(200);
    expect(await captureInventory(source.ctx.dbh.chain.sql)).toEqual(sourceAfterDeletion);
    expect(network).not.toHaveBeenCalled(); expect(chain).not.toHaveBeenCalled();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    process.stdout.write(JSON.stringify({ event: 'restore_drill_fixture', sourceRevision: baseRevision, candidateRevision: baseRevision,
      candidateState: 'worktree; lead must pin final revision', backupChecksum: checksum, restoreTarget: 'sample-isolated-pglite',
      elapsedMs: Date.now() - started, assertions: ['three-migration-ledgers', 'counts', 'cursor-ranges', 'immutable-card-receipt-samples',
        'stale-leases', 'authorized-decryption', 'pre-deletion-ciphertext-denied', 'read-service-reconnect', 'source-unchanged', 'tamper-detection']
        .map(assertion => ({ assertion, status: 'pass' })),
      coverage: 'synthetic PGlite archive with AES-GCM; not pg_dump/age, provider snapshot or WAL/PITR evidence',
      providerCostUsd: 0, networkCalls: 0, ports: 0, accepted: false }) + '\n');
  } finally {
    await target?.close(); await source?.close(); kek.fill(0); backupKey.fill(0);
    network.mockRestore(); chain.mockRestore(); await rm(directory, { recursive: true, force: true });
  }
}, 60000);
