import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, RationalSchema, guardKnownBy } from '@eko/shared';
import { referenceDigest } from '@eko/chain';
import type { ProbabilityDesign } from './probability-sample.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const code = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,191}$/);
export const PARITY_QUESTIONS = ['original_descendant_bags', 'current_sellers', 'account_size_exit',
  'independent_audience', 'recycled_capital', 'horizon_changes', 'failure_recovery',
  'identity_promotion_provenance', 'freshness_excluded_mass'] as const;
const answer = z.strictObject({
  question: z.enum(PARITY_QUESTIONS), status: z.enum(['answered', 'unknown', 'unsupported', 'error']),
  reason: z.enum(['none', 'source_missing', 'historic_endpoint_unsupported', 'chain_unsupported', 'route_unsupported',
    'price_unknown', 'denominator_unknown', 'roles_unknown', 'archive_missing']),
  value: z.union([RationalSchema, uint, z.boolean(), z.array(AddressSchema)]).nullable(),
  unit: z.enum(['raw', 'ratio', 'boolean', 'address']),
  basis: z.enum(['original', 'descendant', 'current_held', 'initial_gross', 'not_applicable', 'unknown']),
  roles: z.enum(['verified', 'unknown', 'not_applicable']),
  denominator: z.strictObject({ convention: z.enum(['minted', 'total', 'circulating', 'holder_float', 'quote_cost', 'not_applicable', 'unknown']),
    raw: uint.nullable() }),
  coveredRaw: uint.nullable(), excludedRaw: uint.nullable(), evidenceIds: z.array(Bytes32Schema),
}).superRefine((a, ctx) => {
  if (a.status === 'answered' ? a.value === null || !a.evidenceIds.length || a.reason !== 'none' : a.value !== null || a.reason === 'none')
    ctx.addIssue({ code: 'custom', message: 'Answer/status evidence mismatch' });
  if (['unknown', 'not_applicable'].includes(a.denominator.convention) ? a.denominator.raw !== null :
      a.denominator.raw === null || a.denominator.raw === '0') ctx.addIssue({ code: 'custom', message: 'Exact denominator required' });
  if (a.value !== null && (a.unit === 'raw' ? typeof a.value !== 'string' : a.unit === 'ratio' ?
    typeof a.value !== 'object' || Array.isArray(a.value) : a.unit === 'boolean' ? typeof a.value !== 'boolean' : !Array.isArray(a.value)))
    ctx.addIssue({ code: 'custom', message: 'Answer unit mismatch' });
});
export const MatchedSnapshotSchema = z.strictObject({
  source: z.enum(['eko', 'raw_receipts', 'gmgn', 'goplus', 'codex', 'dexscreener', 'bubblemaps', 'scanhood', 'axiom', 'rugcheck', 'trenchbot']),
  endpoint: code, methodVersion: code, payloadHash: Bytes32Schema, contextHash: Bytes32Schema,
  observedCursor: GuardCursorSchema.nullable(), acquiredAt: AvailabilityCutSchema, capturedAtUnixMs: uint,
  capability: z.strictObject({ status: z.enum(['verified', 'unsupported', 'unknown']),
    chainId: z.number().int().positive().safe(), historical: z.boolean(), fromSec: uint.nullable(), untilSec: uint.nullable(),
    reason: z.enum(['none', 'historic_endpoint_unsupported', 'chain_unsupported', 'route_unsupported', 'source_missing']), evidenceIds: z.array(Bytes32Schema) }),
  status: z.enum(['available', 'missing', 'unsupported']), quoteUsd: RationalSchema.nullable(),
  priceEvidenceIds: z.array(Bytes32Schema), responseTimeMs: z.number().nonnegative().finite().nullable(),
  answers: z.array(answer).length(PARITY_QUESTIONS.length),
}).superRefine((s, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(s.answers.map(a => a.question)).size !== PARITY_QUESTIONS.length) fail('Finite parity questions required exactly once');
  if (s.quoteUsd && (BigInt(s.quoteUsd.numerator) <= 0n || !s.priceEvidenceIds.length)) fail('Unverified USD price');
  if (!s.quoteUsd && s.priceEvidenceIds.length) fail('Missing price must remain unknown');
  if (s.capability.status === 'verified' && (!s.capability.evidenceIds.length || s.capability.reason !== 'none' ||
      s.capability.fromSec === null || s.capability.untilSec === null || BigInt(s.capability.fromSec) >= BigInt(s.capability.untilSec))) fail('Unverified endpoint interval');
  if (s.capability.status !== 'verified' && s.capability.reason === 'none') fail('Endpoint gap reason required');
  if (s.status === 'available' ? s.observedCursor === null || s.capability.status !== 'verified' || s.responseTimeMs === null :
      s.observedCursor !== null || s.quoteUsd !== null || s.answers.some(a => a.status === 'answered')) fail('Unavailable snapshot cannot contain observations');
  if (s.status === 'unsupported' && (s.capability.status !== 'unsupported' || s.answers.some(a => a.status !== 'unsupported')))
    fail('Unsupported endpoint must be explicit for every field');
  if (s.observedCursor && BigInt(s.capturedAtUnixMs) < BigInt(s.observedCursor.timestampSec) * 1000n) fail('Capture precedes snapshot');
});
export const MatchedSourceRecordSchema = z.strictObject({
  origin: z.enum(['fixture', 'measured']), sourceRevision: Bytes32Schema,
  context: z.strictObject({ coin: AddressSchema, cursor: GuardCursorSchema, routeId: code,
    sizeUsd: z.union([z.literal(100), z.literal(1000)]), account: AddressSchema, accountClass: z.enum(['eoa', 'contract']),
    stage: z.enum(['curve', 'graduated', 'unknown']), horizonSec: z.literal(3600), historical: z.boolean() }),
  // Each source carries its own supply convention and gross/held basis. They are
  // never silently converted to another vendor's denominator or to USD.
  snapshots: z.array(MatchedSnapshotSchema).min(3),
}).superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sources = r.snapshots.map(s => s.source);
  if (new Set(sources).size !== sources.length || !sources.includes('eko') || !sources.includes('raw_receipts') ||
      !sources.some(s => s !== 'eko' && s !== 'raw_receipts')) fail('EKO/raw/comparator sources required without duplicates');
  for (const s of r.snapshots) {
    if (s.contextHash !== referenceDigest(r.context)) fail('Snapshot token/time/route/size/account/stage mismatch');
    if (s.acquiredAt.cursor.chainId !== r.context.cursor.chainId || s.capability.chainId !== r.context.cursor.chainId ||
        !guardKnownBy({ cursor: r.context.cursor, acquisitionSequence: '0' }, s.acquiredAt)) fail('Source acquisition does not match requested chain/cut');
    if (s.observedCursor && (referenceDigest(s.observedCursor) !== referenceDigest(r.context.cursor) ||
        (r.context.historical && !s.capability.historical) ||
        s.capability.fromSec === null || s.capability.untilSec === null ||
        BigInt(r.context.cursor.timestampSec) < BigInt(s.capability.fromSec) ||
        BigInt(r.context.cursor.timestampSec) >= BigInt(s.capability.untilSec))) fail('Source snapshot lacks exact time/historical capability');
  }
});
export type MatchedSourceRecord = z.infer<typeof MatchedSourceRecordSchema>;

