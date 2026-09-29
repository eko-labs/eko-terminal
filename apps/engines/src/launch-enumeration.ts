import { z } from 'zod';
import { toEventSelector, type AbiEvent } from 'viem';
import { AddressSchema, GuardAvailabilityManifestSchema, guardKnownBy } from '@eko/shared';
import { ponsFactoryAbi, type AddressRegistry } from '@eko/chain';
import { pilotHash } from './coverage-pilot.js';
import { AcquisitionDefinitionSchema, type AcquisitionDefinition } from './acquisition-run.js';
import { ProbabilityFrameSchema, SAMPLE_VERSION } from './probability-sample.js';
import { BackfillStop, SelectiveBackfillManifestSchema, assertBackfillLedger, backfillCheckpointFor, backfillFrame,
  createBackfillSession, type BackfillCheckpoint, type BackfillGap, type BackfillIO,
  type BackfillRange, type BackfillResponse } from './selective-backfill.js';
import { decodePonsLaunch } from './selective-backfill-source.js';

const DAY = 86400n;
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const hash = z.string().regex(/^0x[a-f0-9]{64}$/);
const address = AddressSchema.transform(a => a.toLowerCase());
type Cursor = Extract<BackfillResponse, { kind: 'header' }>['cursor'];
type Launch = Extract<BackfillResponse, { kind: 'logs' }>['launches'][number];
type Event = Extract<BackfillResponse, { kind: 'logs' }>['events'][number];
const launchEvent = ponsFactoryAbi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'TokenLaunched')!;
/** The verified Pons factory launch topic (packages/chain/abi/pons/events.json). */
export const PONS_LAUNCH_TOPIC = toEventSelector(launchEvent);
/** Launchpads whose chain adapters expose no verified address/ABI yet; their launches are not enumerable. */
export const UNVERIFIED_LAUNCHPADS = ['flap', 'klik', 'occupy'] as const;

// TODO(spec): §8.3 asks to enumerate launch metadata over exact UTC frames but defines no local wire format.
// This closed envelope pins one whole-day window, its source cut and the verified emitters only.
export const LaunchEnumerationManifestSchema = z.strictObject({
  version: z.literal('launch-enumeration-058.1'), validation: z.enum(['fixture', 'measured']), chainId: z.literal(4663),
  sourceRevision: hash, availability: GuardAvailabilityManifestSchema, fromSec: uint, untilSec: uint,
  launchpads: z.array(z.strictObject({ id: z.literal('pons'), factory: address, topic: hash })).length(1),
  budget: SelectiveBackfillManifestSchema.shape.budget,
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const from = BigInt(m.fromSec), until = BigInt(m.untilSec);
  if (from % DAY !== 0n || until % DAY !== 0n || until <= from || until - from > 51n * DAY) fail('Whole UTC days required');
  if (m.availability.sourceRevision !== m.sourceRevision || m.availability.replayMode !== 'retrospective' ||
    m.availability.watermark.chainId !== 4663 || m.availability.cut.cursor.chainId !== 4663 ||
    !guardKnownBy({ cursor: m.availability.watermark, acquisitionSequence: '0' }, m.availability.cut) ||
    until > BigInt(m.availability.watermark.timestampSec)) fail('Future or mismatched source cut');
  if (m.launchpads.some(p => p.topic !== PONS_LAUNCH_TOPIC)) fail('Unverified launch topic');
  if (BigInt(m.budget.fixedNanoUsd) > BigInt(m.budget.capNanoUsd)) fail('Fixed costs exceed cap');
});
export type LaunchEnumerationManifest = z.infer<typeof LaunchEnumerationManifestSchema>;
export const initialEnumerationCheckpoint = (m: LaunchEnumerationManifest, candidateRevision: string, owner: string) =>
  backfillCheckpointFor(pilotHash(LaunchEnumerationManifestSchema.parse(m)), candidateRevision, owner);

export interface EnumeratedLaunch {
  coin: string; launchpad: 'pons'; factory: string; launchSec: string; creation: Cursor; knownAt: Launch['knownAt'];
  transactionHash: string; transactionIndex: number; logIndex: number; curve: string; deployer: string;
  pairToken: string | null; launchConfigId: string | null; graduationThreshold: string | null;
}
export interface LaunchEnumerationResult {
  version: 'launch-enumeration-058.1'; validation: 'fixture' | 'measured'; sourceRevision: string; manifestHash: string;
  candidateRevision: string; status: BackfillCheckpoint['status']; reason: string | null;
  window: { fromSec: string; untilSec: string };
  /** Verified by timestamp search: before < fromSec <= first, last < untilSec <= after. Null when the day has no block. */
  range: { before: Cursor | null; first: Cursor | null; last: Cursor | null; after: Cursor } | null;
  launches: EnumeratedLaunch[]; ranges: BackfillRange[]; gaps: BackfillGap[]; enumerationComplete: boolean;
  unverifiedLaunchpads: readonly string[]; requestCalls: number; requestUnits: number; rpcNanoUsd: string;
  fixedNanoUsd: string; pricingEvidence: string | null; invoiceNanoUsd: null; released: false;
  elapsedMs: number; peakRssBytes: number;
}

