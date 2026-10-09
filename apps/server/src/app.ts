import { withRpcOrigin } from '@eko/chain';
import { loopHealth, type LoopHeartbeat } from './loop-health.js';
import { installRateLimitObservations, pluginRejectionObserver } from './obs/rate-limits.js';
import { BlueChipListingWorker } from './blue-chip-listings.js';
import { BlueChipReader, blueChipConfig } from './read/blue-chip.js';
import { phaseAt } from './harness/entitlements.js';
import { FileJournalDestructionLedger, migrate, migrateEngines, PostgresBus, ReceiptApiStore } from '@eko/db';
import { ReadStore } from './read/store.js';
import { readServices } from './http/v1/reads.js';
import { ReadLive } from './read/live.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { MARKETS, type ServerMessage, type SystemHealth } from '@eko/shared';
import { InferenceBudget } from './ai/budget.js';
import { ProviderRegistry } from './ai/registry.js';
import type { Config } from './config.js';
import { proxyTrust } from './proxy-trust.js';
import { openDb, runMigrations, type DbHandle } from './db/client.js';
import { LatencyStore } from './obs/telemetry.js';
import { ChainClients, UniswapV3Adapter } from './exec/chain.js';
import { PortfolioService } from './exec/portfolio.js';
import { SanctionsService, SanctionsWorker } from './sanctions/service.js';
import { RetentionWorker } from './retention-worker.js';
import { PricingRepairWorker, chainTokenMeta, type TokenSpot } from './pricing-repair.js';
import { CoinOnboardingWorker, chainOnboarding } from './coin-onboarding.js';
import { bestUsdgPool, isTransientRpcUnavailable, rpcStopReason, usdgPoolPrice, type SpotRpc, type UsdgPool } from '@eko/chain';
import { QuoteStore } from './exec/quotes.js';
import { TradeService, type TradeBackend } from './exec/trades.js';
import { SellGuard } from './exec/sell-guard.js';
import { liveTradeBackend, readModelVerdicts, type LiveTradeOverrides } from './exec/live-trade.js';
import { ExecutionService } from './exec/service.js';
import { JournalService } from './harness/journal.js';
import { PointsService } from './points/service.js';
import { HarnessService } from './harness/service.js';
import { auditTradeConfig, TradeAccessService } from './exec/trade-access.js';
import { AuthService } from './http/auth.js';
import { addressKey, addressLimit } from './http/address-limit.js';
import { registerRoutes } from './http/routes.js';
import { FlagService } from './flags/service.js';
import { ghostReportRoutes } from './http/ghost-reports.js';
import { GhostReportStore } from '@eko/db';
import { guardReadRoutes } from './http/v2-guard.js';
import { reviewApiRoutes } from './http/review-api.js';
import { ReviewStore } from '@eko/db';
import { registerV1 } from './http/v1/index.js';
import { fixtureRoutes } from './http/v1/fixtures.js';
import { journalFixtureProducer } from './fixtures/producers.js';
import { installDemoGuard } from './http/v1/demo.js';
import { notFound } from './http/v1/helpers.js';
import { DemoFeed } from './market/demoFeed.js';
import { storedFeed } from './market/stored.js';
import { MarketDataService } from './market/service.js';
import type { Feed } from './market/types.js';
import { initErrorReporting, reportError } from './obs/errors.js';
import { logger } from './obs/logger.js';
import { metrics } from './obs/metrics.js';
import { LaunchMonitor, type Measurement } from './obs/launch.js';
import { IncidentService, sentryIncidentSink, type AlertSink } from './obs/incidents.js';
import { launchMonitoringRoutes } from './http/launch-monitoring.js';
import { QuantService } from './quant/service.js';
import { Hub } from './ws/hub.js';
import { WatchAlertsService } from './alerts/service.js';
import { TelegramLinkService } from './telegram/link.js';
import { createOgRenderer, type OgRenderer } from '@eko/og-renderer';
import { BagsService } from './read/bags.js';
import { registerShareRoutes, ShareService, spaDocument, webHeaders } from './http/share.js';
import { securityTxtRoutes } from './http/security-txt.js';

export const VERSION = '0.1.0';

