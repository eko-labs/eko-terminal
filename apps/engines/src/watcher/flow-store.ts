import { watcherRefreshEnabled } from './control.js';
import { binary, hex, type ChainDb } from '@eko/db';
import type { Address } from 'viem';
import { walletLabelsAt, type WalletLabelRow } from '../registry-labels.js';
import { FP_MODEL } from './score.js';
import { flowMarker, measureFlow, type ClassifiedSwap, type CrewInput, type FlowLabel } from './flow.js';
export interface FlowOptions {
  modelVersion?:string;
  crewAt?:(address:Address,block:bigint)=>Promise<CrewInput>;
  /** Only an upstream finalized, completely ingested cut may supply public aggregates. */
  finalized?:{status:'unavailable'}|{status:'available';block:number};
}
interface Row {tx_hash:Uint8Array;log_index:number;coin:Uint8Array;trader:Uint8Array|null;block:string;ts:Date;side:number;usd:number|null;priced_block:string|null;senders_pending:boolean;pricing_pending:boolean;block_hash:Uint8Array}
function labelInput(r:WalletLabelRow|undefined,model:string):FlowLabel|null {
  if(!r)return null;
  // Permissionless declarations have their own generation; behavioral labels must match this model.
  if(r.label!=='declared_agent'&&r.source==='fingerprint'&&r.model_version!==model&&!r.model_version.startsWith(model+':correction:'))return null;
  return {label:r.label,confidence:r.confidence,tier:r.tier,crewId:r.crew_id??undefined,unclassified:r.features.unclassified===true};
}
async function classify(db:ChainDb,rows:Row[],block:number,options:FlowOptions) {
  const model=options.modelVersion??FP_MODEL.version;
  const addresses=[...new Set(rows.filter(r=>r.trader&&!r.senders_pending).map(r=>hex(r.trader!) as Address))];
  const labels=new Map((await walletLabelsAt(db,addresses,BigInt(block))).map(r=>[hex(r.address),r]));
  const crews=new Map<Address,CrewInput>();
  for(const address of addresses)crews.set(address,await options.crewAt?.(address,BigInt(block))??{status:'unavailable'});
  return rows.map(r=>{
    const wallet=r.trader?hex(r.trader) as Address:null;
    return {id:`flow:${hex(r.tx_hash)}:${r.log_index}`,coin:hex(r.coin) as Address,block:Number(r.block),sec:new Date(r.ts).getTime()/1000,
      side:r.side===1?'buy':'sell',usd:r.usd,wallet,senderPending:r.senders_pending,pricePending:r.pricing_pending||(r.priced_block!=null&&Number(r.priced_block)>block),
      label:labelInput(wallet?labels.get(wallet):undefined,model),crew:wallet?crews.get(wallet)??{status:'unavailable'}:{status:'unavailable'}} as ClassifiedSwap;
  });
}
async function headerAt(db:ChainDb,block:number) {
  const h=(await db.sql.query<{ts:Date;hash:Uint8Array}>('SELECT ts,hash FROM chain_blocks WHERE number=$1',[block])).rows[0];
  if(!h)throw new Error('Canonical flow block unavailable');return h;
}
async function swapRows(db:ChainDb,block:number,from:Date,to:Date,coin?:Address) {
  return (await db.sql.query<Row>(`SELECT s.*,b.hash AS block_hash FROM watcher_read_swaps s JOIN chain_blocks b ON b.number=s.block
    WHERE s.block<=$1 AND s.ts>$2 AND s.ts<=$3 ${coin?'AND s.coin=$4':''} ORDER BY s.block,s.tx_hash,s.log_index`,[block,from,to,...(coin?[binary(coin)]:[])])).rows;
}
/** Watcher-only writes. API consumers read these projections without running classification. */
export async function refreshCoinFlow(db:ChainDb,coin:Address,block:number,options:FlowOptions={},fromSec?:number) {
  if(!watcherRefreshEnabled())return {swaps:0,block,modelVersion:options.modelVersion??FP_MODEL.version};
  return db.tx(async tx=>{
    // This lock serializes writers and source invalidations, without locking source rows.
    await tx.sql.query('LOCK TABLE flow_dirty IN EXCLUSIVE MODE');
    const h=await headerAt(tx,block),sec=new Date(h.ts).getTime()/1000,model=options.modelVersion??FP_MODEL.version;
    const dirty=(await tx.sql.query<{from_sec:number}>('SELECT from_sec FROM flow_dirty WHERE coin=$1',[binary(coin)])).rows[0];
    const startSec=Math.min(fromSec??sec-86400,dirty?dirty.from_sec-0.001:Infinity);
    const rows=await swapRows(tx,block,new Date(startSec*1000),h.ts,coin);
    const classified=await classify(tx,rows,block,options);
    await tx.sql.query('INSERT INTO watcher_flow_model VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET model_version=excluded.model_version',[model]);
    for(const window of ['5m','1h','24h'] as const) {
      const measurement=measureFlow(classified,window,block,sec,model);
      await tx.sql.query(`INSERT INTO flow_windows(coin,window_kind,block,block_hash,as_of,model_version,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(coin,window_kind) DO UPDATE SET block=excluded.block,block_hash=excluded.block_hash,as_of=excluded.as_of,model_version=excluded.model_version,data=excluded.data,updated_at=now()`,[binary(coin),window,block,h.hash,h.ts,model,measurement.data]);
    }
    // Retain historical marker cuts. Rebuild the requested interval for corrections and enrichment.
    await tx.sql.query('DELETE FROM flow_events WHERE coin=$1 AND (block>$2 OR (ts>$3 AND ts<=$4))',[binary(coin),block,new Date(startSec*1000),h.ts]);
    const byBlock=new Map<number,Row[]>();for(const row of rows){const group=byBlock.get(Number(row.block))??[];group.push(row);byBlock.set(Number(row.block),group);}
    for(const [cut,group] of byBlock) {
      const atCut=await classify(tx,group,cut,options);
      for(let i=0;i<atCut.length;i++) {
        const event=flowMarker(atCut[i],model);if(!event)continue;
        const row=group[i];
        await tx.sql.query('INSERT INTO flow_events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET block=excluded.block,block_hash=excluded.block_hash,ts=excluded.ts,model_version=excluded.model_version,data=excluded.data',
          [atCut[i].id,binary(coin),row.tx_hash,row.log_index,cut,row.block_hash,row.ts,model,event]);
      }
    }
    await tx.sql.query('DELETE FROM flow_dirty WHERE coin=$1',[binary(coin)]);
    await tx.notify('flow_updated',{coin,block});
    return {swaps:rows.length,block,modelVersion:model};
  });
}
/**
 * Refresh a bounded set of stale/dirty coin flows at a supplied canonical block, then attempt
 * finalized Census refresh. Missing header returns zero coins; invalid bounds/storage failures
 * reject. Host watcher supplies model/crew/finality evidence; no provider client is created.
 */
