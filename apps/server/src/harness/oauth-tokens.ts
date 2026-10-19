import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AgentSchema } from '@eko/shared';
import type { Db } from '../db/client.js';
import { accounts, agents, agentKeys, oauthCodes, oauthGrants, oauthTokens } from '../db/schema.js';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
const bounded = z.string().min(1).max(2048);
const exchange = z.discriminatedUnion('grant_type', [
  z.strictObject({ grant_type: z.literal('authorization_code'), client_id: bounded, code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    redirect_uri: bounded, code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), resource: bounded.optional() }),
  z.strictObject({ grant_type: z.literal('refresh_token'), client_id: bounded, refresh_token: bounded,
    resource: bounded.optional(), scope: bounded.optional() }),
]);
const revocation = z.strictObject({ client_id: bounded, token: bounded, token_type_hint: bounded.optional() });
export class OAuthTokenError extends Error {
  /**
   * Carry the protocol error code without request or credential details. No token operation or
   * authorization occurs.
   */
  constructor(readonly code: string) { super(code); }
}
export interface OAuthTokenConfig { resource: string; accessTtlSec: number; refreshTtlSec: number }

/** Prepared lifecycle. Production stays disabled until the external acceptance gate passes. */
export class OAuthTokenService {
  /**
   * Validate HTTPS MCP resource, pepper length and bounded access/refresh lifetimes; wire storage
   * and optional destruction reader. Host-only construction does not enable production OAuth or
   * issue tokens.
   */
  constructor(private db: Db, private pepper: string, readonly config: OAuthTokenConfig,
    private destroyed?: (accountId: string) => boolean) {
    const u = new URL(config.resource);
    if (u.protocol !== 'https:' || u.pathname !== '/mcp' || u.search || u.hash || u.username || u.password || pepper.length < 32
      || !Number.isInteger(config.accessTtlSec) || config.accessTtlSec < 1 || config.accessTtlSec > 3600
      || !Number.isInteger(config.refreshTtlSec) || config.refreshTtlSec < 1 || config.refreshTtlSec > 2592000) throw new Error('Invalid OAuth token configuration');
  }
  private hash(value: string) { return createHmac('sha256', this.pepper).update(value).digest('hex'); }
  private matches(hash: string, value: string) {
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(this.hash(value), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private parseToken(token: string) { return /^eko_(oat|ort)_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/.exec(token); }
  private async token(tx: Db | Transaction, value: string) {
    const match = this.parseToken(value);
    if (!match) return null;
    const access = match[1] === 'oat';
    const [row] = await tx.select().from(oauthTokens).where(eq(access ? oauthTokens.accessPrefix : oauthTokens.refreshPrefix, match[2]!));
    return row && this.matches(access ? row.accessHash : row.refreshHash, match[3]!) ? { row, access } : null;
  }
  private async bound(tx: Transaction, id: string) {
    const [snapshot] = await tx.select().from(oauthGrants).where(eq(oauthGrants.id, id));
    if (!snapshot) return null;
    // Account first serializes with destruction-first deletion; Mission Control
    // locks the agent before credentials. Never lock a code or token first.
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, snapshot.accountId)).for('update');
    const [agent] = await tx.select().from(agents).where(eq(agents.id, snapshot.agentId)).for('update');
    const [grant] = await tx.select().from(oauthGrants).where(eq(oauthGrants.id, id)).for('update');
    const [key] = await tx.select().from(agentKeys).where(and(eq(agentKeys.oauthGrantId, id), eq(agentKeys.kind, 'oauth'))).for('update');
    if (!agent || !grant || !key || agent.accountId !== grant.accountId || key.agentId !== agent.id || grant.revokedAt || key.revokedAt
      || agent.status === 'disconnected' || grant.resource !== this.config.resource) return null;
    try { if (this.destroyed?.(grant.accountId)) return null; } catch { return null; }
    return { agent, grant, key };
  }
  private async revokeGrant(tx: Transaction, id: string) {
    // The database couples this to the key and records a credential-free audit event.
    await tx.update(oauthGrants).set({ revokedAt: sql`now()` }).where(and(eq(oauthGrants.id, id), isNull(oauthGrants.revokedAt)));
  }
  private async issue(tx: Transaction, grant: typeof oauthGrants.$inferSelect, codeId?: string) {
    const ap = randomBytes(8).toString('hex'), rp = randomBytes(8).toString('hex');
    const a = randomBytes(32).toString('base64url'), r = randomBytes(32).toString('base64url');
    await tx.insert(oauthTokens).values({ grantId: grant.id, codeId, accessPrefix: ap, refreshPrefix: rp,
      accessHash: this.hash(a), refreshHash: this.hash(r),
      accessExpiresAt: sql`now() + ${this.config.accessTtlSec} * interval '1 second'`,
      refreshExpiresAt: sql`now() + ${this.config.refreshTtlSec} * interval '1 second'` });
    return { access_token: `eko_oat_${ap}_${a}`, refresh_token: `eko_ort_${rp}_${r}`,
      token_type: 'Bearer', expires_in: this.config.accessTtlSec, scope: grant.scopes.join(' ') };
  }
  /**
   * Validate code/refresh request and resource; under owner/agent/grant locks enforce client,
   * PKCE, expiry and exact scopes. Consume codes once or rotate refresh tokens, storing HMACs
   * only. Replay revokes the grant before invalid_grant is thrown; malformed or mismatched grants
   * reject. Runtime acceptance remains a separate gate.
   */
  async exchange(body: unknown) {
    const parsed = exchange.safeParse(body);
    if (!parsed.success) throw new OAuthTokenError('invalid_request');
    const input = parsed.data;
    if (input.resource !== undefined && input.resource !== this.config.resource) throw new OAuthTokenError('invalid_target');
    const result = await this.db.transaction(async tx => {
      if (input.grant_type === 'authorization_code') {
        const [code] = await tx.select().from(oauthCodes).where(eq(oauthCodes.hash, this.hash(input.code)));
        if (!code) return null;
        const bound = await this.bound(tx, code.grantId);
        if (!bound || code.clientId !== input.client_id || bound.grant.clientId !== input.client_id
          || code.redirectUri !== input.redirect_uri || code.resource !== this.config.resource || code.accountId !== bound.grant.accountId
          || code.codeChallengeMethod !== 'S256' || code.codeChallenge !== createHash('sha256').update(input.code_verifier).digest('base64url')
          || JSON.stringify(code.scopes) !== JSON.stringify(bound.grant.scopes)) return null;
        const [current] = await tx.select().from(oauthCodes).where(eq(oauthCodes.id, code.id)).for('update');
        if (current?.consumedAt) { await this.revokeGrant(tx, bound.grant.id); return null; }
        const [used] = await tx.update(oauthCodes).set({ consumedAt: sql`now()` }).where(and(eq(oauthCodes.id, code.id),
          isNull(oauthCodes.consumedAt), gt(oauthCodes.expiresAt, sql`now()`))).returning();
        return used ? this.issue(tx, bound.grant, code.id) : null;
      }
      const token = await this.token(tx, input.refresh_token);
      if (!token || token.access) return null;
      const bound = await this.bound(tx, token.row.grantId);
      if (!bound || bound.grant.clientId !== input.client_id) return null;
      // TODO(spec): refresh scope narrowing is not specified. Accept only the exact
      // granted scope set; changing scopes requires consent rather than expansion.
      if (input.scope !== undefined && [...new Set(input.scope.split(' '))].sort().join(' ') !== [...bound.grant.scopes].sort().join(' '))
        throw new OAuthTokenError('invalid_scope');
      const [current] = await tx.select().from(oauthTokens).where(eq(oauthTokens.id, token.row.id)).for('update');
      if (current?.refreshConsumedAt) { await this.revokeGrant(tx, bound.grant.id); return null; }
      const [used] = await tx.update(oauthTokens).set({ refreshConsumedAt: sql`now()` }).where(and(eq(oauthTokens.id, token.row.id),
        isNull(oauthTokens.refreshConsumedAt), isNull(oauthTokens.revokedAt), gt(oauthTokens.refreshExpiresAt, sql`now()`))).returning();
      return used ? this.issue(tx, bound.grant) : null;
    });
    // Throw outside the transaction so replay-triggered revocation is committed.
    if (!result) throw new OAuthTokenError('invalid_grant');
    return result;
  }
  /**
   * Validate revocation input and revoke the matching client-bound grant for either access or
   * refresh tokens. Unknown tokens or foreign clients are ignored; malformed requests and storage
   * failures reject. This ends the shared credential family.
   */
  async revoke(body: unknown) {
    const parsed = revocation.safeParse(body);
    if (!parsed.success) throw new OAuthTokenError('invalid_request');
    await this.db.transaction(async tx => {
      const token = await this.token(tx, parsed.data.token);
      if (!token) return;
      const bound = await this.bound(tx, token.row.grantId);
      if (!bound || bound.grant.clientId !== parsed.data.client_id) return;
      // TODO(spec): access-token revocation also ends the grant, the smallest
      // revocation unit shared by its harness key and rotating refresh family.
      await this.revokeGrant(tx, bound.grant.id);
    });
  }
  /**
   * Resolve an unexpired access bearer for the configured resource, rechecking grant/key/agent and
   * optional destruction state under locks, and record use. Invalid/revoked/disconnected/deleted
   * credentials return null; SQL failures reject. Paused agents can resolve; MCP checks active
   * status separately.
   */
  async authenticate(bearer: string, resource = this.config.resource) {
    if (resource !== this.config.resource) return null;
    return this.db.transaction(async tx => {
      const token = await this.token(tx, bearer);
      if (!token?.access) return null;
      const bound = await this.bound(tx, token.row.grantId);
      if (!bound) return null;
      const [valid] = await tx.select().from(oauthTokens).where(and(eq(oauthTokens.id, token.row.id),
        isNull(oauthTokens.revokedAt), gt(oauthTokens.accessExpiresAt, sql`now()`)));
      if (!valid) return null;
      await tx.update(agentKeys).set({ lastUsedAt: sql`now()` }).where(eq(agentKeys.id, bound.key.id));
      await tx.update(oauthGrants).set({ lastUsedAt: sql`now()` }).where(eq(oauthGrants.id, bound.grant.id));
      return { accountId: bound.grant.accountId, keyId: bound.key.id, scopes: bound.grant.scopes,
        agent: AgentSchema.parse({ ...bound.agent, wallet: bound.agent.wallet ?? undefined,
          lastSeen: bound.agent.lastSeen?.toISOString(), guardrails: 'advisory', uncheckedOrders24h: 0 }) };
    });
  }
}
