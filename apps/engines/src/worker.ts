import { countEvaluations, logThroughput, recordFirstPlans, type EvaluationCount } from './throughput.js';
import { watcherRefreshEnabled } from './watcher/control.js';
import { backfillBlueChip, publishBlueChipMeasurements } from './blue-chip.js';
import { refreshFlows, refreshCoinFlow, type FlowOptions } from './watcher/flow-store.js';
import { refreshFingerprints, replayFingerprints, type FingerprintOptions } from './watcher/store.js';
import { writeRegistryLabels } from './registry-labels.js';
import { expireSimulationTraces } from './reference-simulation.js';
import { expireV4ReferenceTraces } from './v4-reference.js';
import { retryableTransaction, TransactionRetryExhaustedError, binary, hex, publishReceipt, priceMovedCoins, ScanJobs, scanTarget, recordScanStart, recordScanVerdict, type ChainDb, type EngineBus } from '@eko/db';
import { assembleVerdict, evaluatePlaybooks, rules, RULES_VERSION } from '@eko/playbooks';
import { shouldRecomputeSignal } from '@eko/signal';
import { isRpcUnavailable, isRpcPaidDeferred, rpcStopReason, withRpcOrigin, type RpcWork, type PonsProfileClient } from '@eko/chain';
import { ratingPriceMove, type Address, type CoinCard, type PlaybookId, type Verdict } from '@eko/shared';
import { lockEngineWrites } from './write-locks.js';
import { OutcomeDifferences, ratingOutcome } from './rating-outcome.js';
import { assembleCard, cardHash, digest, evaluatedPlaybooks, UNSOURCED_PLAYBOOKS } from './card.js';
import { loadSources, historyAt, seconds, type LoadedSources, type SourceMemo } from './sources.js';
import { refreshClock, resolveClock, coinActivity, checkpoints, blockIndex, type ActivityBase, type BlockReader, type BlockTime, type ClockCache, type Checkpoint, type CoinActivity } from './activity.js';
import { LiveActivity, baseColumns, leaveActivityFeed, type LiveActivityStats } from './live-activity.js';
import { materializeHistory, updateOutcomes, OUTCOME_LOADS_PER_WRITE, type OutcomeBudget, type OutcomeQueue } from './outcomes.js';
/**
 * Pending cards re-rated per live poll, after first scans and before backlog (staleRatings). Polls write one card per
 * transaction and yield to new launches only after this tier; the loop beside them (rerateLoop) does the bulk in groups.
 */
export const RERATE_PER_POLL=100;
/** Cards written before 7426b59 (Clear for Pons coins, deployed 2026-10-10 21:05Z) used rules that could not reach Clear. */
export const CLEAR_RULES_AT='2026-10-10T21:05:00Z';
/**
 * Cards written before this time were rated by code that could not complete checks the current code completes: pending
 * cards before e13699e (2026-10-11 21:30Z: taxes and the honeypot check from independent sellers, the launchpad's own
 * hook, token-paired curves), and every card before the run-up check and the recalibrated bundle and deployer levels
 * (deployed 2026-10-12, this time set just after their deploy). The live CLI re-rates them once. Move it forward with any change that completes more checks;
 * a sell check landing after a card is caught by staleRatings without it.
 */
export const RATING_CODE_AT='2026-10-12T18:30:00Z';
/**
 * The same for coins that did not launch on Pons, whatever their grade: cards written before this time could not see a
 * deployer taking its liquidity out (the check read only positions still in the pool) and left the liquidity check
 * not run on a coin with a second pool. They are few (onboarding began that morning) and are re-rated once.
 */
export const UNISWAP_RATING_CODE_AT='2026-10-13T07:30:00Z';
const DB_CONTENTION_SKIPPED=Symbol('database_contention');
const NO_OTHER_RERATE='1970-01-01T00:00:00Z';
/** Stale pending cards the re-rating loop loads at once and writes in one transaction. */
export const RERATE_WIDTH=16;
/** Each loop cycle reserves half of its 32 ordinary slots for first scans; urgent moves are additional. */
// TODO(spec): §6.5 defines triggers but not quotas; the first-scan reservation is 16 of 32 ordinary slots.
export const FIRST_SCAN_SLOTS=16;
/** Blocks before the loop tries again to first-scan a coin it could not load (about two minutes at 0.2 s blocks). */
export const FIRST_SCAN_RETRY_BLOCKS=600;
/** A coin that traded after its card is rated again once that card is at least this old (seconds). */
export const TRADED_RERATE_SEC=300;
/**
 * The same for a coin that never had a Pons curve. Its checks read holders, the deployer and the pool, which move more
 * slowly than a curve's run-up, and the busiest of them trade every block: at the curve coins' pace they would take every
 * re-rating slot (2026-10-13: about 260 such coins traded in an hour, 130 Pons coins).
 */
export const TRADED_RERATE_OTHER_SEC=1800;
/** Outcome horizons the end of a live poll may evaluate, so first scans and re-ratings can skip them per write. */
export const OUTCOME_LOADS_PER_POLL=40;
/** Blocks to wait before reloading a coin whose sources were unavailable: doubles per attempt, from about two minutes to about twelve hours. */
export const retryAfterBlocks=(attempts:number)=>Math.min(2**Math.max(1,Math.min(attempts,10)),1024)*600;
import { performance } from 'node:perf_hooks';
import { ReplayCache, type WriteState } from './replay-cache.js';
import { persistShadowGuardV2 } from './shadow-v2.js';
import { ReplayMetrics } from './metrics.js';
import { verdictReceipt } from './receipt.js';
import { historyPrune, historyPrunes, revivedBy } from './history-prunes.js';

export interface WorkerOptions {
  paidWorkAllowed?: (work: RpcWork) => Promise<boolean>;
  sellCheckBudget?: { dailyRequests: number; reservePct: number };
  fingerprints?:FingerprintOptions;
  flow?:FlowOptions;
  /** Explicit configured normalizer acquisition; never called for retrospective replay. */
  referenceSimulation?: (coin:Address,block:number)=>Promise<void>;
  onScanComplete?: (ms:number)=>void; onScanQueueDelay?: (ms:number)=>void;
  onQueueCompletion?: (ms: number) => void; onHeartbeat?: () => void;
  /** A poll stopped on a spent daily paid budget; run() waits `budgetWaitMs` (default 60 s) and polls again. */
  onBudgetWait?: () => void; budgetWaitMs?: number;
  /** Live: run rerateLoop() beside the polls (the CLI turns it on). `onRerate` reports each batch's cards. */
  rpcPaused?: () => boolean;
  rerateClient?: PonsProfileClient;
  rerate?: boolean; rerateIdleMs?: number; onRerate?: (cards: number, firstScans: number, traded: number) => void; onRerateError?: (error: unknown) => void;
  /** Live: re-rate pending cards written before this ISO time (the CLI passes RATING_CODE_AT). Wall-clock, like engine_runs.created_at. */
  rerateBefore?: string;
  /** Live: cards of coins that did not launch on Pons written before this time are re-rated once (the CLI passes UNISWAP_RATING_CODE_AT). */
  rerateOtherBefore?: string;
  concurrency?: number; pollMs?: number; client?: PonsProfileClient; bus?: EngineBus; readBlock?: BlockReader; now?: () => number; replayCache?:boolean;marketWindow?:boolean; onPlanned?:(plan:{tasks:number;coins:number;from:number;to:number})=>void; onProgress?: (completed:number,block:number) => void;
  /**
   * Live only. Checkpoints older than this many seconds behind the indexed head are not replayed one by one:
   * the coin is evaluated once at its newest checkpoint (or at head). Unset keeps full catch-up, as replay does.
   * Skipped history can be filled later with ENGINE_MODE=replay, which skips runs that already exist.
   */
  liveBacklogSec?: number;
  blueChipEnabled?: boolean;
  /** Live only. After this long, a poll yields to a newer launch so its first scan is not queued behind backlog. */
  liveSliceMs?: number;
  /** Overdue outcome horizons per live card write; defaults to OUTCOME_LOADS_PER_WRITE. */
  outcomeLoadsPerWrite?: number;
  /**
   * Live only. 'incremental' (default) reads only what changed since the previous poll and plans from per-coin progress
   * (live-activity.ts); 'full' aggregates every coin's whole history on every poll, as replay does.
   */
  liveActivity?: 'incremental' | 'full';
  /** Live, incremental only: what each poll's activity refresh read. */
  onLiveActivity?: (stats:LiveActivityStats) => void;
  /** Live only: every planned checkpoint, in execution order (tests compare plans across activity modes). */
  onLiveTasks?: (tasks:readonly Checkpoint[]) => void;
  /**
   * Live only: evaluation-phase progress, every `evaluationReportMs` (default 60000) while a poll evaluates, whether or
   * not any card completed, and once when the phase ends.
   */
  onEvaluation?: (progress:EvaluationProgress) => void;
  evaluationReportMs?: number;
  onLivePlanned?: (plan:LivePlan) => void }
export interface LivePlan { tasks:number; coins:number; firstScans:number; rerates?:number; coalescedCheckpoints:number; to:number }
/**
 * One live poll's evaluation phase so far: tasks attempted, skipped (a run already exists), failed (sources
 * unavailable) and completed (cards written), outcome horizons evaluated in write transactions and whether outcomes are
 * still being caught up, and what the poll is doing now.
 */
export interface EvaluationProgress {
  to:number; tasks:number; attempted:number; skipped:number; failed:number; completed:number;
  outcomeLoads:number; outcomesPending:boolean; phase:'sources'|'write'|'outcomes'|'done'; sec:number;
}
interface Schedule { coin: Uint8Array; first_block: string; last_block: string | null; last_sec: string | null; price: number | null; last_trade: Date | null }
/** A coin a poll may plan: its newest event time, revision (as stored), progress base and retention revival. */
interface PlanInput { coin:Address; firstBlock:number; lastSec:number; revision:string; base:ActivityBase | null; revived:(watermark:number)=>number | undefined; inRange:boolean; activity?:CoinActivity }
/** Blocks commit in order (in live polls, first scans of new launches commit ahead of older backlog). Source reads are
 * bounded; rule/history writes remain serial to preserve prior-launch ordering. */
