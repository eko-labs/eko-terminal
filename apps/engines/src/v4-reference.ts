import { binary, type ChainDb } from '@eko/db';
import { referenceDigest, type V4ReferenceSimulation, type V4ReferenceInput, type V4ReferenceResult, type ReferenceSize } from '@eko/chain';

/** Explicit opt-in worker boundary. No automatic live job or Guard publication. */
export async function runV4References(db:ChainDb,simulator:Pick<V4ReferenceSimulation,'run'>,input:Omit<V4ReferenceInput,'sizeUsd'|'sizeWei'|'noTax'> & {
  ethUsd:{numerator:bigint;denominator:bigint;blockHash:string;evidenceIds:string[]};
}) {
  const p=input.ethUsd;
  if(p.numerator<=0n || p.denominator<=0n || p.blockHash!==input.cursor.blockHash || !p.evidenceIds.length)throw new Error('Pinned ETH USD price unavailable');
  const results:V4ReferenceResult[]=[];
  // Independent debug_traceCall state for every size; serial requests bound upstream concurrency.
  for(const sizeUsd of [100,1000,10000] as ReferenceSize[])results.push(await simulator.run({
    cursor:input.cursor,route:input.route,sizeUsd,sizeWei:BigInt(sizeUsd)*p.denominator*10n**18n/p.numerator,
  }));
  await db.tx(async tx=>{
    if(await tx.blockHash(BigInt(input.cursor.blockNumber))!==input.cursor.blockHash)throw new Error('V4 persistence pin mismatch');
    for(const result of results)await persistV4Reference(tx,result);
    await expireV4ReferenceTraces(tx);
  });
  return results;
}
export async function persistV4Reference(db:ChainDb,result:V4ReferenceResult) {
  if(result.route.executable!==false || result.complete!==false || result.honeypotConfirmed!==false)throw new Error('V4 reference cannot grant acceptance');
  if(referenceDigest(result.trace)!==result.traceDigest)throw new Error('V4 trace digest mismatch');
  const {trace,...data}=result;
  const prior=(await db.sql.query<{data:unknown}>('SELECT data FROM v4_reference_runs WHERE id=$1',[result.id])).rows[0];
  if(prior && referenceDigest(prior.data)!==referenceDigest(data))throw new Error('V4 acquisition revision conflict');
  await db.sql.query(`INSERT INTO v4_reference_runs(id,coin,block,block_hash,pool_id,size_usd,route_id,method_version,data,trace_digest,trace)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,[
    result.id,binary(result.coin),result.cursor.blockNumber,binary(result.cursor.blockHash),binary(result.route.poolId),result.sizeUsd,result.routeId,result.methodVersion,JSON.stringify(data),result.traceDigest,JSON.stringify(trace),
  ]);
}
export async function expireV4ReferenceTraces(db:ChainDb) {
  await db.sql.query('UPDATE v4_reference_runs SET trace=NULL WHERE trace IS NOT NULL AND trace_expires_at<=now()');
}
/** Canonical pinned projection, retaining unsupported states. Never used as completed Guard input. */
export async function loadV4References(db:ChainDb,coin:string,block:bigint) {
  const hash=await db.blockHash(block);if(!hash)return [];
  return (await db.sql.query<{data:V4ReferenceResult}>(
    'SELECT data FROM v4_reference_runs WHERE coin=$1 AND block=$2 AND block_hash=$3 ORDER BY acquired_at DESC,id',
    [binary(coin),block.toString(),binary(hash)],
  )).rows.map(r=>r.data);
}
