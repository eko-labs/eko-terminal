import { binary, type ChainDb } from '@eko/db';
import { referenceDigest, type ReferenceResult, type ReferenceRoute, type ReferenceSize, type ForkMatch, type V3ReferenceSimulation } from '@eko/chain';
import type { GuardCursor } from '@eko/shared';
import type { LoadedSources } from './sources.js';

/** Normalizer-owned acquisition, intentionally opt-in: no CLI paid job or auto-start. */
export async function runV3References(db:ChainDb, simulator:Pick<V3ReferenceSimulation,'run'>, input:{
  cursor:GuardCursor; route:ReferenceRoute; matches:ForkMatch[];
  /** Pinned WETH/USDG marginal ETH-USD rational, USD units scaled by denominator. */
  ethUsd:{numerator:bigint;denominator:bigint;blockHash:string;evidenceIds:string[]};
}) {
  const price=input.ethUsd;
  if(price.numerator<=0n || price.denominator<=0n || price.blockHash!==input.cursor.blockHash || !price.evidenceIds.length)throw new Error('Pinned ETH USD price unavailable');
  const results=await Promise.all(([100,1000,10000] as ReferenceSize[]).map(sizeUsd=>simulator.run({
    cursor:input.cursor,route:input.route,matches:input.matches,sizeUsd,sizeWei:BigInt(sizeUsd)*price.denominator*10n**18n/price.numerator,
  })));
  await db.tx(async tx=>{
    if(await tx.blockHash(BigInt(input.cursor.blockNumber))!==input.cursor.blockHash)throw new Error('Simulation persistence pin mismatch');
    for(const result of results)await persistReferenceResult(tx,result);
    await expireSimulationTraces(tx);
  });
  return results;
}
export async function persistReferenceResult(db:ChainDb,result:ReferenceResult) {
  if(referenceDigest(result.trace)!==result.traceDigest)throw new Error('Simulation trace digest mismatch');
  const {trace,deep,...summary}=result;
  // Every raw trace lives in the expiring column, including nested EOA confirmations.
  const data={...summary,deep:deep.map(({trace:rawTrace,...evidence})=>evidence)};
  const prior=(await db.sql.query<{data:Omit<ReferenceResult,'trace'>}>('SELECT data FROM sim_runs WHERE id=$1',[result.id])).rows[0];
  // Re-acquisition has fresh probe identities. Never overwrite evidence at an existing immutable ID.
  if(prior && referenceDigest(prior.data)!==referenceDigest(data))throw new Error('Simulation revision conflict; use a new acquisition revision');
  await db.sql.query(`INSERT INTO sim_runs(id,coin,block,block_hash,size_usd,route_id,method_version,data,trace_digest,trace)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[
    result.id,binary(result.coin),result.cursor.blockNumber,binary(result.cursor.blockHash),result.sizeUsd,result.routeId,result.methodVersion,JSON.stringify(data),result.traceDigest,JSON.stringify(trace),
  ]);
}
export async function expireSimulationTraces(db:ChainDb) {
  await db.sql.query('UPDATE sim_runs SET trace=NULL WHERE trace IS NOT NULL AND trace_expires_at<=now()');
}
export async function simulationTrace(db:ChainDb,id:string) {
  const row=(await db.sql.query<{trace:unknown;trace_digest:string;retained:boolean}>(
    'SELECT trace,trace_digest,trace IS NOT NULL AND trace_expires_at>now() AS retained FROM sim_runs WHERE id=$1',[id])).rows[0];
  return row ? {status:row.retained?'available':'expired',digest:row.trace_digest,trace:row.retained?row.trace:null} : null;
}
// TODO(spec): legacy replay has no acquisition availability cut; exclude simulations until an explicit Guard cut is supplied.
/** Exact block/hash only. Later acquisition never supplies historical inputs to a replay. */
export async function loadReferenceInputs(db:ChainDb,s:LoadedSources,retrospective=false) {
  if(s.launchpad==='pons' || retrospective)return;
  const canonical=await db.blockHash(BigInt(s.asOfBlock));if(!canonical)return;
  const results=(await db.sql.query<{data:ReferenceResult}>(
    'SELECT data FROM sim_runs WHERE coin=$1 AND block=$2 AND block_hash=$3 ORDER BY acquired_at DESC,id',
    [binary(s.coin),s.asOfBlock,binary(canonical)],
  )).rows.map(r=>r.data);
  const best=new Map<ReferenceSize,ReferenceResult>();
  for(const r of results) {
    if(!r.complete || r.probe===null || (r.exitCostPct===null && !['entry_limited','contract_restricted'].includes(r.status)))continue;
    const prior=best.get(r.sizeUsd);
    if(!prior || prior.status==='entry_limited' && r.status!=='entry_limited' ||
      r.status!=='entry_limited' && prior.status!=='entry_limited' && (BigInt(r.probe.returned)>BigInt(prior.probe!.returned) ||
      BigInt(r.probe.returned)===BigInt(prior.probe!.returned) && r.routeId<prior.routeId))best.set(r.sizeUsd,r);
  }
  s.referenceResults=[...best.values()];
  const measured=[...best.values()].filter(r=>r.probe?.buyOk && r.exitCostPct!==null)
    .sort((a,b)=>b.exitCostPct!-a.exitCostPct! || a.sizeUsd-b.sizeUsd)[0];
  if(measured && (measured.buyTaxPct!==null || measured.sellTaxPct!==null))s.taxes={
    buyPct:measured.buyTaxPct,sellPct:measured.sellTaxPct,mutable:null,changes:[],
  };
  s.simulations=[...best.values()].filter(r=>r.status!=='entry_limited').map(r=>({id:r.id,sizeUsd:r.sizeUsd,block:s.asOfBlock,buyOk:r.probe!.buyOk,sellOk:r.probe!.sellOk,
    returnedInputShare:BigInt(r.probe!.spent)>0n ? Number(BigInt(r.probe!.returned)*1_000_000n/BigInt(r.probe!.spent))/1_000_000 : 0,traceDigest:r.traceDigest,revert:r.probe!.revert,
    confirmedBlockedExit:r.honeypotConfirmed,contractRestricted:r.status==='contract_restricted',
    ...(r.honeypotConfirmed ? {deep:{id:`${r.id}:eoa`,block:s.asOfBlock,buyOk:true,sellOk:r.deep[0].sellOk,
      returnedInputShare:Number(BigInt(r.deep[0].returned)*1_000_000n/BigInt(r.deep[0].spent))/1_000_000,traceDigest:r.traceDigest}} : {}),
  }));
}
