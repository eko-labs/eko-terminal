import type { loopHealth } from '../../loop-health.js';
import type { RpcMeter } from '@eko/chain';
import type { PublicClient } from 'viem';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { FlagService } from '../../flags/service.js';
import { reportError } from '../../obs/errors.js';
import { packRoutes } from './packs.js';
import { configRoutes } from './config.js';
import { demoRoutes } from './demo.js';
import { readRoutes, type ReadServices } from './reads.js';
import { healthRoutes } from './health.js';
import { InputError, notFound, sendError } from './helpers.js';
import { accountRoutes, type AccountServices } from './account.js';
import { agentRoutes, type AgentServices } from './agents.js';
import { journalRoutes, type JournalServices } from './journal.js';
import { rpcRoutes } from './rpc.js';
import { TradeAccessService } from '../../exec/trade-access.js';
import { tradeAdminRoutes } from './trade-admin.js';
import type { ReceiptApiStore } from '@eko/db';
import { bagsRoutes } from './bags.js';
import { telemetryRoutes } from './telemetry.js';
import type { LatencyStore } from '../../obs/telemetry.js';
import type { ExecutionService } from '../../exec/service.js';
import { tradeRoutes } from './trade.js';
import { receiptRoutes } from './receipts.js';
import { watchRoutes, type WatchServices } from './watch.js';
import { telegramRoutes, type TelegramServices } from './telegram.js';
import { oauthConsentRoutes, type OAuthConsentServices } from './oauth.js';

/**
 * Register optional core v1 route groups under /v1 plus config/demo/health and the shared bounded
 * error envelope. Host call; each group owns its session/Origin/role checks. Registration and
 * dependency failures reject; generic request failures are reported except where groups override
 * private handling.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function registerV1(app: FastifyInstance, cfg: Config, flags: FlagService, rpcUsage: () => ReturnType<RpcMeter['usage']>, reads?: ReadServices, account?: AccountServices, rpc?: PublicClient, agents?: AgentServices, journal?: JournalServices, receipts?: ReceiptApiStore, watches?: WatchServices, telemetry?: LatencyStore, exec?: ExecutionService, oauth?: OAuthConsentServices, telegram?: TelegramServices, health?: () => ReturnType<typeof loopHealth>) {
  const access = account ? TradeAccessService.fromDb(cfg, flags, account.db) : new TradeAccessService(cfg, flags, async () => undefined);
  await app.register(async (v1) => {
    v1.setNotFoundHandler((_req, reply) => notFound(reply));
    v1.setErrorHandler((err, req, reply) => {
      if (err instanceof InputError) return sendError(reply, 'bad_request', err.message);
      const e = err as Error & { statusCode?: number };
      if (e.statusCode === 429) return sendError(reply, 'rate_limited', e.message);
      if (e.statusCode === 403) return sendError(reply, 'forbidden', e.message);
      if (e.statusCode === 401) return sendError(reply, 'wallet_auth_required', e.message);
      if (e.statusCode && e.statusCode < 500) return sendError(reply, 'bad_request', e.message);
      reportError(err, { where: 'v1', method: req.method });
      return sendError(reply, 'internal_error', 'Internal error');
    });
    if (telemetry) await v1.register(async area => telemetryRoutes(area, telemetry));
    if (reads) await v1.register(async area => readRoutes(area, reads, account?.auth));
    if (receipts) await v1.register(async area => receiptRoutes(area, receipts));
    if (watches) await v1.register(async area => watchRoutes(area, watches));
    if (telegram) await v1.register(async area => telegramRoutes(area, telegram));
    if (account) await v1.register(async area => accountRoutes(area, cfg, account));
    if (reads && account) await v1.register(async area => bagsRoutes(area, reads.store, account));
    if (journal) await v1.register(async area => journalRoutes(area, journal));
    if (oauth) await v1.register(async area => oauthConsentRoutes(area, cfg, oauth));
    if (agents) await v1.register(async area => agentRoutes(area, cfg, flags, agents));
    if (account && exec) await v1.register(async area => tradeRoutes(area, account, exec));
    if (account) await v1.register(async area => tradeAdminRoutes(area, cfg, account));
    if (rpc) await v1.register(async area => rpcRoutes(area, rpc));
    await v1.register(async area => healthRoutes(area, rpcUsage, cfg, () => reads ? reads.store.db.sql.query('SELECT 1') : Promise.reject(new Error('Database unavailable')), health, reads?.store.db));
    await v1.register(async area => packRoutes(area, cfg.MCP_PUBLIC_URL));
    await v1.register(async (area) => configRoutes(area, cfg, flags, access, account));
    await v1.register(async (area) => demoRoutes(area, cfg));
  }, { prefix: '/v1' });
}
