import { AgentSchema, AgentDetailSchema, ApprovalSchema, JournalEntrySchema, PolicySchema, UncheckedOrderSchema, ApiKeyInfoSchema, AgentCallSchema, type AgentActivity, type AgentCall, type RadarRow } from '@eko/shared';
import { countCall, emptyToday, ACTIVITY_CAP } from '../../lib/agentActivity';
import { createRadarRows } from './radar';
import prototype from './mission-prototype.json';
import history from './mission-history.json';
import connections from './mission-connections.json';
export const demoConnections = connections;

// Read-only prototype data, ported to FACTS §7 / CA-18. No simulated enforcement at T.
const loaded = Date.now();
export interface JournalPayload {
  verdict?: import('@eko/shared').Verdict['level']; kind?: string; side?: string; symbol?: string; usd?: number; decision?: string;
  text?: string; detail?: string; reasons?: string[]; rule?: string; policyVersion?: number;
  fill?: string; lev?: number; venue?: string; ago?: number; id?: string; pf?: string;
}
export const demoMetrics = Object.fromEntries(prototype.agents.map((a) => [a.id, {
  ...a, guardrails: 'advisory', hourly: prototype.activity[a.id as keyof typeof prototype.activity],
  performance: prototype.performance[a.id as keyof typeof prototype.performance],
  rules: prototype.rules[a.id as keyof typeof prototype.rules],
}]));
export const previousChecks = prototype.previousChecks;
export function createMissionDemo(now = loaded) {
  const iso = (ago = 0) => new Date(now - ago * 1000).toISOString();
  const policies = Object.fromEntries(prototype.agents.map((a) => {
    const p = prototype.policies[a.id as keyof typeof prototype.policies];
    return [a.id, PolicySchema.parse({ ...p, mode: a.preset.toLowerCase(),
      blockPlaybookLevel: p.blockMonitor ? 'monitor' : 'danger', killed: a.status === 'paused', version: a.policyVersion })];
  }));
  const agents = prototype.agents.map((a) => AgentSchema.parse({ ...a,
    kind: a.kind === 'stocks' ? 'robinhood_mcp' : a.kind === 'perps' ? 'perp_venue' : a.kind,
    wallet: a.wallet ?? undefined, status: a.status === 'paused' ? 'soft_killed' : 'active',
    guardrails: 'advisory', lastSeen: iso(a.lastSeenSec), uncheckedOrders24h: a.unchecked }));
  const details = Object.fromEntries(agents.map((a) => [a.id, AgentDetailSchema.parse({ ...a, policy: policies[a.id] })]));
  const approvals = prototype.approvals.map((a) => ApprovalSchema.parse({
    id: a.id, agentId: a.agent, preflightId: a.preflightId, summary: a.summary, status: 'pending',
    expiresAt: new Date(now + a.expiresSec * 1000).toISOString(), detail: {
      clientOrderRef: a.id, order: { venue: a.agent === 'scout' ? 'rhc' : a.agent === 'hedge' ? 'perp' : 'robinhood',
        instrument: a.symbol, side: a.side, notionalUsd: a.usd, orderType: 'market', ...(a.agent === 'hedge' ? { leverage: 3 } : {}) },
      orderHash: `0x${'1'.repeat(64)}`, notionalUsd: a.usd,
      approvalAboveUsd: a.agent === 'scout' ? 100 : policies[a.agent].approvalAboveUsd,
      usualSizeUsd: a.usualUsd, reasons: [a.reason], policyVersion: a.policyVersion,
    },
  }));
  approvals.push(...history.map((a) => ApprovalSchema.parse({ id: a.id, agentId: a.agent, preflightId: `pf-${a.id}`, summary: `${a.side === 'buy' ? 'Buy' : 'Sell'} $${a.usd} ${a.symbol}`, status: a.decision, expiresAt: iso(a.ago), detail: { clientOrderRef: a.id, orderHash: `0x${'2'.repeat(64)}`, order: { venue: a.agent === 'scout' ? 'rhc' : a.agent === 'hedge' ? 'perp' : 'robinhood', instrument: a.symbol, side: a.side, notionalUsd: a.usd, orderType: 'market' }, approvalAboveUsd: policies[a.agent].approvalAboveUsd, reasons: [a.rule], policyVersion: policies[a.agent].version } })));
  const journals = Object.fromEntries(Object.entries(prototype.journals).map(([id, rows]) => [id,
    (rows as JournalPayload[]).map((e) => JournalEntrySchema.parse({ id: e.id, agentId: id, ts: iso(e.ago),
      kind: e.kind === 'session' ? 'session_start' : e.kind === 'preflight' || e.kind === 'approval' ? 'decision' : e.kind === 'order' || e.kind === 'unchecked' ? 'order' : 'note',
      payload: e, preflightId: e.pf, share: false, commitment: (e as JournalPayload & { commit: string }).commit,
    }))]));
  const unchecked = [UncheckedOrderSchema.parse({ id: 'unchecked-dca-amd', agentId: 'dca', externalId: 'demo-amd',
    instrument: 'AMD', side: 'buy', notionalUsd: 300, placedAt: iso(610), reportedAt: iso(600) })];
  const keys = Object.fromEntries(agents.map((a) => [a.id, [ApiKeyInfoSchema.parse({ keyId: `demo-${a.id}`,
    prefix: 'eko_demo', kind: a.id === 'dca' ? 'oauth' : 'api', createdAt: '2026-09-12T00:00:00Z', lastUsedAt: a.lastSeen,
    clientName: { text: demoMetrics[a.id].client, flags: [], truncated: false }, scopes: ['preflight', 'journal'] })]]));
  return { agents, details, approvals, journals, unchecked, policies, keys };
}
export const missionDemo = createMissionDemo();

