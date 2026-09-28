import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import { DevelopmentFitInputSchema, fitDevelopment } from './development-fit.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';

export async function developmentFitCandidateRevision() {
  const files = ['apps/engines/src/development-fit.ts', 'apps/engines/src/development-fit-statistics.ts',
    'apps/engines/src/development-fit-cli.ts', 'apps/engines/src/acquisition-run.ts', 'apps/engines/src/probability-sample.ts',
    'apps/engines/src/selective-backfill.ts', 'apps/engines/src/label-completion.ts', 'apps/engines/src/buyer-benchmark.ts',
    'apps/engines/src/buyer-benchmark-input.ts', 'apps/engines/src/coverage-pilot-store.ts',
    'packages/playbooks/src/guard-scoring.ts', 'packages/playbooks/src/guard-factors.ts',
    'packages/playbooks/src/guard-allocation.ts', 'packages/playbooks/src/guard-registry.ts',
    'packages/playbooks/src/history-v2.ts', 'packages/playbooks/config/guard-v2.ts',
    'packages/shared/src/canonical.ts', 'packages/policy/src/canonical.ts',
    'packages/shared/src/contracts/common.ts', 'packages/shared/src/contracts/receipt-encoding.ts',
    'packages/shared/src/contracts/guard-ids.ts', 'packages/shared/src/contracts/guard-scoring.ts', 'packages/shared/src/contracts/guard-history.ts',
    'packages/shared/src/contracts/guard-v2.ts', 'packages/shared/src/contracts/guard-review.ts',
    'packages/db/src/review-store.ts', 'packages/db/src/guard-store.ts', 'packages/chain/src/simulation/reference.ts', 'pnpm-lock.yaml'];
  const root = new URL('../../../', import.meta.url);
  return referenceDigest(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))));
}
/** Durable immutable fixture preparation. Identical resume verifies all outputs;
 * changed source/config/truth/labels require a new directory, preserving originals. */
export async function developmentFitMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: development-fit-cli.ts --fixture input.json output-directory');
  const input = DevelopmentFitInputSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  if (input.acquisition.origin !== 'fixture') throw new Error('Offline driver accepts fixtures only');
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const sourceRevision = referenceDigest(input), candidateRevision = await developmentFitCandidateRevision();
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const prior = await readPilotJson<{ sourceRevision: string; candidateRevision: string; artifactHashes: Record<string, string> }>(join(output, 'checkpoint.json'));
    if (prior) {
      if (prior.sourceRevision !== sourceRevision || prior.candidateRevision !== candidateRevision) throw new Error('Source/candidate mismatch; new output required');
      for (const name of ['evidence.json', 'freeze.json', 'report.json']) {
        const value = await readPilotJson<unknown>(join(output, name));
        if (!value || referenceDigest(value) !== prior.artifactHashes[name]) throw new Error('Immutable fitting artifact missing or changed');
      }
      console.log(JSON.stringify({ event: 'development_fixture_verified', sourceRevision, candidateRevision, acceptedCandidate: null }));
      return 0;
    }
    const result = fitDevelopment(input, candidateRevision);
    const report = { version: 'development-fit-report-060.1', origin: 'fixture', sourceRevision, candidateRevision,
      freezeHash: result.freeze.freezeHash, calibrationHash: result.freeze.calibrationHash, acceptedCandidate: null,
      status: result.freeze.status, blockers: result.blockers, coverage: result.evidence.coverage,
      actualValidation: result.evidence.actualValidation, actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: null,
      mode: 'shadow', active: false, released: false, historyEnabled: false, bucketsEnabled: false,
      process: { status: 'complete', nextAction: 'obtain_measured_development_and_independent_labels_before_candidate_selection' } };
    const artifacts = { 'evidence.json': result.evidence, 'freeze.json': result.freeze, 'report.json': report };
    for (const [name, value] of Object.entries(artifacts)) {
      const saved = await readPilotJson<unknown>(join(output, name));
      if (saved && referenceDigest(saved) !== referenceDigest(value)) throw new Error('Immutable fitting artifact differs');
      if (!saved) await atomicPilotJson(join(output, name), value);
    }
    await atomicPilotJson(join(output, 'checkpoint.json'), { version: 'development-fit-checkpoint-060.1', sourceRevision,
      candidateRevision, freezeHash: result.freeze.freezeHash, status: 'prepared',
      artifactHashes: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, referenceDigest(value)])),
      nextAction: report.process.nextAction });
    console.log(JSON.stringify({ event: 'development_fixture_prepared', ...report }));
    return 0;
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  developmentFitMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Development fixture halted; inspect source and checkpoint.'); process.exitCode = 1;
  });
}
