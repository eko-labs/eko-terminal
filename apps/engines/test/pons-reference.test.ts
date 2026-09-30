import { expect, it } from 'vitest';
import { referenceDigest, type PonsResult } from '@eko/chain';
import type { ChainDb } from '@eko/db';
import { persistPonsReferenceResult, bindPonsControlProfile } from '../src/pons-reference.js';
import { assessPonsControlProfile, type PonsControlInput } from '../src/control-profile.js';
import { address, hash, cursor } from '../../../packages/chain/test/reference-fixtures.js';

const result=():PonsResult=>({id:hash('execution'),methodVersion:'pons-reference-1',coin:address(10),cursor,sizeUsd:100,routeId:'fixture-pons',trajectoryKind:'isolated_persistent_local',benchmarkQualified:false,profileHash:hash('profile'),routeFingerprint:hash('route'),routeSnapshot:{fixture:true},ekoFeeWei:'0',origin:'measured',status:'provider_failure',complete:false,honeypotConfirmed:false,referenceEntryUnavailable:false,entryLimitedClasses:[],observations:[],fidelityEvidenceIds:[],trace:[{fixture:'trace'}],traceDigest:referenceDigest([{fixture:'trace'}]),unsupportedSuccessors:['pons_v4']});
it('records immutable measured summaries, retains traces separately and rejects fixture/reorg/conflicting revisions',async()=>{
 const writes:unknown[][]=[];let canonical:string|null=cursor.blockHash,prior:unknown;
 const db={blockHash:async()=>canonical,tx:async(work:(tx:unknown)=>Promise<unknown>)=>work(db),sql:{query:async(sql:string,params:unknown[]=[])=>{
  if(sql.startsWith('SELECT'))return {rows:prior?[{data:prior}]:[]};if(sql.startsWith('INSERT'))writes.push(params);return {rows:[]};
 }}} as unknown as ChainDb;
 const r=result();await persistPonsReferenceResult(db,r);expect(writes).toHaveLength(1);const stored=JSON.parse(writes[0][7] as string);
 expect(stored.trace).toBeUndefined();expect(JSON.parse(writes[0][9] as string)).toEqual(r.trace);expect(stored.complete).toBe(false);
 await expect(persistPonsReferenceResult(db,{...r,origin:'fixture'})).rejects.toThrow('Fixture');
 canonical=hash('reorg');await expect(persistPonsReferenceResult(db,r)).rejects.toThrow('pin mismatch');canonical=cursor.blockHash;
 prior={...stored,status:'ok'};await expect(persistPonsReferenceResult(db,r)).rejects.toThrow('revision conflict');
 r.trace=[];await expect(persistPonsReferenceResult(db,r)).rejects.toThrow('digest mismatch');
});
it('removes nested account traces from permanent summaries',async()=>{
 const r=result();r.observations=[{trace:[{fixture:'nested'}]} as PonsResult['observations'][number]];
 let data:unknown;const db={blockHash:async()=>cursor.blockHash,tx:async(work:(tx:unknown)=>Promise<unknown>)=>work(db),sql:{query:async(sql:string,p:unknown[]=[])=>{if(sql.startsWith('INSERT'))data=JSON.parse(p[7] as string);return {rows:[]};}}} as unknown as ChainDb;
 await persistPonsReferenceResult(db,r);expect((data as PonsResult).observations[0].trace).toBeUndefined();
});
it('rejects absent/unreviewed profile and changed snapshot digest',()=>{
 const absent={status:'absent' as const,address:null,codeHash:null,evidenceIds:[hash('absent')]};
 const i:PonsControlInput={schemaVersion:'pons-control-input-2',origin:'fixture',coin:address(10),launchpad:'pons',decimals:18,cursor,knownAt:{cursor,acquisitionSequence:'1'},
  pins:{token:{status:'verified',address:address(10),codeHash:hash('code'),evidenceIds:[hash('token')]},curve:absent,proxy:absent,implementation:absent,hook:absent,locker:absent,authorityHash:null,authorityEvidenceIds:[]},
  configuration:{launchConfigId:null,launchedAtSec:null,decayEndSec:null,decayPolicyHash:null,feePolicyHash:null,recipientScheduleHash:null,configurationHash:null,evidenceIds:[]},
  getters:{creatorTaxBps:null,feeBps:null,currentSnipeTaxBps:null,launchedAtSec:null,evidenceIds:[]},permissionCoverageComplete:false,probes:[],charges:[],evidenceIds:[hash('input')]};
 const s=assessPonsControlProfile(i);const route={coin:i.coin,origin:'fixture',verification:{profileHash:s.profileHash,stateFingerprint:s.stateFingerprint,blockHash:cursor.blockHash,sourceRevision:hash('none')}} as Parameters<typeof bindPonsControlProfile>[0];
 expect(()=>bindPonsControlProfile(route,s)).toThrow('unreviewed');s.configuration.decayEndSec='2000';expect(()=>bindPonsControlProfile(route,s)).toThrow('digest mismatch');
});