/** Every Pons launch in whole UTC days: verified block range, factory logs with adaptive dense splits.
 * Shares the selective-backfill ledger, so caps, caching, resume and gaps behave identically. */
export async function runLaunchEnumeration(input: LaunchEnumerationManifest, c: BackfillCheckpoint, io: BackfillIO,
  candidateRevision: string, owner: string, registry: AddressRegistry): Promise<LaunchEnumerationResult> {
  const m = LaunchEnumerationManifestSchema.parse(input);
  assertBackfillLedger(c, pilotHash(m), m.budget, candidateRevision, owner);
  if (m.launchpads[0].factory !== registry.requireAddress('pons.factory').toLowerCase()) throw new Error('Launchpad factory differs from the verified registry');
  const sink = { gaps: [] as BackfillGap[], launches: [] as Launch[] };
  const out: LaunchEnumerationResult = { version: m.version, validation: m.validation, sourceRevision: m.sourceRevision,
    manifestHash: c.manifestHash, candidateRevision, status: 'running', reason: null,
    window: { fromSec: m.fromSec, untilSec: m.untilSec }, range: null, launches: [], ranges: [], gaps: sink.gaps,
    enumerationComplete: false, unverifiedLaunchpads: UNVERIFIED_LAUNCHPADS, requestCalls: c.calls, requestUnits: c.units,
    rpcNanoUsd: c.costNanoUsd, fixedNanoUsd: m.budget.fixedNanoUsd, pricingEvidence: m.budget.pricingEvidence,
    invoiceNanoUsd: null, released: false, elapsedMs: c.elapsedMs, peakRssBytes: c.peakRssBytes };
  const s = createBackfillSession({ validation: m.validation, sourceRevision: m.sourceRevision,
    availability: m.availability, budget: m.budget, pins: [] }, c, io, sink);
  c.status = 'running'; c.reason = null; await s.save();
  try {
    const watermark = await s.header(BigInt(m.availability.watermark.blockNumber));
    if (pilotHash(watermark) !== pilotHash(m.availability.watermark)) throw new BackfillStop('source_reorg');
    const first = await s.blockAt(m.fromSec), next = await s.blockAt(m.untilSec);
    // All four bounds were read by the searches, so these are cached artifacts, not new requests.
    const day = first < next;
    out.range = { before: first > 0n ? await s.header(first - 1n) : null, first: day ? await s.header(first) : null,
      last: day ? await s.header(next - 1n) : null, after: await s.header(next) };
    if (day) for (const p of m.launchpads) await s.acquireRange({ kind: 'logs', addresses: [p.factory], topics: [p.topic],
      from: first.toString(), through: (next - 1n).toString() }, `launches:${p.id}`, out.ranges, true);
    out.launches = await launchDetails(m, out.ranges, sink.launches, io, registry);
    out.enumerationComplete = !sink.gaps.length;
    c.status = sink.gaps.length ? 'stopped' : 'complete'; c.reason = sink.gaps.length ? 'coverage_gaps' : null;
  } catch (error) {
    c.status = error instanceof BackfillStop ? 'stopped' : 'failed';
    c.reason = error instanceof BackfillStop ? error.message : 'acquisition_failed';
    out.enumerationComplete = false; out.launches = [];
    sink.gaps.push({ scope: 'runner', reason: c.reason, from: '0', through: m.availability.watermark.blockNumber });
  }
  await s.save();
  return Object.assign(out, { status: c.status, reason: c.reason, requestCalls: c.calls, requestUnits: c.units,
    rpcNanoUsd: c.costNanoUsd, elapsedMs: c.elapsedMs, peakRssBytes: c.peakRssBytes });
}

