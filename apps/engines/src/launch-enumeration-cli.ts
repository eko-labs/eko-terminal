import { withRpcOrigin } from '@eko/chain';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadRegistry, type AddressRegistry } from '@eko/chain';
import { pilotHash } from './coverage-pilot.js';
import { pilotCandidateRevision } from './coverage-pilot-cli.js';
import { atomicPilotJson, readPilotJson } from './coverage-pilot-store.js';
import { AcquisitionDefinitionSchema, type AcquisitionDefinition } from './acquisition-run.js';
import { BackfillStop, backfillFrame, type BackfillCheckpoint, type BackfillIO, type BackfillResponse } from './selective-backfill.js';
import { BackfillAttemptStore, backfillMethodWeights, createMeasuredBackfillSource, measuredBackfillRpc, parseRpcHeader,
  raiseBackfillStops, type BackfillRpc } from './selective-backfill-source.js';
import { BackfillFixtureSchema, durableBackfillIO, exitCode, fixtureResponse, jsonLog, pinOutputManifest,
  withRunnerLock } from './selective-backfill-cli.js';
import { LaunchEnumerationManifestSchema, PONS_LAUNCH_TOPIC, UNVERIFIED_LAUNCHPADS, initialEnumerationCheckpoint,
  launchPopulationInput, runLaunchEnumeration, type LaunchEnumerationManifest, type LaunchEnumerationResult } from './launch-enumeration.js';

const DAY = 86400;
type Cursor = Extract<BackfillResponse, { kind: 'header' }>['cursor'];
type Budget = LaunchEnumerationManifest['budget'];
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const finality = z.enum(['finalized', 'safe', 'latest']);
export const ENUMERATION_OUTPUTS = ['manifest.json', 'pin.json', 'checkpoint.json', 'artifacts/', 'launches.json',
  'population-input.json', 'report.json'] as const;
const USAGE = 'Usage: launch-enumeration-cli.ts --plan|--measured --from YYYY-MM-DD [--days N] --definition definition.json ' +
  '[--output directory] [--max-units N] [--finality finalized|safe|latest] [--max-minutes N] | ' +
  '--fixture manifest.json fixture.json output-directory';
const OptionsSchema = z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(51).default(1),
  definition: z.string().min(1), output: z.string().min(1).optional(), maxUnits: z.coerce.number().int().min(100).max(250000).default(1000),
  finality: finality.default('finalized'), maxMinutes: z.coerce.number().positive().max(240).default(20) });
