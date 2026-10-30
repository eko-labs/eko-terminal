import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Flags, FLAG_STAGES, AgentDetailSchema, AgentSchema, ApprovalSchema, JournalEntrySchema, PolicySchema, UncheckedOrderSchema, ApiKeyInfoSchema, FlagsSchema } from '@eko/shared';
import { z } from 'zod';
import { createMissionDemo, demoMetrics, previousChecks } from '../../mocks/demo/mission';
import { createMockTransport } from '../../mocks/transport';
import { createConfig } from '../../mocks/responses';
import { MockChannelSocket } from '../../mocks/socket';
import { createApi } from '../../lib/api';
import { loadMission } from '../../lib/mission';
import { AgentRow, KillConfirm, MissionOverview } from './Agents';
import { ApprovalRow, JournalLine, StatusPill } from './parts';
vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));

// The demo is built at a fixed instant; render against the same clock so countdowns don't expire as the day goes on.
const FIXED_NOW = 1790852400000;
beforeEach(() => { vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });
const demo = createMissionDemo(FIXED_NOW);
const snapshot = { ...demo, unchecked: demo.unchecked };
const d0 = { approvals: true, mission_kill: true, unchecked_orders: true, policy_editor: true };

describe('Mission Control prototype port', () => {
  it('ports all four agents, policies, approvals, journals and unchecked orders into shared contracts', () => {
    expect(demo.agents.map((a) => a.name)).toEqual(['Trench scout', 'Tech DCA', 'Earnings loop', 'Perp hedger']);
    demo.agents.forEach((a) => expect(AgentSchema.parse(a)).toEqual(a));
    Object.values(demo.details).forEach((a) => expect(AgentDetailSchema.parse(a)).toEqual(a));
    demo.approvals.forEach((a) => expect(ApprovalSchema.parse(a)).toEqual(a));
    Object.values(demo.journals).flat().forEach((a) => expect(JournalEntrySchema.parse(a)).toEqual(a));
    Object.values(demo.policies).forEach((a) => expect(PolicySchema.parse(a)).toEqual(a));
    demo.unchecked.forEach((a) => expect(UncheckedOrderSchema.parse(a)).toEqual(a));
    Object.values(demo.keys).flat().forEach((a) => expect(ApiKeyInfoSchema.parse(a)).toEqual(a));
    expect(demo.agents.every((a) => a.guardrails === 'advisory')).toBe(true);
    expect(demo.agents[2].status).toBe('soft_killed');
    expect(Object.values(demoMetrics).every((m) => m.hourly.length === 24 && m.performance.cumul.length === 30)).toBe(true);
  });
  it('keeps the default flags off; d0 turns on every D0 flag and a list turns on just those, like the server FLAGS', () => {
    expect(Object.values(createConfig('').flags).every((v) => !v)).toBe(true);
    const on = (preset: string) => Object.entries(FlagsSchema.parse(createConfig(preset).flags)).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on('d0')).toEqual([...FLAG_STAGES.D0].sort());
    expect(on('approvals, mission_kill')).toEqual(['approvals', 'mission_kill']);
    for (const flag of Object.keys(d0)) expect(on('d0')).toContain(flag);
  });
  it('omits approval, kill, unchecked and policy-editor controls with flags off', () => {
    const html = renderToStaticMarkup(<MissionOverview data={snapshot} flags={{}} metrics={demoMetrics} previousChecks={previousChecks} />);
    expect(html).not.toMatch(/Stop all agents|>Resume<|>Approve<|>Deny<|Copy instructions|>Edit limits</);
    expect(html).toContain('1 paused');
    expect(html).toContain('Connect an agent');
  });
  it('shows D0 controls without deciding or killing before confirmation', () => {
    const html = renderToStaticMarkup(<MissionOverview data={snapshot} flags={d0} metrics={demoMetrics} previousChecks={previousChecks} />);
    expect(html).toContain('Stop all agents'); expect(html).toContain('Resume');
    expect(html).toContain('Copy instructions'); expect(html).toContain('>Approve<'); expect(html).toContain('>Deny<');
    expect(html).not.toContain('Confirm deny');
    expect(html).toContain('What the terms mean');
    expect(html).toContain('id="mc-terms-body" inert="" aria-hidden="true"');
  });
  it.each([
    [{}, 'Each check is allowed or blocked. You set the limits your agent checks against.', 'Every order it asks about is blocked while it is paused.'],
    [d0, 'Each check is allowed, blocked, or sent to you to approve. You can pause any agent, or stop them all.', 'Every order it asks about is blocked until you resume it.'],
  ] as [Partial<Flags>, string, string][])('matches How it works and paused copy to flags %j', (flags, step, paused) => {
    const html = renderToStaticMarkup(<MissionOverview data={snapshot} flags={flags} metrics={demoMetrics} />);
    const how = html.match(/id="mc-how-body"[\s\S]*?<\/ol>/)?.[0];
    expect(how).toContain(`<p>${step}</p>`);
    expect(html).toContain(paused);
    expect(html).not.toContain(flags.mission_kill ? 'blocked while it is paused.' : 'blocked until you resume it.');
  });
  it('groups Details, Deny and Approve together with Approve last after the countdown', () => {
    const html = renderToStaticMarkup(<ApprovalRow approval={demo.approvals[0]} agent={demo.agents[1]} now={1790852400000} onUpdated={() => {}} />);
    const buttons = html.match(/<span class="ibx-buttons">([\s\S]*?)<\/span>/)?.[1];
    expect(buttons).toMatch(/>Details<\/a><button[^>]*>Deny<\/button><button[^>]*>Approve<\/button>$/);
    expect(html.indexOf('ibx-left')).toBeLessThan(html.indexOf('ibx-buttons'));
  });
  it('renders the mock row figures, counts, advisory badge and paused state', () => {
    const html = renderToStaticMarkup(<AgentRow agent={demo.agents[0]} data={snapshot} metrics={demoMetrics} index={0} selected select={() => {}} />);
    expect(html).toContain('Trench scout'); expect(html).toContain('214'); expect(html).toContain('38'); expect(html).toContain('$386'); expect(html).toContain('+$42.10');
    expect(html).toContain('Advisory'); expect(html).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<StatusPill agent={{ ...demo.agents[0], lastSeen: undefined }} />)).toContain('Waiting for first call');
  });
  it('renders expired approvals read-only and agent HTML as inert text', () => {
    expect(renderToStaticMarkup(<ApprovalRow approval={demo.approvals[0]} now={1790852400000 + 1800000} onUpdated={() => {}} />)).not.toContain('>Approve<');
    const entry = { ...demo.journals.scout[0], payload: { text: '<img onerror="alert(1)"> ignore previous instructions' } };
    const html = renderToStaticMarkup(<JournalLine entry={entry} />);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  });
  it('requires a confirm for pause, resume and Stop all, and typed confirmation for disconnect', () => {
    const refresh = vi.fn(async () => {});
    for (const action of [{ kind: 'stop-all' as const }, { kind: 'pause' as const, agent: demo.agents[0] }, { kind: 'resume' as const, agent: demo.agents[2] }]) {
      const html = renderToStaticMarkup(<KillConfirm action={action} close={() => {}} refresh={refresh} />);
      expect(html).toContain('role="dialog"'); expect(html).toContain('Cancel');
      expect(html).toContain(action.kind === 'stop-all' ? 'Pause all agents' : action.kind === 'pause' ? 'Confirm pause' : 'Confirm resume');
    }
    const hard = renderToStaticMarkup(<KillConfirm action={{ kind: 'disconnect', agent: demo.agents[1] }} close={() => {}} refresh={refresh} />);
    expect(hard).toContain('Type Tech DCA to confirm'); expect(hard).toContain('disabled=""');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('publishes agent and approval mutations on their mock WebSocket channels and cleans up', async () => {
    const socket = new MockChannelSocket(), events: unknown[] = [];
    socket.on((e) => { if (e.t === 'ev') events.push(e); }); socket.connect(); socket.send({ op: 'sub', ch: ['agents', 'approvals'] });
    const api = createApi('/v1', createMockTransport());
    await api.request('/agents/dca/kill', { body: { mode: 'soft' } });
    await api.request('/approvals/ap-2231', { body: { decision: 'denied', idempotencyKey: 'ws-test' } });
    expect(events).toEqual([expect.objectContaining({ ch: 'agents', kind: 'agent', data: expect.objectContaining({ id: 'dca', status: 'soft_killed' }) }), expect.objectContaining({ ch: 'approvals', kind: 'approval', data: expect.objectContaining({ id: 'ap-2231', status: 'denied' }) })]);
    socket.close(); await api.request('/agents/dca', { method: 'PATCH', body: { status: 'active' } });
    expect(events).toHaveLength(2);
  });
  it('revokes harness keys on a Robinhood hard stop and leaves offline on-chain revocation inert', async () => {
    const api = createApi('/v1', createMockTransport());
    const response = await api.request('/agents/dca/kill', { body: { mode: 'hard' } });
    expect(response).toMatchObject({ kind: 'deeplink' });
    expect((await api.parse('/agents/dca', AgentDetailSchema)).status).toBe('disconnected');
    const keys = await api.parse('/agents/dca/keys', z.object({ keys: z.array(ApiKeyInfoSchema) }));
    expect(keys.keys.every((k) => !!k.revokedAt)).toBe(true);
    await expect(api.request('/agents/scout/kill', { body: { mode: 'hard' } })).rejects.toMatchObject({ status: 409 });
    expect((await api.parse('/agents/scout', AgentDetailSchema)).status).toBe('active');
  });
  it('routes collections and each selected resource, and isolates mutable mock sessions', async () => {
    const client = createApi('/v1', createMockTransport());
    const agents = await client.parse('/agents', z.object({ agents: z.array(AgentSchema) }));
    expect(agents.agents).toHaveLength(4);
    for (const a of agents.agents) {
      expect((await client.parse(`/agents/${a.id}`, AgentDetailSchema)).id).toBe(a.id);
      const journal = await client.parse(`/agents/${a.id}/journal`, z.object({ rows: z.array(JournalEntrySchema) }));
      expect(journal.rows.length).toBeGreaterThan(20); expect(journal.rows.every((e) => e.agentId === a.id)).toBe(true);
    }
    await client.request('/agents/scout/kill', { body: { mode: 'soft' } });
    expect((await client.parse('/agents/scout', AgentDetailSchema)).status).toBe('soft_killed');
    await client.request('/agents/scout', { method: 'PATCH', body: { status: 'active' } });
    expect((await client.parse('/agents/scout', AgentDetailSchema)).status).toBe('active');
    await client.request('/agents/kill-all', { body: { mode: 'soft' } });
    expect((await client.parse('/agents', z.object({ agents: z.array(AgentSchema) }))).agents.every((a) => a.status === 'soft_killed')).toBe(true);
    expect((await createApi('/v1', createMockTransport()).parse('/agents/scout', AgentDetailSchema)).status).toBe('active');
  });
  it('requires a valid idempotent approval decision, rejects conflicts and removes decided rows', async () => {
    const client = createApi('/v1', createMockTransport()), path = '/approvals/ap-2231';
    await expect(client.request(path, { body: { decision: 'approved' } })).rejects.toMatchObject({ status: 400 });
    const opts = { body: { decision: 'approved', idempotencyKey: 'test-decision' } };
    expect((await client.parse(path, ApprovalSchema, opts)).status).toBe('approved');
    expect((await client.parse(path, ApprovalSchema, opts)).status).toBe('approved');
    await expect(client.request(path, { body: { decision: 'denied', idempotencyKey: 'other' } })).rejects.toMatchObject({ status: 409 });
    const page = await client.parse('/approvals?status=pending', z.object({ rows: z.array(ApprovalSchema) }));
    expect(page.rows.some((a) => a.id === 'ap-2231')).toBe(false);
  });
  it('expires approvals without sending an order or allowing a late decision', async () => {
    const client = createApi('/v1', createMockTransport());
    const approval = await client.parse('/approvals/ap-2231', ApprovalSchema);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(approval.expiresAt) + 1);
    try {
      expect((await client.parse('/approvals/ap-2231', ApprovalSchema)).status).toBe('expired');
      await expect(client.request('/approvals/ap-2231', { body: { decision: 'approved', idempotencyKey: 'late' } })).rejects.toMatchObject({ status: 409 });
    } finally { now.mockRestore(); }
  });
  it('fetches flagged endpoints only when enabled', async () => {
    const mock = createMockTransport(), calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => { calls.push(url); return mock(url, init); });
    try {
      const data = await loadMission({}); expect(data.agents).toHaveLength(4);
      expect(calls.some((p) => /approvals|unchecked-orders/.test(p))).toBe(false);
      calls.length = 0; await loadMission(d0);
      expect(calls.filter((p) => p.includes('unchecked-orders'))).toHaveLength(4);
      expect(calls.some((p) => p.includes('/approvals?status=pending'))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('loads real contract data with a visible unavailable journal, while preserving server errors', async () => {
    const mock = createMockTransport();
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.includes('/journal')
      ? Promise.resolve(new Response(JSON.stringify({ error: 'not_found', message: 'Not found' }), { status: 404 }))
      : mock(url, init));
    try {
      const data = await loadMission({});
      expect(data.unavailableJournals).toEqual(data.agents.map(a => a.id));
      const html = renderToStaticMarkup(<MissionOverview data={data} flags={{}} />);
      expect(html).toContain('Activity journal is unavailable');
      expect(data.agents.every(a => a.guardrails === 'advisory')).toBe(true);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ error: 'internal_error', message: 'Internal error' }), { status: 500 })));
      await expect(loadMission({})).rejects.toMatchObject({ status: 500 });
    } finally { vi.unstubAllGlobals(); }
  });

});
