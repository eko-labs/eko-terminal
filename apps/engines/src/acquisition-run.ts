import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardAvailabilityManifestSchema, guardKnownBy } from '@eko/shared';
import { referenceDigest } from '@eko/chain';
import { ProbabilityFrameSchema, SAMPLE_VERSION, drawProbabilitySample } from './probability-sample.js';
import { SelectiveBackfillManifestSchema, backfillFrame } from './selective-backfill.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const DAY = 86400n;
const groupRow = z.strictObject({ coin: AddressSchema,
  components: z.array(z.strictObject({ id: Bytes32Schema, status: z.enum(['accepted', 'suspected']),
    evidenceIds: z.array(Bytes32Schema).min(1) })), unresolved: z.boolean() });
const source = z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  role: z.enum(['launches', 'funding', 'recycling', 'history', 'comparator']),
  status: z.enum(['verified', 'unavailable', 'awaiting_observation']),
  availability: GuardAvailabilityManifestSchema.nullable() });

// TODO(spec): §§8.3/9.4 have no preparation wire contract. This engines-local,
// label-free definition pins planned scope; a pending population is never a frozen draw.
export const AcquisitionDefinitionSchema = z.strictObject({
  version: z.literal('acquisition-definition-058.1'), origin: z.enum(['fixture', 'measured']),
  chainId: z.literal(4663), startSec: uint, labelsInspected: z.literal(false), historyMetadata: z.boolean(),
  sampling: z.strictObject({ version: z.literal(SAMPLE_VERSION), seed: Bytes32Schema,
    query: ProbabilityFrameSchema.shape.query }),
  sources: z.array(source).min(1),
  population: z.strictObject({ frame: ProbabilityFrameSchema, groups: z.array(groupRow) }).nullable(),
  budget: SelectiveBackfillManifestSchema.shape.budget,
  pilotAcceptanceEvidence: Bytes32Schema.nullable(),
  backfill: SelectiveBackfillManifestSchema.nullable(),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const d = BigInt(m.startSec), f = backfillFrame(m.startSec, 'cohort14plus7', m.historyMetadata);
  if (d % DAY !== 0n || d < 30n * DAY) fail('D must be a UTC midnight after context start');
  if (m.sampling.query.artifactHash !== referenceDigest(m.sampling.query.artifact)) fail('Query artifact mismatch');
  if (new Set(m.sources.map(s => s.id)).size !== m.sources.length || m.sources.filter(s => s.role === 'launches').length !== 1)
    fail('Unique sources and one launch source required');
  for (const s of m.sources) {
    if ((s.status === 'verified') !== (s.availability !== null)) fail('Source status/availability mismatch');
    if (s.availability && (s.availability.sourceId !== s.id || s.availability.watermark.chainId !== 4663 ||
        s.availability.cut.cursor.chainId !== 4663)) fail('Source identity/chain mismatch');
    if (s.availability && (BigInt(s.availability.watermark.timestampSec) > BigInt(s.availability.cut.cursor.timestampSec) ||
        !guardKnownBy({ cursor: s.availability.watermark, acquisitionSequence: '0' }, s.availability.cut)))
      fail('Source watermark exceeds availability cut');
  }
  if (BigInt(m.budget.fixedNanoUsd) > BigInt(m.budget.capNanoUsd)) fail('Fixed costs exceed explicit cap');
  const launchSource = m.sources.find(s => s.role === 'launches');
  const p = m.population;
  if (p) {
    if (p.frame.chainId !== 4663 || p.frame.origin !== m.origin || p.frame.fromSec !== f.launches.fromSec ||
        p.frame.untilSec !== f.launches.untilSec || p.frame.seed !== m.sampling.seed ||
        referenceDigest(p.frame.query) !== referenceDigest(m.sampling.query)) fail('Population differs from frozen definition');
    const a = launchSource?.availability;
    if (!a || a.sourceRevision !== p.frame.sourceRevision || referenceDigest(a.cut) !== referenceDigest(p.frame.availabilityCut) ||
        BigInt(a.watermark.timestampSec) < BigInt(f.launches.untilSec))
      fail('Population source/availability mismatch');
    const members = new Set<string>(p.frame.members.map(x => x.coin));
    if (new Set(p.groups.map(g => g.coin)).size !== p.groups.length || p.groups.length !== members.size ||
        p.groups.some(g => !members.has(g.coin))) fail('Group assignment required for every enumerated token');
    for (const g of p.groups) if (new Set(g.components.map(c => c.id)).size !== g.components.length ||
        !g.unresolved && !g.components.length) fail('Pinned components or explicit unresolved group required');
  }
  const b = m.backfill;
  if (b) {
    if (!p) { fail('Backfill requires frozen population/draw'); return; }
    if (b.startSec !== m.startSec || b.historyMetadata !== m.historyMetadata || b.validation !== m.origin ||
        referenceDigest(b.budget) !== referenceDigest(m.budget) ||
        referenceDigest(b.availability) !== referenceDigest(launchSource?.availability)) fail('Backfill scope/source/budget mismatch');
    if (b.mode === 'cohort14plus7' && !m.pilotAcceptanceEvidence) fail('Expansion requires seven-day pilot acceptance evidence');
    const selected = new Set<string>(drawProbabilitySample(p.frame).strata.flatMap(s => s.selected));
    const sampleRows = b.selected.filter(s => s.reason === 'sample');
    if (sampleRows.some(s => !selected.has(s.launch.coin)) ||
        b.selected.some(s => s.reason !== 'sample' && selected.has(s.launch.coin))) fail('Sample/challenge selection mismatch');
    if (b.mode === 'cohort14plus7' && (sampleRows.length !== selected.size || sampleRows.some(s =>
      BigInt(s.untilSec) < BigInt(s.launch.creation.timestampSec) + 7n * DAY))) fail('Full draw and seven-day follow-up required');
    const members = new Map<string, (typeof p.frame.members)[number]>(p.frame.members.map(x => [x.coin, x]));
    for (const s of sampleRows) {
      const member = members.get(s.launch.coin);
      if (!member || member.launchSec !== s.launch.creation.timestampSec) fail('Selected creation differs from population');
    }
  }
});
export type AcquisitionDefinition = z.infer<typeof AcquisitionDefinitionSchema>;

