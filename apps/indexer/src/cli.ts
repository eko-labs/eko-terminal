import { startPartitionMaintenance } from './partitions.js';
import { AgentRegistryCollector, type RegistryWalletEventProfile } from './agent-registry.js';
import { readFile } from 'node:fs/promises';
import { acquireScanJob } from './scan-jobs.js';
import { enrichSenders } from './enrich.js';
import { DeferredEvents } from './deferred.js';
import { isAddress, type Address } from 'viem';
import { reportIndexerError } from './guard-stop.js';
import { z } from 'zod';
import { loadRegistry, createMeteredClients, rpcRoleHealth, RpcGuardError, rpcStopReason, isTransientRpcUnavailable, safeError, type ProgressWatchdog, type RpcEnv } from '@eko/chain';
import { openDb, migrate, migrateEngines, rebuildBars, launchEmitter } from '@eko/db';
import { createClients } from './clients.js';
import { BlockDecoder } from './decode.js';
import { LogHeadFollower } from './log-head.js';
import { HeadFollower } from './head.js';
import { PonsBackfill, blockAtTime, type Stream } from './backfill.js';
import { log, Metrics } from './types.js';
import { indexerWatchdog } from './stall-watch.js';
const integer = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const config = z.object({
  APP_ROLE: z.literal('indexer').default('indexer'), DATABASE_URL: z.string().optional(), PGLITE_DIR: z.string().default('.data/indexer'),
  RPC_HTTP_URL: z.url(), RPC_PUBLIC_HTTP_URL: z.url().optional(), RPC_WS_URL: z.url().optional(),
  INDEX_AGENT_REGISTRY_PROFILE: z.string().optional(),
  // Wallet-protocol evidence (userops, 7702 delegations, per-transaction coverage) is the largest table group.
  INDEX_WALLET_PROTOCOL: z.enum(['on', 'off']).default('on'),
  INDEX_HEAD_MODE: z.enum(['logs', 'blocks']).default('logs'), INDEX_HEAD_TICK_MS: integer(1000), INDEX_HEAD_MAX_RANGE: integer(200), INDEX_CODE_CACHE_SEC: integer(3600), INDEX_TRANSIENT_RETRY_SEC: integer(300),
  // Behind an advancing head with no cursor progress for this long: log indexer_stalled and exit 1.
  INDEX_STALL_SEC: integer(300),
  // Live catch-up: window while far behind, blocks per write transaction, and whether parent links of blocks below the
  // reorg window are read ('fetch') or left unrecorded ('skip').
  INDEX_HEAD_CATCHUP_RANGE: integer(1000).pipe(z.number().max(20000)), INDEX_HEAD_COMMIT_BLOCKS: integer(250).pipe(z.number().max(5000)),
  INDEX_HEAD_DEEP_PARENTS: z.enum(['fetch', 'skip']).default('skip'),
  INDEX_START_BLOCK: z.preprocess(v => v === '' ? undefined : v, z.coerce.bigint().min(0n).optional()), INDEX_PREFETCH_BLOCKS: integer(32).pipe(z.number().max(128)), INDEX_BACKFILL_WORKERS: integer(4), INDEX_LOG_RANGE: integer(2000).pipe(z.number().max(20000)), INDEX_REORG_DEPTH: integer(256),
});
async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--');
  const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === 'bars:rebuild') {
    const range = z.object({ from: z.coerce.bigint().min(0n), to: z.coerce.bigint().min(0n) }).parse({ from: option('from'), to: option('to') });
    const db = await openDb({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR });
    try { await migrate(db); await db.tx(tx => rebuildBars(tx, range.from, range.to),{retry:true}); log('bars_rebuilt', { from: range.from.toString(), to: range.to.toString() }); }
    finally { await db.close(); }
    return;
  }
  const parsed = config.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid indexer environment: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const env = { ...process.env, ...parsed.data } as RpcEnv & typeof parsed.data; const registry = loadRegistry();
  const db = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
  const stopDbMetrics=db.startTransactionMetrics();
  const telemetry=launchEmitter(db.sql,()=>log('launch_metrics_unavailable'));
  let worker: HeadFollower | LogHeadFollower | PonsBackfill | undefined;
  let watchdog: ProgressWatchdog | undefined;
  let stopPartitions:(()=>Promise<void>)|undefined;
  let registryStop:()=>void=()=>{};
  let interrupted = false; let failed = false;
  const stop = (reason: 'shutdown_requested' | 'rpc_session_budget_reached' = 'shutdown_requested') => { interrupted = true; if (reason === 'shutdown_requested') log(reason, { finishing_current_transaction: true }); worker?.stop(); registryStop(); meter.stop(reason); };
  const updatePause = await rpcRoleHealth(db, 'indexer');
  const meter = createMeteredClients(env, { db, log, pauseOnOutage: true, onPauseChange: updatePause, onSessionBudget: () => stop('rpc_session_budget_reached') }).meter;
  const signalStop = () => stop();
  process.once('SIGTERM', signalStop); process.once('SIGINT', signalStop);
  meter.start();
  try {
    await migrate(db);
    stopPartitions=startPartitionMaintenance(db);
    if(args[0]!=='backfill' && args[0]!=='enrich')await migrateEngines(db);
    const client = createClients(env, registry, meter, { enrich:args[0]==='enrich', head: args[0] !== 'backfill' && env.INDEX_HEAD_MODE === 'logs' });
    if (await client.chainId() !== 4663) throw new Error('RPC chain ID must be 4663');
    if(args[0]==='enrich'){const coin=option('coin');if(!coin||!isAddress(coin))throw new Error('enrich requires --coin <address>');log('senders_enriched',{coin,...await enrichSenders(db,coin as Address,client)});return;}
    const liveMetrics=new Metrics((event,fields)=>{
      log(event,fields);
      if(event==='ingest_metrics' && args[0]!=='backfill'){
        telemetry.emit('role_indexer',1);
        if(liveMetrics.hasHeadMeasurement())telemetry.emit('head_lag_ms',Number(fields?.head_lag_ms));
      }
    });
    const walletEvents: RegistryWalletEventProfile[] = env.INDEX_AGENT_REGISTRY_PROFILE ? JSON.parse(await readFile(env.INDEX_AGENT_REGISTRY_PROFILE,'utf8')) : [];
    const agentRegistry=new AgentRegistryCollector(createClients(env,registry,meter),db,registry,{walletEvents,window:env.INDEX_LOG_RANGE,reorgDepth:env.INDEX_REORG_DEPTH});
    let wakeRegistry:(()=>void)|undefined;
    registryStop=()=>{agentRegistry.stop();wakeRegistry?.();};
    if(args[0]==='registry:sync') {
      const range=z.object({from:z.coerce.bigint().min(0n),to:z.coerce.bigint().min(0n)}).parse({from:option('from')??'0',to:option('to')??String(await client.head())});
      await agentRegistry.reconcile();
      await agentRegistry.scan(range.from,range.to);await agentRegistry.snapshot(range.to);
      log('agent_registry_coverage',await agentRegistry.coverage());return;
    }
    const decoder = new BlockDecoder(client, registry, liveMetrics);
    const deferred = new DeferredEvents(db, client, registry, { reorgDepth: env.INDEX_REORG_DEPTH });
    decoder.storeWalletProtocol = env.INDEX_WALLET_PROTOCOL === 'on';
    const backfill = args[0] === 'backfill';
    let from = 0n, to = 0n, stream: Stream = 'logs:pons_factory';
    if (backfill) {
      const toBlock = option('to') ?? (await client.head()).toString();
      const fromBlock = option('from') ?? (await blockAtTime(client, BigInt((await (client.header?.(BigInt(toBlock)) ?? client.block(BigInt(toBlock)))).timestamp) - 30n * 86400n, BigInt(toBlock))).toString();
      const parsed = z.object({ stream: z.enum(['logs:pons_factory','logs:pons_curves','logs:pools','logs:pair_swaps','logs:holders']), from: z.coerce.bigint().min(0n), to: z.coerce.bigint().min(0n), workers: integer(env.INDEX_BACKFILL_WORKERS) }).parse({ stream: option('stream'), from: fromBlock, to: toBlock, workers: option('workers') });
      from = parsed.from; to = parsed.to; stream = parsed.stream;
      worker = new PonsBackfill(client, db, decoder, { workers: parsed.workers, logRange: env.INDEX_LOG_RANGE });
    } else {
      // An alive process that stops moving exits non-zero so the platform restarts it, and its lag stays visible meanwhile.
      const stallWatch = watchdog = indexerWatchdog({ paused: () => meter.pause !== null, stallMs: env.INDEX_STALL_SEC * 1000, client, metrics: liveMetrics, log,
        emit: (metric, value) => telemetry.emit(metric, value) });
      const hooks = { onHead: (n: bigint) => stallWatch.observeHead(n), onProgress: (n: bigint) => stallWatch.progress(n) };
      worker = env.INDEX_HEAD_MODE === 'blocks'
        ? new HeadFollower(client, db, decoder, { startBlock: env.INDEX_START_BLOCK, prefetchBlocks: env.INDEX_PREFETCH_BLOCKS, reorgDepth: env.INDEX_REORG_DEPTH, ...hooks })
        : new LogHeadFollower(client, db, decoder, { startBlock: env.INDEX_START_BLOCK, tickMs: env.INDEX_HEAD_TICK_MS, maxRange: env.INDEX_HEAD_MAX_RANGE, codeCacheSec: env.INDEX_CODE_CACHE_SEC, reorgDepth: env.INDEX_REORG_DEPTH,
          catchUpRange: env.INDEX_HEAD_CATCHUP_RANGE, commitRange: env.INDEX_HEAD_COMMIT_BLOCKS, deepParents: env.INDEX_HEAD_DEEP_PARENTS, ...hooks,
          // Stored raw events of pools that have become known are turned into rows a batch at a time, between ticks at the head.
          onPools: () => deferred.wake(), afterTick: () => deferred.step() });
    }
    if (interrupted) return;
    try { log('indexer_started', { role: env.APP_ROLE, mode: backfill ? 'backfill' : 'head' }); if (worker instanceof HeadFollower || worker instanceof LogHeadFollower) {
      const scanClient=createClients(env,registry,meter,{enrich:true});
      const scanLoop=(async()=>{
        while(!interrupted){
          await acquireScanJob(db,scanClient);
          if(!interrupted)await new Promise<void>(resolve=>setTimeout(resolve,1000));
        }
      })().catch(error=>{stop();throw error;});
      const registryLoop=(async()=>{
        while(!interrupted){
          // A spent paid budget or a provider outage skips this poll instead of stopping the head indexer with it.
          try { log('agent_registry_coverage',await agentRegistry.poll()); }
          catch(error){ if(interrupted||!(rpcStopReason(error)==='rpc_budget_exhausted'||isTransientRpcUnavailable(error)))throw error; log('agent_registry_retry',{reason:rpcStopReason(error)??'rpc_unavailable',error:safeError(error)}); }
          if(!interrupted)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,60000);wakeRegistry=()=>{clearTimeout(timer);resolve();};});
        }
      })().catch(error=>{stop();throw error;});
      watchdog?.start();
      const results=await Promise.allSettled([worker.run().finally(()=>{interrupted=true;registryStop();}),scanLoop,registryLoop]);
      for(const result of results)if(result.status==='rejected')throw result.reason;
    } else await worker.run(stream, from, to); }
    finally { process.removeListener('SIGTERM', signalStop); process.removeListener('SIGINT', signalStop); }
  } catch (error) { failed = true; throw error; } finally {
    process.removeListener('SIGTERM', signalStop); process.removeListener('SIGINT', signalStop);
    // The watchdog outlives cleanup: a shutdown that hangs on the database or RPC is a stall too.
    try { try { await stopPartitions?.();await telemetry.drain();await meter.close(); } finally { stopDbMetrics();await db.close(); } } finally { watchdog?.stop(); }
    if (!failed && (meter.stopReason === 'rpc_session_budget_reached' || meter.stopReason === 'shutdown_requested')) reportIndexerError(new RpcGuardError(meter.stopReason), log);
  }
}
main().catch(error => { process.exit(reportIndexerError(error, log)); });
