import { getAddress, isAddress } from 'viem';
import { createMeteredClients } from '@eko/chain';
import { chainKeyFrom, loadChain } from './chains/index.js';
import { buildServer } from './server.js';
import { loadBuild } from './build.js';
import { relayClient } from './relay.js';
import { Edge } from './service.js';
import { BACKFILL_SEC, Tracker, type Rpc } from './tracker.js';
import { registerRealtime } from './ws.js';
import { memoryUsageStore } from './usage.js';
import { HistoryStore } from './history.js';
import { Explorer } from './explorer.js';
import { FunderTracer } from './funders.js';
import { RpcFunding } from './funders-rpc.js';
import { Historian } from './historian.js';
import { AccountStore } from './accounts.js';
import { budgetedRpc, Trading, tradeRpc } from './trade.js';
import { parseFlags } from './flags.js';
import { loadFeatures } from './features/index.js';
import { AlertInbox } from './alerts.js';
import { ColumnSnapshot } from './snapshot.js';
import { ProbeSnapshot } from './probe-snapshot.js';
import { freeSpaceCheck, setStorageGuard } from './storage-guard.js';
import { dirname, join } from 'node:path';

/**
 * EKO edge: one chain per deployment. Environment:
 *   EKO_CHAIN        elysium (default) or robinhood; anything else stops the edge at start-up. The chain's profile
 *                    (chains/profiles.ts) sets the defaults below marked "the chain's".
 *   PORT (default 8080), HOST (default 0.0.0.0)
 *   RPC_HTTP_URL     paid RPC (optional; read-only key). Without it, the chain's public RPC is used.
 *   RPC_PUBLIC_HTTP_URL  override of the public RPC.
 *   WEB_DIST         built web app to serve (default ../web/dist)
 *   LANDING_DIST     built landing site, served at / and /site/ (default ../landing/dist)
 *   BACKFILL_BLOCKS  blocks replayed at start (default the chain's: 32,400 on both, about 53 and 55 minutes)
 *   POLL_MS          tracker poll interval (default 2,000)
 *   ASSESS_CONCURRENCY  coin checks in flight (default 2; each is two eth_calls)
 *   LOG_CHUNK        largest eth_getLogs span to try (default the chain's: 2,000 on Elysium, 500 on Robinhood Chain)
 *   HISTORY_DB       EKO's memory, one SQLite file (default .data/history.db; on Railway a volume path). "off" runs stateless.
 *   HISTORIAN        "off" stops the background backfill (launches, swap counts, replays); "on" starts it. Default: on with a
 *                    store and an explorer API (Elysium); off without one (Robinhood Chain's Blockscout refuses scripts).
 *   EXPLORER_URL     Etherscan-style explorer API (default the chain's public Blockscout; none on Robinhood Chain, where the
 *                    funder tracer is then off too)
 *   EXPLORER_RPS     requests per second for each of the historian and the funder tracer (default 2)
 *   FUNDER_TRACE     where funders come from: "explorer", "rpc" (the paid archive RPC: about 45 calls a wallet) or "off".
 *                    Default: the explorer when the chain has one; else the archive RPC while linked_devs is on; else off.
 *   FUNDER_RPC_PER_MIN  archive calls a minute the RPC funder tracer may spend (default 150, about 3 wallets a minute)
 *   REPLAY_MIN_SWAPS swaps a past launch needs before the historian rebuilds it (default 10)
 *   ACCOUNTS         "off" closes wallet sign-in (and with it trading); on by default with a store
 *   TRADING          "off" keeps sign-in but turns wallet trading off
 *   MAX_TRADE_USD    largest trade the panel quotes (default 250)
 *   TRUST_PROXY_HOPS proxies in front of the edge whose X-Forwarded-For is trusted (default 1: Railway). Add one per extra proxy (e.g. Cloudflare).
 *   BUILD_COMMIT     the commit this runs, when neither build.json nor Railway's RAILWAY_GIT_COMMIT_SHA says
 *   RPC_RELAY_URL    RPC the browser wallet relay (/v1/rpc) uses (default: the chain's public RPC; never the paid one)
 *   STORE_MIN_FREE_MB  free space the database volume keeps: below it, new accounts, agents, keys, journal rows, approvals
 *                    and orders are refused (507) until space returns; chain memory keeps writing (default 512)
 *   EKO_FLAGS        features turned on, e.g. "leaderboards,referrals" (flags.ts; docs/FLAGS.md). Unset: none.
 *   COLUMNS_SNAPSHOT the followed coins' file (default columns.json beside HISTORY_DB); "off" turns it off.
 *   PROBES_SNAPSHOT  the coins' cached checks' file (default probes.json beside the coin snapshot; probe-snapshot.ts),
 *                    restored before the server serves; "off" turns it off.
 *   EKO_TOKEN_ADDRESS  the project's token once it is live: shown with a copy button on the landing page and the terminal
 *                    header (/v1/config `token`). Unset or not an address: not shown. EKO_TOKEN_SYMBOL names it (optional).
 */
