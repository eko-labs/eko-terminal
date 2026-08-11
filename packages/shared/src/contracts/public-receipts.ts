import { z } from 'zod';
import { AddressSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { CHAIN_ID } from '../chain.js';

/** BACKEND §13: producer envelope, before presentation rounding or anchoring. */
export const PublicReceiptPayloadSchema = z.strictObject({
  schemaVersion: z.literal('public-receipt-1'), canonicalization: z.literal('jcs-rfc8785/v1'),
  receiptId: z.string().min(1), revisionId: z.string().min(1), kind: z.enum(['verdict', 'forecast']),
  chainId: z.number().int().positive(), coin: AddressSchema, recordedAt: z.iso.datetime(),
  modelIds: z.array(z.string().min(1)), personaSetVersion: z.string().min(1).nullable(),
  cardSchemaVersion: z.string().min(1), rulesVersion: z.string().min(1), outputSchemaVersion: z.string().min(1),
  snapshotHash: Bytes32Schema, deterministicInput: z.json(), decision: z.json(),
  window: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('snapshot'), blockNumber: z.number().int().nonnegative(), blockHash: Bytes32Schema.nullable() }),
    z.strictObject({ kind: z.literal('forecast'), startsAt: z.literal('commit_block'), durationSec: z.number().int().positive() }),
  ]),
  supersedes: z.string().min(1).nullable(), reorgOf: z.string().min(1).nullable(),
}).superRefine((p, ctx) => {
  if ((p.kind === 'forecast') !== (p.window.kind === 'forecast')) ctx.addIssue({code:'custom',message:'Receipt kind/window mismatch'});
  if (p.kind === 'forecast' && (!p.modelIds.length || !p.personaSetVersion)) ctx.addIssue({code:'custom',message:'Forecast model/persona versions required'});
});
export type PublicReceiptPayload = z.infer<typeof PublicReceiptPayloadSchema>;

// CA-16: pending items have no fabricated registry/proof metadata. Receipt's
// original required anchor fields remain unchanged for existing consumers.
// TODO(spec): CA-16's Receipt requires anchor fields even while pending. Use
// this additive discriminated lookup shape rather than zero/empty anchors.
// Owner retention policy: summaries describe expired payloads; they are not canonical bytes.
export const ReceiptSummarySchema = z.strictObject(PublicReceiptPayloadSchema.shape).pick({ coin: true, supersedes: true, reorgOf: true,
  recordedAt: true, rulesVersion: true, revisionId: true, receiptId: true, window: true,
}).extend({ level: z.enum(['clear', 'monitor', 'danger', 'pending']).nullable() });
const lookup = {
  payloadStatus: z.literal('expired').optional(), summary: ReceiptSummarySchema.optional(),
  id: z.string().min(1), kind: z.enum(['verdict', 'forecast', 'harness_private']),
  hash: Bytes32Schema, leaf: Bytes32Schema, canonicalization: z.literal('jcs-rfc8785/v1'),
};
export const ReceiptLookupSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...lookup, status: z.literal('pending') }),
  z.strictObject({ ...lookup, status: z.literal('anchored'), merkleRoot: Bytes32Schema,
    proof: z.array(Bytes32Schema), batchId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    txHash: Bytes32Schema, block: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    blockHash: Bytes32Schema, registry: AddressSchema, chainId: z.literal(CHAIN_ID), logIndex: z.number().int().nonnegative(),
    revealed: z.json().optional(), canonicalPayload: z.string().optional(),
  }),
]).superRefine((p, ctx) => {
  if (p.payloadStatus === 'expired' && (p.kind !== 'verdict' || (p.status === 'anchored' && p.revealed !== undefined)))
    ctx.addIssue({ code: 'custom', message: 'Invalid expired payload' });
  if (p.status === 'anchored' && ((p.revealed === undefined) !== (p.canonicalPayload === undefined)
    || (p.kind === 'harness_private' && p.revealed !== undefined)))
    ctx.addIssue({ code: 'custom', message: 'Invalid receipt reveal' });
});
export type ReceiptLookup = z.infer<typeof ReceiptLookupSchema>;
