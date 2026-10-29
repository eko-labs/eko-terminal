import { z } from 'zod';
import * as s from '@eko/shared';
import * as f from './fixtures';
import { createRadarRows } from './demo/radar';
import { MOCK_HEAD_BLOCK } from './head';
import { missionDemo } from './demo/mission';

export const createConfig = (preset = import.meta.env.VITE_FLAGS): s.PublicConfig => {
  const config = f.createPublicConfig();
  config.trading = { liveEnabled: false, maxTradeUsd: 25, routers: [], spenders: [] };
  config.contracts = { receiptsRegistry: f.createAddress() };
  config.wallets.dev = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
  config.tiers = ['listener', 'reader', 'oracle', 'source'].map((tier) => ({
    tier: tier as s.Entitlements['tier'], minBalance: null, feeBps: 0,
    limits: { agents: 1, deepResearchPerDay: 0, loopBacktestsPerDay: 0, realtime: true }, perks: [],
  }));
  // Same syntax as the server's FLAGS override: comma-separated flag names, and "d0" for every D0 flag (BACKEND §21.4).
  for (const name of (preset ?? '').split(',').map((v: string) => v.trim()).filter(Boolean)) {
    if (name.toLowerCase() === 'd0') { config.phase = 'token_live'; for (const flag of s.FLAG_STAGES.D0) config.flags[flag] = true; }
    else { const flag = s.FlagNameSchema.safeParse(name); if (flag.success) config.flags[flag.data] = true; }
  }
  config.drops = [];
  config.loops = { maxBars: 10000, syncMaxBars: 2000 };
  return s.PublicConfigSchema.parse(config);
};
export const createSession = (): s.Me => s.MeSchema.parse({
  ...f.createMe(), account: { id: 'mock-wallet', wallet: f.createAddress(), linked: [] },
  entitlements: { ...f.createEntitlements(), feeBps: 0, tier: 'listener' },
  trial: { status: 'not_open' }, holdings: { minBalance24h: null }, referralCode: '',
});
export const createManualBurn = () => {
  const burn = f.createBurnStatsWithExtras();
  delete burn.engine;
  return s.BurnStatsWithExtrasSchema.parse({ ...burn, mode: 'manual', recent: [{ ...f.createBurnEvent(), signer: 'burn_wallet', kind: 'daily' }] });
};
export const createQuote = () => s.TradeQuoteSchema.parse({ ...f.createTradeQuote(), binding: false,
  fee: { bps: 0, usd: 0, destination: null }, approvals: [], route: { ...f.createTradeQuote().route, executable: false },
});