const env = process.env;
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

const flags = parseFlags(env.EKO_FLAGS);
const tokenAddress = env.EKO_TOKEN_ADDRESS?.trim(), tokenSymbol = env.EKO_TOKEN_SYMBOL?.trim().replace(/^\$/, '').slice(0, 16);
const token = tokenAddress && isAddress(tokenAddress) ? { address: getAddress(tokenAddress), ...(tokenSymbol ? { symbol: tokenSymbol } : {}) } : undefined;
if (tokenAddress && !token) console.warn('EKO_TOKEN_ADDRESS is not an address: the token is not shown.');
const chain = loadChain(chainKeyFrom(env.EKO_CHAIN), flags.on), profile = chain.profile;
log('chain', { key: profile.key, id: profile.id });
const clients = createMeteredClients({ ...env, RPC_PUBLIC_HTTP_URL: env.RPC_PUBLIC_HTTP_URL ?? profile.publicRpc,
  RPC_PUBLIC_MAX_RPM: env.RPC_PUBLIC_MAX_RPM ?? String(profile.publicRpm), RPC_USAGE_DIR: env.RPC_USAGE_DIR ?? '/tmp/eko-rpc-usage' }, {
  // Usage in memory: the edge has no database, and pause persistence needs one.
  store: memoryUsageStore(), chain: profile.chain,
  alert: (reason, fields) => log('rpc_alert', { reason, ...fields }),
});
// Plain JSON-RPC over the metered transport (budgets, timeouts and usage logs stay in force).
const rpc: Rpc = { request: (input) => clients.public.request(input as Parameters<typeof clients.public.request>[0]) };
// Old history (graduates, still-trading graduates, rebase) only from the paid archive: the public RPC keeps minutes.
const archiveRpc: Rpc = { request: (input) => clients.archive.request(input as Parameters<typeof clients.archive.request>[0]) };
const store = env.HISTORY_DB === 'off' ? null : new HistoryStore(env.HISTORY_DB ?? '.data/history.db');
if (store) setStorageGuard(freeSpaceCheck(dirname(env.HISTORY_DB ?? '.data/history.db'), Number(env.STORE_MIN_FREE_MB ?? 512)));
const tracker = new Tracker(rpc, chain, { archiveRpc, backfillBlocks: Number(env.BACKFILL_BLOCKS ?? profile.tracker.backfillBlocks ?? Math.round(BACKFILL_SEC / profile.blockTimeSec)), chunk: Number(env.LOG_CHUNK ?? profile.tracker.chunk),
  ...(store ? { onLaunch: (c) => { try { store.recordLaunch({ token: c.token, launchpad: c.launchpad, deployer: c.creator, poolId: c.poolId, createdBlock: c.block, createdTs: c.ts,
    tx: c.tx, name: c.name, symbol: c.symbol, supply: c.supply.toString() }); } catch (error) { log('launch_record_failed', { error: String((error as Error).message).slice(0, 160) }); } } } : {}) });
