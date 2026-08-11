import { z } from 'zod';
import { CoinCardSchema, PlaybookMatchSchema, VerdictSchema } from './coin.js';
import { GuardAssessmentV2Schema } from './guard-v2.js';
import { NegotiatedCoinCardSchema } from './guard-transport.js';
import { CensusSchema } from './api.js';
import { ReceiptLookupSchema } from './public-receipts.js';

// TODO(spec): §9.3 does not freeze unavailable envelopes or MCP negotiation.
// Keep default V1 verdicts; version:2 explicitly selects the existing Guard contract.
export const SenseUnavailableSchema = z.strictObject({ status: z.literal('unavailable'),
  reason: z.enum(['coin_unavailable', 'delayed_snapshot_unavailable', 'receipt_unavailable', 'receipt_verification_unavailable']) });
// The V1 card is the FACTS CoinCard, as REST serves it: `flow` is the requested window and
// `meta.flow` its availability mask. Unavailable windows keep structural zeros only with
// `meta.flow.unavailable: true`, so consumers never read them as measurements.
export const SenseCoinCardSchema = CoinCardSchema;
export const SenseVerdictResultSchema = z.union([VerdictSchema,
  z.strictObject({ version: z.literal(2), verdict: GuardAssessmentV2Schema.nullable() }), SenseUnavailableSchema]);
export const SenseCardResultSchema = z.union([SenseCoinCardSchema,
  NegotiatedCoinCardSchema.options[1], SenseUnavailableSchema]);
export const SensePlaybookResultSchema = z.union([z.strictObject({ playbooks: z.array(PlaybookMatchSchema),
  history: z.enum(['available', 'unavailable', 'not_requested']).optional() }), SenseUnavailableSchema]);
// The same precision-gated Census as REST GET /census (packet 102): a gated response carries the
// methodology, model and gate status with no headline numbers.
export const SenseCensusResultSchema = CensusSchema.superRefine((v, ctx) => {
  if (v.gated && (v.chain.length || v.coins.length)) ctx.addIssue({ code: 'custom', message: 'Gated Census has no headlines' });
  if (!v.gated && (v.gate.value === null || v.gate.threshold < 0.9 || v.gate.value < v.gate.threshold || !v.gate.modelVersion || !v.gate.evaluatedAt))
    ctx.addIssue({ code: 'custom', message: 'Census label gate has not passed' });
});
// TODO(spec): MCP has no frozen raw receipt payload boundary. Return verified proof
// metadata only; REST retains exact canonical bytes without altering historical hashes.
export const SenseReceiptResultSchema = z.union([
  z.discriminatedUnion('status', [ReceiptLookupSchema.options[0],
    ReceiptLookupSchema.options[1].omit({ revealed: true, canonicalPayload: true })]), SenseUnavailableSchema,
]);
