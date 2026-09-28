import { expect, it } from 'vitest';
import { CoinCardV2Schema } from '@eko/shared';
import type { ChainDb } from '@eko/db';
import { computeLocalDepthRun, localDirectionalDepth } from '@eko/chain';
import { persistLocalDepthRun, guardDirectionalDepth } from '../src/directional-depth.js';
import { route } from '../../../packages/chain/test/directional-depth-fixtures.js';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
import { card } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
const run=()=>computeLocalDepthRun({routes:[{...route(),origin:'measured'}],discoveryComplete:true,positions:null,controller:'demo-controller',accounts:[{id:'standard-eoa',ekoBuyBps:0n,ekoSellBps:0n}]});
it('stores immutable bounds/domain/precision/selection, rejects fixtures, corrupt digests and reorgs',async()=>{
 const writes:unknown[][]=[];const r=run();let canonical:string|null=r.cursor.blockHash,prior:unknown;
 const db={blockHash:async()=>canonical,tx:async(work:(tx:unknown)=>Promise<unknown>)=>work(db),sql:{query:async(sql:string,p:unknown[]=[])=>{
  if(sql.startsWith('SELECT'))return {rows:prior?[{data:prior}]:[]};if(sql.startsWith('INSERT'))writes.push(p);return {rows:[]};
 }}} as unknown as ChainDb;
 await persistLocalDepthRun(db,r);expect(writes).toHaveLength(1);expect(JSON.parse(writes[0][5] as string)).toEqual(r);
 const stored=JSON.parse(writes[0][5] as string);expect(stored.validation).toBe('local_prediction');expect(stored.directionalDepth[0].bounds.domain.precisionUsd).toBe('0.000001');expect(stored.sizeQuotes[0].ties).toEqual([r.sizeQuotes[0].best!.routeId]);
 await expect(persistLocalDepthRun(db,{...r,origin:'fixture'})).rejects.toThrow('Fixture');
 await expect(persistLocalDepthRun(db,{...r,remoteSearchCalls:1} as unknown as typeof r)).rejects.toThrow('digest');
 canonical=hash('reorg');await expect(persistLocalDepthRun(db,r)).rejects.toThrow('pin mismatch');canonical=r.cursor.blockHash;
 prior={...r,validation:'observed'};await expect(persistLocalDepthRun(db,r)).rejects.toThrow('revision conflict');
});
it('adapts bounded marginal depth to shared card metrics without promoting it to exact',()=>{
 const fixture=CoinCardV2Schema.parse(card),{id,unit,status,value,failureCode,...original}=fixture.liquidity.headlineDepth2Usd;
 const r=route(),base={...original,cursor:r.cursor,knownAt:{...original.knownAt,cursor:r.cursor},throughSec:r.cursor.timestampSec},d=localDirectionalDepth(r,'buy',2),metric=guardDirectionalDepth(d,base);
 expect(metric.usd.status).toBe('lower_bound');expect(metric.usd.value).toBe(d.bounds.lowerUsd);expect(metric.solverBounds.domain?.capUsd).toBe('1000000');expect(metric.solverBounds.termination).toBe('refined');
 r.verification.reviewed=false;const unknown=guardDirectionalDepth(localDirectionalDepth(r,'sell',2),base);expect(unknown.usd.status).toBe('unknown');expect(unknown.usd.value).toBeNull();
});
