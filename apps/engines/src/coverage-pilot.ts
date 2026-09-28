import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalize } from '@eko/policy';
import { AddressSchema, GuardAssessmentCheckSchema, GuardAvailabilityManifestSchema, GuardCursorSchema,
  GUARD_CHECK_IDS, GUARD_CHECK_TIERS, guardKnownBy } from '@eko/shared';
import { unavailableFundingCapability, rpcStopReason } from '@eko/chain';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const address = AddressSchema.transform(a => a.toLowerCase());
const relativeFile = z.string().regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(p => p.split('/').every(s => s !== '.' && s !== '..'));
const cursor = GuardCursorSchema.refine(c => c.chainId === 4663 && c.boundary === 'block_end');
const logJob = z.strictObject({ kind: z.literal('logs'), id, priority: z.enum(['critical', 'candidates', 'history']),
  from: uint, through: uint, addresses: z.array(address).min(1).max(10000),
  topics: z.array(z.union([hash, z.array(hash).min(1).max(10000), z.null()])).min(1).max(4) });
const traceJob = z.strictObject({ kind: z.literal('trace'), id, cursor });
export const PilotJobSchema = z.discriminatedUnion('kind', [logJob, traceJob]);
export type PilotJob = z.infer<typeof PilotJobSchema>;
// TODO(spec): §§8.2–8.4 specify pilot records, not their file wire format. Freeze this
// closed local snapshot envelope; its coverage is captured input, never inferred from job success.
export const PilotManifestSchema = z.strictObject({
  version: z.literal('coverage-pilot-045.1'), validation: z.enum(['fixture', 'measured']), sourceRevision: hash,
  availability: GuardAvailabilityManifestSchema, from: cursor, through: cursor,
  snapshotFiles: z.array(z.strictObject({ path: relativeFile, sha256: sha })).min(1).max(100000),
  selected: z.array(z.strictObject({ coin: address, cursor, knownAt: GuardAvailabilityManifestSchema.shape.cut,
    floatRaw: uint, candidates: z.array(z.strictObject({ address, liquidRaw: uint, selected: z.boolean(), reason: id })),
    checks: z.array(GuardAssessmentCheckSchema) })).min(1).max(10000),
  jobs: z.array(PilotJobSchema).max(100000),
  budget: z.strictObject({ approvalRef: id.nullable(), pricingEvidence: hash.nullable(),
    rpcUnitNanoUsd: uint, capNanoUsd: uint, checkpointUnits: z.number().int().min(1).max(250000),
    weights: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), z.number().int().positive().safe()),
    paidStartsPerSecond: z.number().positive().max(20), publicStartsPerSecond: z.number().positive().max(3),
    computeStorageNanoUsd: uint, indexedSubscriptionNanoUsd: uint, humanReviewNanoUsd: uint }),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const start = BigInt(m.from.blockNumber), end = BigInt(m.through.blockNumber);
  if (end - start !== 199999n || BigInt(m.through.timestampSec) < BigInt(m.from.timestampSec)) fail('Pilot requires the existing 200k window');
  if (m.availability.sourceRevision !== m.sourceRevision || m.availability.replayMode !== 'retrospective' ||
    !guardKnownBy({ cursor: m.through, acquisitionSequence: '0' }, m.availability.cut)) fail('Source availability mismatch');
  if (new Set(m.snapshotFiles.map(f => f.path)).size !== m.snapshotFiles.length ||
    new Set(m.selected.map(s => s.coin)).size !== m.selected.length || new Set(m.jobs.map(j => j.id)).size !== m.jobs.length) fail('Duplicate source/selection/job');
  for (const s of m.selected) {
    if (BigInt(s.cursor.blockNumber) < start || BigInt(s.cursor.blockNumber) > end || !guardKnownBy(s.knownAt, m.availability.cut)) fail('Selected state outside availability/window');
    if (new Set(s.candidates.map(c => c.address)).size !== s.candidates.length ||
      s.candidates.reduce((n, c) => n + BigInt(c.liquidRaw), 0n) > BigInt(s.floatRaw)) fail('Candidate balance overlap/overflow');
    if (!guardKnownBy({ cursor: s.cursor, acquisitionSequence: '0' }, s.knownAt)) fail('Selected state precedes its availability');
    if (s.checks.some(c => c.coverage.through && BigInt(c.coverage.through.blockNumber) > BigInt(s.cursor.blockNumber))) fail('Check coverage extends beyond selected state');
    if (new Set(s.checks.map(c => c.id)).size !== s.checks.length) fail('Duplicate check');
  }
  const tracePins = new Map<string, string>();
  for (const j of m.jobs) {
    if (j.kind === 'trace') {
      const prior = tracePins.get(j.cursor.blockNumber), pin = pilotHash(j.cursor);
      if (prior && prior !== pin) fail('Conflicting trace pins');
      tracePins.set(j.cursor.blockNumber, pin);
    }
    const a = BigInt(j.kind === 'logs' ? j.from : j.cursor.blockNumber), b = BigInt(j.kind === 'logs' ? j.through : j.cursor.blockNumber);
    if (a < start || b > end || b < a) fail('Acquisition outside existing window');
    if (j.kind === 'logs' && new Set(j.addresses).size !== j.addresses.length) fail('Duplicate log address');
  }
  for (const method of ['eth_chainId', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockReceipts', 'debug_traceBlockByNumber'])
    if (!m.budget.weights[method]) fail('Explicit provider method weights required');
  const overhead = BigInt(m.budget.computeStorageNanoUsd) + BigInt(m.budget.indexedSubscriptionNanoUsd) + BigInt(m.budget.humanReviewNanoUsd);
  if (overhead > BigInt(m.budget.capNanoUsd)) fail('Fixed costs exceed shared cap');
});
export type PilotManifest = z.infer<typeof PilotManifestSchema>;
/**
 * SHA-256 hash canonical pilot input for checkpoint/artifact identities. Pure host-input operation
 * without auth; canonicalization failures throw and a hash alone is not acquisition approval.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export const pilotHash = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
/**
 * Hash a supplied pilot job for deduplication/artifact recovery. Pure host-input operation without
 * auth; canonicalization failures throw; the run path separately schema-validates jobs.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export const pilotJobKey = (job: PilotJob) => pilotHash(job);
export class PilotStop extends Error {}

export interface PilotCheckpoint {
  version: 1; manifestHash: string; candidateRevision: string; pending: PilotJob[];
  completed: { key: string; kind: PilotJob['kind']; artifactHash: string; latencyMs: number; queueMs: number; status: string }[];
  replay: { complete: boolean; evaluations: number; elapsedMs: number }; elapsedMs: number; peakRssBytes: number;
  status: 'prepared' | 'running' | 'stopped' | 'complete' | 'failed'; reason: string | null;
}
export interface PilotIO {
  /** A completed immutable artifact can recover a crash between write and cursor commit. */
  artifact(key: string): Promise<{ hash: string; status: string } | null>;
  putArtifact(key: string, value: unknown, status: string): Promise<string>;
  save(checkpoint: PilotCheckpoint): Promise<void>;
  replay(): Promise<{ complete: boolean; evaluations: number; elapsedMs: number }>;
  logs(job: Extract<PilotJob, { kind: 'logs' }>): Promise<unknown>;
  trace(job: Extract<PilotJob, { kind: 'trace' }>): Promise<{ status: string; value: unknown }>;
  rangeLimit(error: unknown): boolean;
  stopped(): boolean;
  now(): number; rss(): number;
}
/** Split the largest expensive dimension; topic ORs remain ORs at the same position.
 * @remarks
 * Split range first, then addresses, then topic alternatives while preserving each filter
 * position; return empty when unsplittable. Pure worker helper with no auth; assumes a typed valid
 * log job and invalid integer input can throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function splitPilotLogs(job: Extract<PilotJob, { kind: 'logs' }>): PilotJob[] {
  const span = BigInt(job.through) - BigInt(job.from) + 1n;
  if (span > 1n) {
    const mid = BigInt(job.from) + span / 2n - 1n;
    return [{ ...job, through: mid.toString() }, { ...job, from: (mid + 1n).toString() }];
  }
  if (job.addresses.length > 1) {
    const mid = Math.ceil(job.addresses.length / 2);
    return [{ ...job, addresses: job.addresses.slice(0, mid) }, { ...job, addresses: job.addresses.slice(mid) }];
  }
  const index = job.topics.findIndex(t => Array.isArray(t) && t.length > 1);
  if (index >= 0) {
    const topics = job.topics[index] as string[], mid = Math.ceil(topics.length / 2);
    return [topics.slice(0, mid), topics.slice(mid)].map(values => ({ ...job, topics: job.topics.map((t, i) => i === index ? values : t) }));
  }
  return [];
}
/**
 * Build a prepared checkpoint bound to manifest/candidate hashes, prioritizing critical logs and
 * deduplicating shared trace pins. Operator supplies reviewed manifest; no auth or I/O; malformed
 * typed input/hashing failures throw and no acquisition is approved here.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function initialPilotCheckpoint(m: PilotManifest, candidateRevision: string): PilotCheckpoint {
  const priority = (j: PilotJob) => j.kind === 'trace' ? 2 : { critical: 0, candidates: 1, history: 3 }[j.priority];
  // Deduplicate shared block/hash diagnostics, never trace once per candidate wallet.
  const traces = new Set<string>();
  const pending = m.jobs.filter(j => {
    if (j.kind === 'logs') return true;
    const key = `${j.cursor.blockNumber}:${j.cursor.blockHash}`;
    if (traces.has(key)) return false; traces.add(key); return true;
  }).sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
  return { version: 1, manifestHash: pilotHash(m), candidateRevision, pending, completed: [],
    replay: { complete: false, evaluations: 0, elapsedMs: 0 }, elapsedMs: 0, peakRssBytes: 0, status: 'prepared', reason: null };
}
/** A damaged cursor must never expand the approved address/topic/range plan.
 * @remarks
 * Require checkpoint manifest binding and bounded state, then validate pending jobs as subsets of
 * approved range/address/topic scope. Operator supplies manifest/checkpoint; no authentication.
 * Invalid/damaged/expanded pending state throws before acquisition; completed artifact content is
 * verified by the I/O adapter.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function validatePilotCheckpoint(m: PilotManifest, c: PilotCheckpoint) {
  if (c.version !== 1 || c.manifestHash !== pilotHash(m) || !Array.isArray(c.pending) || !Array.isArray(c.completed) ||
    !Number.isFinite(c.elapsedMs) || c.elapsedMs < 0 || !Number.isFinite(c.peakRssBytes) || c.peakRssBytes < 0 ||
    !Number.isSafeInteger(c.replay?.evaluations) || c.replay.evaluations < 0 || !Number.isFinite(c.replay.elapsedMs) || c.replay.elapsedMs < 0)
    throw new Error('Pilot checkpoint source mismatch');
  for (const input of c.pending) {
    const job = PilotJobSchema.parse(input);
    const authorized = m.jobs.some(original => {
      if (job.kind === 'trace') return original.kind === 'trace' && pilotHash(original.cursor) === pilotHash(job.cursor);
      if (original.kind !== 'logs' || job.id !== original.id || job.priority !== original.priority ||
        BigInt(job.from) < BigInt(original.from) || BigInt(job.through) > BigInt(original.through) || BigInt(job.from) > BigInt(job.through) ||
        !job.addresses.every(a => original.addresses.includes(a)) || job.topics.length !== original.topics.length) return false;
      return job.topics.every((t, i) => {
        const parent = original.topics[i];
        if (parent === null) return t === null;
        if (t === null) return false;
        return (Array.isArray(t) ? t : [t]).every(value => (Array.isArray(parent) ? parent : [parent]).includes(value));
      });
    });
    if (!authorized) throw new Error('Pilot checkpoint expanded scope');
  }
}
/** Serialized work bounds memory and isolates this enrichment budget from baseline ingest.
 * @remarks
 * Validate manifest/checkpoint, run retained replay and optionally serialized bounded acquisition
 * with immutable artifact recovery and checkpoint persistence. Operator controls acquire and must
 * supply approval/pricing refs; adapters enforce budgets. Missing refs/shutdown/budget closure
 * yields stopped, acquisition errors failed; initial validation/save failures can reject. Job
 * completion never upgrades captured check coverage.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function runCoveragePilot(m: PilotManifest, c: PilotCheckpoint, io: PilotIO, acquire: boolean) {
  m = PilotManifestSchema.parse(m);
  validatePilotCheckpoint(m, c);
  const started = io.now(), previous = c.elapsedMs;
  const save = async () => { c.elapsedMs = previous + io.now() - started; c.peakRssBytes = Math.max(c.peakRssBytes, io.rss()); await io.save(c); };
  c.status = 'running'; c.reason = null; await save();
  try {
    if (!c.replay.complete) {
      const result = await io.replay();
      c.replay = { complete: result.complete, evaluations: c.replay.evaluations + result.evaluations, elapsedMs: c.replay.elapsedMs + result.elapsedMs };
      await save();
      if (!result.complete) throw new PilotStop('replay_interrupted');
    }
    if (!acquire) { c.status = 'prepared'; c.reason = 'acquisition_not_requested'; await save(); return c; }
    if (!m.budget.approvalRef || !m.budget.pricingEvidence) throw new PilotStop('approval_or_pricing_missing');
    while (c.pending.length) {
      if (io.stopped()) throw new PilotStop('shutdown_requested');
      const job = c.pending[0], key = pilotJobKey(job), began = io.now();
      let artifact = await io.artifact(key);
      if (!artifact) {
        try {
          if (job.kind === 'logs') {
            // Provider's verified address × block envelope; split before admission.
            if (job.addresses.length > 50 || BigInt(job.through) - BigInt(job.from) + 1n > BigInt(Math.min(100000, Math.floor(200000 / job.addresses.length)))) {
              const children = job.addresses.length > 50 ? [
                { ...job, addresses: job.addresses.slice(0, 50) }, { ...job, addresses: job.addresses.slice(50) },
              ] : splitPilotLogs(job);
              c.pending.splice(0, 1, ...children); await save(); continue;
            }
            const value = await io.logs(job);
            artifact = { hash: await io.putArtifact(key, value, 'acquired'), status: 'acquired' };
          } else {
            const result = await io.trace(job);
            artifact = { hash: await io.putArtifact(key, result.value, result.status), status: result.status };
          }
        } catch (error) {
          if (error instanceof PilotStop || rpcStopReason(error)) throw new PilotStop(error instanceof PilotStop ? error.message : rpcStopReason(error));
          if (job.kind === 'logs' && io.rangeLimit(error)) {
            const children = splitPilotLogs(job);
            if (children.length) { c.pending.splice(0, 1, ...children); await save(); continue; }
          }
          throw new Error('pilot_acquisition_failed');
        }
      }
      c.completed.push({ key, kind: job.kind, artifactHash: artifact.hash, status: artifact.status,
        latencyMs: io.now() - began, queueMs: previous + began - started });
      c.pending.shift(); await save();
    }
    c.status = 'complete';
  } catch (error) {
    c.status = error instanceof PilotStop ? 'stopped' : 'failed';
    c.reason = error instanceof PilotStop ? error.message : 'pilot_failed';
  }
  await save(); return c;
}
/**
 * Project captured candidate/exclusion raw balances and required-check completion from selected
 * manifest state. Public pure report projection without auth; assumes validated manifest and
 * invalid raw quantities can throw. Completed RPC jobs do not set check completion.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function pilotCoverage(m: PilotManifest) {
  return m.selected.map(s => {
    const candidates = s.candidates.filter(c => c.selected), excluded = s.candidates.filter(c => !c.selected);
    const sum = (values: typeof candidates) => values.reduce((n, c) => n + BigInt(c.liquidRaw), 0n).toString();
    const completion = (tier: 'buy_critical' | 'lower_tier') => GUARD_CHECK_IDS.filter(id => GUARD_CHECK_TIERS[id] === tier)
      .map(id => ({ id, status: s.checks.find(c => c.id === id)?.status ?? 'missing' }));
    const critical = completion('buy_critical'), lower = completion('lower_tier');
    const complete = (checks: typeof critical) => checks.every(c => ['complete', 'not_applicable'].includes(c.status));
    return { coin: s.coin, floatRaw: s.floatRaw, candidateCount: candidates.length, candidateRaw: sum(candidates),
      excludedCount: excluded.length, excludedRaw: sum(excluded), excluded: excluded.map(c => ({ address: c.address, liquidRaw: c.liquidRaw, reason: c.reason })),
      candidateFloatRatio: { numerator: sum(candidates), denominator: s.floatRaw }, unenumeratedRaw: (BigInt(s.floatRaw) - BigInt(sum(s.candidates))).toString(),
      critical, lower, criticalComplete: complete(critical), lowerComplete: complete(lower) };
  });
}
/**
 * Project checkpoint performance and captured coverage; freeze an operational target only for
 * measured completed replay, retain explicit gaps and released=false. Public report projection
 * without auth; assumes validated typed manifest/checkpoint and malformed data can throw.
 * Diagnostic traces do not establish live funding completeness.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function pilotReport(m: PilotManifest, c: PilotCheckpoint) {
  const coverage = pilotCoverage(m), latencies = c.completed.map(j => j.latencyMs).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null;
  const rate = c.replay.elapsedMs > 0 ? c.replay.evaluations * 1000 / c.replay.elapsedMs : null;
  return { version: m.version, validation: m.validation, sourceRevision: m.sourceRevision, manifestHash: c.manifestHash,
    candidateRevision: c.candidateRevision, status: c.status, reason: c.reason, coverage,
    capability: unavailableFundingCapability('unconfigured-indexed-source', m.sourceRevision),
    internalFunding: { liveComplete: false, capturedIntervals: m.selected.map(s => ({ coin: s.coin,
      coverage: s.checks.find(c => c.id === 'recent_funding')?.coverage ?? null })), diagnosticBlocks: c.completed.filter(j => j.kind === 'trace' && j.status === 'complete').length },
    performance: { wallMs: c.elapsedMs, peakRssBytes: c.peakRssBytes, replay: c.replay, evaluationsPerSecond: rate,
      acquisitionP95Ms: p95, fullRequiredCheckLatencyMs: null, maxQueueMs: c.completed.length ? c.completed.reduce((n, j) => Math.max(n, j.queueMs), 0) : null },
    operationalTarget: m.validation === 'measured' && c.status === 'complete' && c.replay.evaluations > 0 ? {
      status: 'frozen', manifestHash: c.manifestHash, candidateRevision: c.candidateRevision,
      scope: 'existing_window_only', completedJobs: c.completed.length, criticalComplete: coverage.filter(s => s.criticalComplete).length,
      lowerComplete: coverage.filter(s => s.lowerComplete).length, evaluationsPerSecond: rate, acquisitionP95Ms: p95,
      maxQueueMs: c.completed.reduce((n, j) => Math.max(n, j.queueMs), 0), fullRequiredCheckLatencyMs: null,
      capturedCoverageOnly: true, peakRssBytes: c.peakRssBytes, proposed170PerSecondMet: rate !== null && rate >= 170,
    } : { status: 'unmeasured', reason: 'measured_complete_pilot_required' },
    independentProgress: { replayComplete: c.replay.complete, acquiredJobs: c.completed.length, remainingJobs: c.pending.length },
    gaps: ['indexed_native_unavailable', 'indexed_quote_unverified', 'diagnostic_traces_not_live_funding',
      'captured_checks_not_job_completion', 'seven_day_accuracy_unmeasured', 'provider_invoice_unreconciled'], released: false };
}