export class EngineWorker {
  private stopped=false;
  private clock:ClockCache=new Map();
  private evaluated=new Map<Address,Pick<Verdict, 'level' | 'playbooks'>>();
  private live:LiveActivity;
  private feedLeft=false;
  private cache:ReplayCache | undefined;
  private metrics=new ReplayMetrics();
  private completed=0;
  private cardFailures=0;
  /** Cards a re-rating left pending (staleRatings skips them until the coin's card changes). */
  private rerated=new Map<Address,string>();
  /** Coins the loop first-scanned, by block: one whose sources were unavailable waits FIRST_SCAN_RETRY_BLOCKS (and the failure backoff). */
  private firstTried=new Map<Address,number>();
  /** The loop's cards share one hourly volume-leaders read per block, as a poll's do (it ran once per card before). */
  private rerateMemo:SourceMemo={ranks:new Map()};
  /** Pending cards written before this time are re-rated once (options.rerateBefore, never before CLEAR_RULES_AT). */
  private get rulesAt() { return new Date(Math.max(Date.parse(CLEAR_RULES_AT),Date.parse(this.options.rerateBefore ?? CLEAR_RULES_AT))).toISOString(); }
  /** Cards of coins outside Pons written before this time are re-rated once (options.rerateOtherBefore; none without it). */
  private get otherRulesAt() { return this.options.rerateOtherBefore ?? NO_OTHER_RERATE; }
  /**
   * Return replay/work counters and card-failure totals without new I/O or authentication. Host
   * diagnostic read; counters describe this worker instance, not whole-system completeness.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  telemetry(){return {...this.metrics.snapshot(this.completed),cardFailures:this.cardFailures};}
  private outcomeDifferences=new OutcomeDifferences();
  private client:PonsProfileClient | undefined;
  private readBlock:BlockReader | undefined;
  /**
   * Count this instance's evaluated coin verdicts and playbook levels without new
   * I/O/authentication. Host diagnostic read; absent evaluations are not inferred to be clear.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  summary() {
    const verdicts={clear:0,pending:0,monitor:0,danger:0};
    const playbooks:Record<string,{info:number;monitor:number;danger:number}>={};
    for(const verdict of this.evaluated.values()) {
      verdicts[verdict.level]++;
      for(const match of verdict.playbooks) {
        const counts=playbooks[match.id] ??= {info:0,monitor:0,danger:0};
        if(match.level!=='clear')counts[match.level]++;
      }
    }
    return {coinsEvaluated:this.evaluated.size,verdicts,playbooks};
  }
  private wake: (() => void) | undefined;
  /**
   * Wire storage and optional acquisition callbacks, enforcing concurrency 1-32 and positive finite
   * poll interval. Engines operator construction only; invalid options throw and no work starts yet.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(readonly db: ChainDb, readonly options: WorkerOptions = {}) {
    this.client=options.client ? this.metrics.profile(options.client) : undefined;
    this.live=new LiveActivity(db);
    this.readBlock=options.readBlock ? this.metrics.headers(options.readBlock) : undefined;
    if (!Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4)<1 || (options.concurrency ?? 4)>32) throw new Error('Invalid engine concurrency');
    if (!Number.isFinite(options.pollMs ?? 2000) || (options.pollMs ?? 2000)<1) throw new Error('Invalid engine poll interval');
    if (options.rerateBefore!==undefined && !Number.isFinite(Date.parse(options.rerateBefore))) throw new Error('Invalid engine re-rate time');
    if (options.rerateOtherBefore!==undefined && !Number.isFinite(Date.parse(options.rerateOtherBefore))) throw new Error('Invalid engine re-rate time');
  }
  /**
   * Set stop state and wake polling sleeps. Host lifecycle only; in-flight source reads/current
   * transaction may finish and prior writes remain.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  stop() { this.stopped=true; this.wake?.(); this.rerateWake?.(); this.blueChipWake?.(); }
  private rerateWake?:()=>void;
  private blueChipWake?:()=>void;
  /**
   * Validate interval and replay retained activity with ordered rule/history writes, clearing replay
   * cache in finally. Engines operator only; invalid interval/source/provider/SQL failures reject.
   * Retrospective mode does not invoke live reference simulation.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async replay(from: number, to: number) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from<0 || to<from) throw new Error('Invalid replay interval');
    await refreshClock(this.db,this.clock);
    await this.refreshRegistryLabels();
    if(watcherRefreshEnabled()) {
    let after:import('./watcher/store.js').ReplayCursor|undefined;
    do {const batch=await replayFingerprints(this.db,from,to,{...this.options.fingerprints,after});after=batch.next??undefined;}while(after&&!this.stopped);
    const flowCoins=(await this.db.sql.query<{coin:Uint8Array}>('SELECT DISTINCT coin FROM swaps WHERE block BETWEEN $1 AND $2',[from,to])).rows;
    const fromTime=(await resolveClock(this.db,from,undefined,this.clock))?.ts;
    for(const row of flowCoins)if(await this.db.blockHash(BigInt(to)))await refreshCoinFlow(this.db,hex(row.coin),to,this.flowOptions,fromTime==null?undefined:seconds(fromTime)-1);
    }
    try{return await this.evaluateActivity(from,to,false);}finally{this.cache=undefined;}
  }
  private get flowOptions():FlowOptions {
    return {...this.options.flow,modelVersion:this.options.flow?.modelVersion??this.options.fingerprints?.model?.version};
  }
  private registryLabelRevision:string|null=null;
  private async refreshRegistryLabels() {
    const revision=(await this.db.sql.query<{revision:string}>(`SELECT md5(coalesce((SELECT string_agg(agent_id::text || ':' || wallet_block::text || ':' || encode(block_hash,'hex'),',' ORDER BY agent_id,wallet_block) FROM agent_registry),'') || ':' ||
      coalesce((SELECT string_agg(id,',' ORDER BY id) FROM wallet_labels WHERE source<>'erc8004'),'')) AS revision`)).rows[0].revision;
    if(revision===this.registryLabelRevision)return;
    await writeRegistryLabels(this.db);this.registryLabelRevision=revision;
  }
  private startup=true;
  private yielded=false;
  /** Coins whose head refresh already ran in the current startup sequence. */
  private startupDone=new Set<Address>();
  /** Outcomes that could not be decided yet, by coin and horizon, with the time they were last tried. */
  private outcomeSkips=new Map<string,number>();
  /**
   * Expire traces, refresh registry/clock state, reconcile cursor and process bounded scan/activity
   * work before advancing the engine cursor. Engines role only; missing head returns zero, orphaned
   * cursor/provider/source/SQL failures reject; incomplete inputs remain explicit failures/pending
   * results.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async poll() {
    await expireSimulationTraces(this.db);
    await expireV4ReferenceTraces(this.db);
    await this.refreshRegistryLabels();
    await refreshClock(this.db,this.clock);
    await this.reconcile();
    // One indexed max per table: a max over their UNION read every row of every table on each poll.
    const head=(await this.db.sql.query<{number:string | null}>(`SELECT greatest(
      (SELECT max(number) FROM engine_block_times), (SELECT max(first_block) FROM tokens), (SELECT max(block) FROM pons_events),
      (SELECT max(block) FROM pons_exemptions), (SELECT max(created_block) FROM pools)) AS number`)).rows[0];
    if (head.number==null) return 0;
    const to=Number(head.number);
    await refreshFingerprints(this.db,to,this.options.fingerprints);
    await refreshFlows(this.db,to,this.flowOptions);
    // Recover post-commit timing/job acknowledgements after process failure. Bound each poll.
    const unrecorded=(await this.db.sql.query<{data:CoinCard}>(`SELECT c.data FROM coin_card_latest c JOIN scan_timings t ON t.coin=c.coin
      WHERE c.as_of_block>=t.discovery_block AND (t.first_verdict_at IS NULL OR (t.critical_complete_at IS NULL AND c.data->'verdict'->>'level'<>'pending'
        AND jsonb_array_length(coalesce(c.data->'verdict'->'evaluatedPlaybooks','[]'::jsonb))=$1)) ORDER BY t.discovered_at LIMIT 256`,[Object.keys(rules).length])).rows;
    for(const row of unrecorded)await this.recordScan(row.data);
    const scans=await this.processScanJobs(to);
    const count=scans+await this.evaluateActivity(0,to,true,this.startup);
    // A startup poll that yielded to a new launch has not refreshed every coin yet; the next poll continues it.
    // Only a startup poll continues: a yielded ordinary poll must not restart the full refresh.
    this.startup=this.startup && this.yielded;
    if(!this.startup)this.startupDone.clear();
    await this.db.sql.query("INSERT INTO engine_cursors VALUES('engines',$1,$2) ON CONFLICT(stream) DO UPDATE SET block=excluded.block,hash=excluded.hash",[to,(await resolveClock(this.db,to,undefined,this.clock))?.hash ?? null]);
    return count;
  }
  /** On-demand jobs reuse source acquisition, pure rules and the existing receipt writer.
   * @remarks
   * Claim bounded engine jobs and acquire sources/probes, then verify lease/current block and
   * persist rule/history/receipt state before acknowledgement. Engines role only; missing evidence
   * leaves waiting/pending and processing errors record job failure. Job-store failure may reject
   * and no API writes chain truth.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async processScanJobs(block:number) {
    const jobs=new ScanJobs(this.db,()=> (this.options.now?.() ?? Date.now()/1000)*1000);
    let completed=0;
    for(let i=0;i<(this.options.concurrency ?? 4) && !this.stopped;i++) {
      const job=await jobs.claim('engine');if(!job)break;
      this.options.onScanQueueDelay?.(Math.max(0,jobs.now()-new Date(job.created_at).getTime()));
      try {
        const coin=scanTarget(job)!;
        const header=await resolveClock(this.db,block,this.readBlock,this.clock);
        if(!header)throw new Error('Missing scan block');
        // A quiet coin whose raw history retention dropped keeps its last card until it trades again: a rescan could
        // only re-check it with partial history.
        const prune=await historyPrune(this.db,coin);
        if(prune && !(await revivedBy(this.db,coin,prune,block)) && (await this.db.sql.query('SELECT 1 FROM coin_card_latest WHERE coin=$1',[binary(coin)])).rows.length) {
          await jobs.finish(job,'done','ready');completed++;continue;
        }
        await recordScanStart(this.db,coin,(this.options.now?.() ?? Date.now()/1000)*1000);
        await this.prepareReference(coin,block);
        const sources=await this.loadRatingSources(this.db,coin,block,this.client,this.clock);
        if(!sources){this.cardFailures++;await jobs.finish(job,'waiting','pending','indexed_launch_evidence_unavailable');continue;}
        const card=await this.writeTx(async tx=>{
          const owner=(await tx.sql.query<{lease_id:string}>('SELECT lease_id FROM scan_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
          if(owner?.lease_id!==job.lease_id)return;
          await lockEngineWrites(tx,[sources],true);
          const canonicalHash=await tx.blockHash(BigInt(block));
          if(header.hash && canonicalHash!=null && canonicalHash!==hex(header.hash))throw new Error('Indexed block changed during scan preparation');
          await updateOutcomes(tx,sources.asOfBlock,sources.asOfSec,this.clock,undefined,this.outcomeSkips,{loads:this.options.outcomeLoadsPerWrite ?? OUTCOME_LOADS_PER_WRITE,used:0});
          sources.history=await historyAt(tx,sources.deployer,coin,sources.asOfBlock);
          return this.persistRun(tx,sources);
        });
        if(card===DB_CONTENTION_SKIPPED)await jobs.finish(job,'waiting','pending','database_contention');
        else if(card){await this.recordScan(card);await jobs.finish(job,'done','ready');completed++;}
      } catch {await jobs.fail(job,'engine');}
    }
    return completed;
  }
  private async ratingWork(coin:Address,block:number):Promise<RpcWork> {
    const row=(await this.db.sql.query<{listed:boolean;first:boolean;price:number|null;peak:number|null;full_price:number|null;peak_recorded:boolean|null;fresh:boolean}>(`
      SELECT r.activity>to_timestamp($2::double precision-604800) AS listed,l.coin IS NULL AS first,
        p.price,p.peak,c.full_price,c.peak_recorded,p.block>coalesce(c.checked_block,l.as_of_block) AS fresh FROM tokens t LEFT JOIN read_coins r ON r.coin=t.address
        LEFT JOIN coin_card_latest l ON l.coin=t.address LEFT JOIN coin_rating_prices p ON p.coin=t.address AND p.block<=$3
        LEFT JOIN coin_rating_checks c ON c.coin=t.address WHERE t.address=$1`,
      [binary(coin),this.options.now?.() ?? Date.now()/1000,block])).rows[0];
    return row?.first && row.listed ? 'first_rating' : row && !row.first && row.fresh &&
      ratingPriceMove(row.price,row.full_price,row.peak,row.peak_recorded ?? false).force ? 'crash' : 'routine';
  }
  private async prepareReference(coin:Address,block:number) {
    if(!this.options.referenceSimulation)return;
    if(!this.options.paidWorkAllowed)return this.options.referenceSimulation(coin,block);
    const work=await this.ratingWork(coin,block);
    if(await this.options.paidWorkAllowed(work))return withRpcOrigin('engines.reference_simulation',()=>this.options.referenceSimulation!(coin,block),work);
  }
  private async loadRatingSources(...args: Parameters<typeof loadSources>): ReturnType<typeof loadSources> {
    if (!this.options.paidWorkAllowed) return loadSources(...args);
    const [,coin,block]=args,work=await this.ratingWork(coin,block);
    if (!(await this.options.paidWorkAllowed(work))) return null;
    return withRpcOrigin('engines.rating',()=>loadSources(...args),work);
  }
  private async recordScan(card:CoinCard) {
    const ms=await recordScanVerdict(this.db,card,(this.options.now?.() ?? Date.now()/1000)*1000);
    if(ms!==undefined)this.options.onScanComplete?.(ms);
  }
  private async evaluateActivity(from:number,to:number,live:boolean,startup=false) {
    // Live polls read only what changed since the previous poll (live-activity.ts) and plan exactly what the full
    // history plans; replay and ENGINE_LIVE_ACTIVITY=full read every coin's whole history.
    const incremental=live && this.options.liveActivity!=='full';
    const prunes=await historyPrunes(this.db);
    let inputs:PlanInput[],clock:BlockTime[];
    if(incremental) {
      const loaded=await this.live.refresh(to,this.options.now?.() ?? Date.now()/1000,prunes,{readBlock:this.readBlock,cache:this.clock,concurrency:this.options.concurrency ?? 4,stopped:()=>this.stopped});
      if(!loaded){this.yielded=false;return 0;}
      clock=loaded.clock;
      inputs=loaded.coins.map(coin=>({coin:coin.coin,firstBlock:coin.firstBlock,lastSec:coin.lastSec,revision:coin.revision,base:coin.base,revived:()=>coin.revived,inRange:true}));
      if(this.live.stats)this.options.onLiveActivity?.(this.live.stats);
    } else {
      if(live && !this.feedLeft){await leaveActivityFeed(this.db);this.feedLeft=true;}
      const coins=await coinActivity(this.db,to,this.readBlock,this.clock,this.options.concurrency ?? 4,()=>this.stopped,live);
      clock=(await this.db.sql.query<{number:string;ts:Date}>('SELECT number,ts FROM engine_block_times WHERE number<=$1 ORDER BY number',[to])).rows.map(row=>({number:Number(row.number),sec:seconds(row.ts)}));
      inputs=coins.map(coin=>({coin:coin.coin,firstBlock:coin.firstBlock,lastSec:coin.events.reduce((latest,event)=>Math.max(latest,event.sec),coin.createdSec),
        revision:digest({activity:coin.revision,rulesVersion:RULES_VERSION}),base:coin.base ?? null,
        revived:watermark=>coin.events.find(event=>event.block>watermark && (event.kind==='swap' || event.kind==='transfer' || !!prunes.get(coin.coin)?.preserved))?.block,
        inRange:coin.firstBlock>=from || coin.events.some(event=>event.block>=from && event.block<=to),activity:coin}));
    }
    // A token without a deployer (WETH, USDG and every other non-launchpad token) never gets a card (readSources). It
    // trades often, so the failure backoff below never held it: it stayed a first scan and went ahead of every real
    // launch on each poll. It is planned again once the indexer records a deployer.
    if(live && inputs.length) {
      const ready=new Set((await this.db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens WHERE address=ANY($1) AND deployer IS NOT NULL',
        [inputs.map(input=>binary(input.coin))])).rows.map(row=>hex(row.address)));
      const excluded=inputs.filter(input=>!ready.has(input.coin));
      if(excluded.length)await countEvaluations(this.db,[{path:'planner',outcome:'skipped_candidate',reason:'no_deployer',firstRating:true,count:excluded.length}]);
      inputs=inputs.filter(input=>ready.has(input.coin));
    }
    const observations:EvaluationCount[]=[];
    const observe=(outcome:string,reason:string,firstRating:boolean,count=1)=>observations.push({path:'poll',outcome,reason,firstRating,count});
    const index=blockIndex(clock);
    const now=this.options.now?.() ?? Date.now()/1000;
    const states=new Map((incremental ? await this.db.sql.query<{coin:Uint8Array;revision:string;through_block:string}>('SELECT * FROM engine_activity_state WHERE coin=ANY($1)',[inputs.map(input=>binary(input.coin))])
      : await this.db.sql.query<{coin:Uint8Array;revision:string;through_block:string}>('SELECT * FROM engine_activity_state')).rows.map(row=>[hex(row.coin),row]));
    // Live: a coin with no card yet shows "Scanning…". Its sources may be unavailable for a while (launch identity
    // not enriched yet, no block clock): a failed load is retried after a growing number of blocks, not on every
    // poll and every restart. At head, thousands of such retries starved the scans that could succeed.
    const scanned=!live ? undefined : new Set((incremental ? await this.db.sql.query<{coin:Uint8Array}>('SELECT coin FROM coin_card_latest WHERE coin=ANY($1)',[inputs.map(input=>binary(input.coin))])
      : await this.db.sql.query<{coin:Uint8Array}>('SELECT coin FROM coin_card_latest')).rows.map(row=>hex(row.coin)));
    const failures=!live ? undefined : new Map((await this.db.sql.query<{coin:Uint8Array;attempts:string;last_block:string}>('SELECT coin,attempts::text,last_block::text FROM engine_card_failures WHERE coin=ANY($1)',
      [inputs.filter(input=>!scanned!.has(input.coin)).map(input=>binary(input.coin))])).rows.map(row=>[hex(row.coin),{attempts:Number(row.attempts),block:Number(row.last_block)}]));
    const tasks:Checkpoint[]=[];
    const revised=new Set<Address>();
    const pending:PlanInput[]=[];
    const backlog=live ? this.options.liveBacklogSec : undefined,head=clock.at(-1);
    let coalesced=0;
    const since=new Map<Address,number>();
    const decisions:{input:PlanInput;refreshHead:boolean;changed:boolean;planFrom:number;revived?:number}[]=[];
    for (const input of inputs) {
      // Retention removed this coin's raw history up to its watermark (the removed rows also change its revision).
      // It is evaluated again only from its first swap or transfer after that, never at a checkpoint in the gap.
      const prune=prunes.get(input.coin);
      const revived=prune ? input.revived(prune.watermark) : undefined;
      if(prune && (revived===undefined || revived>to)){if(live)observe('skipped_candidate','history_pruned',!scanned!.has(input.coin));continue;}
      if (!input.inRange && !live) continue;
      if(live && now-input.lastSec>=7*86400){observe('skipped_candidate','idle_seven_days',!scanned!.has(input.coin));continue;}
      const state=states.get(input.coin);
      const refreshHead=startup && !this.startupDone.has(input.coin);
      if(live && !refreshHead && state?.revision===input.revision && Number(state.through_block)>=to){observe('skipped_candidate','through_head',!scanned!.has(input.coin));continue;}
      const failure=failures?.get(input.coin);
      if(failure && state?.revision===input.revision && to-failure.block<retryAfterBlocks(failure.attempts)){observe('skipped_candidate','failure_backoff',true);continue;}
      if(live && state?.revision!==input.revision)revised.add(input.coin);
      decisions.push({input,refreshHead,changed:state?.revision!==input.revision,planFrom:live && state ? Math.max(from,Number(state.through_block)+1) : from,revived});
    }
    // Incremental plans are read in one batch; they equal checkpoints() over the coin's whole history.
    const resumed=incremental ? await this.live.plans(decisions.map(decision=>({coin:decision.input.coin,from:decision.planFrom})),to) : undefined;
    for (const {input,refreshHead,changed,planFrom,revived} of decisions) {
      let plan=resumed ? resumed.get(input.coin)! : checkpoints(input.activity!,clock,planFrom,to,index);
      if(live && (refreshHead || changed) && clock.length && now-clock.at(-1)!.sec<7*86400) {
        const head=clock.at(-1)!;
        if(!plan.some(point=>point.block===head.number))plan.push({coin:input.coin,block:head.number,sec:head.sec});
      }
      if(revived!==undefined)plan=plan.filter(point=>point.block>=revived);
      if(backlog!==undefined && head) {
        // A lagging live engine replayed every historical checkpoint in block order. Each one reloads the coin's
        // whole history and rebuilds holders, so lag fed itself. TODO(spec): §6.5 triggers assume no lag; skip, then replay.
        const recent=plan.filter(point=>head.sec-point.sec<=backlog);
        if(recent.length<plan.length) {
          coalesced+=plan.length-recent.length;
          // The coin keeps the queue place of its oldest dropped checkpoint, or newer work would starve it.
          since.set(input.coin,plan[0].block);
          plan=recent.length ? recent : [{coin:input.coin,block:head.number,sec:head.sec}];
        }
      }
      tasks.push(...plan);pending.push(input);
    }
    // Live: a quiet coin is only re-evaluated when it trades, so pending cards written under rules that could not reach
    // Clear, or before the sell check that completes them, stayed pending (2026-10-11: 13,007 of 14,341 pending coins).
    // A bounded number per poll get a head checkpoint and run right after first scans, most recently active first.
    const rerateRank=new Map<Address,number>(),urgent=new Set<Address>();
    if(live && head && now-head.sec<7*86400) {
      const byCoin=new Map(inputs.map(input=>[input.coin,input]));
      const moved=(await priceMovedCoins(this.db,RERATE_PER_POLL)).filter(entry=>byCoin.has(entry.coin));
      for(const entry of moved)urgent.add(entry.coin);
      const routine=await staleRatings(this.db,[...byCoin.keys()],RERATE_PER_POLL-moved.length,this.rerated,this.rulesAt,this.otherRulesAt);
      for(const {coin,card} of [...moved,...routine.filter(entry=>!moved.some(m=>m.coin===entry.coin))]) {
        // A coin still pending after its re-rating is not selected again until its card changes.
        this.rerated.set(coin,card);rerateRank.set(coin,rerateRank.size);revised.add(coin);
        if(!tasks.some(task=>task.coin===coin && task.block===head.number))tasks.push({coin,block:head.number,sec:head.sec});
      }
    }
    // First scans use oldest launch first across all deployers. Checkpoints within each coin remain in block order.
    const launched=new Map(inputs.map(input=>[input.coin,input.firstBlock]));
    const first=(coin:Address)=>!!scanned && !scanned.has(coin);
    const firstOrder=(a:Checkpoint,b:Checkpoint)=>launched.get(a.coin)!-launched.get(b.coin)! || a.coin.localeCompare(b.coin) || a.block-b.block;
    const queued=(task:Checkpoint)=>since.get(task.coin) ?? task.block;
    // Tiers: urgent price moves, first scans, routine re-ratings, then the backlog. A coin's own checkpoints stay in block order.
    const tier=(coin:Address)=>urgent.has(coin) ? -1 : first(coin) ? 0 : rerateRank.has(coin) ? 1 : 2;
    tasks.sort((a,b)=>tier(a.coin)-tier(b.coin) || (tier(a.coin)===0 ? firstOrder(a,b) : tier(a.coin)<=1 ? rerateRank.get(a.coin)!-rerateRank.get(b.coin)! || a.block-b.block
      : queued(a)-queued(b) || a.coin.localeCompare(b.coin) || a.block-b.block));
    const backlogAt=tasks.findIndex(task=>tier(task.coin)===2),priority=backlogAt<0 ? tasks.length : backlogAt;
    if(live) {
      for(const task of tasks)observe('planned','checkpoint',first(task.coin));
      await recordFirstPlans(this.db,tasks.filter(t=>first(t.coin)).map(t=>t.coin),to,'poll');
      await countEvaluations(this.db,observations);
      this.options.onLiveTasks?.(tasks);
    }
    if(live)this.options.onLivePlanned?.({tasks:tasks.length,coins:new Set(tasks.map(t=>t.coin)).size,firstScans:new Set(tasks.filter(t=>first(t.coin)).map(t=>t.coin)).size,rerates:rerateRank.size,coalescedCheckpoints:coalesced,to});
    const remaining=new Map<Address,number>();for(const task of tasks)remaining.set(task.coin,(remaining.get(task.coin) ?? 0)+1);
    const memo:SourceMemo|undefined=live ? {ranks:new Map()} : undefined;
    const sliceStart=performance.now();let yielded=false;this.yielded=false;
    if(!live) {
      this.options.onPlanned?.({tasks:tasks.length,coins:new Set(tasks.map(t=>t.coin)).size,from,to});
      if(this.options.replayCache!==false){const start=performance.now();this.cache=new ReplayCache(this.db,to,this.clock,this.options.marketWindow);await this.cache.initialize();this.metrics.sourceMs+=performance.now()-start;}
    }
    const idleAt=new Map(inputs.map(input=>[input.coin,input.lastSec+7*86400]));
    const expiry=[...idleAt].sort((a,b)=>a[1]-b[1]);let expired=0;
    const expire=(sec:number)=>{while(expired<expiry.length && expiry[expired][1]<=sec){this.cache?.evict(expiry[expired][0]);expired++;}};
    const queuedAt=performance.now();
    const width=this.options.concurrency ?? 4;
    let completed=0;
    let outcomesBlock=-1;
    // Live writes catch up outcomes a bounded number of horizons at a time (updateOutcomes) until one call finishes.
    let outcomesDone=true;
    const progress:EvaluationProgress={to,tasks:tasks.length,attempted:0,skipped:0,failed:0,completed:0,outcomeLoads:0,outcomesPending:false,phase:'sources',sec:0};
    const report=()=>{progress.sec=Math.round((performance.now()-queuedAt)/1000);progress.outcomesPending=!outcomesDone;this.options.onEvaluation?.({...progress});};
    const reporter=live && this.options.onEvaluation ? setInterval(report,this.options.evaluationReportMs ?? 60_000) : undefined;
    const failedThisPoll=new Set<Address>(),contentionThisPoll=new Set<Address>();
    const queue:OutcomeQueue={};
    const outcomes=async (tx:ChainDb,block:number,sec:number,loads=this.options.outcomeLoadsPerWrite ?? OUTCOME_LOADS_PER_WRITE)=>{
      const budget:OutcomeBudget|undefined=live ? {loads,used:0} : undefined,phase=progress.phase;
      progress.phase='outcomes';
      try{outcomesDone=await updateOutcomes(tx,block,sec,this.clock,this.cache,this.outcomeSkips,budget,live ? queue : undefined);}
      finally{progress.phase=phase;progress.outcomeLoads+=budget?.used ?? 0;}
      outcomesBlock=Math.max(outcomesBlock,block);
    };
    try {
    for(let offset=0;offset<tasks.length && !this.stopped;) {
      if(live && offset>=priority && this.options.liveSliceMs!==undefined && performance.now()-sliceStart>=this.options.liveSliceMs
        && (await this.db.sql.query('SELECT 1 FROM tokens WHERE first_block>$1 LIMIT 1',[to])).rows.length) {yielded=true;break;}
      // First scans never share a batch with backlog, so a yield happens right after them.
      const batchStart=offset,batch=tasks.slice(offset,Math.min(offset+width,offset<priority ? priority : tasks.length));offset+=batch.length;
      const sourceStart=performance.now();progress.phase='sources';
      // Prepare the shared market lane in task order before asynchronous coin loads.
      if(this.cache)for(const point of batch)await this.cache.ranked(point.block,point.sec);
      const loaded=await Promise.all(batch.map(async point=>{
        if(live && failedThisPoll.has(point.coin)) {
          progress.skipped++;
          await countEvaluations(this.db,[{path:'poll',outcome:'skipped',reason:'same_cycle_failure',firstRating:first(point.coin),count:1}]);
          return null;
        }
        progress.attempted++;
        const existing=this.cache ? this.cache.runs.has(`${point.coin}:${point.block}`) : (await this.db.sql.query('SELECT 1 FROM engine_runs WHERE coin=$1 AND block=$2 AND rules_version=$3',[binary(point.coin),point.block,RULES_VERSION])).rows.length;
        if(existing && !(live && revised.has(point.coin) && point.block===to)){progress.skipped++;if(live)await countEvaluations(this.db,[{path:'poll',outcome:'skipped',reason:'existing_run',firstRating:first(point.coin),count:1}]);return null;}
        await resolveClock(this.db,point.block,this.readBlock,this.clock);
        if(live){await recordScanStart(this.db,point.coin,(this.options.now?.() ?? Date.now()/1000)*1000);await this.prepareReference(point.coin,point.block);}
        const sources=await this.loadRatingSources(this.db,point.coin,point.block,this.client,this.clock,this.cache,!live,memo).catch(error=>{
          if(!live || !isRpcUnavailable(error))throw error;
          return null; // loadSources durably records the failure; one coin must not cancel its neighbours.
        });
        if(!sources){this.cardFailures++;progress.failed++;if(live)failedThisPoll.add(point.coin);}
        return sources;
      }));
      this.metrics.sourceMs+=performance.now()-sourceStart;
      for(let i=0;i<batch.length;i++) {
        if(i>0 && this.stopped)break;
        remaining.set(batch[i].coin,remaining.get(batch[i].coin)!-1);
        const sources=loaded[i];if(!sources){this.cache?.writes.delete(batch[i].coin);expire(batch[i].sec);continue;}
        progress.phase='write';
        const writeStart=performance.now();const card=await this.writeTx(async tx=>{
          const before={outcomesDone,outcomesBlock,loads:progress.outcomeLoads,rows:structuredClone(queue.rows)};
          tx.afterRollback(()=>{outcomesDone=before.outcomesDone;outcomesBlock=before.outcomesBlock;progress.outcomeLoads=before.loads;queue.rows=before.rows;});
          await lockEngineWrites(tx,[sources],!(live && batchStart<priority));
          if(!this.cache && !(live && revised.has(sources.coin) && sources.asOfBlock===to) && (await tx.sql.query('SELECT 1 FROM engine_runs WHERE coin=$1 AND block=$2 AND rules_version=$3',[binary(sources.coin),sources.asOfBlock,RULES_VERSION])).rows.length)return;
          // Outcomes are keyed by horizon time, so a later block covers every earlier one. Replay runs in block
          // order (unchanged); live first scans run ahead of older backlog, which must not re-run this per write.
          // A live call stops after a few horizons, so the next write continues it instead of the card waiting for all.
          // First scans and re-ratings skip the per-write outcome load (about half of a write); the end of the poll
          // catches up OUTCOME_LOADS_PER_POLL horizons instead.
          if(!(live && batchStart<priority) && (sources.asOfBlock>outcomesBlock || !outcomesDone))await outcomes(tx,sources.asOfBlock,sources.asOfSec);
          const {historyAt}=await import('./sources.js');sources.history=await historyAt(tx,sources.deployer,sources.coin,sources.asOfBlock,this.cache);
          return this.persistRun(tx,sources,!live);
        });
        this.metrics.writeMs+=performance.now()-writeStart;
        expire(sources.asOfSec);
        if(card===DB_CONTENTION_SKIPPED){progress.skipped++;if(live){failedThisPoll.add(sources.coin);contentionThisPoll.add(sources.coin);}continue;}
        if(!card){progress.skipped++;continue;}
        progress.completed++;
        this.evaluated.set(sources.coin,{level:card.verdict.level,playbooks:card.playbooks});
        if(live){await this.recordScan(card);this.options.onQueueCompletion?.(performance.now()-queuedAt);}
        completed++;this.completed++;this.options.onProgress?.(completed,sources.asOfBlock);
        // PGlite can resolve a long SQL chain entirely through microtasks. Yield
        // between coins so signal handlers and progress output run promptly.
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
    }
    // Outcome horizons still mature after a coin stops receiving card evaluations.
    const end=clock.at(-1);
    if(!this.stopped && end && (outcomesBlock<end.number || !outcomesDone)){const start=performance.now();await this.writeTx(async tx=>{
      const before={outcomesDone,outcomesBlock,loads:progress.outcomeLoads,rows:structuredClone(queue.rows)};
      tx.afterRollback(()=>{outcomesDone=before.outcomesDone;outcomesBlock=before.outcomesBlock;progress.outcomeLoads=before.loads;queue.rows=before.rows;});
      await lockEngineWrites(tx,[],true);
      await outcomes(tx,end.number,end.sec,Math.max(this.options.outcomeLoadsPerWrite ?? OUTCOME_LOADS_PER_WRITE,OUTCOME_LOADS_PER_POLL));
    });this.metrics.writeMs+=performance.now()-start;}
    } finally {clearInterval(reporter);progress.phase='done';if(live)report();}
    // A yielded poll records only coins whose checkpoints all ran; the rest are planned again next poll.
    this.yielded=yielded;
    if(!this.stopped && live)for(const coin of pending)if(!contentionThisPoll.has(coin.coin) && (!yielded || !remaining.get(coin.coin))) {
      if(startup)this.startupDone.add(coin.coin);
      // The progress base lets the next poll (or the next process) read only this coin's rows above it.
      await this.db.sql.query(`INSERT INTO engine_activity_state(coin,revision,through_block,base_block,base_sum,base_sec,last_sec) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,through_block=excluded.through_block,base_block=excluded.base_block,base_sum=excluded.base_sum,
        base_sec=excluded.base_sec,last_sec=excluded.last_sec`,[binary(coin.coin),coin.revision,to,...baseColumns(coin.base),coin.lastSec]);
      if(incremental)this.live.written(coin.coin,coin.revision,to);
    } else await this.db.sql.query('UPDATE engine_activity_state SET last_sec=$2 WHERE coin=$1',[binary(coin.coin),coin.lastSec]);
    if(live && rerateRank.size) {
      for(const row of (await this.db.sql.query<{coin:Uint8Array;card_id:string}>('SELECT coin,card_id FROM coin_card_latest WHERE coin=ANY($1)',[[...rerateRank.keys()].map(binary)])).rows)
        this.rerated.set(hex(row.coin) as Address,row.card_id);
      if(this.rerated.size>50_000)for(const coin of [...this.rerated.keys()].slice(0,25_000))this.rerated.delete(coin);
    }
    return completed;
  }
  /**
   * Subscribe for wakeups with durable polling fallback, process ordered work until stop and
   * unsubscribe in finally. Engines operator only; bus subscription failure preserves polling while
   * poll/SQL/source errors reject. No trading or wallet signing is enabled.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async run() {
    let unsubscribe: (()=>Promise<void>) | undefined;
    try { unsubscribe=await (this.options.bus ?? this.db.bus).subscribe(message => { if (!['card_updated','verdict_created'].includes(message.topic)) this.wake?.(); }); }
    catch { /* A disconnected bus does not disable the durable cursor poll. */ }
    const throughput=setInterval(()=>{void logThroughput(this.db,this.options.sellCheckBudget).catch(error=>this.options.onRerateError?.(error));},60_000);
    throughput.unref();
    const differences=setInterval(()=>this.outcomeDifferences.flush(),60_000);
    differences.unref();
    const rerating=this.options.rerate ? this.rerateLoop() : undefined;
    const blueChipBackfill=this.blueChipBackfillLoop();
    try {
      while (!this.stopped) {
        let completed:number;
        try { completed=await this.poll(); }
        catch(error) {
          // A spent daily paid budget is not a fault: a restart meets the same budget, and each one costs a cold refresh
          // (2026-10-10: 24 restarts in seven minutes on the new host). Wait and poll again; public lanes and the next
          // UTC day let it through. The wait counts as progress for the stall watchdog. Other errors still stop.
          if(retryableTransaction(error)){this.db.recordTransactionSkip(error);}
          else if(rpcStopReason(error)!=='rpc_budget_exhausted' && !isRpcPaidDeferred(error))throw error;
          if(!retryableTransaction(error))this.options.onBudgetWait?.();this.options.onHeartbeat?.();
          await new Promise<void>(resolve=>{const timer=setTimeout(resolve,this.options.budgetWaitMs ?? 60_000);this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};if(this.stopped)this.wake();});
          continue;
        }
        this.options.onHeartbeat?.();
        if (completed) continue;
        await new Promise<void>(resolve => {
          const timer=setTimeout(() => { this.wake=undefined; resolve(); },this.options.pollMs ?? 2000);
          this.wake=()=>{ clearTimeout(timer);this.wake=undefined;resolve(); };
          if (this.stopped) this.wake();
        });
      }
    } finally { clearInterval(throughput);clearInterval(differences); this.stop(); await rerating; await blueChipBackfill; await unsubscribe?.(); }
  }
  /**
   * Live: reserve first-scan slots beside routine re-check slots, with urgent price moves ahead of both, at the
   * newest block, RERATE_WIDTH source loads at a time, beside the polls. Polls spend minutes refreshing activity and planning before they write anything (about nine of every
   * forty-five on 2026-10-11, and about fifty after a restart); this loop writes during that time too. Each group's
   * cards are written in one transaction locked like a poll's, rewritten like a poll's re-rating even at a block that
   * already has a run, and without outcome loads (polls catch those up). Every card write waits for the API's
   * read-model refresh batch holding read_feed (up to 2.4 s each on 2026-10-11, about 35 cards a minute one per
   * transaction), so a group waits once. A spent paid budget waits like the polls; other errors are reported and the
   * group's coins retried.
   */
  private async rerateLoop() {
    while (!this.stopped) {
      let cards=0,firstScans=0,contentionSkipped=false;
      try {
        // The indexer's newest block; resolveClock stores its time when polls have not yet.
        const head=(await this.db.sql.query<{number:string|null}>('SELECT max(number)::text AS number FROM chain_blocks')).rows[0]?.number;
        const block=head==null ? NaN : Number(head),since=(this.options.now?.() ?? Date.now()/1000)-7*86400;
        // Radar coins without a card first: a poll first-scans new launches only when it plans again, about every
        // fifty minutes on 2026-10-11 (426 coins launched over four hours had none).
        const tried=[...this.firstTried].filter(([,at])=>block-at<FIRST_SCAN_RETRY_BLOCKS).map(([coin])=>coin);
        const first=head==null ? [] : await unscannedCoins(this.db,since,block,FIRST_SCAN_SLOTS,tried);
        // Then coins that traded after their card was written: polls reach a trade only after refreshing activity and
        // planning, and yield to every new launch (on 2026-10-12 the median coin traded in the last hour was rated as of
        // nine hours before). Beside them, pending cards that would rate differently now.
        const moved=head==null ? [] : await priceMovedCoins(this.db,RERATE_WIDTH*2);
        const traded=head==null ? [] : await tradedSinceCard(this.db,since,(this.options.now?.() ?? Date.now()/1000)-TRADED_RERATE_SEC,RERATE_WIDTH*2);
        // Coins the radar lists (active in the last seven days), by this worker's clock.
        const stale=head==null ? [] : (await staleRatings(this.db,(await this.db.sql.query<{coin:Uint8Array}>('SELECT coin FROM read_coins WHERE activity>to_timestamp($1)',[since])).rows.map(row=>hex(row.coin) as Address),RERATE_WIDTH*2,this.rerated,this.rulesAt,this.otherRulesAt))
          .filter(entry=>!traded.some(t=>t.coin===entry.coin));
        const routine=reserveFirstScans(first,[...traded,...stale],moved);
        const work:{coin:Address;card?:string}[]=[...moved,...routine.filter(entry=>!moved.some(m=>m.coin===entry.coin))];
        await recordFirstPlans(this.db,first,block,'loop');
        const tradedCoins=new Set(traded.map(t=>t.coin));let tradedCards=0;
        for(let offset=0;offset<work.length && !this.stopped;offset+=RERATE_WIDTH) {
          const batch=work.slice(offset,offset+RERATE_WIDTH);
          await countEvaluations(this.db,batch.map(({card})=>({path:'loop',outcome:'planned',reason:'head',firstRating:!card,count:1})));
          for(const {coin,card} of batch)if(card)this.rerated.set(coin,card);else this.firstTried.set(coin,block);
          try {
            if(!(await resolveClock(this.db,block,this.options.rpcPaused?.() ? undefined : this.readBlock,this.clock)))break;
            const loaded=(await Promise.all(batch.map(async ({coin,card})=>{
              const prune=await historyPrune(this.db,coin);
              if(prune && !(await revivedBy(this.db,coin,prune,block))){await countEvaluations(this.db,[{path:'loop',outcome:'skipped_candidate',reason:'history_pruned',firstRating:!card,count:1}]);return null;}
              if(!card){await recordScanStart(this.db,coin,(this.options.now?.() ?? Date.now()/1000)*1000);if(!this.options.rpcPaused?.())await this.prepareReference(coin,block);}
              const sources=await this.loadRatingSources(this.db,coin,block,this.options.rpcPaused?.() ? undefined : this.options.rerateClient ?? this.client,this.clock,undefined,false,this.rerateMemo).catch(error=>{
                if(!isRpcUnavailable(error))throw error;
                return null; // Failure/backoff was recorded by loadSources; continue the reserved lane.
              });
              if(!sources)this.cardFailures++;
              return sources;
            }))).filter((sources):sources is LoadedSources=>!!sources);
            if(!loaded.length || this.stopped)continue;
            // One transaction per group: every card write waits for the API's read-model refresh batch holding read_feed.
            // read_feed is taken before any card is written. The refresher locks read_feed, then read_coins; a card whose
            // verdict is unchanged writes only read_coins (its card trigger), so a later card's verdict trigger would
            // otherwise reach read_feed second and could deadlock with it.
            const written=await this.writeTx(async tx=>{
              await lockEngineWrites(tx,loaded);
              await tx.sql.query('LOCK TABLE read_feed IN ROW EXCLUSIVE MODE');
              const out:CoinCard[]=[];
              for(const sources of loaded) {
                // Like a poll's re-rating, a stale card is rewritten even at a block that already has a run.
                sources.history=await historyAt(tx,sources.deployer,sources.coin,sources.asOfBlock);
                const card=await this.persistRun(tx,sources);if(card)out.push(card);
              }
              return out;
            });
            if(written===DB_CONTENTION_SKIPPED) {
              contentionSkipped=true;
              for(const {coin,card} of batch){if(card)this.rerated.delete(coin);else this.firstTried.delete(coin);}
              continue;
            }
            for(const card of written){await this.recordScan(card);cards++;this.completed++;if(tradedCoins.has(card.identity.address.toLowerCase() as Address) || tradedCoins.has(card.identity.address as Address))tradedCards++;}
            firstScans+=written.filter(card=>first.includes(card.identity.address.toLowerCase() as Address)).length;
            if(written.length)this.options.onHeartbeat?.();
            for(const row of (await this.db.sql.query<{coin:Uint8Array;card_id:string}>('SELECT coin,card_id FROM coin_card_latest WHERE coin=ANY($1::bytea[])',[loaded.map(s=>binary(s.coin))])).rows)
              this.rerated.set(hex(row.coin) as Address,row.card_id);
          } catch(error) {
            // Not written: the group's coins are selected again.
            for(const {coin,card} of batch) {
              if(card && this.rerated.get(coin)===card)this.rerated.delete(coin);
              if(!card && this.firstTried.get(coin)===block)this.firstTried.delete(coin);
            }
            throw error;
          }
        }
        if(work.length)this.options.onRerate?.(cards,firstScans,tradedCards);
        if(work.length && !contentionSkipped && !this.options.rpcPaused?.() && (!this.options.paidWorkAllowed || cards>0))continue;
      } catch(error) {
        this.db.recordTransactionSkip(error);
        if(rpcStopReason(error)!=='rpc_budget_exhausted' && !isRpcPaidDeferred(error))this.options.onRerateError?.(error);
      }
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,this.options.rerateIdleMs ?? 30_000);this.rerateWake=()=>{clearTimeout(timer);resolve();};if(this.stopped)resolve();});
    }
  }
  /**
   * Schedule a block's eligible coins, acquire sources outside the transaction and serialize
   * current-block/history/receipt writes with canonical hash/cursor checks. Engines role only;
   * missing block, source/provider/SQL or canonical mismatch rejects. Replay uses historical
   * schedule state; absent sources increment failure counts.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async processBlock(block: number, replay=false) {
    const b=await resolveClock(this.db,block,this.options.readBlock,this.clock);
    if (!b) throw new Error('Missing engine block');
    const now=seconds(b.ts);
    const candidates=(await this.db.sql.query<Schedule>(`SELECT t.address AS coin,t.first_block,e.last_block,e.last_sec,e.price,
      (SELECT max(ts) FROM swaps s WHERE s.coin=t.address AND s.block<=$1) AS last_trade
      FROM tokens t LEFT JOIN engine_schedule e ON e.coin=t.address WHERE t.first_block<=$1 ORDER BY t.first_block,t.address`, [block])).rows;
    const moved=new Set((await priceMovedCoins(this.db,candidates.length)).map(r=>r.coin));
    const selected: Address[]=[];
    for (const row of candidates) {
      const coin=hex(row.coin);
      // Historical replays derive the last schedule from blocks already processed, not the live schedule.
      let lastBlock=Number(row.last_block ?? -1),lastSec=Number(row.last_sec ?? 0),lastPrice=row.price;
      if (replay) {
        const prior=(await this.db.sql.query<{ block:string;sec:string;price:number | null }>('SELECT block,sec,price FROM engine_runs WHERE coin=$1 AND block<$2 AND rules_version=$3 ORDER BY block DESC LIMIT 1',[row.coin,block,RULES_VERSION])).rows[0];
        lastBlock=Number(prior?.block ?? -1);lastSec=Number(prior?.sec ?? 0);lastPrice=prior?.price ?? null;
      }
      const latestTrade=row.last_trade ? seconds(row.last_trade) : seconds((await this.db.sql.query<{ ts:Date }>('SELECT ts FROM engine_block_times WHERE number=$1',[row.first_block])).rows[0].ts);
      if (now-latestTrade>=7*86400) continue;
      const current=(await this.db.sql.query<{ low:number | null;high:number | null }>('SELECT min(price_quote) AS low,max(price_quote) AS high FROM swaps WHERE coin=$1 AND block=$2',[row.coin,block])).rows[0];
      const change=current.low!=null && current.high!=null && (lastPrice!=null && lastPrice>0 ?
        current.high>lastPrice*1.05 || current.low<lastPrice*0.95 : lastPrice==null);
      const event=(await this.db.sql.query(`SELECT 1 FROM token_transfers WHERE token=$1 AND block=$2
        UNION ALL SELECT 1 FROM pons_exemptions WHERE token=$1 AND block=$2
        UNION ALL SELECT 1 FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block=$2
        UNION ALL SELECT 1 FROM pools WHERE (currency0=$1 OR currency1=$1) AND created_block=$2 LIMIT 1`,[row.coin,block])).rows.length>0;
      const interval=now-latestTrade<3600 ? 600 : 3600;
      if (lastBlock<0 || Number(row.first_block)===block || change || event || moved.has(coin) || now-lastSec>=interval) selected.push(coin);
    }
    // PGlite transactions are serialized. Preparation only performs archive RPC reads outside the write transaction.
    const prepared=new Map<Address,LoadedSources | null>();
    const width=this.options.concurrency ?? 4;
    for (let offset=0;offset<selected.length;offset+=width) {
      const batch=selected.slice(offset,offset+width);
      const sources=await Promise.all(batch.map(async coin=>{
        if(!replay){await recordScanStart(this.db,coin,(this.options.now?.() ?? Date.now()/1000)*1000);await this.prepareReference(coin,block);}
        return this.loadRatingSources(this.db,coin,block,this.options.client,this.clock,undefined,replay);
      }));
      batch.forEach((coin,i)=>prepared.set(coin,sources[i]));
    }
    const cards:CoinCard[]=[];
    await this.writeTx(async tx => {
      cards.length=0;tx.afterRollback(()=>{cards.length=0;});
      await lockEngineWrites(tx,[...prepared.values()].filter((s):s is LoadedSources=>s!=null),true,true);
      if (!replay) {
        const cursor=(await tx.sql.query<{ block:string }>("SELECT block FROM engine_cursors WHERE stream='engines'")).rows[0];
        if (cursor && Number(cursor.block)>=block) return;
      }
      const canonicalHash=await tx.blockHash(BigInt(block));
      if (b.hash && canonicalHash!=null && canonicalHash!==hex(b.hash)) throw new Error('Indexed block changed during engine preparation');
      await updateOutcomes(tx,block,now,this.clock,undefined,this.outcomeSkips);
      for (const coin of selected) {
        const s=prepared.get(coin); if (!s){this.cardFailures++;continue;}
        // Refresh after outcomes/earlier launches in this block have materialized.
        const { historyAt }=await import('./sources.js');
        s.history=await historyAt(tx,s.deployer,coin,block);
        const card=await this.persistRun(tx,s,replay);if(card)cards.push(card);
      }
      if (!replay) await tx.sql.query("INSERT INTO engine_cursors VALUES('engines',$1,$2) ON CONFLICT(stream) DO UPDATE SET block=excluded.block,hash=excluded.hash",[block,b.hash]);
    });
    if(!replay)for(const card of cards)await this.recordScan(card);
  }
  private async writeTx<T>(work:(tx:ChainDb)=>Promise<T>):Promise<T|typeof DB_CONTENTION_SKIPPED> {
    try {
      return await this.db.tx(async tx=>{
        const restoreCache=this.cache?.checkpoint(),skips=new Map(this.outcomeSkips);
        tx.afterRollback(()=>{restoreCache?.();this.outcomeSkips=skips;});
        return work(tx);
      },{retry:true});
    } catch(error) {
      if(!(error instanceof TransactionRetryExhaustedError))throw error;
      return DB_CONTENTION_SKIPPED;
    }
  }
  private async persistRun(tx:ChainDb,s:LoadedSources,replay=false) {
    if(this.cache){const claim=await tx.sql.query('INSERT INTO engine_runs VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT DO NOTHING RETURNING coin',[binary(s.coin),s.asOfBlock,s.asOfSec,s.trade.last?.price_quote ?? null,RULES_VERSION]);if(!claim.rows.length)return;}
    const firstRating=!replay && !(await tx.sql.query('SELECT 1 FROM coin_card_latest WHERE coin=$1',[binary(s.coin)])).rows.length;
    const card=await this.writeCoin(tx,s);
    if(!replay)await countEvaluations(tx,[{path:'write',outcome:'completed',reason:'card',firstRating,count:1,coin:s.coin}]);
    await persistShadowGuardV2(tx,{coin:s.coin,block:s.asOfBlock,sec:s.asOfSec,legacyVerdictId:card.verdict.receipt.id,legacySignal:card.signal,replayMode:replay ? 'retrospective' : 'production'});
    if(this.cache){await tx.sql.query('UPDATE engine_runs SET signal=$3 WHERE coin=$1 AND block=$2 AND rules_version=$4',[binary(s.coin),s.asOfBlock,JSON.stringify(card.signal),RULES_VERSION]);this.cache.runs.add(`${s.coin}:${s.asOfBlock}`);}
    else await tx.sql.query('INSERT INTO engine_runs VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(coin,block,rules_version) DO UPDATE SET price=excluded.price,signal=excluded.signal',[binary(s.coin),s.asOfBlock,s.asOfSec,s.trade.last?.price_quote ?? null,JSON.stringify(card.signal),RULES_VERSION]);
    await materializeHistory(tx,s.coin,s.asOfBlock,this.cache);
    await tx.sql.query(`INSERT INTO engine_schedule VALUES($1,$2,$3,$4) ON CONFLICT(coin) DO UPDATE SET last_block=excluded.last_block,last_sec=excluded.last_sec,price=excluded.price
      WHERE engine_schedule.last_block<=excluded.last_block`,[binary(s.coin),s.asOfBlock,s.asOfSec,s.trade.last?.price_quote ?? null]);
    return card;
  }
  private async writeState(tx:ChainDb,s:LoadedSources):Promise<WriteState | undefined> {
    if(!this.cache)return;
    const found=this.cache.writes.get(s.coin);if(found)return found;
    const [prior,previous,run]=await Promise.all([
      tx.sql.query<{id:string;signature:string;data:Verdict}>('SELECT v.id,v.signature,v.data FROM verdicts v LEFT JOIN receipt_publications p ON p.id=v.id WHERE v.coin=$1 AND valid_from_block<=$2 ORDER BY valid_from_block DESC,p.publication_sequence DESC NULLS LAST,(v.rules_version=$3) DESC,v.rules_version DESC,v.id DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION]),
      tx.sql.query<{id:string;hash:string}>('SELECT id,hash FROM coin_cards WHERE coin=$1 AND valid_from_block<$2 AND rules_version=$3 ORDER BY valid_from_block DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION]),
      tx.sql.query<{signal:CoinCard['signal']}>('SELECT signal FROM engine_runs WHERE coin=$1 AND block<$2 AND rules_version=$3 ORDER BY block DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION]),
    ]);
    const state={prior:prior.rows[0],previous:previous.rows[0],signal:run.rows[0]?.signal};this.cache.writes.set(s.coin,state);return state;
  }
  private async writeCoin(tx: ChainDb,s: LoadedSources) {
    await tx.sql.query('SELECT read_lock_coins($1::bytea[])',[[binary(s.coin)]]);
    const state=await this.writeState(tx,s);
    const matches=evaluatePlaybooks({ ...s,history:s.history });
    const evaluated=evaluatedPlaybooks(s);
    const assembled=assembleVerdict(matches,{ coin:s.coin,asOfBlock:s.asOfBlock,receipt:{ id:'pending',hash:'',status:'pending' } });
    const incomplete=Object.entries(s.attributionCoverage ?? {}).filter(([,gap])=>gap.status==='incomplete');
    if(incomplete.length)assembled.reasons.push(`Not fully checked: ${incomplete.map(([key,gap])=>`${key.replaceAll('_',' ')} (${gap.reason.replaceAll('_',' ')})`).join(', ')}`);
    // CA-34: Clear needs every check that has an input source (UNSOURCED_PLAYBOOKS has none yet and is named instead).
    const notRun=(Object.keys(rules) as PlaybookId[]).filter(id=>!evaluated.includes(id)),blocking=notRun.filter(id=>!UNSOURCED_PLAYBOOKS.includes(id));
    if (assembled.level==='clear' && (blocking.length>0 || incomplete.length>0)) assembled.level='pending';
    if (assembled.level==='pending' && blocking.includes('honeypot')) assembled.reasons.unshift('Waiting on a sell check: the buy-then-sell simulation has not completed.');
    if (assembled.level==='clear' && notRun.length)assembled.reasons.push(`Not checked yet: ${notRun.map(id=>id.replaceAll('_',' ')).join(', ')} (no data source yet)`);
    // Rated Danger when retention pruned its history: the checks behind that rating cannot be re-run on what is left,
    // so a revived coin is never published as less severe than Danger.
    if(s.dangerBeforePrune) {
      const playbooks=s.dangerBeforePrune.playbooks.map(id=>id.replaceAll('_',' '));
      assembled.reasons.unshift(`Rated Danger before its history was pruned${playbooks.length ? ` (${playbooks.join(', ')})` : ''}`);
      assembled.level='danger';
    }
    assembled.evaluatedPlaybooks=evaluated;
    const signature=digest({ level:assembled.level,playbooks:matches,reasons:assembled.reasons,rulesVersion:RULES_VERSION,evaluated,attributionCoverage:s.attributionCoverage });
    const prior=state ? state.prior : (await tx.sql.query<{ id:string; signature:string; data:Verdict }>('SELECT v.id,v.signature,v.data FROM verdicts v LEFT JOIN receipt_publications p ON p.id=v.id WHERE v.coin=$1 AND valid_from_block<=$2 ORDER BY valid_from_block DESC,p.publication_sequence DESC NULLS LAST,(v.rules_version=$3) DESC,v.rules_version DESC,v.id DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION])).rows[0];
    const latest=(await tx.sql.query<{card_id:string;as_of_block:string;data:CoinCard;rules_version:string}>(`SELECT l.*,c.rules_version FROM coin_card_latest l JOIN coin_cards c ON c.id=l.card_id WHERE l.coin=$1`,[binary(s.coin)])).rows[0];
    const check=(await tx.sql.query<{full_block:string;full_price:number|null;peak_recorded:boolean;outcome_signature:string|null;checked_block:string}>(
      'SELECT * FROM coin_rating_checks WHERE coin=$1 FOR UPDATE',[binary(s.coin)])).rows[0];
    // Replay never borrows a future price. The retained peak is used only at/after its latest indexed trade.
    const price=(await tx.sql.query<{price:number|null;peak:number|null}>(`SELECT
      CASE WHEN p.block<=$2 THEN p.price ELSE (SELECT usd/amount_coin::double precision FROM swaps WHERE coin=$1 AND block<=$2 AND usd>0 AND amount_coin>0 ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC LIMIT 1) END AS price,
      CASE WHEN p.block<=$2 THEN p.peak ELSE (SELECT max(usd/amount_coin::double precision) FROM swaps WHERE coin=$1 AND block<=$2 AND usd>0 AND amount_coin>0) END AS peak
      FROM (SELECT 1) seed LEFT JOIN coin_rating_prices p ON p.coin=$1`,[binary(s.coin),s.asOfBlock])).rows[0];
    const baseline=check?.full_price ?? (prior ? (await tx.sql.query<{price:number|null}>(`SELECT usd/amount_coin::double precision AS price FROM retention_read_swaps WHERE coin=$1 AND block<=$2 AND usd>0 AND amount_coin>0 ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC LIMIT 1`,[binary(s.coin),prior.data.asOfBlock])).rows[0]?.price ?? null : null);
    const move=ratingPriceMove(price.price,baseline,price.peak,check?.peak_recorded ?? false);
    if(Object.keys(move.fact).length)assembled.priceMove=move.fact;
    const card=assembleCard(s,assembled);
    const previous=state ? state.previous : (await tx.sql.query<{ id:string; hash:string; data:CoinCard; ts:Date }>('SELECT c.*,b.ts FROM coin_cards c JOIN engine_block_times b ON b.number=c.valid_from_block WHERE c.coin=$1 AND c.valid_from_block<$2 AND c.rules_version=$3 ORDER BY c.valid_from_block DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION])).rows[0];
    const priorRun=state ? {signal:state.signal} : (await tx.sql.query<{ signal:CoinCard['signal'] }>('SELECT signal FROM engine_runs WHERE coin=$1 AND block<$2 AND rules_version=$3 ORDER BY block DESC LIMIT 1',[binary(s.coin),s.asOfBlock,RULES_VERSION])).rows[0];
    if (priorRun?.signal) {
      const signalTime=this.clock.get(priorRun.signal.asOfBlock) ?? (await tx.sql.query<{ ts:Date }>('SELECT ts FROM engine_block_times WHERE number=$1',[priorRun.signal.asOfBlock])).rows[0];
      if (signalTime && !shouldRecomputeSignal(seconds(signalTime.ts)*1000,s.asOfSec*1000)) card.signal=priorRun.signal;
    }
    if(latest && Number(latest.as_of_block)<=s.asOfBlock)tx.afterCommit(()=>this.outcomeDifferences.record(latest.data,latest.rules_version,card,RULES_VERSION));
    const outcome=ratingOutcome(card,RULES_VERSION);
    const checkedAt=new Date((this.options.now?.() ?? Date.now()/1000)*1000).toISOString();
    const saveCheck=async(full:boolean)=>{
      await tx.sql.query(`INSERT INTO coin_rating_checks(coin,checked_block,checked_at,full_block,full_price,peak_recorded,outcome_signature)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(coin) DO UPDATE SET checked_block=excluded.checked_block,checked_at=excluded.checked_at,
        full_block=excluded.full_block,full_price=excluded.full_price,peak_recorded=excluded.peak_recorded,outcome_signature=excluded.outcome_signature
        WHERE coin_rating_checks.checked_block<=excluded.checked_block`,[binary(s.coin),s.asOfBlock,checkedAt,full ? s.asOfBlock : Number(check?.full_block ?? prior!.data.asOfBlock),
          full ? price.price : baseline,(check?.peak_recorded ?? false) || (full && move.belowPeak),outcome]);
    };
    const sameOutcome=latest && Number(latest.as_of_block)<=s.asOfBlock && latest.rules_version===RULES_VERSION
      && ratingOutcome(latest.data,latest.rules_version)===outcome;
    // Unchanged checks, including same-block enrichment, refresh only mutable measurements.
    if(prior && latest && prior.id===latest.data.verdict.receipt.id && sameOutcome && !move.force) {
      card.verdict={...assembled,asOfBlock:prior.data.asOfBlock,receipt:prior.data.receipt,
        priceMove:{...(latest.data.verdict.priceMove?.downSinceRatedPct==null ? {} : {downSinceRatedPct:latest.data.verdict.priceMove.downSinceRatedPct}),...move.fact}};
      await saveCheck(false);
      card.verdict.lastChecked={block:s.asOfBlock,at:checkedAt};
      await tx.sql.query(`UPDATE coin_card_latest SET as_of_block=$2,data=$3 WHERE coin=$1 AND as_of_block<=$2`,[binary(s.coin),s.asOfBlock,JSON.stringify(card)]);
      await publishBlueChipMeasurements(tx,s);
      await tx.notify('card_updated',{id:latest.card_id,coin:s.coin});
      if(state)state.signal=card.signal;
      return card;
    }
    let verdict=assembled;
    {
      const blockHash=await tx.blockHash(BigInt(s.asOfBlock));
      const payload=verdictReceipt(s,assembled,blockHash,prior?.id ?? null,checkedAt,move.force ? {price:price.price,peak:price.peak,previousFullPrice:baseline} : undefined);
      const id=payload.receiptId;
      verdict.receipt={id,hash:digest(payload),status:'pending'};
      const inserted=(await tx.sql.query('INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[id,binary(s.coin),s.asOfBlock,RULES_VERSION,signature,JSON.stringify(verdict)])).rows.length;
      if (inserted) {
        await publishReceipt(tx,'engines',payload);
        await tx.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[`${id}:created`,id,'created',s.asOfBlock,'{}']);
        if (prior) await tx.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[`${prior.id}:superseded:${id}`,prior.id,'superseded',s.asOfBlock,JSON.stringify({ replacementId:id })]);
        await tx.notify('verdict_created',{ id,coin:s.coin });
      } else verdict=(await tx.sql.query<{data:Verdict}>('SELECT data FROM verdicts WHERE id=$1',[id])).rows[0].data;
    }
    for (const m of matches) await tx.sql.query('INSERT INTO playbook_matches VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[binary(s.coin),s.asOfBlock,RULES_VERSION,m.id,JSON.stringify(m)]);
    for(const match of matches)this.cache?.recordMatch(s.coin,String(s.asOfBlock),match);
    card.verdict=verdict;
    await saveCheck(true);
    // Successive halvings can have identical presentation. A forced record is still a distinct public event.
    const hash=move.force ? digest({content:cardHash(card),priceRecord:verdict.receipt.id}) : cardHash(card);
    const sameBlock=(await tx.sql.query<{id:string;hash:string}>('SELECT id,hash FROM coin_cards WHERE coin=$1 AND valid_from_block=$2 AND rules_version=$3 ORDER BY id',[binary(s.coin),s.asOfBlock,RULES_VERSION])).rows;
    const id=sameBlock.find(c=>c.hash===hash)?.id ?? (previous?.hash===hash && !move.force ? previous.id : `card:${s.coin}:${s.asOfBlock}:${RULES_VERSION}${sameBlock.length ? `:${hash}` : ''}`);
    const inserted=(await tx.sql.query('INSERT INTO coin_cards VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[id,binary(s.coin),s.asOfBlock,hash,JSON.stringify(card),RULES_VERSION])).rows.length;
    card.verdict={...verdict,lastChecked:{block:s.asOfBlock,at:checkedAt}};
    await tx.sql.query(`INSERT INTO coin_card_latest VALUES($1,$2,$3,$4) ON CONFLICT(coin) DO UPDATE SET card_id=excluded.card_id,as_of_block=excluded.as_of_block,data=excluded.data
      WHERE coin_card_latest.as_of_block<=excluded.as_of_block`,[binary(s.coin),id,s.asOfBlock,JSON.stringify(card)]);
    await publishBlueChipMeasurements(tx,s);
    if(state){state.prior={id:verdict.receipt.id,signature,data:verdict};state.previous={id,hash};state.signal=card.signal;}
    if (inserted) await tx.notify('card_updated',{ id,coin:s.coin });
    return card;
  }
  /** Runs beside busy rating queues, including with the category disabled. New listed coins are swept too. */
  private async blueChipBackfillLoop() {
    while(!this.stopped) {
      let filled=0;
      try { filled=await backfillBlueChip(this.db); }
      catch(error) { this.options.onRerateError?.(error); }
      await new Promise<void>(resolve=>{
        const timer=setTimeout(resolve,filled ? 1000 : 30_000);
        this.blueChipWake=()=>{clearTimeout(timer);resolve();};if(this.stopped)this.blueChipWake();
      });
    }
  }
  private async reconcile() {
    const cursor=(await this.db.sql.query<{ block:string; hash:Uint8Array }>("SELECT block,hash FROM engine_cursors WHERE stream='engines'")).rows[0];
    if (!cursor || !cursor.hash) return;
    const current=await this.db.blockHash(BigInt(cursor.block));
    const observed=(await resolveClock(this.db,Number(cursor.block)))?.hash;
    if (current===hex(cursor.hash) || current==null && observed && hex(observed)===hex(cursor.hash)) return;
    // Reorged verdicts are retained with orphaned events. Replay correction requires a fresh version identity.
    // TODO(spec): cross-task canonical recovery is conservative: stop for explicit derived-history reconciliation instead of deleting verdict history.
    throw new Error('Engine cursor is on an orphaned block; reconcile derived history before continuing');
  }
}

