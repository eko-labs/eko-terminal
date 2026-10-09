import { fatalExit, installFatalHandlers } from './fatal.js';
import { buildApp } from './app.js';
import { startDev } from './dev.js';
import { loadConfig } from './config.js';
import { reportError } from './obs/errors.js';
import { logger } from './obs/logger.js';
import { workerSecurityCollectors } from './obs/security-worker.js';
import { runtimeIdentity } from './build-identity.js';

installFatalHandlers();

async function main() {
  const cfg = loadConfig();
  const identity = runtimeIdentity(cfg);
  if (!process.env.SESSION_SECRET) logger.warn('SESSION_SECRET not set — using a generated development secret stored under .data/ (never do this in production).');

  let closeApp: (() => Promise<void>) | undefined;
  let startupResolve!: () => void;
  const startupReady = new Promise<void>(resolve => { startupResolve = resolve; });
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await startupReady;
    await closeApp?.().catch((err) => reportError(err, { where: 'shutdown' }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const workerOnly = cfg.APP_ROLE === 'worker';
  const { app, ctx, close } = await buildApp(cfg, workerOnly ? { startBackground: false } : {});
  const securityCollectors = workerOnly ? workerSecurityCollectors(ctx) : undefined;
  if (workerOnly) { ctx.exec.start(); ctx.sanctionsWorker.start(); ctx.retentionWorker.start(); ctx.pricingRepair.start(); ctx.coinOnboarding.start(); ctx.blueChipListings.start(); }
  securityCollectors?.start();
  const dev = cfg.APP_ROLE === 'dev' ? await startDev(ctx) : undefined;
  closeApp = async () => { try { await securityCollectors?.stop(); await dev?.close(); } finally { await close(); } };
  void dev?.done.catch(() => fatalExit('unhandledRejection'));
  if (!shuttingDown) await app.listen({ host: workerOnly ? '127.0.0.1' : cfg.HOST, port: cfg.PORT });
  startupResolve();
  logger.info(
    {
      port: cfg.PORT,
      identity,
      db: ctx.dbh.driver,
      marketData: ctx.market.source,
      simulated: ctx.market.simulated,
      liveTrading: cfg.LIVE_TRADING_ENABLED,
      aiProviders: ctx.providers.healthList().filter((p) => p.configured).map((p) => p.id),
    },
    workerOnly ? 'EKO worker ready' : 'EKO server ready',
  );
}

void main().catch(() => fatalExit('startup'));
