import { z } from 'zod';
import { AddressSchema, UntrustedSchema } from './common.js';
import { CoinCardV2Schema, GuardAssessmentV2Schema, EvidenceRefV2Schema, GuardLevelV2Schema, GuardCursorSchema, AvailabilityCutSchema } from './guard-v2.js';
import { Bytes32Schema } from './receipt-encoding.js';

export const GuardReadRequestSchema = z.strictObject({ address: AddressSchema, version: z.union([z.literal(1),z.literal(2)]).default(1) });
export const GuardEvidenceResponseSchema = z.strictObject({ reference: EvidenceRefV2Schema, payload: UntrustedSchema, dependencyIds: z.array(Bytes32Schema) });
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const GuardTotalsSchema = z.discriminatedUnion('status',[
  z.strictObject({ status:z.literal('observed'), activeVersion:z.enum(['verdict-1','guard-2']), coins:count, lower:count,elevated:count,high:count,incomplete:count,noVerdict:count,incompleteCoverage:count,evaluatedToday:count,clear:count,monitor:count,danger:count,pending:count }),
  z.strictObject({ status:z.literal('unavailable'), activeVersion:z.enum(['verdict-1','guard-2']), failureCode:z.literal('missing') }),
]);
export const CoinSummaryV2Schema = z.strictObject({ address:AddressSchema,name:UntrustedSchema,symbol:UntrustedSchema,level:GuardLevelV2Schema.nullable(),verdictPending:z.boolean(),incompleteCoverage:z.boolean(),mode:z.enum(['shadow','candidate','active']).nullable() }).superRefine((v,ctx)=>{
  if(v.verdictPending !== (v.level===null))ctx.addIssue({code:'custom',message:'Pending is only the no-verdict state'});
});
export const GuardListResponseSchema = z.strictObject({version:z.literal(2),rows:z.array(CoinSummaryV2Schema),cursor:z.string().nullable(),totals:GuardTotalsSchema});
export const GuardScanResponseSchema = z.strictObject({version:z.literal(2),status:z.enum(['not_found','ambiguous','pending','ready']),cards:z.array(CoinCardV2Schema),candidates:z.array(CoinSummaryV2Schema)});
export const GuardWsClientSchema = z.union([
  z.strictObject({op:z.enum(['sub','unsub']),version:z.literal(2),ch:z.array(z.string().regex(/^coin:0x[0-9a-f]{40}$/)).max(64)}),
  z.strictObject({op:z.literal('ping')}),
]);
export const GuardWsEventSchema = z.union([
  z.strictObject({t:z.literal('ev'),version:z.literal(2),ch:z.string().regex(/^coin:0x[0-9a-f]{40}$/),seq:count,ts:count,kind:z.literal('card'),data:CoinCardV2Schema.nullable()}),
  z.strictObject({t:z.literal('ev'),version:z.literal(2),ch:z.string().regex(/^coin:0x[0-9a-f]{40}$/),seq:count,ts:count,kind:z.literal('verdict'),data:GuardAssessmentV2Schema.nullable()}),
]);
export type GuardTotals=z.infer<typeof GuardTotalsSchema>;
export type CoinSummaryV2=z.infer<typeof CoinSummaryV2Schema>;
export type GuardWsEvent=z.infer<typeof GuardWsEventSchema>;

/** Typed captured card measurements; projection cannot fill a collector gap. */
export const GuardCardMeasurementSchema = z.strictObject({
  schemaVersion:z.literal('guard-card-measurements-2'),coin:AddressSchema,cursor:GuardCursorSchema,knownAt:AvailabilityCutSchema,
  identity:CoinCardV2Schema.shape.identity.omit({chainId:true,address:true,name:true,symbol:true}).partial().optional(),
  tradeability:CoinCardV2Schema.shape.tradeability.partial().optional(),liquidity:CoinCardV2Schema.shape.liquidity.partial().optional(),
  supply:CoinCardV2Schema.shape.supply.partial().optional(),holdings:CoinCardV2Schema.shape.holdings.partial().optional(),
  control:CoinCardV2Schema.shape.control.partial().optional(),selling:CoinCardV2Schema.shape.selling.partial().optional(),
  flow:CoinCardV2Schema.shape.flow.partial().optional(),text:CoinCardV2Schema.shape.text.partial().optional(),
  collectionCoverage:CoinCardV2Schema.shape.collectionCoverage,
});

export const GuardWsServerSchema = z.union([
  GuardWsEventSchema,
  z.strictObject({t:z.literal('hello'),version:z.literal(2),serverTime:count,mode:z.literal('shadow')}),
  z.strictObject({t:z.literal('pong'),version:z.literal(2),serverTime:count}),
  z.strictObject({t:z.literal('ack'),version:z.literal(2),ch:z.string().regex(/^coin:0x[0-9a-f]{40}$/),seq:count}),
  z.strictObject({t:z.literal('resync'),version:z.literal(2),ch:z.string().regex(/^coin:0x[0-9a-f]{40}$/)}),
  z.strictObject({t:z.literal('err'),version:z.literal(2),code:z.literal('internal_error'),message:z.literal('Card is unavailable.')}),
  z.strictObject({t:z.literal('err'),version:z.literal(2),code:z.literal('rate_limited'),message:z.string()}),
]);