export interface Ctx {
  cfg: Config;
  flags: FlagService;
  tradeAccess: TradeAccessService;
  sanctions: SanctionsService;
  sanctionsWorker: SanctionsWorker;
  retentionWorker: RetentionWorker;
  pricingRepair: PricingRepairWorker;
  coinOnboarding: CoinOnboardingWorker;
  blueChipListings: BlueChipListingWorker;
  dbh: DbHandle;
  reads: ReturnType<typeof readServices>;
  hub: Hub;
  market: MarketDataService;
  providers: ProviderRegistry;
  budget: InferenceBudget;
  chains: ChainClients;
  exec: ExecutionService;
  portfolio: PortfolioService;
  quant: QuantService;
  auth: AuthService;
  harness: HarnessService;
  journal: JournalService;
  points: PointsService;
  receipts: ReceiptApiStore;
  alerts: WatchAlertsService;
  telegram: TelegramLinkService;
  demoFeed: DemoFeed | null;
  monitoring: LaunchMonitor;
  incidents: IncidentService;
  health(): SystemHealth;
  loopHealth(): ReturnType<typeof loopHealth>;
}

/** Requests per minute from one client address across all of its sessions (each session keeps 600). */
export const ADDRESS_REQUESTS_PER_MINUTE = 1800;

