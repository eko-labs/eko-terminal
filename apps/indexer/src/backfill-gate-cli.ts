import { readFile, stat, writeFile } from 'node:fs/promises';
import { openDb } from '@eko/db';
import { GatePlanSchema, verifyBackfill } from './backfill-gate.js';
import { captureBackfillSnapshot } from './backfill-gate-snapshot.js';

const args = process.argv.slice(2).filter(a => a !== '--');
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
async function json(path: string) {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('Evidence input exceeds 16 MiB');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function main() {
  const output = option('out');
  if (!output) throw new Error('Use --out <new evidence file>');
  if (args[0] === 'snapshot') {
    const path = option('plan');
    if (!path || (!process.env.DATABASE_URL && !process.env.PGLITE_DIR)) throw new Error('Snapshot requires --plan and an existing DATABASE_URL or PGLITE_DIR');
    const plan = GatePlanSchema.parse(await json(path));
    const db = await openDb({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR });
    try {
      const snapshot = await captureBackfillSnapshot(db, plan, { origin: 'local', checkpoint: option('checkpoint') ?? 'backfill-gate-export' });
      await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      console.log('Read-only snapshot saved; no RPC or acquisition run.');
    } finally { await db.close(); }
    return;
  }
  if (args[0] !== 'verify' || !option('snapshot')) throw new Error('Use verify --snapshot <file> --out <new report> [--guard-048 <manifest>] [--guard-057 <manifest>]');
  const manifests: { owner: '048' | '057'; content: unknown }[] = [];
  for (const owner of ['048', '057'] as const) { const path = option(`guard-${owner}`); if (path) manifests.push({ owner, content: await json(path) }); }
  const report = verifyBackfill(await json(option('snapshot')!), manifests);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, origin: report.origin, snapshotHash: report.snapshotHash, liveApproved: false }));
  if (report.status !== 'verified-offline') process.exitCode = 2;
}
// Do not print connection strings, filesystem paths, raw provider errors or imported manifest contents.
main().catch(() => { console.error('Backfill gate failed: check input schema, existing database, row/time bounds and output path.'); process.exitCode = 1; });
