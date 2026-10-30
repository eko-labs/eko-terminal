import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OAuthConsentSchema, OAuthRequestSchema } from '@eko/shared';
import { resolveRoute } from '../routes';
import { ConsentForm } from './OAuthConsent';
vi.mock('../lib/trade', () => ({ siweSignIn: vi.fn() }));
const request = OAuthRequestSchema.parse({ id: '00000000-0000-4000-8000-000000000098', clientName: { text: '<script>sample</script>', flags: ['agent_bait'], truncated: false },
  redirectUri: 'https://connector.example/callback', redirectHost: 'connector.example', resource: 'https://mcp.eko.example/mcp', expiresAt: '2026-10-03T12:00:00Z', scopes: ['senses:read', 'preflight', 'journal', 'research'] });
describe('connector consent review', () => {
  it('loads a separate SIWE page and requires explicit review before confirmation', async () => {
    const route = resolveRoute('/oauth/consent')!.route;
    expect(route.auth).toBe('siwe'); expect(typeof (await route.load()).default).toBe('function');
    const submit = vi.fn();
    const html = renderToStaticMarkup(<ConsentForm request={request} agents={[]} busy={false} submit={submit} />);
    expect(submit).not.toHaveBeenCalled();
    expect(html).toContain('Untrusted text'); expect(html).toContain('&lt;script&gt;sample&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('connector.example'); expect(html).toContain('senses:read (required)');
    expect(html.match(/type="checkbox" disabled="" checked=""/g)).toHaveLength(3);
    expect(html).toContain('research'); expect(html).toContain('Create a new agent'); expect(html).toContain('Policy preset');
    expect(html).toContain('>Deny<'); expect(html).not.toContain('Confirm approval');
    expect(html).toContain('disabled="">Approve');
  });
  it('offers only connected owner agents and locks all decisions while submission is pending', () => {
    const agents = [{ id: '00000000-0000-4000-8000-000000000090', name: 'Sample agent', kind: 'other' as const, uncheckedOrders24h: 0, status: 'active' as const },
      { id: '00000000-0000-4000-8000-000000000091', name: 'Disconnected sample', kind: 'other' as const, uncheckedOrders24h: 0, status: 'disconnected' as const }];
    const html = renderToStaticMarkup(<ConsentForm request={request} agents={agents} busy={true} submit={vi.fn()} />);
    expect(html).toContain('Sample agent'); expect(html).not.toContain('Disconnected sample');
    expect(html).toContain('disabled="">Approve'); expect(html).toContain('disabled="">Deny');
  });
  it('requires one agent choice on approval and allows explicit denial with no agent', () => {
    const common = { requestId: request.id, scopes: request.scopes, decision: 'approve' };
    expect(OAuthConsentSchema.safeParse(common).success).toBe(false);
    expect(OAuthConsentSchema.safeParse({ ...common, newAgentName: 'Sample agent', agentId: '00000000-0000-4000-8000-000000000090' }).success).toBe(false);
    expect(OAuthConsentSchema.parse({ ...common, decision: 'deny', scopes: [] }).decision).toBe('deny');
  });
});