const criticalOmissions = (a: z.infer<typeof answer>) => a.status === 'answered' && (
  (['original_descendant_bags', 'independent_audience'].includes(a.question) &&
    (['unknown', 'not_applicable'].includes(a.denominator.convention) || a.basis === 'unknown' || a.coveredRaw === null || a.excludedRaw === null)) ||
  (['current_sellers', 'identity_promotion_provenance', 'original_descendant_bags'].includes(a.question) && a.roles !== 'verified'));

/** Import normalized, content-pinned captures, not vendor transports or human labels. */
export function importMatchedSources(input: unknown) {
  const records = z.array(MatchedSourceRecordSchema).min(100).parse(input);
  const keys = records.map(r => referenceDigest(r.context));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate matched token/time/route/size/account record');
  records.sort((a, b) => referenceDigest(a.context).localeCompare(referenceDigest(b.context)));
  const sources = [...new Set(records.flatMap(r => r.snapshots.map(s => s.source)))].sort();
  const origins = [...new Set(records.map(r => r.origin))].sort();
  const coverage = origins.flatMap(origin => sources.map(source => {
    const snapshots = records.filter(r => r.origin === origin).flatMap(r => r.snapshots.filter(s => s.source === source));
    const answers = snapshots.flatMap(s => s.answers);
    return { origin, source, snapshots: snapshots.length, measuredAvailable: records.filter(r => r.origin === origin && r.origin === 'measured' &&
      r.snapshots.some(s => s.source === source && s.status === 'available')).length,
    available: snapshots.filter(s => s.status === 'available').length, unsupported: snapshots.filter(s => s.status === 'unsupported').length,
    unknownPrice: snapshots.filter(s => s.quoteUsd === null).length,
    unanswerable: answers.filter(a => a.status !== 'answered').length, totalQuestions: answers.length,
    criticalOmissions: answers.filter(criticalOmissions).length,
    responseTimesMs: snapshots.map(s => s.responseTimeMs).filter((v): v is number => v !== null) };
  }));
  const supportedParity = origins.flatMap(origin => sources.filter(s => s !== 'eko' && s !== 'raw_receipts').map(source => {
    const pairs = records.filter(r => r.origin === origin).flatMap(r => {
      const comparator = r.snapshots.find(s => s.source === source), eko = r.snapshots.find(s => s.source === 'eko')!;
      if (!comparator || comparator.status !== 'available') return [];
      return comparator.answers.filter(a => a.status !== 'unsupported').map(a => ({ comparator: a, eko: eko.answers.find(e => e.question === a.question)! }));
    });
    return { origin, source, supportedFields: pairs.length,
      comparatorUnanswerable: pairs.filter(p => p.comparator.status !== 'answered').length,
      ekoUnanswerable: pairs.filter(p => p.eko.status !== 'answered').length,
      criticalOmissions: pairs.filter(p => criticalOmissions(p.comparator) || criticalOmissions(p.eko)).length };
  }));
  return { version: 'matched-source-057.1' as const, records, recordsHash: referenceDigest(records), coverage, supportedParity,
    measuredRecords: records.filter(r => r.origin === 'measured').length,
    parityGatePassed: false as const, humanReviewComplete: false as const, released: false as const };
}

