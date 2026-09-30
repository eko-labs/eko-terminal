import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddressSchema, Bytes32Schema, AvailabilityCutSchema, guardKnownBy } from '@eko/shared';
import { referenceDigest } from '@eko/chain';

export const SAMPLE_VERSION = 'probability-sample-057.1' as const;
export const SAMPLE_STRATA = ['operator_sale', 'restriction', 'non_operator', 'legacy', 'remainder'] as const;
export const SAMPLE_QUOTAS = [100, 75, 75, 100, 250] as const;
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const eligibility = z.strictObject({
  operator_sale: z.boolean(), restriction: z.boolean(), non_operator: z.boolean(), legacy: z.boolean(),
  evidenceIds: z.array(Bytes32Schema),
}).refine(v => !SAMPLE_STRATA.slice(0, 4).some(k => v[k as keyof typeof v] === true) || v.evidenceIds.length > 0,
  'Eligibility requires pinned evidence');
// TODO(spec): §9.3 has no sampling wire contract. This local, label-free envelope
// records the complete enumeration and caller's frozen eligibility query, not a public API.
export const ProbabilityFrameSchema = z.strictObject({
  version: z.literal(SAMPLE_VERSION), origin: z.enum(['fixture', 'measured']), sourceRevision: Bytes32Schema,
  enumerationComplete: z.literal(true), availabilityCut: AvailabilityCutSchema,
  fromSec: uint, untilSec: uint, chainId: z.number().int().positive().safe(),
  query: z.strictObject({ version: z.string().regex(/^\d+\.\d+\.\d+$/), artifact: z.json(), artifactHash: Bytes32Schema }),
  seed: Bytes32Schema,
  members: z.array(z.strictObject({ coin: AddressSchema, launchSec: uint, knownAt: AvailabilityCutSchema, eligibility })),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (m.query.artifactHash !== referenceDigest(m.query.artifact)) fail('Frozen query artifact mismatch');
  if (BigInt(m.fromSec) >= BigInt(m.untilSec) || m.availabilityCut.cursor.chainId !== m.chainId ||
      BigInt(m.availabilityCut.cursor.timestampSec) < BigInt(m.untilSec)) fail('Invalid frame/source interval');
  if (new Set(m.members.map(x => x.coin)).size !== m.members.length) fail('Duplicate population token');
  for (const x of m.members) if (BigInt(x.launchSec) < BigInt(m.fromSec) || BigInt(x.launchSec) >= BigInt(m.untilSec) ||
      x.knownAt.cursor.chainId !== m.chainId || BigInt(x.knownAt.cursor.timestampSec) < BigInt(x.launchSec) ||
      !guardKnownBy(x.knownAt, m.availabilityCut)) fail('Population member outside frame/source cut');
});
export type ProbabilityFrame = z.infer<typeof ProbabilityFrameSchema>;

/** Deterministic counter PRNG + rejection, then partial Fisher-Yates. No modulo bias. */
function randomBelow(seed: string) {
  let counter = 0n;
  return (bound: number) => {
    const b = BigInt(bound), space = 1n << 256n, limit = space - space % b;
    for (;;) {
      const value = BigInt(`0x${createHash('sha256').update(`${seed}:${counter++}`).digest('hex')}`);
      if (value < limit) return Number(value % b);
    }
  };
}
export function drawProbabilitySample(input: ProbabilityFrame) {
  return drawStratifiedProbabilitySample(input, SAMPLE_QUOTAS);
}

/** Shared label-free draw; maintenance quotas are frozen before review. */
export function drawStratifiedProbabilitySample(input: ProbabilityFrame, quotas: readonly number[]) {
  if (quotas.length !== SAMPLE_STRATA.length || quotas.some(q => !Number.isSafeInteger(q) || q < 1))
    throw new Error('Positive quota required for every stratum');
  const frame = ProbabilityFrameSchema.parse(input);
  frame.members.sort((a, b) => a.coin.localeCompare(b.coin));
  const buckets = SAMPLE_STRATA.map(k => frame.members.filter(x =>
    (SAMPLE_STRATA.slice(0, 4).find(s => x.eligibility[s as keyof typeof x.eligibility] === true) ?? 'remainder') === k));
  const counts = buckets.map((b, i) => Math.min(b.length, quotas[i]));
  let vacancies = Math.min(quotas.reduce((a, b) => a + b, 0), frame.members.length) - counts.reduce((a, b) => a + b, 0);
  // Capacity only, before any draw/labels; remainder first, then eligibility priority.
  for (const i of [4, 0, 1, 2, 3]) {
    const added = Math.min(vacancies, buckets[i].length - counts[i]); counts[i] += added; vacancies -= added;
  }
  const strata = buckets.map((members, i) => {
    const seed = referenceDigest({ version: SAMPLE_VERSION, seed: frame.seed, stratum: SAMPLE_STRATA[i] });
    const shuffled = members.map(x => x.coin), below = randomBelow(seed);
    for (let j = 0; j < counts[i]; j++) {
      const k = j + below(shuffled.length - j); [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    return { id: SAMPLE_STRATA[i], target: quotas[i], N_h: members.length, n_h: counts[i], seed,
      members: members.map(x => x.coin), selected: shuffled.slice(0, counts[i]),
      inclusionProbability: members.length ? { numerator: String(counts[i]), denominator: String(members.length) } : null };
  });
  const design = { version: SAMPLE_VERSION, frame, frameHash: referenceDigest(frame),
    populationSize: frame.members.length, sampleSize: counts.reduce((a, b) => a + b, 0), strata,
    expansion: 'new_design_required' as const, released: false as const };
  return { ...design, designHash: referenceDigest(design) };
}
export type ProbabilityDesign = ReturnType<typeof drawProbabilitySample>;

function fraction(n: bigint, d: bigint) {
  const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
  const g = gcd(n < 0n ? -n : n, d);
  return { numerator: (n / g).toString(), denominator: (d / g).toString() };
}
/** Horvitz-Thompson population mean, not a complete-case or unweighted rate.
 * Missing outcomes stop estimation. Challenges cannot be supplied as population rows.
 */
export function weightedSampleRate(design: ProbabilityDesign,
  input: { coin: string; value: boolean | null; origin: 'probability' | 'challenge' }[]) {
  if (referenceDigest(design) !== referenceDigest(drawStratifiedProbabilitySample(design.frame, design.strata.map(s => s.target)))) throw new Error('Altered probability design');
  const rows = z.array(z.strictObject({ coin: AddressSchema, value: z.boolean().nullable(),
    origin: z.enum(['probability', 'challenge']) })).parse(input);
  const selected = design.strata.flatMap(s => s.selected);
  if (!design.populationSize || rows.length !== selected.length || new Set(rows.map(x => x.coin)).size !== rows.length ||
      rows.some(x => x.origin !== 'probability' || x.value === null || !selected.includes(x.coin)))
    throw new Error('Complete probability outcomes required; no challenge/top-up rows');
  let numerator = 0n, denominator = 1n;
  for (const s of design.strata) {
    if (s.N_h && !s.n_h) throw new Error('Zero-probability population stratum');
    if (!s.n_h) continue;
    const positives = rows.filter(x => s.selected.includes(x.coin) && x.value).length;
    numerator = numerator * BigInt(s.n_h) + BigInt(positives) * BigInt(s.N_h) * denominator;
    denominator *= BigInt(s.n_h);
    const reduced = fraction(numerator, denominator); numerator = BigInt(reduced.numerator); denominator = BigInt(reduced.denominator);
  }
  return fraction(numerator, denominator * BigInt(design.populationSize));
}
