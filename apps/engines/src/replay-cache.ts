import { swapPages } from './swap-reader.js';
import { binary, hex, type ChainDb } from '@eko/db';
import { RULES_VERSION, type CardSources, type HistoryView, type PriorLaunch } from '@eko/playbooks';
import type { Address, CoinSignal, PlaybookMatch, Verdict } from '@eko/shared';
import type { ClockCache } from './activity.js';
import { curveProgress, type ProgressPoint, type PonsEventRow } from './curve-progress.js';
import { MarketWindow, liveRanks } from './market.js';
import { loadRegistry } from '@eko/chain';
import { rowHex, prepareSwap, prepareHolding, HolderAggregate, TradeAggregate, type TradeView } from './aggregates.js';
import type { EventRow, Holding, PoolRow, SwapRow, TokenRow } from './sources.js';

export function upperBlock<T extends {block:string}>(rows:T[],block:number) {
  let low=0,high=rows.length;while(low<high){const mid=(low+high)>>>1;if(Number(rows[mid].block)<=block)low=mid+1;else high=mid;}return low;
}
class Lru<K,V> {
  private values=new Map<K,Promise<V>>();
  constructor(private limit=256) {}
  get(key:K,read:()=>Promise<V>) {const found=this.values.get(key);if(found){this.values.delete(key);this.values.set(key,found);return found;}
    const value=read().catch(error=>{this.values.delete(key);throw error;});this.values.set(key,value);
    if(this.values.size>this.limit)this.values.delete(this.values.keys().next().value!);return value;}
}
interface Transfer { fromHex?:Address;toHex?:Address;block:string;from_address:Uint8Array;to_address:Uint8Array;amount:string;kind:string }
interface Rows { progress:ProgressPoint[];nonCurveSwaps:SwapRow[];swaps:SwapRow[];pools:PoolRow[];events:EventRow[];transfers:Transfer[];lastTransfer:number;balances:Holding[];exemptions:Exemption[];baselines:Baseline[] }
/** Net movement of compacted transfers (retention); replay is exact only at or after its block. */
interface Baseline { holderHex:Address;amount:string;block:number }
export interface Exemption {wallet:Uint8Array;block:string;tx_hash:Uint8Array;log_index:number}
export interface WriteState {
  prior?:{id:string;signature:string;data:Verdict};
  previous?:{id:string;hash:string};
  signal?:CoinSignal;
}
interface Outcome { horizon:'1h'|'24h'|'7d';valid_from_block:string;outcome:PriorLaunch['outcomes'][number]['outcome'];data:{evidence:PriorLaunch['evidence']} }
/** Scoped to a finished canonical replay range; nothing from beyond an evaluation block is exposed. */
export class ReplayCache {
  tokens=new Map<Address,TokenRow>();
  runs=new Set<string>();
  writes=new Map<Address,WriteState>();
  private rows=new Map<Address,Promise<Rows>>();
  private trends=new Map<number,Promise<NonNullable<CardSources['trending']>>>();
  private market:MarketWindow|undefined;
  private ranks=new Lru<number,Map<Address,number>>();
  private histories=new Map<Address,{block:number;data:PriorLaunch}[]>();
  private matches=new Map<Address,{block:string;id:PlaybookMatch['id'];level:PlaybookMatch['level']}[]>();
  private outcomes=new Map<Address,Outcome[]>();
  outcomeAttempts=new Set<string>();
  private holders=new Map<string,{block:number;cursor:number;aggregate:HolderAggregate}>();
  private trades=new Map<Address,TradeAggregate>();
  /** Every stored block time, by number (initialize): horizon and prior-block searches go by time. */
  clockPoints:{number:number;sec:number}[]=[];
  constructor(readonly db:ChainDb,readonly to:number,readonly clock:ClockCache,readonly marketWindow=true) {}
  /** Restore only state derived from transaction writes; source aggregates are rebuilt after rollback. */
  checkpoint() {
    const runs=new Set(this.runs),writes=new Map([...this.writes].map(([k,v])=>[k,{...v}])),
      histories=new Map([...this.histories].map(([k,v])=>[k,[...v]])),matches=new Map([...this.matches].map(([k,v])=>[k,[...v]])),
      outcomes=new Map([...this.outcomes].map(([k,v])=>[k,[...v]])),attempts=new Set(this.outcomeAttempts);
    return ()=>{
      this.runs=runs;this.writes=writes;this.histories=histories;this.matches=matches;
      this.outcomes=outcomes;this.outcomeAttempts=attempts;this.holders.clear();this.trades.clear();
    };
  }
  async initialize() {
    // The shared clock cache is filled lazily (refreshClock), so it cannot be searched by time. Read every stored time
    // once; a time the cache already holds wins, and launch-time lookups by block (outcomes.ts) find every block here.
    for(const row of (await this.db.sql.query<{number:string;ts:Date;hash:Uint8Array|null}>('SELECT number,ts,hash FROM engine_block_times ORDER BY number')).rows){
      const number=Number(row.number),cached=this.clock.get(number);
      if(!cached)this.clock.set(number,{ts:row.ts,hash:row.hash});
      this.clockPoints.push({number,sec:new Date((cached ?? row).ts).getTime()/1000});
    }
    if(this.marketWindow){const market=(await this.db.sql.query<{coin:Uint8Array;block:string;sec:number;usd:number}>(`SELECT coin,block,extract(epoch FROM ts)::double precision AS sec,usd FROM raw_history_live_swaps WHERE block<=$1 AND usd>0 AND usd<'Infinity'::double precision ORDER BY block,ts,tx_hash,log_index`,[this.to])).rows;
    this.market=new MarketWindow(market.map(row=>({coin:rowHex(row.coin),block:Number(row.block),sec:row.sec,usd:row.usd})));}
    for(const t of (await this.db.sql.query<TokenRow>('SELECT * FROM tokens WHERE first_block<=$1',[this.to])).rows){rowHex(t.address);if(t.deployer)rowHex(t.deployer);if(t.curve)rowHex(t.curve);if(t.graduated_pool)rowHex(t.graduated_pool);this.tokens.set(rowHex(t.address),t);}
    for(const r of (await this.db.sql.query<{coin:Uint8Array;block:string}>('SELECT coin,block FROM engine_runs WHERE rules_version=$1 AND block<=$2',[RULES_VERSION,this.to])).rows)this.runs.add(`${hex(r.coin)}:${r.block}`);
    for(const r of (await this.db.sql.query<{deployer:Uint8Array;valid_from_block:string;data:PriorLaunch}>('SELECT deployer,valid_from_block,data FROM deployer_stats WHERE rules_version=$1 AND valid_from_block<=$2 ORDER BY valid_from_block,coin',[RULES_VERSION,this.to])).rows)this.recordHistory(hex(r.deployer),Number(r.valid_from_block),r.data);
    for(const r of (await this.db.sql.query<{coin:Uint8Array;block:string;id:PlaybookMatch['id'];level:PlaybookMatch['level']}>('SELECT coin,valid_from_block AS block,playbook_id AS id,data->>\'level\' AS level FROM playbook_matches WHERE rules_version=$1 AND valid_from_block<=$2 UNION ALL SELECT coin,first_block AS block,playbook_id AS id,level FROM coin_match_lifetime WHERE rules_version=$1 AND first_block<=$2 ORDER BY block,id',[RULES_VERSION,this.to])).rows)this.recordMatch(hex(r.coin),r.block,r);
    for(const r of (await this.db.sql.query<Outcome & {coin:Uint8Array}>('SELECT * FROM outcomes ORDER BY horizon')).rows)this.recordOutcome(hex(r.coin),r);
  }
  async coinRows(coin:Address):Promise<Rows> {
    const found=this.rows.get(coin);if(found)return found;
    const promise=(async()=>{
      const key=binary(coin),[swaps,pools,events,transfers,last,balances,pons,exemptions,baselines]=await Promise.all([
        swapPages(this.db,coin,this.to,-1,'replay').then(rows=>({rows})),
        this.db.sql.query<PoolRow>('SELECT * FROM pools WHERE (currency0=$1 OR currency1=$1) AND created_block<=$2 ORDER BY id',[key,this.to]),
        this.db.sql.query<EventRow>('SELECT e.* FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block<=$2 ORDER BY e.block,e.log_index,e.tx_hash',[key,this.to]),
        this.db.sql.query<Transfer>('SELECT block,from_address,to_address,amount,kind FROM raw_history_live_transfers WHERE token=$1 AND block<=$2 ORDER BY block,log_index,tx_hash',[key,this.to]),
        this.db.sql.query<{block:string|null}>('SELECT (SELECT block FROM raw_history_live_transfers WHERE token=$1 ORDER BY block DESC LIMIT 1) AS block',[key]),
        this.db.sql.query<Holding>('SELECT holder,amount,last_block AS block FROM balances WHERE token=$1 AND amount>0 ORDER BY holder',[key]),
        this.db.sql.query<PonsEventRow>("SELECT block,kind,data FROM pons_events WHERE token=$1 AND block<=$2 AND kind IN ('launch','trade') ORDER BY block,log_index,tx_hash",[key,this.to]),
        this.db.sql.query<Exemption>('SELECT * FROM pons_exemptions WHERE token=$1 AND block<=$2 ORDER BY wallet',[key,this.to]),
        this.db.sql.query<{holder:Uint8Array;amount:string;block:string}>('SELECT holder,amount::text,through_block::text AS block FROM transfer_baselines WHERE token=$1 AND through_block<=$2 ORDER BY holder',[key,this.to]),
      ]);
      for(const row of transfers.rows){row.fromHex=rowHex(row.from_address);row.toHex=rowHex(row.to_address);}
      for(const row of pools.rows){rowHex(row.id);rowHex(row.currency0);rowHex(row.currency1);if(row.hooks)rowHex(row.hooks);}
      for(const row of events.rows){if(row.actor!=null)rowHex(row.actor);rowHex(row.pool_id);rowHex(row.tx_hash);}
      for(const row of exemptions.rows){rowHex(row.wallet);rowHex(row.tx_hash);}
      const normalized=swaps.rows.map(prepareSwap);
      return {progress:curveProgress(pons.rows,Number(this.tokens.get(coin)!.first_block)),swaps:normalized,nonCurveSwaps:normalized.filter(r=>r.venue!=='pons_curve'),pools:pools.rows,events:events.rows,transfers:transfers.rows,lastTransfer:Number(last.rows[0].block ?? -1),balances:balances.rows.map(prepareHolding),exemptions:exemptions.rows,
        baselines:baselines.rows.map(row=>({holderHex:rowHex(row.holder) as Address,amount:row.amount,block:Number(row.block)}))};
    })();this.rows.set(coin,promise);return promise;
  }
  private holderState(coin:Address,rows:Rows,block:number,lane:string) {
    const key=`${coin}:${lane}`;let state=this.holders.get(key);const token=this.tokens.get(coin)!;
    if(!state || block<state.block){state={block:-1,cursor:0,aggregate:new HolderAggregate(coin,token.curve ? rowHex(token.curve) : undefined,loadRegistry().addressOf('ours.burnWallet')?.toLowerCase() as Address|undefined)};this.holders.set(key,state);
      for(const b of rows.baselines)state.aggregate.add(b.holderHex,BigInt(b.amount),b.block);}
    if(block>=rows.lastTransfer){
      if(state.cursor!==Infinity){state.aggregate=new HolderAggregate(coin,token.curve ? rowHex(token.curve) : undefined,loadRegistry().addressOf('ours.burnWallet')?.toLowerCase() as Address|undefined);for(const r of rows.balances)state.aggregate.set(r.holderHex!,BigInt(r.amount),Number(r.block));state.cursor=Infinity;}
    }else{
      const end=upperBlock(rows.transfers,block);
      for(let i=state.cursor;i<end;i++){const r=rows.transfers[i];if(r.kind!=='Transfer')continue;const amount=BigInt(r.amount);state.aggregate.add(r.toHex!,amount,Number(r.block));state.aggregate.add(r.fromHex!,-amount,Number(r.block));}state.cursor=end;
    }
    state.block=block;return state.aggregate;
  }
  materializeHoldings(coin:Address,rows:Rows,block:number){return this.holderState(coin,rows,block,'materialized').rows();}
  async holdingsAt(coin:Address,block:number,lane='now'):Promise<Holding[]> {const rows=await this.coinRows(coin);return this.holderState(coin,rows,block,lane).rows();}
  async holderViewAt(coin:Address,block:number,wallets:Address[],lane='now',skip:ReadonlySet<string>=new Set()) {
    const rows=await this.coinRows(coin),state=this.holderState(coin,rows,block,lane);
    return {count:state.count,top10:state.top10(),burned:state.burned,inventory:state.inventory,amounts:new Map(wallets.map(wallet=>[wallet,state.amount(wallet)])),top:state.top(12,wallet=>skip.has(wallet))};
  }
  async tradeAt(coin:Address,block:number,sec:number,exempt:Set<Address>):Promise<TradeView & {bought:number}> {
    const rows=await this.coinRows(coin);let state=this.trades.get(coin);const end=upperBlock(rows.swaps,block);
    if(!state || end<state.count){state=new TradeAggregate(rows.swaps);this.trades.set(coin,state);}
    const view=state.advance(end,sec);return {...view,bought:state.boughtFor(exempt)};
  }
  evict(coin:Address) {this.rows.delete(coin);this.trades.delete(coin);this.writes.delete(coin);for(const key of this.holders.keys())if(key.startsWith(`${coin}:`))this.holders.delete(key);}
  priorBlock(sec:number,block:number) {
    let low=0,high=this.clockPoints.length;while(low<high){const mid=(low+high)>>>1,p=this.clockPoints[mid];if(p.sec<=sec && p.number<=block)low=mid+1;else high=mid;}return this.clockPoints[low-1];
  }
  endBlock(sec:number,block:number) {
    let low=0,high=this.clockPoints.length;while(low<high){const mid=(low+high)>>>1;if(this.clockPoints[mid].sec<sec)low=mid+1;else high=mid;}const point=this.clockPoints[low];return point && point.number<=block ? point : undefined;
  }
  trending(block:number,read:()=>Promise<NonNullable<CardSources['trending']>>) {let found=this.trends.get(block);if(!found){found=read().catch(error=>{this.trends.delete(block);throw error;});this.trends.set(block,found);}return found;}
  ranked(block:number,sec:number) {return this.ranks.get(block,()=>this.market ? Promise.resolve(this.market.ranked(block,sec)) : liveRanks(this.db,block,sec));}
  recordHistory(deployer:Address,block:number,data:PriorLaunch) {const rows=this.histories.get(deployer) ?? [];const index=rows.findIndex(r=>r.block===block && r.data.coin===data.coin);if(index>=0)rows[index]={block,data};else rows.push({block,data});this.histories.set(deployer,rows);}
  historyAt(deployer:Address,coin:Address,block:number):HistoryView {
    const latest=new Map<Address,{block:number;data:PriorLaunch}>();for(const r of this.histories.get(deployer) ?? [])if(r.block<=block && r.data.coin!==coin && (!latest.has(r.data.coin) || latest.get(r.data.coin)!.block<=r.block))latest.set(r.data.coin,r);
    return {launches:[...latest].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,r])=>r.data)};
  }
  recordMatch(coin:Address,block:string,match:Pick<PlaybookMatch,'id'|'level'>) {const rows=this.matches.get(coin) ?? [];if(!rows.some(r=>r.block===block && r.id===match.id))rows.push({block,...match});this.matches.set(coin,rows);if(match.id==='honeypot' && match.level==='danger')for(const horizon of ['1h','24h','7d'])this.outcomeAttempts.delete(`${coin}:${horizon}`);}
  matchesAt(coin:Address,block:number) {return (this.matches.get(coin) ?? []).filter(r=>Number(r.block)<=block).sort((a,b)=>Number(a.block)-Number(b.block) || a.id.localeCompare(b.id));}
  outcomesAt(coin:Address,block:number) {return (this.outcomes.get(coin) ?? []).filter(r=>Number(r.valid_from_block)<=block).sort((a,b)=>a.horizon.localeCompare(b.horizon));}
  recordOutcome(coin:Address,row:Outcome) {const rows=this.outcomes.get(coin) ?? [];if(!rows.some(r=>r.horizon===row.horizon))rows.push(row);this.outcomes.set(coin,rows);}
}
