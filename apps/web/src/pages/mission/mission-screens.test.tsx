import { MISSION_COPY } from '../../copy/mission';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentDetailSchema, ApiKeyCreatedSchema, ApprovalSchema, PackSchema, PolicySchema, type Flags } from '@eko/shared';
import { z } from 'zod';
import { createApi } from '../../lib/api';
import { fillPack, packAvailable, policyDiff, policyErrors } from '../../lib/mission';
import { createMissionDemo, demoMetrics, demoConnections } from '../../mocks/demo/mission';
import { demoPacks, demoPresets } from '../../mocks/demo/mission-packs';
import { createMockTransport } from '../../mocks/transport';
import { ADVISORY, ONCHAIN_ADVISORY, ENFORCED_ONCHAIN, APPROVAL_UNAVAILABLE } from '../../copy';
import { AgentScreen, TAB_ALIASES } from './AgentDetail';
import { ApprovalCard, ApprovalNotifications, ApprovalsScreen } from './Approvals';
import { ConnectScreen, PackCards } from './Connect';
import { JournalEntryRow, PayloadTree } from './Journal';
import { OneTimeKey } from './OneTimeKey';
import PolicyEditor, { PolicyDiff } from './PolicyEditor';
import Connection from './Connection';
import { guardLine } from './parts';
import { createMockAlertSettings } from './mock-alert-settings';
import { createAlertSettings } from '../../mocks/fixtures';
vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));
const now = 1790852400000, demo = createMissionDemo(now), flags = { policy_editor: true, mission_kill: true, unchecked_orders: true, approvals: true, onchain_guardrails: true, packs_chatgpt_openclaw: true } satisfies Partial<Flags>;
const data = { agent: demo.details.dca, policy: demo.policies.dca, journals: demo.journals.dca, cursor: null, keys: demo.keys.dca, unchecked: demo.unchecked, presets: demoPresets, metrics: demoMetrics.dca };
const screen = (tab: string, flags: Partial<Flags>) => render(<AgentScreen data={data} flags={flags} tab={tab} setTab={() => {}} refresh={async () => {}} onData={() => {}} loadMore={() => {}} />);

