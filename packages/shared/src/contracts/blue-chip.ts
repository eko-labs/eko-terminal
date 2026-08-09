import { z } from 'zod';

// TODO(spec): Blue chip is an optional category, with floors set by the operator.
export const BlueChipSchema = z.object({ member: z.boolean(), via: z.array(z.enum(['coingecko', 'earned'])) });
export type BlueChip = z.infer<typeof BlueChipSchema>;
export const BlueChipCriteriaSchema = z.object({ minAgeDays: z.number().nonnegative(), minLiquidityUsd: z.number().nonnegative(), minHolders: z.number().int().nonnegative() });
export type BlueChipCriteria = z.infer<typeof BlueChipCriteriaSchema>;