export async function refreshFlows(db:ChainDb,block:number,options:FlowOptions&{coinLimit?:number}={}) {
  if(!watcherRefreshEnabled())return {coins:0};
  const h=(await db.sql.query<{ts:Date}>('SELECT ts FROM chain_blocks WHERE number=$1',[block])).rows[0];if(!h)return {coins:0};
  const limit=options.coinLimit??16;if(!Number.isInteger(limit)||limit<1||limit>256)throw new Error('Invalid flow coin bound');
  const rows=(await db.sql.query<{coin:Uint8Array}>(`WITH coins AS (SELECT DISTINCT coin FROM swaps WHERE block<=$1 AND ts>$2 UNION SELECT coin FROM flow_windows)
    SELECT c.coin FROM coins c LEFT JOIN flow_windows f ON f.coin=c.coin AND f.window_kind='1h' LEFT JOIN flow_dirty d ON d.coin=c.coin
    WHERE (d.coin IS NOT NULL OR f.block IS DISTINCT FROM $1::bigint OR f.model_version IS DISTINCT FROM $3)
    AND (f.updated_at IS NULL OR f.updated_at<=now()-interval '1 second')
    ORDER BY f.as_of NULLS FIRST,c.coin LIMIT $4`,[block,new Date(new Date(h.ts).getTime()-86400000),options.modelVersion??FP_MODEL.version,limit])).rows;
  for(const row of rows)await refreshCoinFlow(db,hex(row.coin) as Address,block,options);
  await refreshCensus(db,options);
  return {coins:rows.length};
}
/**
 * Require an upstream finalized complete-ingest cut, classify its persisted swaps and atomically
 * retain complete 24-hour/seven-day aggregates under the dirty-flow lock. Missing finality or
 * incomplete flow returns unavailable; absent canonical header/storage failures reject. This does
 * not bypass the public precision gate.
 */
export async function refreshCensus(db:ChainDb,options:FlowOptions={}) {
  if(!watcherRefreshEnabled())return {status:'unavailable' as const};
  // TODO(spec): No persisted finalized-tag/complete-ingest certificate exists here. Require an upstream typed cut; never substitute head.
  if(options.finalized?.status!=='available')return {status:'unavailable' as const};
  const block=options.finalized.block,model=options.modelVersion??FP_MODEL.version;
  return db.tx(async tx=>{
    await tx.sql.query('LOCK TABLE flow_dirty IN EXCLUSIVE MODE');
    const h=await headerAt(tx,block),sec=new Date(h.ts).getTime()/1000;
    const rows=await swapRows(tx,block,new Date((sec-7*86400)*1000),h.ts);
    const classified=await classify(tx,rows,block,options),chain=[];
    for(const [window,duration] of [['24h',86400],['7d',7*86400]] as const) {
      // Census includes likely labels only at high/medium confidence.
      const eligible=classified.map(s=>s.label?.label==='likely_agent'&&(s.label.tier==null||s.label.tier==='low')?{...s,label:null}:s);
      const flow=measureFlow(eligible,'24h',block,sec,model,duration).data;
      if(flow.meta?.unavailable){await tx.sql.query('DELETE FROM census_snapshots WHERE model_version=$1',[model]);return {status:'unavailable' as const};}
      chain.push({window,agentPct:flow.agentPct,crewPct:flow.crewPct,humanPct:flow.humanPct,asOfBlock:block});
    }
    await tx.sql.query(`INSERT INTO census_snapshots VALUES($1,$2,$3,$4,$5) ON CONFLICT(model_version) DO UPDATE SET block=excluded.block,block_hash=excluded.block_hash,as_of=excluded.as_of,data=excluded.data`,[model,block,h.hash,h.ts,{chain}]);
    return {status:'available' as const};
  });
}
