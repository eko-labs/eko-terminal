import { withRpcOrigin } from '@eko/chain';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Address, Hex, PublicClient } from 'viem';
import { formatUnits } from 'viem';
import { z } from 'zod';
import {
  AI_PROVIDERS,
  DEFAULT_LAYOUT,
  DEFAULT_PREFERENCES,
  InstantOrderSchema,
  MARKETS,
  NETWORKS,
  NETWORK_FOR_MODE,
  PlaceOrderSchema,
  PreferencesSchema,
  QuoteRequestSchema,
  RULE_STRATEGIES,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  TradingModeSchema,
  WorkspaceLayoutSchema,
  getMarket,
  routeFor,
  type BookResponse,
  type SparklinesResponse,
  type Timeframe,
} from '@eko/shared';
import type { Ctx } from '../app.js';
import { VERSION } from '../app.js';
import { accounts, inferenceRuns, journalEntries, preferences, workspaceLayouts } from '../db/schema.js';
import { ERC20_ABI } from '../exec/chain.js';
import { ExecError } from '../exec/service.js';
import { reportError } from '../obs/errors.js';
import { telemetryIngress } from './v1/telemetry.js';
import { BACKTEST_METHODOLOGY } from '../quant/service.js';
import type { Account } from './auth.js';
import { SESSION_COOKIE } from './auth.js';
import { sharedAddressLimit } from './address-limit.js';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, 'invalid_input', `${i?.path.join('.') || 'input'}: ${i?.message ?? 'invalid'}`);
  }
  return r.data;
}

