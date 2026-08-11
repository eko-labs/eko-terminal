import { GuardAssessmentV2Schema } from './guard-v2.js';
import { z } from 'zod';
import { AddressSchema, UntrustedSchema, EvidenceRefSchema } from './common.js';
import { ReceiptRefSchema } from './receipts.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const ResearchNoteSchema = z.object({
  guardV2: GuardAssessmentV2Schema.nullable().optional(),
  coin: AddressSchema, level: z.enum(['clear', 'monitor', 'danger']), confidence: z.number().min(0).max(1),
  summary: UntrustedSchema, // model prose: toUntrusted(text, 600) (§9.5), never a bare string
  sections: z.array(z.object({ title: z.enum(['deployer_and_crew', 'lp_forensics', 'playbooks', 'agent_inflow', 'holders', 'crowding', 'x_sentiment']),
    findings: z.array(UntrustedSchema).max(8), // each toUntrusted(text, 300)
    evidence: z.array(EvidenceRefSchema).max(20) })),
  xSentiment: z.object({ posts: z.number().int(), botFollowerPct: z.number().nullable(), excerpts: z.array(UntrustedSchema).max(5) }).nullable(),
  models: z.array(z.string()), costUsd: z.number(), asOfBlock: z.number().int(),
});
export type ResearchNote = z.infer<typeof ResearchNoteSchema>;
export const ResearchJobSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  steps: z.array(z.object({
    tool: z.string(),
    status: z.enum(['ok', 'error']),
    ms: z.number(),
  })),
  note: ResearchNoteSchema.optional(),
  receipt: ReceiptRefSchema.optional(),
  refunded: z.boolean().optional(),
  costUsd: z.number().optional(),
});
export type ResearchJob = z.infer<typeof ResearchJobSchema>;
