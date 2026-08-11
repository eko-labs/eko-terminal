import { z } from 'zod';
import { AddressSchema } from './common.js';
import { ChartMarkerSchema, CoinCardSchema, AttributionCoverageGapSchema } from './coin.js';
// BACKEND §5.5: precedence and lower-inclusive confidence bands.
export const WALLET_LABEL_PRECEDENCE = ['declared_agent', 'crew', 'likely_agent', 'human'] as const;
export const LABEL_CONFIDENCE_BANDS = {
  high: { min: 0.90, max: 1 }, medium: { min: 0.75, max: 0.90 }, low: { min: 0.60, max: 0.75 },
} as const;
export const LabelTierSchema = z.enum(['high', 'medium', 'low']);
export type LabelTier = z.infer<typeof LabelTierSchema>;
export const LabelConfidenceSchema = z.number().min(0).max(1);
export type LabelConfidence = z.infer<typeof LabelConfidenceSchema>;
export function labelTier(confidence: number): LabelTier | undefined {
  LabelConfidenceSchema.parse(confidence);
  if (confidence >= 0.90)
    return 'high';
  if (confidence >= 0.75)
    return 'medium';
  if (confidence >= 0.60)
    return 'low';
  return undefined;
}
// TODO(spec): fields — §5.6/§21.1 name FlowEvent without a shape; retain the swap's
// coin, block and ChartMarker fields, the smallest event described by those sections.
export const FlowEventSchema = ChartMarkerSchema.extend({ coin: AddressSchema, block: z.number() });
export type FlowEvent = z.infer<typeof FlowEventSchema>;
export const FlowSchema = CoinCardSchema.shape.flow.extend({ meta: z.object({ confidence:z.number(),asOfBlock:z.number(),unavailable:z.boolean().optional(),missing:z.array(z.string()).optional(),flags:z.array(z.string()).optional(),coverageGaps:z.record(z.string(),AttributionCoverageGapSchema).optional() }).optional() });
export type Flow = z.infer<typeof FlowSchema>;
