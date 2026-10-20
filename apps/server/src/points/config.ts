import { z } from 'zod';

export const PointCategorySchema = z.enum(['guarded_volume', 'shared_journal', 'opened_scan', 'ghost_tip']);
export type PointCategory = z.infer<typeof PointCategorySchema>;
const rate = z.strictObject({ pointsPerUnit: z.number().int().nonnegative().max(1_000_000), dailyCapPoints: z.number().int().nonnegative().max(1_000_000_000) });
export const PointsRatesSchema = z.strictObject({
  guarded_volume: rate.optional(), shared_journal: rate.optional(), opened_scan: rate.optional(), ghost_tip: rate.optional(),
});
export type PointsRates = z.infer<typeof PointsRatesSchema>;
export function parsePointsRates(value: string): PointsRates { return PointsRatesSchema.parse(JSON.parse(value)); }
// TODO(spec): Exact point rates and daily caps are unspecified. All rates are
// disabled until launch economics and the T activation instant are configured;
// redemption and unsupported earning categories remain unavailable.
