import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import type { Abi, Hex } from 'viem';
import { GuardReceiptPayloadSchema, GuardAssessmentV2Schema, guardDecisionBody, createGuardReceiptCodec } from '@eko/shared';
import type { GuardVerdictRevisionInput, GuardAvailabilityManifest } from '@eko/shared';
import { migrate, migrateEngines, GuardSourceStore, GuardVerdictStore, GuardReceiptStore, ReceiptOutbox, guardManifestId, guardStorageHash } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import type { ChainDb, GuardRegistryReader } from '../src/index.js';
import registryAbi from '../../chain/abi/eko/ReceiptsRegistry.json' with {type:'json'};
import fixture from '../../shared/test/fixtures/receipts/guard-v2.json' with {type:'json'};

const codec=createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
const sample=GuardReceiptPayloadSchema.parse(fixture.items.find(i=>i.case==='exact-threshold')!.payload);
const at=sample.recordedAt,registry=`0x${'ab'.repeat(20)}` as const,txHash=guardStorageHash('fixture-anchor-tx'),blockHash=guardStorageHash('fixture-anchor-block');
let db:ChainDb,manifest:GuardAvailabilityManifest,receipts:GuardReceiptStore;
function request(runId:string,edit:(r:GuardVerdictRevisionInput)=>void=()=>{}) {
  const raw:GuardVerdictRevisionInput={assessment:GuardAssessmentV2Schema.parse({...sample.decision,receipt:{status:'recorded',id:'internal-calculation',payloadHash:guardStorageHash(null)}}),
    deterministicInput:structuredClone(sample.deterministicInput),manifestId:manifest.id,sourceRevision:manifest.sourceRevision,
    context:sample.revisionKey.context,dependencyIds:[],recordedAt:at,runId};
  edit(raw);raw.assessment.snapshotHash=guardStorageHash(raw.deterministicInput);raw.assessment.decisionHash=guardStorageHash(guardDecisionBody(raw.assessment));return raw;
}
function reader(root:Hex,count:number,changes:Partial<Awaited<ReturnType<GuardRegistryReader['getTransactionReceipt']>>>={}):GuardRegistryReader {
  const encodedTopics=encodeEventTopics({abi:registryAbi as Abi,eventName:'BatchCommitted',args:{batchId:37n,root,committer:registry}});
  const topics=encodedTopics.map(topic=>{if(typeof topic!=='string')throw new Error('Fixture needs exact topics');return topic;});
  return {getChainId:async()=>4663,getBlock:async()=>({hash:blockHash}),getTransactionReceipt:async()=>({
    status:'success',transactionHash:txHash,blockNumber:600n,blockHash,
    logs:[{address:registry,topics,data:encodeAbiParameters([{type:'uint32'}],[count]),logIndex:2}],...changes,
  })};
}
beforeAll(async()=>{
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);receipts=new GuardReceiptStore(db);
  const m={sourceId:'receipt-fixture',sourceRevision:guardStorageHash('receipt-fixture-source'),replayMode:'production' as const,
    cut:sample.decision.availabilityCut,watermark:sample.decision.cursor};
  manifest=await new GuardSourceStore(db).putManifest({...m,id:guardManifestId(m),acquiredAt:at});
},30000);
afterAll(async()=>{await db?.close();});
describe('034 receipt lifecycle, synthetic PGlite and registry logs',()=>{
  it('records a nonrecursive public payload, reuses exact bytes/time/id and appends execution runs',async()=>{
    const store=new GuardVerdictStore(db),first=await store.putRevision(request('receipt-run-1'));
    const second=await store.putRevision(request('receipt-run-2',r=>{r.recordedAt='2026-10-02T00:00:01.000Z';r.assessment.receipt.id='discarded-id';}));
    expect(second.id).toBe(first.id);expect(second.data).toEqual(first.data);
    const result=(await receipts.get(first.data.assessment.receipt.id))!;
    expect(result.receipt).toEqual(first.data.assessment.receipt);expect(result.receipt).not.toHaveProperty('root');expect(result.receipt).not.toHaveProperty('txHash');
    expect(codec.hash(result.payload)).toBe(first.payload_hash);expect(result.payload.decision).not.toHaveProperty('receipt');
    expect(result.payload.recordedAt).toBe(at);expect(result.payload.revisionKey).toMatchObject({cursor:manifest.watermark,sourceRevision:manifest.sourceRevision,context:sample.revisionKey.context});
    expect((await db.sql.query('SELECT * FROM guard_verdict_runs WHERE revision_id=$1',[first.id])).rows).toHaveLength(2);
    expect((await db.sql.query('SELECT * FROM guard_receipt_payloads')).rows).toHaveLength(1);
    const outbox=new ReceiptOutbox(db);expect(await outbox.recover()).toBe(1);expect(await outbox.recover()).toBe(0);
    const queued=(await outbox.get(result.receipt.id))!;
    expect(queued.canonicalPayload).toBe(result.canonicalPayload);expect(queued.item.hash).toBe(first.payload_hash);
    expect(queued.receipt).toEqual(result.receipt);expect(queued.leaf).toBe(codec.encodeReceiptLeaf(queued.item));
    await expect(db.sql.query('UPDATE guard_receipt_payloads SET canonical_payload=$1',['{}'])).rejects.toThrow('append-only');
  });
  it('uses full versions/hashes/context/raw status in the revision key and rejects same-input decision drift',async()=>{
    const store=new GuardVerdictStore(db),original=await store.putRevision(request('key-original'));
    let previous=original;
    for(const [i,edit] of [
      (r:GuardVerdictRevisionInput)=>{r.context={...r.context,sizeUsd:'1000'};},
      (r:GuardVerdictRevisionInput)=>{r.assessment.codeHash=guardStorageHash('different-code');},
      (r:GuardVerdictRevisionInput)=>{r.assessment.measurementVersion='2.0.1';},
      (r:GuardVerdictRevisionInput)=>{r.deterministicInput={raw:'unknown',status:'missing'};},
    ].entries()) {
      const next=await store.putRevision(request(`key-${i}`,edit));expect(next.id).not.toBe(original.id);
      if(i>0)expect(next.data.assessment.supersedes).toBe(previous.id);
      if(i>0)previous=next;else expect(next.data.assessment.supersedes).toBeNull();
    }
    const drift=request('same-input-drift',r=>{r.assessment.reasons=[];});
    await expect(store.putRevision(drift)).rejects.toThrow('different decision');
  });
  it('prepares 300-second batches and accepts only successful canonical events from the configured registry',async()=>{
    expect(await receipts.prepareBatch('2026-10-02T00:04:59.999Z')).toBeNull();
    const batch=(await receipts.prepareBatch('2026-10-02T00:05:00.000Z'))!;
    const valid=reader(batch.root,batch.items.length);
    for(const invalid of [reader(batch.root,batch.items.length,{status:'reverted'}),reader(batch.root,batch.items.length,{logs:[]}),
      reader(guardStorageHash('wrong-root'),batch.items.length),reader(batch.root,batch.items.length+1),
      {...valid,getChainId:async()=>1}, {...valid,getBlock:async()=>({hash:guardStorageHash('orphan')})}])
      await expect(receipts.recordAnchor(batch,txHash,registry,4663,invalid,at)).rejects.toThrow();
    await expect(receipts.recordAnchor(batch,txHash,`0x${'cd'.repeat(20)}`,4663,valid,at)).rejects.toThrow('BatchCommitted');
    await receipts.recordAnchor(batch,txHash,registry,4663,valid,at);await receipts.recordAnchor(batch,txHash,registry,4663,valid,at);
    const outbox=new ReceiptOutbox(db);await outbox.recover();
    const item=batch.items[0]!,result=(await receipts.get(item.id))!;
    expect(result.receipt).toMatchObject({status:'anchored',root:batch.root,batchId:37,txHash});
    expect((await outbox.get(item.id))!.receipt).toEqual(result.receipt);
    expect(result.payload.decision).not.toHaveProperty('batchId');expect(result.payload.recordedAt).toBe(at);
    expect(codec.verifyPublicProof(result.payload,item,batch.proofs[0]!,batch.root)).toBe(true);
    expect(await receipts.prepareBatch('2026-10-02T00:10:00.000Z')).toBeNull();
    const before=result.canonicalPayload;
    await receipts.refreshAnchors({...valid,getBlock:async()=>({hash:guardStorageHash('replacement-anchor-block')})},4663,'2026-10-02T00:06:00.000Z');
    expect((await receipts.get(item.id))!.receipt.status).toBe('recorded');expect((await receipts.get(item.id))!.canonicalPayload).toBe(before);
    expect((await outbox.get(item.id))!.receipt.status).toBe('recorded');
    expect((await receipts.prepareBatch('2026-10-02T00:10:00.000Z'))!.root).toBe(batch.root);
  });
  it('retains payload/proof identity after append-only supersession and source reorg',async()=>{
    const store=new GuardVerdictStore(db),old=await store.putRevision(request('before-reorg'));
    const oldBytes=(await receipts.get(old.data.assessment.receipt.id))!.canonicalPayload;
    const corrected=await store.putRevision(request('corrected-revision',r=>{r.deterministicInput={correction:'new-evidence'};r.assessment.supersedes=old.id;}));
    expect(corrected.id).not.toBe(old.id);
    await store.invalidateReorg({chainId:4663,fromBlock:manifest.watermark.blockNumber,causeId:guardStorageHash('reorg-cause'),knownAt:manifest.cut,recordedAt:at});
    const result=(await receipts.get(old.data.assessment.receipt.id))!;
    expect(result.canonicalPayload).toBe(oldBytes);expect(result.payload.decision.supersedes).toBeNull();
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({kind:'superseded',replacementId:corrected.id}),expect.objectContaining({kind:'orphaned'})]));
  });
});
