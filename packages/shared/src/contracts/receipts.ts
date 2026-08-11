import { z } from 'zod';
// FACTS §7 and BACKEND §23 (v1.2).
export const ReceiptRefSchema = z.object({
  id: z.string(),
  hash: z.string(),
  status: z.enum(['pending', 'committed']),
  batchId: z.number().optional(),
  txHash: z.string().optional(),
});
export type ReceiptRef = z.infer<typeof ReceiptRefSchema>;
export const ReceiptProofSchema = z.object({
  leaf: z.string(),
  proof: z.array(z.string()),
  batchId: z.number(),
  canonicalization: z.literal('jcs-rfc8785/v1'),
});
export type ReceiptProof = z.infer<typeof ReceiptProofSchema>;
// CA-16: receipt responses include optional proof/reveal metadata.
export const ReceiptSchema = z.object({
  id: z.string(),
  kind: z.enum(['verdict', 'forecast', 'harness_private']),
  hash: z.string(),
  merkleRoot: z.string(),
  block: z.number(),
  txHash: z.string(),
  revealed: z.unknown().optional(),
  grade: z.enum(['hit', 'miss', 'n/a']).optional(),
}).extend(ReceiptProofSchema.partial().shape);
export type Receipt = z.infer<typeof ReceiptSchema>;