const explorerApi = env.EXPLORER_URL ?? profile.explorerApi;
const explorer = (rps: number) => new Explorer({ base: explorerApi, ratePerSec: rps });
// Funders from the explorer API; on a chain without one (Robinhood Chain) from the paid archive RPC, which costs about 45
// calls a wallet, so only while a feature that shows them is on, and only the deployer and first buyers of each launch.
const funderSource = env.FUNDER_TRACE ?? (explorerApi ? 'explorer' : flags.on.has('linked_devs') ? 'rpc' : 'off');
const funders = !store ? null
  : funderSource === 'explorer' && explorerApi ? new FunderTracer(explorer(Number(env.EXPLORER_RPS ?? 2)), store, { log })
  : funderSource === 'rpc' ? new FunderTracer(new RpcFunding(archiveRpc, { perMin: Number(env.FUNDER_RPC_PER_MIN ?? 150) }).find, store, { log, livePerWant: 6, lookupEvery: 3, maxQueue: 1000 })
  : null;
if (funders) log('funders_on', { source: funderSource });
const historian = store ? new Historian(explorer(Number(env.EXPLORER_RPS ?? 2)), store, chain, { tracker, ...(funders ? { funders } : {}) }, { log, minSwaps: Number(env.REPLAY_MIN_SWAPS ?? 10) }) : null;
// The graduation columns' coins, kept on the volume across restarts (snapshot.ts). COLUMNS_SNAPSHOT=off turns it off.
const snapshotPath = env.COLUMNS_SNAPSHOT === 'off' ? null : env.COLUMNS_SNAPSHOT ?? (store ? join(dirname(env.HISTORY_DB ?? '.data/history.db'), 'columns.json') : null);
const snapshot = snapshotPath ? new ColumnSnapshot(snapshotPath, tracker) : null;
const seeded = snapshot?.load() ?? [];
if (snapshot) tracker.seed(seeded);
// The native coin in USD (HYPE or ETH) from the profile's price source.
// The native coin in USD: HYPE from Hyperliquid on Elysium; ETH from Hyperliquid, checked against the WETH/USDG pool, on Robinhood Chain.
const hype = chain.price(rpc);
const edge = new Edge(tracker, rpc, chain, hype, { log, concurrency: Number(env.ASSESS_CONCURRENCY ?? 2),
  ...(store && historian ? { memory: { store, historian, ...(funders ? { funders } : {}) } } : {}) });
// The coins' cached checks, kept beside the coin snapshot and put back before the server serves (probe-snapshot.ts): a coin
// shows its last verdict and score as soon as the tracker has it again, and only checks older than the usual ten minutes
// are redone. Only checks for coins the coin snapshot still holds are kept.
const probesPath = env.PROBES_SNAPSHOT === 'off' ? null : env.PROBES_SNAPSHOT ?? (snapshotPath ? join(dirname(snapshotPath), 'probes.json') : null);
const probeSnapshot = probesPath ? new ProbeSnapshot(probesPath, edge, log) : null;
if (probeSnapshot) {
  const tracked = seeded.length ? new Set(seeded.map(c => c.token.toLowerCase())) : undefined;
  log('probes_restored', { probes: edge.restoreProbes(probeSnapshot.load(tracked)) });
}
const accounts = store && env.ACCOUNTS !== 'off' ? new AccountStore(store.db) : null;
const maxTradeUsd = Number(env.MAX_TRADE_USD ?? 250);
let pushTo: ((accountId: string, ch: string, kind: string, data: unknown) => void) | null = null;
const trading = accounts && env.TRADING !== 'off' ? new Trading({ db: store!.db, rpc: tradeRpc(rpc), receiptRpc: budgetedRpc(rpc, { perMin: 60, inFlight: 4 }), chain, coin: (a) => tracker.coin(a), assess: (c) => edge.fresh(c), hypeUsd: () => hype.latest, maxTradeUsd,
  onOrder: (accountId, order) => pushTo?.(accountId, 'orders', 'order', { order }) }) : null;
