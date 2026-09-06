import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { keccak256, toHex } from 'viem';
import { GuardAssessmentV2Schema, GuardCursorSchema, compareGuardCursors, guardKnownBy, busChannel, GUARD_BUS_TOPICS, GuardBusEventSchema, guardDecisionBody } from '@eko/shared';
import type { GuardAvailabilityManifest, GuardStoredEvidence, GuardStoredRole, GuardVerdictRevisionInput, GuardReorg } from '@eko/shared';
import { migrate } from '../src/client.js';
import { openDb } from './helpers/historical-db.js';
import type { ChainDb, BusMessage } from '../src/client.js';
import { migrateEngines } from '../src/engines-migrate.js';
import { GuardSourceStore, GuardMeasurementStore, GuardVerdictStore, guardManifestId, guardStorageHash, guardRowsKnownAt } from '../src/guard-store.js';
import { assessment as syntheticAssessment } from '../../shared/test/fixtures/contracts/guard-v2.js';
import legacy from '../../shared/test/fixtures/contracts/v1.json';

let db: ChainDb, source: GuardSourceStore, measurements: GuardMeasurementStore, verdicts: GuardVerdictStore;
const coin = `0x${'ab'.repeat(20)}`;
const sourceRevision = guardStorageHash({ source:'fixture',version:2 });
const at = '2026-10-02T00:00:00.000Z';
function cursor(block='123',tx: number|null=null,ordinal: number|null=null,boundary: 'block_end'|'before_tx'|'after_tx'='block_end') {
  return GuardCursorSchema.parse({ chainId:4663,blockNumber:block,blockHash:guardStorageHash({ block,fork:'fixture-canonical' }),transactionIndex:tx,executionOrdinal:ordinal,timestampSec:'1000',boundary });
}
async function manifest(name: string, sequence='1', state=cursor(), replayMode: 'production'|'retrospective'='production') {
  const key = { sourceId:name,sourceRevision,replayMode,cut:{cursor:state,acquisitionSequence:sequence},watermark:state };
  return source.putManifest({ ...key,id:guardManifestId(key),acquiredAt:at });
}
function evidence(m: GuardAvailabilityManifest, item: string, observed=cursor(), dependencyIds: `0x${string}`[]=[]) {
  const content = new TextEncoder().encode(`synthetic raw observation ${item}`), digest = keccak256(toHex(content));
  const data: GuardStoredEvidence = { chainId:4663,coin:coin as `0x${string}`,manifestId:m.id,sourceItemId:item,sourceRevision,cursor:observed,knownAt:m.cut,acquiredAt:at,methodVersion:'2.0.0',dependencyIds,evidence:{id:guardStorageHash({item}),kind:'log',cursor:observed,knownAt:m.cut,payloadHash:digest,objectRef:digest,supersedes:null} };
  return { data,content };
}
function revision(m: GuardAvailabilityManifest, runId: string, dependencies: string[]=[], receiptId=`receipt-${runId}`, supersedes: string|null=null): GuardVerdictRevisionInput {
  const a = JSON.parse(JSON.stringify(syntheticAssessment));
  a.cursor=m.watermark;a.availabilityCut=m.cut;a.receipt.id=receiptId;a.supersedes=supersedes;
  a.checks.forEach((c:{evidenceIds:string[]})=>{c.evidenceIds=[];});
  a.factors.forEach((f:{evidenceIds:string[]})=>{f.evidenceIds=dependencies;});
  a.reasons.forEach((r:{evidenceIds:string[]})=>{r.evidenceIds=dependencies;});
  const deterministicInput={fixture:'raw-storage-input',cursor:m.watermark,cut:m.cut,dependencies};
  a.snapshotHash=guardStorageHash(deterministicInput);a.decisionHash=guardStorageHash(guardDecisionBody(a));
  return { deterministicInput, assessment:GuardAssessmentV2Schema.parse(a),manifestId:m.id,sourceRevision,context:{routeId:null,sizeUsd:'100',accountClass:'eoa'},dependencyIds:dependencies as `0x${string}`[],recordedAt:at,runId };
}
const readCut=(m:GuardAvailabilityManifest,state=m.watermark)=>({chainId:4663,coin,manifestId:m.id,availability:m.cut,state});
const event=(m:GuardAvailabilityManifest,label:string)=>({causeId:guardStorageHash({label}),knownAt:m.cut,recordedAt:at});
beforeAll(async()=>{ db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);source=new GuardSourceStore(db);measurements=new GuardMeasurementStore(db);verdicts=new GuardVerdictStore(db); },30000);
afterAll(async()=>{await db?.close();});

