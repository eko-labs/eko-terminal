import { PartitionLockTimeoutError } from '@eko/db';
import { walletProtocolTopics } from './wallet-protocol.js';
import { decodePoolEvents } from './pool-events.js';
import { loadSenderScope, extendSenderScope, needsSender, type SenderScope } from './sender-scope.js';
import { decodePonsResult, decodeResult, ponsFactoryAbi, ponsCurveAbi, v3Abi, v4Abi, erc20Abi, wethAbi, rpcStopReason, isTransientRpcUnavailable, backoffDelay } from '@eko/chain';
import { binary, hex, type ChainDb } from '@eko/db';
import { toHex, toEventSelector, type Address, type Hex } from 'viem';
import { lower, native } from './clients.js';
import { isRangeLimit } from './backfill.js';
import { budgetedQueries, type LogFilter } from './log-budget.js';
import { Semaphore, settle } from './concurrency.js';
import { ReorgDepthError } from './head.js';
import type { BlockDecoder, Prepared, TokenRow } from './decode.js';
import { log, type ChainClient, type Logger, type RpcBlock, type RpcLog, type RpcReceipt, type TokenMetadata } from './types.js';
import { BlockRows, emptyFlushTimings } from './rows.js';
import { safeError } from './safe-error.js';

const userOpTopics = walletProtocolTopics;
export const headTopics = [...new Set([...ponsFactoryAbi, ...ponsCurveAbi, ...v3Abi, ...v4Abi, ...erc20Abi, ...wethAbi].filter(e => e.type === 'event').map(toEventSelector))];
const transferTopic=toEventSelector(erc20Abi[0]),poolCreatedTopic=toEventSelector(v3Abi[0]),initializeTopic=toEventSelector(v4Abi[0]);
const v3PoolTopics=new Set(v3Abi.slice(1).map(toEventSelector));
const identity = (l: RpcLog) => `${lower(l.transactionHash)}:${BigInt(l.logIndex)}`;
const order = (a: RpcLog, b: RpcLog) => BigInt(a.blockNumber) === BigInt(b.blockNumber) ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1;
class ReorgDuringTick extends Error {}
/** A deadlock or serialization failure reported by the database (SQLSTATE 40P01, 40001): the transaction rolled back whole. */
export const lockContention = (error: unknown) => { const e = error as { code?: unknown; message?: unknown } | null;
  return error instanceof PartitionLockTimeoutError || e?.code === '40P01' || e?.code === '40001' || (typeof e?.message === 'string' && /deadlock detected|could not serialize access/i.test(e.message)); };
/** A single block's logs exceed the provider's reply limits even alone. */
class SpanTooLarge extends Error {}
/**
 * Blocks per candidate eth_getLogs request at most (or maxRange, if larger). A larger catch-up window reads several
 * spans concurrently: smaller replies stay under provider size and result limits, and transfer in parallel instead of
 * in one long reply.
 */
const MAX_LOG_SPAN = 500;
/**
 * Unknown emitters of v3 pool events checked against the canonical factory per window. Each costs two pinned reads on
 * the lane the head's own reads use, so the first minutes after a start (thousands of unknown emitters) are spread
 * over many windows instead of holding one up.
 */
const POOL_CHECKS = 16;
interface WindowData { deepLinks:Set<bigint>;from:bigint;to:bigint;head:bigint;scope:SenderScope;candidates:RpcLog[];blocks:Map<bigint,RpcLog[]>;hashes:Map<bigint,Hex>;headers:Map<bigint,RpcBlock>;receiptsByBlock:Map<bigint,RpcReceipt[]>;discoveredPools:Map<string,import('./types.js').PoolMetadata>;timings:LogHeadFollower['timings'];meterBefore:ReturnType<NonNullable<ChainClient['rpcTiming']>>|undefined }
type ReceiptReason = 'pons_coin_trade' | 'other_indexed_token' | 'launch' | 'liquidity' | 'other_event';
const emptyReasons = (): Record<ReceiptReason,number> => ({pons_coin_trade:0,other_indexed_token:0,launch:0,liquidity:0,other_event:0});
const emptyTimings=()=>({flush:emptyFlushTimings(),deepLinksSkipped:0,logRequests:0,commits:0,rpcWallMs:0,dbWriteMs:0,logsMs:0,discoveryMs:0,timestampMs:0,receiptsMs:0,headersMs:0,parentHeadersMs:0,timestampHeadersMs:0,enrichmentMs:0,prepareMs:0,windowScopeMs:0,receiptRpcMs:0,receiptMaxMs:0,receiptConcurrency:0,enrichmentConcurrency:0,blocks:0,logs:0,receipts:0,receiptReasons:emptyReasons(),headers:0,cursorReads:0,timestampHeaders:0,parentHeaders:0,timestampScans:0});
interface Options { pipeline?:boolean; startBlock?: bigint; tickMs?: number; maxRange?: number; codeCacheSec?: number; reorgDepth: number; concurrency?: number; logger?: Logger;
  /** Progress hooks for a watchdog: every chain head read, and every committed scan cursor. */
  onHead?: (head: bigint) => void; onProgress?: (cursor: bigint) => void;
  /** Backoff after a tick that failed on transient provider unavailability (default 1 s doubling to 60 s, jittered). */
  retryBaseMs?: number; retryCapMs?: number; random?: () => number;
  /**
   * Window while far behind (default maxRange). Candidate logs are still read in spans the provider accepts, and near
   * the head windows return to maxRange.
   */
  catchUpRange?: number;
  /** Blocks per write transaction (default min(maxRange, 200)); a larger window commits several bounded prefixes. */
  commitRange?: number;
  /**
   * Parent links of stored blocks deeper than reorgDepth below the head whose parent block had no candidate log:
   * 'fetch' (default) reads a header per such block; 'skip' stores no link (NULL parent_hash) and saves those reads.
   * Inside the reorg window every link is fetched and checked either way.
   */
  deepParents?: 'fetch' | 'skip';
  /** Once public logs are known to lack blockTimestamp, read candidates on the paid lane instead of twice (default true). */
  paidLogs?: boolean;
  /** Prepare the next commit batch while the previous one writes (default true). */
  overlapWrites?: boolean;
  /**
   * Check emitters of v3 pool events the scope does not know against the canonical factory, and index the ones that are
   * its pools from then on (default true when the client can ask the factory). `onPools` reports each window's finds.
   */
  discoverPools?: boolean; onPools?: (found: number) => void;
  /** Runs after a tick that ended at the head (a bounded background step); its failure is logged, never the head's. */
  afterTick?: () => Promise<unknown>; }
interface StagedBatch { batch: BlockRows; states: Prepared[]; dates: Date[]; last: RpcBlock | null; newest: Hex | null }

