import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Inject the external encryption tool boundary; these tests establish CLI ownership,
// integrity and refusal behavior, not age cryptography or real Postgres acceptance.
vi.mock('../src/ops/backup-stream.js', () => ({ runStream: vi.fn() }));
import { runStream } from '../src/ops/backup-stream.js';
const argv = process.argv, exitCode = process.exitCode;
let directory: string | undefined;
afterEach(async () => {
  process.argv = argv; process.exitCode = exitCode;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fixture() {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'eko-backup-census-')));
  const archive = join(directory, 'archive'), target = join(directory, 'restore');
  await mkdir(archive); await mkdir(target);
  vi.stubEnv('BACKUP_WAL_DIRECTORY', archive); vi.stubEnv('RESTORE_PGDATA', target);
  vi.stubEnv('BACKUP_RECIPIENTS_FILE', 'fixture-recipients'); vi.stubEnv('BACKUP_IDENTITY_FILE', 'fixture-identity');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Reversible bytes represent an injected vendor tool, never actual encrypted evidence.
  vi.mocked(runStream).mockImplementation(async (_stages, input, destination) => {
    await pipeline(input ?? Readable.from([]), new Transform({ transform(chunk, _encoding, callback) {
      callback(null, Buffer.from(chunk).map(byte => byte ^ 0xaa));
    } }), destination as Writable);
  });
  const cli = async (...args: string[]) => {
    vi.resetModules(); process.argv = ['node', 'backup-cli.ts', ...args]; process.exitCode = 0;
    await import('../src/ops/backup-cli.js');
    return process.exitCode;
  };
  return { archive, target, output, error, cli };
}
const name = '000000010000000000000001';

describe('operator key/restore wrapper census (offline tool injection)', () => {
  it('retains exact WAL retry identity and refuses a conflicting replay before another encryption', async () => {
    const f = await fixture(), source = join(directory!, 'source');
    await writeFile(source, 'neutral WAL fixture');
    expect(await f.cli('wal-archive', source, name)).toBe(0);
    expect(await f.cli('wal-archive', source, name)).toBe(0);
    expect(runStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runStream).mock.calls[0][0]).toEqual([{ command: 'age', args: ['--recipients-file', 'fixture-recipients'] }]);
    await writeFile(source, 'conflicting neutral WAL fixture');
    expect(await f.cli('wal-archive', source, name)).toBe(1);
    expect(runStream).toHaveBeenCalledTimes(1);
    expect(f.error).toHaveBeenLastCalledWith('Backup operation incomplete. Check configuration and the private evidence report.');
    expect(JSON.stringify(f.error.mock.calls)).not.toContain(source);
  });
  it('restores only into an absent isolated target and refuses overwrite or path escape', async () => {
    const f = await fixture(), source = join(directory!, 'source'), destination = join(f.target, name);
    await writeFile(source, 'neutral WAL fixture');
    expect(await f.cli('wal-archive', source, name)).toBe(0);
    expect(await f.cli('wal-fetch', destination, name)).toBe(0);
    expect(await readFile(destination, 'utf8')).toBe('neutral WAL fixture');
    expect(vi.mocked(runStream).mock.calls[1][0]).toEqual([{ command: 'age', args: ['--decrypt', '--identity', 'fixture-identity'] }]);
    expect(await f.cli('wal-fetch', destination, name)).toBe(1);
    expect(await readFile(destination, 'utf8')).toBe('neutral WAL fixture');
    const outside = join(directory!, 'outside');
    expect(await f.cli('wal-fetch', outside, name)).toBe(1);
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runStream).toHaveBeenCalledTimes(2);
  });
  it('rejects changed ciphertext before decrypting and removes only its own failed restore file', async () => {
    const f = await fixture(), source = join(directory!, 'source'), destination = join(f.target, name);
    await writeFile(source, 'neutral WAL fixture');
    expect(await f.cli('wal-archive', source, name)).toBe(0);
    const ciphertext = await readFile(join(f.archive, name + '.age'));
    await writeFile(join(f.archive, name + '.age'), 'tampered fixture');
    expect(await f.cli('wal-fetch', destination, name)).toBe(1);
    expect(runStream).toHaveBeenCalledTimes(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(f.archive, name + '.age'), ciphertext);
    vi.mocked(runStream).mockImplementationOnce(async (_stages, _input, output) => {
      await pipeline(Readable.from(['wrong restored bytes']), output!);
    });
    expect(await f.cli('wal-fetch', destination, name)).toBe(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('neutral WAL fixture');
  });
  it('refuses malformed commands, revisions, WAL names and manifests without invoking tools', async () => {
    const f = await fixture();
    vi.stubEnv('BACKUP_SOURCE_REVISION', 'invalid'); vi.stubEnv('BACKUP_CANDIDATE_REVISION', 'a'.repeat(40));
    vi.stubEnv('RESTORE_DATABASE_NAME', 'eko_restore_fixture');
    await writeFile(join(directory!, 'manifest.json'), JSON.stringify({ version: 1, artifact: '../foreign', sha256: 'a'.repeat(64) }));
    for (const args of [[], ['unknown', directory!], ['backup', directory!], ['basebackup', directory!],
      ['wal-archive', directory!, '../invalid'], ['restore', directory!]]) {
      expect(await f.cli(...args)).toBe(1);
    }
    expect(runStream).not.toHaveBeenCalled(); expect(f.output).not.toHaveBeenCalled();
  });
});