/**
 * Radar coins (active since `since`) whose last trade is later than their card's block and whose card was written
 * before `settledBefore` (seconds), most recently traded first, with their card ids.
 */
export async function tradedSinceCard(db:ChainDb,since:number,settledBefore:number,limit:number,otherSettledBefore=settledBefore-(TRADED_RERATE_OTHER_SEC-TRADED_RERATE_SEC)):Promise<{coin:Address;card:string}[]> {
  if(limit<=0)return [];
  return (await db.sql.query<{coin:Uint8Array;card:string}>(`SELECT r.coin,l.card_id AS card FROM read_coins r JOIN coin_card_latest l ON l.coin=r.coin
    JOIN engine_block_times b ON b.number=l.as_of_block LEFT JOIN coin_rating_checks checked ON checked.coin=l.coin
    WHERE r.activity>to_timestamp($1) AND r.activity>b.ts
      AND coalesce(checked.checked_at,b.ts)<to_timestamp(CASE WHEN r.launchpad='pons' THEN $2::double precision ELSE $4::double precision END)
    ORDER BY r.activity DESC,r.coin LIMIT $3`,[since,settledBefore,limit,otherSettledBefore])).rows.map(row=>({coin:hex(row.coin) as Address,card:row.card}));
}

/**
 * Radar coins (active since `since`) that have no card, oldest eligible launch
 * first: a deployer's launches are first-scanned oldest first, so each sees its siblings in deployer history as the
 * replay does. Coins whose sources failed wait out the poll's backoff (retryAfterBlocks); `skip` holds recent tries.
 */
