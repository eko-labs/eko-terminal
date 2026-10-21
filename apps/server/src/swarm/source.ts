import { z } from 'zod';
import { AddressSchema, SwarmSnapshotHashSchema } from '@eko/shared';
const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const hash = SwarmSnapshotHashSchema;
/** Explicit upstream observations. No provider, model or wallet is constructed by this runner. */
export const SwarmCalibrationInputSchema = z.strictObject({
  forecastId: id, evidence: z.enum(['fixture', 'measured']), availableMs: ms, block: ms, blockHash: hash,
  growth5m: z.number().nullable(), change5mPct: z.number().nullable(), evidenceIds: z.array(hash).min(1).max(100),
});
export const SwarmOutcomeSchema = z.strictObject({
  forecastId: id, anchorHash: hash, endBlock: ms, endBlockHash: hash, availableMs: ms, netAgentUsd: z.number().nullable(),
  coverage: z.strictObject({ complete: z.boolean(), prices: z.boolean(), labels: z.boolean(), provider: z.boolean() }),
  evidenceIds: z.array(hash).min(1).max(100),
});
export const SwarmPaperTickSchema = z.strictObject({
  id: hash, block: ms, blockHash: hash, atMs: ms, cutoffMs: ms,
  prices: z.array(z.strictObject({ coin: AddressSchema, markUsd: z.number().positive().nullable(), ethUsd: z.number().positive().nullable(),
    decimals: z.number().int().min(0).max(36), availableMs: ms, evidenceIds: z.array(hash).min(1).max(100) })).max(10000),
  simulations: z.array(z.strictObject({ positionId: id, referenceId: hash, heldEntryReference: hash.nullable() })).max(50000),
}).refine(t => t.cutoffMs >= t.atMs && t.prices.every(p => p.availableMs <= t.cutoffMs), 'invalid snapshot cutoff');
export const SwarmCalibrationCohortSchema = z.strictObject({ id: hash, startMs: ms, endMs: ms, evidence: z.enum(['fixture', 'measured']) }).refine(c => c.endMs - c.startMs >= 14 * 86400000, 'cohort requires fourteen days');
export type SwarmCalibrationCohort = z.infer<typeof SwarmCalibrationCohortSchema>;
export const SwarmPaperBatchSchema = z.strictObject({
  schemaVersion: z.literal('swarm-paper-input-1'), cohort: SwarmCalibrationCohortSchema.optional(), reportCohortId: hash.optional(),
  inputs: z.array(SwarmCalibrationInputSchema).max(10000), outcomes: z.array(SwarmOutcomeSchema).max(10000), ticks: z.array(SwarmPaperTickSchema).max(10000),
});
export type SwarmCalibrationInput = z.infer<typeof SwarmCalibrationInputSchema>;
export type SwarmOutcome = z.infer<typeof SwarmOutcomeSchema>;
export type SwarmPaperTick = z.infer<typeof SwarmPaperTickSchema>;
