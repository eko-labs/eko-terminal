import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import pg from 'pg';
import { FileJournalDestructionLedger, ChainDb } from '@eko/db';
import { JournalService, journalKeyWriter } from '../harness/journal.js';
import { assertFreshRestoreTarget, captureInventory, compareInventories, digest, reclaimRestoreLeases, validateRestoreName, type RestoreInventory } from './restore-checks.js';
import { runStream } from './backup-stream.js';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error('Missing backup configuration'); return value; };
const revision = (name: string) => { const value = required(name); if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid revision'); return value; };
async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const client = (url: string) => new pg.Client({ connectionString: url, application_name: 'eko-restore-drill', connectionTimeoutMillis: 10000 });
const pgEnv = (url: string) => ({ ...process.env, PGDATABASE: url });
const ageEncrypt = () => ({ command: 'age', args: ['--recipients-file', required('BACKUP_RECIPIENTS_FILE')] });
const ageDecrypt = () => ({ command: 'age', args: ['--decrypt', '--identity', required('BACKUP_IDENTITY_FILE')] });
async function cluster(sql: pg.Client) {
  // A different URI/hostname is insufficient isolation (DNS aliases exist).
  return String((await sql.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id);
}
type Manifest = { version: 1; sourceRevision: string; candidateRevision: string; sha256: string; inventory: RestoreInventory;
  startedAt: string; elapsedMs: number; sourceClusterHash: string; artifact: string };

async function backup(directory: string) {
  const sourceRevision = revision('BACKUP_SOURCE_REVISION'), candidateRevision = revision('BACKUP_CANDIDATE_REVISION');
  const source = client(required('BACKUP_SOURCE_DATABASE_URL'));
  // Exclusive directory: a retry must not overwrite an earlier artifact/report.
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'dump.pgcustom.age'), started = Date.now();
  try {
    await source.connect();
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sourceClusterHash = digest(await cluster(source));
    const snapshot = String((await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot);
    const inventory = await captureInventory(source);
    await runStream([
      { command: 'pg_dump', args: ['--format=custom', '--no-owner', '--no-acl', '--exclude-table-data=public.journal_entries', `--snapshot=${snapshot}`], env: pgEnv(required('BACKUP_SOURCE_DATABASE_URL')) },
      ageEncrypt(),
    ], undefined, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    const manifest: Manifest = { version: 1, sourceRevision, candidateRevision, sourceClusterHash, artifact: 'dump.pgcustom.age',
      sha256: await checksum(file), inventory, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await source.query('COMMIT');
  } catch { await rm(file, { force: true }); throw new Error('Encrypted dump failed; no complete backup manifest'); }
  finally { await source.end(); }
}

async function restore(directory: string) {
  const started = Date.now(), candidateRevision = revision('BACKUP_CANDIDATE_REVISION');
  const name = required('RESTORE_DATABASE_NAME');
  validateRestoreName(name);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.artifact !== 'dump.pgcustom.age' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid backup manifest');
  const artifact = join(directory, manifest.artifact);
  if (await checksum(artifact) !== manifest.sha256) throw new Error('Encrypted dump checksum mismatch');
  // Current ledger, mounted independently of backup/PITR. Fail closed before DDL.
  const ledger = new FileJournalDestructionLedger(required('JOURNAL_TOMBSTONE_PATH'));
  ledger.destroyedAt('00000000-0000-4000-8000-000000000000');
  const adminUrl = required('RESTORE_ADMIN_DATABASE_URL'), sourceUrl = required('BACKUP_SOURCE_DATABASE_URL');
  const admin = client(adminUrl), source = client(sourceUrl);
  const assertions: { assertion: string; status: 'pass' | 'fail' | 'pending' }[] = [];
  let target: pg.Client | undefined, created = false, completed = false;
  try {
    await source.connect(); await admin.connect();
    await assertFreshRestoreTarget(source, admin, name, manifest.sourceClusterHash);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const targetUrl = new URL(adminUrl); targetUrl.pathname = '/' + name;
    await runStream([ageDecrypt(), { command: 'pg_restore', args: ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', name],
      // PGDATABASE carries credentials; --dbname is only the neutral DB name.
      env: { ...pgEnv(targetUrl.toString()), PGSSLMODE: 'verify-full', PGHOST: new URL(adminUrl).hostname, PGPORT: new URL(adminUrl).port || '5432',
        PGUSER: decodeURIComponent(new URL(adminUrl).username), PGPASSWORD: decodeURIComponent(new URL(adminUrl).password) } }], createReadStream(artifact));
    target = client(targetUrl.toString()); await target.connect();
    assertions.push({ assertion: 'fresh-isolated-target-and-ciphertext-checksum', status: 'pass' });
    assertions.push(...compareInventories(manifest.inventory, await captureInventory(target)));
    assertions.push({ assertion: 'no-inherited-session-advisory-leases', status: (await target.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows.length === 0 ? 'pass' : 'fail' });
    // Reconcile CURRENT tombstones before any journal reader or application boot.
    const db = new ChainDb(target, async fn => { await target!.query('BEGIN'); try { const value = await fn(target!); await target!.query('COMMIT'); return value; } catch (error) { await target!.query('ROLLBACK'); throw error; } });
    for (const row of (await target.query<{ account_id: string }>('SELECT DISTINCT account_id FROM user_keys')).rows) {
      const deletedAt = ledger.destroyedAt(row.account_id);
      if (deletedAt) await journalKeyWriter.destroy(db, row.account_id, deletedAt);
    }
    assertions.push({ assertion: 'current-destruction-ledger-mounted-and-reconciled', status: 'pass' });
    assertions.push({ assertion: 'stale-range-leases-reclaimed', status: await reclaimRestoreLeases(target) ? 'pass' : 'fail' });
    const active = process.env.RESTORE_FIXTURE_ACTIVE_ACCOUNT, agent = process.env.RESTORE_FIXTURE_ACTIVE_AGENT;
    const deleted = process.env.RESTORE_FIXTURE_DELETED_ACCOUNT, deletedAgent = process.env.RESTORE_FIXTURE_DELETED_AGENT;
    if (active && agent && deleted && deletedAgent) {
      const key = Buffer.from(required('JOURNAL_KEK'), 'hex');
      try {
        const service = new JournalService(db, ledger, { kek: key, id: required('JOURNAL_KEK_ID') });
        const entries = await service.page(active, agent);
        assertions.push({ assertion: 'authorized-neutral-journal-decryption', status: entries.rows.some(row => row.payload && typeof row.payload === 'object' && 'text' in row.payload && row.payload.text === 'restore-drill-neutral-fixture') ? 'pass' : 'fail' });
        let denied = false;
        try { await service.page(deleted, deletedAgent); } catch (error) { denied = (error as { code?: string }).code === 'forbidden'; }
        assertions.push({ assertion: 'pre-deletion-backup-journal-unreadable', status: ledger.destroyedAt(deleted) && denied ? 'pass' : 'fail' });
      } finally { key.fill(0); }
    } else assertions.push({ assertion: 'authorized-and-crypto-shredded-neutral-journals', status: 'pending' });
    await target.end(); target = client(targetUrl.toString()); await target.connect();
    assertions.push({ assertion: 'fresh-sql-read-connection', status: (await target.query('SELECT count(*) FROM coin_cards')).rows.length === 1 ? 'pass' : 'fail' });
    assertions.push({ assertion: 'isolated-api-mcp-read-service-reconnect', status: 'pending' }, { assertion: 'provider-snapshots-wal-pitr-recovery', status: 'pending' });
    completed = true;
  } finally {
    await target?.end(); await source.end(); await admin.end();
    for (const assertion of ['fresh-isolated-target-and-ciphertext-checksum', 'counts', 'ledgers', 'state', 'samples', 'leasedRanges',
      'no-inherited-session-advisory-leases', 'current-destruction-ledger-mounted-and-reconciled', 'stale-range-leases-reclaimed',
      'authorized-neutral-journal-decryption', 'pre-deletion-backup-journal-unreadable', 'fresh-sql-read-connection',
      'isolated-api-mcp-read-service-reconnect', 'provider-snapshots-wal-pitr-recovery'])
      if (!assertions.some(check => check.assertion === assertion)) assertions.push({ assertion, status: 'pending' });
    assertions.push({ assertion: 'restore-operation-completed', status: completed ? 'pass' : 'fail' });
    await writeFile(join(directory, `restore-${name}.json`), JSON.stringify({ sourceRevision: manifest.sourceRevision, candidateRevision,
      backupSha256: manifest.sha256, restoreTarget: name, created, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started,
      assertions, accepted: false, providerCostUsd: null }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (assertions.some(check => check.status !== 'pass')) throw new Error('Restore has failed or pending assertions; consult private report');
}

async function physicalBackup(directory: string) {
  const sourceRevision = revision('BACKUP_SOURCE_REVISION'), candidateRevision = revision('BACKUP_CANDIDATE_REVISION');
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'base.tar.age'), started = Date.now();
  const source = client(required('BACKUP_SOURCE_DATABASE_URL'));
  const replication = client(required('BACKUP_REPLICATION_DATABASE_URL'));
  try {
    await source.connect(); await replication.connect(); await captureInventory(source);
    if (await cluster(source) !== await cluster(replication)) throw new Error('Replication source cluster differs');
    if ((await source.query('SELECT 1 FROM journal_entries LIMIT 1')).rows.length) throw new Error('Physical backup requires retired plaintext notes to be absent');
    await runStream([{ command: 'pg_basebackup', args: ['--pgdata=-', '--format=tar', '--wal-method=none', '--checkpoint=spread'],
      env: pgEnv(required('BACKUP_REPLICATION_DATABASE_URL')) }, ageEncrypt()], undefined, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    await writeFile(join(directory, 'base-manifest.json'), JSON.stringify({ sourceRevision, candidateRevision,
      sourceClusterHash: digest(await cluster(source)), artifact: 'base.tar.age', sha256: await checksum(file),
      startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, pitrStatus: 'pending', accepted: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { await rm(file, { force: true }); throw new Error('Encrypted base backup incomplete'); }
  finally { await source.end(); await replication.end(); }
}

async function wal(command: string, path: string, name: string | undefined) {
  // PostgreSQL %f: WAL segment, timeline history or backup history only.
  if (!name || !/^(?:[A-F0-9]{24}|[A-F0-9]{8}\.history|[A-F0-9]{24}\.[A-F0-9]{8}\.backup)$/.test(name)) throw new Error('Invalid WAL name');
  const archive = join(required('BACKUP_WAL_DIRECTORY'), name + '.age');
  if (command === 'wal-archive') {
    // archive_command can retry after an acknowledgement loss. Confirm identical
    // input/ciphertext hashes without mounting a private identity on the producer.
    let existing: { ciphertextSha256: string; walSha256: string } | undefined;
    try { existing = JSON.parse(await readFile(archive + '.sha256', 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.ciphertextSha256 !== await checksum(archive) || existing.walSha256 !== await checksum(path)) throw new Error('Existing WAL archive differs');
      return;
    }
    try {
      await runStream([ageEncrypt()], createReadStream(path), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
      await writeFile(archive + '.sha256', JSON.stringify({ ciphertextSha256: await checksum(archive), walSha256: await checksum(path) }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { throw new Error('WAL archive incomplete; inspect partial artifact before retry'); }
  } else {
    const hashes = JSON.parse(await readFile(archive + '.sha256', 'utf8')) as { ciphertextSha256: string; walSha256: string };
    if (await checksum(archive) !== hashes.ciphertextSha256) throw new Error('WAL checksum mismatch');
    // %p must be an absent file in the dedicated restore data directory.
    const root = resolve(required('RESTORE_PGDATA'));
    const parent = await realpath(dirname(path)), realRoot = await realpath(root);
    if (!resolve(path).startsWith(root + '/') || root !== realRoot || !(parent === realRoot || parent.startsWith(realRoot + '/')))
      throw new Error('WAL destination must be inside isolated PGDATA');
    const destination = await open(path, 'wx', 0o600);
    try {
      await runStream([ageDecrypt()], createReadStream(archive), createWriteStream(path, { fd: destination.fd, autoClose: false }));
      if (await checksum(path) !== hashes.walSha256) throw new Error('Restored WAL checksum mismatch');
    } catch {
      // Only the exclusive-created target file belongs to this invocation.
      await rm(path, { force: true }); throw new Error('WAL restore incomplete');
    } finally { await destination.close(); }
  }
}

try {
  const [command, path, name] = process.argv.slice(2);
  if (!path || !['backup', 'restore', 'basebackup', 'wal-archive', 'wal-fetch'].includes(command ?? '')) throw new Error('Invalid backup command');
  if (command === 'backup') await backup(resolve(path));
  else if (command === 'restore') await restore(resolve(path));
  else if (command === 'basebackup') await physicalBackup(resolve(path));
  else await wal(command!, resolve(path), name);
  console.log('Encrypted backup operation completed.');
} catch {
  // Do not print raw libpq errors, paths, environment values or journal payloads.
  console.error('Backup operation incomplete. Check configuration and the private evidence report.');
  process.exitCode = 1;
}