/** Sparse head anchor plus a separate scan cursor: empty windows need neither headers nor chain rows. */
export class LogHeadFollower {
  private stopping = false;
  private ticking?:Promise<void>;
  private pipeline=false;
  private timestampProbe?:boolean;
  private ahead?:Promise<{ok:true;data:WindowData}|{ok:false;error:unknown}>;
  private aheadFrom?:bigint;
  private wake?: () => void;
  private rpc: Semaphore;
  private readonly maxRange: number;
  private readonly catchUpRange: number;
  private readonly commitRange: number;
  /** Blocks per candidate eth_getLogs request: halves on a size refusal, then grows back, capped for a while. */
  private span: number;
  private readonly maxSpan: number;
  private spanCeiling = Infinity;
  private spanSuccesses = 0;
  /** Public logs lack blockTimestamp and paid logs carry it: read candidates on the paid lane instead of twice. */
  private paidLogs?: boolean;
  private budgetSpent = false;
  /** Emitters of v3 pool events found not to be pools of the canonical factory: not read again by this process. */
  private rejectedEmitters = new Set<string>();
  private caughtUp = false;
  private timings = emptyTimings();
  private async remote<T>(read:()=>Promise<T>): Promise<T> { const began=performance.now(); try { return await read(); } finally { this.timings.rpcWallMs += performance.now()-began; } }
  /**
   * Validate positive integer tick/window/cache/reorg settings and initialize concurrency control.
   * Indexer operator construction only; invalid settings/concurrency throw before acquisition.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  constructor(readonly client: ChainClient, readonly db: ChainDb, readonly decoder: BlockDecoder, readonly options: Options) {
    for (const value of [options.tickMs ?? 1000, options.maxRange ?? 200, options.codeCacheSec ?? 3600, options.reorgDepth, options.catchUpRange ?? 1, options.commitRange ?? 1]) if (!Number.isInteger(value) || value < 1) throw new Error('Invalid log head configuration');
    this.pipeline=options.pipeline??false;
    this.maxRange = options.maxRange ?? 200;
    this.catchUpRange = Math.max(this.maxRange, options.catchUpRange ?? this.maxRange);
    this.commitRange = options.commitRange ?? Math.min(this.maxRange, 200);
    this.maxSpan = Math.min(this.catchUpRange, Math.max(this.maxRange, MAX_LOG_SPAN));
    this.span = this.maxSpan;
    this.rpc = new Semaphore(options.concurrency ?? 32);
  }
  /**
   * Request stop and wake the poll sleep. Host lifecycle only; in-flight acquisition drains through
   * run cleanup rather than being synchronously cancelled.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  stop() { this.stopping = true; this.wake?.(); }
  private get logger() { return this.options.logger ?? log; }
  private header(n: bigint) { return this.client.header?.(n) ?? this.client.block(n); }
  private async anchor(n: bigint) {
    const b = await this.header(n);this.timings.cursorReads++;
    if (!b || BigInt(b.number) !== n) throw new Error('Invalid cursor header');
    await this.db.tx(async tx => {
      await tx.insert('chain_blocks', { number: n.toString(), block: n.toString(), hash: binary(b.hash), parent_hash: binary(b.parentHash), ts: new Date(Number(BigInt(b.timestamp)) * 1000) });
      await tx.setCursor('head', n, b.hash);
      await tx.setCursor('head_logs', n, null);
    });
    return b;
  }
  /**
   * Search retained sparse blocks within the configured depth, delete chain state above a canonical
   * ancestor/reset both head cursors and invalidate caches. Indexer role only; RPC/SQL failures or
   * depth exhaustion reject. Sparse anchors still count depth in blocks.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async rollback(from: bigint) {
    for (let depth = 0, n = from; n >= 0n && depth < this.options.reorgDepth; depth++, n--) {
      const stored = await this.db.blockHash(n);
      // Sparse storage still counts depth in blocks, not in stored rows.
      if (!stored) continue;
      const canonical = await this.header(n);
      if(!canonical)throw new Error('Invalid reorg header');
      if (BigInt(canonical.number) !== n || stored !== lower(canonical.hash)) continue;
      await this.db.tx(async tx => {
        await tx.deleteAbove(n);
        await tx.setCursor('head', n, canonical.hash);
        await tx.setCursor('head_logs', n, null);
        await tx.notify('chain_reorg', { fromBlock: (n + 1n).toString() });
      });
      this.decoder.invalidate();
      this.logger('chain_reorg', { fromBlock: (n + 1n).toString() });
      return;
    }
    this.logger('alert', { reason: 'reorg_depth_exceeded', depth: this.options.reorgDepth });
    throw new ReorgDepthError('Reorg exceeds INDEX_REORG_DEPTH; indexer halted');
  }
  private async query(filter: LogFilter): Promise<RpcLog[]> {
    try { return await this.client.logs(filter); }
    catch (error) {
      if (rpcStopReason(error) || this.client.rpcStopped?.()) throw error;
      const arrayLimit = /too many addresses|address.*limit|array.*limit/i.test(safeError(error));
      if (!arrayLimit && isRangeLimit(error) && filter.from < filter.to) {
        const mid = (filter.from + filter.to) / 2n;
        return [...await this.query({ ...filter, to: mid }), ...await this.query({ ...filter, from: mid + 1n })];
      }
      if ((arrayLimit || isRangeLimit(error)) && filter.addresses && filter.addresses.length > 1) {
        const mid = Math.ceil(filter.addresses.length / 2);
        return [...await this.query({ ...filter, addresses: filter.addresses.slice(0, mid) }), ...await this.query({ ...filter, addresses: filter.addresses.slice(mid) })];
      }
      throw error;
    }
  }
  private async logs(filter: LogFilter) {
    const result: RpcLog[] = [];
    for (const part of budgetedQueries(filter)) result.push(...await this.query(part));
    return result;
  }
  /** One bounded window. Exposed for offline replay and a lead's budgeted comparison.
   * @remarks
   * Share one in-flight bounded log window, collecting timings while preparing and persisting
   * canonical source data/cursors. Indexer role only; consistency/provider/budget/SQL failures
   * reject and the in-flight latch clears in finally. Caller must use the configured chain; run
   * performs the chain-id check.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  tick():Promise<void> {
    return this.ticking??=this.tickOnce().finally(()=>{this.ticking=undefined;});
  }
  private async tickOnce() {
    const began=performance.now(), meterBefore=this.client.rpcTiming?.();
    this.timings=emptyTimings();
    try { await this.processTick(); }
    finally {
      const meterAfter=this.client.rpcTiming?.();
      this.logger('head_tick',{headers_fetched:this.timings.headers+this.timings.cursorReads,headers_by_reason:{cursor:this.timings.cursorReads,missing_timestamp:this.timings.timestampHeaders,missing_parent:this.timings.parentHeaders},timestamp_scans:this.timings.timestampScans, blocks_covered:this.timings.blocks,logs_kept:this.timings.logs,receipts_fetched:this.timings.receipts,receipts_by_reason:this.timings.receiptReasons,tick_ms:performance.now()-began,
        rpc_wait_ms:meterAfter && meterBefore ? meterAfter.rpcMs-meterBefore.rpcMs : this.timings.rpcWallMs,
        rpc_wall_ms:this.timings.rpcWallMs,meter_admission_ms:meterAfter && meterBefore ? meterAfter.admissionMs-meterBefore.admissionMs : 0,
        meter_rate_wait_ms:meterAfter && meterBefore ? meterAfter.rateWaitMs-meterBefore.rateWaitMs : 0,meter_public_rate_wait_ms:meterAfter&&meterBefore?(meterAfter.publicRateWaitMs??0)-(meterBefore.publicRateWaitMs??0):0,meter_paid_rate_wait_ms:meterAfter&&meterBefore?(meterAfter.paidRateWaitMs??0)-(meterBefore.paidRateWaitMs??0):0,db_write_ms:this.timings.dbWriteMs,logs_ms:this.timings.logsMs,discovery_ms:this.timings.discoveryMs,timestamp_ms:this.timings.timestampMs,receipts_ms:this.timings.receiptsMs,headers_ms:this.timings.headersMs,parent_headers_ms:this.timings.parentHeadersMs,timestamp_headers_ms:this.timings.timestampHeadersMs,enrichment_ms:this.timings.enrichmentMs,prepare_ms:this.timings.prepareMs,window_scope_ms:this.timings.windowScopeMs,receipt_rpc_ms:this.timings.receiptRpcMs,receipt_max_ms:this.timings.receiptMaxMs,receipt_concurrency:this.timings.receiptConcurrency,enrichment_concurrency:this.timings.enrichmentConcurrency,
        // Write phases (summed over the window's commits) and how the window was read.
        db_insert_ms:this.timings.flush.insertMs,db_update_ms:this.timings.flush.updateMs,db_balances_ms:this.timings.flush.balancesMs,db_bars_ms:this.timings.flush.barsMs,db_notify_ms:this.timings.flush.notifyMs,
        commits:this.timings.commits,log_requests:this.timings.logRequests,log_span:this.span,deep_links_skipped:this.timings.deepLinksSkipped,logs_lane:this.paidLogs===true&&this.options.paidLogs!==false?'paid':'public_first',
        ...(this.budgetSpent?{paid_budget:'exhausted',lane:'public'}:{}) });
    }
  }
  private async processTick() {
    const head=await this.remote(()=>this.client.head());
    this.options.onHead?.(head);
    this.observeBudget();
    let previousHash:Hex|undefined;
    let anchored:RpcBlock|undefined;
    let cursor=await this.db.cursor('head');
    let scanned=await this.db.cursor('head_logs')??cursor;
    if(scanned==null){const first=this.options.startBlock??head;if(first>0n){anchored=await this.remote(()=>this.anchor(first-1n));cursor=first-1n;}scanned=first-1n;}
    this.options.onProgress?.(scanned);
    if(cursor!=null){const canonical=anchored??await this.remote(()=>this.header(cursor));if(!anchored)this.timings.cursorReads++;if(!canonical||BigInt(canonical.number)!==cursor)throw new Error('Invalid cursor header');previousHash=canonical.hash;if(await this.db.blockHash(cursor)!==lower(canonical.hash)){await this.discardAhead();await this.rollback(cursor);return;}}
    if(this.stopping||this.client.rpcStopped?.())return;
    const from=scanned+1n;
    if(head<from){this.decoder.metrics.observeLogs(null,0n);return;}
    try {
      let data:WindowData;
      if(this.ahead && this.aheadFrom===from){const read=await this.ahead;this.ahead=undefined;this.aheadFrom=undefined;if(!read.ok)throw read.error;data=read.data;}
      else {await this.discardAhead();data=await this.fetchWindow(from,head,await loadSenderScope(this.db),cursor===from-1n?previousHash:undefined);}
      data.timings.rpcWallMs+=this.timings.rpcWallMs;data.timings.cursorReads+=this.timings.cursorReads;this.timings=data.timings;
      data.head=head;
      if(this.pipeline && head-data.to>=BigInt(this.maxRange) && !this.stopping){
        this.aheadFrom=data.to+1n;
        const scopeBegan=performance.now();
        const scope=this.windowScope(data);
        this.timings.windowScopeMs+=performance.now()-scopeBegan;
        this.ahead=this.fetchWindow(data.to+1n,head,scope,data.candidates.find(l=>BigInt(l.blockNumber)===data.to)?.blockHash).then(data=>({ok:true as const,data}),error=>({ok:false as const,error}));
      }
      await this.applyWindow(data);
    } catch(error) {
      await this.discardAhead();this.decoder.invalidate();
      if(!(error instanceof ReorgDuringTick))throw error;
      const anchor=await this.db.cursor('head');if(anchor==null)throw error;await this.rollback(anchor);
    }
  }
  private async discardAhead(){if(this.ahead)await this.ahead;this.ahead=undefined;this.aheadFrom=undefined;}
  /** Say once when the paid daily budget closes (public-capable reads then continue on the public lane) and when it reopens. */
  private observeBudget() {
    const spent=this.client.paidExhausted?.()??false;
    if(spent===this.budgetSpent)return;
    this.budgetSpent=spent;
    this.logger(spent?'head_public_lane':'head_paid_lane_restored',spent?{reason:'rpc_budget_exhausted',lane:'public',note:'logs, receipts and headers continue on the public lane at its rate; pinned archive reads use it where it still holds the state'}:{reason:'paid_budget_available'});
  }
  /** Far behind, windows grow to catchUpRange; near the head they stay at maxRange. */
  private windowSize(from:bigint,head:bigint) { return head-from+1n>BigInt(this.maxRange)*2n?this.catchUpRange:this.maxRange; }
  /**
   * Candidate logs for [from,to] in spans the provider accepts. A refused span is halved and retried, and later windows
   * keep the smaller span for a while instead of repeating the refusal. A single block that is still refused throws
   * SpanTooLarge (the Transfer topic is then read by token address instead).
   */
  private async candidateLogs(from:bigint,to:bigint,topics:Hex[],paid:boolean,timings:LogHeadFollower['timings']):Promise<RpcLog[]> {
    const read=(a:bigint,b:bigint)=>{timings.logRequests++;return paid?this.client.timestampLogs!({from:a,to:b,topics}):this.client.logs({from:a,to:b,topics});};
    const piece=async(a:bigint,b:bigint):Promise<RpcLog[]>=>{
      try { return await read(a,b); }
      catch(error) {
        if(rpcStopReason(error)||!isRangeLimit(error))throw error;
        if(a===b)throw new SpanTooLarge(safeError(error));
        this.span=Math.min(this.span,Math.max(1,Math.floor(Number(b-a+1n)/2)));this.spanCeiling=this.span;this.spanSuccesses=0;
        // Re-split the refused range at the current span, which a nested refusal may have narrowed further.
        const logs:RpcLog[]=[];
        for(let x=a;x<=b;){const y=x+BigInt(this.span)-1n<b?x+BigInt(this.span)-1n:b;logs.push(...await piece(x,y));x=y+1n;}
        return logs;
      }
    };
    const spans:[bigint,bigint][]=[];
    for(let a=from;a<=to;){const b=a+BigInt(this.span)-1n<to?a+BigInt(this.span)-1n:to;spans.push([a,b]);a=b+1n;}
    // Drain every span before propagating a failure: no request outlives the window it belongs to.
    const reads=await Promise.allSettled(spans.map(([a,b])=>piece(a,b)));
    const failed=reads.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    if(++this.spanSuccesses>=32)this.spanCeiling=Infinity;
    this.span=Math.min(this.maxSpan,this.spanCeiling,this.span*2);
    return reads.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  }
  private windowScope(data:WindowData):SenderScope {
    const scope={...data.scope,tokenRows:[...data.scope.tokenRows],poolRows:[...data.scope.poolRows]};
    // Set membership replaces repeated whole-registry .some()/hex conversions.
    const tokens=new Set<string>(scope.tokenRows.map(t=>hex(t.address))),pools=new Set<string>(scope.poolRows.map(p=>hex(p.id)));
    const initializations=new Map<string,Address>(data.candidates.filter(l=>l.topics[0]===initializeTopic).flatMap(l=>decodePoolEvents(l,{registry:this.decoder.registry}).events).flatMap(e=>e.source==='uniswap_v4'&&e.eventName==='Initialize'?[[lower(e.args.id),e.args.hooks] as const]:[]));
    for(const [curve,token] of scope.curves)if(!tokens.has(lower(token))){tokens.add(lower(token));scope.tokenRows.push({address:binary(token),curve:binary(curve),launchpad:'pons',symbol:null,name:null,decimals:null});}
    for(const [id,pool] of data.discoveredPools)scope.pools.set(id,pool);
    for(const [id,pool] of scope.pools){
      for(const address of [pool.currency0,pool.currency1])if(lower(address)!==native&&!tokens.has(lower(address))){tokens.add(lower(address));scope.tokenRows.push({address:binary(address),curve:null,launchpad:scope.tokens.has(lower(address))?'pons':null,symbol:null,name:null,decimals:null});}
      if(pools.has(id))continue;pools.add(id);
      const hooks=initializations.get(id);
      scope.poolRows.push({id:binary(id),venue:id.length===66?'uniswap_v4':'uniswap_v3',currency0:binary(pool.currency0),currency1:binary(pool.currency1),fee:pool.fee,tick_spacing:pool.tickSpacing,hooks:hooks?binary(hooks):null,creation_verified:false,created_block:'0'});
    }
    return scope;
  }
  private async fetchWindow(from:bigint,head:bigint,initialScope:SenderScope,previousHash?:Hex):Promise<WindowData> {
    const timings=emptyTimings();
    const meterBefore=this.client.rpcTiming?.();
    const remote=async<T>(read:()=>Promise<T>):Promise<T>=>{const began=performance.now();try{return await read();}finally{timings.rpcWallMs+=performance.now()-began;}};
    const size=BigInt(this.windowSize(from,head)),to=from+size-1n<head?from+size-1n:head;
      let candidates: RpcLog[]; let chunkTransfers=false;
      const logsBegan=performance.now();
      // Paid logs carry blockTimestamp: once public logs are known to lack it, one paid read replaces the public read plus
      // the paid timestamp scan of the same range (the paid request count stays the same, the public one goes away).
      const paidLogs=this.paidLogs===true&&this.options.paidLogs!==false&&!!this.client.timestampLogs;
      try { candidates=await remote(()=>this.candidateLogs(from,to,headTopics,paidLogs,timings)); }
      catch(error) {
        if(!(error instanceof SpanTooLarge))throw error;
        // Even one block is too large with every Transfer: read other topics by range and Transfers by tracked token.
        chunkTransfers=true; candidates=await remote(()=>this.logs({from,to,topics:headTopics.filter(t=>t!==transferTopic)}));
      }
      timings.logsMs=performance.now()-logsBegan;
      timings.blocks=Number(to-from+1n);
      const validate = (logs: RpcLog[]) => {
        if (logs.some(l => l.removed)) throw new ReorgDuringTick('Removed log');
        if (logs.some(l => BigInt(l.blockNumber) < from || BigInt(l.blockNumber) > to)) throw new Error('Head logs require a consistent block range');
      };
      validate(candidates);
      const candidateHashes = new Map<bigint, string>();
      for (const l of candidates) {
        const n = BigInt(l.blockNumber), previous = candidateHashes.get(n);
        if (previous && previous !== lower(l.blockHash)) throw new ReorgDuringTick('Conflicting block hashes');
        candidateHashes.set(n, lower(l.blockHash));
      }
      const registry = this.decoder.registry;
      const scope=extendSenderScope(initialScope,candidates,registry);
      const tokenRows=scope.tokenRows;
      const knownTokens=new Map<string,TokenMetadata>(tokenRows.map(r=>[hex(r.address),{...r,totalSupply:r.total_supply==null?null:BigInt(r.total_supply),supplyBlock:r.supply_block==null?null:BigInt(r.supply_block)}]));
      const tokens=new Set(knownTokens.keys());
      const curves=scope.curves;
      const pools=new Set<string>(scope.pools.keys());
      const poolCurrencies=new Map<string,string[]>([...scope.pools].map(([id,p])=>[id,[lower(p.currency0),lower(p.currency1)]]));
      const ponsTokens=scope.tokens;
      const known = new Set((['pons.factory', 'uniswapV3.factory', 'uniswapV4.poolManager', 'tokens.WETH'] as const).map(k => lower(registry.requireAddress(k))));
      const discoveryBegan=performance.now();
      const discoveredPools = await remote(()=>this.decoder.discoverV3Pools(candidates,pools,scope));
      for (const [id,pool] of await remote(()=>this.discoverCanonical(candidates,new Set([...pools,...discoveredPools.keys()])))) discoveredPools.set(id,pool);
      timings.discoveryMs=performance.now()-discoveryBegan;
      for (const [id,pool] of discoveredPools) { poolCurrencies.set(id,[lower(pool.currency0),lower(pool.currency1)]); pools.add(id); scope.pools.set(id,pool); tokens.add(lower(pool.currency0)); tokens.add(lower(pool.currency1)); }
      const deferredTopics=v3PoolTopics;
      const activeFrom = new Map<string, bigint>();
      const selected: RpcLog[] = [];
      const receiptBlocks = new Set<bigint>();
      const receiptReasons = new Map<bigint,Set<ReceiptReason>>();
      for (const l of candidates.sort(order)) {
        const dummy = { from: native, to: null };
        // Discover before filtering, including launches that follow curve trades within the same block.
        for (const e of decodePonsResult(l, dummy, { registry, tokenForCurve: c => curves.get(lower(c)) ?? null }).events) if (e.kind === 'launch') { ponsTokens.add(lower(e.token)); tokens.add(lower(e.token)); curves.set(lower(e.curve), e.token); activeFrom.set(lower(e.curve), BigInt(l.blockNumber)); }
        for (const e of decodePoolEvents(l, { registry }).events) {
          if (e.source === 'uniswap_v3' && e.eventName === 'PoolCreated') { poolCurrencies.set(lower(e.args.pool),[lower(e.args.token0),lower(e.args.token1)]); pools.add(lower(e.args.pool)); activeFrom.set(lower(e.args.pool), BigInt(l.blockNumber)); tokens.add(lower(e.args.token0)); tokens.add(lower(e.args.token1)); }
          if (e.source === 'uniswap_v4' && e.eventName === 'Initialize') { poolCurrencies.set(lower(e.args.id),[lower(e.args.currency0),lower(e.args.currency1)]); pools.add(lower(e.args.id)); activeFrom.set(lower(e.args.id), BigInt(l.blockNumber)); tokens.add(lower(e.args.currency0)); tokens.add(lower(e.args.currency1)); }
        }
      }
      for (const l of candidates.sort(order)) {
        const emitter = lower(l.address);
        const activation = activeFrom.get(emitter === lower(registry.requireAddress('uniswapV4.poolManager')) ? lower(l.topics[1] ?? '0x') : emitter);
        if (activation != null && BigInt(l.blockNumber) < activation) continue;
        const transfer = l.topics[0] === transferTopic;
        if (transfer ? !tokens.has(emitter) : !known.has(emitter) && !curves.has(emitter) && !pools.has(emitter) && !deferredTopics.has(l.topics[0]) && l.topics[0]!==poolCreatedTopic) continue;
        selected.push(l);
        const pons = decodePonsResult(l, { from: native, to: null }, { registry, tokenForCurve: c => curves.get(lower(c)) ?? null });
        const standard = decodePoolEvents(l, { registry, isV3Pool: a => pools.has(lower(a)) });
        if (needsSender(l,scope,registry)) {
          const n = BigInt(l.blockNumber), reasons = receiptReasons.get(n) ?? new Set<ReceiptReason>();
          receiptBlocks.add(n); receiptReasons.set(n,reasons);
          for (const e of pons.events) reasons.add(e.kind === 'trade' ? 'pons_coin_trade' : e.kind === 'launch' ? 'launch' : 'other_event');
          for (const e of standard.events) if (e.source === 'uniswap_v3' || e.source === 'uniswap_v4') {
            if (e.eventName === 'Swap') {
              const id = e.source === 'uniswap_v3' ? emitter : lower(e.args.id);
              reasons.add(poolCurrencies.get(id)?.some(a=>ponsTokens.has(a)) ? 'pons_coin_trade' : 'other_indexed_token');
            } else if (e.eventName !== 'PoolCreated') reasons.add('liquidity');
          }
        }
      }
      if(chunkTransfers) {
        const addresses=[...tokens].filter(a=>a!==native) as Address[];
        if(addresses.length) { const transfers=await remote(()=>this.logs({from,to,addresses,topics:[transferTopic]}));validate(transfers);selected.push(...transfers.filter(l=>tokens.has(lower(l.address)))); }
      }
      // Transfer is already in the OR topic scan. Reuse it; address chunks are a size-error fallback only.
      timings.logs=selected.length;
      const unique = new Map<string, RpcLog>();
      for (const l of selected) {
        const previous = unique.get(identity(l));
        if (previous && (lower(previous.blockHash) !== lower(l.blockHash) || previous.data !== l.data || previous.address !== l.address || previous.topics.join() !== l.topics.join())) throw new ReorgDuringTick('Conflicting logs');
        unique.set(identity(l), l);
      }
      const blocks = new Map<bigint, RpcLog[]>();
      for (const l of [...unique.values()].sort(order)) { const n = BigInt(l.blockNumber); const group = blocks.get(n) ?? []; group.push(l); blocks.set(n, group); }
      const headers = new Map<bigint, RpcBlock>();
      const rawHashes = new Map(candidates.map(l => [BigInt(l.blockNumber), l.blockHash]));
      if(previousHash)rawHashes.set(from-1n,previousHash);
      const headerBegan=performance.now();
      // TODO(spec): Logs omit parentHash and the spec does not define sparse parent links. Inside the reorg window
      // they stay exact, read public first and paid only when public fails (no spill). Blocks deeper than INDEX_REORG_DEPTH
      // below the head cannot reorg (a deeper one halts the indexer): with deepParents 'skip' (the CLI default) their
      // missing links are not read and the stored row's parent_hash stays NULL. Those header reads were most of a
      // catch-up window's public requests.
      const deepLinks=new Set<bigint>(), deepBelow=head-BigInt(this.options.reorgDepth);
      const parentNs=[...blocks.keys()].filter(n=>{
        if(rawHashes.has(n-1n))return false;
        if(this.options.deepParents==='skip'&&n<deepBelow){deepLinks.add(n);return false;}
        return true;
      });
      timings.deepLinksSkipped=deepLinks.size;
      const parentRead=(async()=>{
        try {
          await settle(parentNs.map(n=>this.rpc.run(async()=>{
            headers.set(n,await (this.client.parentHeader?.(n)??this.client.timestampHeader?.(n)??this.header(n)));
            timings.headers++;timings.parentHeaders++;
          })));
        } finally {timings.parentHeadersMs=performance.now()-headerBegan;}
      })();
      const receiptBegan=performance.now();
      let receiptActive=0;
      const receiptRead = Promise.allSettled([...receiptBlocks].map(n => this.rpc.run(async () => {
        const began=performance.now();
        timings.receiptConcurrency=Math.max(timings.receiptConcurrency,++receiptActive);
        try {
          const receipts=await this.client.receipts(n);
          timings.receipts++;
          for(const reason of receiptReasons.get(n)??[])timings.receiptReasons[reason]++;
          return [n,receipts] as const;
        } finally {
          receiptActive--;
          const elapsed=performance.now()-began;
          timings.receiptRpcMs+=elapsed;timings.receiptMaxMs=Math.max(timings.receiptMaxMs,elapsed);
        }
      }))).then(reads=>{timings.receiptsMs=performance.now()-receiptBegan;return reads;});
      // Timestamp capability recovery and receipt loading use independent providers.
      const timestampRead = (async()=>{
        const began=performance.now();
        try {
          // Candidates already read on the paid lane (now served by public: budget spent or paid failing) skip the scan;
          // header reads below recover their timestamps.
          if(!paidLogs && this.timestampProbe!==false && this.client.timestampLogs && [...blocks].some(([n,ls])=>!receiptBlocks.has(n)&&ls.every(l=>!l.blockTimestamp||BigInt(l.blockTimestamp)===0n))){
            timings.timestampScans++;
            let stamped:RpcLog[]=[];
            try {stamped=await this.candidateLogs(from,to,headTopics,true,timings);}
            catch(error){if(!(error instanceof SpanTooLarge))throw error;}
            validate(stamped);
            const timestamps=new Map<bigint,Hex>();
            for(const l of stamped){const n=BigInt(l.blockNumber);if(candidateHashes.has(n)&&candidateHashes.get(n)!==lower(l.blockHash))throw new ReorgDuringTick('Timestamp provider hash mismatch');if(!l.blockTimestamp||BigInt(l.blockTimestamp)===0n)continue;const prior=timestamps.get(n);if(prior&&BigInt(prior)!==BigInt(l.blockTimestamp))throw new ReorgDuringTick('Conflicting provider timestamps');timestamps.set(n,l.blockTimestamp);}
            this.timestampProbe=timestamps.size>0;
            if(timestamps.size>0)this.paidLogs=true;
            for(const [n,ls] of blocks){const timestamp=timestamps.get(n);if(timestamp){if(ls.some(l=>l.blockTimestamp&&BigInt(l.blockTimestamp)>0n&&BigInt(l.blockTimestamp)!==BigInt(timestamp)))throw new ReorgDuringTick('Timestamp provider mismatch');blocks.set(n,ls.map(l=>({...l,blockTimestamp:timestamp})));}}
          }
        } finally {timings.timestampMs=performance.now()-began;}
      })();
      // Drain both siblings even on failure before retrying or invalidating caches.
      const results=await remote(()=>Promise.allSettled([receiptRead,timestampRead,parentRead]));
      for(const result of results)if(result.status==='rejected')throw result.reason;
      const reads=await receiptRead;
      const failed=reads.find(r=>r.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      const receiptsByBlock=new Map(reads.flatMap(r=>r.status==='fulfilled'?[[r.value[0],r.value[1]] as const]:[]));
      const fallbackBegan=performance.now();
      await remote(async()=>{
        const need:bigint[]=[];
        for(const [n,logs] of blocks){
          const timestampKnown=[...logs,...(receiptsByBlock.get(n)?.flatMap(r=>r.logs)??[])].some(l=>l.blockTimestamp&&BigInt(l.blockTimestamp)>0n);
          if(headers.has(n)){if(!timestampKnown)timings.timestampHeaders++;continue;}
          if(!timestampKnown)need.push(n);
        }
        await settle(need.map(n=>this.rpc.run(async()=>{
          const header=await (this.client.timestampHeader?.(n)??this.header(n));
          headers.set(n,header);timings.headers++;
          timings.timestampHeaders++;
        })));
      });
      timings.timestampHeadersMs=performance.now()-fallbackBegan;
      timings.headersMs=performance.now()-headerBegan;
      return {deepLinks,from,to,head,scope,candidates,blocks,hashes:rawHashes,headers,receiptsByBlock,discoveredPools,timings,meterBefore};
  }
  /**
   * Pools of the registry's canonical v3 factory among emitters of v3 pool events the scope does not hold. The head
   * discovered a v3 pool only when it paired a Pons coin (or WETH with USDG); every other pool created before the
   * indexer followed the factory stayed unknown, its events stored raw and its coins invisible (2026-10-13: 5,853 such
   * emitters, 290,000 events a day). An emitter is accepted only when the factory itself names it as the pool of the
   * currencies and fee it reports: a contract that merely answers like a pool is rejected, and not read again by this
   * process. Two pinned reads per emitter, at most `POOL_CHECKS` emitters per window. A provider failure or a spent
   * budget leaves the emitter for a later window; any other failure rejects it, so no contract can stall the head.
   */
  private async discoverCanonical(candidates:RpcLog[],known:Set<string>) {
    const found=new Map<string,import('./types.js').PoolMetadata>();
    if(this.options.discoverPools===false||!this.client.canonicalV3Pool)return found;
    const manager=lower(this.decoder.registry.requireAddress('uniswapV4.poolManager')),first=new Map<string,RpcLog>();
    for(const l of candidates){
      const address=lower(l.address);
      if(!v3PoolTopics.has(l.topics[0])||known.has(address)||address===manager||this.rejectedEmitters.has(address)||first.has(address))continue;
      first.set(address,l);if(first.size>=POOL_CHECKS)break;
    }
    await settle([...first].map(([address,l])=>this.rpc.run(async()=>{
      try {
        const n=BigInt(l.blockNumber),pool=await this.client.v3Pool(l.address,n);
        const canonical=pool?await this.client.canonicalV3Pool!(pool.currency0,pool.currency1,pool.fee,n):null;
        if(pool&&canonical&&lower(canonical)===address)found.set(address,pool);else this.rejectedEmitters.add(address);
      } catch(error) {
        if(this.stopping||this.client.rpcStopped?.())throw error;
        if(rpcStopReason(error)||isTransientRpcUnavailable(error))return;
        this.rejectedEmitters.add(address);
      }
    })));
    if(found.size){this.logger('v3_pools_discovered',{pools:found.size,rejected:this.rejectedEmitters.size});this.options.onPools?.(found.size);}
    return found;
  }
  private async applyWindow(data:WindowData) {
      const {from,to,head,scope,blocks}=data;
      const knownTokens=new Map<string,TokenMetadata>(scope.tokenRows.map(r=>[hex(r.address),{...r,totalSupply:r.total_supply==null?null:BigInt(r.total_supply),supplyBlock:r.supply_block==null?null:BigInt(r.supply_block)}]));
      const storedHashes=new Map((await this.db.sql.query<{number:string;hash:Uint8Array}>('SELECT number,hash FROM chain_blocks WHERE number BETWEEN $1 AND $2',[(from-1n).toString(),to.toString()])).rows.map(r=>[BigInt(r.number),hex(r.hash)]));
      let newest: Hex | null = null;
      const entries=[...blocks];
      const batchSize=this.commitRange;
      // Two stages: enrichment and preparation of the next batch run while the previous batch commits. Commits stay in
      // order (each waits for the one before), and preparation reads no rows the pending commit writes: the window scope,
      // the batch's staged tokens/pools and the decoder's in-memory state carry them, exactly as between committed batches.
      let writing:Promise<void>|undefined;
      try {
        for (let offset=0;offset<entries.length;offset+=batchSize) {
          const staged=await this.prepareBatch(entries.slice(offset,offset+batchSize),data,knownTokens,storedHashes);
          if(writing){const previous=writing;writing=undefined;await previous;}
          // A stop never commits a batch prepared after it; the decoder forgets what that batch staged in memory.
          if(!staged||this.stopping||this.client.rpcStopped?.()){this.decoder.invalidate();return;}
          if(staged.newest)newest=staged.newest;
          // A larger fetch still commits bounded prefixes. Never skip uncommitted suffixes.
          const covered=offset+batchSize>=entries.length?to:BigInt(staged.last!.number);
          writing=this.commitBatch(staged,covered);
          if(this.options.overlapWrites===false){const previous=writing;writing=undefined;await previous;}
        }
        if(writing){const previous=writing;writing=undefined;await previous;}
      } catch(error) {
        // Drain an in-flight commit before invalidating caches or retrying the window.
        if(writing)await writing.catch(()=>{});
        this.decoder.invalidate();throw error;
      }
      if(!entries.length){await this.db.setCursor('head_logs',to,null);this.options.onProgress?.(to);}
      this.caughtUp=head-to<=BigInt(this.maxRange);
      this.decoder.metrics.observeLogs(newest, head - to);
  }
  /** Validate, enrich and prepare one commit batch in block order; undefined when the follower is stopping. */
  private async prepareBatch(slice:[bigint,RpcLog[]][],data:WindowData,knownTokens:Map<string,TokenMetadata>,storedHashes:Map<bigint,Hex>):Promise<StagedBatch|undefined> {
        const {scope,candidates,hashes,headers,receiptsByBlock,discoveredPools,deepLinks}=data;
        const registry=this.decoder.registry;
        const batch=new BlockRows(), states:Prepared[]=[], dates:Date[]=[], pending:Pick<Prepared,'tokens'|'pools'>={tokens:new Map(),pools:new Map()};
        let last:RpcBlock|null=null, newest:Hex|null=null;
        const contexts=slice.map(([n,logs])=>{
          const first = logs[0];
          if (logs.some(l => lower(l.blockHash) !== lower(first.blockHash))) throw new ReorgDuringTick('Inconsistent block logs');
          const storedHash = storedHashes.get(n);
          if (storedHash && storedHash !== lower(first.blockHash)) throw new ReorgDuringTick('Stored block hash mismatch');
          const all = receiptsByBlock.get(n);
          let receipts: RpcReceipt[];
          if (all) {
            if (new Set(all.map(r => lower(r.transactionHash))).size !== all.length || all.some(r => r.logs.some(l => l.removed || lower(l.blockHash) !== lower(first.blockHash) || BigInt(l.blockNumber) !== n || lower(l.transactionHash) !== lower(r.transactionHash)) || BigInt(r.blockNumber) !== n || lower(r.blockHash) !== lower(first.blockHash) || !r.from || !('to' in r))) throw new ReorgDuringTick('Inconsistent receipts');
            const observed = new Map(all.flatMap(r => r.logs).map(l => [identity(l), l]));
            for (const l of logs) { const r = observed.get(identity(l)); if (!r || r.removed || lower(r.blockHash) !== lower(l.blockHash) || r.data !== l.data || lower(r.address) !== lower(l.address) || r.topics.join() !== l.topics.join()) throw new ReorgDuringTick('Log missing from canonical receipts'); }
            receipts = all;
          } else {
            receipts = [...new Set(logs.map(l => lower(l.transactionHash)))].map(hash => ({ transactionHash: hash, blockHash: first.blockHash, blockNumber: first.blockNumber, logs: logs.filter(l => lower(l.transactionHash) === hash), from: native, to: null, synthetic:true }));
          }
          const times=[...logs,...(all?.flatMap(r=>r.logs)??[])].flatMap(l=>l.blockTimestamp && BigInt(l.blockTimestamp)>0n ? [BigInt(l.blockTimestamp)] : []);
          if (new Set(times).size>1) throw new ReorgDuringTick('Conflicting block timestamps');
          let timestamp=times[0] == null ? null : toHex(times[0]);
          let parentHash=hashes.get(n-1n) ?? storedHashes.get(n-1n);
          // A skipped deep link with a known timestamp needs no header; '0x' marks the link as not recorded.
          if (!parentHash && timestamp && deepLinks.has(n) && !headers.has(n)) parentHash='0x';
          if (!timestamp || !parentHash) {
            const header=headers.get(n);
            if(!header)throw new Error('Missing validated block header');
            if (BigInt(header.number)!==n || lower(header.hash)!==lower(first.blockHash) || BigInt(header.timestamp)<=0n) throw new ReorgDuringTick('Invalid timestamp/header');
            if (timestamp && BigInt(timestamp)!==BigInt(header.timestamp)) throw new ReorgDuringTick('Timestamp/header mismatch');
            timestamp=header.timestamp; parentHash=header.parentHash;
          }
          const block: RpcBlock = { number: first.blockNumber, hash: first.blockHash, parentHash, timestamp, transactionsComplete:false, transactions: receipts.map(r => ({ hash: r.transactionHash, from: r.from!, to: r.to!, type: r.type, transactionIndex:r.transactionIndex })) };
          const keys = new Set(logs.map(identity));
          const contextReceipts = receipts.map(r => ({ ...r, logs: r.logs.filter(l => keys.has(identity(l)) || userOpTopics.includes(l.topics[0])) }));
          return {n,logs,receipts,block,keys,contextReceipts,scope:this.decoder.scopeForBlock(scope,contextReceipts.flatMap(r=>r.logs)).scope};
        });
        const barrier=(ctx:typeof contexts[number])=>ctx.receipts.some(r=>r.type!=null&&BigInt(r.type)===4n)
          || ctx.logs.some(l=>l.topics[0]===poolCreatedTopic || decodePonsResult(l,{from:native,to:null},{registry,tokenForCurve:()=>null}).events.some(e=>e.kind==='launch')
            || decodePoolEvents(l,{registry}).events.some(e=>e.source==='uniswap_v4'&&e.eventName==='Initialize'));
        for(let start=0;start<contexts.length;) {
          // Creation and SetCode blocks are ordered barriers: later prefetch must see
          // committed metadata and the new delegation code, never an earlier cache entry.
          let end=start+1;
          if(!barrier(contexts[start]))while(end<contexts.length&&end-start<this.rpc.limit&&!barrier(contexts[end]))end++;
          if(this.stopping||this.client.rpcStopped?.())return undefined;
          const enrichmentBegan=performance.now();
          this.timings.enrichmentConcurrency=Math.max(this.timings.enrichmentConcurrency,end-start);
          const reads=await this.remote(()=>Promise.allSettled(contexts.slice(start,end).map(ctx=>this.decoder.prefetch(ctx.block,ctx.contextReceipts,{head:true,codeCacheSec:this.options.codeCacheSec,knownTokens,discoveredPools,scope:ctx.scope}))));
          this.timings.enrichmentMs+=performance.now()-enrichmentBegan;
          const failed=reads.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
          for(let i=start;i<end;i++) {
            if(this.stopping||this.client.rpcStopped?.())return undefined;
            const {n,logs,receipts,block,keys,contextReceipts}=contexts[i];
            dates.push(new Date(Number(BigInt(block.timestamp))*1000));
            const read=reads[i-start];if(read.status!=='fulfilled')throw new Error('Missing enrichment');
            const remote=read.value;
            const prepareBegan=performance.now();
            const scoped=this.decoder.scopeForBlock(scope,contextReceipts.flatMap(r=>r.logs),pending);
            const prepared = await this.decoder.prepare(this.db, block, contextReceipts, { remote,pending:scoped.pending,scope:scoped.scope,tokenRows:scoped.scope.tokenRows,poolRows:scoped.scope.poolRows });
            const filtered = receipts.map(r => ({ ...r, logs: r.logs.filter(l => keys.has(identity(l))) }));
            for(const r of filtered)for(const l of r.logs)if(v3PoolTopics.has(l.topics[0])&&!prepared.pools.has(lower(l.address))&&lower(l.address)!==lower(registry.requireAddress('uniswapV4.poolManager'))){const hints=candidates.filter(t=>lower(t.transactionHash)===lower(l.transactionHash)&&t.topics[0]===transferTopic&&t.topics.slice(1,3).some(a=>lower(`0x${a.slice(-40)}`)===lower(l.address))).map(t=>lower(t.address));(l as RpcLog&{currencyHints?:string[]}).currencyHints=[...new Set(hints)];}
            batch.add('chain_blocks',{ number:n.toString(),block:n.toString(),hash:binary(block.hash),parent_hash:block.parentHash==='0x'?null:binary(block.parentHash),ts:new Date(Number(BigInt(block.timestamp))*1000) });
            // Candidate logs include every Transfer of the indexed tokens, so a transaction's own logs can name its traders.
            batch.merge(this.decoder.collect(block,filtered,prepared,{transfers:true}));
            for (const [id,pool] of prepared.pools) pending.pools.set(id,{...pool,currency0:lower(pool.currency0) as Address,currency1:lower(pool.currency1) as Address,...(pool.hooks?{hooks:lower(pool.hooks) as Address}:{})});
            for (const [id,token] of prepared.tokens) pending.tokens.set(id,{...token,address:lower(token.address) as Address,curve:token.curve?lower(token.curve) as Address:null});
            states.push(prepared); last=block;
            this.decoder.committed(prepared);
            for (const [address, token] of prepared.tokens) knownTokens.set(address, token);
            newest = block.timestamp;
            this.timings.prepareMs+=performance.now()-prepareBegan;
          }
          start=end;
        }
        return {batch,states,dates,last,newest};
  }
  /** Commit one prepared batch and both cursors in one transaction. */
  private async commitBatch(staged:StagedBatch,covered:bigint) {
        const {batch,states,dates,last}=staged;
        const writeBegan=performance.now();
        try {
          for(const date of dates) await this.db.ensurePartitions(date);
          await this.db.tx(async tx=>{
            await batch.flush(tx,this.timings.flush);
            // This live batch includes the launch's mint and all tracked Transfer logs from that boundary.
            const launchTokens=(batch.get('pons_events') ?? []).filter(row=>row.kind==='launch').map(row=>row.token);
            if(launchTokens.length)await tx.sql.query(`INSERT INTO token_balance_origins(token,block,block_hash)
              SELECT e.token,e.block,c.hash FROM pons_events e JOIN chain_blocks c ON c.number=e.block
              WHERE e.kind='launch' AND e.token=ANY($1::bytea[]) AND EXISTS (
                SELECT 1 FROM token_transfers t WHERE t.token=e.token AND t.block=e.block AND t.from_address=decode(repeat('00',20),'hex'))
              ON CONFLICT(token) DO NOTHING`,[launchTokens]);
            await tx.setCursor('head_logs',covered,null);
            if(last) { const applied=await tx.cursor('head');if(applied==null||BigInt(last.number)>=applied)await tx.setCursor('head',BigInt(last.number),last.hash); }
          },{retry:true});
        } finally { this.timings.dbWriteMs+=performance.now()-writeBegan;this.timings.commits++; }
        this.options.onProgress?.(covered);
        this.decoder.metrics.blocks+=states.length;
  }
  /**
   * Require chain 4663, enable bounded look-ahead pipeline and poll until stop or RPC closure,
   * draining discarded work in finally. Indexer operator only; chain mismatch, session budget,
   * consistency/SQL failures reject rather than continuing on an unverified branch; provider
   * outages and a spent paid daily budget back off and retry (public lane) instead.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async run() {
    if (await this.client.chainId() !== 4663) throw new Error('RPC chain ID must be 4663');
    this.pipeline=true;
    let failures=0;
    try { while (!this.stopping && !this.client.rpcStopped?.()) {
      const began = Date.now();
      let delay:number;
      try {
        await this.tick(); failures=0;
        // Background work only while the head is followed closely; it gets what is left of the tick, and its own failures.
        if(this.options.afterTick&&this.caughtUp&&!this.stopping&&!this.client.rpcStopped?.()){
          try{await this.options.afterTick();}catch(error){this.logger('after_tick_failed',{error:safeError(error)});}
        }
        delay=Math.max(0, (this.options.tickMs ?? 1000) - (Date.now() - began));
      }
      catch (error) {
        // Providers that stay unavailable past the meter's own retry window (timeouts, 429/5xx,
        // malformed replies) back off here instead of halting the process. So does a spent paid
        // budget: public-capable reads already continue on the public lane, and a pinned archive
        // read the public lane cannot serve waits for the budget instead of ending the run.
        // Wrong chain, database, reorg-depth, session-budget and usage-store failures still end it.
        const budget=rpcStopReason(error)==='rpc_budget_exhausted';
        // The database chose this transaction as the victim of a deadlock, or could not serialize it: nothing was
        // committed (a batch and its cursors are one transaction), so the same window is read and written again. A
        // halt here restarted the whole process over a conflict another writer had already resolved by finishing
        // (2026-10-13: the scanner's wallet labels against the head's swap rows, 74 deadlocks in three days).
        const contention=lockContention(error);
        this.db.recordTransactionSkip(error);
        if (this.stopping || this.client.rpcStopped?.() || !(budget || contention || isTransientRpcUnavailable(error))) throw error;
        delay=contention ? 250 : backoffDelay(failures++, this.options.random, this.options.retryBaseMs ?? 1000, this.options.retryCapMs ?? 60_000);
        this.logger('head_retry', { reason: budget ? 'rpc_budget_exhausted' : contention ? 'database_lock_contention' : 'rpc_unavailable', ...(budget ? { lane: 'public' } : {}), attempt: failures, backoff_ms: Math.round(delay), error: safeError(error) });
      }
      if (this.stopping || this.client.rpcStopped?.()) break;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); this.wake = () => { clearTimeout(timer); resolve(); }; });
      this.wake = undefined;
    }} finally {await this.discardAhead();this.pipeline=false;}
  }
}