const cursor = { cursor: z.string().nullable() };
const ok = z.object({ ok: z.literal(true) });
// TODO(spec): FACTS §7 does not freeze several collection/mutation wrappers. These
// minimal wrappers compose shared item schemas; confirm them with the backend in M2/M3.
const page = <T extends z.ZodType>(schema: T) => z.object({ rows: z.array(schema), ...cursor });
const nonce = s.SiweNonceSchema;
const url = z.object({ url: z.string() });
const share = z.object({ id: z.string(), shareUrl: z.string() });
export interface MockEndpoint {
  method: string; path: string; schema: z.ZodType; create: () => unknown; input?: z.ZodType;
}
const endpoint = (method: string, path: string, schema: z.ZodType, create: () => unknown, input?: z.ZodType): MockEndpoint => ({ method, path, schema, create, input });
const success = (method: string, path: string) => endpoint(method, path, ok, () => ({ ok: true }));
export const endpoints: MockEndpoint[] = [
  endpoint('GET', '/config', s.PublicConfigSchema, createConfig),
  endpoint('POST', '/auth/siwe/nonce', nonce, () => ({ nonce: 'ekoMockNonce123', domain: 'localhost', uri: 'http://localhost:5180', issuedAt: '2026-10-01T12:00:00Z', expirationTime: '2026-10-01T12:10:00Z' })),
  endpoint('POST', '/auth/siwe/verify', s.MeSchema, createSession), success('POST', '/auth/logout'),
  endpoint('GET', '/me', s.MeSchema, createSession),
  endpoint('GET', '/radar', z.object({ rows: z.array(s.RadarRowSchema), ...cursor, delayedSec: z.number() }), () => ({ rows: createRadarRows(), cursor: null, delayedSec: 0 })),
  endpoint('GET', '/pairs', z.object({ rows: z.array(s.PairRowSchema), ...cursor, delayedSec: z.number() }), () => ({ rows: [f.createPairRow()], cursor: null, delayedSec: 0 })),
  endpoint('GET', '/feed', page(s.FeedItemSchema), () => ({ rows: [{ ...f.createFeedItem(), block: MOCK_HEAD_BLOCK }], cursor: null })),
  endpoint('GET', '/coins/:address', s.CoinCardSchema, f.createCoinCard),
  endpoint('GET', '/coins/:address/verdict', s.VerdictSchema, f.createVerdict),
  endpoint('GET', '/coins/:address/candles', z.object({ bars: z.array(s.BarSchema) }), () => ({ bars: [f.createBar()] })),
  endpoint('GET', '/coins/:address/markers', z.object({ markers: z.array(s.ChartMarkerSchema) }), () => ({ markers: [f.createChartMarker()] })),
  endpoint('GET', '/coins/:address/flow', s.FlowSchema, f.createFlow),
  endpoint('POST', '/scan', s.ScanResultSchema, f.createScanResult, z.object({ query: z.string().min(1) })),
  endpoint('GET', '/scan/:id', s.ScanResultSchema, f.createScanResult),
  endpoint('GET', '/wallets/:address/bags', s.BagReportSchema, f.createBagReport),
  endpoint('POST', '/wallets/:address/bags/share', share, () => ({ id: 'bags-1', shareUrl: '/bags/r/bags-1' })),
  endpoint('GET', '/bags/:id', s.BagReportSchema, () => { const report = f.createBagReport(); delete report.wallet; return report; }),
  endpoint('GET', '/census', s.CensusSchema, () => ({ ...f.createCensus(), gated: true, chain: [], coins: [] })),
  endpoint('GET', '/scoreboard', z.object({ rows: z.array(s.ScoreboardRowSchema), ...cursor, counters: z.object({ refused: z.number(), missed: z.number(), since: z.string() }) }), () => ({ rows: [f.createScoreboardRow()], cursor: null, counters: { refused: 0, missed: 0, since: '2026-10-01T00:00:00Z' } })),
  endpoint('GET', '/receipts/:id', s.ReceiptSchema, () => ({ ...f.createReceipt(), ...f.createReceiptProof() })),
  success('POST', '/receipts/:id/reveal'),
  endpoint('GET', '/burn/stats', s.BurnStatsWithExtrasSchema, createManualBurn),
  endpoint('GET', '/burn/events', page(s.BurnEventSchema), () => ({ rows: [f.createBurnEvent()], cursor: null })),
  endpoint('POST', '/trade/quote', s.TradeQuoteSchema, createQuote, s.TradeQuoteRequestSchema),
  endpoint('POST', '/trade/order', z.object({ order: s.TradeOrderSchema, tx: s.UnsignedTxSchema }), () => ({ order: f.createTradeOrder(), tx: f.createUnsignedTx() })),
  endpoint('POST', '/trade/order/:id/submitted', s.TradeOrderSchema, () => ({ ...f.createTradeOrder(), status: 'submitted' })),
  endpoint('POST', '/trade/order/:id/rejected', s.TradeOrderSchema, () => ({ ...f.createTradeOrder(), status: 'rejected', errorCode: 'user_rejected' })),
  endpoint('GET', '/trade/orders', page(s.TradeOrderSchema), () => ({ rows: [f.createTradeOrder()], cursor: null })),
  endpoint('GET', '/trade/orders/:id', s.TradeOrderSchema, f.createTradeOrder),
  endpoint('GET', '/watch', z.object({ items: z.array(s.WatchBodySchema) }), () => ({ items: [f.createWatchBody()] })),
  endpoint('POST', '/watch', s.WatchBodySchema, f.createWatchBody, s.WatchBodySchema), success('DELETE', '/watch'),
  ...['GET', 'PUT'].map((method) => endpoint(method, '/alerts/settings', s.AlertSettingsSchema, f.createAlertSettings)),
  endpoint('GET', '/agents', z.object({ agents: z.array(s.AgentSchema) }), () => ({ agents: missionDemo.agents })),
  endpoint('POST', '/agents', s.AgentSchema, f.createAgent),
  endpoint('GET', '/agents/:id', s.AgentDetailSchema, () => missionDemo.details.scout),
  endpoint('PATCH', '/agents/:id', s.AgentSchema, f.createAgent), success('DELETE', '/agents/:id'),
  endpoint('POST', '/agents/:id/keys', s.ApiKeyCreatedSchema, f.createApiKeyCreated),
  endpoint('GET', '/agents/:id/keys', z.object({ keys: z.array(s.ApiKeyInfoSchema) }), () => ({ keys: [f.createApiKeyInfo()] })), success('DELETE', '/agents/:id/keys/:keyId'),
  endpoint('GET', '/agents/:id/journal', page(s.JournalEntrySchema), () => ({ rows: missionDemo.journals.scout, cursor: null })),
  endpoint('GET', '/agents/:id/unchecked-orders', page(s.UncheckedOrderSchema), () => ({ rows: missionDemo.unchecked, cursor: null })),
  ...['GET', 'PUT'].map((method) => endpoint(method, '/agents/:id/policy', s.PolicySchema, f.createPolicy)),
  endpoint('GET', '/policy-presets', z.object({ presets: z.array(s.PolicySchema) }), () => ({ presets: [f.createPolicy()] })),
  endpoint('GET', '/approvals', page(s.ApprovalSchema), () => ({ rows: missionDemo.approvals, cursor: null })),
  endpoint('GET', '/approvals/:id', s.ApprovalSchema, f.createApproval),
  endpoint('POST', '/approvals/:id', s.ApprovalSchema, f.createApproval),
  endpoint('POST', '/agents/:id/kill', s.HardKillSchema, f.createHardKill), success('POST', '/agents/kill-all'),
  endpoint('POST', '/agents/:id/session-key', s.UnsignedTxSchema, f.createUnsignedTx),
  endpoint('GET', '/agents/:id/summary', s.AgentSummarySchema, f.createAgentSummary),
  endpoint('GET', '/packs', z.object({ packs: z.array(s.PackSchema) }), () => ({ packs: [f.createPack()] })),
  endpoint('POST', '/loops/compile', s.LoopSpecSchema, f.createLoopSpec),
  endpoint('POST', '/loops/backtest', s.LoopBacktestSchema, f.createLoopBacktest),
  endpoint('GET', '/loops', page(s.LoopBacktestSchema), () => ({ rows: [f.createLoopBacktest()], cursor: null })),
  endpoint('POST', '/research', s.ResearchJobSchema, f.createResearchJob), endpoint('GET', '/research/:id', s.ResearchJobSchema, f.createResearchJob),
  endpoint('GET', '/perps/context', s.PerpContextSchema, f.createPerpContext),
  endpoint('GET', '/referrals', s.ReferralsSchema, f.createReferrals), endpoint('GET', '/me/trial-recap', s.TrialRecapSchema, f.createTrialRecap),
  ...['GET', 'PUT'].map((method) => endpoint(method, '/me/preferences', s.PreferencesSchema, () => s.DEFAULT_PREFERENCES)),
  ...['GET', 'PUT'].map((method) => endpoint(method, '/me/journal-consent', s.JournalConsentSchema, () => ({ optedIn: false }))),
  endpoint('POST', '/telegram/link', url, () => ({ url: 'https://t.me/{{BOT_HANDLE}}' })),
  success('POST', '/push/subscriptions'), success('DELETE', '/push/subscriptions'), success('POST', '/telemetry'), endpoint('DELETE', '/me/data', z.object({ deletedAt: z.string().datetime() }), () => ({ deletedAt: '2026-10-13T12:00:00.000Z' })),
  // TODO(spec): CA-9 demo claims, CA-25 RPC, CA-26 host metadata and CA-27 dev injection
  // are transport contracts without frozen shared schemas; keep their mocks local.
  endpoint('GET', '/demo/:token', z.object({ flags: s.FlagsSchema }), () => ({ flags: createConfig().flags })),
  endpoint('POST', '/rpc', z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.string() }), () => ({ jsonrpc: '2.0', id: 1, result: '0x4663' })),
  endpoint('POST', '/dev/fixtures/:shape', ok, () => ({ ok: true })),
];
// TODO(spec): CA-29 Drop payloads (AFI, crews, Arena, Desk, Launcher, Inside,
// Swarm and badge status) are not in @eko/shared yet. Routes remain gated placeholders.
