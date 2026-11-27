import { z } from 'zod';
import { AgentActivitySchema, AgentSchema, AgentDetailSchema, ApprovalSchema, JournalEntrySchema, PolicySchema, UncheckedOrderSchema, ApiKeyInfoSchema, PackSchema, ApiKeyCreatedSchema } from '@eko/shared';
import type { Flags, Agent, AgentCall, Pack } from '@eko/shared';
import { ApiError, fetchParsed, api } from './api';

export const AgentsResponse = z.object({ agents: z.array(AgentSchema) });
export const ApprovalsResponse = z.object({ rows: z.array(ApprovalSchema) });
export const JournalResponse = z.object({ rows: z.array(JournalEntrySchema), cursor: z.string().nullable().optional() });
export const UncheckedResponse = z.object({ rows: z.array(UncheckedOrderSchema) });
export const KeysResponse = z.object({ keys: z.array(ApiKeyInfoSchema) });
export async function loadMission(flags: Partial<Flags>, signal?: AbortSignal) {
  const { agents } = await fetchParsed('/agents', AgentsResponse, { signal });
  const [details, journals, approvals, unchecked] = await Promise.all([
    Promise.all(agents.map((a) => fetchParsed(`/agents/${encodeURIComponent(a.id)}`, AgentDetailSchema, { signal }))),
    Promise.all(agents.map((a) => loadJournal(a.id, undefined, undefined, signal))),
    flags.approvals ? fetchParsed('/approvals?status=pending', ApprovalsResponse, { signal }) : Promise.resolve({ rows: [] }),
    flags.unchecked_orders ? Promise.all(agents.map((a) => fetchParsed(`/agents/${encodeURIComponent(a.id)}/unchecked-orders`, UncheckedResponse, { signal }))) : Promise.resolve([]),
  ]);
  const listedAgents: Agent[] = agents.map((a, i) => ({ ...a, guardrails: details[i].guardrails }));
  return { agents: listedAgents, details: Object.fromEntries(details.map((a) => [a.id, a])),
    journals: Object.fromEntries(agents.map((a, i) => [a.id, journals[i].rows])), approvals: approvals.rows,
    unchecked: unchecked.flatMap((page) => page.rows),
    unavailableJournals: agents.filter((_, i) => journals[i].unavailable).map(a => a.id) };
}
export type MissionSnapshot = Omit<Awaited<ReturnType<typeof loadMission>>, 'unavailableJournals'> & { unavailableJournals?: string[] };
export const emptyMission: MissionSnapshot = { agents: [], details: {}, journals: {}, approvals: [], unchecked: [] };
export type MissionAction = { kind: 'pause' | 'resume' | 'disconnect'; agent: Agent } | { kind: 'stop-all' };
export async function mutateMission(action: MissionAction) {
  if (action.kind === 'stop-all') return api('/agents/kill-all', { body: { mode: 'soft' } });
  const path = `/agents/${encodeURIComponent(action.agent.id)}`;
  return action.kind === 'resume' ? fetchParsed(path, AgentSchema, { method: 'PATCH', body: { status: 'active' } })
    : api(`${path}/kill`, { body: { mode: action.kind === 'pause' ? 'soft' : 'hard' } });
}
export async function decideApproval(id: string, decision: 'approved' | 'denied', idempotencyKey: string) {
  return fetchParsed(`/approvals/${encodeURIComponent(id)}`, ApprovalSchema, { body: { decision, idempotencyKey } });
}
export const loadPolicy = (id: string, signal?: AbortSignal) => fetchParsed(`/agents/${encodeURIComponent(id)}/policy`, PolicySchema, { signal });
export const loadKeys = (id: string, signal?: AbortSignal) => fetchParsed(`/agents/${encodeURIComponent(id)}/keys`, KeysResponse, { signal });
export const loadPacks = (signal?: AbortSignal) => fetchParsed('/packs', z.array(PackSchema), { signal });
// TODO(spec): /policy-presets has no frozen response envelope. Use the smallest
// reading: an array of named Policy presets, like the frozen /packs array.
export const PresetsResponse = z.array(z.object({ name: z.enum(['Safe', 'Balanced', 'Degen']), policy: PolicySchema }));
export const loadPresets = (signal?: AbortSignal) => fetchParsed('/policy-presets', PresetsResponse, { signal });
export const createAgent = (name: string, kind: Agent['kind'], preset: string) => fetchParsed('/agents', AgentDetailSchema, { body: { name, kind, preset } });
export const createKey = (id: string) => fetchParsed(`/agents/${encodeURIComponent(id)}/keys`, ApiKeyCreatedSchema, { body: {} });
export const savePolicy = (id: string, policy: import('@eko/shared').Policy) => fetchParsed(`/agents/${encodeURIComponent(id)}/policy`, PolicySchema, { method: 'PUT', body: policy });
export const loadJournal = async (id: string, cursor?: string, kind?: string, signal?: AbortSignal) => {
  const query = new URLSearchParams(); if (cursor) query.set('cursor', cursor); if (kind) query.set('kind', kind);
  try { return { ...await fetchParsed(`/agents/${encodeURIComponent(id)}/journal?${query}`, JournalResponse, { signal }), unavailable: false }; }
  catch (error) {
    // Packet 092 owns journal storage. Keep Mission usable while that route is absent,
    // and expose its absence instead of claiming there were no checks.
    if (error instanceof ApiError && error.status === 404) return { rows: [], cursor: null, unavailable: true };
    throw error;
  }
};
export function policyDiff(saved: import('@eko/shared').Policy, draft: import('@eko/shared').Policy) {
  return (Object.keys(draft) as (keyof typeof draft)[]).filter((k) => k !== 'version' && JSON.stringify(saved[k]) !== JSON.stringify(draft[k]))
    .map((field) => ({ field, before: saved[field], after: draft[field] }));
}
export function policyErrors(policy: import('@eko/shared').Policy) {
  return Object.entries(policy).filter(([key, value]) => typeof value === 'number' && (!Number.isFinite(value) || value < 0 || (key.endsWith('Pct') && value > 100)))
    .map(([key]) => key);
}
export function packAvailable(pack: import('@eko/shared').Pack, flags: Partial<Flags>, phase: 'launch_week' | 'token_live' | 'tiers') {
  // OAuth connector metadata stays pending until 099 promotes the accepted pack.
  if (pack.platform === 'claude_connector' && pack.stage === 'D0') return false;
  if (pack.stage === 'D0' && phase === 'launch_week') return false;
  return !['chatgpt', 'openclaw'].includes(pack.platform) || !!flags.packs_chatgpt_openclaw;
}
export function fillPack(template: string, key: string, mcpUrl = import.meta.env.VITE_MCP_URL ?? '') {
  return template.replaceAll('{{API_KEY}}', key).replaceAll('{{MCP_URL}}', mcpUrl || '{{MCP_URL}}');
}

