import { mkdir, open, readFile, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** One owner per disk directory, including multiple opens in the same process. */
export async function lockPglite(directory: string): Promise<() => Promise<void>> {
  if (directory === ':memory:') return async () => {};
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, '.eko-pglite.pid');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(String(process.pid));
      await file.close();
      const owned = await stat(path);
      return async () => {
        const current = await stat(path).catch(() => null);
        if (current?.ino === owned.ino && await readFile(path, 'utf8') === String(process.pid)) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await stat(path).catch(() => null);
      if (!current) continue;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('PGlite directory lock is incomplete; retry after its owner finishes opening');
      try { process.kill(pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          if ((await stat(path).catch(() => null))?.ino === current.ino) await unlink(path);
          continue;
        }
      }
      throw new Error('PGlite directory is already held by another open database; use APP_ROLE=dev locally or Postgres for separate roles');
    }
  }
  throw new Error('Could not acquire PGlite directory lock');
}
