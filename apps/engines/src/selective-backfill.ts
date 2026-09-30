import { z } from 'zod';
import { AddressSchema, AvailabilityCutSchema, GuardAvailabilityManifestSchema, GuardCursorSchema, guardKnownBy } from '@eko/shared';
import { pilotHash, splitPilotLogs } from './coverage-pilot.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = z.string().regex(/^0x[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const reasonCode = z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/);
const address = AddressSchema.transform(a => a.toLowerCase());
const cursor = GuardCursorSchema.refine(c => c.chainId === 4663 && c.boundary === 'block_end');
const filter = z.strictObject({ addresses: z.array(address).min(1).max(10000),
  topics: z.array(z.union([hash, z.array(hash).min(1).max(10000), z.null()])).min(1).max(4) });
export const BackfillLaunchSchema = z.strictObject({ coin: address, creation: cursor, knownAt: AvailabilityCutSchema });
export const BackfillEventSchema = z.strictObject({ address, cursor, knownAt: AvailabilityCutSchema,
  transactionHash: hash, transactionIndex: z.number().int().nonnegative().safe(), logIndex: z.number().int().nonnegative().safe(),
  topics: z.array(hash).max(4), data: z.string().regex(/^0x(?:[a-f0-9]{2})*$/) });
const DAY = 86400n;
/** Exact UTC calendar intervals, all half-open. No height/rate extrapolation. */
export function backfillFrame(startSec: string, mode: 'pilot7' | 'cohort14plus7', history: boolean) {
  const d = BigInt(uint.parse(startSec)), at = (days: bigint) => (d + days * DAY).toString();
  const interval = (fromSec: string, untilSec: string) => ({ fromSec, untilSec });
  return { launches: interval(at(0n), at(mode === 'pilot7' ? 7n : 14n)),
    observations: interval(at(0n), at(mode === 'pilot7' ? 7n : 21n)),
    development: interval(at(0n), at(7n)), fitting: interval(at(0n), at(4n)),
    validation: interval(at(4n), at(7n)), lockedTest: mode === 'pilot7' ? null : interval(at(7n), at(14n)),
    primaryPurgeSeconds: 3900, sevenDaySensitivityOnly: true,
    funding: interval(at(-1n), at(0n)), recycling: interval(at(-7n), at(0n)),
    metadata: interval(at(history ? -30n : 0n), at(mode === 'pilot7' ? 7n : 21n)),
    historyEnabled: false, historyRequested: history };
}
// TODO(spec): §8.3 defines acquisition records but no local wire format. This closed
// envelope freezes acquisition scope only; cohort grouping/labels belong to later packets.
export const SelectiveBackfillManifestSchema = z.strictObject({
  version: z.literal('selective-backfill-048.1'), validation: z.enum(['fixture', 'measured']),
  sourceRevision: hash, availability: GuardAvailabilityManifestSchema,
  startSec: uint, mode: z.enum(['pilot7', 'cohort14plus7']), historyMetadata: z.boolean(),
  metadataFilters: z.array(filter).min(1).max(100),
  selected: z.array(z.strictObject({ launch: BackfillLaunchSchema, untilSec: uint,
    filters: z.array(filter).min(1).max(100), reason: z.enum(['sample', 'incident', 'negative_control']) })).min(1).max(10000),
  budget: z.strictObject({ approvalRef: id.nullable(), pricingEvidence: hash.nullable(),
    checkpointUnits: z.number().int().min(1).max(250000), capNanoUsd: uint, unitNanoUsd: uint,
    fixedNanoUsd: uint, weights: z.strictObject({ header: z.number().int().positive().safe(),
      logs: z.number().int().positive().safe(), boundary: z.number().int().positive().safe() }) }),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const f = backfillFrame(m.startSec, m.mode, m.historyMetadata);
  if (BigInt(f.recycling.fromSec) < 0n || BigInt(f.metadata.fromSec) < 0n) fail('Calendar precedes genesis');
  if (m.availability.sourceRevision !== m.sourceRevision || m.availability.replayMode !== 'retrospective' ||
    !guardKnownBy({ cursor: m.availability.watermark, acquisitionSequence: '0' }, m.availability.cut) ||
    BigInt(f.observations.untilSec) > BigInt(m.availability.watermark.timestampSec)) fail('Future or mismatched source cut');
  if (new Set(m.selected.map(s => s.launch.coin)).size !== m.selected.length) fail('Duplicate selected coin');
  if (BigInt(m.budget.fixedNanoUsd) > BigInt(m.budget.capNanoUsd)) fail('Fixed costs exceed cap');
  for (const s of m.selected) {
    if (!guardKnownBy(s.launch.knownAt, m.availability.cut) ||
      !guardKnownBy({ cursor: s.launch.creation, acquisitionSequence: '0' }, s.launch.knownAt) ||
      BigInt(s.launch.creation.blockNumber) === 0n || BigInt(s.untilSec) <= BigInt(s.launch.creation.timestampSec) ||
      BigInt(s.untilSec) > BigInt(f.observations.untilSec)) fail('Selected creation/follow-up outside source');
    if (m.mode === 'pilot7' && BigInt(s.untilSec) - BigInt(s.launch.creation.timestampSec) > 7n * DAY) fail('First pilot reconstruction exceeds seven days');
    if (!s.filters.some(f => f.addresses.includes(s.launch.coin))) fail('Selected token events required');
  }
  for (const f of [...m.metadataFilters, ...m.selected.flatMap(s => s.filters)]) {
    if (new Set(f.addresses).size !== f.addresses.length ||
      f.topics.some(t => Array.isArray(t) && new Set(t).size !== t.length)) fail('Duplicate log filter member');
  }
});
export type SelectiveBackfillManifest = z.infer<typeof SelectiveBackfillManifestSchema>;
const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('header'), block: uint }),
  z.strictObject({ kind: z.literal('logs'), from: uint, through: uint, ...filter.shape }),
  z.strictObject({ kind: z.literal('boundary'), coin: address, cursor }),
]);
export type BackfillRequest = z.infer<typeof requestSchema>;
export const BackfillResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('header'), cursor }),
  z.strictObject({ kind: z.literal('logs'), events: z.array(BackfillEventSchema).max(10000),
    launches: z.array(BackfillLaunchSchema).max(10000) }),
  z.strictObject({ kind: z.literal('boundary'), coin: address, cursor, knownAt: AvailabilityCutSchema,
    state: z.json(), methodVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }),
  z.strictObject({ kind: z.literal('dense') }),
  z.strictObject({ kind: z.literal('missing'), reason: z.enum(['range_unavailable', 'boundary_unavailable', 'header_unavailable']) }),
]);
export type BackfillResponse = z.infer<typeof BackfillResponseSchema>;
const attemptKind = z.enum(['header', 'logs', 'boundary']);
const checkpointSchema = z.strictObject({ version: z.literal(1), manifestHash: digest, candidateRevision: digest,
  owner: id, status: z.enum(['prepared', 'running', 'stopped', 'complete', 'failed']), reason: reasonCode.nullable(),
  calls: z.number().int().nonnegative().safe(), units: z.number().int().nonnegative().safe(), costNanoUsd: uint,
  // `extra` lists provider attempts beyond the one the reservation prepays (retries, multi-call reads),
  // each admitted and charged before its dispatch. Absent means none.
  requests: z.array(z.strictObject({ key: digest, request: requestSchema, artifactHash: digest.nullable(),
    extra: z.array(attemptKind).max(100000).optional() })),
  elapsedMs: z.number().nonnegative().finite(), peakRssBytes: z.number().nonnegative().finite(),
});
export type BackfillCheckpoint = z.infer<typeof checkpointSchema>;
export const backfillRequestKey = (r: BackfillRequest) => pilotHash(requestSchema.parse(r));
/** Empty ledger bound to one manifest hash (selective backfill or launch enumeration). */
export function backfillCheckpointFor(manifestHash: string, candidateRevision: string, owner: string): BackfillCheckpoint {
  return checkpointSchema.parse({ version: 1, manifestHash, candidateRevision, owner, status: 'prepared', reason: null,
    calls: 0, units: 0, costNanoUsd: '0', requests: [], elapsedMs: 0, peakRssBytes: 0 });
}
export function initialBackfillCheckpoint(m: SelectiveBackfillManifest, candidateRevision: string, owner: string): BackfillCheckpoint {
  return backfillCheckpointFor(pilotHash(SelectiveBackfillManifestSchema.parse(m)), candidateRevision, owner);
}
export type BackfillAttemptKind = BackfillRequest['kind'];
/** Admits one provider attempt before it is dispatched, or throws a named stop (cap, shutdown). */
export type BackfillAdmit = (kind: BackfillAttemptKind) => Promise<void>;
export interface BackfillIO {
  /** Single-owner durable store; responses are content hashed and source-scoped by the driver. */
  artifact(key: string): Promise<BackfillResponse | null>;
  putArtifact(key: string, response: BackfillResponse): Promise<void>;
  save(c: BackfillCheckpoint): Promise<void>;
  request(r: BackfillRequest): Promise<BackfillResponse>;
  /** Bound by the runner around each request() call and unbound after it. A measured source routes every
   * underlying provider attempt through it before dispatch: the reservation prepays one attempt of the
   * request's own kind, and retries or extra calls are charged and cap-checked one by one. Required for
   * measured manifests; fixture sources answer each request with exactly the prepaid attempt. */
  bindAttempts?(admit: BackfillAdmit | null): void;
  /** Local canonical-source status, never an unmetered RPC. Reorg requires a new source manifest. */
  sourceRevision(): Promise<string>;
  stopped(): boolean; now(): number; rss(): number;
}
/** A named, resumable stop (cap, shutdown, reorg, unavailable header), as opposed to a failure. */
export class BackfillStop extends Error {}
export type BackfillGap = { scope: string; reason: string; from: string; through: string };
export type BackfillRange = { from: string; through: string; artifactKey: string; eventCount: number };
type Launch = z.infer<typeof BackfillLaunchSchema>;
type Cursor = z.infer<typeof cursor>;
type LogsRequest = Extract<BackfillRequest, { kind: 'logs' }>;
export interface BackfillResult {
  validation: 'fixture' | 'measured'; sourceRevision: string; candidateRevision: string; manifestHash: string;
  status: BackfillCheckpoint['status']; reason: string | null;
  frame: ReturnType<typeof backfillFrame>; launches: Launch[];
  metadataRanges: BackfillRange[]; selected: { coin: string; from: string; through: string;
    boundaryKey: string; ranges: BackfillRange[]; complete: boolean }[]; gaps: BackfillGap[];
  enumerationComplete: boolean; requestCalls: number; requestUnits: number; rpcNanoUsd: string;
  fixedNanoUsd: string; pricingEvidence: string | null; invoiceNanoUsd: null;
  nativeFundingComplete: false; historyComplete: false; released: false;
  elapsedMs: number; peakRssBytes: number;
}
/** What one ledger acquires under: source, availability cut, budget and cursors pinned in advance. */
export interface BackfillScope {
  validation: 'fixture' | 'measured'; sourceRevision: string;
  availability: SelectiveBackfillManifest['availability']; budget: SelectiveBackfillManifest['budget']; pins: Cursor[];
}
/** Rejects a checkpoint bound to another manifest/candidate/owner or whose ledger is not internally exact. */
export function assertBackfillLedger(c: BackfillCheckpoint, manifestHash: string, budget: BackfillScope['budget'],
  candidateRevision: string, owner: string) {
  checkpointSchema.parse(c);
  if (c.manifestHash !== manifestHash || c.candidateRevision !== candidateRevision || c.owner !== owner) throw new Error('Backfill checkpoint source/candidate/owner mismatch');
  const attempts = c.requests.flatMap(r => [r.request.kind, ...(r.extra ?? [])]);
  if (c.calls !== attempts.length || new Set(c.requests.map(r => r.key)).size !== c.requests.length ||
    c.units !== attempts.reduce((n, kind) => n + budget.weights[kind], 0) ||
    BigInt(c.costNanoUsd) !== BigInt(c.units) * BigInt(budget.unitNanoUsd) ||
    c.units > budget.checkpointUnits || BigInt(c.costNanoUsd) + BigInt(budget.fixedNanoUsd) > BigInt(budget.capNanoUsd) ||
    c.requests.some(r => r.key !== backfillRequestKey(r.request))) throw new Error('Backfill checkpoint ledger mismatch');
}
/** Shared core: durable request ledger, sparse timestamp search and adaptive log splits for one scope. */
export function createBackfillSession(m: BackfillScope, c: BackfillCheckpoint, io: BackfillIO,
  sink: { gaps: BackfillGap[]; launches: Launch[] }) {
  const started = io.now(), previous = c.elapsedMs;
  const save = async () => { c.elapsedMs = previous + io.now() - started; c.peakRssBytes = Math.max(c.peakRssBytes, io.rss()); await io.save(c); };
  const pins = new Map([m.availability.watermark, ...m.pins].map(c => [c.blockNumber, { hash: c.blockHash, timestamp: c.timestampSec }]));
  const pin = (at: Cursor) => {
    const prior = pins.get(at.blockNumber);
    if (prior && prior.hash !== at.blockHash) throw new BackfillStop('source_reorg');
    if (prior && prior.timestamp !== at.timestampSec) throw new Error('Source timestamp mismatch');
    if (BigInt(at.timestampSec) > BigInt(m.availability.watermark.timestampSec)) throw new BackfillStop('future_source_evidence');
    pins.set(at.blockNumber, { hash: at.blockHash, timestamp: at.timestampSec });
  };
  const known = (at: z.infer<typeof AvailabilityCutSchema>) => {
    if (BigInt(at.cursor.timestampSec) > BigInt(m.availability.cut.cursor.timestampSec) ||
      !guardKnownBy(at, m.availability.cut)) throw new BackfillStop('future_source_evidence');
  };
  const validateResponse = (r: BackfillRequest, raw: BackfillResponse) => {
    const value = BackfillResponseSchema.parse(raw);
    if (value.kind === 'missing') return value;
    if (value.kind === 'dense') { if (r.kind !== 'logs') throw new Error('Unexpected dense response'); return value; }
    if (value.kind !== r.kind) throw new Error('Backfill response kind mismatch');
    if (value.kind === 'header' && r.kind === 'header') {
      if (value.cursor.blockNumber !== r.block) throw new Error('Header number mismatch');
      pin(value.cursor);
      known({ cursor: value.cursor, acquisitionSequence: '0' });
    }
    if (value.kind === 'boundary' && r.kind === 'boundary') {
      if (value.coin !== r.coin || pilotHash(value.cursor) !== pilotHash(r.cursor)) throw new BackfillStop('source_reorg');
      known(value.knownAt);
      pin(value.cursor);
      if (!guardKnownBy({ cursor: value.cursor, acquisitionSequence: '0' }, value.knownAt)) throw new Error('Boundary known before state');
    }
    if (value.kind === 'logs' && r.kind === 'logs') {
      const events = new Set<string>();
      for (const e of value.events) {
        pin(e.cursor);
        known(e.knownAt);
        if (!guardKnownBy({ cursor: e.cursor, acquisitionSequence: '0' }, e.knownAt) ||
          BigInt(e.cursor.blockNumber) < BigInt(r.from) || BigInt(e.cursor.blockNumber) > BigInt(r.through) ||
          !r.addresses.includes(e.address) || r.topics.some((t, i) => t !== null && !(Array.isArray(t) ? t : [t]).includes(e.topics[i]))) throw new Error('Log scope mismatch');
        const key = `${e.cursor.blockNumber}:${e.logIndex}`;
        if (events.has(key)) throw new Error('Duplicate source log'); events.add(key);
      }
      for (const l of value.launches) {
        pin(l.creation);
        known(l.knownAt);
        if (!guardKnownBy({ cursor: l.creation, acquisitionSequence: '0' }, l.knownAt) ||
          BigInt(l.creation.blockNumber) < BigInt(r.from) || BigInt(l.creation.blockNumber) > BigInt(r.through) ||
          !value.events.some(e => pilotHash(e.cursor) === pilotHash(l.creation))) throw new Error('Launch lacks creation event');
      }
      value.events.sort((a, b) => BigInt(a.cursor.blockNumber) < BigInt(b.cursor.blockNumber) ? -1 :
        BigInt(a.cursor.blockNumber) > BigInt(b.cursor.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    }
    return value;
  };
  // Every charge is checked against both caps before the attempt it pays for can be dispatched.
  const charge = (kind: BackfillAttemptKind) => {
    const units = m.budget.weights[kind], cost = BigInt(units) * BigInt(m.budget.unitNanoUsd);
    if (c.units + units > m.budget.checkpointUnits || BigInt(c.costNanoUsd) + cost + BigInt(m.budget.fixedNanoUsd) > BigInt(m.budget.capNanoUsd)) throw new BackfillStop('cap_reached');
    c.calls++; c.units += units; c.costNanoUsd = (BigInt(c.costNanoUsd) + cost).toString();
  };
  const request = async (r: BackfillRequest) => {
    if (io.stopped()) throw new BackfillStop('shutdown_requested');
    if (await io.sourceRevision() !== m.sourceRevision) throw new BackfillStop('source_reorg');
    const key = backfillRequestKey(r);
    const entry = c.requests.find(e => e.key === key);
    const cached = await io.artifact(key);
    if (cached) {
      if (!entry) throw new Error('Unreserved artifact');
      const response = validateResponse(r, cached), artifactHash = pilotHash(response);
      if (entry.artifactHash && entry.artifactHash !== artifactHash) throw new Error('Backfill artifact changed');
      if (!entry.artifactHash) { entry.artifactHash = artifactHash; await save(); }
      return response;
    }
    if (entry) throw new BackfillStop('request_outcome_unconfirmed'); // Never blindly redispatch after a crash.
    if (m.validation === 'measured' && (!m.budget.approvalRef || !m.budget.pricingEvidence)) throw new BackfillStop('approval_or_pricing_missing');
    if (m.validation === 'measured' && !io.bindAttempts) throw new Error('Measured source must meter every provider attempt');
    charge(r.kind);
    const reserved: BackfillCheckpoint['requests'][number] = { key, request: r, artifactHash: null };
    c.requests.push(reserved); await save();
    let prepaid = true, open = true, admitted = 0;
    io.bindAttempts?.(async kind => {
      if (!open) throw new Error('Provider attempt outside its request');
      if (io.stopped()) throw new BackfillStop('shutdown_requested');
      if (prepaid && kind === r.kind) { prepaid = false; admitted++; return; }
      charge(kind); (reserved.extra ??= []).push(kind); admitted++; await save();
    });
    let raw: BackfillResponse;
    try { raw = await io.request(r); }
    catch (error) {
      // A metered source that stopped before admitting any attempt sent nothing: release the reservation
      // so a resume re-plans it, instead of treating it as an unconfirmed dispatch.
      if (io.bindAttempts && admitted === 0 && error instanceof BackfillStop && c.requests.at(-1) === reserved) {
        c.requests.pop(); c.calls--; c.units -= m.budget.weights[r.kind];
        c.costNanoUsd = (BigInt(c.costNanoUsd) - BigInt(m.budget.weights[r.kind]) * BigInt(m.budget.unitNanoUsd)).toString();
        await save();
      }
      throw error;
    } finally { open = false; io.bindAttempts?.(null); }
    const response = validateResponse(r, raw);
    if (await io.sourceRevision() !== m.sourceRevision) throw new BackfillStop('source_reorg');
    await io.putArtifact(key, response); reserved.artifactHash = pilotHash(response); await save();
    return response;
  };
  const header = async (block: bigint) => {
    const response = await request({ kind: 'header', block: block.toString() });
    if (response.kind !== 'header') throw new BackfillStop('header_unavailable');
    return response.cursor;
  };
  // Sparse binary search over pinned headers, shared cache: never a block-rate estimate or per-block scan.
  // Returns the first block whose timestamp is >= `timestamp`; its predecessor is verified to be earlier.
  const blockAt = async (timestamp: string) => {
    if (BigInt(timestamp) > BigInt(m.availability.watermark.timestampSec)) throw new BackfillStop('future_source_cut');
    let lo = 0n, hi = BigInt(m.availability.watermark.blockNumber);
    while (lo < hi) {
      const mid = (lo + hi) / 2n, h = await header(mid);
      if (BigInt(h.timestampSec) < BigInt(timestamp)) lo = mid + 1n; else hi = mid;
    }
    const h = await header(lo);
    if (BigInt(h.timestampSec) < BigInt(timestamp)) throw new BackfillStop('header_unavailable');
    // The search already visited lo - 1, so this re-read is a cached artifact, not a new request.
    if (lo > 0n && BigInt((await header(lo - 1n)).timestampSec) >= BigInt(timestamp)) throw new Error('Non-monotonic block timestamps');
    return lo;
  };
  const acquireRange = async (r: LogsRequest, scope: string, ranges: BackfillRange[], metadata: boolean): Promise<void> => {
    const split = () => splitPilotLogs({ ...r, id: 'selective', priority: 'history' }).map(j => {
      if (j.kind !== 'logs') throw new Error('Unexpected trace split');
      return { kind: 'logs' as const, from: j.from, through: j.through, addresses: j.addresses, topics: j.topics };
    });
    const span = BigInt(r.through) - BigInt(r.from) + 1n;
    if (r.addresses.length > 50 || span > BigInt(Math.min(100000, Math.floor(200000 / r.addresses.length)))) {
      const children = r.addresses.length > 50 ? [{ ...r, addresses: r.addresses.slice(0, 50) }, { ...r, addresses: r.addresses.slice(50) }] : split();
      for (const child of children) await acquireRange(child, scope, ranges, metadata);
      return;
    }
    const response = await request(r);
    if (response.kind === 'dense') {
      const children = split();
      if (children.length) { for (const child of children) await acquireRange(child, scope, ranges, metadata); return; }
    }
    if (response.kind !== 'logs') { sink.gaps.push({ scope, reason: response.kind === 'missing' ? response.reason : 'dense_unsplittable', from: r.from, through: r.through }); return; }
    ranges.push({ from: r.from, through: r.through, artifactKey: backfillRequestKey(r), eventCount: response.events.length });
    if (metadata) for (const launch of response.launches) {
      const prior = sink.launches.find(l => l.coin === launch.coin);
      if (prior && pilotHash(prior) !== pilotHash(launch)) throw new Error('Conflicting launch metadata');
      if (!prior) sink.launches.push(launch);
    }
  };
  return { save, request, header, blockAt, acquireRange };
}
/** Acquisition tape and boundary snapshots only; never a label, price or funding graph. */
export async function runSelectiveBackfill(input: SelectiveBackfillManifest, c: BackfillCheckpoint, io: BackfillIO,
  candidateRevision: string, owner: string): Promise<BackfillResult> {
  const m = SelectiveBackfillManifestSchema.parse(input);
  assertBackfillLedger(c, pilotHash(m), m.budget, candidateRevision, owner);
  const out: BackfillResult = { validation: m.validation, sourceRevision: m.sourceRevision, candidateRevision,
    manifestHash: c.manifestHash, status: 'running', reason: null, frame: backfillFrame(m.startSec, m.mode, m.historyMetadata),
    launches: [], metadataRanges: [], selected: [], gaps: [], enumerationComplete: false,
    requestCalls: c.calls, requestUnits: c.units, rpcNanoUsd: c.costNanoUsd, fixedNanoUsd: m.budget.fixedNanoUsd,
    pricingEvidence: m.budget.pricingEvidence, invoiceNanoUsd: null, nativeFundingComplete: false, historyComplete: false,
    released: false, elapsedMs: c.elapsedMs, peakRssBytes: c.peakRssBytes };
  const { save, request, header, blockAt, acquireRange } = createBackfillSession({ validation: m.validation,
    sourceRevision: m.sourceRevision, availability: m.availability, budget: m.budget,
    pins: m.selected.map(s => s.launch.creation) }, c, io, out);
  c.status = 'running'; c.reason = null; await save();
  try {
    const watermark = await header(BigInt(m.availability.watermark.blockNumber));
    if (pilotHash(watermark) !== pilotHash(m.availability.watermark)) throw new BackfillStop('source_reorg');
    const from = await blockAt(out.frame.metadata.fromSec), until = await blockAt(out.frame.metadata.untilSec);
    if (from < until) for (const f of m.metadataFilters) await acquireRange({ kind: 'logs', ...f, from: from.toString(), through: (until - 1n).toString() }, 'metadata', out.metadataRanges, true);
    out.enumerationComplete = !out.gaps.some(g => g.scope === 'metadata');
    out.launches.sort((a, b) => a.coin.localeCompare(b.coin)); // Includes all enumerated tokens, never only selected labels.
    for (const s of m.selected) {
      const creation = await header(BigInt(s.launch.creation.blockNumber));
      if (pilotHash(creation) !== pilotHash(s.launch.creation)) throw new BackfillStop('source_reorg');
      const parent = await header(BigInt(creation.blockNumber) - 1n), end = await blockAt(s.untilSec);
      if (BigInt(parent.timestampSec) > BigInt(creation.timestampSec) || end <= BigInt(creation.blockNumber)) throw new Error('Invalid creation boundary');
      const boundary: BackfillRequest = { kind: 'boundary', coin: s.launch.coin, cursor: parent };
      const state = await request(boundary), scope = s.launch.coin;
      if (state.kind !== 'boundary') out.gaps.push({ scope, reason: 'boundary_unavailable', from: parent.blockNumber, through: parent.blockNumber });
      const selected = { coin: scope, from: creation.blockNumber, through: (end - 1n).toString(), boundaryKey: backfillRequestKey(boundary), ranges: [] as BackfillRange[], complete: false };
      out.selected.push(selected);
      for (const f of s.filters) await acquireRange({ kind: 'logs', ...f, from: selected.from, through: selected.through }, scope, selected.ranges, false);
      selected.complete = !out.gaps.some(g => g.scope === scope);
    }
    c.status = out.gaps.length ? 'stopped' : 'complete'; c.reason = out.gaps.length ? 'coverage_gaps' : null;
  } catch (error) {
    c.status = error instanceof BackfillStop ? 'stopped' : 'failed';
    c.reason = error instanceof BackfillStop ? error.message : 'acquisition_failed';
    out.enumerationComplete = false;
    out.gaps.push({ scope: 'runner', reason: c.reason, from: '0', through: m.availability.watermark.blockNumber });
  }
  await save();
  return Object.assign(out, { status: c.status, reason: c.reason, requestCalls: c.calls, requestUnits: c.units,
    rpcNanoUsd: c.costNanoUsd, elapsedMs: c.elapsedMs, peakRssBytes: c.peakRssBytes });
}