/** Decode each factory log in the acquired tapes and require a one-to-one match with the source's launches. */
async function launchDetails(m: LaunchEnumerationManifest, ranges: BackfillRange[], launches: Launch[], io: BackfillIO,
  registry: AddressRegistry): Promise<EnumeratedLaunch[]> {
  const factory = m.launchpads[0].factory, rows: EnumeratedLaunch[] = [];
  for (const range of ranges) {
    const tape = await io.artifact(range.artifactKey);
    if (tape?.kind !== 'logs') throw new Error('Enumeration tape missing');
    for (const e of tape.events as Event[]) {
      const decoded = decodePonsLaunch(e, registry);
      if (!decoded || decoded === 'malformed') throw new Error('Undecodable factory launch log');
      const launch = launches.find(l => l.coin === decoded.token);
      if (!launch || pilotHash(launch.creation) !== pilotHash(e.cursor)) throw new Error('Launch metadata disagrees with factory logs');
      rows.push({ coin: decoded.token, launchpad: 'pons', factory, launchSec: e.cursor.timestampSec, creation: e.cursor,
        knownAt: launch.knownAt, transactionHash: e.transactionHash, transactionIndex: e.transactionIndex, logIndex: e.logIndex,
        curve: decoded.curve, deployer: decoded.deployer, pairToken: decoded.pairToken, launchConfigId: decoded.launchConfigId,
        graduationThreshold: decoded.graduationThreshold });
    }
  }
  if (new Set(rows.map(r => r.coin)).size !== rows.length || rows.length !== launches.length) throw new Error('Launch metadata disagrees with factory logs');
  return rows.sort((a, b) => Number(BigInt(a.creation.blockNumber) - BigInt(b.creation.blockNumber)) ||
    a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
}

// TODO(spec): §9.3/§9.4 freeze eligibility and groups from pinned evidence, which enumeration cannot supply.
// The input therefore leaves both explicitly pending; populationFromEnumeration requires them.
export function launchPopulationInput(m: LaunchEnumerationManifest, result: LaunchEnumerationResult) {
  const manifest = LaunchEnumerationManifestSchema.parse(m);
  return { version: 'launch-population-input-058.1' as const, origin: manifest.validation, chainId: 4663 as const,
    sourceRevision: manifest.sourceRevision, availability: manifest.availability, availabilityCut: manifest.availability.cut,
    fromSec: manifest.fromSec, untilSec: manifest.untilSec, range: result.range,
    enumerationComplete: result.status === 'complete' && result.enumerationComplete,
    launchpads: manifest.launchpads, unverifiedLaunchpads: result.unverifiedLaunchpads, gaps: result.gaps,
    members: [...result.launches].sort((a, b) => a.coin.localeCompare(b.coin))
      .map(l => ({ coin: l.coin, launchSec: l.launchSec, knownAt: l.knownAt })),
    eligibility: 'pending_pinned_evidence' as const, groups: 'pending_pinned_components' as const, labelsInspected: false as const };
}
export type LaunchPopulationInput = ReturnType<typeof launchPopulationInput>;

const evidenceRow = z.strictObject({ coin: address,
  eligibility: ProbabilityFrameSchema.shape.members.element.shape.eligibility,
  components: AcquisitionDefinitionSchema.shape.population.unwrap().shape.groups.element.shape.components,
  unresolved: z.boolean() });
/** The 058 `population` (frame + groups) and its verified `launches` source entry, from a complete
 * enumeration of exactly the definition's launch frame plus pinned eligibility/group evidence per member. */
export function populationFromEnumeration(definition: AcquisitionDefinition, input: LaunchPopulationInput,
  evidence: z.input<typeof evidenceRow>[]) {
  const d = AcquisitionDefinitionSchema.parse(definition), frame = backfillFrame(d.startSec, 'cohort14plus7', d.historyMetadata);
  const rows = new Map(z.array(evidenceRow).parse(evidence).map(r => [r.coin, r]));
  const source = d.sources.find(s => s.role === 'launches')!;
  if (!input.enumerationComplete || input.chainId !== d.chainId || input.origin !== d.origin) throw new Error('Complete enumeration of the same origin required');
  if (input.availability.sourceId !== source.id) throw new Error('Enumeration source differs from the definition launch source');
  if (input.fromSec !== frame.launches.fromSec || input.untilSec !== frame.launches.untilSec) throw new Error('Enumeration must cover exactly the launch frame');
  if (rows.size !== evidence.length || rows.size !== input.members.length || input.members.some(x => !rows.has(x.coin)))
    throw new Error('Pinned eligibility and group evidence required for every enumerated launch');
  const population = { frame: ProbabilityFrameSchema.parse({ version: SAMPLE_VERSION, origin: input.origin,
    sourceRevision: input.sourceRevision, enumerationComplete: true, availabilityCut: input.availabilityCut,
    fromSec: input.fromSec, untilSec: input.untilSec, chainId: input.chainId, query: d.sampling.query, seed: d.sampling.seed,
    members: input.members.map(x => ({ ...x, eligibility: rows.get(x.coin)!.eligibility })) }),
  groups: input.members.map(x => ({ coin: x.coin, components: rows.get(x.coin)!.components, unresolved: rows.get(x.coin)!.unresolved })) };
  return { launchSource: { ...source, status: 'verified' as const, availability: input.availability }, population };
}
