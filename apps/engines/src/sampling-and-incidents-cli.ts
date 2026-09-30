import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { drawProbabilitySample, ProbabilityFrameSchema } from './probability-sample.js';
import { importMatchedSources, prepareIncidentChallenge, IncidentChallengeInputSchema, MatchedSourceRecordSchema } from './matched-source.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';

export const SamplingFixtureSchema = z.strictObject({ version: z.literal('sampling-fixture-057.1'),
  frame: ProbabilityFrameSchema, matches: z.array(MatchedSourceRecordSchema).min(100), incident: IncidentChallengeInputSchema,
}).refine(m => m.frame.origin === 'fixture' && m.incident.origin === 'fixture' && m.matches.every(r => r.origin === 'fixture'),
  'Offline driver accepts fixtures only');

export async function samplingCandidateRevision() {
  const files = ['apps/engines/src/probability-sample.ts', 'apps/engines/src/matched-source.ts',
    'apps/engines/src/sampling-and-incidents-cli.ts', 'apps/engines/src/coverage-pilot-store.ts',
    'packages/shared/src/contracts/guard-v2.ts', 'packages/shared/src/contracts/common.ts',
    'packages/chain/src/simulation/reference.ts', 'pnpm-lock.yaml'];
  const root = new URL('../../../', import.meta.url);
  return referenceDigest(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))));
}

/** Opt-in local fixture preparation only; never dispatches requests or writes review labels. */
export async function samplingAndIncidentsMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: sampling-and-incidents-cli.ts --fixture input.json output-directory');
  const fixture = SamplingFixtureSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  const sourceRevision = referenceDigest(fixture), candidateRevision = await samplingCandidateRevision();
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}${sep}`)) throw new Error('Separate source/output required');
  const sample = drawProbabilitySample(fixture.frame), matches = importMatchedSources(fixture.matches);
  const incident = prepareIncidentChallenge(fixture.incident, sample);
  const artifacts = { sourceRevision, candidateRevision, sample, matches, incident };
  const artifactHash = referenceDigest(artifacts);
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  try {
    const checkpoint = { version: 'sampling-checkpoint-057.1', sourceRevision, candidateRevision, artifactHash, status: 'complete' };
    const prior = await readPilotJson<unknown>(join(output, 'checkpoint.json'));
    if (prior && referenceDigest(prior) !== referenceDigest(checkpoint)) throw new Error('Source/candidate checkpoint mismatch; new output required');
    const saved = await readPilotJson<unknown>(join(output, 'artifacts.json'));
    if (saved && referenceDigest(saved) !== artifactHash) throw new Error('Immutable sample/import artifacts differ');
    if (prior && !saved) throw new Error('Completed checkpoint missing artifacts');
    if (!saved) await atomicPilotJson(join(output, 'artifacts.json'), artifacts);
    await atomicPilotJson(join(output, 'checkpoint.json'), checkpoint);
    await atomicPilotJson(join(output, 'report.json'), { version: 'sampling-report-057.1', origin: 'fixture', sourceRevision, candidateRevision,
      artifactHash, sampleSize: sample.sampleSize, populationSize: sample.populationSize, matches: matches.records.length,
      measuredMatchedRecords: 0, incidentMembers: incident.members.length, incidentReproduced: false,
      actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', providerPricing: null,
      fixturePricing: 'local_computation_zero_remote_cost', mode: 'shadow', released: false,
      process: { status: 'complete', checkpoint: 'checkpoint.json', artifacts: 'artifacts.json', logEvent: 'sampling_fixture_complete',
        nextAction: 'review_frozen_design_then_obtain_verified_source_capabilities_and_incident_manifest' } });
    console.log(JSON.stringify({ event: 'sampling_fixture_complete', sourceRevision, candidateRevision, artifactHash,
      sampleSize: sample.sampleSize, matchedFixtureRecords: matches.records.length, incidentMembers: incident.members.length }));
    return 0;
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  samplingAndIncidentsMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Sampling fixture halted; inspect source and checkpoint.'); process.exitCode = 1;
  });
}