export async function unscannedCoins(db:ChainDb,since:number,block:number,limit:number,skip:Address[]=[]):Promise<Address[]> {
  if(limit<=0)return [];
  return (await db.sql.query<{coin:Uint8Array}>(`SELECT r.coin FROM read_coins r JOIN tokens t ON t.address=r.coin
      LEFT JOIN engine_card_failures f ON f.coin=r.coin
      WHERE r.activity>to_timestamp($1) AND t.deployer IS NOT NULL AND NOT EXISTS(SELECT 1 FROM coin_card_latest l WHERE l.coin=r.coin)
        AND NOT r.coin=ANY($4::bytea[]) AND (f.coin IS NULL OR $2-f.last_block>=least(power(2,greatest(1,least(f.attempts,10))),1024)*600)
      ORDER BY t.first_block,r.coin LIMIT $3`,[since,block,limit,skip.map(binary)])).rows.map(row=>hex(row.coin) as Address);
}

const staleRatingCaches=new WeakMap<ChainDb,Map<Address,{version:string;stale:boolean}>>();
/**
 * Cards earlier code rated without the bundle, holder-concentration, deployer or run-up checks (any level: Clear looked
 * at none of them before 2026-10-12), without the owner-power read on a Pons token, or with a bundle or run-up reason in earlier wording,
 * and pending cards that would rate differently now, most recently active first,
 * with their card ids: written before
 * `rulesAt` (CLEAR_RULES_AT, or the worker's start for cards earlier code wrote); missing the honeypot check while a sell check ran after them (sell-check-reference.ts reads it at the
 * next checkpoint); or, for a Pons coin that has traded, missing the wash or curve check (both need every swap priced)
 * while no swap is unpriced any more (pricing repair). `skip` holds card ids already re-rated that are still current.
 */
