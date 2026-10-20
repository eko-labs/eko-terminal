import { binary, flowModel, censusGate } from '@eko/db';
import { FeedItemSchema, type Address, type FeedItem } from '@eko/shared';
import { InputError } from '../http/v1/helpers.js';
import { toUntrusted } from '@eko/untrusted';
import type { ReadStore } from './store.js';
import { decodeCursor, encodeCursor } from './pagination.js';
/** How long the API process reuses the feed's whole-database inputs (flow model, Census gate, agent-trade availability). */
export const FEED_SHARED_TTL_MS=30_000;
/** A trade this large on a Radar coin is a Feed row (about 280 an hour on 2026-10-12, against 56,000 swaps in all). */
export const FEED_TRADE_MIN_USD=500;
/** Trades are read from the swaps of the last hour only: the Feed keeps the latest 500 rows, which is minutes of them. */
export const FEED_TRADE_WINDOW_MS=3_600_000;
export class FeedService {
  constructor(readonly store:ReadStore) {}
  private cachedShared?:{at:number;value:Promise<{model:string;gate:Awaited<ReturnType<typeof censusGate>>;measured:boolean}>};
  /**
   * The flow model, the Census gate and agent-trade availability describe the whole database, not one coin or page.
   * Live pushes read a coin's feed for every refreshed coin and engine event, so on 2026-10-10 the availability query
   * (a parallel scan of flow_windows) ran continuously and held most of the new host's four cores, slowing the scanner.
   * With the background refresher they are read at most every 30 s; without it (tests, tools) on every call.
   */
  private shared() {
    const now=this.store.now();
    if(!this.store.background || !this.cachedShared || now-this.cachedShared.at>=FEED_SHARED_TTL_MS) {
      const value=this.computeShared();
      this.cachedShared={at:now,value};
      value.catch(()=>{if(this.cachedShared?.value===value)this.cachedShared=undefined;});
    }
    return this.cachedShared.value;
  }
  private async computeShared() {
    const model=await flowModel(this.store.db),gate=await censusGate(this.store.db,model);
    const measured=(await this.store.db.sql.query<{available:boolean}>(`SELECT EXISTS(SELECT 1 FROM flow_windows f JOIN chain_blocks b ON b.number=f.block AND b.hash=f.block_hash WHERE f.model_version=$1 AND NOT EXISTS(SELECT 1 FROM flow_dirty d WHERE d.coin=f.coin) AND NOT coalesce((f.data->'meta'->>'unavailable')::boolean,true)) AND NOT EXISTS(SELECT 1 FROM flow_dirty) AND NOT EXISTS(SELECT 1 FROM flow_windows f WHERE f.window_kind='1h' AND (f.model_version<>$1 OR coalesce((f.data->'meta'->>'unavailable')::boolean,true))) AS available`,[model])).rows[0].available;
    return {model,gate,measured};
  }
  private async page(kinds?:FeedItem['kind'][],coin?:Address,block?:number,cursor?:string) {
    await this.store.currentModels();
    const scope=`feed:${[...(kinds ?? [])].sort().join(',')}`,key=decodeCursor(cursor,scope);
    if(key && (key.length!==2 || !Number.isSafeInteger(key[0]) || typeof key[1]!=='string'))throw new InputError('Invalid feed cursor');
    const {model,gate,measured}=await this.shared();
    // Large trades on Radar coins in the last hour, by any wallet: the buyer is the wallet that received the coins.
    const params:unknown[]=[model,FEED_TRADE_MIN_USD,new Date(this.store.now()-FEED_TRADE_WINDOW_MS)],where:string[]=[];
    // A new pool for a token with no indexed name that is not on the Radar is left out: about 3,800 a day on
    // 2026-10-12 (Uniswap pools of tokens EKO does not price or rate yet), each a bare address leading to an empty page.
    const sources=[`SELECT * FROM read_feed f WHERE NOT (f.kind='new_pair' AND coalesce(f.symbol,'')='' AND NOT EXISTS(SELECT 1 FROM read_coins r WHERE r.coin=f.coin))`, `SELECT 'trade:'||encode(s.tx_hash,'hex')||':'||s.log_index AS id,s.coin,s.block,'trade' AS kind,
      jsonb_build_object('sizeUsd',s.usd,'side',CASE WHEN s.side=1 THEN 'buy' ELSE 'sell' END,'wallet','0x'||encode(coalesce(CASE WHEN s.side=1 THEN s.recipient END,s.trader),'hex')) AS data,
      NULL::text AS verdict_id,t.first_block,t.symbol
      FROM swaps s JOIN read_coins r ON r.coin=s.coin JOIN tokens t ON t.address=s.coin
      WHERE s.usd>=500 AND s.usd>=$2 AND s.ts>$3 AND coalesce(CASE WHEN s.side=1 THEN s.recipient END,s.trader) IS NOT NULL`, `SELECT e.id,e.coin,e.block,
      CASE WHEN e.data->>'label'='crew' THEN 'crew_trade' ELSE 'agent_trade' END AS kind,e.data,NULL::text AS verdict_id,t.first_block,t.symbol
      FROM flow_events e JOIN tokens t ON t.address=e.coin JOIN chain_blocks b ON b.number=e.block AND b.hash=e.block_hash
      WHERE e.model_version=$1 AND e.data->>'label' IN ('declared_agent','likely_agent','crew') AND NOT EXISTS(SELECT 1 FROM flow_dirty d WHERE d.coin=e.coin) `];
    const bind=(v:unknown)=>{params.push(v);return `$${params.length}`;};
    if(coin)where.push(`coin=${bind(binary(coin))}`);
    if(block!=null)where.push(`block=${bind(block)}`);
    if(key)where.push(`(block,id)<(${bind(key[0])},${bind(key[1])})`);
    // Top 101 from each ordered source suffice for the exact top 101 of their union. Apply every filter before LIMIT.
    const branches=(kind?:FeedItem['kind'])=>{
      const conditions=[...where];if(kind)conditions.push(`kind=${bind(kind)}`);
      return sources.map(source=>`(SELECT * FROM (${source}) feed_source ${conditions.length ? 'WHERE '+conditions.join(' AND ') : ''} ORDER BY block DESC,id DESC LIMIT 101)`);
    };
    const candidates=kinds?.length ? [...new Set(kinds)].flatMap(kind=>branches(kind)) : branches();
    const page=`SELECT * FROM (${candidates.join(' UNION ALL ')}) candidates ORDER BY block DESC,id DESC LIMIT 101`;
    // Chain block and id form an immutable chronological cursor. Enrichment is bounded to 101 events.
    const result=await this.store.db.sql.query<{id:string;coin:Uint8Array;symbol:string;block:string;kind:FeedItem['kind'];data:Record<string,unknown>;first_block:string|null}>(page,params);
    const coins=result.rows.map(r=>r.coin);
    const firstVerdicts=coins.length ? (await this.store.db.sql.query<{coin:Uint8Array;block:string}>('SELECT coin,block FROM read_first_verdict WHERE coin=ANY($1::bytea[])',[coins])).rows : [];
    const verdictBlocks=new Map(firstVerdicts.map(r=>[Buffer.from(r.coin).toString('hex'),Number(r.block)]));
    const blocks=[...new Set([...result.rows.flatMap(r=>r.first_block==null ? [Number(r.block)] : [Number(r.block),Number(r.first_block)]),...verdictBlocks.values()])];
    const clocks=blocks.length ? (await this.store.db.sql.query<{number:string;ts:Date}>(`SELECT number,ts FROM engine_block_times WHERE number=ANY($1::bigint[])
      UNION ALL SELECT number,ts FROM chain_blocks WHERE number=ANY($1::bigint[])`,[blocks])).rows : [];
    // Engine clocks take precedence. Explicit block keys keep the planner off the complete header history.
    const timestamps=new Map<number,Date>();
    for(const clock of clocks)if(!timestamps.has(Number(clock.number)))timestamps.set(Number(clock.number),clock.ts);
    const enriched=result.rows.map(r=>({...r,ts:timestamps.get(Number(r.block)),first_ts:r.first_block==null ? undefined : timestamps.get(Number(r.first_block)),first_verdict_ts:timestamps.get(verdictBlocks.get(Buffer.from(r.coin).toString('hex')) ?? -1)}));
    const rows:FeedItem[]=enriched.slice(0,100).filter(r=>r.ts).map(r=>FeedItemSchema.parse({id:r.id,coin:`0x${Buffer.from(r.coin).toString('hex')}`,symbol:toUntrusted(r.symbol ?? '',32),
      priceMove:r.data.priceMove,guardV2:r.data.guardV2,guardFactorId:r.data.guardFactorId,guardReasonCode:r.data.guardReasonCode,guardReason:r.data.guardReason,
      label:r.data.label,sizeUsd:r.data.sizeUsd,wallet:r.data.wallet,crewId:r.data.crewId,side:r.data.side,modelVersion:r.data.modelVersion,
      beta:r.data.modelVersion ? gate.value==null||gate.value<gate.threshold : undefined,confidence:r.data.confidence,
      block:Number(r.block),ts:new Date(r.ts!).getTime(),kind:r.kind,level:r.data.level==='pending' ? undefined : r.data.level,
      playbookId:r.kind==='playbook' || r.kind==='wash' ? r.data.id : undefined,
      matchPct:typeof r.data.confidence==='number' ? r.data.confidence*100 : undefined,
      firstVerdictMs:r.kind==='verdict' && r.first_ts && r.first_verdict_ts ? Math.max(0,new Date(r.first_verdict_ts).getTime()-new Date(r.first_ts).getTime()) : undefined}));
    const last=result.rows[99];
    return {rows,cursor:result.rows.length>100 ? encodeCursor(scope,[Number(last.block),last.id]) : null,delayedSec:0,unavailable:[...(!measured?['agent_trade','crew_trade']:[]),'clone','swarm','burn']};
  }
  async all(kinds?:FeedItem['kind'][],coin?:Address,block?:number) {return (await this.page(kinds,coin,block)).rows;}
  list(kinds?:FeedItem['kind'][],cursor?:string) {return this.page(kinds,undefined,undefined,cursor);}
}
