import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { OAuthRequestSchema, type OAuthConsent, type OAuthScope } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import type { Db } from '../db/client.js';
import { accounts, agents, agentKeys, auditLog, oauthClients, oauthCodes, oauthGrants, oauthRequests, sessions } from '../db/schema.js';
import { HarnessError, HarnessService } from './service.js';

export const REQUIRED_CONSENT_SCOPES: OAuthScope[] = ['senses:read', 'preflight', 'journal'];
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export interface OAuthConsentConfig { resource: string; redirectAllowlist: string[]; codeTtlSec: number }

/** API-owned, atomic consent. Runtime activation waits for packet 099 and connector acceptance. */
export class OAuthConsentService {
  /**
   * Validate HTTPS MCP resource, redirect allowlist, pepper length and code TTL; wire API-owned
   * consent storage and harness. Host-only construction rejects invalid configuration and does not
   * activate OAuth.
   */
  constructor(private db: Db, private harness: HarnessService, private pepper: string, private cfg: OAuthConsentConfig) {
    const resource = new URL(cfg.resource);
    if (resource.protocol !== 'https:' || resource.pathname !== '/mcp' || resource.search || resource.hash || resource.username || resource.password
      || pepper.length < 32 || !Number.isInteger(cfg.codeTtlSec) || cfg.codeTtlSec < 1 || cfg.codeTtlSec > 60 || !cfg.redirectAllowlist.length) throw new Error('Invalid consent configuration');
    for (const uri of cfg.redirectAllowlist) {
      const u = new URL(uri), loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if ((!loopback && u.protocol !== 'https:') || u.username || u.password || u.hash) throw new Error('Invalid consent redirect');
    }
  }
  private async owner(tx: Transaction, token?: string) {
    if (!token) throw new HarnessError('wallet_auth_required', 'Sign in with your wallet to continue.');
    const [row] = await tx.select({ account: accounts }).from(sessions).innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(and(eq(sessions.tokenHash, createHash('sha256').update(token).digest('hex')), gt(sessions.expiresAt, sql`now()`),
        gt(sessions.authenticatedAt, sql`now() - interval '1 hour'`), eq(accounts.kind, 'wallet'))).for('share', { of: sessions });
    if (!row?.account.walletAddress) throw new HarnessError('wallet_auth_required', 'Sign in again with your wallet. Consent requires a signature within one hour.');
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, row.account.id)).for('update');
    return row.account;
  }
  private async request(tx: Transaction, id: string, accountId: string) {
    const [request] = await tx.select().from(oauthRequests).where(and(eq(oauthRequests.id, id), gt(oauthRequests.expiresAt, sql`now()`))).for('update');
    if (!request || (request.accountId && request.accountId !== accountId)) throw new HarnessError('not_found', 'Not found');
    if (request.decidedAt) throw new HarnessError('conflict', 'This request has already been decided.');
    const [client] = await tx.select().from(oauthClients).where(eq(oauthClients.id, request.clientId));
    if (!client || !client.redirectUris.includes(request.redirectUri) || !this.cfg.redirectAllowlist.includes(request.redirectUri)
      || request.resource !== this.cfg.resource || request.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
      || REQUIRED_CONSENT_SCOPES.some(scope => !request.scopes.includes(scope))) throw new HarnessError('not_found', 'Not found');
    return { request, clientName: toUntrusted(client.clientName.text, 64) };
  }
  /**
   * Require a wallet session authenticated within one hour, lock owner/request, validate
   * PKCE/resource/registered redirect/scopes and bind the undecided request to that account.
   * Return bounded client metadata; expired, foreign or decided requests reject.
   */
  async inspect(token: string | undefined, id: string) {
    return this.db.transaction(async tx => {
      const owner = await this.owner(tx, token), { request, clientName } = await this.request(tx, id, owner.id);
      // TODO(spec): authorize is anonymous; bind the request to the first fresh SIWE
      // account that opens consent. A different wallet must start a new authorization.
      await tx.update(oauthRequests).set({ accountId: owner.id }).where(eq(oauthRequests.id, id));
      return OAuthRequestSchema.parse({ id, clientName, redirectUri: request.redirectUri, redirectHost: new URL(request.redirectUri).host,
        scopes: request.scopes, resource: request.resource, expiresAt: request.expiresAt.toISOString() });
    });
  }
  /**
   * Require fresh wallet authentication and a previously owner-bound request. Atomically approve
   * scopes with an owned connected agent or quota-checked new agent, grant, HMAC-only key/code and
   * audit; denial records access_denied. Return the registered redirect with state. Invalid
   * scopes/ownership or storage failures roll back; runtime activation is separate.
   */
  async consent(token: string | undefined, input: OAuthConsent, limit: number) {
    return this.db.transaction(async tx => {
      const owner = await this.owner(tx, token), { request, clientName } = await this.request(tx, input.requestId, owner.id);
      if (request.accountId !== owner.id) throw new HarnessError('conflict', 'Open the consent request before deciding.');
      const redirect = new URL(request.redirectUri);
      // Registered query parameters survive; protocol response parameters cannot conflict.
      for (const field of ['code', 'error', 'error_description', 'state']) redirect.searchParams.delete(field);
      redirect.searchParams.set('state', request.state);
      let agentId: string | undefined;
      if (input.decision === 'approve') {
        const scopes = [...new Set(input.scopes)];
        if (REQUIRED_CONSENT_SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !request.scopes.includes(scope)))
          throw new HarnessError('bad_request', 'Required scopes must be retained; extra scopes cannot be added.');
        this.harness.assertKeyIssuance(owner.id);
        if (input.agentId) {
          const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.accountId, owner.id))).for('update');
          if (!agent) throw new HarnessError('not_found', 'Not found');
          if (agent.status === 'disconnected') throw new HarnessError('conflict', 'Agent is disconnected.');
          agentId = agent.id;
        } else {
          // TODO(spec): consent names a new agent but does not freeze its kind/default
          // preset. Use the connector kind and Balanced unless a preset is selected.
          agentId = (await this.harness.createInTransaction(tx, owner.id,
            { name: input.newAgentName!, kind: 'robinhood_mcp', preset: input.preset ?? 'balanced' }, limit)).id;
        }
        const [grant] = await tx.insert(oauthGrants).values({ clientId: request.clientId, accountId: owner.id, agentId,
          wallet: owner.walletAddress!, scopes, resource: request.resource }).returning();
        const secret = randomBytes(32).toString('base64url');
        await tx.insert(agentKeys).values({ agentId, kind: 'oauth', oauthGrantId: grant!.id, prefix: randomBytes(8).toString('hex'),
          hash: createHmac('sha256', this.pepper).update(secret).digest('hex'), clientName, scopes });
        const code = randomBytes(32).toString('base64url');
        await tx.insert(oauthCodes).values({ requestId: request.id, grantId: grant!.id, accountId: owner.id,
          hash: createHmac('sha256', this.pepper).update(code).digest('hex'), clientId: request.clientId, redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge, codeChallengeMethod: request.codeChallengeMethod, scopes, resource: request.resource,
          expiresAt: new Date(Date.now() + this.cfg.codeTtlSec * 1000) });
        redirect.searchParams.set('code', code);
      } else redirect.searchParams.set('error', 'access_denied');
      await tx.update(oauthRequests).set({ decision: input.decision, decidedAt: new Date() }).where(eq(oauthRequests.id, request.id));
      await tx.insert(auditLog).values({ accountId: owner.id, action: 'oauth.consent', data: { requestId: request.id, decision: input.decision, ...(agentId ? { agentId } : {}) } });
      return { redirect: redirect.toString() };
    });
  }
}