export async function staleRatings(db:ChainDb,coins:Address[],limit:number,skip:ReadonlyMap<Address,string>=new Map(),rulesAt=CLEAR_RULES_AT,otherRulesAt=NO_OTHER_RERATE):Promise<{coin:Address;card:string}[]> {
  if(!coins.length || limit<=0)return [];
  const cache=staleRatingCaches.get(db) ?? new Map<Address,{version:string;stale:boolean}>();
  const updates=new Map<Address,{version:string;stale:boolean}>(),skipped=new Set(skip.values());
  const result=await db.tx(async tx=>{
    await tx.sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const found:{coin:Address;card:string}[]=[];
    // Only compact keys/generations are visited on an unchanged poll. Card flags are maintained at write time.
    const ordered=(await tx.sql.query<{coin:Uint8Array;card:string;version:string}>(`SELECT r.coin,l.card_id AS card,
      coalesce(v.revision,0)::text||':'||coalesce(s.revision,0)::text||':'||coalesce(s.high_block,-1)::text AS version
      FROM read_coins r JOIN engine_rating_candidates l ON l.coin=r.coin
      LEFT JOIN engine_rating_versions v ON v.coin=r.coin LEFT JOIN engine_swap_versions s ON s.coin=r.coin
      WHERE r.coin=ANY($1::bytea[]) ORDER BY r.activity DESC NULLS LAST,r.coin`,[coins.map(binary)])).rows;
    const version=(row:typeof ordered[number])=>`${row.card}:${row.version}:${rulesAt}:${otherRulesAt}`;
    for(let offset=0;offset<ordered.length && found.length<limit;offset+=128) {
      const page=ordered.slice(offset,offset+128).filter(row=>!skipped.has(row.card));
      const changed=page.filter(row=>cache.get(hex(row.coin))?.version!==version(row));
      if(changed.length) {
        const stale=new Set((await tx.sql.query<{coin:Uint8Array}>(`SELECT l.coin FROM unnest($1::bytea[]) candidate(coin)
          CROSS JOIN LATERAL (SELECT * FROM engine_rating_candidates WHERE coin=candidate.coin OFFSET 0) l
          CROSS JOIN LATERAL (SELECT launchpad FROM tokens WHERE address=l.coin OFFSET 0) t
          LEFT JOIN LATERAL (SELECT created_at,sec FROM engine_runs WHERE coin=l.coin AND block=l.as_of_block AND rules_version=$3 OFFSET 0) e ON true
          WHERE ((l.legacy OR l.control_unavailable AND t.launchpad='pons') AND coalesce(e.created_at,to_timestamp(e.sec))<$2::timestamptz
          OR l.pending AND (coalesce(e.created_at,to_timestamp(e.sec))<$2::timestamptz
            OR l.missing_honeypot AND EXISTS(SELECT 1 FROM sell_check_runs s WHERE s.coin=l.coin AND s.block>l.as_of_block AND s.status IN ('sellable','refused'))
            OR t.launchpad='pons' AND l.missing_pricing AND EXISTS(SELECT 1 FROM swaps s WHERE s.coin=l.coin)
              AND NOT EXISTS(SELECT 1 FROM swaps s WHERE s.coin=l.coin AND s.usd IS NULL))
          OR t.launchpad IS DISTINCT FROM 'pons' AND coalesce(e.created_at,to_timestamp(e.sec))<$4::timestamptz)`,
        [changed.map(row=>row.coin),rulesAt,RULES_VERSION,otherRulesAt])).rows.map(row=>hex(row.coin)));
        for(const row of changed)updates.set(hex(row.coin),{version:version(row),stale:stale.has(hex(row.coin))});
      }
      for(const row of page)if((updates.get(hex(row.coin)) ?? cache.get(hex(row.coin)))?.stale && found.length<limit)
        found.push({coin:hex(row.coin),card:row.card});
    }
    return found;
  });
  for(const [coin,entry] of updates){cache.delete(coin);cache.set(coin,entry);}
  while(cache.size>20000)cache.delete(cache.keys().next().value!);
  staleRatingCaches.set(db,cache);
  return result;
}

/** Half of ordinary cycle slots are reserved for first scans. Price moves run before both lanes. */
export function reserveFirstScans(first:readonly Address[],routine:readonly {coin:Address;card:string}[],moved:readonly {coin:Address;card:string}[]):{coin:Address;card?:string}[] {
  const urgent=new Set(moved.map(entry=>entry.coin));
  const pending=first.filter(coin=>!urgent.has(coin)).slice(0,FIRST_SCAN_SLOTS).map(coin=>({coin}));
  const seen=new Set([...urgent,...pending.map(entry=>entry.coin)]);
  const rated=routine.filter(entry=>{if(seen.has(entry.coin))return false;seen.add(entry.coin);return true;}).slice(0,FIRST_SCAN_SLOTS*2-pending.length);
  return [...pending,...rated];
}
