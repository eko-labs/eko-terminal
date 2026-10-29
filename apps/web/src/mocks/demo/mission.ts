import { AgentSchema, AgentDetailSchema, ApprovalSchema, JournalEntrySchema, PolicySchema, UncheckedOrderSchema, ApiKeyInfoSchema } from '@eko/shared';
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
type DemoEvent = { ch: 'agents'; kind: 'agent'; data: import('@eko/shared').Agent } | { ch: 'agents'; kind: 'journal'; data: import('@eko/shared').JournalEntry } | { ch: 'approvals'; kind: 'approval'; data: import('@eko/shared').Approval };
const listeners = new Set<(event: DemoEvent) => void>();
export function onMissionEvent(listener: (event: DemoEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function emitMission(ch: DemoEvent['ch'], kind: DemoEvent['kind'], data: DemoEvent['data']) {
  const event = { ch, kind, data: structuredClone(data) } as DemoEvent;
  listeners.forEach((listener) => listener(event));
}