describe('Guard append-only evidence and availability, synthetic PGlite validation',()=>{
  it('preserves legacy rows and immutable IDs while allowing same-block corrections',async()=>{
    await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,123,$3,$4,$5)',['legacy-fixture',Buffer.from(coin.slice(2),'hex'),'1.0.2','fixture',JSON.stringify(legacy.Verdict)]);
    await migrate(db);await migrateEngines(db);
    expect((await db.sql.query<{data:unknown}>('SELECT data FROM verdicts WHERE id=$1',['legacy-fixture'])).rows[0].data).toEqual(legacy.Verdict);
    await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,123,$3,$4,$5)',['legacy-correction',Buffer.from(coin.slice(2),'hex'),'1.0.2','corrected','{}']);
    expect((await db.sql.query('SELECT id FROM verdicts WHERE valid_from_block=123')).rows).toHaveLength(2);
    await expect(db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,123,$3,$4,$5)',['legacy-fixture',Buffer.from(coin.slice(2),'hex'),'1.0.2','fixture','{}'])).rejects.toThrow();
    const tables=(await db.sql.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'guard_%'")).rows.map(r=>r.tablename);
    expect(tables).toHaveLength(15);
    expect(tables).toContain('guard_shadow_runs');
  });
  it('replays source keys without mutations/duplicate notifications and verifies content hashes',async()=>{
    const m=await manifest('source-replay'), e=evidence(m,'first');
    const notifications:BusMessage[]=[];const stop=await db.bus.subscribe(msg=>{notifications.push(msg);});
    const first=await source.putEvidence(e.data,e.content);
    const second=await source.putEvidence({...e.data,acquiredAt:'2026-10-01T23:59:59.000Z'},e.content);
    expect(second.id).toBe(first.id);expect(second.recorded_at).toEqual(first.recorded_at);
    expect(notifications).toEqual([{topic:'guard_evidence_created',ids:{id:first.id}}]);
    await expect(source.putEvidence(e.data,new TextEncoder().encode('different'))).rejects.toThrow('content hash');
    await expect(db.sql.query('UPDATE guard_chain_evidence SET data=$1 WHERE id=$2',['{}',first.id])).rejects.toThrow('append-only');
    await expect(db.sql.query('DELETE FROM guard_chain_evidence WHERE id=$1',[first.id])).rejects.toThrow('append-only');
    await stop();
  });
  it('excludes same-second late discovery, full-cursor later boundaries, other forks and replay modes',async()=>{
    const early=await manifest('late-discovery','1'), late=await manifest('late-discovery','2');
    const before=evidence(early,'early'), after=evidence(late,'late');
    await source.putEvidence(before.data,before.content);await source.putEvidence(after.data,after.content);
    expect((await guardRowsKnownAt(db,'guard_chain_evidence',readCut(early))).length).toBe(1);
    expect((await guardRowsKnownAt(db,'guard_chain_evidence',readCut(late))).length).toBe(2);
    const retro=await manifest('late-discovery','3',cursor(),'retrospective'), r=evidence(retro,'retrospective');await source.putEvidence(r.data,r.content);
    expect((await guardRowsKnownAt(db,'guard_chain_evidence',readCut(retro))).length).toBe(1);
    expect((await guardRowsKnownAt(db,'guard_chain_evidence',readCut(late))).length).toBe(2);
    const beforeTx=cursor('123',1,0,'before_tx'),afterTx=cursor('123',1,0,'after_tx');
    expect(compareGuardCursors(beforeTx,afterTx)).toBe(-1);expect(compareGuardCursors(afterTx,cursor())).toBe(-1);
    expect(guardKnownBy({cursor:afterTx,acquisitionSequence:'1'},{cursor:beforeTx,acquisitionSequence:'1'})).toBe(false);
    expect(guardKnownBy({cursor:cursor('122'),acquisitionSequence:'3'},early.cut)).toBe(false);
    const fork={...cursor(),blockHash:guardStorageHash('fork')};
    expect(()=>compareGuardCursors(fork,cursor())).toThrow('fork');
    await expect(guardRowsKnownAt(db,'guard_chain_evidence',{...readCut(early),state:fork})).rejects.toThrow('fork');
  });
  it('stores explicit unknown role/coverage without inventing observations or identities',async()=>{
    const m=await manifest('unknown-role'),bytes=new TextEncoder().encode('synthetic unresolved role'),digest=keccak256(toHex(bytes));
    const template=evidence(m,'unknown-role').data;
    const {evidence:_,...base}=template;
    const role:GuardStoredRole={...base,role:'launch_principal',address:null,status:'missing',evidenceIds:[],payloadHash:digest,objectRef:digest};
    const row=await source.putRole(role,bytes);expect(row.data.address).toBeNull();
    await expect(source.putRole({...role,status:'verified'},bytes)).rejects.toThrow('proved address');
    const coverage={scopeId:'fixture-coverage',from:cursor(),through:cursor(),complete:false,gaps:['missing'] as const,methodVersion:'2.0.0',coveredUnits:null,excludedUnits:null,topLevelNative:false,internalNative:false,firstEverEstablished:false,sourceHashes:[]};
    const stored=await measurements.putCoverage({...base,coverage:{...coverage,gaps:['missing']}});
    expect(stored.data.coverage.coveredUnits).toBeNull();expect(stored.data.coverage.internalNative).toBe(false);
  });
  it('reuses a verdict ID/receipt/recording time, adds runs, and rejects same-key drift',async()=>{
    const m=await manifest('verdict-replay'),e=evidence(m,'verdict-replay'),proof=await source.putEvidence(e.data,e.content);
    const first=await verdicts.putRevision(revision(m,'replay-1',[proof.id]));
    expect(first.data.deterministicInput).toMatchObject({sourceRefs:[expect.objectContaining({id:proof.id,payloadHash:proof.payload_hash,objectRef:proof.object_ref})]});
    expect((first.data.deterministicInput as {sourceRefs:unknown[]}).sourceRefs[0]).not.toHaveProperty('acquiredAt');
    const secondInput={...revision(m,'replay-2',[proof.id],'unused-new-receipt'),recordedAt:'2026-10-02T00:00:01.000Z'};
    const second=await verdicts.putRevision(secondInput);
    expect(second.id).toBe(first.id);expect(second.data.assessment.receipt).toEqual(first.data.assessment.receipt);expect(second.recorded_at).toEqual(first.recorded_at);
    expect((await db.sql.query('SELECT * FROM guard_verdict_runs WHERE revision_id=$1',[first.id])).rows.length).toBe(2);
    await verdicts.putRevision(secondInput);expect((await db.sql.query('SELECT * FROM guard_verdict_runs WHERE revision_id=$1',[first.id])).rows.length).toBe(2);
    const drift=revision(m,'replay-drift',[proof.id]);drift.assessment.decisionHash=guardStorageHash('different-decision');
    await expect(verdicts.putRevision(drift)).rejects.toThrow('different decision');
    await expect(db.sql.query('DELETE FROM guard_verdict_revisions WHERE id=$1',[first.id])).rejects.toThrow('append-only');
  });
  it('appends a new same-block evidence/verdict revision and retains immutable supersession history',async()=>{
    const old=await manifest('same-block','1'),oldProof=evidence(old,'old'),e1=await source.putEvidence(oldProof.data,oldProof.content),v1=await verdicts.putRevision(revision(old,'same-block-1',[e1.id]));
    const next=await manifest('same-block','2'),newProof=evidence(next,'new'),e2=await source.putEvidence(newProof.data,newProof.content);
    const v2=await verdicts.putRevision(revision(next,'same-block-2',[e2.id],'receipt-new',v1.id));
    expect(v2.id).not.toBe(v1.id);expect(v2.data.assessment.cursor.blockNumber).toBe(v1.data.assessment.cursor.blockNumber);
    expect((await guardRowsKnownAt(db,'guard_verdict_revisions',readCut(next))).map(r=>r.id)).toEqual([v2.id]);
    expect((await guardRowsKnownAt(db,'guard_verdict_revisions',{...readCut(old),validity:'historic'})).map(r=>r.id)).toEqual([v1.id]);
    const history=(await db.sql.query<{data:unknown}>('SELECT data FROM guard_verdict_revisions WHERE id=$1',[v1.id])).rows[0].data;
    expect(history).toEqual(v1.data);
    const event=await db.sql.query<{kind:string}>('SELECT kind FROM guard_verdict_events WHERE target_id=$1',[v1.id]);expect(event.rows[0].kind).toBe('superseded');
  });
  it('appends owner-local reorg invalidation through evidence, roles, measurements and verdict dependencies',async()=>{
    const m=await manifest('reorg','1',cursor('124')),e=evidence(m,'orphan-source',cursor('124')),raw=await source.putEvidence(e.data,e.content);
    const derived=evidence(m,'derived-old-state',cursor('122'),[raw.id as `0x${string}`]),measurement=await measurements.putEvidence(derived.data,derived.content);
    const v=await verdicts.putRevision(revision(m,'reorg-run',[measurement.id]));
    const next=await manifest('reorg','2',cursor('125'));
    const reorg:GuardReorg={chainId:4663,fromBlock:'124',...event(next,'reorg-fixture')};
    expect(await source.invalidateReorg(reorg)).toContain(raw.id);
    expect(await measurements.invalidateReorg(reorg)).toContain(measurement.id);
    expect(await verdicts.invalidateReorg(reorg)).toContain(v.id);
    expect(await source.invalidateReorg(reorg)).toEqual([]);
    expect((await guardRowsKnownAt(db,'guard_chain_evidence',readCut(next))).length).toBe(0);
    expect((await guardRowsKnownAt(db,'guard_verdict_revisions',readCut(next))).length).toBe(0);
    expect((await guardRowsKnownAt(db,'guard_verdict_revisions',{...readCut(m),validity:'historic'})).map(r=>r.id)).toEqual([v.id]);
    expect((await db.sql.query<{data:unknown}>('SELECT data FROM guard_verdict_revisions WHERE id=$1',[v.id])).rows[0].data).toEqual(v.data);
  });
  it('invalidates dependent records when a source revision is superseded, with no duplicate events',async()=>{
    const m=await manifest('supersede-source','1',cursor('122')),a=evidence(m,'source-old',cursor('122')),old=await source.putEvidence(a.data,a.content),d=evidence(m,'source-dependent',cursor('122'),[old.id as `0x${string}`]);
    const dependent=await measurements.putEvidence(d.data,d.content);
    const v=await verdicts.putRevision(revision(m,'source-change-run',[dependent.id]));
    const next=await manifest('supersede-source','2',cursor('123')),b=evidence(next,'source-new',cursor('122')),replacement=await source.putEvidence(b.data,b.content);
    const changed=event(next,'source-change');await source.supersede(old.id,replacement.id,changed);
    expect(await measurements.invalidateDependencies(changed)).toContain(dependent.id);
    expect(await verdicts.invalidateDependencies(changed)).toContain(v.id);
    expect(await measurements.invalidateDependencies(changed)).toEqual([]);
    const original=(await db.sql.query<{data:unknown}>('SELECT data FROM guard_chain_evidence WHERE id=$1',[old.id])).rows[0].data;expect(original).toEqual(old.data);
  });
  it('publishes typed ID-only Guard extensions after commit, and none on rollback',async()=>{
    for(const topic of GUARD_BUS_TOPICS){expect(busChannel(topic)).toMatch(/^eko_guard_/);expect(GuardBusEventSchema.safeParse({topic,ids:{id:sourceRevision,prose:'unexpected'}}).success).toBe(false);}
    const messages:BusMessage[]=[];const stop=await db.bus.subscribe(msg=>{messages.push(msg);});
    await expect(db.tx(async tx=>{await tx.notify('guard_evidence_created',{id:sourceRevision});throw new Error('rollback fixture');})).rejects.toThrow('rollback');
    expect(messages).toEqual([]);await stop();
  });
});
