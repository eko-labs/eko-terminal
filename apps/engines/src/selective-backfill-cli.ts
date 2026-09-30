import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { loadRegistry } from '@eko/chain';
import { pilotHash } from './coverage-pilot.js';
import { pilotCandidateRevision } from './coverage-pilot-cli.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { BackfillResponseSchema, SelectiveBackfillManifestSchema, backfillRequestKey,
  initialBackfillCheckpoint, runSelectiveBackfill, type BackfillCheckpoint, type BackfillIO, type BackfillRequest,
  type BackfillResponse } from './selective-backfill.js';
import { backfillMethodWeights, createMeasuredBackfillSource, measuredBackfillRpc } from './selective-backfill-source.js';

export const BackfillFixtureSchema = z.strictObject({ version: z.literal('selective-backfill-fixture-048.1'),
  responses: z.record(z.string().regex(/^[a-f0-9]{64}$/), BackfillResponseSchema) });
/** Offline answer for a fixture tape: an omitted request is an explicit missing response. */
export const fixtureResponse = (responses: Record<string, BackfillResponse>, r: BackfillRequest): BackfillResponse =>
  responses[backfillRequestKey(r)] ?? { kind: 'missing', reason:
    r.kind === 'header' ? 'header_unavailable' : r.kind === 'boundary' ? 'boundary_unavailable' : 'range_unavailable' };
export const jsonLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

export interface RunnerControl { stopped(): boolean; stop(): void; onStop(hook: () => void): void }
/** Exclusive output owner with signal and wall-clock stops. A stale lock needs lead inspection before removal. */
export async function withRunnerLock<T>(output: string, inputs: string[], maxMinutes: number | null,
  run: (control: RunnerControl) => Promise<T>): Promise<T> {
  if (inputs.some(p => resolve(p) === output || resolve(p).startsWith(`${output}${sep}`))) throw new Error('Source and output must be separate');
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock'); await mkdir(lock);
  let stopped = false; const hooks: (() => void)[] = [];
  const stop = () => { stopped = true; for (const hook of hooks) hook(); };
  const timer = maxMinutes === null ? null : setTimeout(stop, maxMinutes * 60_000);
  timer?.unref();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { return await run({ stopped: () => stopped, stop, onStop: hook => { hooks.push(hook); } }); }
  finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await rm(lock, { recursive: true });
  }
}
/** Atomic checkpoint and immutable content artifacts under `output`; logs ledger summaries only. */
export function durableBackfillIO(output: string, sourceRevision: string, control: RunnerControl, logEvent: string,
  source: Pick<BackfillIO, 'request' | 'bindAttempts'>, measured: boolean): BackfillIO {
  return { sourceRevision: async () => sourceRevision, stopped: control.stopped,
    now: () => performance.now(), rss: () => process.memoryUsage().rss,
    save: async value => {
      await atomicPilotJson(join(output, 'checkpoint.json'), value);
      jsonLog(logEvent, { status: value.status, reason: value.reason, ...(measured ?
        { requestCalls: value.calls, requestUnits: value.units, costNanoUsd: value.costNanoUsd } :
        { fixtureCalls: value.calls, fixtureUnits: value.units }) });
    },
    artifact: key => readPilotJson<BackfillResponse>(join(output, 'artifacts', `${key}.json`)),
    putArtifact: (key, response) => atomicPilotJson(join(output, 'artifacts', `${key}.json`), response),
    request: r => source.request(r),
    ...(source.bindAttempts ? { bindAttempts: source.bindAttempts } : {}) };
}
/** Bind an output to one manifest hash; a different manifest needs a separate output. */
export async function pinOutputManifest(output: string, manifest: unknown) {
  const hash = pilotHash(manifest), saved = await readPilotJson<{ hash: string }>(join(output, 'manifest.json'));
  if (saved && saved.hash !== hash) throw new Error('Output manifest mismatch');
  await atomicPilotJson(join(output, 'manifest.json'), { hash, manifest });
  await mkdir(join(output, 'artifacts'), { recursive: true });
}
export const exitCode = (status: BackfillCheckpoint['status']) => status === 'failed' ? 1 : status === 'stopped' ? 2 : 0;
const USAGE = 'Usage: selective-backfill-cli.ts --fixture manifest.json fixture.json output-directory | ' +
  '--measured manifest.json output-directory [--max-minutes N]';

