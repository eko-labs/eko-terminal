import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { isAddress } from 'viem';
import type { ErrorCode, PairRow } from '@eko/shared';
import { barsFromTrades, TIMEFRAMES, type Timeframe } from './market.js';
import type { Edge } from './service.js';
import type { CoinState, Rpc } from './tracker.js';
import { coinCard, feedItem, pairColumn, pairRow, pendingVerdict, progressBps, publicConfig, radarRow } from './views.js';
import type { HistoryStore } from './history.js';
import type { LoadedFeature } from './features/index.js';
import type { Historian } from './historian.js';
import type { FunderTracer } from './funders.js';
import { registerMemoryRoutes } from './memory-routes.js';
import { registerAccountRoutes, type AccountStore } from './accounts.js';
import { registerTradeRoutes, type Trading } from './trade.js';
import { AgentStore, registerAgentRoutes } from './agents.js';
import { registerMcp } from './mcp.js';
import type { Approval } from '@eko/shared';

const fail = (reply: FastifyReply, status: number, error: ErrorCode, message: string) => reply.code(status).send({ error, message });
const LIMIT = 100;

/**
 * The read API the EKO web app calls, answered from the edge's memory, plus the built web app itself.
 * Every route is read-only. Account, agent, trading and burn routes are not served on Elysium yet.
 */
/** Read methods the web app's wallet layer may relay (network badge, balances, token reads). Nothing that sends. */
export const RELAY_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_call', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_estimateGas']);

