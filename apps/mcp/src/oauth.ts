import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OAuthScopeSchema, type OAuthScope, type Untrusted } from '@eko/shared';
import { toUntrusted } from '../../../packages/untrusted/src/index.js';
import type { DbHandle } from '../../server/src/db/client.js';

export const OAUTH_SCOPES = OAuthScopeSchema.options;
export const REQUIRED_OAUTH_SCOPES: OAuthScope[] = ['senses:read', 'preflight', 'journal'];
const bounded = z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/);
const registration = z.object({
  redirect_uris: z.array(bounded).min(1).max(10),
  client_name: z.string().max(1024).default('Unnamed client'),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1).max(2)
    .default(['authorization_code', 'refresh_token']).refine(v => v.includes('authorization_code')),
  response_types: z.tuple([z.literal('code')]).default(['code']),
});
export interface VerifiedClientDocument {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: 'none';
  grant_types?: ('authorization_code' | 'refresh_token')[];
  response_types?: ['code'];
}
export interface OAuthDiscoveryConfig {
  publicUrl: string;
  issuer: string;
  webOrigin: string;
  redirectAllowlist: string[];
  /** Operator-verified snapshots only. Authorization never fetches a caller-provided URL. */
  verifiedClientDocuments?: VerifiedClientDocument[];
}
export interface StoredOAuthRequest {
  id: string; client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: 'S256';
  state: string; scopes: OAuthScope[]; resource: string; created_at: Date; expires_at: Date; client_name: Untrusted;
}
interface ClientRow { id: string; client_name: Untrusted; redirect_uris: string[] }
export class OAuthDiscoveryError extends Error {
  constructor(readonly code: string, readonly redirectUri?: string, readonly state?: string) { super(code); }
}
const publicHttps = (value: string) => {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) throw new Error('Invalid OAuth URL');
  return u;
};

