import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackSchema } from '@eko/shared';
import generated from '../../../../../harness-packs/generated/packs.json';
import { checkConnection, connectionReceived, fillPack, KEY_MASK, mcpUrlOf, packAvailable, pasteReady } from '../../lib/mission';
import { demoPresets } from '../../mocks/demo/mission-packs';
import { ConnectScreen, PackCards } from './Connect';
import { createMissionDemo } from '../../mocks/demo/mission';
const packs = generated.map(p => PackSchema.parse(p));
afterEach(() => vi.unstubAllGlobals());
describe('096 Connect with generated launch packs', () => {
  it('renders real pack config/instructions, key issuance and pending connector stage', () => {
    const html = render(<ConnectScreen packs={packs} presets={demoPresets} flags={{}} phase="launch_week" />);
    expect(html).toContain('Generate key'); expect(html).toContain('MCP config');
    expect(html).toContain('approval_unavailable'); expect(html).toContain('session_start');
    expect(html).toContain('trade approvals are on'); expect(html).not.toContain('Customize → Connectors');
    // The pack's own setup lines are shown, including where Claude Code's command goes.
    expect(html).toContain('Run this command in your project folder'); expect(html).toContain('run /mcp');
    const cards = render(<PackCards packs={packs} flags={{}} phase="launch_week" selected="claude_code" select={() => {}} />);
    expect(cards).toContain('Claude Code'); expect(cards).toContain('Generic MCP');
    // Claude Desktop ships through its local config at T; the OAuth connector card stays hidden.
    expect(cards).toContain('Claude Desktop'); expect(cards).not.toContain('Claude Desktop and claude.ai');
    const connector = packs.find(p => p.platform === 'claude_connector')!;
    expect(packAvailable(connector, {}, 'launch_week')).toBe(false);
    expect(packAvailable(connector, {}, 'token_live')).toBe(false);
    expect(packAvailable(connector, {}, 'tiers')).toBe(false);
    const fill = (platform: string) => fillPack(packs.find(p => p.platform === platform)!.configTemplate, 'synthetic-test-key', 'https://fixture.invalid/mcp');
    expect(fill('claude_code')).toBe('claude mcp add --transport http eko https://fixture.invalid/mcp --header "Authorization: Bearer synthetic-test-key"');
    expect(JSON.parse(fill('claude_desktop')).mcpServers.eko).toMatchObject({ command: 'npx',
      args: ['-y', 'mcp-remote', 'https://fixture.invalid/mcp', '--header', 'Authorization:${EKO_AUTH_HEADER}'], env: { EKO_AUTH_HEADER: 'Bearer synthetic-test-key' } });
    expect(JSON.parse(fill('generic_mcp')).mcpServers.eko).toMatchObject({ url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer synthetic-test-key' } });
    const desktop = render(<ConnectScreen packs={packs.filter(p => p.platform === 'claude_desktop')} presets={demoPresets} flags={{}} phase="launch_week" />);
    expect(desktop).toContain('Settings, Developer, Edit Config'); expect(desktop).toContain('Node.js 18');
  });
  it('confirms only a call made with the key (or, without the activity route, a persisted journal entry); surfaces errors', async () => {
    const entry = createMissionDemo(1790852400000).journals.dca[0];
    const today = { calls: 0, checks: 0, allowed: 0, denied: 0, needsApproval: 0, prepared: 0, notes: 0 }, since = '2026-11-27T00:00:00.000Z';
    const call = { id: 'c1', agentId: 'sample-agent', ts: '2026-11-27T12:00:00.000Z', tool: 'coin_verdict', ok: true };
    const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const fetch = vi.fn().mockResolvedValueOnce(res({ calls: [], lastCallAt: null, since, today }))
      .mockResolvedValueOnce(res({ calls: [call], lastCallAt: call.ts, since, today: { ...today, calls: 1 } }))
      .mockResolvedValueOnce(res({ error: 'not_found', message: 'Not available.' }, 404)).mockResolvedValueOnce(res({ rows: [], cursor: null }))
      .mockResolvedValueOnce(res({ error: 'not_found', message: 'Not available.' }, 404)).mockResolvedValueOnce(res({ rows: [entry], cursor: null }))
      .mockResolvedValueOnce(res({ error: 'internal_error', message: 'Activity is unavailable' }, 500));
    vi.stubGlobal('fetch', fetch);
    // One agent per case: reads of one resource are spaced seconds apart (requestControl), which is not under test here.
    expect(await connectionReceived('sample-a')).toBe(false);
    expect(await checkConnection('sample-b')).toMatchObject({ received: true, call: { tool: 'coin_verdict' } });
    expect(await connectionReceived('sample-c')).toBe(false);
    expect(await connectionReceived('sample-d')).toBe(true);
    await expect(connectionReceived('sample-e')).rejects.toMatchObject({ status: 500 });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/v1/agents/sample-a/activity', '/v1/agents/sample-b/activity', '/v1/agents/sample-c/activity',
      '/v1/agents/sample-c/journal?limit=1', '/v1/agents/sample-d/activity', '/v1/agents/sample-d/journal?limit=1', '/v1/agents/sample-e/activity']);
  });
  it('builds paste-ready setups with the key only in what is copied', () => {
    const url = mcpUrlOf(packs, 'https://fixture.invalid/mcp');
    expect(url).toMatch(/^https:\/\/.+\/mcp$/);
    const shown = pasteReady('https://fixture.invalid/mcp', KEY_MASK), real = pasteReady('https://fixture.invalid/mcp', 'eko_your_key_here');
    expect(real.claudeCode).toBe('claude mcp add --transport http eko https://fixture.invalid/mcp --header "Authorization: Bearer eko_your_key_here"');
    expect(JSON.parse(real.json)).toEqual({ mcpServers: { eko: { url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer eko_your_key_here' } } } });
    expect(real.curl).toContain('-H "Authorization: Bearer eko_your_key_here"'); expect(real.curl).toContain('"name":"coins"');
    expect(real.starter).toBe('EKO_KEY=eko_your_key_here EKO_MCP_URL=https://fixture.invalid/mcp npx tsx examples/agent-starter/agent.ts');
    expect(Object.values(shown).join('\n')).not.toContain('eko_your_key_here');
    const html = render(<ConnectScreen packs={packs} presets={demoPresets} flags={{}} phase="launch_week" />);
    expect(html).toContain('Paste-ready setup'); expect(html).toContain('Cursor and other MCP clients'); expect(html).toContain('Plain HTTP (curl)');
    for (const tool of ['coins', 'watch', 'new_launches', 'deployer_history', 'trade_prepare']) expect(html).toContain(`<code>${tool}</code>`);
  });
});
