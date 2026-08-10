import { z } from 'zod';
import { AddressSchema, UntrustedSchema, HexSchema } from './common.js';
import { VerdictSchema } from './coin.js';
import { UnsignedTxSchema } from './transactions.js';
import { ActualOrderBindingSchema } from './actual-order.js';
import { CHAIN_ID } from '../chain.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const PolicySchema = z.object({
  mode: z.enum(['safe', 'balanced', 'degen']),
  maxPositionUsd: z.number().optional(),
  maxPositionPct: z.number().optional(),
  maxDailyLossUsd: z.number().optional(),
  allowAssets: z.array(z.string()).optional(),
  blockAssets: z.array(z.string()).optional(),
  blockPlaybookLevel: z.union([z.literal('danger'), z.literal('monitor'), z.null()]),
  earningsBlackoutDays: z.number().optional(),
  minLiquidityUsd: z.number().optional(),
  blueChipsOnly: z.boolean().optional(),
  maxRoundTripCostPct: z.number().optional(),
  maxLeverage: z.number().optional(),
  approvalAboveUsd: z.number().optional(),
  killed: z.boolean(),
  version: z.number(),
  // Absent on original policies; mandatory buyer-level semantics are version 2.
  guardPolicyVersion: z.literal(2).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;
export const PreflightOrderTxSchema = z.object({
  to: AddressSchema,
  data: HexSchema,
  value: z.string(),
});
export type PreflightOrderTx = z.infer<typeof PreflightOrderTxSchema>;
export const PreflightAttestationSchema = z.object({
  executor: AddressSchema,
  chainId: z.literal(CHAIN_ID),
  safe: AddressSchema,
  tokenIn: AddressSchema,
  tokenOut: AddressSchema,
  amountIn: z.string(),
  minOut: z.string(),
  callHash: HexSchema,
  policyVersion: z.number(),
  expiry: z.number(),
  nonce: z.string(),
  signature: HexSchema,
});
export type PreflightAttestation = z.infer<typeof PreflightAttestationSchema>;
export const PreflightRequestSchema = z.object({
  agentId: z.string(),
  clientOrderRef: z.string(),
  order: z.object({
    venue: z.enum(['robinhood', 'rhc', 'base', 'perp', 'elysium']),
    instrument: z.string(),
    side: z.enum(['buy', 'sell']),
    qty: z.number().optional(),
    notionalUsd: z.number().optional(),
    orderType: z.enum(['market', 'limit']),
    limitPrice: z.number().optional(),
    leverage: z.number().optional(),
    tx: PreflightOrderTxSchema.optional(),
    execution: ActualOrderBindingSchema.optional(),
  }),
  context: z.object({
    positions: z.array(z.object({
      instrument: z.string(),
      qty: z.number(),
      valueUsd: z.number(),
    })).optional(),
    cashUsd: z.number().optional(),
    dailyPnlUsd: z.number().optional(),
    earningsDate: z.string().optional(),
    reportedAt: z.string(),
  }).optional(),
});
export type PreflightRequest = z.infer<typeof PreflightRequestSchema>;
export const PreflightResultSchema = z.object({
  preflightId: z.string(),
  decision: z.enum(['allow', 'deny', 'needs_approval']),
  reasons: z.array(z.string()),
  policyVersion: z.number(),
  guardPolicyVersion: z.literal(2).optional(),
  approvalId: z.string().optional(),
  senses: z.object({
    verdict: VerdictSchema.optional(),
  }).optional(),
  attestation: PreflightAttestationSchema.optional(),
  journalId: z.string(),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
export const JournalEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  ts: z.string(),
  kind: z.enum(['session_start', 'decision', 'order', 'outcome', 'note']),
  payload: z.unknown(),
  preflightId: z.string().optional(),
  share: z.boolean(),
  commitment: z.string(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export const ApprovalDetailSchema = z.object({
  clientOrderRef: z.string(),
  order: PreflightRequestSchema.shape.order,
  orderHash: HexSchema,
  notionalUsd: z.number().optional(),
  approvalAboveUsd: z.number(),
  usualSizeUsd: z.number().optional(),
  reasons: z.array(z.string()),
  policyVersion: z.number(),
  guardPolicyVersion: z.literal(2).optional(),
  verdict: VerdictSchema.optional(),
  contextReportedAt: z.string().optional(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;
export const ApprovalSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  preflightId: z.string(),
  summary: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  detail: ApprovalDetailSchema.optional(),
  expiresAt: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export const AgentGuardrailsSchema = z.enum(['advisory', 'enforced']);
export type AgentGuardrails = z.infer<typeof AgentGuardrailsSchema>;
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['robinhood_mcp', 'onchain', 'perp_venue', 'other']),
  wallet: AddressSchema.optional(),
  status: z.enum(['active', 'soft_killed', 'disconnected']),
  lastSeen: z.string().optional(),
  guardrails: AgentGuardrailsSchema.optional(),
  uncheckedOrders24h: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;
export const AgentDetailSchema = AgentSchema.extend({
  guardrails: AgentGuardrailsSchema,
  policy: PolicySchema.pick({ mode: true, version: true, guardPolicyVersion: true, killed: true, blockPlaybookLevel: true, approvalAboveUsd: true, maxPositionUsd: true, maxDailyLossUsd: true }),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export const ApiKeyCreatedSchema = z.object({
  keyId: z.string(),
  prefix: z.string(),
  secret: z.string(),
});
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;
export const ApiKeyInfoSchema = z.object({
  keyId: z.string(),
  prefix: z.string(),
  kind: z.enum(['api', 'oauth']),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  revokedAt: z.string().optional(),
  clientName: UntrustedSchema.optional(),
  scopes: z.array(z.string()).optional(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>;
export const UncheckedOrderSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  externalId: z.string(),
  instrument: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: z.number().optional(),
  notionalUsd: z.number().optional(),
  placedAt: z.string(),
  reportedAt: z.string(),
});
export type UncheckedOrder = z.infer<typeof UncheckedOrderSchema>;
export const HardKillSchema = z.union([z.object({
    kind: z.literal('deeplink'),
    url: z.string(),
  }), z.object({
    kind: z.literal('tx'),
    tx: UnsignedTxSchema,
  })]);
export type HardKill = z.infer<typeof HardKillSchema>;
export const AgentSummarySchema = z.object({
  exposureUsd: z.number(),
  pnl24hUsd: z.number().optional(),
  policyHits24h: z.number(),
  preflights24h: z.number(),
  health: z.enum(['ok', 'warn', 'bad']),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export const PackSchema = z.object({
  // TODO(spec): BACKEND §23 Pack lists no Claude Desktop config pack. claude_desktop is the API-key
  // path through a local stdio bridge while the OAuth connector (claude_connector) waits on 099.
  platform: z.enum(['claude_code', 'claude_desktop', 'claude_connector', 'chatgpt', 'openclaw', 'generic_mcp']),
  stage: z.enum(['T', 'D0']),
  version: z.number(),
  configTemplate: z.string(),
  instructions: z.string(),
  setup: z.string().optional(),
});
export type Pack = z.infer<typeof PackSchema>;

// BACKEND §9.3 journal tool, §9.9 owner reads, CA-30 deletion.
export const JournalWriteSchema = z.object({ kind: JournalEntrySchema.shape.kind,
  payload: z.record(z.string(), z.unknown()), preflightId: z.uuid().optional(), share: z.boolean().default(false) }).strict();
export type JournalWrite = z.infer<typeof JournalWriteSchema>;
export const JournalPageSchema = z.object({ rows: z.array(JournalEntrySchema), cursor: z.string().nullable() });
export const DataDeletedSchema = z.object({ deletedAt: z.iso.datetime() });
export const JournalConsentSchema = z.object({ optedIn: z.boolean() }).strict();
