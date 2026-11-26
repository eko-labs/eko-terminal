import { storageOk } from './storage-guard.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { isAddress, type Address } from 'viem';
import type { ErrorCode, PairRow, ScanResult } from '@eko/shared';
import { barsFromTrades, MAX_BARS, TIMEFRAMES, type Timeframe } from './market.js';
import type { Edge } from './service.js';
import type { CoinState, Rpc } from './tracker.js';
import { coinCard, coinSummary, feedItem, flowView, pairColumn, pairRow, pendingVerdict, progressBps, publicConfig, radarRow, unitScale } from './views.js';
import type { HistoryStore } from './history.js';
import type { LoadedFeature } from './features/index.js';
import type { AlertInbox } from './alerts.js';
import type { Historian } from './historian.js';
import type { FunderTracer } from './funders.js';
import { registerMemoryRoutes } from './memory-routes.js';
import { registerAccountRoutes, type AccountStore } from './accounts.js';
import { budgetedRpc, registerTradeRoutes, type Trading } from './trade.js';
import { AgentStore, registerAgentRoutes } from './agents.js';
import { registerMcp } from './mcp.js';
import type { Approval } from '@eko/shared';
import type { BuildInfo } from './build.js';
import { RelayBusy, relayFromRpc, type RelayClient } from './relay.js';
import { registerSecurityTxt } from './security-txt.js';

const fail = (reply: FastifyReply, status: number, error: ErrorCode, message: string) => reply.code(status).send({ error, message });
const LIMIT = 100, SEARCH_LIMIT = 8;

