import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { LabelAssignmentInputSchema, SignedDecisionSchema, importLabelDecisions } from './label-completion.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';

export const LabelCompletionFixtureSchema = z.strictObject({ version: z.literal('label-completion-fixture-059.1'),
  assignment: LabelAssignmentInputSchema, decisions: z.array(SignedDecisionSchema), previous: z.array(SignedDecisionSchema) })
  .refine(v => v.assignment.acquisition.origin === 'fixture' && [...v.decisions, ...v.previous].every(d => d.origin === 'fixture'),
    'Offline driver accepts fixtures only');
export async function labelCompletionCandidateRevision() {
  const files = ['apps/engines/src/label-completion.ts', 'apps/engines/src/label-completion-cli.ts',
    'apps/engines/src/acquisition-run.ts', 'apps/engines/src/probability-sample.ts',
    'apps/engines/src/selective-backfill.ts', 'apps/engines/src/coverage-pilot-store.ts',
    'packages/db/src/review-store.ts', 'packages/db/src/guard-store.ts',
    'packages/shared/src/contracts/guard-review.ts', 'packages/shared/src/contracts/guard-v2.ts',
    'packages/shared/src/contracts/common.ts', 'packages/chain/src/simulation/reference.ts', 'pnpm-lock.yaml'];
  const root = new URL('../../../', import.meta.url);
  return referenceDigest(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))));
}
/** New decisions use a new output with the prior signed ledger in `previous`.
 * Identical resumes are read-only verification; nothing provisions real roles,
 * supplies human answers, writes a database, contacts a provider or activates V2. */
export async function labelCompletionMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: label-completion-cli.ts --fixture input.json output-directory');
  const fixture = LabelCompletionFixtureSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const sourceRevision = referenceDigest(fixture), candidateRevision = await labelCompletionCandidateRevision();
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const result = importLabelDecisions(fixture.assignment, fixture.decisions, fixture.previous);
  const artifacts = { sourceRevision, candidateRevision, ...result }, artifactHash = referenceDigest(artifacts);
  const checkpoint = { version: 'label-completion-checkpoint-059.1', sourceRevision, candidateRevision, artifactHash,
    assignmentHash: result.plan.assignmentHash, labelSetHash: result.labelSetHash, status: 'prepared', nextAction: 'obtain_verified_independent_human_work' };
  const report = { version: 'label-completion-report-059.1', origin: 'fixture', sourceRevision, candidateRevision, artifactHash,
    assignmentHash: result.plan.assignmentHash, labelSetHash: result.labelSetHash, counts: result.counts, blockers: result.blockers,
    fixtureImportComplete: result.importComplete, measuredHumanJudgments: 0, measuredHumanValidation: false,
    actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: null,
    mode: 'shadow', released: false, process: { status: 'complete', checkpoint: 'checkpoint.json', artifacts: 'artifacts.json',
      nextAction: 'review_prepared_work_then_obtain_verified_independent_human_work' } };
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const prior = await readPilotJson<unknown>(join(output, 'checkpoint.json'));
    if (prior && referenceDigest(prior) !== referenceDigest(checkpoint)) throw new Error('Source/candidate checkpoint mismatch; new output required');
    for (const [name, value] of [['assignments.json', result.plan], ['artifacts.json', artifacts], ['report.json', report]] as const) {
      const saved = await readPilotJson<unknown>(join(output, name));
      if (saved && referenceDigest(saved) !== referenceDigest(value)) throw new Error('Immutable label import artifact differs');
      if (prior && !saved) throw new Error('Completed checkpoint missing artifact');
      if (!saved) await atomicPilotJson(join(output, name), value);
    }
    if (!prior) await atomicPilotJson(join(output, 'checkpoint.json'), checkpoint);
    console.log(JSON.stringify({ event: 'label_completion_fixture_prepared', sourceRevision, candidateRevision, artifactHash,
      labelSetHash: result.labelSetHash, counts: result.counts, blockers: result.blockers, measuredHumanJudgments: 0 }));
    return 0;
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  labelCompletionMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Label fixture import halted; inspect source and checkpoint.'); process.exitCode = 1;
  });
}
