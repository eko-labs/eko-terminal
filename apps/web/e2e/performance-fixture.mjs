import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const f = JSON.parse(readFileSync(new URL('../src/mocks/contracts.json', import.meta.url)));
const approvalsEnabled = process.env.EKO_PERF_APPROVALS === '1';
const port = Number(process.env.E2E_API_PORT ?? 8991);
const card = { ...f.CoinCard, supply: { ...f.CoinCard.supply, circulating: '1000000' }, freshness: { block: 1, ageSec: 0 } };
const scan = { id: 'perf-scan', status: 'ready', card, shareUrl: '/scan/perf-scan' };
const subscribers = new Map();
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname.replace(/^\/v1/, '');
  let raw = ''; for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  if (path === '/health') return json(res, { ok: true });
  if (path === '/config') return json(res, { ...f.PublicConfig, flags: { ...f.PublicConfig.flags, approvals: approvalsEnabled }, wallets: { ...f.PublicConfig.wallets, dev: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' }, exampleScans: [f.Address] });
  if (url.pathname === '/api/session') return json(res, { account: { id: 'demo-account', kind: approvalsEnabled ? 'wallet' : 'guest', walletAddress: approvalsEnabled ? f.Address : null, displayName: null, role: 'user' }, installs: [] });
  if (path === '/me') return json(res, { ...f.Me, account: { ...f.Me.account, id: 'demo-account' } });
  if (path === '/approvals' || path === '/approvals/fixture') { const approval = { ...f.Approval, expiresAt: new Date(Date.now() + 120000).toISOString() }; return json(res, path === '/approvals' ? { rows: [approval], cursor: null } : approval); }
  if (path === '/radar' || url.pathname === '/v2/radar') return json(res, { rows: [f.RadarRow], cursor: null, delayedSec: 0 });
  if (path === '/scoreboard') return json(res, { counters: { refused: 0, missed: null, since: '2026-10-01T00:00:00Z' } });
  if (path === '/scan' || path === '/scan/perf-scan') return json(res, scan);
  if (path === '/feed') return json(res, { rows: [], cursor: null });
  if (path === '/watch') return json(res, { items: [] });
  if (path === '/agents') return json(res, { agents: [] });
  if (path === '/telemetry') return json(res, { ok: true });
  if (path === '/trade/quote') return json(res, { ...f.TradeQuote, ...body, amountIn: '100', valueWei: '0', minOut: '1', binding: false, expiresAt: new Date(Date.now() + 15000).toISOString(), approvals: [], fee: { bps: 0, usd: 0, destination: null }, route: { ...f.TradeQuote.route, executable: false }, guard: { decision: 'refuse', checks: [{ status: 'refuse', code: 'sim_unavailable', label: 'Synthetic quote only' }] } });
  if (path.startsWith('/coins/')) {
    if (path.endsWith('/verdict')) return json(res, card.verdict);
    if (path.endsWith('/flow')) return json(res, { ...f.Flow, window: url.searchParams.get('window') });
    if (path.endsWith('/candles')) { const now = Math.floor(Date.now() / 300000) * 300; return json(res, { tf: '5m', bars: Array.from({ length: 72 }, (_, i) => ({ ...f.Bar, ts: now - (71-i)*300, o: 1+i/1000, c: 1+(i+1)/1000, h: 1.1+i/1000, l: .9+i/1000 })), asOfBlock: 1 }); }
    if (path.endsWith('/markers')) return json(res, { markers: [], unavailable: ['labels'] });
    return json(res, card);
  }
  if (path === '/perf/event') {
    let delivered = 0;
    for (const [ws, channels] of subscribers) if (channels.has('feed')) { const seq = channels.get('feed') + 1; channels.set('feed', seq); ws.send(JSON.stringify({ t: 'ev', ch: 'feed', kind: 'item', seq, ts: Date.now(), data: { ...f.FeedItem, id: `perf-event-${body.index}`, block: 1000 + body.index } })); delivered++; }
    return json(res, { delivered });
  }
  return json(res, { error: 'not_found', message: 'No performance fixture for endpoint.' }, 404);
});
const wss = new WebSocketServer({ server, path: '/v1/ws' });
wss.on('connection', ws => {
  const channels = new Map(); subscribers.set(ws, channels);
  ws.send(JSON.stringify({ t: 'hello', session: 'anon', serverTime: Date.now(), delayedSec: 0 }));
  ws.on('message', bytes => {
    const m = JSON.parse(bytes.toString());
    if (m.op === 'ping') ws.send(JSON.stringify({ t: 'pong', serverTime: Date.now() }));
    if (m.op === 'sub') for (const ch of m.ch) { channels.set(ch, 0); ws.send(JSON.stringify({ t: 'ack', ch, seq: 0 })); }
    if (m.op === 'unsub') for (const ch of m.ch) channels.delete(ch);
  });
  ws.on('close', () => subscribers.delete(ws));
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { wss.clients.forEach(ws => ws.terminate()); server.close(() => process.exit()); });
