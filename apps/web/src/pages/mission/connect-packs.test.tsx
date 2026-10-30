import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackSchema } from '@eko/shared';
import generated from '../../../../../harness-packs/generated/packs.json';
import { connectionReceived, fillPack, packAvailable } from '../../lib/mission';
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
  it('only confirms a persisted journal entry, never a successful auth or empty result; surfaces errors', async () => {
    const entry = createMissionDemo(1790852400000).journals.dca[0];
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ rows: [], cursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [entry], cursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'internal_error', message: 'Journal storage is unavailable' }), { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    expect(await connectionReceived('sample-agent')).toBe(false);
    expect(await connectionReceived('sample-agent')).toBe(true);
    await expect(connectionReceived('sample-agent')).rejects.toMatchObject({ status: 500 });
    expect(fetch.mock.calls.every(([path]) => path === '/v1/agents/sample-agent/journal?limit=1')).toBe(true);
  });
});