export function buildServer(edge: Edge, opts: { webDist?: string; landingDist?: string; logger?: boolean; rpc?: Rpc; store?: HistoryStore; historian?: Historian; funders?: FunderTracer; accounts?: AccountStore; trading?: Trading; maxTradeUsd?: number; flags?: ReadonlySet<string>; features?: readonly LoadedFeature[]; onApproval?: (accountId: string, a: Approval) => void } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store'); return payload; });

  app.get('/health', async () => {
    const t = edge.tracker;
    return { ok: t.cursor > 0n, head: Number(t.head), cursor: Number(t.cursor), lagBlocks: Number(t.head - t.cursor), coins: t.coins.size,
      assessed: edge.assessedCount, hypeUsd: edge.hype.latest, counters: edge.counters, memory: opts.store ? { historian: opts.historian?.status() ?? null, funderQueue: opts.funders?.pending ?? null } : null };
  });

  const coinOr404 = (address: string, reply: FastifyReply) => {
    if (!isAddress(address, { strict: false })) { void fail(reply, 400, 'bad_request', 'Not an address.'); return null; }
    const coin = edge.tracker.coin(address);
    if (!coin) { void fail(reply, 404, 'not_found', 'EKO follows Montra launches from the last 24 hours on Elysium; this coin is not one of them yet.'); return null; }
    return coin;
  };
  const ranked = () => {
    const ctx = edge.ctx();
    // Newest activity first: an hour's volume, then age. Verdict never re-ranks (a ranking is not a recommendation).
    return [...edge.tracker.coins.values()].map(c => ({ c, vol: c.trades.filter(t => t.ts >= ctx.nowSec - 3600).reduce((s, t) => s + t.hype, 0) }))
      .sort((x, y) => y.vol - x.vol || y.c.ts - x.c.ts).map(x => x.c);
  };

  const tradingConfig = opts.trading ? { router: opts.trading.router, permit2: opts.trading.permit2, maxTradeUsd: opts.maxTradeUsd ?? 1000 } : undefined;
  app.get('/v1/config', async () => publicConfig(tradingConfig, { accounts: !!opts.accounts, ...(opts.flags ? { flags: opts.flags } : {}) }));
  const agents = opts.accounts ? new AgentStore(opts.accounts.db) : undefined;
  let auth: ReturnType<typeof registerAccountRoutes> | undefined;
  if (opts.accounts && agents) {
    auth = registerAccountRoutes(app, { store: opts.accounts, ...(opts.rpc ? { rpc: opts.rpc } : {}), onErase: (id) => agents.erase(id) });
    if (opts.trading) registerTradeRoutes(app, opts.trading, auth);
    registerAgentRoutes(app, agents, auth, { mcpUrl: (req) => `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}/mcp`, ...(opts.onApproval ? { onApproval: opts.onApproval } : {}) });
  } else app.get('/v1/me', async (_req, reply) => fail(reply, 401, 'wallet_auth_required', 'Accounts are not open on EKO for Elysium yet.'));
  registerMcp(app, { edge, ...(opts.store ? { store: opts.store } : {}), ...(agents ? { agents } : {}), ...(opts.trading ? { trading: opts.trading } : {}) });

  const radar = async () => {
    const ctx = edge.ctx();
    const rows = ranked().slice(0, LIMIT).map((c, i) => radarRow(c, edge.assessment(c.token), ctx, i + 1));
    // Counts use each coin's last verdict: recomputing every coin's verdict per request stalls the server.
    const levels = [...edge.tracker.coins.values()].map(c => edge.cachedLevel(c.token));
    const count = (l: string) => levels.filter(x => x === l).length;
    return { rows, cursor: null, delayedSec: 0, totals: { coins: levels.length, clear: count('clear'), monitor: count('monitor'), pending: count('pending'),
      danger: count('danger'), evaluatedToday: edge.counters.assessed, honeypotsRefused: edge.counters.honeypotsRefused } };
  };
  app.get('/v1/radar', radar);
  app.get('/v2/radar', radar);

  app.get<{ Querystring: { stage?: string } }>('/v2/pairs', async (req) => {
    const ctx = edge.ctx(), stage = (req.query.stage ?? 'new') as PairRow['column'];
    // Pick the column's coins first (cheap), then build rows (each computes a verdict) for the page only.
    // New: newest first. About to graduate: closest to the line first. Graduated: latest graduation first.
    const order = stage === 'near_grad' ? (a: CoinState, b: CoinState) => (progressBps(b, ctx) ?? 0) - (progressBps(a, ctx) ?? 0) || b.ts - a.ts
      : stage === 'migrated' ? (a: CoinState, b: CoinState) => (b.graduatedTs ?? b.ts) - (a.graduatedTs ?? a.ts) : (a: CoinState, b: CoinState) => b.ts - a.ts;
    const rows = [...edge.tracker.coins.values()].filter(c => pairColumn(c, ctx) === stage).sort(order).slice(0, LIMIT)
      .map(c => pairRow(c, edge.assessment(c.token), ctx));
    const today = [...edge.tracker.coins.values()].filter(c => ctx.nowSec - c.ts < 86_400);
    const firstScan = today.map(c => { const at = edge.probedAtSec(c.token); return at === null ? null : at - c.ts; }).filter((v): v is number => v !== null && v >= 0).sort((a, b) => a - b);
    return { rows, cursor: null, delayedSec: 0, today: { launches: today.length, medianFirstScanSec: firstScan.length ? Math.round(firstScan[Math.floor(firstScan.length / 2)]!) : null,
      refused: edge.counters.honeypotsRefused } };
  });

  const feed = async (req: { query: { kinds?: string } }) => {
    const kinds = new Set((req.query.kinds ?? '').split(',').filter(Boolean));
    const rows = [...edge.tracker.feed].reverse().filter(e => !kinds.size || kinds.has(e.kind)).slice(0, LIMIT).map(e => feedItem(e, edge.assessment(e.coin), edge.tracker.coin(e.coin)));
    return { rows, cursor: null };
  };
  app.get<{ Querystring: { kinds?: string } }>('/v1/feed', feed);
  app.get<{ Querystring: { kinds?: string } }>('/v2/feed', feed);

  app.get<{ Params: { address: string } }>('/v1/coins/:address', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    return coinCard(coin, await edge.fresh(coin), edge.ctx());
  });
  app.get<{ Params: { address: string } }>('/v1/coins/:address/verdict', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    return (await edge.fresh(coin))?.verdict ?? pendingVerdict(coin, Number(edge.tracker.head));
  });
  // The v2 Guard assessment is not computed on Elysium yet: the client falls back to the v1 card and verdict.
  app.get<{ Params: { address: string } }>('/v2/coins/:address', async () => ({ version: 2, card: null }));
  app.get<{ Params: { address: string } }>('/v2/coins/:address/verdict', async () => ({ version: 2, verdict: null }));

  app.get<{ Params: { address: string }; Querystring: { tf?: string; from?: string; to?: string } }>('/v1/coins/:address/candles', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    const tf = (req.query.tf && req.query.tf in TIMEFRAMES ? req.query.tf : '1m') as Timeframe;
    const ctx = edge.ctx(), from = Number(req.query.from ?? 0), to = Number(req.query.to ?? ctx.nowSec);
    const hypeUsd = ctx.hypeUsd;
    return { tf, bars: hypeUsd ? barsFromTrades(coin.trades, tf, hypeUsd, from, to) : [], asOfBlock: ctx.head,
      firstTradeTs: coin.trades[0]?.ts ?? null, lastTradeTs: coin.trades.at(-1)?.ts ?? null, ...(hypeUsd ? {} : { unavailable: ['price'] }) };
  });
  // Wallet labels (agent / crew / human) are not computed on Elysium yet: no markers rather than unlabelled ones.
  app.get('/v1/coins/:address/markers', async () => ({ markers: [], unavailable: ['labels'] }));
  app.get<{ Params: { address: string }; Querystring: { window?: string } }>('/v1/coins/:address/flow', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    const window = (['5m', '1h', '24h'].includes(req.query.window ?? '') ? req.query.window : '1h') as '5m' | '1h' | '24h';
    return { window, agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0,
      meta: { confidence: 0, asOfBlock: Number(edge.tracker.head), unavailable: true, missing: ['agentPct', 'crewPct', 'humanPct', 'washEstPct'] } };
  });

  if (opts.store) registerMemoryRoutes(app, edge, { store: opts.store, ...(opts.historian ? { historian: opts.historian } : {}), ...(opts.funders ? { funders: opts.funders } : {}) });
  else app.get('/v1/scoreboard', async () => {
    const through = new Date().toISOString();
    const unavailable = { status: 'unavailable' as const, reason: 'monitoring_missing' as const };
    return { rows: [], cursor: null, counters: { refused: edge.counters.honeypotsRefused, missed: null, since: edge.counters.startedAt },
      availability: { refused: { status: 'observed' as const, since: edge.counters.startedAt, through }, missed: unavailable, grades: unavailable,
        forecasts: unavailable, cohort: unavailable, milestones: unavailable }, snapshot: String(Number(edge.tracker.head)) };
  });


  // Bounded read-only JSON-RPC relay for the wallet layer: one request per call, allowlisted methods only.
  app.post<{ Body: { jsonrpc?: string; id?: number | string; method?: string; params?: unknown[] } }>('/v1/rpc', { bodyLimit: 16_384 }, async (req, reply) => {
    const { id = 1, method, params = [] } = req.body ?? {};
    if (!opts.rpc || typeof method !== 'string' || !RELAY_METHODS.has(method) || !Array.isArray(params) || params.length > 4) {
      return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not available' } });
    }
    if (method === 'eth_getBlockByNumber' && params[1] === true) return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Full blocks are not relayed' } });
    try { return { jsonrpc: '2.0', id, result: await opts.rpc.request({ method, params }) }; }
    catch { return reply.code(502).send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Upstream RPC unavailable' } }); }
  });

  app.get('/v2/ghost-reports', async () => ({ records: [] }));

  // Post-launch features that are on (features/index.ts): their routes come before the catch-all below.
  for (const feature of opts.features ?? []) feature.register({ app, edge, ...(opts.store ? { store: opts.store } : {}), ...(opts.accounts ? { accounts: opts.accounts } : {}), ...(auth ? { auth } : {}) });

  // Everything else under the API is not served on Elysium yet.
  app.all('/v1/*', async (_req, reply) => fail(reply, 404, 'not_found', 'Not available on EKO for Elysium yet.'));
  app.all('/v2/*', async (_req, reply) => fail(reply, 404, 'not_found', 'Not available on EKO for Elysium yet.'));

  // The terminal's build everywhere, the marketing landing's own build at "/" with its assets under /site/
  // (the layout EKO's server used). Without a landing build, "/" is the terminal's entry page.
  const web = opts.webDist ? resolve(opts.webDist) : null;
  if (web && existsSync(resolve(web, 'index.html'))) {
    const shell = readFileSync(resolve(web, 'index.html'), 'utf8');
    const html = (doc: string) => (_req: unknown, reply: FastifyReply) => reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(doc);
    const assetHeaders = (res: FastifyReply, path: string) => { res.header('cache-control', /\/assets\//.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'); };
    void app.register(fastifyStatic, { root: web, prefix: '/', wildcard: false, index: false, globIgnore: ['**/index.html'], setHeaders: assetHeaders });
    const landing = opts.landingDist ? resolve(opts.landingDist) : null;
    if (landing && existsSync(resolve(landing, 'index.html'))) {
      void app.register(fastifyStatic, { root: landing, prefix: '/site/', decorateReply: false, wildcard: false, index: false, globIgnore: ['**/*.html'], setHeaders: assetHeaders });
      app.get('/', html(readFileSync(resolve(landing, 'index.html'), 'utf8')));
      if (existsSync(resolve(landing, 'docs.html'))) app.get('/site/docs.html', html(readFileSync(resolve(landing, 'docs.html'), 'utf8')));
    } else app.get('/', html(shell));
    app.get('/index.html', html(shell));
    // Client-side routes (/radar, /coin/0x…) get the terminal shell; API and asset paths stay 404.
    app.setNotFoundHandler((req, reply) => req.method === 'GET' && !['/v1', '/v2', '/site/', '/assets/', '/health'].some(prefix => req.url.startsWith(prefix))
      ? html(shell)(req, reply) : fail(reply, 404, 'not_found', 'Not found.'));
  }
  return app;
}
