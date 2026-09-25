import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDigest } from '@eko/chain';
import { BuyerBenchmarkManifestSchema } from './buyer-benchmark-input.js';
import { initialBenchmarkCheckpoint, runBuyerBenchmark, type BenchmarkCheckpoint } from './buyer-benchmark.js';
import { ponsBenchmarkFixtureAdapter, verifyPonsBenchmarkFixture } from './buyer-benchmark-pons.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';

export async function buyerBenchmarkCandidateRevision() {
  // Include dirty candidate source bytes, without personal paths or unrelated worktree files.
  const files = ['apps/engines/src/buyer-benchmark-input.ts', 'apps/engines/src/buyer-benchmark.ts',
    'apps/engines/src/buyer-benchmark-pons.ts', 'apps/engines/src/buyer-benchmark-cli.ts', 'apps/engines/src/coverage-pilot-store.ts',
    'packages/chain/src/simulation/campaign-input.ts', 'packages/chain/src/simulation/campaign-replay.ts',
    'packages/chain/src/simulation/campaign-pressure.ts', 'packages/chain/src/simulation/pons-math.ts',
    'packages/chain/src/simulation/reference.ts', 'packages/shared/src/contracts/guard-v2.ts',
    'packages/shared/src/contracts/guard-storage.ts', 'packages/shared/src/canonical.ts', 'pnpm-lock.yaml'];
  const root = new URL('../../../', import.meta.url);
  return referenceDigest(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, root), 'utf8') }))));
}

/** Offline fixture runner only. No endpoints, ports, paid dispatch or worker integration. */
export async function buyerBenchmarkMain(args: string[]) {
  if (args.length !== 3 || args[0] !== '--fixture') throw new Error('Usage: buyer-benchmark-cli.ts --fixture manifest.json output-directory');
  const m = BuyerBenchmarkManifestSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  if (m.origin !== 'fixture') throw new Error('Benchmark CLI requires fixtures');
  verifyPonsBenchmarkFixture(m.frames);
  const output = resolve(args[2]), source = resolve(args[1]);
  if (source === output || source.startsWith(`${output}/`)) throw new Error('Source/output must be separate');
  const candidate = await buyerBenchmarkCandidateRevision();
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  let stopped = false; const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await mkdir(join(output, 'artifacts'), { recursive: true });
    const c = await readPilotJson<BenchmarkCheckpoint>(join(output, 'checkpoint.json')) ?? initialBenchmarkCheckpoint(m, candidate);
    const result = await runBuyerBenchmark(m, c, ponsIO(), ponsBenchmarkFixtureAdapter, candidate);
    await atomicPilotJson(join(output, 'report.json'), { ...result,
      pricing: 'local_fixture_zero_remote_cost', process: { checkpoint: 'checkpoint.json', artifacts: 'artifacts', logEvent: 'buyer_benchmark_checkpoint',
        nextAction: result.status === 'complete' ? 'prepare_independently_verified_matches_before_calibration' : 'inspect_stop_reason_then_resume_same_source_candidate' } });
    return result.status === 'complete' ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await rm(lock, { recursive: true });
  }
  function ponsIO() {
    return { sourceRevision: async () => m.sourceRevision, stopped: () => stopped,
      artifact: (key: string) => readPilotJson<unknown>(join(output, 'artifacts', `${key}.json`)),
      putArtifact: (key: string, value: unknown) => atomicPilotJson(join(output, 'artifacts', `${key}.json`), value),
      save: async (value: BenchmarkCheckpoint) => {
        await atomicPilotJson(join(output, 'checkpoint.json'), value);
        console.log(JSON.stringify({ event: 'buyer_benchmark_checkpoint', status: value.status, reason: value.reason, localEvaluations: value.artifacts.length }));
      } };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buyerBenchmarkMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Buyer benchmark halted; inspect manifest and checkpoint.'); process.exitCode = 1;
  });
}
