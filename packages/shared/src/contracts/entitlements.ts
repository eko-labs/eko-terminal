import { z } from 'zod';
// FACTS §7 and BACKEND §23 (v1.2).
export const EntitlementsSchema = z.object({
  tier: z.enum(['listener', 'reader', 'oracle', 'source']),
  trial: z.object({
    endsAt: z.string(),
  }).optional(),
  limits: z.object({
    agents: z.number(),
    deepResearchPerDay: z.number(),
    loopBacktestsPerDay: z.number(),
    realtime: z.boolean(),
  }),
  feeBps: z.union([z.literal(0), z.literal(50), z.literal(40), z.literal(30), z.literal(25)]),
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;