/**
 * The agent's MCP calls (GET /agents/:id/activity): the newest first and the counts since `since` (the viewer's local
 * midnight). Every call made with the agent's key counts, read tools included, and each new one is also pushed on the
 * owner's `agents` channel (kind `call`).
 */
export const loadActivity = (id: string, since: string, signal?: AbortSignal) =>
  fetchParsed(`/agents/${encodeURIComponent(id)}/activity?since=${encodeURIComponent(since)}`, AgentActivitySchema, { signal });

/**
 * Whether the agent has reached EKO yet: any MCP call made with its key (its activity), and the earliest one listed.
 * An edge without the activity route (404) falls back to the persisted owner-only journal, as before. An empty answer
 * is not a check-in, and neither is signing in.
 */
export async function checkConnection(id: string, signal?: AbortSignal): Promise<{ received: boolean; call?: AgentCall }> {
  try {
    const a = await fetchParsed(`/agents/${encodeURIComponent(id)}/activity`, AgentActivitySchema, { signal });
    const call = a.calls.at(-1);
    return call ? { received: true, call } : { received: false };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  const page = await fetchParsed(`/agents/${encodeURIComponent(id)}/journal?limit=1`, JournalResponse, { signal });
  return { received: page.rows.length > 0 };
}
export async function connectionReceived(id: string, signal?: AbortSignal) {
  return (await checkConnection(id, signal)).received;
}

/** The MCP server's URL as the packs carry it (the first http(s) URL ending in /mcp in a template), else VITE_MCP_URL. */
export function mcpUrlOf(packs: readonly Pack[], fallback: string = import.meta.env.VITE_MCP_URL ?? ''): string {
  for (const p of packs) { const m = /https?:\/\/[^\s"'<>]+\/mcp\b/.exec(p.configTemplate); if (m) return m[0]; }
  return fallback || 'https://ekoterminal.com/mcp';
}
/** The key on screen: never the real one, only its shape. */
export const KEY_MASK = 'eko_••••••••••••••••';
/**
 * Ready-to-paste setups for one key: Claude Code's command (the claude_code pack's own syntax), the JSON an MCP client
 * with remote servers takes (Cursor and others: url plus headers), a plain curl call, and the starter agent. `key` is
 * the real key only when copying; on screen it is KEY_MASK.
 */
export function pasteReady(url: string, key: string) {
  const json = JSON.stringify({ mcpServers: { eko: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'coins', arguments: { sort: 'hottest', limit: 5 } } });
  return {
    claudeCode: `claude mcp add --transport http eko ${url} --header "Authorization: Bearer ${key}"`,
    json,
    curl: [`curl -s ${url} \\`, '  -H "Content-Type: application/json" \\', '  -H "Accept: application/json, text/event-stream" \\', `  -H "Authorization: Bearer ${key}" \\`, `  -d '${body}'`].join('\n'),
    starter: `EKO_KEY=${key} EKO_MCP_URL=${url} npx tsx examples/agent-starter/agent.ts`,
  };
}
