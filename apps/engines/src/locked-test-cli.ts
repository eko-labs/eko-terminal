import { mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import { prepareAcquisition } from './acquisition-run.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { developmentFitCandidateRevision } from './development-fit-cli.js';
import { LockedTestInputSchema, evaluateLockedFixtures, LOCKED_TEST_VERSION } from './locked-test.js';

export async function lockedTestImplementationRevision() {
  const root = new URL('../../../', import.meta.url);
  const files = ['apps/engines/src/locked-test.ts', 'apps/engines/src/locked-test-statistics.ts', 'apps/engines/src/locked-test-cli.ts'];
  return referenceDigest({ developmentDependencies: await developmentFitCandidateRevision(),
    files: await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))) });
}
interface Checkpoint {
  version: string; inputHash: string; implementationRevision: string; datasetHash: string;
  status: string; artifactHashes: Record<string, string>; nextAction: string;
}
/** One cohort inspection per shared ledger. Identical resume verifies content
 * without re-evaluation. A consumed cohort cannot be retried under a new freeze. */
export async function lockedTestMain(args: string[]) {
  if (args.length !== 4 || args[0] !== '--fixture') throw new Error('Usage: locked-test-cli.ts --fixture input.json output-directory ledger-directory');
  const input = LockedTestInputSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const source = resolve(args[1]), output = resolve(args[2]), ledger = resolve(args[3]);
  if ([output, ledger].some(p => source === p || source.startsWith(`${p}${sep}`)) || output === ledger ||
      output.startsWith(`${ledger}${sep}`) || ledger.startsWith(`${output}${sep}`)) throw new Error('Separate source/output/ledger required');
  const inputHash = referenceDigest(input), implementationRevision = await lockedTestImplementationRevision();
  const datasetHash = prepareAcquisition(input.acquisition).manifestHash;
  // Freeze-independent identity: changing labels/truths/parameters cannot make
  // the same test frame untouched. Shared-ledger ownership is a lead obligation.
  const testIdentity = referenceDigest({ tokens: input.acquisition.population?.frame.members.map(m => ({ coin: m.coin, launchSec: m.launchSec })).sort((a, b) => a.coin.localeCompare(b.coin)),
    chainId: input.acquisition.chainId, startSec: input.acquisition.startSec });
  await mkdir(output, { recursive: true }); await mkdir(ledger, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  const claim = join(ledger, testIdentity);
  try {
    const prior = await readPilotJson<Checkpoint>(join(output, 'checkpoint.json'));
    if (prior) {
      const seal = await readPilotJson<{ checkpointHash: string }>(join(claim, 'complete.json'));
      if (prior.version !== LOCKED_TEST_VERSION || prior.status !== 'prepared_fixture' || prior.inputHash !== inputHash ||
          prior.implementationRevision !== implementationRevision || prior.datasetHash !== datasetHash ||
          seal?.checkpointHash !== referenceDigest(prior)) throw new Error('Checkpoint/source mismatch; consumed test requires new untouched cohort');
      for (const name of ['report.json', 'input-pins.json']) {
        const artifact = await readPilotJson<unknown>(join(output, name));
        if (!artifact || referenceDigest(artifact) !== prior.artifactHashes[name]) throw new Error('Immutable locked artifact missing or changed');
      }
      return { exitCode: 0, event: 'locked_fixture_verified', reEvaluated: false, acceptedCandidate: null };
    }
    if ((await readdir(output)).some(name => name !== 'runner.lock')) throw new Error('Output without checkpoint is not fresh; inspect interrupted run');
    await mkdir(claim); // exclusive persistent consumption, including failed gates
    await atomicPilotJson(join(claim, 'started.json'), { inputHash, implementationRevision, datasetHash, origin: 'fixture',
      measuredTestInspected: false, nextAction: 'inspect_process_and_output_before_resuming_interrupted_preparation' });
    const report = evaluateLockedFixtures(input, implementationRevision);
    const commands = [{ command: 'pnpm --filter @eko/engines exec node --import tsx src/locked-test-cli.ts --fixture input.json output ledger',
      exitCode: 0, purpose: 'fixture preparation; immutable verification on identical resume' }];
    const { reportHash: _, ...reportBody } = report;
    const withCommands = { ...reportBody, commands };
    const artifacts = { 'report.json': { ...withCommands, reportHash: referenceDigest(withCommands) }, 'input-pins.json': { inputHash, implementationRevision,
      datasetHash, testIdentity, pins: report.pins, origin: 'fixture' } };
    for (const [name, value] of Object.entries(artifacts)) await atomicPilotJson(join(output, name), value);
    const checkpoint: Checkpoint = { version: LOCKED_TEST_VERSION, inputHash, implementationRevision, datasetHash,
      status: 'prepared_fixture', artifactHashes: Object.fromEntries(Object.entries(artifacts).map(([name, v]) => [name, referenceDigest(v)])),
      nextAction: report.nextAction };
    await atomicPilotJson(join(output, 'checkpoint.json'), checkpoint);
    await atomicPilotJson(join(claim, 'complete.json'), { checkpointHash: referenceDigest(checkpoint) });
    return { exitCode: 0, event: 'locked_fixture_prepared', status: report.status, acceptedCandidate: null };
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  lockedTestMain(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.exitCode; }).catch(() => {
    console.error('Locked fixture halted; inspect process, shared ledger and checkpoint. A failed gate requires new development and a new untouched test.');
    process.exitCode = 1;
  });
}