export type EnumerationOptions = z.infer<typeof OptionsSchema>;
export function parseEnumerationOptions(args: string[]): EnumerationOptions {
  const raw: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || i + 1 >= args.length) throw new Error(USAGE);
    raw[args[i].slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = args[i + 1];
  }
  const o = OptionsSchema.parse(raw), ms = Date.parse(`${o.from}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== o.from) throw new Error('Invalid --from date');
  return o;
}
/** Whole UTC days inside the definition's declared metadata frame. */
export function enumerationWindow(o: EnumerationOptions, definition: AcquisitionDefinition) {
  const fromSec = Date.parse(`${o.from}T00:00:00Z`) / 1000, untilSec = fromSec + o.days * DAY;
  const frame = backfillFrame(definition.startSec, 'cohort14plus7', definition.historyMetadata).metadata;
  if (fromSec < Number(frame.fromSec) || untilSec > Number(frame.untilSec)) throw new Error('Window outside the definition frame');
  return { fromSec: String(fromSec), untilSec: String(untilSec) };
}
/** The definition's approval and pricing with a smaller enumeration cap; the finality pin is a fixed cost. */
export function enumerationBudget(definition: AcquisitionDefinition, maxUnits: number, pin: { units: number; costNanoUsd: string }): Budget {
  const b = definition.budget;
  if (maxUnits > b.checkpointUnits || BigInt(maxUnits) * BigInt(b.unitNanoUsd) > BigInt(b.capNanoUsd)) throw new Error('Enumeration cap exceeds the approved budget');
  if (pin.units >= maxUnits) throw new BackfillStop('cap_reached');
  return { approvalRef: b.approvalRef, pricingEvidence: b.pricingEvidence, unitNanoUsd: b.unitNanoUsd, weights: b.weights,
    checkpointUnits: maxUnits - pin.units, capNanoUsd: (BigInt(maxUnits) * BigInt(b.unitNanoUsd)).toString(), fixedNanoUsd: pin.costNanoUsd };
}
const defaultOutput = (o: EnumerationOptions) => o.output ?? `../../.data/eko-058/launches-${o.from}${o.days > 1 ? `-${o.days}d` : ''}`;
const usd = (nano: bigint) => `$${(Number(nano) / 1e9).toFixed(6)}`;

/** Estimate-only chain model for the dry run (the run itself searches real headers and never extrapolates):
 * a captured Pons launch block and the measured ~10 blocks/s. */
export const PLAN_MODEL = { block: 77438503n, timestampSec: 1790864133n, blocksPerSecond: 10n,
  basis: 'captured Pons launch block 77438503 at 2026-10-01T14:15:33Z (packages/chain fixture) and ~10 blocks/s (Guard facts §2)' };
const floorDiv = (a: bigint, b: bigint) => a >= 0n ? a / b : -((-a + b - 1n) / b);
/** Offline plan: runs the real enumeration over a modeled chain to count requests. No network, no files. */
export async function launchEnumerationPlan(o: EnumerationOptions, definition: AcquisitionDefinition, registry: AddressRegistry, nowSec: number) {
  const { fromSec, untilSec } = enumerationWindow(o, definition), weights = definition.budget.weights;
  const pinUnits = weights.header, budget = enumerationBudget(definition, o.maxUnits,
    { units: pinUnits, costNanoUsd: (BigInt(pinUnits) * BigInt(definition.budget.unitNanoUsd)).toString() });
  const p = PLAN_MODEL, headSec = BigInt(Math.max(nowSec, Number(untilSec) + 3600));
  const at = (n: bigint): Cursor => ({ chainId: 4663, blockNumber: n.toString(), blockHash: `0x${n.toString(16).padStart(64, '0')}`,
    transactionIndex: null, executionOrdinal: null, boundary: 'block_end',
    timestampSec: (p.timestampSec + floorDiv(n - p.block, p.blocksPerSecond)).toString() });
  const watermark = at(p.block + (headSec - p.timestampSec) * p.blocksPerSecond), revision = `0x${pilotHash('dry-run-model')}`;
  const m = LaunchEnumerationManifestSchema.parse({ version: 'launch-enumeration-058.1', validation: 'fixture', chainId: 4663,
    sourceRevision: revision, availability: { id: revision, sourceId: 'dry-run-model', sourceRevision: revision,
      replayMode: 'retrospective', cut: { cursor: watermark, acquisitionSequence: '0' }, watermark,
      acquiredAt: new Date(Number(headSec) * 1000).toISOString() },
    fromSec, untilSec, launchpads: [{ id: 'pons', factory: registry.requireAddress('pons.factory'), topic: PONS_LAUNCH_TOPIC }], budget });
  const artifacts = new Map<string, BackfillResponse>(), candidate = '0'.repeat(64), c = initialEnumerationCheckpoint(m, candidate, 'dry-run-plan');
  const io: BackfillIO = { sourceRevision: async () => revision, stopped: () => false, now: () => 0, rss: () => 0, save: async () => {},
    artifact: async key => artifacts.get(key) ?? null, putArtifact: async (key, value) => { artifacts.set(key, value); },
    request: async r => r.kind === 'header' ? { kind: 'header', cursor: at(BigInt(r.block)) } :
      r.kind === 'logs' ? { kind: 'logs', events: [], launches: [] } : { kind: 'missing', reason: 'boundary_unavailable' } };
  const modeled = await runLaunchEnumeration(m, c, io, candidate, 'dry-run-plan', registry);
  if (modeled.status !== 'complete') throw new Error('Dry-run model did not complete');
  const headers = c.requests.filter(r => r.request.kind === 'header').length, logs = c.requests.length - headers;
  const units = pinUnits + c.units, unit = BigInt(definition.budget.unitNanoUsd), output = defaultOutput(o);
  const searchBound = 2 * Math.ceil(Math.log2(Number(watermark.blockNumber) + 1));
  return { version: 'launch-enumeration-plan-058.1' as const, dryRun: true as const, networkCalls: 0,
    window: { from: new Date(Number(fromSec) * 1000).toISOString(), until: new Date(Number(untilSec) * 1000).toISOString(), fromSec, untilSec, days: o.days },
    launchpads: m.launchpads, unverifiedLaunchpads: UNVERIFIED_LAUNCHPADS,
    command: `pnpm --filter @eko/engines exec node --import tsx src/launch-enumeration-cli.ts --measured --from ${o.from} --days ${o.days} ` +
      `--definition ${o.definition} --output ${output} --max-units ${o.maxUnits} --finality ${o.finality} --max-minutes ${o.maxMinutes}`,
    environment: ['RPC_HTTP_URL (paid endpoint, exported in the shell; never written to files)', 'RPC_PAID_MAX_RPM (optional, default 1200)'],
    requests: { finalityPin: 1, watermarkCheck: 1, timestampSearchHeaders: headers - 1, factoryLogPages: logs, expectedTotal: 1 + c.calls,
      searchHeaderBound: searchBound, perDenseSplit: 2, perZeroTimestampBlock: 1 },
    cost: { unitNanoUsd: definition.budget.unitNanoUsd, expectedNanoUsd: (BigInt(units) * unit).toString(), expectedUsd: usd(BigInt(units) * unit),
      capUnits: o.maxUnits, capNanoUsd: (BigInt(o.maxUnits) * unit).toString(), capUsd: usd(BigInt(o.maxUnits) * unit),
      approvalRef: definition.budget.approvalRef, pricingEvidence: definition.budget.pricingEvidence },
    outputs: ENUMERATION_OUTPUTS.map(name => `${output}/${name}`),
    assumptions: [`request counts are modeled from ${p.basis}; the live run finds both day boundaries by header search`,
      'one factory log page per 100,000 blocks before any dense split; each split adds 2 pages',
      'logs carry positive blockTimestamp on the paid route (Guard facts §2); a zero timestamp costs one header per block',
      `the run stops before dispatch at ${o.maxUnits} requests, and after ${o.maxMinutes} minutes`] };
}
export function formatEnumerationPlan(plan: Awaited<ReturnType<typeof launchEnumerationPlan>>) {
  const r = plan.requests, p = plan.launchpads[0];
  return [`Launch enumeration dry-run plan (no network calls made)`,
    `  Window       ${plan.window.from} to ${plan.window.until} (${plan.window.days} UTC day${plan.window.days > 1 ? 's' : ''}, half-open)`,
    `  Emitters     ${p.id} factory ${p.factory}, TokenLaunched ${p.topic}; not enumerable yet: ${plan.unverifiedLaunchpads.join(', ')}`,
    `  Environment  ${plan.environment.join('; ')}`,
    `  Command      ${plan.command}`,
    `  Requests     ~${r.expectedTotal} expected: ${r.finalityPin} finality pin, ${r.watermarkCheck} watermark check, ` +
      `${r.timestampSearchHeaders} timestamp-search headers (bound ${r.searchHeaderBound}), ${r.factoryLogPages} factory log pages; +${r.perDenseSplit} per dense split`,
    `  Cost         ~${plan.cost.expectedUsd} at ${plan.cost.unitNanoUsd} nano-USD per request; hard cap ${plan.cost.capUnits} requests = ${plan.cost.capUsd}`,
    `  Approval     ${plan.cost.approvalRef}, pricing evidence ${plan.cost.pricingEvidence}`,
    `  Outputs      ${plan.outputs.join(', ')}`,
    ...plan.assumptions.map((a, i) => `  ${i ? '            ' : 'Assumptions '} ${a}`)].join('\n');
}

const PinLedgerSchema = z.strictObject({ version: z.literal('launch-enumeration-pin-058.1'), calls: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(), costNanoUsd: uint,
  pins: z.array(z.strictObject({ finality, acquiredAt: z.iso.datetime(), cursor: z.unknown().nullable() })) });
export type PinLedger = z.infer<typeof PinLedgerSchema>;
/** Pin the finalized (or chosen) head as the run's watermark. Each attempt, retries included, is charged to the
 * pin ledger before dispatch and persisted; the pin's spend later enters the manifest as a fixed cost. */
export async function pinEnumerationWatermark(rpc: BackfillRpc, store: BackfillAttemptStore, pin: PinLedger,
  limits: { finality: z.infer<typeof finality>; maxUnits: number; unitNanoUsd: string; headerWeight: number },
  save: (pin: PinLedger) => Promise<void>, now: () => string): Promise<Cursor | null> {
  if (pin.units !== pin.calls * limits.headerWeight || BigInt(pin.costNanoUsd) !== BigInt(pin.units) * BigInt(limits.unitNanoUsd))
    throw new Error('Pin ledger mismatch');
  store.bind(async kind => {
    if (kind !== 'header') throw new Error('Unexpected pin attempt');
    if (pin.units + limits.headerWeight > limits.maxUnits) throw new BackfillStop('cap_reached');
    pin.calls++; pin.units += limits.headerWeight;
    pin.costNanoUsd = (BigInt(pin.units) * BigInt(limits.unitNanoUsd)).toString(); await save(pin);
  });
  let raw: unknown = null;
  try { raw = await withRpcOrigin('engines.launch_enumeration_cli.rawL140',()=>rpc.request('eth_getBlockByNumber', [limits.finality, false])); }
  catch (error) { raiseBackfillStops(store, error); }
  finally { store.bind(null); }
  const cursor = parseRpcHeader(raw);
  pin.pins.push({ finality: limits.finality, acquiredAt: now(), cursor }); await save(pin);
  return cursor;
}
/** The measured manifest for a pinned watermark; the source revision commits to chain, route, finality and pin.
 * `sourceId` is the definition's launch source, so the population plugs into it unchanged. */
export function measuredEnumerationManifest(input: { fromSec: string; untilSec: string; watermark: Cursor; sourceId: string;
  finality: z.infer<typeof finality>; acquiredAt: string; factory: string; budget: Budget }): LaunchEnumerationManifest {
  const sourceId = input.sourceId, cut = { cursor: input.watermark, acquisitionSequence: '0' };
  const sourceRevision = `0x${pilotHash({ chainId: 4663, sourceId, route: 'paid-only', finality: input.finality, watermark: input.watermark })}`;
  return LaunchEnumerationManifestSchema.parse({ version: 'launch-enumeration-058.1', validation: 'measured', chainId: 4663,
    sourceRevision, availability: { id: `0x${pilotHash({ sourceRevision, cut })}`, sourceId, sourceRevision,
      replayMode: 'retrospective', cut, watermark: input.watermark, acquiredAt: input.acquiredAt },
    fromSec: input.fromSec, untilSec: input.untilSec, launchpads: [{ id: 'pons', factory: input.factory, topic: PONS_LAUNCH_TOPIC }],
    budget: input.budget });
}

async function writeOutputs(output: string, m: LaunchEnumerationManifest, result: LaunchEnumerationResult,
  run: { pid: number | null; pin: PinLedger | null }) {
  await atomicPilotJson(join(output, 'launches.json'), { version: 'launch-list-058.1', validation: m.validation,
    sourceRevision: m.sourceRevision, window: result.window, range: result.range, status: result.status,
    enumerationComplete: result.enumerationComplete, unverifiedLaunchpads: result.unverifiedLaunchpads,
    count: result.launches.length, launches: result.launches });
  await atomicPilotJson(join(output, 'population-input.json'), launchPopulationInput(m, result));
  const { launches, ...summary } = result;
  const measured = m.validation === 'measured', pin = run.pin ?? { calls: 0, units: 0, costNanoUsd: '0' };
  await atomicPilotJson(join(output, 'report.json'), { ...summary, launchCount: launches.length,
    pricing: { kind: measured ? 'pre_dispatch_admissions_including_retries' : 'fixture_arithmetic_only', evidence: m.budget.pricingEvidence,
      unitNanoUsd: m.budget.unitNanoUsd, weights: m.budget.weights, methodWeights: backfillMethodWeights(m.budget.weights) },
    pin: { calls: pin.calls, units: pin.units, costNanoUsd: pin.costNanoUsd },
    // Pin attempts (all of them, including earlier not-yet-final ones) plus the enumeration ledger.
    actualLiveRequestCalls: measured ? result.requestCalls + pin.calls : 0, actualLiveRequestUnits: measured ? result.requestUnits + pin.units : 0,
    actualPaidNanoUsd: measured ? (BigInt(result.rpcNanoUsd) + BigInt(pin.costNanoUsd)).toString() : '0',
    process: { pid: run.pid, checkpoint: 'checkpoint.json', pin: run.pin ? 'pin.json' : null, artifacts: 'artifacts', logEvent: 'launch_enumeration_checkpoint',
      nextAction: result.status === 'complete' ? 'review_launch_list_then_pin_eligibility_and_groups_for_the_full_frame' :
        'inspect_named_gap_or_stop_before_resuming_same_output' } });
}

/** Plan (offline), measured enumeration (paid-route metered RPC), or fixture enumeration (offline tape). */
export async function launchEnumerationMain(args: string[]) {
  if (args[0] === '--fixture' && args.length === 4) return fixtureMain(args[1], args[2], resolve(args[3]));
  if (args[0] !== '--plan' && args[0] !== '--measured') throw new Error(USAGE);
  const o = parseEnumerationOptions(args.slice(1));
  const definition = AcquisitionDefinitionSchema.parse(JSON.parse(await readFile(o.definition, 'utf8')));
  if (args[0] === '--plan') {
    console.log(formatEnumerationPlan(await launchEnumerationPlan(o, definition, loadRegistry(), Math.floor(Date.now() / 1000))));
    return 0;
  }
  return measuredMain(o, definition);
}
async function fixtureMain(manifestPath: string, fixturePath: string, output: string) {
  const m = LaunchEnumerationManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const fixture = BackfillFixtureSchema.parse(JSON.parse(await readFile(fixturePath, 'utf8')));
  if (m.validation !== 'fixture' || m.sourceRevision !== `0x${pilotHash(fixture)}`) throw new Error('Fixture source mismatch');
  return withRunnerLock(output, [manifestPath, fixturePath], null, async control => {
    const candidate = await pilotCandidateRevision(), owner = 'fixture-runner', registry = loadRegistry();
    const c = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json')) ?? initialEnumerationCheckpoint(m, candidate, owner);
    await pinOutputManifest(output, m);
    const result = await runLaunchEnumeration(m, c, durableBackfillIO(output, m.sourceRevision, control, 'launch_enumeration_checkpoint',
      { request: async r => fixtureResponse(fixture.responses, r) }, false), candidate, owner, registry);
    await writeOutputs(output, m, result, { pid: null, pin: null });
    return exitCode(result.status);
  });
}
async function measuredMain(o: EnumerationOptions, definition: AcquisitionDefinition) {
  if (!definition.budget.approvalRef || !definition.budget.pricingEvidence) throw new Error('Recorded approval and pricing required');
  if (!process.env.RPC_HTTP_URL) throw new Error('RPC_HTTP_URL required');
  const { fromSec, untilSec } = enumerationWindow(o, definition), output = resolve(defaultOutput(o)), registry = loadRegistry();
  const provisional = enumerationBudget(definition, o.maxUnits, { units: 0, costNanoUsd: '0' });
  return withRunnerLock(output, [o.definition], o.maxMinutes, async control => {
    const { meter, store, rpc } = measuredBackfillRpc(process.env, provisional, { onSessionBudget: control.stop, log: jsonLog });
    control.onStop(() => meter.stop());
    const stopped = async (reason: string, pin: PinLedger) => {
      await atomicPilotJson(join(output, 'report.json'), { version: 'launch-enumeration-058.1', status: 'stopped', reason,
        window: { fromSec, untilSec }, actualLiveRequestCalls: pin.calls, actualLiveRequestUnits: pin.units, actualPaidNanoUsd: pin.costNanoUsd,
        process: { pid: process.pid, pin: 'pin.json', nextAction: reason === 'window_not_final' ? 'rerun_after_the_window_is_final' : 'inspect_pin_ledger' } });
      jsonLog('launch_enumeration_stopped', { reason, pinCalls: pin.calls });
      return 2;
    };
    try {
      jsonLog('launch_enumeration_process', { pid: process.pid, maxMinutes: o.maxMinutes, maxUnits: o.maxUnits });
      const candidate = await pilotCandidateRevision(), owner = 'measured-runner';
      const saved = await readPilotJson<{ manifest: unknown }>(join(output, 'manifest.json'));
      const pinPath = join(output, 'pin.json'), save = (value: PinLedger) => atomicPilotJson(pinPath, value);
      const pin = PinLedgerSchema.parse(await readPilotJson(pinPath) ?? { version: 'launch-enumeration-pin-058.1', calls: 0, units: 0, costNanoUsd: '0', pins: [] });
      let m: LaunchEnumerationManifest;
      if (saved) m = LaunchEnumerationManifestSchema.parse(saved.manifest);
      else {
        let watermark: Cursor | null;
        try {
          watermark = await pinEnumerationWatermark(rpc, store, pin, { finality: o.finality, maxUnits: o.maxUnits,
            unitNanoUsd: definition.budget.unitNanoUsd, headerWeight: definition.budget.weights.header }, save, () => new Date().toISOString());
        } catch (error) { if (error instanceof BackfillStop) return stopped(error.message, pin); throw error; }
        if (!watermark) return stopped('head_unavailable', pin);
        if (BigInt(watermark.timestampSec) < BigInt(untilSec)) return stopped('window_not_final', pin);
        m = measuredEnumerationManifest({ fromSec, untilSec, watermark, finality: o.finality, acquiredAt: new Date().toISOString(),
          sourceId: definition.sources.find(s => s.role === 'launches')!.id,
          factory: registry.requireAddress('pons.factory'), budget: enumerationBudget(definition, o.maxUnits, pin) });
      }
      if (m.validation !== 'measured' || m.fromSec !== fromSec || m.untilSec !== untilSec || m.budget.fixedNanoUsd !== pin.costNanoUsd)
        throw new Error('Output manifest mismatch');
      await pinOutputManifest(output, m);
      const c = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json')) ?? initialEnumerationCheckpoint(m, candidate, owner);
      const source = createMeasuredBackfillSource({ rpc, store, registry });
      const result = await runLaunchEnumeration(m, c, durableBackfillIO(output, m.sourceRevision, control,
        'launch_enumeration_checkpoint', source, true), candidate, owner, registry);
      await writeOutputs(output, m, result, { pid: process.pid, pin });
      return exitCode(result.status);
    } finally { await meter.close(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchEnumerationMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Usage') ? error.message :
      'Launch enumeration halted; inspect options, definition, pin ledger and checkpoint.'); process.exitCode = 1;
  });
}