/**
 * Build Fastify, open/migrate storage, wire auth/market/execution/public-share routes (including
 * optional trusted trade acquisition and OG rendering) and optionally start
 * background services. Host configuration/dependency injection only; individual routes enforce
 * caller auth. Startup/plugin/database failures reject; app close handles resources through the
 * returned lifecycle API.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function buildApp(cfg: Config, opts: { feed?: Feed; startBackground?: boolean; ogRenderer?: OgRenderer; alertSinks?: { page?: AlertSink; sentry?: AlertSink }; tradeBackend?: TradeBackend; tradeOverrides?: LiveTradeOverrides } = {}): Promise<{ app: FastifyInstance; ctx: Ctx; close(): Promise<void> }> {
  initErrorReporting(cfg.SENTRY_DSN, cfg.NODE_ENV);
  const dbh = await openDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
  await runMigrations(dbh);
  await migrate(dbh.chain);
  await migrateEngines(dbh.chain);
  const points = new PointsService(dbh.chain,cfg.POINTS_RATES,cfg.POINTS_ACTIVE_FROM);
  const reads = readServices(new ReadStore(dbh.chain,Date.now,{liquidityProbeKeys:cfg.READ_LIQUIDITY_PROBE_KEYS}),points,()=>phaseAt(cfg,Date.now()));
  reads.store.blueChip = new BlueChipReader(dbh.chain,blueChipConfig(cfg));
  const blueChipListings = new BlueChipListingWorker(dbh.chain,cfg.BLUE_CHIP_ENABLED,undefined,Date.now,success=>logger[success ? 'info' : 'warn']({success},'Blue chip listing refresh'));
  reads.store.sellCheckQuotes = cfg.SELL_CHECK_ENABLED;
  // Not refreshed here: the API's background refresher catches the projection up while requests read it as it stands,
  // and processes without one refresh on their first read. A startup refresh held every deploy (and the worker, which
  // serves no reads) on the whole backlog, 45 minutes after a scanner catch-up on 2026-10-09, under the refresh lock.
  const db = dbh.db;
  const flags = FlagService.fromDb(db, cfg.FLAGS);
  await flags.all();
  const tradeAccess = TradeAccessService.fromDb(cfg, flags, db);
  await auditTradeConfig(db, cfg);
  const sanctions = new SanctionsService(dbh.chain);
  const sanctionsWorker = new SanctionsWorker(dbh.chain, cfg.OFAC_SDN_URL, undefined, Date.now,
    failed => logger[failed ? 'warn' : 'info']({ failed }, 'Sanctions dataset refresh'));
  const retentionWorker = new RetentionWorker(dbh.chain, { enabled:cfg.RETENTION_ENABLED,swapDays:cfg.RETENTION_SWAP_DAYS,transferDays:cfg.RETENTION_TRANSFER_DAYS, settleHours:cfg.RETENTION_SETTLE_HOURS,rawDays:cfg.RETENTION_RAW_DAYS,ratingDays:cfg.RETENTION_RATING_DAYS,receiptHours:cfg.RETENTION_RECEIPT_HOURS,receiptKeepCurrent:cfg.RETENTION_RECEIPT_KEEP_CURRENT,dryRun:cfg.RETENTION_DRY_RUN,
    quoteDays: cfg.RETENTION_QUOTE_TRANSFER_DAYS,
    idleTokenDays: cfg.RETENTION_IDLE_TOKEN_DAYS, pendingPoolDays: cfg.RETENTION_PENDING_POOL_DAYS ?? cfg.RETENTION_RAW_DAYS, feedDays: cfg.RETENTION_FEED_DAYS,
    dangerQuietDays: cfg.RETENTION_DANGER_QUIET_DAYS, quietCoinDays: cfg.RETENTION_QUIET_COIN_DAYS },
    result => {
      if(!('failed' in result))for(const table of result.tables ?? [])logger.info({dryRun:result.dryRun ?? false,...table},
        `retention dry_run=${result.dryRun ?? false} table=${table.table} rows=${table.rows} estimated_bytes=${table.estimatedBytes}`);
      if(!('failed' in result))for(const partition of result.partitions ?? [])logger.info(partition,`retention table=${partition.table} partition=${partition.partition} rows=${partition.rows} seconds=${partition.seconds}`);
      if(!('failed' in result))for(const [rule,stats] of Object.entries(result.ruleStats ?? {}))logger.info({rule,...stats},`retention rule=${rule} rows=${stats.rows} skipped=${stats.skipped} timeouts=${stats.timeouts} batch_rows=${stats.batchRows}`);
      if(!('failed' in result))for(const skip of result.partitionSkips ?? [])logger.info(skip,'Retention partition skipped');
      logger['failed' in result ? 'warn' : 'info']({retention:result},'Chain retention pass');
    });



  const monitoring = new LaunchMonitor(dbh.chain.sql);
  const incidents = new IncidentService(db, opts.alertSinks ?? (cfg.SENTRY_DSN ? { sentry: sentryIncidentSink } : {}));
  const launchMetricMap: Record<string, Measurement['metric']> = {
    'quote.latency_ms': 'quote_ms', 'harness.preflight_ms': 'preflight_ms', 'simulation.failure': 'simulation_failure',
    'scan.pair_to_complete_verdict_ms': 'pair_to_complete_verdict_ms', 'queue.completion_ms': 'queue_completion_ms',
  };

  // Persist latency samples in small batches so measurements survive restarts.
  const latencyStore = new LatencyStore(db);
  metrics.setSink((metric, valueMs, labels, at) => {
    latencyStore.record(metric, valueMs, labels, at);
    const launchMetric = launchMetricMap[metric];
    // Paper quotes are fixtures, never launch latency evidence.
    if (launchMetric && (!labels.mode || labels.mode === 'live')) void monitoring.record({ metric: launchMetric, value: valueMs }).catch(() => reportError(new Error('launch_measurement_write_failed')));
  });
  const flushSamples = setInterval(() => {
    void latencyStore.flush().catch(() => reportError(new Error('latency_flush_failed')));
  }, 10_000);

  const hub = new Hub({
    windowMs: cfg.WS_WINDOW_MS,
    messagesPerWindow: cfg.WS_MESSAGES_PER_WINDOW,
    hardMessagesPerWindow: cfg.WS_HARD_MESSAGES_PER_WINDOW,
    snapshotsPerConnection: cfg.WS_SNAPSHOTS_PER_CONNECTION,
    snapshotsGlobal: cfg.WS_SNAPSHOTS_GLOBAL,
    snapshotQueue: cfg.WS_SNAPSHOT_QUEUE,
  });
  const alerts = new WatchAlertsService(dbh.chain, hub);
  const telegram = new TelegramLinkService(dbh.chain, cfg.TELEGRAM_BOT_HANDLE);
  const demoFeed = opts.feed instanceof DemoFeed ? opts.feed : cfg.MARKET_DATA_SOURCE === 'demo' && !opts.feed ? new DemoFeed(cfg.DEMO_SEED) : null;
  const feed: Feed = opts.feed ?? demoFeed ?? storedFeed;
  const market = new MarketDataService(feed, db, MARKETS);
  const providers = new ProviderRegistry(cfg);
  const budget = new InferenceBudget(db, cfg.AI_DAILY_BUDGET_USD, cfg.AI_MAX_CALLS_PER_BOT_HOUR);
  const chains = new ChainClients({ mainnet: cfg.RH_MAINNET_RPC_URL, testnet: cfg.RH_TESTNET_RPC_URL }, cfg, dbh.rpcUsage, dbh.chain);
  chains.meter.start();
  // Swaps quoted in a token with no indexed price are priced at its Uniswap v3 USDG pool (repricePoolQuotes). A reverted
  // or undecodable read (no pool at that block) is no price; budget stops and transient provider failures are retried.
  const usdgPools = new Map<string, Promise<UsdgPool | null>>();
  const tokenSpot: TokenSpot = async (token, decimals, block) => {
    const mainnet = chains.get('robinhood-mainnet','worker.pricing_spot'), client: SpotRpc = { request: input => withRpcOrigin('server.app.rawL199',()=>mainnet.request(input as never)) };
    try {
      let pool = usdgPools.get(token);
      if (!pool) { pool = bestUsdgPool(client, token as `0x${string}`, block, undefined, true).then(found => found.pool); usdgPools.set(token, pool); pool.catch(() => usdgPools.delete(token)); }
      const found = await pool;
      return found ? await usdgPoolPrice(client, found, decimals, block) : null;
    } catch (error) {
      if (rpcStopReason(error) || isTransientRpcUnavailable(error)) throw error;
      return null;
    }
  };
  const tokenMeta = chainTokenMeta(() => chains.get('robinhood-mainnet','worker.pricing_metadata'));
  const pricingRepair = new PricingRepairWorker(dbh.chain, (event, fields) => logger.info({ event, ...fields }, event), undefined, undefined, undefined, undefined, undefined, tokenSpot, tokenMeta);
  // Onboarding reads (token metadata, first mint, its sender) go through the metered client like the pricing reads
  // above: four or five per coin, with their own daily ceiling (chainOnboarding). The public RPC answers most requests
  // from this host's Node services with an HTTP 403 challenge (2026-10-13: seven of eight), so it cannot carry them.
  const coinOnboarding = new CoinOnboardingWorker(dbh.chain, chainOnboarding(() => chains.get('robinhood-mainnet','worker.onboarding')),
    (event, fields) => logger.info({ event, ...fields }, event));
  const receipts = new ReceiptApiStore(dbh.chain, cfg.RECEIPTS_REGISTRY_ADDRESS, chains.get('robinhood-mainnet','server.receipts'));
  const portfolio = new PortfolioService(db);
  const quotes = new QuoteStore();
  const auth = new AuthService(db, cfg);
  const destruction = cfg.JOURNAL_TOMBSTONE_PATH ? new FileJournalDestructionLedger(cfg.JOURNAL_TOMBSTONE_PATH) : undefined;
  const journal = new JournalService(dbh.chain, destruction, cfg.JOURNAL_KEK && cfg.JOURNAL_KEK_ID
    ? { kek: Buffer.from(cfg.JOURNAL_KEK, 'hex'), id: cfg.JOURNAL_KEK_ID } : undefined, undefined, undefined, points);
  const harness = new HarnessService(db, cfg.HARNESS_KEY_PEPPER, (accountId, agent) => hub.publishAgent(accountId, agent),
    destruction ? accountId => !!destruction.destroyedAt(accountId) : undefined);

  let lastHealthJson = '';
  const health = (): SystemHealth => ({
    marketData: market.health(),
    providers: providers.healthList(),
    networks: chains.healthList(),
    worker: { running: cfg.RUN_WORKER && opts.startBackground !== false, lastTickAt: null, activeBots: 0 },
  });
  const pushHealth = () => {
    const h = health();
    const j = JSON.stringify({ ...h, worker: { ...h.worker, lastTickAt: null } });
    if (j === lastHealthJson) return;
    lastHealthJson = j;
    hub.broadcast({ type: 'health', health: h });
  };

  // Live v1 trade acquisition (api quotes/orders, worker reconciliation). Fail-closed: with LIVE_TRADING_ENABLED off,
  // or without the pinned-block RPC and simulation host, there is no backend and quotes refuse with the reason.
  const liveTrade = liveTradeBackend(cfg, { chains: () => chains, sql: () => dbh.chain.sql, verdict: readModelVerdicts(reads, () => dbh.chain.sql) }, opts.tradeOverrides);
  if (cfg.LIVE_TRADING_ENABLED && !liveTrade.backend && !opts.tradeBackend) logger.warn({ missing: liveTrade.missing }, 'Live trade backend unavailable; v1 trade quotes refuse');
  const ethUsd = () => market.lastPrice('ETH-USD')?.price ?? null;
  const exec = new ExecutionService(
    db,
    market,
    portfolio,
    quotes,
    {
      testnet: new UniswapV3Adapter(chains, 'robinhood-testnet', ethUsd),
      live: new UniswapV3Adapter(chains, 'robinhood-mainnet', ethUsd),
    },
    { liveEnabled: cfg.LIVE_TRADING_ENABLED, paperFeeBps: 10, tradeAccess, sanctions,
      // Open native Pons curves (exec/pons-trade.ts), indexed v3 pools, then native v4 pools (exec/v4-trade.ts) when v3 has no route.
      trades: new TradeService(db, tradeAccess, sanctions, opts.tradeBackend ?? liveTrade.backend, Date.now, { incidents, onOrder: (acc, order) => hub.publishOrder(acc, order),
        unavailable: liveTrade.unavailable || undefined,
        // Live buys always need a sellable reading: a recent stored one, else a quote-time probe when SELL_CHECK_ENABLED.
        requireSellCheck: Boolean(liveTrade.backend),
        ...(cfg.SELL_CHECK_ENABLED || liveTrade.backend ? { sellGuard: new SellGuard(dbh.chain, { getBlockNumber: () => chains.get('robinhood-mainnet').getBlockNumber(),
          request: input => chains.get('robinhood-mainnet').request(input as never) }, Date.now, { probe: cfg.SELL_CHECK_ENABLED }) } : {}) }) },
    {
      onOrder: (acc, o) => hub.toAccount(acc, { type: 'order', order: o }),
      onPortfolio: (acc, mode) => hub.toAccount(acc, { type: 'portfolio', mode }),
    },
  );
  const quant = new QuantService(market);
  const roleLoopHealth = () => {
    const loops: Record<string, LoopHeartbeat> = {};
    if (cfg.APP_ROLE !== 'worker') {
      loops.refresher = reads.store.heartbeat;
      loops.ranks = reads.store.rankHeartbeat;
      loops.summaries = reads.store.summaryHeartbeat;
    }
    if (cfg.APP_ROLE === 'worker' || cfg.APP_ROLE === 'dev' && cfg.RUN_WORKER) {
      if (retentionWorker.enabled) loops.retention = retentionWorker.heartbeat;
      if (retentionWorker.partitionsEnabled) loops.partitions = retentionWorker.partitionHeartbeat;
      loops.pricingRepair = pricingRepair.heartbeat;
      if (cfg.APP_ROLE === 'worker') loops.onboarding = coinOnboarding.heartbeat;
    }
    return loopHealth(loops);
  };
  const ctx: Ctx = { cfg, flags, tradeAccess, sanctions, sanctionsWorker, retentionWorker, pricingRepair, coinOnboarding, blueChipListings, dbh, reads, hub, market, providers, budget, chains, exec, portfolio, quant, auth, harness, journal, points, receipts, alerts, telegram, demoFeed, health, loopHealth: roleLoopHealth, monitoring, incidents };

  // Market data → WebSocket, throttled to ~4 Hz per stream (closed bars always go out immediately).
  const pendingCandles = new Map<string, Extract<ServerMessage, { type: 'candle' }>>();
  const pendingTickers = new Map<string, Extract<ServerMessage, { type: 'ticker' }>>();
  const pendingBooks = new Map<string, Extract<ServerMessage, { type: 'book' }>>();
  market.on('candle', (m, tf, c, closed) => {
    const msg = { type: 'candle' as const, market: m, timeframe: tf, candle: { ...c }, closed };
    if (closed) hub.broadcastCandle(msg);
    else pendingCandles.set(`${m}|${tf}`, msg);
  });
  market.on('ticker', (t) => pendingTickers.set(t.market, { type: 'ticker', ticker: t }));
  market.on('book', (b) => pendingBooks.set(b.market, { type: 'book', book: b }));
  hub.onSubscriptionsChanged = () => market.watchBooks([...hub.watchedMarkets()]);
  market.on('health', () => pushHealth());
  providers.onHealthChange = () => pushHealth();
  const flush = setInterval(() => {
    for (const m of pendingCandles.values()) hub.broadcastCandle(m);
    pendingCandles.clear();
    for (const m of pendingTickers.values()) hub.broadcast(m, true);
    pendingTickers.clear();
    for (const m of pendingBooks.values()) hub.broadcastBook(m);
    pendingBooks.clear();
  }, 250);
  const healthTimer = setInterval(() => {
    if (cfg.LEGACY_API && (cfg.RUN_WORKER || cfg.LIVE_TRADING_ENABLED)) void chains.checkHealth().then(pushHealth);
  }, 20_000);
  const heartbeat = setInterval(() => hub.broadcast({ type: 'health', health: health() }), 5_000);

  // ─────────────── HTTP ───────────────
  const app = Fastify({ logger: false, trustProxy: proxyTrust(cfg.TRUST_PROXY_HOPS), bodyLimit: 256 * 1024, routerOptions: { maxParamLength: 4096 } });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0]!.split('/').filter(Boolean).join('/') === 'oauth/consent') {
      reply.header('Content-Security-Policy', "frame-ancestors 'none'").header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'strict-origin');
    }
  });
  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(cors, { origin: cfg.origins, credentials: true, exposedHeaders: ['retry-after'] });
  const limitObservations = installRateLimitObservations(app);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => auth.readCookie(req) ?? addressKey(req.ip),
    allowList: (req) => req.url.startsWith('/assets/'),
    onExceeded: pluginRejectionObserver(limitObservations, req => !!auth.readCookie(req)),
  });
  // Sessions are free to mint, so one address also gets a ceiling across all of its sessions.
  app.addHook('onRequest', addressLimit(app, ADDRESS_REQUESTS_PER_MINUTE, req => req.url.startsWith('/assets/')));
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.decorateRequest('account', null);
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string; validation?: unknown };
    const status = e.statusCode ?? 500;
    if (status >= 500) reportError(err, { url: req.url, method: req.method });
    reply.status(status).send({ error: e.code && typeof e.code === 'string' && !e.code.startsWith('FST_') ? e.code : status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Internal error' : e.message });
  });
  installDemoGuard(app, cfg);
  // OAuth consent is prepared but omitted until 099 and the connector acceptance gate.
  await registerV1(app, cfg, flags, () => chains.meter.usage(), reads, { auth, db, client: chains.get('robinhood-mainnet') }, chains.get('robinhood-mainnet'), { auth, harness }, { auth, journal }, receipts, { auth, alerts }, latencyStore, exec, undefined, { auth, telegram }, roleLoopHealth);
  await fixtureRoutes(app, cfg, flags, cfg.JOURNAL_KEK && cfg.JOURNAL_KEK_ID && cfg.JOURNAL_TOMBSTONE_PATH
    ? { journal: journalFixtureProducer(journal) } : {}, auth);
  const live = new ReadLive(reads, hub);
  // The worker serves only loopback health. Without the background refresher, each bus message's live upsert refreshed the whole
  // read-model backlog inline there, under the locks every scanner card write needs (2026-10-09: about 7 cards a minute).
  await alerts.start(cfg.DATABASE_URL ? new PostgresBus(cfg.DATABASE_URL) : dbh.chain.bus, opts.startBackground !== false);
  await guardReadRoutes(app,reads.guard,reads);
  await reviewApiRoutes(app, new ReviewStore(dbh.chain), auth);
  await ghostReportRoutes(app, new GhostReportStore(dbh.chain), receipts);
  app.get('/v2/ws', { websocket: true }, (socket) => { hub.addV2(socket,async coin=>reads.guard.card(coin)); });
  app.get('/v1/ws', { websocket: true, preValidation: async (req) => {
    // Private subscriptions require an allowed Origin at the authenticated handshake.
    if (req.headers.origin) auth.originFor(req, true);
    req.account = req.headers.origin ? await auth.fromToken(auth.readCookie(req)) : null;
  } }, (socket, req) => {
    const account = req.account?.kind === 'wallet' ? req.account.id : undefined;
    hub.addV1(socket, account, account ? () => alerts.latestSeq(account) : undefined);
  });
  await registerRoutes(app, ctx);
  await launchMonitoringRoutes(app, ctx);

  // Missing runtime assets remain explicit; never substitute another image or font.
  const ogRenderer = opts.ogRenderer ?? await createOgRenderer().catch(() => undefined);
  const shares = new ShareService(cfg.origins[0], { scan: reads.scan, coins: reads.coins,
    bags: new BagsService(reads.store, db, chains.get('robinhood-mainnet','server.bags')), receipts }, ogRenderer);
  app.addHook('onClose', async () => { if (!opts.ogRenderer) await ogRenderer?.close(); });
  await registerShareRoutes(app, shares);
  await securityTxtRoutes(app);
  let serveSpa: Awaited<ReturnType<typeof spaDocument>> | null = null;
  if (cfg.SERVE_WEB) {
    const dist = resolve(process.cwd(), cfg.WEB_DIST_DIR);
    if (existsSync(dist)) {
      serveSpa = await spaDocument(resolve(dist, 'index.html'));
      await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false, index: false, globIgnore: ['**/index.html'], maxAge: '1h', immutable: false });
      // The marketing landing is its own build: its document at "/", its assets and docs under /site/, and the
      // terminal keeps every other path. Without a landing build, "/" stays the terminal's own entry page.
      const landing = cfg.LANDING_DIST_DIR ? resolve(process.cwd(), cfg.LANDING_DIST_DIR) : null;
      if (landing && existsSync(resolve(landing, 'index.html'))) {
        const page = (html: string) => (req: { url: string }, reply: FastifyReply) => {
          webHeaders(reply, cfg, 'no-cache', req.url.split('?')[0]);
          return reply.type('text/html; charset=utf-8').send(html);
        };
        await app.register(fastifyStatic, { root: landing, prefix: '/site/', decorateReply: false, wildcard: false, index: false, globIgnore: ['**/*.html'], maxAge: '1h', immutable: false });
        app.get('/', page(await readFile(resolve(landing, 'index.html'), 'utf8')));
        if (existsSync(resolve(landing, 'docs.html'))) app.get('/site/docs.html', page(await readFile(resolve(landing, 'docs.html'), 'utf8')));
      } else app.get('/', (req, reply) => serveSpa!(req.url, reply, cfg, shares));
      app.get('/index.html', (req, reply) => serveSpa!(req.url, reply, cfg, shares));
    } else logger.warn({ dist }, 'SERVE_WEB set but web build not found');
  }
  app.setNotFoundHandler((req, reply) => {
    if (!serveSpa || ['/v1', '/v2', '/og', '/api', '/ws', '/dev', '/site/', '/.well-known/'].some(prefix => req.url.startsWith(prefix))) return notFound(reply);
    return serveSpa(req.url, reply, cfg, shares);
  });

  // Boot reads committed snapshots before projection writer timers are started.
  await reads.store.refreshSummaries();

  if (opts.startBackground !== false) {
    reads.store.start();
    reads.scoreboard.start();
    await market.start();
    if (cfg.RUN_WORKER) {
      exec.start();
      if (cfg.APP_ROLE === 'worker' || cfg.APP_ROLE === 'dev') { sanctionsWorker.start(); retentionWorker.start(); pricingRepair.start(); }
      if (cfg.APP_ROLE === 'worker') { coinOnboarding.start(); blueChipListings.start(); }
    } else logger.info('RUN_WORKER=false — API-only process (no order reconciler)');
    if (cfg.LEGACY_API && (cfg.RUN_WORKER || cfg.LIVE_TRADING_ENABLED)) void chains.checkHealth().then(pushHealth);
  }

  // Subscribe after priming and starting projection timers so boot events cannot refresh inline.
  if (cfg.APP_ROLE !== 'worker') await live.start(cfg.DATABASE_URL ? new PostgresBus(cfg.DATABASE_URL) : dbh.chain.bus);

  return {
    app,
    ctx,
    /**
     * Clear app timers, close live/alert/read services, stop execution/sanctions/market work, close
     * sockets/Fastify and flush telemetry/meter before database release. Host lifecycle call; shutdown
     * errors reject and an early failure may prevent later cleanup. This does not cancel externally
     * signed transactions.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
     */
    async close() {
      clearInterval(flush);
      clearInterval(healthTimer);
      clearInterval(heartbeat);
      clearInterval(flushSamples);
      await live.close();
      await alerts.close();
      await reads.scoreboard.close();
      await reads.store.close();
      exec.stop();
      await sanctionsWorker.stop();
      await retentionWorker.stop();
      await pricingRepair.stop();
      await coinOnboarding.stop();
      await blueChipListings.stop();
      market.stop();
      hub.closeAll();
      await app.close();
      try {
        await latencyStore.flush();
        await chains.meter.close();
      } finally { await dbh.close(); }
    },
  };
}