// Shared by the offline HTTP transport and WebSocket transport, so decisions update every consumer.
type DemoEvent = { ch: 'agents'; kind: 'agent'; data: import('@eko/shared').Agent } | { ch: 'agents'; kind: 'journal'; data: import('@eko/shared').JournalEntry }
  | { ch: 'agents'; kind: 'call'; data: AgentCall } | { ch: 'approvals'; kind: 'approval'; data: import('@eko/shared').Approval };
const listeners = new Set<(event: DemoEvent) => void>();
export function onMissionEvent(listener: (event: DemoEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function emitMission(ch: DemoEvent['ch'], kind: DemoEvent['kind'], data: DemoEvent['data']) {
  const event = { ch, kind, data: structuredClone(data) } as DemoEvent;
  listeners.forEach((listener) => listener(event));
}

/*
 * A believable live agent for mock mode: "Trench scout" (scout) runs the starter agent's loop against the mock Radar's
 * coins, one MCP call every few seconds: watch → coins → coin_verdict → preflight → trade_prepare (only after an allow)
 * → journal. Each call is kept in a ring (GET /agents/:id/activity) and pushed on the agents channel (kind `call`), as
 * the edge does. Display only: nothing is signed, sent or traded. Timers start lazily and never in tests.
 */
export const LIVE_DEMO_AGENT = 'scout';
const calls = new Map<string, AgentCall[]>();
/** Today's counts before this page load, so the mock agent reads as one that has been running since morning. */
const BASELINE: Record<string, AgentActivity['today']> = { scout: { calls: 1268, checks: 214, allowed: 171, denied: 38, needsApproval: 5, prepared: 44, notes: 61 } };
let seq = 0, step = 0, pick = 0;
const untrusted = (text: string) => ({ text, flags: [], truncated: false });
/** The Radar's scored coins, a Clear one between every two others, so the scout both buys and skips as a real one would. */
const scored = () => {
  const rows = createRadarRows().filter((r) => r.ekoScore && r.verdict !== 'pending');
  const ok = rows.filter((r) => r.verdict === 'clear'), rest = rows.filter((r) => r.verdict !== 'clear'), out: RadarRow[] = [];
  for (let i = 0; out.length < rows.length; i++) { if (ok[i]) out.push(ok[i]!); if (rest[2 * i]) out.push(rest[2 * i]!); if (rest[2 * i + 1]) out.push(rest[2 * i + 1]!); }
  return out;
};
const coinOf = (r: RadarRow): NonNullable<AgentCall['coin']> => ({ address: r.address, symbol: r.symbol, verdict: r.verdict,
  ...(r.ekoScore ? { score: r.ekoScore.value, band: r.ekoScore.band } : {}) });
function record(agentId: string, call: Omit<AgentCall, 'id' | 'agentId' | 'ts' | 'ok'> & { ok?: boolean }, ts = Date.now()) {
  const c = AgentCallSchema.parse({ ok: true, ...call, id: `demo-call-${++seq}`, agentId, ts: new Date(ts).toISOString() });
  calls.set(agentId, [c, ...(calls.get(agentId) ?? [])].slice(0, ACTIVITY_CAP));
  return c;
}
/** The scout's next call in its loop, about the coin it is looking at. */
function nextCall(agentId: string, ts = Date.now()) {
  const rows = scored(), row = rows[pick % rows.length]!, coin = coinOf(row), usd = [25, 40, 60, 80][pick % 4]!;
  const allowed = row.verdict === 'clear' && (row.ekoScore?.value ?? 0) >= 70 && row.exitCost1kPct <= 10;
  const reasons = allowed ? [`Clear, score ${row.ekoScore?.value}. A round trip costs ${row.exitCost1kPct.toFixed(1)}%.`]
    : row.verdict === 'danger' ? ['EKO rates this coin danger; the policy blocks danger and above.']
    : row.exitCost1kPct > 10 ? [`A round trip costs ${row.exitCost1kPct.toFixed(1)}%; the policy allows 10%.`]
    : [`EKO rates this coin ${row.verdict}; the scout only buys Clear coins scoring 70 or more.`];
  const s = step++ % 6;
  if (s === 5) pick++;
  switch (s) {
    case 0: return record(agentId, { tool: 'watch', ms: 1200 + (pick % 5) * 900, results: 1 + pick % 3, coin }, ts);
    case 1: return record(agentId, { tool: 'coins', ms: 38, results: 12 + pick % 7 }, ts);
    case 2: return record(agentId, { tool: 'coin_verdict', ms: 64, coin }, ts);
    case 3: return record(agentId, { tool: 'preflight', ms: 91, coin, preflight: { decision: allowed ? 'allow' : 'deny', side: 'buy', notionalUsd: usd, reasons } }, ts);
    case 4: return allowed
      ? record(agentId, { tool: 'trade_prepare', ms: 240, coin, trade: { status: 'ready', side: 'buy', amountUsd: usd, amountIn: String(Math.round(usd / 3150 * 1e6)) + '000000000000', minOut: String(Math.round(usd / Math.max(row.priceUsd, 1e-9) * 0.97)) + '000000000000000000' } }, ts)
      : record(agentId, { tool: 'coin_card', ms: 72, coin }, ts);
    default: return record(agentId, { tool: 'journal', ms: 22, coin, journal: { kind: 'note', text: untrusted(allowed
      ? `Prepared a $${usd} buy of $${row.symbol.text} (score ${row.ekoScore?.value}, Clear). Dry run: left unsigned.`
      : `Skipped $${row.symbol.text}: ${reasons[0]}`) } }, ts);
  }
}
/** The ring for one agent, seeded for the scout with its last couple of minutes so its page is never empty. */
function ring(agentId: string, now = Date.now()) {
  if (!calls.has(agentId) && agentId === LIVE_DEMO_AGENT) for (let i = 18; i >= 1; i--) nextCall(agentId, now - i * 7000 - 2000);
  return calls.get(agentId) ?? [];
}
/** GET /agents/:id/activity in mock mode: the ring, and today's counts (the baseline plus this page load's calls). */
export function demoActivity(agentId: string, since: string, now = Date.now()): AgentActivity {
  const list = ring(agentId, now), from = Date.parse(since) || now - 86_400_000;
  const today = list.filter((c) => Date.parse(c.ts) >= from).reduceRight(countCall, BASELINE[agentId] ? { ...BASELINE[agentId] } : emptyToday());
  return { calls: list, lastCallAt: list[0]?.ts ?? null, since: new Date(from).toISOString(), today };
}
/** One step of the live loop (tests drive it directly; mock mode runs it on a timer). */
export function tickDemoAgent(agentId = LIVE_DEMO_AGENT, now = Date.now()) {
  ring(agentId, now);
  const c = nextCall(agentId, now);
  emitMission('agents', 'call', c);
  return c;
}
let liveTimer: ReturnType<typeof setTimeout> | undefined;
const testing = () => import.meta.env.MODE === 'test';
/** Start the scout's loop once (mock mode in a browser only): a call every 3 to 5 seconds. */
export function startDemoAgent() {
  if (liveTimer !== undefined || testing() || typeof window === 'undefined') return;
  const go = () => { liveTimer = setTimeout(() => { tickDemoAgent(); go(); }, 3000 + (step % 3) * 1000); };
  go();
}
/** A new demo agent's first call, a few seconds after its key is created, so Connect's test sees it arrive. */
export function firstDemoCall(agentId: string, delayMs = 8000) {
  if (testing() || typeof window === 'undefined') return;
  setTimeout(() => {
    const rows = scored(), row = rows.find((r) => r.verdict === 'clear') ?? rows[0]!;
    emitMission('agents', 'call', record(agentId, { tool: 'coin_verdict', ms: 58, coin: coinOf(row) }));
  }, delayMs);
}
