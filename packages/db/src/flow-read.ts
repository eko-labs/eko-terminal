import { censusGateAccepted, CensusSchema, FlowSchema, ChartMarkerSchema, type Address, type Flow } from '@eko/shared';
import { binary } from './types.js';
import type { ChainDb } from './client.js';
export const INITIAL_FLOW_MODEL='fp-1.0.0';
/**
 * Read the active watcher model version or fall back to the initial version when no row exists.
 * SQL failures propagate; no model is trained or activated.
 */
export async function flowModel(db:ChainDb) {
  return (await db.sql.query<{model_version:string}>('SELECT model_version FROM watcher_flow_model WHERE singleton')).rows[0]?.model_version ?? INITIAL_FLOW_MODEL;
}
/**
 * Read the latest precision-evaluation record for this model and validate its publication-gate
 * projection. Missing metrics remain null; SQL/schema failures reject. The caller separately
 * checks gate acceptance.
 */
export async function censusGate(db:ChainDb,modelVersion:string) {
  // JSON projection lets engine-only databases without API migration 0035 fail closed.
  const row=(await db.sql.query<{data:Record<string,unknown>}>(`SELECT to_jsonb(e) AS data FROM eval_gates e WHERE metric='likely_agent_precision' AND model_version=$1 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,[modelVersion])).rows[0]?.data;
  return CensusSchema.shape.gate.parse({metric:'likely_agent_precision',value:row?.value??null,wilsonLower:row?.wilson_lower??null,recall:row?.recall??null,
    threshold:0.90,modelVersion,evaluatedAt:row?new Date(row.evaluated_at as string).toISOString():null,
    expiresAt:row?.expires_at?new Date(row.expires_at as string).toISOString():null,modelHash:row?.model_hash??null,datasetHash:row?.dataset_hash??null,evidence:row?.evidence??null});
}
/**
 * Build a structural flow placeholder whose availability mask marks all shares missing. Pure
 * projection; numeric zeros are not measured values and consumers must honor the mask.
 */
export function unavailableFlow(window:Flow['window'],block=0,modelVersion=INITIAL_FLOW_MODEL):Flow {
  // Required numeric fields are structural only; consumers must honor the availability mask.
  return {window,agentPct:0,crewPct:0,humanPct:0,washEstPct:0,beta:true,confidence:0,modelVersion,
    meta:{confidence:0,asOfBlock:block,unavailable:true,missing:['agentPct','crewPct','humanPct','washEstPct'],flags:['watcher_unavailable']}};
}
/**
 * Read clean canonical coin/window snapshots for the active model and derive beta from its
 * evaluation gate. Empty input returns an empty map; absent snapshots are omitted and SQL/schema
 * failures reject. No classification or acquisition runs.
 */
export async function readFlows(db:ChainDb,coins:Address[],window:Flow['window']='1h') {
  if(!coins.length)return new Map<Address,Flow>();
  const model=await flowModel(db),gate=await censusGate(db,model);
  const rows=(await db.sql.query<{coin:Uint8Array;data:unknown}>(`SELECT f.coin,f.data FROM flow_windows f JOIN chain_blocks b ON b.number=f.block AND b.hash=f.block_hash
    WHERE f.coin=ANY($1::bytea[]) AND f.window_kind=$2 AND f.model_version=$3
    AND NOT EXISTS(SELECT 1 FROM flow_dirty d WHERE d.coin=f.coin)`,[coins.map(binary),window,model])).rows;
  return new Map(rows.map(r=>[`0x${Buffer.from(r.coin).toString('hex')}` as Address,{...FlowSchema.parse(r.data),beta:!censusGateAccepted(gate)}]));
}
/**
 * Read at most 5000 canonical active-model chart markers in the supplied time interval and report
 * missing labels/overflow explicitly. Missing clean flow returns unavailable labels; SQL/schema
 * failures reject. No sender or price acquisition occurs.
 */
export async function readMarkers(db:ChainDb,coin:Address,from:number,to:number) {
  const model=await flowModel(db),gate=await censusGate(db,model);
  const ready=(await db.sql.query<{data:Flow}>(`SELECT f.data FROM flow_windows f JOIN chain_blocks b ON b.number=f.block AND b.hash=f.block_hash WHERE f.coin=$1 AND f.model_version=$2
    AND NOT EXISTS(SELECT 1 FROM flow_dirty d WHERE d.coin=f.coin) LIMIT 1`,[binary(coin),model])).rows[0];
  if(!ready)return {rows:[],markers:[],cursor:null,unavailable:['labels'],delayedSec:0};
  const rows=(await db.sql.query<{data:unknown}>(`SELECT e.data FROM flow_events e JOIN chain_blocks b ON b.number=e.block AND b.hash=e.block_hash
    WHERE e.coin=$1 AND e.model_version=$2 AND e.ts>=to_timestamp($3::double precision) AND e.ts<to_timestamp($4::double precision)
      AND e.block>coalesce((SELECT swaps_through_block FROM history_prunes WHERE coin=$1),-1)
    ORDER BY e.ts,e.block,e.tx_hash,e.log_index LIMIT 5001`,[binary(coin),model,from,to])).rows;
  const pending=(await db.sql.query<{n:string}>(`SELECT count(*) AS n FROM swaps s WHERE s.coin=$1 AND s.ts>=to_timestamp($2::double precision) AND s.ts<to_timestamp($3::double precision)
    AND NOT EXISTS(SELECT 1 FROM flow_events e JOIN chain_blocks b ON b.number=e.block AND b.hash=e.block_hash WHERE e.tx_hash=s.tx_hash AND e.log_index=s.log_index AND e.model_version=$4)`,[binary(coin),from,to,model])).rows[0];
  const markers=rows.slice(0,5000).map(r=>({...ChartMarkerSchema.parse(r.data),beta:!censusGateAccepted(gate)}));
  const unavailable=[...(Number(pending.n)>0||ready.data.meta?.flags?.some(f=>['labels','sender','price','crew_membership'].includes(f))?['labels']:[]),...(rows.length>5000?['marker_limit']:[])];
  return {rows:markers,markers,cursor:null,unavailable,delayedSec:0};
}
/**
 * Return a validated public Census only when the current precision gate is accepted at now and a
 * clean canonical finalized snapshot exists. Otherwise return gated empty aggregates with an
 * explicit reason; SQL/schema failures reject. No classification or measurement runs on this read.
 */
export async function readCensus(db:ChainDb,now=Date.now()) {
  const model=await flowModel(db),gate=await censusGate(db,model);
  // TODO(spec): No methodology URL or Census coin selection is specified. Link the Census methodology anchor and publish only finalized chain windows.
  const base={methodologyUrl:'/census#methodology',gate,asOf:new Date(now).toISOString()};
  if(!censusGateAccepted(gate,now))return CensusSchema.parse({...base,gated:true,reason:'Wallet-label precision has not passed the publication gate.',chain:[],coins:[]});
  const snapshot=(await db.sql.query<{data:{chain:unknown[]};as_of:Date}>(`SELECT c.data,c.as_of FROM census_snapshots c JOIN chain_blocks b ON b.number=c.block AND b.hash=c.block_hash
    WHERE c.model_version=$1 AND NOT EXISTS(SELECT 1 FROM flow_dirty)`,[model])).rows[0];
  if(!snapshot)return CensusSchema.parse({...base,gated:true,reason:'Finalized flow coverage is unavailable.',chain:[],coins:[]});
  return CensusSchema.parse({...base,asOf:new Date(snapshot.as_of).toISOString(),gated:false,chain:snapshot.data.chain,coins:[]});
}
