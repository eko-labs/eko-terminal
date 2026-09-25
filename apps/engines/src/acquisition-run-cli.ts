import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import { AcquisitionDefinitionSchema, prepareAcquisition } from './acquisition-run.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { initialBackfillCheckpoint } from './selective-backfill.js';
import { pilotCandidateRevision } from './coverage-pilot-cli.js';

export async function acquisitionCandidateRevision() {
  const files = ['apps/engines/src/acquisition-run.ts', 'apps/engines/src/acquisition-run-cli.ts',
    'apps/engines/src/probability-sample.ts', 'apps/engines/src/selective-backfill.ts',
    'apps/engines/src/selective-backfill-cli.ts', 'apps/engines/src/coverage-pilot.ts',
    'apps/engines/src/coverage-pilot-store.ts', 'apps/engines/src/buyer-benchmark.ts',
    'apps/engines/src/buyer-benchmark-input.ts', 'packages/shared/src/contracts/guard-v2.ts',
    'packages/shared/src/contracts/common.ts', 'packages/chain/src/simulation/reference.ts', 'pnpm-lock.yaml'];
  const root = new URL('../../../', import.meta.url);
  return referenceDigest(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))));
}

/** Dry-run only. No transport, endpoint lookup, worker start or secret read. */
export async function acquisitionRunMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--dry-run')
    throw new Error('Usage: acquisition-run-cli.ts --dry-run definition.json output-directory');
  const definition = AcquisitionDefinitionSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const preparation = prepareAcquisition(definition), candidateRevision = await acquisitionCandidateRevision();
  const output = resolve(args[2]), input = resolve(args[1]);
  if (input === output || input.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const runnerRevision = await pilotCandidateRevision();
  const checkpoint = { version: 'acquisition-preparation-058.1', candidateRevision, runnerRevision,
    manifestHash: preparation.manifestHash, status: 'prepared', owner: 'preparation-runner',
    requestCalls: 0, requestUnits: 0, paidNanoUsd: '0', completedRanges: [] };
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const saved = await readPilotJson<unknown>(join(output, 'preparation.json'));
    if (saved && referenceDigest(saved) !== referenceDigest(preparation)) throw new Error('Frozen preparation differs; new output required');
    const prior = await readPilotJson<unknown>(join(output, 'checkpoint.json'));
    if (prior && referenceDigest(prior) !== referenceDigest(checkpoint)) throw new Error('Preparation candidate/checkpoint differs');
    if (prior && !saved) throw new Error('Preparation checkpoint missing manifest');
    const backfill = definition.backfill;
    // These are starter artifacts, separate from any real runner output/ledger.
    const starter = backfill ? initialBackfillCheckpoint(backfill, runnerRevision, 'fixture-runner') : null;
    for (const [name, value] of [['backfill-manifest.json', backfill], ['backfill-checkpoint.json', starter]] as const) {
      const existing = await readPilotJson<unknown>(join(output, name));
      if (existing && referenceDigest(existing) !== referenceDigest(value)) throw new Error('Backfill starter differs');
    }
    if (!saved) await atomicPilotJson(join(output, 'preparation.json'), preparation);
    if (backfill) {
      await atomicPilotJson(join(output, 'backfill-manifest.json'), backfill);
      await atomicPilotJson(join(output, 'backfill-checkpoint.json'), starter);
    }
    await atomicPilotJson(join(output, 'checkpoint.json'), checkpoint);
    await atomicPilotJson(join(output, 'report.json'), { version: 'acquisition-preparation-report-058.1',
      candidateRevision, runnerRevision, definitionHash: preparation.definitionHash, manifestHash: preparation.manifestHash,
      origin: definition.origin, status: preparation.status, dryRun: true, mode: 'shadow', released: false,
      actualRequestCalls: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0',
      pricing: { evidence: definition.budget.pricingEvidence, unitNanoUsd: definition.budget.unitNanoUsd,
        weights: definition.budget.weights, fixedNanoUsd: definition.budget.fixedNanoUsd,
        capNanoUsd: definition.budget.capNanoUsd, checkpointUnits: definition.budget.checkpointUnits,
        invoiceNanoUsd: null, kind: definition.origin === 'fixture' ? 'fixture_arithmetic_only' : 'unexecuted_declared_pricing' },
      coverage: { reconstructedTokens: 0, completedRanges: [], measuredValidation: false,
        nativeFundingComplete: false, historyComplete: false, primaryOutcomesMature: false,
        populationFrozen: preparation.sample !== null, sources: definition.sources },
      process: { status: 'prepared_no_acquisition_started', pid: null, checkpoint: 'checkpoint.json',
        logEvent: 'acquisition_preparation_complete', nextAction: preparation.sample === null ?
          'obtain_complete_enumeration_and_pin_groups_before_labels_in_new_preparation' :
          'review_preparation_and_source_coverage_obtain_owner_resource_decision_before_paid_work',
        fixtureRunner: backfill?.validation === 'fixture' ? 'selective-backfill-cli.ts --fixture backfill-manifest.json fixture.json separate-output' : null } });
    console.log(JSON.stringify({ event: 'acquisition_preparation_complete', candidateRevision,
      manifestHash: preparation.manifestHash, status: preparation.status, actualRequestUnits: 0 }));
    return 0;
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acquisitionRunMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Acquisition preparation halted; inspect definition and checkpoint.'); process.exitCode = 1;
  });
}