/**
 * Register legacy core system/auth/market/order/paper/private-note endpoints. Read routes may be
 * public; private routes resolve sessions and execution services own wallet checks. Mutation
 * handlers check Origin; dev mutations require nonproduction configuration.
 * Validation/auth/execution failures become bounded HTTP responses; unexpected failures propagate
 * to the app handler.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx.dbh;

  const optionalAccount = async (req: FastifyRequest) => {
    req.account = await ctx.auth.fromToken(ctx.auth.readCookie(req));
    return req.account;
  };
  const requireAccount = async (req: FastifyRequest): Promise<Account> => {
    const a = await optionalAccount(req);
    if (!a) throw new HttpError(401, 'no_session', 'No session. Reload the app.');
    return a;
  };
  const sendExec = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ExecError) return reply.status(err.statusCode).send({ error: err.code, message: err.message, order: err.order });
    throw err;
  };
  const tight = (max: number, timeWindow = '1 minute') => ({ config: { rateLimit: { max, timeWindow } } });
  const loadPreferences = async (accountId: string) => {
    const [p] = await db.select().from(preferences).where(eq(preferences.accountId, accountId));
    return PreferencesSchema.parse({ ...DEFAULT_PREFERENCES, ...((p?.data as object) ?? {}) });
  };

  // ─────────────────────────── system ───────────────────────────

  /** Liveness: the process is up and serving HTTP. */
  app.get('/api/health/live', async () => ({ ok: true }));

  /** Readiness: market data backfilled and (if this process runs it) the worker is running. */
  app.get('/api/health/ready', async (_req, reply) => {
    const ready = ctx.market.ready && ctx.loopHealth().ok;
    return reply.status(ready ? 200 : 503).send({ ready, marketData: ctx.market.health().status });
  });

  app.get('/api/health', async (_req, reply) => {
    const h = ctx.health();
    const status = ctx.loopHealth();
    const ok = h.marketData.status === 'live' && status.ok;
    reply.code(ok ? 200 : 503);
    return { loops: status.loops, ok, service: 'eko', version: VERSION, ...h, uptimeSec: Math.round(process.uptime()), db: ctx.dbh.driver };
  });

  app.get('/api/metrics', async () => ({ metrics: (await import('../obs/metrics.js')).metrics.summary(), counters: (await import('../obs/metrics.js')).metrics.counters(), at: Date.now() }));

  // Retained operational ingress uses the same privacy boundary as CA-24.
  await app.register(async area => telemetryIngress(area, '/api/telemetry'));

  if (ctx.cfg.LEGACY_API) {
  app.get('/api/config', async () => ({
    version: VERSION,
    dataSource: ctx.market.source,
    simulatedData: ctx.market.simulated,
    liveTradingEnabled: await ctx.tradeAccess.liveEnabled(),
    devRoutes: ctx.cfg.ENABLE_DEV_ROUTES,
    markets: MARKETS.map((m) => ({
      ...m,
      routes: {
        testnet: routeFor(NETWORK_FOR_MODE.testnet, m.id),
        live: routeFor(NETWORK_FOR_MODE.live, m.id),
      },
    })),
    networks: NETWORKS,
    providers: AI_PROVIDERS.map((p) => {
      const r = ctx.providers.route(p.id);
      return { ...p, configured: ctx.providers.isConfigured(p.id), defaultModel: r.model, route: r.route, via: r.via };
    }),
    ai: {
      gateway: { configured: ctx.providers.gateway.configured, via: ctx.providers.gateway.via, baseUrl: ctx.providers.gateway.baseUrl },
      configuredProviders: AI_PROVIDERS.filter((p) => ctx.providers.isConfigured(p.id)).map((p) => p.id),
      setupCommand: 'pnpm setup:ai',
      budget: ctx.budget.limits,
    },
    strategies: {
      rules: Object.values(RULE_STRATEGIES).map((s) => ({ id: s.id, version: s.version, name: s.name, category: s.category, summary: s.summary, description: s.description, params: s.params, dataInputs: s.dataInputs })),
    },
    aiBudget: ctx.budget.limits,
    backtestMethodology: BACKTEST_METHODOLOGY,
  }));

  // ─────────────────────────── session / prefs ───────────────────────────

  app.get('/api/session', async (req, reply) => {
    const a = await ctx.auth.ensure(req, reply);
    await ctx.portfolio.ensurePaperAccount(a.id);
    const prefs = await loadPreferences(a.id);
    const [l] = await db.select().from(workspaceLayouts).where(and(eq(workspaceLayouts.accountId, a.id), eq(workspaceLayouts.name, 'default')));
    await db.update(accounts).set({ lastSeenAt: new Date() }).where(eq(accounts.id, a.id));
    return {
      account: a,
      preferences: prefs,
      layout: WorkspaceLayoutSchema.parse({ ...DEFAULT_LAYOUT, ...((l?.data as object) ?? {}) }),
      serverTime: Date.now(),
    };
  });

  app.put('/api/preferences', async (req) => {
    const a = await requireAccount(req);
    const data = parse(PreferencesSchema, req.body);
    await db.insert(preferences).values({ accountId: a.id, data }).onConflictDoUpdate({ target: preferences.accountId, set: { data, updatedAt: new Date() } });
    return { preferences: data };
  });

  app.put('/api/layout', async (req) => {
    const a = await requireAccount(req);
    const data = parse(WorkspaceLayoutSchema, req.body);
    await db
      .insert(workspaceLayouts)
      .values({ accountId: a.id, name: 'default', data })
      .onConflictDoUpdate({ target: [workspaceLayouts.accountId, workspaceLayouts.name], set: { data, updatedAt: new Date() } });
    return { layout: data };
  });

  // ─────────────────────────── SIWE ───────────────────────────

  app.get('/api/auth/nonce', tight(30), async (req) => {
    const a = await requireAccount(req);
    const origin = ctx.auth.originFor(req);
    return { nonce: await ctx.auth.nonce(a.id), domain: new URL(origin).host, uri: origin };
  });

  // Shares the v1 sign-in cap: a failed signature can fall back to an on-chain contract-wallet check.
  app.post('/api/auth/verify', { ...tight(20), preHandler: sharedAddressLimit(app, 'siwe-verify', 60) }, async (req, reply) => {
    const a = await requireAccount(req);
    const body = parse(z.object({ message: z.string().max(2000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }), req.body);
    const clients: Record<number, PublicClient> = {};
    for (const n of Object.values(NETWORKS)) clients[n.chainId] = ctx.chains.get(n.id);
    try {
      const account = await ctx.auth.verifySiwe(req, reply, a, body.message, body.signature as Hex, clients);
      return { account };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      throw new HttpError(e.statusCode ?? 401, 'siwe_failed', e.message);
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await ctx.auth.destroySession(ctx.auth.readCookie(req));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ─────────────────────────── market data ───────────────────────────

  app.get('/api/candles', async (req) => {
    const q = parse(
      z.object({
        market: z.string(),
        timeframe: z.enum(TIMEFRAMES),
        limit: z.coerce.number().int().min(10).max(2000).default(500),
        before: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const def = getMarket(q.market);
    if (!def) throw new HttpError(404, 'unknown_market', 'Unknown market');
    let candles = ctx.market.store.snapshot(q.market, q.timeframe, q.limit, q.before);
    if (q.before !== undefined && candles.length < q.limit) {
      // Page further back from storage / the feed's history API.
      const step = TIMEFRAME_SECONDS[q.timeframe];
      const older = await ctx.market.loadRange(def, q.timeframe, q.before - step * q.limit, q.before).catch(() => []);
      const have = new Set(candles.map((c) => c.time));
      candles = [...older.filter((c) => !have.has(c.time)), ...candles].sort((a, b) => a.time - b.time).slice(-q.limit);
    }
    return { market: q.market, timeframe: q.timeframe, candles, source: ctx.market.source, simulated: ctx.market.simulated, serverTime: Date.now() };
  });

  app.get('/api/tickers', async () => ({ tickers: ctx.market.allTickers(), health: ctx.market.health() }));

  app.get('/api/sparklines', async (): Promise<SparklinesResponse> => ({ sparklines: await ctx.market.sparklines(24) }));

  app.get('/api/book', tight(120), async (req): Promise<BookResponse> => {
    const q = parse(z.object({ market: z.string() }), req.query);
    if (!getMarket(q.market)) throw new HttpError(404, 'unknown_market', 'Unknown market');
    try {
      return { book: await ctx.market.book(q.market) };
    } catch (err) {
      throw new HttpError(502, 'book_unavailable', `Order book unavailable: ${(err as Error).message.slice(0, 120)}`);
    }
  });

  // ─────────────────────────── trading ───────────────────────────

  app.post('/api/quotes', tight(90), async (req, reply) => {
    const a = await requireAccount(req);
    const body = parse(QuoteRequestSchema, req.body);
    try {
      return { quote: await ctx.exec.quote(a.id, body) };
    } catch (err) {
      return sendExec(reply, err);
    }
  });

  app.post('/api/orders', tight(40), async (req, reply) => {
    const a = await requireAccount(req);
    const body = parse(PlaceOrderSchema, req.body);
    try {
      const r = await ctx.exec.place(a.id, a.walletAddress, body);
      return reply.status(r.duplicate ? 200 : 201).send(r);
    } catch (err) {
      return sendExec(reply, err);
    }
  });

  /** One-tap paper trade: quote and fill in one call. Live one-tap trades use quotes → orders → wallet. */
  app.post('/api/orders/instant', tight(40), async (req, reply) => {
    const a = await requireAccount(req);
    const body = parse(InstantOrderSchema, req.body);
    if (body.mode !== 'paper') throw new HttpError(409, 'paper_only', 'Instant orders are paper-only. Live trades are signed in your wallet.');
    try {
      const slippageBps = body.slippageBps ?? (await loadPreferences(a.id)).defaultSlippageBps;
      const r = await ctx.exec.instantPaper(a.id, { ...body, slippageBps });
      return reply.status(r.duplicate ? 200 : 201).send(r);
    } catch (err) {
      return sendExec(reply, err);
    }
  });

  app.post('/api/orders/:id/submitted', tight(40), async (req, reply) => {
    const a = await requireAccount(req);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ txHash: z.string(), walletMs: z.number().nonnegative().optional() }), req.body);
    try {
      return { order: await ctx.exec.markSubmitted(a.id, id, body.txHash, body.walletMs) };
    } catch (err) {
      return sendExec(reply, err);
    }
  });

  app.post('/api/orders/:id/rejected', tight(40), async (req, reply) => {
    const a = await requireAccount(req);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ code: z.string().max(40), message: z.string().max(300) }), req.body);
    try {
      return { order: await ctx.exec.markRejected(a.id, id, body.code, body.message) };
    } catch (err) {
      return sendExec(reply, err);
    }
  });

  app.get('/api/orders', async (req) => {
    const a = await requireAccount(req);
    const q = parse(z.object({ mode: TradingModeSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    return { orders: await ctx.exec.list(a.id, q.mode, q.limit) };
  });

  app.get('/api/portfolio', async (req) => {
    const a = await requireAccount(req);
    const q = parse(z.object({ mode: TradingModeSchema.default('paper') }), req.query);
    const marks = (m: string) => ctx.market.lastPrice(m)?.price ?? null;
    const [positions, fills, balances] = await Promise.all([
      ctx.portfolio.positions(a.id, q.mode, marks),
      ctx.portfolio.fills(a.id, q.mode),
      q.mode === 'paper' ? ctx.portfolio.paperBalances(a.id) : Promise.resolve([]),
    ]);
    return { mode: q.mode, positions, fills, balances };
  });

  app.post('/api/portfolio/paper/reset', tight(5), async (req) => {
    const a = await requireAccount(req);
    await ctx.portfolio.resetPaper(a.id);
    ctx.hub.toAccount(a.id, { type: 'portfolio', mode: 'paper' });
    return { ok: true };
  });

  /** Read-only on-chain balances for a wallet (ETH + route tokens + router allowance). */
  app.get('/api/chain/balances', tight(60), async (req) => {
    const q = parse(z.object({ mode: z.enum(['testnet', 'live']), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }), req.query);
    const net = NETWORKS[NETWORK_FOR_MODE[q.mode]];
    const client = ctx.chains.get(net.id);
    const addr = q.address as Address;
    try {
      const eth = await client.getBalance({ address: addr });
      const tokens = await Promise.all(
        Object.values(net.tokens).map(async (t) => {
          const [bal, allowance] = await Promise.all([
            withRpcOrigin('server.routes.L342',()=>client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] })),
            net.contracts.uniswapV3SwapRouter02 ? withRpcOrigin('server.routes.L343',()=>client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'allowance', args: [addr, net.contracts.uniswapV3SwapRouter02!] })) : Promise.resolve(0n),
          ]);
          return { symbol: t.symbol, address: t.address, amount: Number(formatUnits(bal, t.decimals)), routerAllowance: Number(formatUnits(allowance, t.decimals)) };
        }),
      );
      return { network: net.id, chainId: net.chainId, balances: [{ symbol: 'ETH', address: null, amount: Number(formatUnits(eth, 18)), routerAllowance: null }, ...tokens] };
    } catch (err) {
      throw new HttpError(502, 'rpc_error', `Could not read balances from ${net.name}: ${(err as Error).message.slice(0, 120)}`);
    }
  });

  // ─────────────────────────── quant ───────────────────────────

  app.post('/api/backtests', tight(20), async (req) => {
    const a = await requireAccount(req);
    const body = parse(
      z.object({
        strategyId: z.string(),
        params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
        market: z.string(),
        timeframe: z.enum(TIMEFRAMES),
        bars: z.number().int().min(100).max(5000).default(1000),
        assumptions: z
          .object({
            feeBps: z.number().min(0).max(200),
            slippageBps: z.number().min(0).max(200),
            allocation: z.number().min(0.01).max(1),
            useInvalidationStop: z.boolean(),
            maxHoldBars: z.number().int().min(0).max(500),
            inSampleFraction: z.number().min(0.1).max(0.95),
            startingEquity: z.number().positive().max(1e9),
          })
          .partial()
          .optional(),
      }),
      req.body,
    );
    const r = await ctx.quant.backtest(body);
    return { result: r, methodology: BACKTEST_METHODOLOGY };
  });

  // ─────────────────────────── journal ───────────────────────────

  app.get('/api/journal', async (req) => {
    const a = await requireAccount(req);
    const q = parse(z.object({ mode: TradingModeSchema.optional() }), req.query);
    const rows = await db
      .select()
      .from(journalEntries)
      .where(q.mode ? and(eq(journalEntries.accountId, a.id), eq(journalEntries.mode, q.mode)) : eq(journalEntries.accountId, a.id))
      .orderBy(desc(journalEntries.createdAt))
      .limit(300);
    return { entries: rows };
  });

  const JournalSchema = z.object({
    mode: TradingModeSchema,
    body: z.string().trim().min(1).max(4000),
    tags: z.array(z.string().trim().min(1).max(24)).max(8).default([]),
    orderId: z.string().uuid().optional(),
    market: z.string().max(20).optional(),
  });
  app.post('/api/journal', tight(60), async (req) => {
    const a = await requireAccount(req);
    const b = parse(JournalSchema, req.body);
    const [row] = await db.insert(journalEntries).values({ accountId: a.id, ...b }).returning();
    return { entry: row };
  });
  app.patch('/api/journal/:id', tight(60), async (req) => {
    const a = await requireAccount(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ body: z.string().trim().min(1).max(4000).optional(), tags: z.array(z.string().max(24)).max(8).optional() }), req.body);
    const [row] = await db
      .update(journalEntries)
      .set({ ...b, updatedAt: new Date() })
      .where(and(eq(journalEntries.id, id), eq(journalEntries.accountId, a.id)))
      .returning();
    if (!row) throw new HttpError(404, 'not_found', 'Entry not found');
    return { entry: row };
  });
  app.delete('/api/journal/:id', tight(60), async (req) => {
    const a = await requireAccount(req);
    const { id } = req.params as { id: string };
    await db.delete(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.accountId, a.id)));
    return { ok: true };
  });

  // ─────────────────────────── AI ops ───────────────────────────

  app.get('/api/ai/usage', async () => {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const runs = await db.select().from(inferenceRuns).where(gte(inferenceRuns.startedAt, dayStart)).orderBy(desc(inferenceRuns.startedAt)).limit(500);
    const spent = await ctx.budget.spentToday();
    return { spentTodayUsd: spent, limits: ctx.budget.limits, runs, providers: ctx.providers.healthList() };
  });

  } // LEGACY_API

  // ─────────────────────────── WebSocket ───────────────────────────

  app.get('/ws', { websocket: true }, async (socket, req) => {
    const a = await ctx.auth.fromToken(ctx.auth.readCookie(req));
    if (!a) {
      socket.close(4401, 'no session');
      return;
    }
    ctx.hub.add(socket, a.id, { type: 'hello', serverTime: Date.now(), clockSpeed: 1, simulated: ctx.market.simulated, dataSource: ctx.market.source, version: VERSION });
    socket.send(JSON.stringify({ type: 'health', health: ctx.health() }));
  });

  // ─────────────────────────── dev / test hooks ───────────────────────────

  if (ctx.cfg.LEGACY_API && ctx.cfg.ENABLE_DEV_ROUTES && ctx.cfg.NODE_ENV !== 'production') {
    app.post('/api/dev/feed/pause', async (req) => {
      const b = parse(z.object({ paused: z.boolean() }), req.body);
      if (!ctx.demoFeed) throw new HttpError(409, 'not_demo', 'Only available with the simulated feed');
      ctx.demoFeed.setPaused(b.paused);
      return { ok: true };
    });

    app.post('/api/dev/providers/outage', async (req) => {
      const b = parse(z.object({ provider: z.enum(AI_PROVIDERS.map((p) => p.id) as [string, ...string[]]), ms: z.number().int().min(0).max(3_600_000) }), req.body);
      ctx.providers.simulateOutage(b.provider as never, b.ms);
      return { ok: true, providers: ctx.providers.healthList() };
    });

    app.post('/api/dev/paper/fund', async (req) => {
      const a = await requireAccount(req);
      const b = parse(z.object({ asset: z.string(), amount: z.number() }), req.body);
      const { paperBalances } = await import('../db/schema.js');
      await db
        .insert(paperBalances)
        .values({ accountId: a.id, asset: b.asset, amount: b.amount })
        .onConflictDoUpdate({ target: [paperBalances.accountId, paperBalances.asset], set: { amount: b.amount } });
      return { ok: true };
    });
  }

}
