import { createMeteredClients, elysium, ELYSIUM_PUBLIC_RPC, loadElysiumRegistry } from '@eko/chain';
import { HypeUsd } from './hype.js';
import { buildServer } from './server.js';
import { Edge } from './service.js';
import { Tracker, type Rpc } from './tracker.js';
import { registerRealtime } from './ws.js';
import { memoryUsageStore } from './usage.js';
import { HistoryStore } from './history.js';
import { Explorer } from './explorer.js';
import { FunderTracer } from './funders.js';
import { Historian } from './historian.js';
import { AccountStore } from './accounts.js';
import { Trading } from './trade.js';
import { parseFlags } from './flags.js';
import { loadFeatures } from './features/index.js';
import { ColumnSnapshot } from './snapshot.js';
import { dirname, join } from 'node:path';

/**
 * EKO edge for Elysium. Environment:
 *   PORT (default 8080), HOST (default 0.0.0.0)
 *   RPC_HTTP_URL     paid RPC (optional; read-only key). Without it, Kinetiq's public RPC is used.
 *   RPC_PUBLIC_HTTP_URL  override of the public RPC.
 *   WEB_DIST         built web app to serve (default ../web/dist)
 *   LANDING_DIST     built landing site, served at / and /site/ (default ../landing/dist)
 *   BACKFILL_BLOCKS  blocks replayed at start (default 32,400, about an hour)
 *   POLL_MS          tracker poll interval (default 2,000)
 *   ASSESS_CONCURRENCY  coin checks in flight (default 2; each is two eth_calls)
 *   LOG_CHUNK        largest eth_getLogs span to try (default 2,000; free RPC tiers allow ~100)
 *   HISTORY_DB       EKO's memory, one SQLite file (default .data/history.db; on Railway a volume path). "off" runs stateless.
 *   HISTORIAN        "off" stops the background backfill (launches, swap counts, replays); on by default with a store.
 *   EXPLORER_URL     Etherscan-style explorer API (default Elysium's public Blockscout)
 *   EXPLORER_RPS     requests per second for each of the historian and the funder tracer (default 2)
 *   REPLAY_MIN_SWAPS swaps a past launch needs before the historian rebuilds it (default 10)
 *   ACCOUNTS         "off" closes wallet sign-in (and with it trading); on by default with a store
 *   TRADING          "off" keeps sign-in but turns wallet trading off
 *   MAX_TRADE_USD    largest trade the panel quotes (default 1,000)
 *   EKO_FLAGS        features turned on, e.g. "leaderboards,referrals" (flags.ts; docs/FLAGS.md). Unset: none.
 */
const env = process.env;
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

const registry = loadElysiumRegistry();
const clients = createMeteredClients({ ...env, RPC_PUBLIC_HTTP_URL: env.RPC_PUBLIC_HTTP_URL ?? ELYSIUM_PUBLIC_RPC,
  RPC_PUBLIC_MAX_RPM: env.RPC_PUBLIC_MAX_RPM ?? '600', RPC_USAGE_DIR: env.RPC_USAGE_DIR ?? '/tmp/eko-rpc-usage' }, {
  // Usage in memory: the edge has no database, and pause persistence needs one.
  store: memoryUsageStore(), chain: elysium,
  alert: (reason, fields) => log('rpc_alert', { reason, ...fields }),
});
// Plain JSON-RPC over the metered transport (budgets, timeouts and usage logs stay in force).
const rpc: Rpc = { request: (input) => clients.public.request(input as Parameters<typeof clients.public.request>[0]) };
const store = env.HISTORY_DB === 'off' ? null : new HistoryStore(env.HISTORY_DB ?? '.data/history.db');
const tracker = new Tracker(rpc, registry, { backfillBlocks: Number(env.BACKFILL_BLOCKS ?? 32_400), chunk: Number(env.LOG_CHUNK ?? 2000),
  ...(store ? { onLaunch: (c) => { try { store.recordLaunch({ token: c.token, launchpad: c.launchpad, deployer: c.creator, poolId: c.poolId, createdBlock: c.block, createdTs: c.ts,
    tx: c.tx, name: c.name, symbol: c.symbol, supply: c.supply.toString() }); } catch (error) { log('launch_record_failed', { error: String((error as Error).message).slice(0, 160) }); } } } : {}) });
