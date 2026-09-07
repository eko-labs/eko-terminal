import type { ChainDb } from './client.js';
import { emptyLifetime, addLifetimeLiquidity, addLifetimePons, type Lifetime, type LifetimeLiquidityRow } from './lifetime.js';

/** The existing outcome engine resolves its three launch horizons with this same clock ordering. */
export async function outcomeBlocks(db:ChainDb,coin:Uint8Array) {
  // Unrated launches can reach retention before the engine copies their clocks.
  // The outcome engine never evaluates identities without a deployer (including high-volume quote tokens).
  await db.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source)
    SELECT b.number,b.ts,b.hash,'head' FROM tokens t JOIN chain_blocks b ON b.number=t.first_block WHERE t.address=$1 AND t.deployer IS NOT NULL ON CONFLICT DO NOTHING`,[coin]);
  await db.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source)
    SELECT DISTINCT b.number,b.ts,b.hash,'head' FROM tokens t JOIN engine_block_times c ON c.number=t.first_block
    CROSS JOIN (VALUES(3600),(86400),(604800)) h(sec)
    CROSS JOIN LATERAL (SELECT number,ts,hash FROM chain_blocks WHERE ts>=c.ts+h.sec*interval '1 second' ORDER BY ts,number LIMIT 1) b
    WHERE t.address=$1 AND t.deployer IS NOT NULL ON CONFLICT DO NOTHING`,[coin]);

  return (await db.sql.query<{block:string;prior:string|null;ts:Date}>(`SELECT DISTINCT e.number::text AS block,e.ts,
    (SELECT number::text FROM engine_block_times WHERE ts<=e.ts-interval '1 hour' AND number<=e.number ORDER BY ts DESC,number DESC LIMIT 1) AS prior
    FROM tokens t JOIN engine_block_times c ON c.number=t.first_block
    CROSS JOIN (VALUES(3600),(86400),(604800)) h(sec)
    CROSS JOIN LATERAL (SELECT number,ts FROM engine_block_times WHERE ts>=c.ts+h.sec*interval '1 second' ORDER BY ts,number LIMIT 1) e
    WHERE t.address=$1 AND t.deployer IS NOT NULL`,[coin])).rows;
}
export type OutcomeCuts = Awaited<ReturnType<typeof outcomeBlocks>>;
/** Capture a complete prefix only. Batches drain in block order, so no later fact can enter an old checkpoint. */
export async function preserveOutcomeSwaps(db:ChainDb,coin:Uint8Array,data:Lifetime,through:bigint,cuts?:OutcomeCuts) {
  for(const {block} of cuts ?? await outcomeBlocks(db,coin)) {
    if(BigInt(block)>through || data.last && BigInt(data.last.block)>BigInt(block))continue;
    const hour=(await db.sql.query<{total:number;missing:number;volume:number;missing_volume:number;unknown:number}>('SELECT * FROM coin_outcome_hours WHERE coin=$1 AND block=$2',[coin,block])).rows[0];
    const snapshot={...data,checkpointHour:{totalCount:hour?.total ?? 0,unattributedCount:hour?.missing ?? 0,totalVolumeUsd:hour?.volume ?? 0,unattributedVolumeUsd:hour?.missing_volume ?? 0,unknownVolumeCount:hour?.unknown ?? 0}};
    await db.sql.query(`INSERT INTO coin_lifetime_checkpoints(coin,block,data) SELECT $1,$2,$3
      WHERE NOT EXISTS(SELECT 1 FROM swaps WHERE coin=$1 AND block<=$2)
      ON CONFLICT DO NOTHING`,[coin,block,JSON.stringify(snapshot)]);
  }
}
/** Holder views at outcome cuts and their preceding hour survive the three-day movement window. */
export async function preserveOutcomeHoldings(db:ChainDb,coin:Uint8Array,through:bigint,cuts?:OutcomeCuts) {
  const blocks=new Set((cuts ?? await outcomeBlocks(db,coin)).flatMap(r=>[r.block,...r.prior ? [r.prior] : []]));
  for(const block of blocks) {
    if(BigInt(block)>through)continue;
    if((await db.sql.query('SELECT 1 FROM coin_holder_checkpoints WHERE coin=$1 AND block=$2',[coin,block])).rows.length)continue;
    await db.sql.query(`INSERT INTO coin_holder_checkpoints(coin,block,data)
      SELECT $1,$2,coalesce(jsonb_object_agg(encode(holder,'hex'),jsonb_build_object('amount',amount::text,'block',block::text)),'{}') FROM (
        SELECT holder,sum(amount) AS amount,max(block) AS block FROM (
          SELECT to_address AS holder,amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
          UNION ALL SELECT from_address,-amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
          UNION ALL SELECT holder,amount,through_block FROM transfer_baselines WHERE token=$1 AND through_block<=$2
        ) m GROUP BY holder HAVING sum(amount)>0
      ) h ON CONFLICT DO NOTHING`,[coin,block]);
  }
}

