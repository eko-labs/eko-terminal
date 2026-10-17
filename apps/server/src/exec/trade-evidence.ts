import { z } from 'zod';
import { AddressSchema } from '@eko/shared';

const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const ActualFillSchema = z.strictObject({ filledIn: raw, filledOut: raw });
export type ActualFill = z.infer<typeof ActualFillSchema>;
export const PostFillEvidenceSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'unavailable']), origin: z.enum(['measured', 'unavailable']),
  chainId: z.literal(4663), account: AddressSchema, txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/), blockNumber: raw, amount: raw,
  checkedAt: z.string().datetime(), evidenceIds: z.array(z.string().min(1).max(200)).max(100),
  code: z.enum(['sell_ok', 'sell_failed', 'sim_unavailable']),
}).superRefine((e, ctx) => {
  if (e.status === 'unavailable' ? e.origin !== 'unavailable' || e.code !== 'sim_unavailable'
    : e.origin !== 'measured' || !e.evidenceIds.length || e.code !== (e.status === 'failed' ? 'sell_failed' : 'sell_ok'))
    ctx.addIssue({ code: 'custom', message: 'Sell evidence must distinguish an observed failure from unavailable acquisition' });
});
export type PostFillEvidence = z.infer<typeof PostFillEvidenceSchema>;

