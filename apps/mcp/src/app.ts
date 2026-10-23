import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { Agent, Entitlements, OAuthScope } from '@eko/shared';
import type { RateLimits } from './limits.js';
import { ToolRegistry, toolContracts, toolSchemas, modelText, UNTRUSTED_NOTICE, type ToolContext } from './tools.js';
import { OAuthTokenError, type OAuthTokenService } from '../../server/src/harness/oauth-tokens.js';
import { HarnessError } from '../../server/src/harness/service.js';
import { OAuthDiscoveryError, type OAuthDiscovery } from './oauth.js';
import { proxyTrust } from '../../server/src/proxy-trust.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
const id = z.union([z.string().max(128), z.number().int()]);
const requestSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id, method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional() });
const notificationSchema = requestSchema.omit({ id: true });
const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id, result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal('2.0'), id, error: z.strictObject({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }),
]);
const rpcError = (id: string | number | null, code: number, message: string, data?: object) =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const tierRates = { listener: 30, reader: 120, oracle: 300, source: 600 } as const;
// Harness errors carry fixed server-authored messages (never request data). Add the next step
// for the human-only fixes an agent cannot make itself.
const harnessReason = (error: HarnessError) => error.message === 'Journal opt-in is required'
  ? 'Journal opt-in is required: ask the human to turn on the agent journal in EKO Settings, Privacy & data, then retry.'
  : `${error.message.replace(/\.$/, '')}.`;
class PrivateRequestLogs extends LogController { override disableRequestLogging = true; }

export interface McpDependencies {
  /** Resolve on EVERY request using the API-owned HMAC/revocation service. */
  authenticate(bearer: string): Promise<{ accountId: string; agent: Agent; keyId: string; scopes?: OAuthScope[] } | null>;
  entitlements(accountId: string): Promise<Entitlements> | Entitlements;
  limits: RateLimits;
  tools: ToolRegistry;
  publicUrl: string;
  trustProxyHops?: number;
  /** Prepared endpoints only; runtime omits them pending deployed connector acceptance. */
  oauth?: OAuthDiscovery;
  oauthTokens?: OAuthTokenService;
  allowedOrigins?: string[];
  close?(): Promise<void>;
}

