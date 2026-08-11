import { z } from 'zod';
import { ScoreboardRowSchema } from './api.js';

// TODO(spec): CA-15 has no unavailable counter shape. Null plus explicit status
// distinguishes absent monitoring from an observed zero without changing row kinds.
const availability = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed'), since: z.iso.datetime().optional(), through: z.iso.datetime() }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['monitoring_missing', 'coverage_gap', 'outcomes_unaccepted', 'forecast_dependency', 'd0_gated', 'milestones_unaccepted']) }),
]);
export const ScoreboardResponseSchema = z.strictObject({
  rows: z.array(ScoreboardRowSchema), cursor: z.string().nullable(),
  counters: z.strictObject({ refused: z.number().int().nonnegative().nullable(), missed: z.number().int().nonnegative().nullable(), since: z.iso.datetime().nullable() }),
  availability: z.strictObject({ refused: availability, missed: availability, grades: availability, forecasts: availability, cohort: availability, milestones: availability }),
  snapshot: z.string().regex(/^\d+$/),
});
export type ScoreboardResponse = z.infer<typeof ScoreboardResponseSchema>;
