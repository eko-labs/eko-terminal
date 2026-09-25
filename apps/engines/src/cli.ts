import { enginesHalt } from './halt.js';
import { withRpcOrigin } from '@eko/chain';
import { openDb, migrate, migrateEngines, PostgresBus, launchEmitter } from '@eko/db';
import { createMeteredClients, rpcRoleHealth, rpcStopReason, loadRegistry, ponsCurveAbi, ProgressWatchdog, rpcOriginClient, type PonsProfileClient } from '@eko/chain';
import { createPublicClient } from 'viem';
import { z } from 'zod';
import type { BlockReader } from './activity.js';
import { EngineWorker, RATING_CODE_AT, UNISWAP_RATING_CODE_AT } from './worker.js';
import { fingerprintWindows } from './watcher/store.js';
import { SellChecker, SellCheckScheduler } from './sell-check.js';
const flag=z.enum(['true','false','1','0','']).optional().transform(v=>v==='true' || v==='1');
const config=z.object({
  APP_ROLE:z.literal('engines').default('engines'),ENGINE_MODE:z.enum(['live','replay']).default('live'),
  DATABASE_URL:z.string().optional(),PGLITE_DIR:z.string().default('.data/indexer'),RPC_HTTP_URL:z.url().optional(),
  FROM:z.coerce.number().int().nonnegative().safe().optional(),TO:z.coerce.number().int().nonnegative().safe().optional(),
  ENGINE_CONCURRENCY:z.coerce.number().int().min(1).max(32).default(4),ENGINE_POLL_MS:z.coerce.number().int().min(100).max(60000).default(2000),
  // Live catch-up: checkpoints further behind head than this are coalesced into one current evaluation per coin.
  // 604800 (seven days) keeps full catch-up; ENGINE_MODE=replay fills skipped history.
  ENGINE_LIVE_BACKLOG_SEC:z.coerce.number().int().min(60).max(604800).default(900),
  ENGINE_LIVE_SLICE_MS:z.coerce.number().int().min(1000).max(3600000).default(60000),
  // Live activity reads: 'incremental' reads only what changed since the previous poll; 'full' reads every coin's whole
  // history on every poll (the pre-2026-10-08 behaviour; it outgrew the heap in production, keep it for small databases).
  ENGINE_WATCHER_REFRESH_ENABLED:z.enum(['true','false','1','0','']).default('true'),
  ENGINE_LIVE_ACTIVITY:z.enum(['incremental','full']).default('incremental'),
  // Live loop silent (no poll completed, no evaluation finished) this long: log engines_stalled and exit 1.
  ENGINE_STALL_SEC:z.coerce.number().int().min(60).max(86400).default(600),
  // Overdue outcome horizons evaluated per live card write while a backlog clears (0 defers them to the end of the poll).
  ENGINE_OUTCOME_LOADS_PER_WRITE:z.coerce.number().int().min(0).max(64).default(8),
  // Live sell checks (BACKEND §6.2, eth_call probe). Off unless set; needs RPC_HTTP_URL and runs in live mode only.
  BLUE_CHIP_ENABLED:flag,
  SELL_CHECK_ENABLED:flag,
  SELL_CHECK_POLL_MS:z.coerce.number().int().min(1000).max(600000).default(5000),
  SELL_CHECK_BATCH:z.coerce.number().int().min(1).max(64).default(8),
  SELL_CHECK_DAILY_REQUESTS:z.coerce.number().int().min(0).max(5000000).default(60000),
  SELL_CHECK_MIN_INTERVAL_SEC:z.coerce.number().int().min(60).max(86400).default(600),
  SELL_CHECK_UNSUPPORTED_DAYS:z.coerce.number().int().min(0).max(365).default(7),
  SELL_CHECK_BUY_FAILED_HOURS:z.coerce.number().int().min(1).max(168).default(24),
  SELL_CHECK_SELLABLE_HOURS:z.coerce.number().int().min(1).max(168).default(24),
  SELL_CHECK_RESERVE_PCT:z.coerce.number().int().min(0).max(100).default(20),
  SELL_CHECK_MAX_AGE_SEC:z.coerce.number().int().min(600).max(604800).default(86400),
});
async function main() {
  const parsed=config.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid engine environment: ${parsed.error.issues.map(i=>i.path.join('.')).join(', ')}`);
  const env=parsed.data;
  const fingerprints=fingerprintWindows();
  loadRegistry();
  if (env.ENGINE_MODE==='replay' && (env.FROM==null || env.TO==null || env.TO<env.FROM)) throw new Error('Replay requires FROM <= TO');
  const db=await openDb({ databaseUrl:env.DATABASE_URL,pgliteDir:env.PGLITE_DIR });
  const stopDbMetrics=db.startTransactionMetrics();
  let readBlock:BlockReader | undefined;
  let client: PonsProfileClient | undefined;
  let rerateClient: PonsProfileClient | undefined;
  let stopWorker:() => void=() => {};
  let watchdog: ProgressWatchdog | undefined;
  // Every chain read goes through the metered transport (task 024), sharing this process's database for usage.
  const updatePause = await rpcRoleHealth(db, 'engines');
  const rpc=env.RPC_HTTP_URL ? createMeteredClients({...process.env,APP_ROLE:env.APP_ROLE},{ db,pauseOnOutage:true,onPauseChange:updatePause,onSessionBudget:() => { rpc?.meter.stop('rpc_session_budget_reached');stopWorker(); } }) : undefined;
  const stopStartup=()=>rpc?.meter.stop();
  process.on('SIGINT',stopStartup);process.on('SIGTERM',stopStartup);
  try {
  if (rpc) {
    rpc.archive=rpcOriginClient(rpc.archive,'engines.pons_profile');
    if (await rpc.paid.getChainId()!==4663) throw new Error('RPC chain ID must be 4663');
    // Block times public first, paid only when the public read fails (the indexer's parent-header lane): a cold start
    // read about 170 headers a minute on the paid lane on 2026-10-11, under the per-minute limit card reads share.
    const headers=createPublicClient({transport:rpc.meter.transport('parent')});
    readBlock=async block=>{const header=await headers.getBlock({blockNumber:BigInt(block),includeTransactions:false});return {timestamp:header.timestamp,hash:header.hash};};
    readBlock.readMany=blocks=>Promise.all(blocks.map(block=>readBlock!(block)));
    const profileClient=(archive: typeof rpc.archive): PonsProfileClient => ({ getCode:input=>withRpcOrigin('engines.cli.L62',()=>archive.getCode(input)),readContract:async input=>{
      const value=await withRpcOrigin('engines.cli.L63',()=>archive.readContract(input));
      if (typeof value!=='bigint') throw new Error('Unexpected Pons read result');
      return value;
    },readGetters:async ({curve,token,blockNumber})=>{
      // One Multicall3 call (the chain's registered multicall3) at the same block; any failed getter fails the read.
      const values=await withRpcOrigin('engines.cli.L68',()=>archive.multicall({allowFailure:false,blockNumber,contracts:[
        {address:curve,abi:ponsCurveAbi,functionName:'creatorTaxBps'},{address:curve,abi:ponsCurveAbi,functionName:'feeBps'},
        {address:curve,abi:ponsCurveAbi,functionName:'currentSnipeTaxBps',args:[token]}]}));
      if (!values.every(value=>typeof value==='bigint')) throw new Error('Unexpected Pons read result');
      return values as [bigint,bigint,bigint];
    } });
    client=profileClient(rpc.archive);
    rerateClient={...profileClient(rpcOriginClient(createPublicClient({chain:rpc.archive.chain,transport:rpc.meter.transport('archive',undefined,false)}) as typeof rpc.archive,'engines.pons_profile')),outageNonBlocking:true};
  }
    await migrate(db);await migrateEngines(db);
    const telemetry=launchEmitter(db.sql,()=>console.log(JSON.stringify({event:'launch_metrics_unavailable'})));
    let heartbeatAt=0;
    let progressAt=Date.now();
    const log=(event:string,fields:Record<string,unknown>)=>console.log(JSON.stringify({event,...fields}));
    // The live loop shares the indexer's metered RPC; a loop that goes silent exits non-zero for a platform restart.
    const stallWatch=watchdog=env.ENGINE_MODE==='live' ? new ProgressWatchdog({ role:'engines',paused:()=>rpc?.meter.pause!=null,stallMs:env.ENGINE_STALL_SEC*1000,log,reportMs:Infinity }) : undefined;
    if(env.SELL_CHECK_ENABLED && (!rpc || env.ENGINE_MODE!=='live'))log('sell_check_unavailable',{reason:rpc ? 'replay_mode' : 'rpc_not_configured'});
    // Every probe goes through the process meter (paid archive route, pinned block) and the daily cap below.
    const sellChecks=env.SELL_CHECK_ENABLED && rpc && env.ENGINE_MODE==='live' ? new SellCheckScheduler(db,new SellChecker(db,{request:request=>rpcOriginClient(rpc.archive,'engines.sell_check').request(request as never)},{paidWorkAllowed:work=>rpc.meter.paidWorkAllowed(work)}),
      {batch:env.SELL_CHECK_BATCH,dailyRequests:env.SELL_CHECK_DAILY_REQUESTS,minIntervalSec:env.SELL_CHECK_MIN_INTERVAL_SEC,maxAgeSec:env.SELL_CHECK_MAX_AGE_SEC,unsupportedDays:env.SELL_CHECK_UNSUPPORTED_DAYS,buyFailedHours:env.SELL_CHECK_BUY_FAILED_HOURS,sellableHours:env.SELL_CHECK_SELLABLE_HOURS,reservePct:env.SELL_CHECK_RESERVE_PCT},log) : undefined;
    const worker=new EngineWorker(db,{ paidWorkAllowed:rpc ? work=>rpc.meter.paidWorkAllowed(work) : undefined, rpcPaused:()=>rpc?.meter.pause!=null, rerateClient, sellCheckBudget:sellChecks ? {dailyRequests:env.SELL_CHECK_DAILY_REQUESTS,reservePct:env.SELL_CHECK_RESERVE_PCT} : undefined,fingerprints,blueChipEnabled:env.BLUE_CHIP_ENABLED,client,readBlock,outcomeLoadsPerWrite:env.ENGINE_OUTCOME_LOADS_PER_WRITE,onScanComplete:ms=>telemetry.emit('pair_to_complete_verdict_ms',ms),onQueueCompletion:ms=>telemetry.emit('queue_completion_ms',ms),onHeartbeat:()=>{stallWatch?.progress();if(Date.now()-heartbeatAt>=30000){telemetry.emit('role_engines',1);heartbeatAt=Date.now();}},onPlanned:plan=>console.log(JSON.stringify({event:'replay_planned',...plan})),onProgress:(evaluations,block)=>{stallWatch?.progress();if(evaluations%100===0 || Date.now()-progressAt>=30000){console.log(JSON.stringify({event:'engine_progress',evaluations,block,...worker.telemetry()}));progressAt=Date.now();}},concurrency:env.ENGINE_CONCURRENCY,pollMs:env.ENGINE_POLL_MS,liveBacklogSec:env.ENGINE_LIVE_BACKLOG_SEC,liveSliceMs:env.ENGINE_LIVE_SLICE_MS,liveActivity:env.ENGINE_LIVE_ACTIVITY,
      onLiveActivity:stats=>{if(stats.cold || stats.summedCoins || stats.ms>=10000)log('live_activity',{...stats,ms:Math.round(stats.ms)});},
      // Every minute of a live evaluation phase, with or without completed cards, and at its end.
      onEvaluation:progress=>log('engine_evaluation',{...progress}),onBudgetWait:()=>log('engines_budget_wait',{reason:'rpc_budget_exhausted',retrySec:60}),rerate:env.ENGINE_MODE==='live',rerateBefore:RATING_CODE_AT,rerateOtherBefore:UNISWAP_RATING_CODE_AT,onRerate:(cards,firstScans,traded)=>log('engine_rerate',{cards,firstScans,traded}),onRerateError:error=>log('engine_rerate_failed',{error:error instanceof Error ? error.message.replace(/https?:\/\/\S+/g,'<url>').slice(0,200) : 'unknown'}),onLivePlanned:plan=>{if(plan.coalescedCheckpoints || plan.firstScans>10)console.log(JSON.stringify({event:'live_planned',...plan}));},bus:env.DATABASE_URL ? new PostgresBus(env.DATABASE_URL) : db.bus });
    let interrupted=false;
    const stop=()=>{interrupted=true;worker.stop();sellChecks?.stop();rpc?.meter.stop();};stopWorker=stop;process.on('SIGINT',stop);process.on('SIGTERM',stop);
    try {
      console.log(JSON.stringify({ event:'engines_started',role:env.APP_ROLE,mode:env.ENGINE_MODE }));
      if (env.ENGINE_MODE==='replay') {const evaluations=await worker.replay(env.FROM!,env.TO!);console.log(JSON.stringify({event:interrupted?'replay_interrupted':'replay_complete',evaluations,...worker.summary(),...worker.telemetry()}));}
      else {
        if(sellChecks)log('sell_check_started',{pollMs:env.SELL_CHECK_POLL_MS,batch:env.SELL_CHECK_BATCH,dailyRequests:env.SELL_CHECK_DAILY_REQUESTS});
        const checks=sellChecks?.run(env.SELL_CHECK_POLL_MS);
        stallWatch?.start();
        try {await worker.run();} finally {sellChecks?.stop();await checks;}
      }
      console.log(JSON.stringify({ event:'engines_stopped',mode:env.ENGINE_MODE }));
    } finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await telemetry.drain(); }
  } finally { process.removeListener('SIGINT',stopStartup);process.removeListener('SIGTERM',stopStartup);try { await rpc?.meter.close();stopDbMetrics();await db.close(); } finally { watchdog?.stop(); } }
}
main().catch(error=>{ if(rpcStopReason(error)==='shutdown_requested'||rpcStopReason(error)==='rpc_session_budget_reached')return;console.error(JSON.stringify(enginesHalt(error)));console.error(error instanceof Error && /^Missing (launch|activity) timestamp at block [0-9]+; provide RPC_HTTP_URL for archive headers$/.test(error.message) ? error.message : 'Engines halted: check environment, indexed range and database.');process.exit(1); });
