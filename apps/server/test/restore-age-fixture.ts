// Explicit operator-tool fixture; requires age/age-keygen, never part of the
// dependency-only test gate. Disposable synthetic identities, no provider calls.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { runStream } from '../src/ops/backup-stream.js';
const directory = await realpath(await mkdtemp(join(tmpdir(), 'eko-age-fixture-')));
const started = Date.now();
try {
  const identity = join(directory, 'fixture-identity'), recipients = join(directory, 'recipients');
  execFileSync('age-keygen', ['-o', identity], { stdio: 'ignore' });
  await writeFile(recipients, execFileSync('age-keygen', ['-y', identity]), { mode: 0o600 });
  const source = join(directory, 'source'), encrypted = join(directory, 'encrypted.age'), restored = join(directory, 'restored');
  await writeFile(source, 'neutral encrypted backup fixture', { mode: 0o600 });
  await runStream([{ command: 'age', args: ['--recipients-file', recipients] }], createReadStream(source), createWriteStream(encrypted, { flags: 'wx', mode: 0o600 }));
  assert(!(await readFile(encrypted)).includes(Buffer.from('neutral encrypted backup fixture')));
  await runStream([{ command: 'age', args: ['--decrypt', '--identity', identity] }], createReadStream(encrypted), createWriteStream(restored, { flags: 'wx', mode: 0o600 }));
  assert.deepEqual(await readFile(source), await readFile(restored));
  const corrupted = await readFile(encrypted); corrupted[corrupted.length - 1]! ^= 1;
  await writeFile(encrypted, corrupted);
  await assert.rejects(runStream([{ command: 'age', args: ['--decrypt', '--identity', identity] }], createReadStream(encrypted)));
  const archive = join(directory, 'wal'), pgdata = join(directory, 'isolated-pgdata');
  await mkdir(archive, { mode: 0o700 }); await mkdir(pgdata, { mode: 0o700 });
  const name = '000000010000000000000001';
  const env = { PATH: process.env.PATH, BACKUP_RECIPIENTS_FILE: recipients, BACKUP_IDENTITY_FILE: identity,
    BACKUP_WAL_DIRECTORY: archive, RESTORE_PGDATA: pgdata };
  const cli = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/backup-cli.ts', ...args], { env, stdio: 'pipe' });
  cli('wal-archive', source, name); cli('wal-archive', source, name);
  const destination = join(pgdata, name);
  cli('wal-fetch', destination, name);
  assert.deepEqual(await readFile(destination), await readFile(source));
  assert.throws(() => cli('wal-fetch', destination, name));
  assert.deepEqual(await readFile(destination), await readFile(source));
  assert.throws(() => cli('wal-fetch', join(directory, 'outside-target'), name));
  assert.throws(() => cli('wal-archive', source, '../invalid'));
  await writeFile(source, 'conflicting neutral fixture');
  assert.throws(() => cli('wal-archive', source, name));
  console.log(JSON.stringify({ event: 'age_wal_fixture', encryption: 'pass', decryption: 'pass', tamperRejection: 'pass',
    walRetry: 'pass', walRoundTrip: 'pass', overwriteRefusal: 'pass', outsideTargetRefusal: 'pass', conflictRefusal: 'pass',
    elapsedMs: Date.now() - started, providerCostUsd: 0, networkCalls: 0, pitrReplay: 'pending' }));
} finally { await rm(directory, { recursive: true, force: true }); }