if (flags.unknown.length) log('flags_unknown', { names: flags.unknown });
const features = await loadFeatures(flags.on);
const alerts = new AlertInbox();
if (features.length) log('features_on', { flags: features.map(f => f.flag) });
const app = buildServer(edge, { rpc, relay: relayClient(env.RPC_RELAY_URL ?? env.RPC_PUBLIC_HTTP_URL ?? profile.publicRpc), trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 1), build: loadBuild(), flags: flags.on, ...(token ? { token } : {}), features, alerts, ...(accounts ? { accounts } : {}), ...(trading ? { trading } : {}), maxTradeUsd, onApproval: (accountId, a) => pushTo?.(accountId, 'approvals', 'approval', a), ...(store ? { store } : {}), ...(historian ? { historian } : {}), ...(funders ? { funders } : {}), webDist: env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,
  landingDist: env.LANDING_DIST ?? new URL('../../landing/dist', import.meta.url).pathname });

const realtime = await registerRealtime(app, edge, { ...(accounts ? { accounts } : {}) });
const publish = realtime.publish;
pushTo = realtime.pushTo;
alerts.deliver = (accountId, alert) => pushTo?.(accountId, 'alerts', 'alert', alert);

let stopping = false, savedAt = Date.now();
async function loop() {
  const pollMs = Number(env.POLL_MS ?? 2000);
  while (!stopping) {
    const started = Date.now();
    // Never before the saved coins are back in memory (the cursor is set just before they are restored).
    if (tracker.cursor > 0n && Date.now() - savedAt >= 60_000) { savedAt = Date.now();
      if (snapshot) void snapshot.save().catch(error => log('snapshot_failed', { error: String((error as Error).message).slice(0, 160) }));
      if (probeSnapshot) void probeSnapshot.save().catch(error => log('probes_save_failed', { error: String((error as Error).message).slice(0, 160) })); }
    try { await tracker.tick(); edge.prune(); void edge.name(); edge.schedule(); edge.warm(); edge.settle(); publish(); void hype.get(); void trading?.reconcile().catch(error => log('reconcile_failed', { error: String((error as Error).message).slice(0, 160) })); }
    catch (error) { log('tick_failed', { error: String((error as Error).message).slice(0, 200) }); }
    await new Promise(r => setTimeout(r, Math.max(250, pollMs - (Date.now() - started))));
  }
}

const shutdown = async (signal: string) => {
  if (stopping) return; stopping = true; log('shutdown', { signal });
  // Only once the saved coins are back in memory: a save before that would drop what the file still holds.
  if (snapshot && tracker.cursor > 0n) { try { log('snapshot_saved', { coins: snapshot.saveSync() }); } catch (error) { log('snapshot_failed', { error: String((error as Error).message).slice(0, 160) }); } }
  // The checks are all in memory from the start (restored before serving), so they are saved whatever the replay's state.
  if (probeSnapshot) { try { log('probes_saved', { probes: probeSnapshot.saveSync() }); } catch (error) { log('probes_save_failed', { error: String((error as Error).message).slice(0, 160) }); } }
  historian?.stop(); await app.close().catch(() => undefined); clients.meter.stop(); try { store?.close(); } catch { /* already closed */ } await clients.meter.close().catch(() => undefined); process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await hype.get();
await app.listen({ port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
log('listening', { port: Number(env.PORT ?? 8080), hypeUsd: hype.latest });
// Serve /health while the hour of history replays; the radar fills as it lands.
// Checks start once the saved coins are back (the cursor is set just before they are restored), not after the replay:
// a check reads the chain at the head the start read, and the replay only adds trades, so a coin that trades in the
// replayed hour is simply due again later. Nothing is pruned until the replay is done (a coin it has not reached yet
// keeps its restored check), and the RPC caps are shared with the replay as before.
const early = setInterval(() => { if (!stopping && tracker.cursor > 0n) edge.schedule(); }, Number(env.POLL_MS ?? 2000));
tracker.start().then(() => { clearInterval(early); log('backfilled', { head: Number(tracker.head), coins: tracker.coins.size, restored: tracker.restored, probes: edge.assessedCount }); void edge.name(); edge.schedule(); void loop();
  if (historian && (env.HISTORIAN ?? (explorerApi ? 'on' : 'off')) !== 'off') void historian.run(); })
  .catch(error => { clearInterval(early); log('backfill_failed', { error: String((error as Error).message).slice(0, 200) }); void loop(); });
