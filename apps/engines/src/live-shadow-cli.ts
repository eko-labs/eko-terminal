import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import guardFiles from './guard-code-files.json' with { type: 'json' };
import signalFiles from './signal-code-files.json' with { type: 'json' };
import { lockedTestImplementationRevision } from './locked-test-cli.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { LiveShadowInputSchema, reportLiveShadowFixtures } from './live-shadow.js';

export async function liveShadowImplementationRevision() {
  const root = new URL('../../../', import.meta.url);
  const files = [...new Set([...guardFiles, ...signalFiles, 'apps/engines/src/live-shadow.ts',
    'apps/engines/src/live-shadow-cli.ts', 'packages/policy/src/guard.ts'])].sort();
  return referenceDigest({ lockedDependencies: await lockedTestImplementationRevision(),
    files: await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))) });
}
interface Checkpoint { version: 1; inputHash: string; definitionHash: string; implementationRevision: string;
  ticks: number; reportHash: string; prior: string | null; nextAction: string; }
/** One durable checkpoint per progressing fixture invocation. Identical resume
 * verifies stored content without replay. Immutable generations survive updates. */
export async function liveShadowMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: live-shadow-cli.ts --fixture input.json output-directory');
  const input = LiveShadowInputSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const inputHash = referenceDigest(input), definitionHash = referenceDigest(input.definition);
  const implementationRevision = await liveShadowImplementationRevision();
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const head = await readPilotJson<{ checkpointHash: string }>(join(output, 'checkpoint.json'));
    let previous: Checkpoint | null = null;
    if (head) {
      previous = await readPilotJson<Checkpoint>(join(output, `${head.checkpointHash}.checkpoint.json`));
      if (!previous || referenceDigest(previous) !== head.checkpointHash || previous.implementationRevision !== implementationRevision ||
          previous.definitionHash !== definitionHash) throw new Error('Checkpoint/source/config mismatch');
      const savedInput = await readPilotJson<unknown>(join(output, `${previous.inputHash}.input.json`));
      const report = await readPilotJson<unknown>(join(output, `${previous.inputHash}.report.json`));
      if (!savedInput || referenceDigest(savedInput) !== previous.inputHash || !report || referenceDigest(report) !== previous.reportHash)
        throw new Error('Immutable shadow artifact changed');
      const saved = LiveShadowInputSchema.parse(savedInput);
      if (previous.inputHash === inputHash) return { event: 'shadow_fixture_verified', replayed: false, enabled: false };
      if (input.ticks.length <= saved.ticks.length || referenceDigest(input.ticks.slice(0, saved.ticks.length)) !== referenceDigest(saved.ticks))
        throw new Error('Only append-only fixture progress can resume');
    } else if ((await readdir(output)).some(name => name !== 'runner.lock')) throw new Error('Interrupted output; inspect before continuing');
    const report = reportLiveShadowFixtures(input, implementationRevision);
    const checkpoint: Checkpoint = { version: 1, inputHash, definitionHash, implementationRevision, ticks: input.ticks.length,
      reportHash: referenceDigest(report), prior: head?.checkpointHash ?? null, nextAction: report.process.nextAction };
    const checkpointHash = referenceDigest(checkpoint);
    // Refuse interrupted generations rather than replacing their evidence.
    for (const [name, value] of Object.entries({ [`${inputHash}.input.json`]: input,
      [`${inputHash}.report.json`]: report, [`${checkpointHash}.checkpoint.json`]: checkpoint })) {
      if (await readPilotJson(join(output, name))) throw new Error('Interrupted generation; inspect process/checkpoint');
      await atomicPilotJson(join(output, name), value);
    }
    await atomicPilotJson(join(output, 'checkpoint.json'), { checkpointHash });
    return { event: previous ? 'shadow_fixture_checkpointed' : 'shadow_fixture_prepared', replayed: true,
      status: report.status, enabled: false, checkpointHash };
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  liveShadowMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Offline shadow preparation halted; inspect source and checkpoint. Live shadow remains disabled.');
    process.exitCode = 1;
  });
}