const explorer = (rps: number) => new Explorer({ ...(env.EXPLORER_URL ? { base: env.EXPLORER_URL } : {}), ratePerSec: rps });
const funders = store ? new FunderTracer(explorer(Number(env.EXPLORER_RPS ?? 2)), store, { log }) : null;
const historian = store ? new Historian(explorer(Number(env.EXPLORER_RPS ?? 2)), store, registry, { tracker, ...(funders ? { funders } : {}) }, { log, minSwaps: Number(env.REPLAY_MIN_SWAPS ?? 10) }) : null;
// The graduation columns' coins, kept on the volume across restarts (snapshot.ts). COLUMNS_SNAPSHOT=off turns it off.
const snapshotPath = env.COLUMNS_SNAPSHOT === 'off' ? null : env.COLUMNS_SNAPSHOT ?? (store ? join(dirname(env.HISTORY_DB ?? '.data/history.db'), 'columns.json') : null);
const snapshot = snapshotPath ? new ColumnSnapshot(snapshotPath, tracker) : null;
if (snapshot) tracker.seed(snapshot.load());
const hype = new HypeUsd();
const edge = new Edge(tracker, rpc, registry, hype, { log, concurrency: Number(env.ASSESS_CONCURRENCY ?? 2),
  ...(store && historian && funders ? { memory: { store, historian, funders } } : {}) });
const accounts = store && env.ACCOUNTS !== 'off' ? new AccountStore(store.db) : null;
const maxTradeUsd = Number(env.MAX_TRADE_USD ?? 1000);
let pushTo: ((accountId: string, ch: string, kind: string, data: unknown) => void) | null = null;
const trading = accounts && env.TRADING !== 'off' ? new Trading({ db: store!.db, rpc, registry, coin: (a) => tracker.coin(a), assess: (c) => edge.fresh(c), hypeUsd: () => hype.latest, maxTradeUsd,
  onOrder: (accountId, order) => pushTo?.(accountId, 'orders', 'order', { order }) }) : null;
const flags = parseFlags(env.EKO_FLAGS);
if (flags.unknown.length) log('flags_unknown', { names: flags.unknown });
const features = await loadFeatures(flags.on);
if (features.length) log('features_on', { flags: features.map(f => f.flag) });
const app = buildServer(edge, { rpc, flags: flags.on, features, ...(accounts ? { accounts } : {}), ...(trading ? { trading } : {}), maxTradeUsd, onApproval: (accountId, a) => pushTo?.(accountId, 'approvals', 'approval', a), ...(store ? { store } : {}), ...(historian ? { historian } : {}), ...(funders ? { funders } : {}), webDist: env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,
  landingDist: env.LANDING_DIST ?? new URL('../../landing/dist', import.meta.url).pathname });

const realtime = await registerRealtime(app, edge, { ...(accounts ? { accounts } : {}) });
const publish = realtime.publish;
pushTo = realtime.pushTo;

let stopping = false, savedAt = Date.now();
async function loop() {
  const pollMs = Number(env.POLL_MS ?? 2000);
  while (!stopping) {
    const started = Date.now();
    // Never before the saved coins are back in memory (the cursor is set just before they are restored).
    if (snapshot && tracker.cursor > 0n && Date.now() - savedAt >= 60_000) { savedAt = Date.now(); void snapshot.save().catch(error => log('snapshot_failed', { error: String((error as Error).message).slice(0, 160) })); }
    try { await tracker.tick(); edge.prune(); void edge.name(); edge.schedule(); edge.settle(); publish(); void hype.get(); void trading?.reconcile().catch(error => log('reconcile_failed', { error: String((error as Error).message).slice(0, 160) })); }
    catch (error) { log('tick_failed', { error: String((error as Error).message).slice(0, 200) }); }
    await new Promise(r => setTimeout(r, Math.max(250, pollMs - (Date.now() - started))));
  }
}

const shutdown = async (signal: string) => {
  if (stopping) return; stopping = true; log('shutdown', { signal });
  // Only once the saved coins are back in memory: a save before that would drop what the file still holds.
  if (snapshot && tracker.cursor > 0n) { try { log('snapshot_saved', { coins: snapshot.saveSync() }); } catch (error) { log('snapshot_failed', { error: String((error as Error).message).slice(0, 160) }); } }
  historian?.stop(); await app.close().catch(() => undefined); clients.meter.stop(); try { store?.close(); } catch { /* already closed */ } await clients.meter.close().catch(() => undefined); process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await hype.get();
await app.listen({ port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
log('listening', { port: Number(env.PORT ?? 8080), hypeUsd: hype.latest });
// Serve /health while the hour of history replays; the radar fills as it lands.
tracker.start().then(() => { log('backfilled', { head: Number(tracker.head), coins: tracker.coins.size, restored: tracker.restored }); void edge.name(); edge.schedule(); void loop();
  if (historian && env.HISTORIAN !== 'off') void historian.run(); })
  .catch(error => { log('backfill_failed', { error: String((error as Error).message).slice(0, 200) }); void loop(); });
