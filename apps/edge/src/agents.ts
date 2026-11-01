import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAddress, isAddress, type Address } from 'viem';
import { PolicySchema, type Agent, type AgentDetail, type Approval, type JournalEntry, type Pack, type Policy, type PreflightResult, type Verdict } from '@eko/shared';
import type { Account } from './accounts.js';
import type { Assessment } from './assess.js';
import type { CoinState } from './tracker.js';

/**
 * Mission Control on Elysium: a signed-in wallet registers its AI agents, gives each an API key and a policy, and sees
 * what they checked. Agents connect over MCP (mcp.ts) and ask EKO before they trade (preflight). EKO never holds keys
 * or funds and never places an order: a preflight is advice, an approval is the owner's yes for one order, and the
 * kill switch makes every later preflight say no. Keys are stored only as SHA-256 hashes.
 */
export const PRESETS: { name: 'Safe' | 'Balanced' | 'Degen'; policy: Policy }[] = [
  { name: 'Safe', policy: { mode: 'safe', blockPlaybookLevel: 'monitor', maxPositionUsd: 100, approvalAboveUsd: 50, maxRoundTripCostPct: 10, killed: false, version: 1, guardPolicyVersion: 2 } },
  { name: 'Balanced', policy: { mode: 'balanced', blockPlaybookLevel: 'danger', maxPositionUsd: 500, approvalAboveUsd: 250, maxRoundTripCostPct: 20, killed: false, version: 1, guardPolicyVersion: 2 } },
  { name: 'Degen', policy: { mode: 'degen', blockPlaybookLevel: null, maxPositionUsd: 1000, killed: false, version: 1, guardPolicyVersion: 2 } },
];
const MAX_AGENTS = 3, APPROVAL_TTL_SEC = 900;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

export interface AgentRow { id: string; accountId: string; name: string; kind: Agent['kind']; wallet: Address | null; status: Agent['status']; policy: Policy; lastSeen: number | null }