/** Five sufficient statistics per outcome hour, accumulated with the exact batch being removed. */
export async function addOutcomeHours(db:ChainDb,coin:Uint8Array,rows:Record<string,unknown>[],cuts?:OutcomeCuts) {
  const ends=cuts?.map(c=>({number:c.block,ts:c.ts})) ?? (await db.sql.query<{number:string;ts:Date}>(`SELECT e.number,e.ts FROM tokens t JOIN engine_block_times c ON c.number=t.first_block
    CROSS JOIN (VALUES(3600),(86400),(604800)) h(sec)
    CROSS JOIN LATERAL (SELECT number,ts FROM engine_block_times WHERE ts>=c.ts+h.sec*interval '1 second' ORDER BY ts,number LIMIT 1) e WHERE t.address=$1 AND t.deployer IS NOT NULL`,[coin])).rows;
  for(const end of new Map(ends.map(e=>[String(e.number),e])).values()) {
    const samples=rows.filter(r=>BigInt(String(r.block))<=BigInt(end.number) && new Date(r.ts as Date).getTime()>new Date(end.ts).getTime()-3600000);
    if(!samples.length)continue;
    const missing=samples.filter(r=>r.trader==null || r.senders_pending);
    await db.sql.query(`INSERT INTO coin_outcome_hours VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(coin,block) DO UPDATE SET
      total=coin_outcome_hours.total+excluded.total,missing=coin_outcome_hours.missing+excluded.missing,
      volume=coin_outcome_hours.volume+excluded.volume,missing_volume=coin_outcome_hours.missing_volume+excluded.missing_volume,unknown=coin_outcome_hours.unknown+excluded.unknown`,
      [coin,end.number,samples.length,missing.length,samples.reduce((n,r)=>n+Number(r.usd ?? 0),0),missing.reduce((n,r)=>n+Number(r.usd ?? 0),0),missing.filter(r=>r.usd==null).length]);
  }
}

/** Auxiliary retention can run before the swap cap. Keep its prefix separately at each resolved outcome cut. */
export async function prepareOutcomeEvents(db:ChainDb,coin:Uint8Array,data:Lifetime) {
  for(const {block} of await outcomeBlocks(db,coin)) {
    const cut=Number(block),snapshot=emptyLifetime();
    if(data.liquidity && (data.liquidityThrough==null || data.liquidityThrough>cut))continue;
    const hasCurve=data.curve.launchSeen || data.curve.threshold!=null || data.curve.reserve!=='0' || !data.curve.valid;
    if(data.ponsThrough!=null && data.ponsThrough>cut || hasCurve && data.ponsThrough==null)continue;
    snapshot.liquidity=data.liquidity;snapshot.curve=data.curve;
    snapshot.priorRemovalCount=data.priorRemovalCount;snapshot.priorRemovalLastBlock=data.priorRemovalLastBlock;snapshot.priorRemovals=data.priorRemovals;
    await db.sql.query('INSERT INTO coin_outcome_events VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[coin,block,JSON.stringify(snapshot)]);
  }
}
export async function addOutcomeEvents(db:ChainDb,coin:Uint8Array,rows:LifetimeLiquidityRow[] | {block:string;kind:string;data:Record<string,unknown>}[],kind:'liquidity'|'pons',identity:{launchpad:string;deployer:string;firstBlock:number}) {
  const checkpoints=(await db.sql.query<{block:string;data:Lifetime}>('SELECT block,data FROM coin_outcome_events WHERE coin=$1 ORDER BY block FOR UPDATE',[coin])).rows;
  for(const checkpoint of checkpoints) {
    const prefix=rows.filter(r=>BigInt(r.block)<=BigInt(checkpoint.block));if(!prefix.length)continue;
    if(kind==='liquidity')addLifetimeLiquidity(checkpoint.data,prefix as LifetimeLiquidityRow[],identity.launchpad,identity.deployer);
    else addLifetimePons(checkpoint.data,prefix,identity.firstBlock);
    await db.sql.query('UPDATE coin_outcome_events SET data=$3 WHERE coin=$1 AND block=$2',[coin,checkpoint.block,JSON.stringify(checkpoint.data)]);
  }
}