/** Transitive accepted/suspected components, with unresolved tokens conservatively
 * combined. Later calendar split owns a crossing group; earlier examples are held out.
 * Purged tokens still participate in grouping, so purging cannot disguise leakage.
 */
function assignGroups(p: NonNullable<AcquisitionDefinition['population']>, startSec: string) {
  const parent = new Map<string, string>(p.groups.map(g => [g.coin, g.coin]));
  const root = (coin: string): string => {
    let result = coin;
    while (parent.get(result) !== result) result = parent.get(result)!;
    while (coin !== result) { const next = parent.get(coin)!; parent.set(coin, result); coin = next; }
    return result;
  };
  const union = (a: string, b: string) => {
    const x = root(a), y = root(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  const first = new Map<string, string>();
  for (const g of p.groups) for (const id of [...g.components.map(c => c.id), ...(g.unresolved ? ['unresolved'] : [])]) {
    const prior = first.get(id); if (prior) union(g.coin, prior); else first.set(id, g.coin);
  }
  const d = BigInt(startSec), boundary4 = d + 4n * DAY, boundary7 = d + 7n * DAY;
  const rows = p.frame.members.map(x => {
    const t = BigInt(x.launchSec), split = t < boundary4 ? 0 : t < boundary7 ? 1 : 2;
    const purged = split === 0 && t >= boundary4 - 3900n || split === 1 && t >= boundary7 - 3900n;
    return { coin: x.coin, launchSec: x.launchSec, group: root(x.coin), split, purged };
  });
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.group, Math.max(latest.get(r.group) ?? 0, r.split));
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group)!.push(r.coin);
  }
  const groupIds = new Map([...groups].map(([id, coins]) => [id, referenceDigest(coins.sort())]));
  const names = ['fitting', 'validation', 'locked_test'] as const;
  return rows.map(r => ({ coin: r.coin, launchSec: r.launchSec,
    groupId: groupIds.get(r.group)!, calendarSplit: names[r.split],
    groupSplit: names[latest.get(r.group)!],
    disposition: r.purged ? 'primary_purge' : r.split < latest.get(r.group)! ? 'group_held_out' : 'included',
  })).sort((a, b) => a.coin.localeCompare(b.coin));
}

/** Preparation only: zero dispatches, labels, evaluator jobs or active switches. */
export function prepareAcquisition(input: AcquisitionDefinition) {
  const definition = AcquisitionDefinitionSchema.parse(input);
  const frame = backfillFrame(definition.startSec, 'cohort14plus7', definition.historyMetadata);
  const sample = definition.population ? drawProbabilitySample(definition.population.frame) : null;
  const assignments = definition.population ? assignGroups(definition.population, definition.startSec) : null;
  const selected = new Set<string>(sample?.strata.flatMap(s => s.selected) ?? []);
  const primaryTruth = { version: 'buyer-primary-truth-058.1', entryDelaySec: 60, maximumEntryDelaySec: 300,
    exitHoldSec: 3600, sizesUsd: [100, 1000], accountClasses: ['eoa', 'contract'],
    severelyHurtReturnLtePct: -30, scheduledFailurePreserved: true, providerGaps: 'censored',
    paperFidelityRequired: true, sevenDaySensitivityOnly: true, boosterEnabled: false };
  const manifests = { definition, frame, sample, assignments, primaryTruth,
    fitting: { fromSec: frame.fitting.fromSec, untilSec: (BigInt(frame.fitting.untilSec) - 3900n).toString() },
    validation: { fromSec: frame.validation.fromSec, untilSec: (BigInt(frame.validation.untilSec) - 3900n).toString() },
    groupingPolicy: 'transitive_components_later_split_owns_group_unresolved_combined',
    mode: 'shadow', released: false };
  return { ...manifests, manifestHash: referenceDigest(manifests), definitionHash: referenceDigest(definition),
    status: sample ? 'cohort_frozen' : 'definition_frozen_population_pending',
    remainingPrimaryPopulation: assignments ? Object.fromEntries(['fitting', 'validation', 'locked_test'].map(split =>
      [split, assignments.filter(r => r.calendarSplit === split && r.disposition === 'included').length])) : null,
    remainingPrimarySample: assignments && sample ? Object.fromEntries(['fitting', 'validation', 'locked_test'].map(split =>
      [split, assignments.filter(r => r.calendarSplit === split && r.disposition === 'included' &&
        selected.has(r.coin)).length])) : null };
}