/** Text responses worth compressing; video, images and woff2 are compressed already. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
/** The client's preferred encoding of br and gzip, honouring q=0 ("not this one"). */
export function pickEncoding(accept: string | undefined): 'br' | 'gzip' | null {
  const allowed = new Map<string, number>();
  for (const part of (accept ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map(p => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
    if (name) allowed.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  const ok = (name: string) => (allowed.get(name) ?? allowed.get('*') ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}

/**
 * The read API the EKO web app calls, answered from the edge's memory, plus the built web app itself, for the
 * deployment's chain (edge.chain). Accounts, agents and trading are served when a store is open; burn routes are not.
 */
/** Read methods the web app's wallet layer may relay (network badge, balances, token reads). Nothing that sends. */
export const RELAY_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_call', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_estimateGas']);

export function buildServer(edge: Edge, opts: { webDist?: string; landingDist?: string; logger?: boolean; rpc?: Rpc; store?: HistoryStore; historian?: Historian; funders?: FunderTracer; accounts?: AccountStore; trading?: Trading; maxTradeUsd?: number; flags?: ReadonlySet<string>; token?: { address: Address; symbol?: string }; features?: readonly LoadedFeature[]; alerts?: AlertInbox; onApproval?: (accountId: string, a: Approval) => void; trustProxyHops?: number; build?: BuildInfo; relay?: RelayClient } = {}): FastifyInstance {
  // Trust exactly the proxies in front of us (Railway: one hop), so a client cannot pick its own req.ip with X-Forwarded-For.
  // JSON bodies are small everywhere; the routes that need more (SIWE contract-wallet signatures, MCP batches) say so.
  const hops = opts.trustProxyHops ?? 1;
  const chain = edge.chain.profile, { text } = chain;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: (_address: string, hop: number) => hop < hops, bodyLimit: 16_384 });
  // Compression, added first so every route below gets it: JSON and HTML at a light brotli level (gzip for clients
  // without br), at most a millisecond or two. Files come as streams and pass through: the web and landing builds ship
  // .br/.gz next to them, which the static block at the end serves as they are.
  app.addHook('onSend', async (req, reply, payload) => {
    if ((typeof payload !== 'string' && !Buffer.isBuffer(payload)) || req.method === 'HEAD' || reply.getHeader('content-encoding')) return payload;
    if (Buffer.byteLength(payload) < 1024 || !COMPRESSIBLE.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/accept-encoding/i.test(vary)) reply.header('vary', vary ? `${vary}, accept-encoding` : 'accept-encoding');
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return payload;
    reply.header('content-encoding', encoding).removeHeader('content-length');
    return encoding === 'br' ? brotliCompressSync(payload, { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }) : gzipSync(payload, { level: 6 });
  });
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store'); return payload; });

  app.get('/health', async () => {
    const t = edge.tracker;
    return { ok: t.cursor > 0n, build: opts.build ?? { commit: null, builtAt: null }, head: Number(t.head), cursor: Number(t.cursor), lagBlocks: Number(t.head - t.cursor), coins: t.coins.size,
      assessed: edge.assessedCount, hypeUsd: edge.hype.latest, counters: edge.counters,
      // 'low' means the storage guard is refusing new user content (monitoring alerts on it; the free space itself is not shown).
      storage: storageOk() ? 'ok' : 'low', memory: opts.store ? { historian: opts.historian?.status() ?? null, funderQueue: opts.funders?.pending ?? null } : null };
  });

  const coinOr404 = (address: string, reply: FastifyReply) => {
    if (!isAddress(address, { strict: false })) { void fail(reply, 400, 'bad_request', 'Not an address.'); return null; }
    const coin = edge.tracker.coin(address);
    if (!coin) { void fail(reply, 404, 'not_found', `EKO follows ${text.launches} from the last 24 hours on ${chain.name}; this coin is not one of them yet.`); return null; }
    return coin;
  };
  const ranked = () => {
    const ctx = edge.ctx();
    // Newest activity first: an hour's volume, then age. Verdict never re-ranks (a ranking is not a recommendation).
    return [...edge.tracker.coins.values()].map(c => ({ c, vol: c.trades.filter(t => t.ts >= ctx.nowSec - 3600).reduce((s, t) => s + t.hype, 0) }))
      .sort((x, y) => y.vol - x.vol || y.c.ts - x.c.ts).map(x => x.c);
  };

  const tradingConfig = opts.trading ? { routers: opts.trading.routers, spenders: opts.trading.spenders, permit2: opts.trading.permit2, maxTradeUsd: opts.maxTradeUsd ?? 1000 } : undefined;
  app.get('/v1/config', async () => publicConfig(tradingConfig, { accounts: !!opts.accounts, ...(opts.flags ? { flags: opts.flags } : {}), ...(opts.token ? { token: opts.token } : {}) }, chain));
  const agents = opts.accounts ? new AgentStore(opts.accounts.db) : undefined;
  let auth: ReturnType<typeof registerAccountRoutes> | undefined;
  if (opts.accounts && agents) {
    // Sign-in's contract-wallet check gets its own small slice of the RPC, never the tracker's whole lane.
    auth = registerAccountRoutes(app, { store: opts.accounts, chain, ...(opts.alerts ? { alerts: opts.alerts } : {}), ...(opts.rpc ? { rpc: budgetedRpc(opts.rpc, { perMin: 60, inFlight: 4 }) } : {}), onErase: (id) => { agents.erase(id); opts.trading?.erase(id); } });
    if (opts.trading) registerTradeRoutes(app, opts.trading, auth);
    registerAgentRoutes(app, agents, auth, { mcpUrl: (req) => `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}/mcp`, ...(opts.onApproval ? { onApproval: opts.onApproval } : {}) });
  } else app.get('/v1/me', async (_req, reply) => fail(reply, 401, 'wallet_auth_required', `Accounts are not open on EKO for ${chain.name} yet.`));
  registerMcp(app, { edge, ...(opts.store ? { store: opts.store } : {}), ...(agents ? { agents } : {}), ...(opts.trading ? { trading: opts.trading } : {}) });

  // The radar list is the same for every visitor and building it judges up to 100 coins, which takes seconds when their
  // verdicts are due (measured 3.5 s after a quiet spell). So it is shared: a list under RADAR_FRESH_MS old is served as
  // is; an older one, up to RADAR_STALE_MS, is served at once while one rebuild runs after the response has gone out;
  // only a missing or very old list is built while the visitor waits.
  const RADAR_FRESH_MS = 3_000, RADAR_STALE_MS = 60_000;
  let radarCache: { at: number; body: ReturnType<typeof buildRadar> } | null = null, radarJob: Promise<ReturnType<typeof buildRadar>> | null = null;
  const rebuildRadar = (defer: boolean) => radarJob ??= new Promise<ReturnType<typeof buildRadar>>((done, failed) => {
    const run = () => { try { const body = buildRadar(); radarCache = { at: Date.now(), body }; done(body); } catch (e) { failed(e); } };
    if (defer) setTimeout(run, 0); else run();
  }).finally(() => { radarJob = null; });
  const radar = async () => {
    const age = radarCache ? Date.now() - radarCache.at : Infinity;
    if (radarCache && age < RADAR_FRESH_MS) return radarCache.body;
    if (radarCache && age < RADAR_STALE_MS) { void rebuildRadar(true).catch(() => undefined); return radarCache.body; }
    return rebuildRadar(false);
  };
  const buildRadar = () => {
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
    // From each coin's first check (kept across restarts), not its latest: a restart re-checks every coin, and a
    // restored day-old coin read as 'first scanned' hours after launch (the median jumped to ~6.5 h after a deploy).
    const firstScan = today.map(c => c.firstScanSec !== undefined && c.firstScanSec >= 0 ? c.firstScanSec - c.ts : null).filter((v): v is number => v !== null && v >= 0).sort((a, b) => a - b);
    return { rows, cursor: null, delayedSec: 0, today: { launches: today.length, medianFirstScanSec: firstScan.length ? Math.round(firstScan[Math.floor(firstScan.length / 2)]!) : null,
      refused: edge.counters.honeypotsRefused } };
  });

  // The header search box: a ticker or name among the coins the edge follows, best match first (exact address, exact
  // ticker, ticker prefix, name prefix, then either containing it), newest first within each. A pasted address opens
  // the coin page without asking; it comes here only to be matched like any other text.
  /** Coins the edge follows matching a ticker or name, best first (exact address, exact ticker, ticker prefix, name prefix,
   *  then either containing it), newest first within each, with each one's rank (0 and 1 are exact). */
  const findCoins = (raw: string) => {
    const q = raw.trim().replace(/^\$/, '').toLowerCase().slice(0, 64);
    if (!q) return [];
    const rank = (c: CoinState) => {
      // The probe's name and symbol first, as the pages show them (a launch event can leave the tracker's empty).
      const p = edge.probes.get(c.token.toLowerCase());
      const sym = (p?.symbol || c.symbol || '').toLowerCase(), name = (p?.name || c.name || '').toLowerCase();
      return c.token.toLowerCase() === q ? 0 : sym === q ? 1 : sym.startsWith(q) ? 2 : name.startsWith(q) ? 3 : sym.includes(q) || name.includes(q) ? 4 : -1;
    };
    return [...edge.tracker.coins.values()].map(c => ({ rank: rank(c), coin: c })).filter(m => m.rank >= 0)
      .sort((a, b) => a.rank - b.rank || b.coin.ts - a.coin.ts).slice(0, SEARCH_LIMIT);
  };
  // The header search box: a ticker or name among the coins the edge follows. A pasted address opens the coin page
  // without asking; it comes here only to be matched like any other text.
  app.get<{ Querystring: { q?: string } }>('/v1/search', async (req) => {
    const ctx = edge.ctx();
    return { rows: findCoins(String(req.query.q ?? '')).map(m => coinSummary(m.coin, edge.assessment(m.coin.token), ctx)) };
  });

  // A scan: the /scan page, share links (/scan/<address>) and API clients ask for one coin by address, ticker or name.
  // An address of a coin the edge follows, or a single match, is answered with its card (verdict, sell check, flow);
  // several matches are offered to pick from; anything else says plainly why there is no card.
  const scan = async (raw: string): Promise<ScanResult> => {
    const q = raw.trim().slice(0, 80), share = (id: string) => `/scan/${encodeURIComponent(id)}`;
    const ready = async (c: CoinState): Promise<ScanResult> => ({ id: c.token, status: 'ready', card: coinCard(c, await edge.fresh(c), edge.ctx()), shareUrl: share(c.token) });
    if (isAddress(q, { strict: false })) {
      const c = edge.tracker.coin(q);
      return c ? ready(c) : { id: q, status: 'not_found', shareUrl: share(q), message: `EKO follows ${text.launches} from the last 24 hours on ${chain.name}; this coin is not one of them.` };
    }
    const found = findCoins(q), exact = found.filter(m => m.rank <= 1);
    if (exact.length === 1 || found.length === 1) return ready((exact[0] ?? found[0])!.coin);
    if (!found.length) return { id: q, status: 'not_found', shareUrl: share(q), message: `No coin called "${q.slice(0, 40)}" among the coins EKO follows. Paste its contract address.` };
    const ctx = edge.ctx();
    return { id: q, status: 'ambiguous', shareUrl: share(q), candidates: found.map(m => coinSummary(m.coin, edge.assessment(m.coin.token), ctx)) };
  };
  app.get<{ Querystring: { q?: string } }>('/v1/scan', async (req, reply) => {
    const q = String(req.query.q ?? '').trim();
    return q ? scan(q) : fail(reply, 400, 'bad_request', 'Give a contract address, ticker or name as q.');
  });
  app.post<{ Body: { query?: unknown } }>('/v1/scan', { bodyLimit: 4096 }, async (req, reply) => {
    const q = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    return q ? scan(q) : fail(reply, 400, 'bad_request', 'Give a contract address, ticker or name as query.');
  });
  app.get<{ Params: { id: string } }>('/v1/scan/:id', async (req) => scan(decodeURIComponent(req.params.id)));

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
  // The v2 Guard assessment is not computed by the edge yet: the client falls back to the v1 card and verdict.
  app.get<{ Params: { address: string } }>('/v2/coins/:address', async () => ({ version: 2, card: null }));
  app.get<{ Params: { address: string } }>('/v2/coins/:address/verdict', async () => ({ version: 2, verdict: null }));

  app.get<{ Params: { address: string }; Querystring: { tf?: string; from?: string; to?: string } }>('/v1/coins/:address/candles', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    const tf = (req.query.tf && req.query.tf in TIMEFRAMES ? req.query.tf : '1m') as Timeframe;
    const ctx = edge.ctx(), from = Number(req.query.from ?? 0), to = Number(req.query.to ?? ctx.nowSec);
    const hypeUsd = ctx.hypeUsd;
    return { tf, bars: hypeUsd ? barsFromTrades(coin.trades, tf, hypeUsd, from, to, unitScale(coin)).slice(-MAX_BARS) : [], asOfBlock: ctx.head,
      firstTradeTs: coin.trades[0]?.ts ?? null, lastTradeTs: coin.trades.at(-1)?.ts ?? null, ...(hypeUsd ? {} : { unavailable: ['price'] }) };
  });
  // Wallet labels (agent / crew / human) are not computed by the edge yet: no markers rather than unlabelled ones.
  app.get('/v1/coins/:address/markers', async () => ({ markers: [], unavailable: ['labels'] }));
  app.get<{ Params: { address: string }; Querystring: { window?: string } }>('/v1/coins/:address/flow', async (req, reply) => {
    const coin = coinOr404(req.params.address, reply); if (!coin) return reply;
    const window = (['5m', '1h', '24h'].includes(req.query.window ?? '') ? req.query.window : '1h') as '5m' | '1h' | '24h';
    // Measured buy / sell activity, largest wallets and latest trades; the label split stays named missing (views.ts).
    return flowView(coin, edge.ctx(), window, edge.chain.excluded(coin));
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
  // It runs on its own public-RPC client (relay.ts), never on the metered lanes the tracker and safety checks use.
  const relay = opts.relay ?? (opts.rpc ? relayFromRpc(opts.rpc) : undefined);
  app.post<{ Body: { jsonrpc?: string; id?: number | string; method?: string; params?: unknown[] } }>('/v1/rpc', { bodyLimit: 16_384 }, async (req, reply) => {
    const { id = 1, method, params = [] } = req.body ?? {};
    if (!relay || typeof method !== 'string' || !RELAY_METHODS.has(method) || !Array.isArray(params) || params.length > 4) {
      return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not available' } });
    }
    if (method === 'eth_getBlockByNumber' && params[1] === true) return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Full blocks are not relayed' } });
    try { return { jsonrpc: '2.0', id, result: await relay.request(req.ip, { method, params }) }; }
    catch (e) {
      if (e instanceof RelayBusy) return reply.code(429).send({ jsonrpc: '2.0', id, error: { code: -32005, message: 'Too many requests; slow down.' } });
      return reply.code(502).send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Upstream RPC unavailable' } });
    }
  });

  app.get('/v2/ghost-reports', async () => ({ records: [] }));
  // The web app's anonymous usage pings: accepted and dropped (this build keeps no usage record), so pages log no 404.
  app.post('/v1/telemetry', { bodyLimit: 16_384 }, async (_req, reply) => reply.code(204).send());
  // Grade outcomes need the scoreboard's graded history, which this build does not keep: an empty answer, not a 404.
  app.get('/v1/scoreboard/grades', async (_req, reply) => reply.code(204).send());
  registerSecurityTxt(app);

  // Link previews and the page description for a shared coin page (the web asks for /coin/<address>). Other share paths
  // (scans, bags, receipts) have no server-side record on this build: an empty answer, not a 404, so pages log no error.
  app.get<{ Querystring: { path?: string } }>('/v1/share-meta', async (req, reply) => {
    const m = /^\/coin\/(0x[0-9a-fA-F]{40})$/.exec(String(req.query.path ?? ''));
    const coin = m && isAddress(m[1]!) ? edge.tracker.coin(m[1]!) : undefined;
    if (!coin) return reply.code(204).send();
    const a = edge.assessment(coin.token), level = a?.verdict.level ?? 'pending';
    const symbol = (a?.symbol ?? coin.symbol ?? '').replace(/[^\p{L}\p{N} ._$-]/gu, '').slice(0, 24) || coin.token.slice(0, 10);
    // A Clear grade on part of the coin's history (EKO joined after launch) is not "No flags": the holder checks never
    // ran. Same word as the coin page's chip.
    const word = level === 'clear' && a?.verdict.historyPartial ? 'Partly checked'
      : ({ clear: 'No flags', monitor: 'Monitor', danger: 'Danger' } as Record<string, string>)[level] ?? 'Being checked';
    const site = `${req.protocol}://${String(req.headers['x-forwarded-host'] ?? req.headers.host)}`;
    return { title: `$${symbol} · ${word} · EKO`, url: `${site}/coin/${coin.token}`,
      description: `${word} on EKO's checks for $${symbol} (${edge.chain.profile.name}). Buyer risk at one block, not a buy recommendation. DYOR.` };
  });

  // Post-launch features that are on (features/index.ts): their routes come before the catch-all below.
  for (const feature of opts.features ?? []) feature.register({ app, edge, ...(opts.store ? { store: opts.store } : {}), ...(opts.accounts ? { accounts: opts.accounts } : {}), ...(auth ? { auth } : {}), ...(opts.alerts ? { alerts: opts.alerts } : {}), ...(opts.rpc ? { rpc: opts.rpc } : {}), ...(opts.funders ? { funders: opts.funders } : {}) });

  // Everything else under the API is not served yet.
  app.all('/v1/*', async (_req, reply) => fail(reply, 404, 'not_found', `Not available on EKO for ${chain.name} yet.`));
  app.all('/v2/*', async (_req, reply) => fail(reply, 404, 'not_found', `Not available on EKO for ${chain.name} yet.`));

  // The terminal's build everywhere, the marketing landing's own build at "/" with its assets under /site/
  // (the layout EKO's server used). Without a landing build, "/" is the terminal's entry page.
  const web = opts.webDist ? resolve(opts.webDist) : null;
  if (web && existsSync(resolve(web, 'index.html'))) {
    // The terminal's page carries the public config inline (the same JSON as /v1/config), so the first render already
    // knows the features, plan and trading state: no sidebar item, plan chip or trade panel changes size when the
    // config request returns (layout shift). `<` is escaped so the JSON can never close the script element.
    const shellFile = readFileSync(resolve(web, 'index.html'), 'utf8');
    const inlineConfig = () => `<script id="eko-config" type="application/json">${JSON.stringify(publicConfig(tradingConfig, { accounts: !!opts.accounts, ...(opts.flags ? { flags: opts.flags } : {}), ...(opts.token ? { token: opts.token } : {}) }, chain)).replace(/</g, '\\u003c')}</script>`;
    const shell = { toString: () => shellFile.replace('<!--eko:head-->', `<!--eko:head-->${inlineConfig()}`) };
    const html = (doc: string | { toString(): string }) => (_req: unknown, reply: FastifyReply) => reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(String(doc));
    // Hashed bundles never change; fonts and landing media keep their names, so they get a month (and a day of
    // stale-while-revalidate) rather than forever; everything else (manifest, icons, the site bridge) an hour.
    const assetHeaders = (res: FastifyReply, path: string) => {
      const rel = path.replaceAll('\\', '/');
      res.header('cache-control', /\/assets\//.test(rel) ? 'public, max-age=31536000, immutable'
        : /\/(fonts|media)\//.test(rel) ? 'public, max-age=2592000, stale-while-revalidate=86400' : 'public, max-age=3600');
    };
    // preCompressed: a request that accepts br (or gzip) gets the build's .br (.gz) file when there is one.
    void app.register(fastifyStatic, { root: web, prefix: '/', wildcard: false, index: false, preCompressed: true, globIgnore: ['**/index.html'], setHeaders: assetHeaders });
    const landing = opts.landingDist ? resolve(opts.landingDist) : null;
    if (landing && existsSync(resolve(landing, 'index.html'))) {
      void app.register(fastifyStatic, { root: landing, prefix: '/site/', decorateReply: false, wildcard: false, index: false, preCompressed: true, globIgnore: ['**/*.html'], setHeaders: assetHeaders });
      app.get('/', html(readFileSync(resolve(landing, 'index.html'), 'utf8')));
      for (const page of ['docs.html', 'whitepaper.html']) {
        const file = resolve(landing, page);
        if (existsSync(file)) app.get(`/site/${page}`, html(readFileSync(file, 'utf8')));
      }
    } else app.get('/', html(shell));
    app.get('/index.html', html(shell));
    // Client-side routes (/radar, /coin/0x…) get the terminal shell; API and asset paths stay 404.
    app.setNotFoundHandler((req, reply) => req.method === 'GET' && !['/v1', '/v2', '/site/', '/assets/', '/health'].some(prefix => req.url.startsWith(prefix))
      ? html(shell)(req, reply) : fail(reply, 404, 'not_found', 'Not found.'));
  }
  return app;
}