export class AgentStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, wallet TEXT, status TEXT NOT NULL,
        policy TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE INDEX IF NOT EXISTS agents_account ON agents(account_id);
      CREATE TABLE IF NOT EXISTS agent_keys(key_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        last_used_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, preflight_id TEXT,
        share INTEGER NOT NULL, commitment TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent_id, ts);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, account_id TEXT NOT NULL, preflight_id TEXT NOT NULL, client_ref TEXT NOT NULL,
        summary TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER);
      CREATE INDEX IF NOT EXISTS approvals_account ON approvals(account_id, status);`);
  }
  private row(r: Record<string, unknown>): AgentRow {
    return { id: String(r.id), accountId: String(r.account_id), name: String(r.name), kind: r.kind as Agent['kind'], wallet: r.wallet ? getAddress(String(r.wallet)) : null,
      status: r.status as Agent['status'], policy: PolicySchema.parse(JSON.parse(String(r.policy))), lastSeen: r.last_seen == null ? null : Number(r.last_seen) };
  }
  list(accountId: string) { return (this.db.prepare('SELECT * FROM agents WHERE account_id = ? ORDER BY created_at').all(accountId) as Record<string, unknown>[]).map(r => this.row(r)); }
  get(accountId: string, id: string) { const r = this.db.prepare('SELECT * FROM agents WHERE id = ? AND account_id = ?').get(id, accountId) as Record<string, unknown> | undefined; return r ? this.row(r) : null; }
  byId(id: string) { const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? this.row(r) : null; }
  create(accountId: string, name: string, kind: Agent['kind'], policy: Policy): AgentRow {
    const id = `agt_${randomBytes(8).toString('hex')}`;
    this.db.prepare('INSERT INTO agents(id, account_id, name, kind, wallet, status, policy, created_at) VALUES(?, ?, ?, ?, NULL, ?, ?, ?)').run(id, accountId, name, kind, 'active', JSON.stringify(policy), now());
    return this.byId(id)!;
  }
  setStatus(id: string, status: Agent['status']) { this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id); }
  setPolicy(id: string, policy: Policy) { this.db.prepare('UPDATE agents SET policy = ? WHERE id = ?').run(JSON.stringify(policy), id); }
  setWallet(id: string, wallet: Address) { this.db.prepare('UPDATE agents SET wallet = ? WHERE id = ? AND wallet IS NULL').run(wallet.toLowerCase(), id); }
  touch(id: string) { this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(now(), id); }

  createKey(agentId: string) {
    const secret = `eko_${randomBytes(24).toString('base64url')}`, keyId = `key_${randomBytes(6).toString('hex')}`, prefix = secret.slice(0, 10);
    this.db.prepare('INSERT INTO agent_keys(key_id, agent_id, prefix, hash, created_at) VALUES(?, ?, ?, ?, ?)').run(keyId, agentId, prefix, sha(secret), now());
    return { keyId, prefix, secret };
  }
  keys(agentId: string) {
    return (this.db.prepare('SELECT * FROM agent_keys WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as Record<string, number | string | null>[]).map(k => ({
      keyId: String(k.key_id), prefix: String(k.prefix), kind: 'api' as const, createdAt: iso(Number(k.created_at)),
      ...(k.last_used_at ? { lastUsedAt: iso(Number(k.last_used_at)) } : {}), ...(k.revoked_at ? { revokedAt: iso(Number(k.revoked_at)) } : {}) }));
  }
  revokeKeys(agentId: string, keyId?: string) {
    if (keyId) this.db.prepare('UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND key_id = ? AND revoked_at IS NULL').run(now(), agentId, keyId);
    else this.db.prepare('UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL').run(now(), agentId);
  }
  /** The agent a bearer key belongs to (unrevoked, agent not disconnected). */
  byKey(secret: string | undefined): AgentRow | null {
    if (!secret || !secret.startsWith('eko_') || secret.length > 80) return null;
    const k = this.db.prepare('SELECT * FROM agent_keys WHERE hash = ? AND revoked_at IS NULL').get(sha(secret)) as { key_id: string; agent_id: string } | undefined;
    if (!k) return null;
    const a = this.byId(k.agent_id);
    if (!a || a.status === 'disconnected') return null;
    this.db.prepare('UPDATE agent_keys SET last_used_at = ? WHERE key_id = ?').run(now(), k.key_id);
    this.touch(a.id);
    return a;
  }

  journal(agentId: string, kind: JournalEntry['kind'], payload: Record<string, unknown>, preflightId?: string, share = false): JournalEntry {
    const id = randomUUID(), ts = now(), body = JSON.stringify(payload);
    const commitment = `0x${sha(`${id}:${agentId}:${ts}:${kind}:${body}`)}`;
    this.db.prepare('INSERT INTO journal(id, agent_id, ts, kind, payload, preflight_id, share, commitment) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(id, agentId, ts, kind, body, preflightId ?? null, share ? 1 : 0, commitment);
    return { id, agentId, ts: iso(ts), kind, payload, ...(preflightId ? { preflightId } : {}), share, commitment };
  }
  journalPage(agentId: string, opts: { cursor?: string; kind?: string; limit?: number }) {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50)), before = Number(opts.cursor ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
    const rows = (this.db.prepare(`SELECT * FROM journal WHERE agent_id = ? AND ts < ? ${opts.kind ? 'AND kind = ?' : ''} ORDER BY ts DESC LIMIT ?`)
      .all(...[agentId, before, ...(opts.kind ? [opts.kind] : []), limit + 1]) as Record<string, string | number | null>[]);
    return { rows: rows.slice(0, limit).map(r => ({ id: String(r.id), agentId: String(r.agent_id), ts: iso(Number(r.ts)), kind: r.kind as JournalEntry['kind'], payload: JSON.parse(String(r.payload)),
      ...(r.preflight_id ? { preflightId: String(r.preflight_id) } : {}), share: !!r.share, commitment: String(r.commitment) })), cursor: rows.length > limit ? String(rows[limit - 1]!.ts) : null };
  }

  approval(accountId: string, id: string): Approval | null {
    this.expire();
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND account_id = ?').get(id, accountId) as Record<string, string | number | null> | undefined;
    return r ? toApproval(r) : null;
  }
  approvals(accountId: string, status?: string): Approval[] {
    this.expire();
    return (this.db.prepare(`SELECT * FROM approvals WHERE account_id = ? ${status ? 'AND status = ?' : ''} ORDER BY expires_at DESC LIMIT 100`).all(...[accountId, ...(status ? [status] : [])]) as Record<string, string | number | null>[]).map(toApproval);
  }
  decide(accountId: string, id: string, decision: 'approved' | 'denied'): Approval | null {
    this.expire();
    this.db.prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND account_id = ? AND status = 'pending'`).run(decision, now(), id, accountId);
    return this.approval(accountId, id);
  }
  /** The latest approval for one order of an agent (clientOrderRef), if any. */
  approvalFor(agentId: string, clientRef: string) {
    this.expire();
    const r = this.db.prepare('SELECT * FROM approvals WHERE agent_id = ? AND client_ref = ? ORDER BY expires_at DESC LIMIT 1').get(agentId, clientRef) as Record<string, string | number | null> | undefined;
    return r ? toApproval(r) : null;
  }
  requestApproval(agent: AgentRow, preflightId: string, clientRef: string, summary: string, detail: Approval['detail']): Approval {
    const id = `apr_${randomBytes(8).toString('hex')}`;
    this.db.prepare(`INSERT INTO approvals(id, agent_id, account_id, preflight_id, client_ref, summary, status, detail, expires_at) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, agent.id, agent.accountId, preflightId, clientRef, summary, JSON.stringify(detail ?? null), now() + APPROVAL_TTL_SEC);
    return this.approval(agent.accountId, id)!;
  }
  private expire() { this.db.prepare(`UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`).run(now()); }
  erase(accountId: string) {
    for (const a of this.list(accountId)) { for (const t of ['agent_keys', 'journal']) this.db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(a.id); }
    this.db.prepare('DELETE FROM approvals WHERE account_id = ?').run(accountId);
    this.db.prepare('DELETE FROM agents WHERE account_id = ?').run(accountId);
  }
}

function toApproval(r: Record<string, string | number | null>): Approval {
  const detail = JSON.parse(String(r.detail));
  return { id: String(r.id), agentId: String(r.agent_id), preflightId: String(r.preflight_id), summary: String(r.summary), status: r.status as Approval['status'],
    ...(detail ? { detail } : {}), expiresAt: iso(Number(r.expires_at)) };
}

export function agentView(a: AgentRow): Agent {
  return { id: a.id, name: a.name, kind: a.kind, ...(a.wallet ? { wallet: a.wallet } : {}), status: a.status, ...(a.lastSeen ? { lastSeen: iso(a.lastSeen) } : {}), guardrails: 'advisory', uncheckedOrders24h: 0 };
}
export function agentDetail(a: AgentRow): AgentDetail {
  const p = a.policy;
  return { ...agentView(a), guardrails: 'advisory', policy: { mode: p.mode, version: p.version, ...(p.guardPolicyVersion ? { guardPolicyVersion: p.guardPolicyVersion } : {}), killed: p.killed,
    blockPlaybookLevel: p.blockPlaybookLevel, ...(p.approvalAboveUsd !== undefined ? { approvalAboveUsd: p.approvalAboveUsd } : {}), ...(p.maxPositionUsd !== undefined ? { maxPositionUsd: p.maxPositionUsd } : {}),
    ...(p.maxDailyLossUsd !== undefined ? { maxDailyLossUsd: p.maxDailyLossUsd } : {}) } };
}

export interface PreflightDeps {
  agents: AgentStore;
  coin: (address: string) => CoinState | undefined;
  assess: (coin: CoinState) => Promise<Assessment | undefined>;
}
export interface PreflightOrder { coin: Address; side: 'buy' | 'sell'; notionalUsd: number }

/**
 * Advice for one order against the agent's policy and the coin's live check. Deny: the agent is paused or killed, the
 * coin is a confirmed honeypot (buys), its level is at or above the policy's block level, a pending check under the
 * Safe preset, the round trip costs more than allowed, the size is over the cap, or the coin is blocked. Needs
 * approval: the size is above the approval line and the owner has not said yes to this order yet. Otherwise allow.
 */
export async function preflight(d: PreflightDeps, agent: AgentRow, clientOrderRef: string, order: PreflightOrder): Promise<PreflightResult> {
  const p = agent.policy, reasons: string[] = [], preflightId = randomUUID();
  let decision: PreflightResult['decision'] = 'allow';
  const deny = (r: string) => { reasons.push(r); decision = 'deny'; };
  if (agent.status !== 'active' || p.killed) deny('This agent is paused by its owner.');
  const coin = d.coin(order.coin), a = coin ? await d.assess(coin) : undefined;
  const verdict: Verdict | undefined = a?.verdict;
  const buy = order.side === 'buy';
  if (!a) { if (buy) deny('EKO has not checked this coin (it follows Montra launches from the last day).'); else reasons.push('EKO has not checked this coin.'); }
  else {
    const honeypot = a.verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger');
    if (buy && honeypot) deny('A buy-then-sell check could not sell this coin.');
    const rank = { clear: 0, info: 1, pending: 1, monitor: 2, danger: 3 } as const;
    if (buy && p.blockPlaybookLevel && rank[a.verdict.level] >= rank[p.blockPlaybookLevel]) deny(`EKO rates this coin ${a.verdict.level}; the policy blocks ${p.blockPlaybookLevel} and above.`);
    if (buy && a.verdict.level === 'pending' && p.mode === 'safe') deny('EKO has not finished checking this coin; the Safe policy waits.');
    const exit = a.probe?.exitCostPct;
    if (buy && p.maxRoundTripCostPct !== undefined && typeof exit === 'number' && exit > p.maxRoundTripCostPct) deny(`A round trip costs ${exit.toFixed(1)}%; the policy allows ${p.maxRoundTripCostPct}%.`);
    for (const r of a.verdict.reasons.slice(0, 3)) reasons.push(r);
  }
  const lc = order.coin.toLowerCase();
  if (p.blockAssets?.some(x => x.toLowerCase() === lc)) deny('The policy blocks this coin.');
  if (p.allowAssets?.length && !p.allowAssets.some(x => x.toLowerCase() === lc)) deny('The policy allows only listed coins.');
  if (buy && p.maxPositionUsd !== undefined && order.notionalUsd > p.maxPositionUsd) deny(`$${order.notionalUsd} is over the policy's $${p.maxPositionUsd} cap.`);
  let approvalId: string | undefined;
  if (decision === 'allow' && p.approvalAboveUsd !== undefined && order.notionalUsd > p.approvalAboveUsd) {
    const prior = d.agents.approvalFor(agent.id, clientOrderRef);
    if (prior?.status === 'approved') reasons.push('The owner approved this order.');
    else if (prior?.status === 'pending') { decision = 'needs_approval'; approvalId = prior.id; reasons.push('Waiting for the owner to approve this order in Mission Control.'); }
    else if (prior?.status === 'denied') deny('The owner declined this order.');
    else {
      decision = 'needs_approval';
      const summary = `${agent.name}: ${order.side} $${order.notionalUsd} of ${order.coin}`;
      approvalId = d.agents.requestApproval(agent, preflightId, clientOrderRef, summary, {
        clientOrderRef, order: { venue: 'elysium', instrument: order.coin, side: order.side, notionalUsd: order.notionalUsd, orderType: 'market' },
        orderHash: `0x${sha(`${agent.id}:${clientOrderRef}:${order.coin}:${order.side}:${order.notionalUsd}`)}`, notionalUsd: order.notionalUsd, approvalAboveUsd: p.approvalAboveUsd,
        reasons: [...reasons], policyVersion: p.version, ...(verdict ? { verdict } : {}) }).id;
      reasons.push(`Above the $${p.approvalAboveUsd} approval line: the owner must approve it in Mission Control.`);
    }
  }
  const entry = d.agents.journal(agent.id, 'decision', { clientOrderRef, order, decision, reasons }, preflightId);
  return { preflightId, decision, reasons, policyVersion: p.version, ...(p.guardPolicyVersion ? { guardPolicyVersion: p.guardPolicyVersion } : {}),
    ...(approvalId ? { approvalId } : {}), ...(verdict ? { senses: { verdict } } : {}), journalId: entry.id };
}

/** Connection packs: how to add EKO's MCP server to an agent. {{API_KEY}} is filled in the browser, never sent back. */
export function packs(mcpUrl: string): Pack[] {
  return [
    { platform: 'claude_code', stage: 'T', version: 1, configTemplate: `claude mcp add --transport http eko ${mcpUrl} --header "Authorization: Bearer {{API_KEY}}"`,
      instructions: 'Run this in a terminal where Claude Code is installed, then ask Claude to check a coin with EKO before it trades.' },
    { platform: 'generic_mcp', stage: 'T', version: 1, configTemplate: JSON.stringify({ mcpServers: { eko: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer {{API_KEY}}' } } } }, null, 2),
      instructions: 'Add this server to any MCP client that supports streamable HTTP. Read tools work without a key; preflight and the journal need it.' },
    { platform: 'claude_desktop', stage: 'T', version: 1, configTemplate: JSON.stringify({ mcpServers: { eko: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization: Bearer {{API_KEY}}'] } } }, null, 2),
      instructions: 'Paste into Claude Desktop\'s config file (Settings → Developer → Edit Config) and restart Claude Desktop.' },
  ];
}

const fail = (reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).send({ error, message });

export function registerAgentRoutes(app: FastifyInstance, agents: AgentStore, auth: { need: (req: FastifyRequest, reply: FastifyReply) => Account | null }, opts: { mcpUrl: (req: FastifyRequest) => string; onApproval?: (accountId: string, a: Approval) => void }) {
  const mine = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const acct = auth.need(req, reply); if (!acct) return null;
    const a = agents.get(acct.id, req.params.id);
    if (!a) { void fail(reply, 404, 'not_found', 'No such agent.'); return null; }
    return a;
  };
  app.get('/v1/policy-presets', async () => PRESETS);
  app.get('/v1/packs', async (req) => packs(opts.mcpUrl(req)));
  app.get('/v1/agents', async (req, reply) => { const acct = auth.need(req, reply); if (!acct) return reply; return { agents: agents.list(acct.id).map(agentView) }; });
  app.post<{ Body: { name?: unknown; kind?: unknown; preset?: unknown } }>('/v1/agents', async (req, reply) => {
    const acct = auth.need(req, reply); if (!acct) return reply;
    const b = req.body ?? {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 48) : '';
    const kind = ['robinhood_mcp', 'onchain', 'perp_venue', 'other'].includes(String(b.kind)) ? b.kind as Agent['kind'] : 'other';
    const preset = PRESETS.find(p => p.name.toLowerCase() === String(b.preset ?? 'balanced').toLowerCase()) ?? PRESETS[1]!;
    if (!name) return fail(reply, 400, 'bad_request', 'Name the agent.');
    if (agents.list(acct.id).filter(a => a.status !== 'disconnected').length >= MAX_AGENTS) return fail(reply, 400, 'limit_reached', `Up to ${MAX_AGENTS} agents per wallet.`);
    return agentDetail(agents.create(acct.id, name, kind, preset.policy));
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => { const a = mine(req, reply); return a ? agentDetail(a) : reply; });
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>('/v1/agents/:id', async (req, reply) => {
    const a = mine(req, reply); if (!a) return reply;
    if (req.body?.status !== 'active') return fail(reply, 400, 'bad_request', 'Only resuming is supported here.');
    if (a.status === 'disconnected') return fail(reply, 409, 'conflict', 'A disconnected agent needs a new key; create a new agent.');
    agents.setStatus(a.id, 'active'); agents.setPolicy(a.id, { ...a.policy, killed: false, version: a.policy.version + 1 });
    return agentView(agents.byId(a.id)!);
  });
  app.post<{ Params: { id: string }; Body: { mode?: unknown } }>('/v1/agents/:id/kill', async (req, reply) => {
    const a = mine(req, reply); if (!a) return reply;
    const hard = req.body?.mode === 'hard';
    agents.setStatus(a.id, hard ? 'disconnected' : 'soft_killed'); agents.setPolicy(a.id, { ...a.policy, killed: true, version: a.policy.version + 1 });
    if (hard) agents.revokeKeys(a.id);
    // EKO holds no keys: there is nothing on-chain to revoke. The agent's own wallet is the owner's to empty or rotate.
    return { kind: 'deeplink', url: '/mission' };
  });
  app.post('/v1/agents/kill-all', async (req, reply) => {
    const acct = auth.need(req, reply); if (!acct) return reply;
    for (const a of agents.list(acct.id)) if (a.status === 'active') { agents.setStatus(a.id, 'soft_killed'); agents.setPolicy(a.id, { ...a.policy, killed: true, version: a.policy.version + 1 }); }
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id/policy', async (req, reply) => { const a = mine(req, reply); return a ? a.policy : reply; });
  app.put<{ Params: { id: string } }>('/v1/agents/:id/policy', async (req, reply) => {
    const a = mine(req, reply); if (!a) return reply;
    const p = PolicySchema.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'bad_request', 'Invalid policy.');
    const next = { ...p.data, version: a.policy.version + 1, killed: a.policy.killed };
    agents.setPolicy(a.id, next);
    return next;
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id/keys', async (req, reply) => { const a = mine(req, reply); return a ? { keys: agents.keys(a.id) } : reply; });
  app.post<{ Params: { id: string } }>('/v1/agents/:id/keys', async (req, reply) => {
    const a = mine(req, reply); if (!a) return reply;
    if (a.status === 'disconnected') return fail(reply, 409, 'conflict', 'This agent is disconnected.');
    return agents.createKey(a.id);
  });
  app.delete<{ Params: { id: string; keyId: string } }>('/v1/agents/:id/keys/:keyId', async (req, reply) => {
    const a = mine(req as unknown as FastifyRequest<{ Params: { id: string } }>, reply); if (!a) return reply;
    agents.revokeKeys(a.id, req.params.keyId); return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; kind?: string; limit?: string } }>('/v1/agents/:id/journal', async (req, reply) => {
    const a = mine(req, reply); if (!a) return reply;
    return agents.journalPage(a.id, { ...(req.query.cursor ? { cursor: req.query.cursor } : {}), ...(req.query.kind ? { kind: req.query.kind } : {}), ...(req.query.limit ? { limit: Number(req.query.limit) } : {}) });
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id/unchecked-orders', async (req, reply) => { const a = mine(req, reply); return a ? { rows: [] } : reply; });
  app.get<{ Querystring: { status?: string } }>('/v1/approvals', async (req, reply) => {
    const acct = auth.need(req, reply); if (!acct) return reply;
    return { rows: agents.approvals(acct.id, ['pending', 'approved', 'denied', 'expired'].includes(req.query.status ?? '') ? req.query.status : undefined) };
  });
  app.get<{ Params: { id: string } }>('/v1/approvals/:id', async (req, reply) => {
    const acct = auth.need(req, reply); if (!acct) return reply;
    return agents.approval(acct.id, req.params.id) ?? fail(reply, 404, 'not_found', 'No such approval.');
  });
  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>('/v1/approvals/:id', async (req, reply) => {
    const acct = auth.need(req, reply); if (!acct) return reply;
    if (req.body?.decision !== 'approved' && req.body?.decision !== 'denied') return fail(reply, 400, 'bad_request', 'Decide approved or denied.');
    const a = agents.decide(acct.id, req.params.id, req.body.decision);
    if (!a) return fail(reply, 404, 'not_found', 'No such approval.');
    opts.onApproval?.(acct.id, a);
    return a;
  });
}

export const isWallet = (s: unknown): s is Address => typeof s === 'string' && isAddress(s, { strict: false });