/** Fixture driver (offline tape) or measured driver (paid-route metered RPC, endpoint from RPC_HTTP_URL). */
export async function selectiveBackfillMain(args: string[]) {
  if (args[0] === '--fixture' && args.length === 4) return fixtureMain(args[1], args[2], resolve(args[3]));
  const minutes = args.length === 5 && args[3] === '--max-minutes' ? Number(args[4]) : args.length === 3 ? 60 : NaN;
  if (args[0] === '--measured' && Number.isFinite(minutes) && minutes > 0) return measuredMain(args[1], resolve(args[2]), minutes);
  throw new Error(USAGE);
}
async function fixtureMain(manifestPath: string, fixturePath: string, output: string) {
  const m = SelectiveBackfillManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const fixture = BackfillFixtureSchema.parse(JSON.parse(await readFile(fixturePath, 'utf8')));
  if (m.validation !== 'fixture' || m.sourceRevision !== `0x${pilotHash(fixture)}`) throw new Error('Fixture source mismatch');
  return withRunnerLock(output, [manifestPath, fixturePath], null, async control => {
    const candidate = await pilotCandidateRevision(), owner = 'fixture-runner';
    const c = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json')) ?? initialBackfillCheckpoint(m, candidate, owner);
    await pinOutputManifest(output, m);
    const result = await runSelectiveBackfill(m, c, durableBackfillIO(output, m.sourceRevision, control,
      'selective_backfill_checkpoint', { request: async r => fixtureResponse(fixture.responses, r) }, false), candidate, owner);
    await atomicPilotJson(join(output, 'report.json'), { ...result,
      pricing: { kind: 'fixture_arithmetic_only', unitNanoUsd: m.budget.unitNanoUsd, weights: m.budget.weights },
      actualLiveRequestCalls: 0, actualLiveRequestUnits: 0, actualPaidNanoUsd: '0',
      process: { checkpoint: 'checkpoint.json', artifacts: 'artifacts', logEvent: 'selective_backfill_checkpoint',
        nextAction: result.status === 'complete' ? 'review_fixture_tape_then_prepare_verified_source_and_owner_resource_decision' :
          'inspect_named_gap_or_unconfirmed_attempt_before_resuming_same_source_candidate' } });
    return exitCode(result.status);
  });
}
async function measuredMain(manifestPath: string, output: string, maxMinutes: number) {
  const m = SelectiveBackfillManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (m.validation !== 'measured' || !m.budget.approvalRef || !m.budget.pricingEvidence) throw new Error('Measured manifest with recorded approval and pricing required');
  if (!process.env.RPC_HTTP_URL) throw new Error('RPC_HTTP_URL required');
  return withRunnerLock(output, [manifestPath], maxMinutes, async control => {
    const candidate = await pilotCandidateRevision(), owner = 'measured-runner';
    const { meter, store, rpc } = measuredBackfillRpc(process.env, m.budget, { onSessionBudget: control.stop, log: jsonLog });
    control.onStop(() => meter.stop());
    try {
      const c = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json')) ?? initialBackfillCheckpoint(m, candidate, owner);
      await pinOutputManifest(output, m);
      jsonLog('selective_backfill_process', { pid: process.pid, maxMinutes, checkpoint: 'checkpoint.json' });
      const source = createMeasuredBackfillSource({ rpc, store, registry: loadRegistry() });
      const result = await runSelectiveBackfill(m, c, durableBackfillIO(output, m.sourceRevision, control,
        'selective_backfill_checkpoint', source, true), candidate, owner);
      await atomicPilotJson(join(output, 'report.json'), { ...result,
        pricing: { kind: 'pre_dispatch_admissions_including_retries', evidence: m.budget.pricingEvidence,
          unitNanoUsd: m.budget.unitNanoUsd, weights: m.budget.weights, methodWeights: backfillMethodWeights(m.budget.weights) },
        actualLiveRequestCalls: result.requestCalls, actualLiveRequestUnits: result.requestUnits, actualPaidNanoUsd: result.rpcNanoUsd,
        process: { pid: process.pid, checkpoint: 'checkpoint.json', artifacts: 'artifacts', logEvent: 'selective_backfill_checkpoint',
          nextAction: result.status === 'complete' ? 'review_measured_tape_and_coverage_before_expansion' :
            'inspect_named_gap_or_unconfirmed_attempt_before_resuming_same_source_candidate' } });
      return exitCode(result.status);
    } finally { await meter.close(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selectiveBackfillMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Selective backfill halted; inspect manifest, source and checkpoint.'); process.exitCode = 1;
  });
}
