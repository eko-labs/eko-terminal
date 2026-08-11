import { z } from 'zod';
import { FlowSchema } from './labels.js';
import { AddressSchema } from './common.js';
import type { Address } from './common.js';
import { CoinCardSchema, VerdictSchema, ChartMarkerSchema } from './coin.js';
import { RadarRowSchema, PairRowSchema, FeedItemSchema, TickSchema } from './feed.js';
import { BurnEventSchema, BurnStatsWithExtrasSchema } from './burn.js';
import { AlertSchema, ErrorCodeSchema } from './api.js';
import { EntitlementsSchema } from './entitlements.js';
import { AgentSchema, JournalEntrySchema, PreflightResultSchema, ApprovalSchema } from './harness.js';
import { TradeOrderSchema } from './trading.js';
// BACKEND §23 CA-1: this map alone defines the payloads and event kinds.
export const WsEventMapSchema = z.object({
  radar: z.object({ row_upsert: RadarRowSchema, row_remove: z.object({ address: AddressSchema }), rerank: z.object({ order: z.array(AddressSchema) }) }),
  pairs: z.object({ pair_upsert: PairRowSchema, pair_remove: z.object({ address: AddressSchema, column: PairRowSchema.shape.column }) }),
  feed: z.object({ item: FeedItemSchema }),
  coin: z.object({ card: CoinCardSchema, verdict: VerdictSchema, tick: TickSchema }),
  flow: z.object({ marker: ChartMarkerSchema, flow: FlowSchema }),
  burns: z.object({ burn: BurnEventSchema, stats: BurnStatsWithExtrasSchema }),
  alerts: z.object({ alert: AlertSchema, entitlements: EntitlementsSchema }),
  agents: z.object({ agent: AgentSchema, journal: JournalEntrySchema, preflight: PreflightResultSchema.extend({ agentId: z.string(), clientOrderRef: z.string() }) }),
  approvals: z.object({ approval: ApprovalSchema }),
  orders: z.object({ order: TradeOrderSchema }),
});
export type WsEventMap = z.infer<typeof WsEventMapSchema>;
export type WsChannelKind = keyof WsEventMap;
export type WsChannel<K extends WsChannelKind = WsChannelKind> = K extends 'coin' | 'flow' ? `${K}:${Address}` : K;
export type WsEvent<K extends WsChannelKind = WsChannelKind> = K extends WsChannelKind ? {
  [E in keyof WsEventMap[K]]: {
    t: 'ev';
    ch: WsChannel<K>;
    seq: number;
    ts: number;
    kind: E;
    data: WsEventMap[K][E];
  };
}[keyof WsEventMap[K]] : never;
export type WsKind = {
  [K in WsChannelKind]: keyof WsEventMap[K];
}[WsChannelKind];
const channelKinds = Object.keys(WsEventMapSchema.shape) as [
  WsChannelKind,
  ...WsChannelKind[]
];
export const WsChannelKindSchema = z.enum(channelKinds);
export const WsChannelSchema = z.union([
  z.enum(channelKinds.filter((kind) => kind !== 'coin' && kind !== 'flow') as [
    Exclude<WsChannelKind, 'coin' | 'flow'>,
    ...Exclude<WsChannelKind, 'coin' | 'flow'>[]
  ]),
  z.string().regex(/^(coin|flow):0x[0-9a-fA-F]{40}$/).transform((value): WsChannel<'coin' | 'flow'> => value.toLowerCase() as WsChannel<'coin' | 'flow'>),
]);
// Address channels validate the full address and normalize it on parse.
export const WsKindSchema = z.enum(Object.values(WsEventMapSchema.shape).flatMap((schema) => Object.keys(schema.shape)) as [
  WsKind,
  ...WsKind[]
]);
export const WsClientSchema = z.union([
  z.object({ op: z.enum(['sub', 'unsub']), ch: z.array(z.string()) }),
  z.object({ op: z.literal('ping') }),
]);
export type WsClient = z.infer<typeof WsClientSchema>;
// Build channel/kind/data validators from the map; no independent event shape registry.
const eventSchemas = Object.entries(WsEventMapSchema.shape).flatMap(([channel, events]) => Object.entries(events.shape).map(([kind, data]) => z.object({
  t: z.literal('ev'),
  ch: channel === 'coin' || channel === 'flow'
    ? z.string().regex(new RegExp(`^${channel}:0x[0-9a-fA-F]{40}$`)).transform((value) => value.toLowerCase())
    : z.literal(channel),
  seq: z.number(), ts: z.number(), kind: z.literal(kind), data,
})));
// The dynamic map expansion erases literal correlations; the public type keeps them.
export const WsEventSchema = z.union(eventSchemas) as unknown as z.ZodType<WsEvent>;
export const WsServerSchema = z.union([
  z.object({ t: z.literal('hello'), serverTime: z.number(), session: z.enum(['anon', 'user']), delayedSec: z.number() }),
  z.object({ t: z.literal('ack'), ch: z.string(), seq: z.number() }),
  z.object({ t: z.literal('resync'), ch: z.string() }),
  z.object({ t: z.literal('pong'), serverTime: z.number() }),
  z.object({ t: z.literal('err'), code: ErrorCodeSchema, message: z.string(), ch: z.string().optional() }),
  WsEventSchema,
]);
export type WsServer = z.infer<typeof WsServerSchema>;
