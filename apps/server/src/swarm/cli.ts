import { readFile, writeFile } from 'node:fs/promises';
import { openDb, migrate, migrateEngines } from '@eko/db';
import { SwarmPaperBatchSchema } from './source.js';
import { SwarmPaperRunner } from './runner.js';

/** Explicit local embedded database only. No environment provider/connection URLs or timers. */
async function main() {
  const [directory, sourceFile, reportFile, now] = process.argv.slice(2);
  if (!directory || !sourceFile || !reportFile || !now || !Number.isSafeInteger(Number(now))) throw new Error('Usage: cli.ts <local-db-dir> <input.json> <report.json> <now-ms>');
  const batch = SwarmPaperBatchSchema.parse(JSON.parse(await readFile(sourceFile, 'utf8')));
  const db = await openDb({ pgliteDir: directory });
  try {
    await migrate(db); await migrateEngines(db);
    const runner = new SwarmPaperRunner(db);
    if (batch.cohort) await runner.prepareCohort(batch.cohort);
    // Caller supplies chronological batches. Existing inputs/outcomes are immutable and replay idempotently.
    for (const input of batch.inputs) await runner.register(input);
    for (const outcome of batch.outcomes) await runner.observe(outcome);
    for (const tick of batch.ticks) await runner.tick(tick);
    await writeFile(reportFile, JSON.stringify(await runner.report(Number(now), batch.reportCohortId), null, 2) + '\n');
  } finally { await db.close(); }
}
main().catch(() => { process.stderr.write('Swarm paper runner failed; inspect input pins, immutable conflicts and coverage.\n'); process.exitCode = 1; });