/** MCP owns writes here. The API consent packet reads only live requests; no tokens are issued. */
export class OAuthDiscovery {
  readonly config: OAuthDiscoveryConfig;
  private documents = new Map<string, z.infer<typeof registration>>();
  /**
   * Validate credential-free HTTPS resource/issuer/web origins, bounded exact redirect allowlist and
   * operator-verified metadata snapshots. Host construction only; invalid/mismatched
   * URLs/profile/duplicates throw before registration. No caller-provided URL is fetched.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  constructor(private db: DbHandle['chain'], private pepper: string, config: OAuthDiscoveryConfig) {
    const resource = publicHttps(config.publicUrl), issuer = publicHttps(config.issuer), web = publicHttps(config.webOrigin);
    if (resource.pathname !== '/mcp' || config.issuer !== resource.origin || config.webOrigin !== web.origin || issuer.pathname !== '/') {
      throw new Error('Invalid OAuth origin/resource');
    }
    const allowlist = [...new Set(config.redirectAllowlist)];
    if (!allowlist.length || allowlist.length > 100) throw new Error('Invalid OAuth redirect allowlist');
    for (const value of allowlist) {
      const u = new URL(value);
      const loopback = u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
      if ((!loopback && u.protocol !== 'https:') || u.username || u.password || u.hash || !bounded.safeParse(value).success) {
        throw new Error('Invalid OAuth redirect allowlist');
      }
    }
    this.config = { ...config, redirectAllowlist: allowlist };
    // TODO(spec): §9.1 leaves CIMD verification/intake unspecified. Require a reviewed
    // local snapshot keyed by its exact HTTPS document URL until connector evidence specifies intake.
    for (const doc of config.verifiedClientDocuments ?? []) {
      const u = publicHttps(doc.client_id);
      if (u.pathname === '/' || this.documents.has(doc.client_id)) throw new Error('Invalid verified client document');
      const parsed = this.validateRegistration(doc);
      this.documents.set(doc.client_id, parsed);
    }
  }
  /**
   * Return configured public resource/discovery metadata without issuing or validating tokens.
   * Public read without authentication; runtime omits discovery until connector acceptance.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  protectedResource() {
    return { resource: this.config.publicUrl, authorization_servers: [this.config.issuer],
      scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ['header'] };
  }
  /**
   * Return prepared issuer/endpoint/PKCE metadata. Public read without authentication; advertising
   * this object does not implement consent, token issuance or revocation endpoints and runtime omits
   * it.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  authorizationServer() {
    const issuer = this.config.issuer;
    return { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: OAUTH_SCOPES,
      client_id_metadata_document_supported: true };
  }
  private validateRegistration(input: unknown) {
    const parsed = registration.safeParse(input);
    if (!parsed.success) throw new OAuthDiscoveryError('invalid_client_metadata');
    if (parsed.data.redirect_uris.some(uri => !this.config.redirectAllowlist.includes(uri))) {
      throw new OAuthDiscoveryError('invalid_redirect_uri');
    }
    return parsed.data;
  }
  /** A sliding hour, atomic across replicas; only IP HMACs and at most ten timestamps persist.
   * @remarks
   * Atomically enforce ten accepted registration attempts per sliding hour using IP HMACs and return
   * retry time. Anonymous callers are throttled by transport; SQL failures reject rather than allow.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  async registrationLimit(ip: string) {
    const subject = createHmac('sha256', this.pepper).update(`oauth-register:${ip}`).digest('hex');
    const { rows } = await this.db.sql.query<{ allowed: boolean; retry: number }>(`
      INSERT INTO oauth_registration_limits(subject_hash, attempts, allowed) VALUES ($1, ARRAY[now()], true)
      ON CONFLICT (subject_hash) DO UPDATE SET
        attempts = CASE WHEN cardinality(ARRAY(SELECT t FROM unnest(oauth_registration_limits.attempts) t
          WHERE t > now() - interval '1 hour')) < 10
          THEN ARRAY(SELECT t FROM unnest(oauth_registration_limits.attempts) t WHERE t > now() - interval '1 hour') || now()
          ELSE ARRAY(SELECT t FROM unnest(oauth_registration_limits.attempts) t WHERE t > now() - interval '1 hour') END,
        allowed = cardinality(ARRAY(SELECT t FROM unnest(oauth_registration_limits.attempts) t WHERE t > now() - interval '1 hour')) < 10
      RETURNING allowed, GREATEST(1, CEIL(EXTRACT(EPOCH FROM attempts[1] + interval '1 hour' - now())))::int AS retry
    `, [subject]);
    return { allowed: rows[0]!.allowed, retryAfterSec: rows[0]!.retry };
  }
  /**
   * Validate exact allowlisted redirect URIs/client metadata, store a generated public client id
   * with Untrusted name and append registration audit state. Anonymous registration; transport must
   * apply limits first. Invalid metadata/redirect or SQL failures reject; no tokens are issued.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  async register(input: unknown) {
    const metadata = this.validateRegistration(input), id = randomUUID();
    const name = toUntrusted(metadata.client_name, 64);
    await this.db.tx(async tx => {
      await tx.sql.query('INSERT INTO oauth_clients(id,client_name,redirect_uris) VALUES($1,$2::jsonb,$3::jsonb)',
        [id, JSON.stringify(name), JSON.stringify(metadata.redirect_uris)]);
      await tx.sql.query('INSERT INTO audit_log(action,data) VALUES($1,$2::jsonb)',
        ['oauth.register', JSON.stringify({ clientId: id, metadataDocument: false })]);
    });
    // RFC 7591 echoes client_name as a string; all stored/consent-facing names are Untrusted.
    return { ...metadata, client_name: name.text, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) };
  }
  /**
   * Validate registered/live or locally verified snapshot clients, exact redirects, required scopes,
   * state, S256 PKCE and resource; persist a ten-minute request and return consent URL. Anonymous
   * discovery request, not user consent. Invalid requests reject with OAuthDiscoveryError; redirects
   * are attached only after validation, and SQL failures reject. No caller URL is fetched and no
   * authorization code is issued.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  async authorize(query: unknown) {
    const q = query as Record<string, unknown>;
    if (!q || typeof q !== 'object' || Array.isArray(q) || !bounded.safeParse(q.client_id).success) {
      throw new OAuthDiscoveryError('invalid_request');
    }
    const clientId = q.client_id as string;
    const doc = this.documents.get(clientId);
    let client: ClientRow | undefined;
    if (doc) client = { id: clientId, client_name: toUntrusted(doc.client_name, 64), redirect_uris: doc.redirect_uris };
    else {
      // URL-shaped IDs cannot bypass the verified snapshot registry via a stale stored row.
      if (clientId.includes(':')) throw new OAuthDiscoveryError('invalid_client');
      client = (await this.db.sql.query<ClientRow>(
        "SELECT id,client_name,redirect_uris FROM oauth_clients WHERE id=$1 AND last_used_at > now() - interval '30 days'", [clientId])).rows[0];
    }
    if (!client) throw new OAuthDiscoveryError('invalid_client');
    if (typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)
      || !this.config.redirectAllowlist.includes(q.redirect_uri)) throw new OAuthDiscoveryError('invalid_redirect_uri');
    const redirect = q.redirect_uri;
    const state = bounded.safeParse(q.state).success ? q.state as string : undefined;
    const fail = (code: string): never => { throw new OAuthDiscoveryError(code, redirect, state); };
    if (q.response_type !== 'code') fail('unsupported_response_type');
    if (!state) fail('invalid_request');
    if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)
      || Buffer.from(q.code_challenge, 'base64url').toString('base64url') !== q.code_challenge || q.code_challenge_method !== 'S256') fail('invalid_request');
    if (q.resource !== undefined && q.resource !== this.config.publicUrl) fail('invalid_target');
    if (typeof q.scope !== 'string' || q.scope.length > 256 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(q.scope)) fail('invalid_scope');
    const scopes = [...new Set((q.scope as string).split(' '))];
    if (scopes.some(s => !OAUTH_SCOPES.includes(s as OAuthScope)) || REQUIRED_OAUTH_SCOPES.some(s => !scopes.includes(s))) fail('invalid_scope');
    const id = randomUUID();
    await this.db.tx(async tx => {
      if (doc) {
        const { rows } = await tx.sql.query(`INSERT INTO oauth_clients(id,client_name,redirect_uris,metadata_document)
          VALUES($1,$2::jsonb,$3::jsonb,true) ON CONFLICT(id) DO NOTHING RETURNING id`,
          [clientId, JSON.stringify(client.client_name), JSON.stringify(doc.redirect_uris)]);
        if (rows.length) await tx.sql.query('INSERT INTO audit_log(action,data) VALUES($1,$2::jsonb)',
          ['oauth.register', JSON.stringify({ clientId, metadataDocument: true })]);
        await tx.sql.query('UPDATE oauth_clients SET client_name=$2::jsonb,redirect_uris=$3::jsonb,last_used_at=now() WHERE id=$1',
          [clientId, JSON.stringify(client.client_name), JSON.stringify(doc.redirect_uris)]);
      } else {
        const { rows } = await tx.sql.query("UPDATE oauth_clients SET last_used_at=now() WHERE id=$1 AND last_used_at > now() - interval '30 days' RETURNING id", [clientId]);
        if (!rows.length) fail('invalid_client');
      }
      await tx.sql.query(`INSERT INTO oauth_requests(id,client_id,redirect_uri,code_challenge,code_challenge_method,state,scopes,resource,expires_at)
        VALUES($1,$2,$3,$4,'S256',$5,$6::jsonb,$7,now()+interval '10 minutes')`,
        [id, clientId, redirect, q.code_challenge, state, JSON.stringify(scopes), this.config.publicUrl]);
    });
    return `${this.config.webOrigin}/oauth/consent?request=${id}`;
  }
  /** Internal consent integration boundary; expired requests are never returned, even before cleanup.
   * @remarks
   * Read only a valid UUID's unexpired consent request joined with client name, or null. Internal
   * consent integration must authenticate the owner separately; SQL failures reject. This read does
   * not consent or issue tokens.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  async request(id: string): Promise<StoredOAuthRequest | null> {
    if (!z.uuid().safeParse(id).success) return null;
    return (await this.db.sql.query<StoredOAuthRequest>(`SELECT r.*, c.client_name FROM oauth_requests r
      JOIN oauth_clients c ON c.id=r.client_id WHERE r.id=$1 AND r.expires_at > now()`, [id])).rows[0] ?? null;
  }
  /**
   * Invoke transactional expiry cleanup for requests, inactive clients and registration limits. Host
   * housekeeping only; SQL failures reject.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
   */
  async prune() {
    await pruneOAuthDiscovery(this.db);
  }
}

/** Housekeeping also runs while the hosted connector is disabled.
 * @remarks
 * Transactionally remove expired requests, clients inactive thirty days and expired registration
 * counters even when hosted connector is disabled. Host housekeeping only; SQL failures reject; it
 * does not revoke implemented access tokens.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | SIWE and session invariants}
 */
export async function pruneOAuthDiscovery(db: DbHandle['chain']) {
  await db.tx(async tx => {
    await tx.sql.query('DELETE FROM oauth_requests WHERE expires_at <= now()');
    await tx.sql.query("DELETE FROM oauth_clients WHERE last_used_at <= now() - interval '30 days'");
    await tx.sql.query("DELETE FROM oauth_registration_limits WHERE attempts[cardinality(attempts)] <= now() - interval '1 hour'");
  });
}