/** Stateless Streamable HTTP: JSON POST responses; no GET stream or DELETE session.
 * @remarks
 * Build stateless Streamable HTTP POST transport with bounded bodies, protocol/schema checks, per-
 * IP/key/group limits and current bearer authentication on every transport request. API keys
 * use the injected harness authenticator; OAuth access tokens require the optional token service. Cookies
 * grant no tool access; agent must be active and entitled. Foreign Origin, malformed requests,
 * missing auth, denied entitlement, rate/storage/handler failures refuse with bounded responses.
 * Optional injected OAuth services register discovery/registration/authorization and token/revoke
 * routes; the production runtime omits them pending acceptance. No GET stream or DELETE session
 * is implemented.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function buildMcpApp(deps: McpDependencies, options: Pick<FastifyServerOptions, 'logger' | 'loggerInstance'> = {}) {
  const url = new URL(deps.publicUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) {
    throw new Error('MCP_PUBLIC_URL must be an HTTPS /mcp URL');
  }
  const app = Fastify({ ...options, trustProxy: proxyTrust(deps.trustProxyHops ?? 0), logController: new PrivateRequestLogs(), bodyLimit: 128 * 1024,
    requestTimeout: 30_000, forceCloseConnections: true, exposeHeadRoutes: false });
  const controller = new AbortController();
  const contexts = new WeakMap<object, ToolContext>();
  if (deps.oauthTokens && (!deps.oauth || deps.oauthTokens.config.resource !== deps.publicUrl)) throw new Error('OAuth token resource mismatch');
  if (deps.oauth && deps.oauth.config.publicUrl !== deps.publicUrl) throw new Error('OAuth resource mismatch');
  app.addHook('preClose', async () => { controller.abort(); });
  app.addHook('onClose', async () => { await deps.close?.(); });
  app.setErrorHandler<FastifyError>((error, _req, reply) => {
    // Neither raw parser errors nor provider/handler errors enter logs or responses.
    const status = error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415 : error.statusCode === 400 ? 400 : 503;
    reply.code(status).send(rpcError(null, status === 400 ? -32700 : -32603,
      status === 400 ? 'Parse error' : status === 503 ? 'Service unavailable' : 'Unsupported or oversized body'));
  });
  app.get('/health', async () => ({ ok: !controller.signal.aborted, transport: 'streamable-http', oauthEnabled: false }));
  if (deps.oauth) app.register(async oauthApp => {
    const oauth = deps.oauth!;
    oauthApp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      const params = new URLSearchParams(body as string);
      if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return done(new OAuthTokenError('invalid_request'));
      done(null, Object.fromEntries(params));
    });
    if (deps.oauthTokens) {
      oauthApp.post('/oauth/token', async (req, reply) => reply.header('Pragma', 'no-cache').send(await deps.oauthTokens!.exchange(req.body)));
      oauthApp.post('/oauth/revoke', async (req, reply) => {
        await deps.oauthTokens!.revoke(req.body);
        return reply.code(200).send();
      });
    }
    oauthApp.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (controller.signal.aborted) return reply.code(503).send({ error: 'temporarily_unavailable' });
      // TODO(spec): §9.1 gives only the DCR hourly budget. Use 60/min per IP
      // for OAuth routes until connector evidence defines their separate budgets.
      const limit = await deps.limits.consume(`oauth-ip:${req.ip}`, 60);
      if (!limit.allowed) return reply.header('Retry-After', limit.retryAfterSec).code(429).send({ error: 'rate_limited' });
    });
    oauthApp.setErrorHandler<FastifyError>((error, _req, reply) => {
      if (error instanceof OAuthTokenError) return reply.code(400).send({ error: error.code });
      if (error instanceof OAuthDiscoveryError) {
        const failure = error as OAuthDiscoveryError;
        if (failure.redirectUri) {
          const target = new URL(failure.redirectUri);
          target.searchParams.set('error', failure.code);
          if (failure.state) target.searchParams.set('state', failure.state);
          return reply.code(302).redirect(target.href);
        }
        return reply.code(400).send({ error: failure.code });
      }
      const status = [400, 413, 415].includes(error.statusCode ?? 0) ? error.statusCode! : 503;
      return reply.code(status).send({ error: status === 503 ? 'temporarily_unavailable' : 'invalid_request' });
    });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      oauthApp.get(path, async () => oauth.protectedResource());
    }
    oauthApp.get('/.well-known/oauth-authorization-server', async () => oauth.authorizationServer());
    oauthApp.post('/oauth/register', async (req, reply) => {
      const limit = await oauth.registrationLimit(req.ip);
      if (!limit.allowed) return reply.header('Retry-After', limit.retryAfterSec).code(429).send({ error: 'rate_limited' });
      return reply.code(201).send(await oauth.register(req.body));
    });
    oauthApp.get('/oauth/authorize', async (req, reply) => reply.code(302).redirect(await oauth.authorize(req.query)));
  });
  app.register(async transport => {
    transport.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (controller.signal.aborted) return reply.code(503).send(rpcError(null, -32603, 'Service unavailable'));
      const origin = req.headers.origin;
      if (origin !== undefined && ![url.origin, ...(deps.allowedOrigins ?? [])].includes(origin)) {
        return reply.code(403).send(rpcError(null, -32600, 'Origin refused'));
      }
      if (Object.keys(req.query as object).length) return reply.code(400).send(rpcError(null, -32600, 'Query parameters are unsupported'));
      const global = await deps.limits.consume(`ip:${req.ip}`, 600);
      if (!global.allowed) return reply.header('Retry-After', global.retryAfterSec).code(429)
        .send(rpcError(null, -32000, 'Rate limited', { retryAfterSec: global.retryAfterSec }));
      const match = /^Bearer (eko_(?:live|oat)_[0-9a-f]{16}_[A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '');
      const bearer = match?.[1];
      const identity = bearer?.startsWith('eko_oat_')
        ? await deps.oauthTokens?.authenticate(bearer, deps.publicUrl)
        : bearer ? await deps.authenticate(bearer) : null;
      if (!identity || identity.agent.status !== 'active' || !identity.accountId || !identity.keyId) {
        const challenge = deps.oauth ? `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` : 'Bearer realm="eko-mcp"';
        return reply.header('WWW-Authenticate', challenge).code(401).send(rpcError(null, -32001, 'Unauthorized'));
      }
      const entitlements = await deps.entitlements(identity.accountId);
      if (entitlements.limits.agents < 1) return reply.code(403).send(rpcError(null, -32003, 'Harness entitlement unavailable'));
      const control = await deps.limits.consume(`key:${identity.keyId}:requests`, 600);
      if (!control.allowed) return reply.header('Retry-After', control.retryAfterSec).code(429)
        .send(rpcError(null, -32000, 'Rate limited', { retryAfterSec: control.retryAfterSec }));
      contexts.set(req, { ...identity, entitlements, delayedSec: entitlements.limits.realtime ? 0 : 60, signal: controller.signal });
    });
    transport.route({ method: ['GET', 'DELETE'], url: '/mcp', handler: async (_req, reply) =>
      reply.header('Allow', 'POST').code(405).send(rpcError(null, -32600, 'Method not allowed')) });
    transport.post('/mcp', async (req, reply) => {
      const accept = (req.headers.accept ?? '').split(',').map(s => s.trim().split(';')[0]);
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return reply.code(406).send(rpcError(null, -32600, 'Accept must include application/json and text/event-stream'));
      }
      const version = req.headers['mcp-protocol-version'];
      if (version !== undefined && !PROTOCOL_VERSIONS.includes(version as typeof PROTOCOL_VERSIONS[number])) {
        return reply.code(400).send(rpcError(null, -32600, 'Unsupported protocol version'));
      }
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        if (notificationSchema.safeParse(req.body).success || responseSchema.safeParse(req.body).success) return reply.code(202).send();
        return reply.code(400).send(rpcError(null, -32600, 'Invalid Request'));
      }
      const { id: requestId, method, params } = parsed.data;
      const result = (value: object) => ({ jsonrpc: '2.0', id: requestId, result: value });
      if (method === 'initialize') {
        const init = z.object({ protocolVersion: z.string(), capabilities: z.record(z.string(), z.unknown()),
          clientInfo: z.object({ name: z.string(), version: z.string() }) }).safeParse(params);
        if (!init.success) return rpcError(requestId, -32602, 'Invalid params');
        return result({ protocolVersion: PROTOCOL_VERSIONS.includes(init.data.protocolVersion as typeof PROTOCOL_VERSIONS[number])
          ? init.data.protocolVersion : PROTOCOL_VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: 'eko-mcp', version: '0.1.0' }, instructions: UNTRUSTED_NOTICE });
      }
      if (method === 'ping') return result({});
      if (method !== 'tools/list' && method !== 'tools/call') return rpcError(requestId, -32601, 'Method not found');
      const ctx = contexts.get(req)!;
      const visible = await deps.tools.visible(ctx);
      if (method === 'tools/list') {
        if (!z.strictObject({ _meta: z.record(z.string(), z.unknown()).optional() }).safeParse(params ?? {}).success) return rpcError(requestId, -32602, 'Invalid params');
        return result({ tools: visible.map(({ name }) => ({ name, description: toolContracts[name].description,
          inputSchema: toolSchemas(name).input, outputSchema: toolSchemas(name).output,
          annotations: { readOnlyHint: toolContracts[name].readOnly, openWorldHint: false } })) });
      }
      const call = z.strictObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(),
        _meta: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
      if (!call.success) return rpcError(requestId, -32602, 'Invalid params');
      const tool = visible.find(t => t.name === call.data.name);
      if (!tool) return rpcError(requestId, -32602, 'Unknown or unavailable tool');
      const contract = toolContracts[tool.name];
      if (!contract.input.safeParse(call.data.arguments ?? {}).success) return rpcError(requestId, -32602, 'Invalid tool arguments');
      // TODO(spec): Launch-week tool quotas are not specified separately. Keep the
      // published Listener rate while honoring realtime launch entitlements; never invent unlimited calls.
      const max = contract.group === 'senses' ? tierRates[ctx.entitlements.tier]
        : ctx.entitlements.tier === 'listener' ? 60 : tierRates[ctx.entitlements.tier];
      const budget = await deps.limits.consume(`key:${ctx.keyId}:${contract.group}`, max);
      if (!budget.allowed) return reply.header('Retry-After', budget.retryAfterSec).code(429)
        .send(rpcError(requestId, -32000, 'Rate limited', { retryAfterSec: budget.retryAfterSec }));
      try {
        const structuredContent = await tool.invoke(call.data.arguments ?? {}, ctx);
        // TODO(spec): §9.1 specifies only a short templated content text. Clients such as Claude
        // Code give the model `content`, never structuredContent, so the second block mirrors the
        // result as JSON (MCP's backward-compatible form) with third-party text withheld.
        return result({ structuredContent, content: [{ type: 'text', text: `${contract.text} ${UNTRUSTED_NOTICE}` },
          { type: 'text', text: modelText(structuredContent) }], notice: UNTRUSTED_NOTICE });
      } catch (error) {
        // Only fixed, server-authored harness reasons are shown; other failures stay withheld.
        const reason = error instanceof HarnessError ? ` ${harnessReason(error)}` : '';
        return result({ isError: true, content: [{ type: 'text', text: `Tool unavailable.${reason} ${UNTRUSTED_NOTICE}` }], notice: UNTRUSTED_NOTICE });
      }
    });
  });
  return app;
}
