import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { lockedTestImplementationRevision } from './locked-test-cli.js';
import { MONTHLY_EVALUATION_VERSION, MonthlyInputSchema, evaluateMonthlyFixtures } from './monthly-evaluation.js';

export async function monthlyImplementationRevision() {
  const root = new URL('../../../', import.meta.url);
  const files = ['apps/engines/src/monthly-evaluation.ts', 'apps/engines/src/monthly-evaluation-cli.ts',
    'apps/engines/src/probability-sample.ts', 'apps/engines/src/guard-cutover.ts'];
  return referenceDigest({ lockedDependencies: await lockedTestImplementationRevision(),
    files: await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))) });
}
interface Checkpoint { version: typeof MONTHLY_EVALUATION_VERSION; inputHash: string; definitionHash: string;
  implementationRevision: string; reportHash: string; prior: string | null; nextAction: string; }

/** Existing offline application job, bounded invocation; no timer or OS service.
 * Checkpoint head publishes only after durable immutable artifacts. Partial writes
 * can resume only with identical content, never by overwriting changed evidence. */
export async function monthlyEvaluationMain(args: string[], afterArtifacts?: () => void) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: monthly-evaluation-cli.ts --fixture input.json output-directory');
  const input = MonthlyInputSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const implementationRevision = await monthlyImplementationRevision();
  const inputHash = referenceDigest(input), definitionHash = referenceDigest(input.definition);
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const head = await readPilotJson<{ checkpointHash: string }>(join(output, 'checkpoint.json'));
    if (head) {
      const prior = await readPilotJson<Checkpoint>(join(output, `${head.checkpointHash}.checkpoint.json`));
      if (!prior || referenceDigest(prior) !== head.checkpointHash || prior.version !== MONTHLY_EVALUATION_VERSION ||
          prior.definitionHash !== definitionHash || prior.implementationRevision !== implementationRevision)
        throw new Error('Checkpoint/source/config mismatch; new versioned output required');
      const saved = await readPilotJson<unknown>(join(output, `${prior.inputHash}.input.json`));
      const report = await readPilotJson<unknown>(join(output, `${prior.inputHash}.report.json`));
      if (!saved || referenceDigest(saved) !== prior.inputHash || !report || referenceDigest(report) !== prior.reportHash)
        throw new Error('Immutable monthly artifact missing or changed');
      if (prior.inputHash === inputHash) return { event: 'monthly_fixture_verified', replayed: false, enabled: false, checkpointHash: head.checkpointHash };
      const previous = MonthlyInputSchema.parse(saved);
      if (previous.ticks.some(t => t.evaluation) || input.ticks.length <= previous.ticks.length ||
          referenceDigest(input.ticks.slice(0, previous.ticks.length)) !== referenceDigest(previous.ticks))
        throw new Error('Append-only progress before frozen gate inspection required');
    }
    const report = evaluateMonthlyFixtures(input, implementationRevision);
    const checkpoint: Checkpoint = { version: MONTHLY_EVALUATION_VERSION, inputHash, definitionHash,
      implementationRevision, reportHash: referenceDigest(report), prior: head?.checkpointHash ?? null,
      nextAction: report.nextAction };
    const checkpointHash = referenceDigest(checkpoint);
    const artifacts = { [`${inputHash}.input.json`]: input, [`${inputHash}.report.json`]: report,
      [`${checkpointHash}.checkpoint.json`]: checkpoint };
    if (!head && (await readdir(output)).some(name => name !== 'runner.lock' && !Object.hasOwn(artifacts, name)))
      throw new Error('Unknown interrupted generation; inspect checkpoint');
    for (const [name, value] of Object.entries(artifacts)) {
      const saved = await readPilotJson<unknown>(join(output, name));
      if (saved && referenceDigest(saved) !== referenceDigest(value)) throw new Error('Immutable interrupted artifact changed');
      if (!saved) await atomicPilotJson(join(output, name), value);
    }
    afterArtifacts?.();
    await atomicPilotJson(join(output, 'checkpoint.json'), { checkpointHash });
    return { event: 'monthly_fixture_checkpointed', replayed: true, enabled: false, status: report.status, checkpointHash };
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  monthlyEvaluationMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Monthly fixture job halted; inspect immutable artifacts and checkpoint. Monthly maintenance remains disabled.');
    process.exitCode = 1;
  });
}