export const IncidentChallengeInputSchema = z.strictObject({
  version: z.literal('incident-challenge-057.1'), origin: z.enum(['fixture', 'measured']), sourceRevision: Bytes32Schema,
  // Aggregate allegations remain source claims; category membership can overlap.
  allegation: z.strictObject({ reportedLaunches: z.literal(53), reportedExtractedUsd: z.literal('18430000'),
    categoryCounts: z.tuple([z.literal(45), z.literal(4), z.literal(4)]), evidenceIds: z.array(Bytes32Schema).min(1),
    status: z.literal('unreconciled_allegation') }),
  availability: z.enum(['manifest_unavailable', 'archive_unavailable', 'provided']),
  members: z.array(z.strictObject({ coin: AddressSchema, launch: GuardCursorSchema, launchTransaction: Bytes32Schema,
    // Supplied normalized launch receipt, not an abbreviation expanded by this importer.
    verification: z.strictObject({ coin: AddressSchema, transaction: Bytes32Schema, cursor: GuardCursorSchema,
      receiptHash: Bytes32Schema, evidenceIds: z.array(Bytes32Schema).min(1) }),
    archiveComplete: z.boolean(), categories: z.array(z.enum(['collector_next_funder', 'shared_batch', 'shared_collector'])),
  })),
}).superRefine((v, ctx) => {
  for (const m of v.members) if (m.coin !== m.verification.coin || m.launchTransaction !== m.verification.transaction ||
    referenceDigest(m.launch) !== referenceDigest(m.verification.cursor) || m.launch.boundary !== 'after_tx')
    ctx.addIssue({ code: 'custom', message: 'Incident identity requires matching full launch receipt' });
  if (v.availability === 'manifest_unavailable' && v.members.length) ctx.addIssue({ code: 'custom', message: 'Unavailable manifest cannot invent members' });
});
export type IncidentChallengeInput = z.infer<typeof IncidentChallengeInputSchema>;
export function prepareIncidentChallenge(input: IncidentChallengeInput, sample: ProbabilityDesign) {
  const m = IncidentChallengeInputSchema.parse(input);
  const members = new Map<string, IncidentChallengeInput['members'][number]>();
  for (const member of m.members) {
    const key = `${member.launch.chainId}:${member.coin}`, prior = members.get(key);
    if (prior && (prior.launchTransaction !== member.launchTransaction || referenceDigest(prior.verification) !== referenceDigest(member.verification) ||
        prior.archiveComplete !== member.archiveComplete)) throw new Error('Conflicting incident launch verification');
    members.set(key, { ...member, categories: [...new Set([...(prior?.categories ?? []), ...member.categories])].sort() });
  }
  if (members.size > 53) throw new Error('Incident exceeds reported 53 distinct launches');
  const selected = sample.strata.flatMap(s => s.selected);
  const rows = [...members.values()].sort((a, b) => `${a.launch.chainId}:${a.coin}`.localeCompare(`${b.launch.chainId}:${b.coin}`))
    .map(member => ({ ...member, probabilitySampleOverlap: member.launch.chainId === sample.frame.chainId && selected.includes(member.coin),
      populationProbability: null, label: 'unreproduced' as const }));
  return { ...m, members: rows, manifestComplete: rows.length === 53,
    reconstructionReady: m.availability === 'provided' && rows.length === 53 && rows.every(r => r.archiveComplete),
    reproduced: false as const, heldOutChallenge: true as const, populationRateEligible: false as const, released: false as const };
}
