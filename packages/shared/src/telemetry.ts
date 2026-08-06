import { z } from 'zod';
import { ErrorCodeSchema } from './contracts/api.js';
import { EntitlementsSchema } from './contracts/entitlements.js';
import { GUARD_FACTOR_IDS, GUARD_REASON_CODES } from './contracts/guard-ids.js';
import { PlaybookIdSchema } from './contracts/common.js';

// FRONTEND §11–12 / BACKEND §23 CA-24. No free-form labels or resource identifiers.
// TODO(spec): CA-24 does not define payload keys, category enums or bounds. Use
// name + common props + event-specific props; 50 items, 600s samples, 24h durations.
export const TELEMETRY_BODY_LIMIT = 32 * 1024;
export const TelemetryRouteSchema = z.enum([
  '/', '/radar', '/pairs', '/feed', '/coin/:address', '/scan/:id', '/bags', '/bags/r/:id', '/watch',
  '/scoreboard', '/receipt/:id', '/census', '/drops', '/mission', '/mission/agents/:id', '/mission/connect',
  '/mission/approvals', '/approve/:id', '/lab', '/lab/:loopId', '/research', '/research/:id', '/perps',
  '/burn', '/swarm', '/embed/clear/:address', '/settings', '/settings/plan', '/legal/:doc', '/afi',
  '/embed/afi', '/crews', '/crews/:id', '/leaderboards', '/arena', '/desk/:runId', '/mission/launcher',
  '/inside', '/embed/verdict/:address', 'other',
]);
export function telemetryRoute(path: string): z.infer<typeof TelemetryRouteSchema> {
  const clean = path.split(/[?#]/)[0]!;
  for (const template of TelemetryRouteSchema.options) {
    const parts = template.split('/'), actual = clean.split('/');
    if (parts.length === actual.length && parts.every((p, i) => p.startsWith(':') ? !!actual[i] : p === actual[i])) return template;
  }
  return 'other';
}
export const CLIENT_METRICS = [
  'ui.signal_arrival_to_paint_ms', 'ui.click_to_card_ms', 'ui.click_to_submit_ms', 'ui.quote_roundtrip_ms',
  'ui.scan_to_verdict_ms', 'ui.ws_event_to_paint_ms', 'ui.chart_load_ms', 'ui.approval_open_ms', 'ws.rtt_ms',
] as const;
export const TelemetrySampleSchema = z.strictObject({
  metric: z.enum(CLIENT_METRICS), value: z.number().min(0).max(600_000), demo: z.boolean().optional(),
});
const common = {
  ts: z.number().int().min(0).max(8_640_000_000_000_000), route: TelemetryRouteSchema,
  sessionId: z.uuid(), buildSha: z.string().regex(/^(?:[a-f0-9]{7,40}|unknown)$/),
  tier: EntitlementsSchema.shape.tier, trial: z.boolean(), demo: z.boolean(),
  device: z.enum(['mobile', 'tablet', 'desktop', 'unknown']),
};
const seconds = z.number().min(0).max(86_400);
const source = z.enum(['paste', 'search', 'radar', 'pairs', 'feed', 'bags', 'web', 'telegram', 'api', 'onchain', 'byo', 'other']);
const platform = z.enum(['claude_code', 'claude_desktop', 'claude_ai', 'chatgpt', 'openclaw', 'generic', 'other']);
const codes = z.array(z.union([z.enum(GUARD_FACTOR_IDS), z.enum(GUARD_REASON_CODES), PlaybookIdSchema, ErrorCodeSchema,
  z.enum(['calldata_mismatch', 'scan_pending', 'slippage', 'liquidity', 'tax', 'exit_cost', 'size', 'stale_quote'])])).max(32);
const event = <N extends string, S extends z.ZodRawShape>(name: N, props: S) =>
  z.strictObject({ ...common, name: z.literal(name), props: z.strictObject(props) });
const plain = <N extends string>(name: N) => z.strictObject({ ...common, name: z.literal(name), props: z.strictObject({}).optional() });
export const TelemetryEventSchema = z.discriminatedUnion('name', [
  plain('landing_view'), plain('page_view'), event('scan_submitted', { source }),
  event('scan_result_viewed', { level: z.enum(['clear', 'monitor', 'danger', 'info', 'pending']) }),
  plain('wallet_connect_started'), event('wallet_connected', { connector: z.enum(['injected', 'walletconnect', 'coinbase', 'other']) }),
  plain('network_switched'), plain('siwe_completed'),
  event('bags_scanned', { holdings: z.number().int().min(0).max(100_000), danger: z.number().int().min(0).max(100_000) }),
  event('bag_report_shared', { channel: z.enum(['copy', 'x', 'telegram', 'other']) }), plain('trial_started'),
  event('trade_quote_viewed', { decision: z.enum(['allow', 'warn', 'refuse']) }), plain('trade_tap'),
  event('guard_refused', { checks: codes }), event('guard_warning_ack', { codes }), plain('trade_submitted'),
  event('trade_confirmed', { venue: z.enum(['uniswap_v3', 'uniswap_v4', 'pons_curve', 'other']), sizeBucket: z.enum(['small', 'medium', 'large']) }),
  event('trade_failed', { code: z.union([ErrorCodeSchema, z.literal('calldata_mismatch')]) }),
  plain('trial_recap_viewed'), event('upgrade_prompt_viewed', { feature: z.enum(['agents', 'deep_research', 'loop_lab', 'realtime', 'other']), requiredTier: EntitlementsSchema.shape.tier }),
  plain('plan_viewed'), plain('referral_landing'), plain('referral_link_copied'), event('agent_connect_started', { platform }),
  plain('agent_key_created'), event('mcp_config_copied', { platform }), event('first_preflight_seen', { secondsSinceKey: seconds }),
  event('approval_viewed', { source: z.enum(['push', 'telegram', 'web']) }),
  event('approval_decided', { decision: z.enum(['approved', 'denied']), secondsToDecide: seconds }),
  plain('loop_compiled'), event('backtest_run', { source: z.enum(['onchain', 'byo']) }),
  event('kill_used', { mode: z.enum(['soft', 'hard']), scope: z.enum(['agent', 'all']) }),
  plain('alert_opened'), event('watch_added', { kind: z.enum(['coin', 'wallet', 'crew']) }), plain('pwa_installed'), plain('push_enabled'),
  event('drop_demo_played', { drop: z.number().int().min(1).max(9) }), event('drop_surface_viewed', { drop: z.number().int().min(1).max(9) }),
]);
export const TelemetryErrorKindSchema = z.enum(['type_error', 'range_error', 'syntax_error', 'client_error']);
export function telemetryErrorKind(err: unknown): z.infer<typeof TelemetryErrorKindSchema> {
  if (err instanceof TypeError) return 'type_error';
  if (err instanceof RangeError) return 'range_error';
  if (err instanceof SyntaxError) return 'syntax_error';
  return 'client_error';
}
export const TelemetryErrorSchema = z.strictObject({
  kind: TelemetryErrorKindSchema.optional(), demo: z.boolean().optional(),
  // Accept bounded legacy-shaped errors, but discard all text before observation.
  message: z.string().max(500).optional(), stack: z.string().max(4000).optional(), url: z.string().max(300).optional(),
});
export const TelemetrySchema = z.strictObject({
  events: z.array(TelemetryEventSchema).max(50).default([]),
  samples: z.array(TelemetrySampleSchema).max(50).default([]), error: TelemetryErrorSchema.optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;
export type Telemetry = z.infer<typeof TelemetrySchema>;
