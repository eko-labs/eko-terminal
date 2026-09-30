import { binary, type ChainDb } from '@eko/db';
import { referenceDigest, type PonsCurveRoute, type PonsResult } from '@eko/chain';
import { PonsControlSnapshotSchema, controlProfileHash, type PonsControlSnapshot } from './control-profile.js';

/** Bind 040 execution to the exact reviewed 039 snapshot. No codehash-only template inheritance. */
export function bindPonsControlProfile(route:PonsCurveRoute,raw:PonsControlSnapshot):PonsCurveRoute {
  const profile=PonsControlSnapshotSchema.parse(raw),v=route.verification;
  const {profileHash,...body}=profile;
  if(controlProfileHash(body)!==profileHash)throw new Error('Pons profile digest mismatch');
  if(profile.coin.toLowerCase()!==route.coin.toLowerCase() || profile.origin!==route.origin || profile.profileHash!==v.profileHash ||
    profile.stateFingerprint!==v.stateFingerprint || profile.cursor.blockHash!==v.blockHash || profile.templateRevision!==v.sourceRevision ||
    profile.configuration.decayEndSec!==route.decayEndSec || profile.checks.some(c=>c.status!=='complete'))throw new Error('Pons profile is unreviewed or changed');
  for(const pin of [profile.pins.token,profile.pins.curve,profile.pins.proxy,profile.pins.implementation,profile.pins.hook,profile.pins.locker]) {
    if(pin.status==='unknown' || pin.status==='verified' && !v.pins.some(p=>p.address.toLowerCase()===pin.address!.toLowerCase() && p.codeHash===pin.codeHash))throw new Error('Pons execution code pin missing');
  }
  if(profile.pins.curve.address?.toLowerCase()!==route.curve.toLowerCase())throw new Error('Pons curve mismatch');
  return route;
}
/** Explicit normalizer-owned recording; does not activate V2 or complete a card check. Reuses 068 trace retention. */
export async function persistPonsReferenceResult(db:ChainDb,result:PonsResult) {
  if(result.origin!=='measured')throw new Error('Fixture execution cannot be recorded as measured');
  if(referenceDigest(result.trace)!==result.traceDigest)throw new Error('Pons trace digest mismatch');
  const {trace,observations,...summary}=result;
  const data={...summary,observations:observations.map(({trace:_,...o})=>o)};
  await db.tx(async tx=>{
    if(await tx.blockHash(BigInt(result.cursor.blockNumber))!==result.cursor.blockHash)throw new Error('Pons persistence pin mismatch');
    const prior=(await tx.sql.query<{data:unknown}>('SELECT data FROM sim_runs WHERE id=$1',[result.id])).rows[0];
    if(prior && referenceDigest(prior.data)!==referenceDigest(data))throw new Error('Pons simulation revision conflict');
    await tx.sql.query(`INSERT INTO sim_runs(id,coin,block,block_hash,size_usd,route_id,method_version,data,trace_digest,trace)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[
      result.id,binary(result.coin),result.cursor.blockNumber,binary(result.cursor.blockHash),result.sizeUsd,result.routeId,result.methodVersion,JSON.stringify(data),result.traceDigest,JSON.stringify(trace),
    ]);
    await tx.sql.query('UPDATE sim_runs SET trace=NULL WHERE trace IS NOT NULL AND trace_expires_at<=now()');
  });
}
