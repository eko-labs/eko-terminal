import { binary, type ChainDb } from '@eko/db';
import { referenceDigest, type LocalDepthRun, type LocalDirectionalDepth } from '@eko/chain';
import { DirectionalDepthMeasurementSchema, type Metric, type DirectionalDepthMeasurement } from '@eko/shared';
/** Persist the local prediction and provenance, never publish it as measured execution. */
export async function persistLocalDepthRun(db:ChainDb,result:LocalDepthRun) {
  if(result.origin!=='measured')throw new Error('Fixture depth cannot be recorded as measured');
  const {id,...body}=result;
  if(referenceDigest(body)!==id)throw new Error('Depth result digest mismatch');
  await db.tx(async tx=>{
    if(await tx.blockHash(BigInt(result.cursor.blockNumber))!==result.cursor.blockHash)throw new Error('Depth persistence pin mismatch');
    const prior=(await tx.sql.query<{data:unknown}>('SELECT data FROM directional_depth_runs WHERE id=$1',[id])).rows[0];
    if(prior&&referenceDigest(prior.data)!==referenceDigest(result))throw new Error('Depth revision conflict');
    await tx.sql.query(`INSERT INTO directional_depth_runs(id,coin,block,block_hash,method_version,data)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,binary(result.coin),result.cursor.blockNumber,binary(result.cursor.blockHash),result.methodVersion,JSON.stringify(result)]);
  });
}

/** Card/policy adapter only; calling this does not mark an execution check complete. */
export function guardDirectionalDepth(depth:LocalDirectionalDepth,base:Omit<Metric<string>,'id'|'unit'|'status'|'value'|'failureCode'|'errorBounds'>):DirectionalDepthMeasurement {
  if(referenceDigest(base.cursor)!==referenceDigest(depth.cursor))throw new Error('Depth metric cursor mismatch');
  const b=depth.bounds,p=b.domain.inputUsd;
  const errors=b.lowerInput===null||b.upperInput===null?null:{
    lower:{numerator:(BigInt(b.lowerInput)*BigInt(p.numerator)).toString(),denominator:(BigInt(p.denominator)*1_000_000n).toString()},
    upper:{numerator:(BigInt(b.upperInput)*BigInt(p.numerator)).toString(),denominator:(BigInt(p.denominator)*1_000_000n).toString()},
  };
  const exact=b.status==='exact'&&b.lowerInput!==null&&BigInt(b.lowerInput)*BigInt(p.numerator)%BigInt(p.denominator)===0n;
  const unknown=b.status==='unsupported'||b.lowerUsd==='0'&&!base.coverage.complete;
  return DirectionalDepthMeasurementSchema.parse({routeId:depth.routeId,direction:depth.direction,discountPct:depth.discountPct,
    usd:{...base,methodVersion:'1.0.0',evidenceIds:[...new Set([...base.evidenceIds,...depth.evidenceIds])],id:`depth${depth.direction==='buy'?'Buy':'Sell'}${depth.discountPct}`,unit:'usd',
      ...(unknown?{status:'unknown',value:null,failureCode:'unsupported'}:{status:exact?'observed':'lower_bound',value:b.lowerUsd,failureCode:null}),
      ...(errors?{errorBounds:errors}:{})},
    solverBounds:{method:b.method,evaluations:b.evaluations,monotonicityProved:b.monotonicityProved,lowerUsd:b.lowerUsd,upperUsd:b.upperUsd,
      relativeWidthPct:b.relativeWidthPct,errorBounds:errors,domain:b.domain,termination:b.reason,lowerInput:b.lowerInput,upperInput:b.upperInput,remoteSearchCalls:0}});
}