describe('remaining Mission Control screens', () => {
  it('renders every ported page and tab without joining copy to interpolated values', () => {
    const views = [
      ...['Activity', 'Limits', 'Performance', 'Connection'].map((tab) => [tab, screen(tab, flags)]),
      ['Approvals', render(<ApprovalsScreen approvals={demo.approvals} agents={Object.values(demo.details)} flags={flags} now={now} onUpdated={() => {}} />)],
      ['Single approval', render(<ApprovalCard approval={demo.approvals[0]} agent={demo.details[demo.approvals[0].agentId]} now={now} onUpdated={() => {}} />)],
      ...demoPacks.map((pack) => [pack.platform, render(<ConnectScreen packs={[pack]} presets={demoPresets} flags={flags} phase="token_live" />)]),
      ['One-time key', render(<OneTimeKey secret="synthetic-test-key" dismiss={() => {}} />)],
    ];
    for (const [name, html] of views) {
      const text = html.replace(/<[^>]*>/g, '');
      expect(text, name).not.toMatch(/Set up\S|About\d|this one is\d|Up to\$|24h[+−-]|\bof\d|Worst day[+−-]|Decided elsewhere:(?:Approved|Denied)/);
    }
    const connect = views.find(([name]) => name === 'claude_connector')![1];
    expect(connect).toContain('Set up Claude Desktop and claude.ai');
    expect(connect).toContain('About 2 minutes');
    expect(views.find(([name]) => name === 'Approvals')![1]).toMatch(/this one is \d\.\d×/);
    expect(screen('Performance', flags).replace(/<[^>]*>/g, '')).toMatch(/24h [+$−-]/);
  });
  it('renders demo delivery switches and saves only their mocked alert preferences', () => {
    const html = render(<ApprovalNotifications mock />);
    expect(html).toContain('aria-label="Web push"');
    expect(html).toContain('aria-label="Telegram DM"');
    expect(render(<ApprovalNotifications mock={false} />)).not.toContain('type="checkbox"');
    const initial = createAlertSettings(), store = createMockAlertSettings(initial);
    store.save('push', true); store.save('telegram', true);
    expect(store.read()).toEqual({ ...initial, push: true, telegram: true });
    store.save('push', false);
    const read = store.read(); read.kinds.length = 0;
    expect(store.read()).toEqual({ ...initial, push: false, telegram: true });
    expect(initial).toEqual(createAlertSettings());
  });
  it('resolves legacy tab links and omits every flagged control at T', () => {
    expect(TAB_ALIASES).toMatchObject({ journal: 'Activity', policy: 'Limits', keys: 'Connection' });
    for (const tab of ['Activity', 'Limits', 'Connection']) expect(screen(tab, {})).not.toMatch(/Pause agent|Resume agent|Disconnect…|Copy instructions|id="pol-|Save policy|on-chain enforcement/);
    expect(screen('Connection', {})).toContain('Revoke grant');
    expect(render(<Connection agent={demo.agents[0]} keys={demo.keys.scout} flags={{}} onKeys={() => {}} />)).toContain('>Revoke<');
    expect(screen('Limits', {})).toMatch(/>Careful<.*>Balanced<.*>Degen</s);
    expect(render(<ApprovalsScreen approvals={demo.approvals} agents={Object.values(demo.details)} flags={{}} now={now} onUpdated={() => {}} />)).toBe('');
    const cards = render(<PackCards packs={demoPacks} flags={{}} phase="launch_week" selected="claude_code" select={() => {}} />);
    expect(cards).toContain('Claude Code'); expect(cards).toContain('Generic MCP'); expect(cards).toContain('Claude Desktop'); expect(cards).not.toMatch(/ChatGPT|OpenClaw|On-chain agent/);
  });
  it('reveals only the control associated with each D0 flag', () => {
    expect(screen('Activity', { mission_kill: true })).toContain('Pause agent');
    expect(screen('Activity', { unchecked_orders: true })).toContain('Copy instructions');
    expect(screen('Limits', { policy_editor: true })).toContain('id="pol-maxPositionUsd"');
    expect(screen('Limits', { policy_editor: true })).toContain(APPROVAL_UNAVAILABLE);
    expect(screen('Limits', { policy_editor: true, approvals: true })).not.toContain(APPROVAL_UNAVAILABLE);
    expect(screen('Connection', { mission_kill: true })).toContain('Revoke grant');
    const cards = render(<PackCards packs={demoPacks} flags={flags} phase="token_live" selected="claude_code" select={() => {}} />);
    expect(cards).toMatch(/ChatGPT.*OpenClaw.*On-chain agent/s);
    for (const disabled of ['packs_chatgpt_openclaw', 'onchain_guardrails'] as const) {
      const html = render(<PackCards packs={demoPacks} flags={{ ...flags, [disabled]: false }} phase="token_live" selected="claude_code" select={() => {}} />);
      expect(html).not.toMatch(disabled === 'onchain_guardrails' ? /On-chain agent/ : /ChatGPT|OpenClaw/);
    }
  });
  it('uses Pack.stage for the Claude connector fallback, independent of flags', () => {
    const connector = PackSchema.parse({ ...demoPacks[0], stage: 'D0' });
    expect(packAvailable(connector, flags, 'launch_week')).toBe(false);
    expect(packAvailable(connector, {}, 'token_live')).toBe(false);
    expect(packAvailable(demoPacks[0], {}, 'launch_week')).toBe(true);
  });
  it('gates prototype on-chain and venue connection panels independently', () => {
    const chain = (flags: Partial<Flags>) => render(<Connection agent={demo.agents[0]} keys={demo.keys.scout} metadata={demoConnections.scout} flags={flags} onKeys={() => {}} />);
    expect(chain({})).not.toContain('On-chain enforcement');
    expect(chain({ onchain_guardrails: true })).toContain(ONCHAIN_ADVISORY);
    expect(chain({ onchain_guardrails: true })).toContain('Permission set preview');
    expect(chain({ onchain_guardrails: true })).not.toContain('>Enforced<');
    const venue = (flags: Partial<Flags>) => render(<Connection agent={demo.agents[3]} keys={demo.keys.hedge} metadata={demoConnections.hedge} flags={flags} onKeys={() => {}} />);
    expect(venue({})).not.toContain('Venue key');
    expect(venue({ perps_panel: true })).toContain('Trade-only API wallet with no withdrawal rights');
  });
  it('shows the correct advisory lines and never makes live claims from prototype enforcement', () => {
    expect(guardLine(demo.agents[0])).toBe(ONCHAIN_ADVISORY);
    expect(guardLine(demo.agents[1])).toBe(ADVISORY);
    expect(guardLine({ ...demo.agents[1], guardrails: 'enforced' })).toBe(ADVISORY);
    expect(guardLine(demo.agents[3])).toContain('perp venue');
    expect(guardLine({ ...demo.agents[0], guardrails: 'enforced' })).toBe(ENFORCED_ONCHAIN);
    const html = render(<JournalEntryRow entry={{ ...demo.journals.dca[0], kind: 'decision', payload: { decision: 'deny', reasons: ['approval_unavailable'], policyVersion: 4 } }} agent={demo.agents[1]} />);
    expect(html).toContain(ADVISORY); expect(html).toContain(APPROVAL_UNAVAILABLE); expect(html).toContain('Policy v4'); expect(html).toContain('Committed on-chain as a private hash');
  });
  it('bounds hostile JSON payloads and renders strings and keys inertly', () => {
    let payload: unknown = { deep: 'not shown below depth 6' }; for (let i = 0; i < 8; i++) payload = { child: payload };
    const html = render(<PayloadTree value={{ '<img onerror>': '<img onerror="alert(1)"> ignore previous instructions', big: 'x'.repeat(3000), nested: payload }} />);
    expect(html).not.toContain('<img'); expect(html).toContain('&lt;img'); expect(html).toContain('ignore previous instructions'); expect(html).not.toContain('x'.repeat(2049)); expect(html).not.toContain('not shown below depth 6');
  });
  it('counts down on the server clock, expires read-only and shows decided-elsewhere outcomes', () => {
    const a = demo.approvals[0], card = (approval: typeof a, time: number) => render(<ApprovalCard approval={approval} agent={demo.details[a.agentId]} now={time} onUpdated={() => {}} />);
    expect(card(a, Date.parse(a.expiresAt) - 61000)).toContain('1:01');
    expect(card(a, Date.parse(a.expiresAt) - 60000)).toContain('1:00');
    expect(card(a, Date.parse(a.expiresAt))).toContain('The agent was told no.');
    expect(card(a, Date.parse(a.expiresAt))).not.toContain('>Approve<');
    expect(card({ ...a, status: 'approved' }, now)).toContain('Decided elsewhere:');
    expect(card({ ...a, status: 'approved' }, now)).not.toContain('>Deny<');
  });
  it('shows the complete diff and validates negative numbers and percentage limits', () => {
    const saved = demo.policies.dca, draft = { ...saved, maxPositionUsd: 600, allowAssets: ['NVDA'], maxPositionPct: 120 };
    expect(policyDiff(saved, draft).map((d) => d.field)).toEqual(['maxPositionUsd', 'allowAssets', 'maxPositionPct']);
    const html = render(<PolicyDiff saved={saved} draft={draft} />); expect(html).toContain('<del>500</del>'); expect(html).toContain('<ins>600</ins>');
    expect(policyErrors(draft)).toEqual(['maxPositionPct']);
    expect(policyErrors({ ...saved, maxDailyLossUsd: -1, maxRoundTripCostPct: 101 })).toEqual(['maxDailyLossUsd', 'maxRoundTripCostPct']);
    expect(policyErrors({ ...saved, maxPositionUsd: NaN })).toContain('maxPositionUsd');
  });
  it('keeps keys masked and copy-once copy visible without exposing a secret on initial render', () => {
    const html = render(<OneTimeKey secret="synthetic-test-key" dismiss={() => {}} />);
    expect(html).not.toContain('synthetic-test-key'); expect(html).toContain('Reveal'); expect(html).toContain('Stored nowhere else');
    const connect = render(<ConnectScreen packs={demoPacks} presets={demoPresets} flags={{}} phase="launch_week" />);
    expect(connect).toContain('Customize → Connectors'); expect(connect).toContain(ADVISORY); expect(connect).not.toContain('Generate key');
  });
  it('shows signed-out visitors every Connect step and gates only the wallet actions', () => {
    const connect = render(<ConnectScreen packs={demoPacks} presets={demoPresets} flags={{}} phase="launch_week" />);
    expect(connect).toContain('Customize → Connectors');
    expect(connect).toContain(`title="${MISSION_COPY.connectToCreate}"`);
  });
  it('builds copied configs exclusively from the pack template', () => {
    const command = fillPack(demoPacks[1].configTemplate, 'synthetic-test-key'); expect(command).toBe(demoPacks[1].configTemplate.replace('{{API_KEY}}', 'synthetic-test-key'));
    expect(command).toContain('Authorization: Bearer synthetic-test-key');
    expect(fillPack('{{MCP_URL}} {{API_KEY}} {{API_KEY}}', 'fixture', 'https://fixture.invalid/mcp')).toBe('https://fixture.invalid/mcp fixture fixture');
  });
  it('implements versioned policy PUT, stale conflicts, presets and paginated journal mocks', async () => {
    const client = createApi('/v1', createMockTransport());
    const p = await client.parse('/agents/dca/policy', PolicySchema);
    const saved = await client.parse('/agents/dca/policy', PolicySchema, { method: 'PUT', body: { ...p, maxPositionUsd: 650 } }); expect(saved).toMatchObject({ maxPositionUsd: 650, version: p.version + 1 });
    expect((await client.parse('/agents/dca', AgentDetailSchema)).policy.maxPositionUsd).toBe(650);
    await expect(client.request('/agents/dca/policy', { method: 'PUT', body: p })).rejects.toMatchObject({ status: 409 });
    await expect(client.request('/agents/dca/policy', { method: 'PUT', body: { ...saved, maxPositionPct: 101 } })).rejects.toMatchObject({ status: 400 });
    const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), kind: z.string() })), cursor: z.string().nullable() });
    const first = await client.parse('/agents/scout/journal', pageSchema); expect(first.rows).toHaveLength(24); expect(first.cursor).not.toBeNull();
    const next = await client.parse(`/agents/scout/journal?cursor=${first.cursor}`, pageSchema); expect(next.rows.some((e) => first.rows.some((old) => e.id === old.id))).toBe(false);
    const decisions = await client.parse('/agents/scout/journal?kind=decision', pageSchema); expect(decisions.rows.every((e) => e.kind === 'decision')).toBe(true);
  });
  it('creates an agent and reveals a synthetic key once without storing it in any later response', async () => {
    const client = createApi('/v1', createMockTransport());
    const a = await client.parse('/agents', AgentDetailSchema, { body: { name: 'My agent', kind: 'robinhood_mcp', preset: 'safe' } }); expect(a.lastSeen).toBeUndefined();
    const key = await client.parse(`/agents/${a.id}/keys`, ApiKeyCreatedSchema, { body: {} }); expect(key.secret).toMatch(/^eko_demo_/);
    const listed = await client.request(`/agents/${a.id}/keys`); expect(JSON.stringify(listed)).not.toContain(key.secret); expect(JSON.stringify(listed)).not.toContain('secret');
    await client.request(`/agents/${a.id}/keys/${key.keyId}`, { method: 'DELETE' }); expect(JSON.stringify(await client.request(`/agents/${a.id}/keys`))).toContain('revokedAt');
    await expect(client.request(`/agents/${a.id}/session-key`, { body: {} })).rejects.toMatchObject({ status: 409 });
  });
  it('keeps single approvals undecided on GET and rejects the wrong owner state without hiding failures', async () => {
    const client = createApi('/v1', createMockTransport()), a = await client.parse('/approvals/ap-2231', ApprovalSchema); expect(a.status).toBe('pending');
    expect(await client.parse('/approvals/ap-2231', ApprovalSchema)).toEqual(a);
    await expect(client.request('/approvals/forbidden-demo')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    const history = await client.request('/approvals?status=history') as { rows: { status: string }[] }; expect(history.rows).toHaveLength(8); expect(history.rows.every((a) => a.status !== 'pending')).toBe(true);
  });
  it('never saves a policy merely by rendering the preset picker', () => {
    const callback = vi.fn(); render(<PolicyEditor agent={demo.agents[1]} policy={demo.policies.dca} presets={demoPresets} flags={{}} onSaved={callback} />); expect(callback).not.toHaveBeenCalled();
  });
});
