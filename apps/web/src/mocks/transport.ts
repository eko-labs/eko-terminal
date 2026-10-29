import { endpoints, createSession, createQuote } from './responses';
import { createAlertSettings, createAddress } from './fixtures';
import { MOCK_HEAD_BLOCK } from './head';
import { coinResponse } from './demo/coin';
import { createRadarCard } from './demo/radar';
import { createPairCard } from './demo/pairs';
import { feedSnapshot, pairSnapshot } from './demo/market';
import { match } from '../lib/router';
import { DEFAULT_PREFERENCES, PreferencesSchema, TelemetrySchema, SIWE_STATEMENT, AgentDetailSchema, AgentSchema, PolicySchema, ApiKeyInfoSchema, AlertSettingsSchema, TradeQuoteRequestSchema, TradeQuoteSchema, JournalConsentSchema, type AlertSettings, type Preferences } from '@eko/shared';
import { createMissionDemo, emitMission } from './demo/mission';
import { demoPacks, demoPresets } from './demo/mission-packs';
import { policyErrors } from '../lib/mission';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** No fetch, wallet prompt, RPC, or real signature verification happens in this transport. */
export function createMockTransport() {
  let wallet: string | null = null;
  const preferenceStore = new Map<string, Preferences>();
  const journalOptIn = new Set<string>();
  const mission = createMissionDemo();
  const alertSettings = new Map<string, AlertSettings>();
  const watches=new Map<string,{kind:'coin'|'wallet'|'crew';target:string}>();
  const account = () => ({ id: 'mock-session', kind: wallet ? 'wallet' : 'guest', walletAddress: wallet, displayName: null, role: 'user' });
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const path = new URL(input, 'http://localhost').pathname;
    const method = init.method ?? 'GET';
    if (path.startsWith('/api/')) {
      if (path === '/api/session') return json({ account: account(), preferences: DEFAULT_PREFERENCES, installs: [] });
      if (path === '/api/auth/nonce') return json({ nonce: 'ekoMockNonce123', domain: typeof location === 'undefined' ? 'localhost' : location.host, uri: typeof location === 'undefined' ? 'http://localhost' : location.origin });
      if (path === '/api/auth/verify') {
        const body = JSON.parse(String(init.body ?? '{}')) as { message?: string };
        wallet = body.message?.match(/\n(0x[0-9a-fA-F]{40})\n/)?.[1]?.toLowerCase() ?? null;
        if (!wallet) return json({ error: 'bad_request', message: 'Missing mock SIWE message.' }, 400);
        return json({ account: account() });
      }
      if (path === '/api/auth/logout') { wallet = null; return json({ ok: true }); }
      if (path === '/api/orders') return json({ orders: [] });
      return json({ error: 'not_found', message: 'No offline fixture for this endpoint.' }, 404);
    }
    const route = path.replace(/^\/v1/, '');
    if (route === '/telemetry' && method === 'POST') {
      let body: unknown;
      try { body = JSON.parse(String(init.body)); } catch { return json({ error: 'bad_request', message: 'Invalid telemetry' }, 422); }
      return TelemetrySchema.safeParse(body).success ? json({ ok: true }) : json({ error: 'bad_request', message: 'Invalid telemetry' }, 422);
    }
    if (route === '/metrics' && method === 'GET') return json({ metrics: [], telemetry: [], retentionDays: 30, at: Date.now() });
    const query = new URL(input, 'http://localhost').searchParams;
    const mockMe = () => ({ ...createSession(), account: { id: wallet ? `demo-wallet-${wallet.slice(2)}` : 'mock-guest', ...(wallet ? { wallet } : {}), linked: [] } });
    if (route === '/auth/siwe/nonce' && method === 'POST') {
      const issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + 600_000);
      return json({ nonce: 'ekoMockNonce123', domain: typeof location === 'undefined' ? 'localhost' : location.host, uri: typeof location === 'undefined' ? 'http://localhost' : location.origin, issuedAt: issuedAt.toISOString(), expirationTime: expirationTime.toISOString() });
    }
    if (route === '/auth/siwe/verify' && method === 'POST') {
      const message = JSON.parse(String(init.body ?? '{}')).message as string;
      // Fixture transport only; the real AuthService verifies the challenge and signature.
      const address = message?.match(/\n(0x[0-9a-fA-F]{40})\n/)?.[1]?.toLowerCase();
      if (!address || !message.includes(SIWE_STATEMENT)) return json({ error: 'unauthorized', message: 'Missing mock SIWE message.' }, 401);
      wallet = address;
      return json(mockMe());
    }
    if (route === '/auth/logout' && method === 'POST') { wallet = null; return json({ ok: true }); }
    if (route === '/me/preferences') {
      if (method === 'GET') return json(preferenceStore.get(wallet ?? 'guest') ?? DEFAULT_PREFERENCES);
      if (method === 'PUT') {
        const parsed = PreferencesSchema.safeParse(JSON.parse(String(init.body ?? '{}')));
        if (!parsed.success) return json({ error: 'bad_request', message: 'Invalid preferences.' }, 422);
        preferenceStore.set(wallet ?? 'guest', parsed.data); return json(parsed.data);
      }
    }
    if (route === '/me/journal-consent' && (method === 'GET' || method === 'PUT')) {
      if (!wallet) return json({ error: 'wallet_auth_required', message: 'Verify your wallet to manage journal data.' }, 401);
      if (method === 'PUT') {
        const parsed = JournalConsentSchema.safeParse(JSON.parse(String(init.body ?? '{}')));
        if (!parsed.success) return json({ error: 'bad_request', message: 'Invalid journal consent.' }, 400);
        if (parsed.data.optedIn) journalOptIn.add(wallet); else journalOptIn.delete(wallet);
      }
      return json({ optedIn: journalOptIn.has(wallet) });
    }
    if (route === '/me/data' && method === 'DELETE') {
      if (!wallet) return json({ error: 'wallet_auth_required', message: 'Verify your wallet to delete harness data.' }, 401);
      preferenceStore.delete(wallet); journalOptIn.delete(wallet);
      return json({ deletedAt: '2026-10-13T12:00:00.000Z' });
    }
    if (route === '/pairs' && method === 'GET') return json({ rows: pairSnapshot().filter((r) => !query.has('stage') || r.column === query.get('stage')).slice(0, 100), cursor: null, delayedSec: 0 });
    if (route === '/feed' && method === 'GET') {
      const kinds = query.get('kinds')?.split(','), rows = feedSnapshot().filter((r) => !kinds || kinds.includes(r.kind));
      const start = query.has('cursor') ? Math.max(0, rows.findIndex((r) => r.id === query.get('cursor')) + 1) : 0;
      return json({ rows: rows.slice(start, start + 500), cursor: null, delayedSec: 0 });
    }
    const body = () => { try { return JSON.parse(String(init.body ?? '{}')); } catch { return {}; } };
    if (route === '/alerts' && method === 'GET') return json({ rows: [], cursor: null, seq: 0 });
    if (route === '/alerts/settings') {
      const key = wallet ?? 'demo-account';
      if (method === 'PUT') { const parsed = AlertSettingsSchema.safeParse(body()); if (!parsed.success) return json({ error: 'bad_request', message: 'Invalid alert settings.' }, 400); alertSettings.set(key, parsed.data); }
      return json(alertSettings.get(key) ?? createAlertSettings());
    }
    if (route === '/telegram/link' && method === 'POST') return json({ url: 'https://t.me/demo_bot?start=demo-link-code', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (route === '/trade/quote' && method === 'POST') {
      const parsed = TradeQuoteRequestSchema.extend({ amountUsd: TradeQuoteRequestSchema.shape.amountUsd.positive(), slippageBps: TradeQuoteRequestSchema.shape.slippageBps.int().min(0).max(9999) }).strict().safeParse(body());
      if (!parsed.success) return json({ error: 'bad_request', message: 'Invalid trade quote request.' }, 400);
      // Synthetic, request-scoped display only. No executable route or accepted checks.
      return json(TradeQuoteSchema.parse({ ...createQuote(), coin: parsed.data.coin, side: parsed.data.side, amountUsd: parsed.data.amountUsd, account: parsed.data.account,
        expiresAt: new Date(Date.now() + 15000).toISOString(), guard: { decision: 'refuse', checks: [{ code: 'sim_unavailable', status: 'refuse', label: 'Execution checks unavailable in this fixture.' }] } }));
    }
    if(route==='/watch'){if(method==='GET')return json({items:[...watches.values()]});const item=body();if(!['coin','wallet','crew'].includes(item.kind)||typeof item.target!=='string')return json({error:'bad_request',message:'Invalid watch target.'},400);const key=`${item.kind}:${item.target}`;if(method==='POST'){watches.set(key,item);return json(item);}if(method==='DELETE'){watches.delete(key);return json({ok:true});}}
    if (route === '/agents' && method === 'GET') return json({ agents: mission.agents });
    if (route === '/packs' && method === 'GET') return json(demoPacks);
    if (route === '/policy-presets' && method === 'GET') return json(demoPresets);
    if (route === '/agents' && method === 'POST') {
      const b = body(), preset = demoPresets.find((p) => p.name.toLowerCase() === String(b.preset).toLowerCase());
      if (!preset || typeof b.name !== 'string' || !b.name.trim() || !['robinhood_mcp', 'onchain', 'perp_venue', 'other'].includes(b.kind)) return json({ error: 'bad_request', message: 'Choose a name, kind and preset.' }, 400);
      const a = AgentSchema.parse({ id: `demo-agent-${mission.agents.length + 1}`, name: b.name.trim().slice(0, 40), kind: b.kind, status: 'active', guardrails: 'advisory', uncheckedOrders24h: 0 });
      const p = structuredClone(preset.policy);
      mission.agents.push(a); mission.policies[a.id] = p; mission.details[a.id] = AgentDetailSchema.parse({ ...a, policy: p }); mission.journals[a.id] = []; mission.keys[a.id] = [];
      emitMission('agents', 'agent', a); return json(mission.details[a.id]);
    }
    if (route === '/agents/kill-all' && method === 'POST') {
      if (body().mode !== 'soft') return json({ error: 'bad_request', message: 'Choose a stop mode.' }, 400);
      for (const a of mission.agents) if (a.status === 'active') {
        a.status = 'soft_killed'; mission.details[a.id].status = a.status; mission.details[a.id].policy.killed = true; mission.policies[a.id].killed = true;
        emitMission('agents', 'agent', a);
      }
      return json({ ok: true });
    }
    const agentRoute = route.match(/^\/agents\/([^/]+)(?:\/(.*))?$/);
    if (agentRoute && !['kill-all'].includes(agentRoute[1])) {
      const [, id, child] = agentRoute, a = mission.agents.find((a) => a.id === id);
      if (!a) return json({ error: 'not_found', message: 'Agent not found.' }, 404);
      if (!child && method === 'GET') return json(mission.details[id]);
      if (!child && method === 'PATCH') {
        if (typeof body().name === 'string' && body().name.trim()) a.name = body().name.trim().slice(0, 40);
        else if (body().status === 'active') { a.status = 'active'; mission.policies[id].killed = false; }
        else return json({ error: 'bad_request', message: 'Invalid agent update.' }, 400);
        mission.details[id] = AgentDetailSchema.parse({ ...a, policy: mission.policies[id] });
        emitMission('agents', 'agent', a); return json(a);
      }
      if (child === 'journal' && method === 'GET') {
        const rows = mission.journals[id].filter((e) => !query.has('kind') || e.kind === query.get('kind'));
        const start = query.has('cursor') ? Math.max(0, rows.findIndex((e) => e.id === query.get('cursor')) + 1) : 0;
        const page = rows.slice(start, start + 24);
        return json({ rows: page, cursor: start + page.length < rows.length ? page.at(-1)?.id : null });
      }
      if (child === 'unchecked-orders' && method === 'GET') return json({ rows: mission.unchecked.filter((u) => u.agentId === id), cursor: null });
      if (child === 'keys' && method === 'GET') return json({ keys: mission.keys[id] });
      if (child === 'keys' && method === 'POST') {
        const keyId = `demo-key-${crypto.randomUUID()}`, prefix = 'eko_demo';
        mission.keys[id].push(ApiKeyInfoSchema.parse({ keyId, prefix, kind: 'api', createdAt: new Date().toISOString(), scopes: ['preflight', 'journal'] }));
        // Synthetic fixture only. Never persist the issued value, even in the mock key list.
        return json({ keyId, prefix, secret: `eko_demo_${crypto.randomUUID()}` });
      }
      if (child?.startsWith('keys/') && method === 'DELETE') {
        const key = mission.keys[id].find((k) => k.keyId === child.slice(5));
        if (!key) return json({ error: 'not_found', message: 'Key not found.' }, 404);
        key.revokedAt = new Date().toISOString(); return json({ ok: true });
      }
      if (child === 'policy' && method === 'GET') return json(mission.policies[id]);
      if (child === 'policy' && method === 'PUT') {
        const parsed = PolicySchema.safeParse(body());
        if (!parsed.success || policyErrors(parsed.data).length) return json({ error: 'bad_request', message: 'Check the policy fields.' }, 400);
        if (parsed.data.version !== mission.policies[id].version) return json({ error: 'conflict', message: 'Policy changed elsewhere — review and save again.' }, 409);
        const p = { ...parsed.data, killed: mission.policies[id].killed, version: parsed.data.version + 1 };
        mission.policies[id] = p; mission.details[id] = AgentDetailSchema.parse({ ...a, policy: p }); emitMission('agents', 'agent', a); return json(p);
      }
      if (child === 'session-key' && method === 'POST') return json({ error: 'conflict', message: 'A reviewed session-key transaction is unavailable in this offline demo. No transaction was sent.' }, 409);
      if (child === 'kill' && method === 'POST') {
        if (!['soft', 'hard'].includes(body().mode)) return json({ error: 'bad_request', message: 'Invalid stop mode.' }, 400);
        // No offline wallet signs a revocation. Keep on-chain hard stops explicit and inert.
        if (body().mode === 'hard' && a.kind === 'onchain') return json({ error: 'conflict', message: 'On-chain hard stop requires a wallet-signed revocation and is unavailable in this offline demo.' }, 409);
        a.status = body().mode === 'soft' ? 'soft_killed' : 'disconnected';
        mission.policies[id].killed = true;
        mission.details[id].status = a.status; mission.details[id].policy.killed = true;
        if (a.status === 'disconnected') mission.keys[id].forEach((key) => { key.revokedAt = new Date().toISOString(); });
        emitMission('agents', 'agent', a);
        return json(body().mode === 'soft' ? { ok: true } : { kind: 'deeplink', url: a.kind === 'perp_venue' ? 'https://app.hyperliquid.xyz' : 'https://robinhood.com/account/settings' });
      }
    }
    if (route === '/approvals' && method === 'GET') {
      for (const a of mission.approvals) if (a.status === 'pending' && Date.parse(a.expiresAt) <= Date.now()) { a.status = 'expired'; emitMission('approvals', 'approval', a); }
      return json({ rows: mission.approvals.filter((a) => !query.has('status') || (query.get('status') === 'history' ? a.status !== 'pending' : a.status === query.get('status'))), cursor: null });
    }
    const approvalRoute = route.match(/^\/approvals\/([^/]+)$/);
    if (approvalRoute && ['GET', 'POST'].includes(method)) {
      if (approvalRoute[1] === 'forbidden-demo') return json({ error: 'forbidden', message: 'This approval belongs to another wallet.' }, 403);
      const a = mission.approvals.find((a) => a.id === approvalRoute[1]);
      if (!a) return json({ error: 'not_found', message: 'Approval not found.' }, 404);
      if (Date.parse(a.expiresAt) <= Date.now() && a.status === 'pending') a.status = 'expired';
      if (method === 'POST') {
        const b = body();
        if (!['approved', 'denied'].includes(b.decision) || typeof b.idempotencyKey !== 'string') return json({ error: 'bad_request', message: 'A decision and idempotency key are required.' }, 400);
        if (a.status !== 'pending' && a.status !== b.decision) return json({ error: 'conflict', message: 'This approval has expired or was decided elsewhere.' }, 409);
        a.status = b.decision; emitMission('approvals', 'approval', a);
      }
      return json(a);
    }
    if (route === '/me') {
      return json(mockMe());
    }
    // CA-26: deterministic image transport fixture; not a JSON API response.
    if (/^\/og\/(scan|bags)\/[^/]+\.png$/.test(route)) {
      const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
      return new Response(data, { headers: { 'content-type': 'image/png' } });
    }
    const coinRoute = route.match(/^\/coins\/(0x[0-9a-fA-F]{40})(?:\/(verdict|candles|markers|flow))?$/);
    if (method === 'GET' && coinRoute) {
      const result = coinResponse(coinRoute[1], coinRoute[2], new URL(input, 'http://localhost').searchParams);
      if (result !== undefined) return json(result);
      // Coins that only exist on New pairs have a card but no chart profile yet.
      const address = coinRoute[1], pair = pairSnapshot().find((r) => r.address.toLowerCase() === address.toLowerCase());
      const card = !coinRoute[2] ? createRadarCard(address) ?? (pair && createPairCard(pair)) : undefined;
      return card ? json(card) : json({ error: 'not_found', message: 'Coin not found.' }, 404);
    }
    const endpoint = endpoints.find((e) => e.method === method && match(e.path, route));
    if (!endpoint) return json({ error: 'not_found', message: 'No offline fixture for this endpoint.' }, 404);
    if (endpoint.input) {
      let body: unknown;
      try { body = JSON.parse(String(init.body)); } catch { return json({ error: 'bad_request', message: 'Invalid JSON.' }, 400); }
      if (!endpoint.input.safeParse(body).success) return json({ error: 'bad_request', message: 'Invalid request.' }, 400);
    }
    const result = endpoint.create();
    // Public scan deep links should agree with the requested resource id.
    if (route.startsWith('/scan/') && typeof result === 'object' && result) Object.assign(result, { id: route.slice(6), shareUrl: route });
    return json(endpoint.schema.parse(result));
  };
}
export const mockFetch = createMockTransport();

export function mockHead() { return { block: MOCK_HEAD_BLOCK, address: createAddress() }; }
