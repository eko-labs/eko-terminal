import { readFile } from 'node:fs/promises';
import { expect,it } from 'vitest';
import { type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { enqueueOutcomeLabels,runOutcomeMaturityQueue,readOutcomeLabels,invalidateOutcomeDependency } from '../src/outcome-queue.js';
import { outcomeStreamKey } from '../src/outcome-labels.js';
import { outcomeFixture,confirmation } from './outcome-fixtures.js';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
const revision='a'.repeat(40);

async function setup() {
 const db=await openDb({pgliteDir:':memory:'});
 await db.sql.query("CREATE FUNCTION guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END; $$");
 const sql=await readFile(new URL('../../../packages/db/drizzle/0168_outcome_labels.sql',import.meta.url),'utf8');
 for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.sql.query(statement);
 const input=outcomeFixture(),watermark=confirmation(input),registry=new Map([...input.boundaries.map(b=>b.cursor),watermark.cursor].map(c=>[c.blockNumber,c.blockHash]));
 const pinned=Object.assign(Object.create(db),{blockHash:async(n:bigint)=>registry.get(String(n))??null}) as ChainDb;
 pinned.tx=async work=>db.tx(tx=>work(Object.assign(Object.create(tx),{blockHash:pinned.blockHash}) as ChainDb));
 return {db,pinned,input,watermark,registry};
}
it('persists independent fixture revisions, matures without trades, resumes transactionally and preserves as-of results',async()=>{
 const {db,pinned,input,watermark}=await setup();
 try {
  const id=await enqueueOutcomeLabels(pinned,input,revision);expect(await enqueueOutcomeLabels(pinned,input,revision)).toBe(id);
  expect((await db.sql.query('SELECT * FROM outcome_label_jobs')).rows).toHaveLength(1);
  const stream=outcomeStreamKey(input),initial=await readOutcomeLabels(pinned,stream,input.availabilityCut);
  expect(initial!.records.find(r=>r.kind==='survived')!.status).toBe('provisional');
  expect(await runOutcomeMaturityQueue(pinned,input.availabilityCut)).toBeNull();
  const originalTx=pinned.tx;
  pinned.tx=async work=>db.tx(async tx=>{await work(Object.assign(Object.create(tx),{blockHash:pinned.blockHash}) as ChainDb);throw new Error('interrupted fixture');});
  await expect(runOutcomeMaturityQueue(pinned,watermark)).rejects.toThrow('interrupted');
  expect((await db.sql.query('SELECT status FROM outcome_label_jobs')).rows[0].status).toBe('queued');
  expect((await db.sql.query('SELECT * FROM outcome_label_revisions')).rows).toHaveLength(1);pinned.tx=originalTx;
  const result=await runOutcomeMaturityQueue(pinned,watermark);expect(result!.status).toBe('completed');
  expect(result!.result!.label.records.find(r=>r.kind==='survived')!.status).toBe('confirmed_under_policy');
  expect(result!.result!.label.records.every(r=>!r.historyEligible)).toBe(true);expect(await runOutcomeMaturityQueue(pinned,watermark)).toBeNull();
  expect((await readOutcomeLabels(pinned,stream,input.availabilityCut))!.id).toBe(initial!.id);
  expect((await readOutcomeLabels(pinned,stream,watermark))!.id).toBe(result!.result!.label.id);
  expect((await db.sql.query('SELECT revision FROM outcome_label_revisions ORDER BY revision')).rows.map(r=>r.revision)).toEqual([1,2]);
  await expect(db.sql.query('DELETE FROM outcome_label_revisions')).rejects.toThrow('append-only');
  await expect(db.sql.query("UPDATE outcome_label_events SET kind='orphaned'")).rejects.toThrow('append-only');
 }finally{await db.close();}
});
it('canonical recheck invalidates all dependent revisions across horizons and retains original records',async()=>{
 const {db,pinned,input,watermark,registry}=await setup();
 try {
  await enqueueOutcomeLabels(pinned,input,revision);await runOutcomeMaturityQueue(pinned,watermark);
  const other={...input,eventId:hash('second-outcome-event')};await enqueueOutcomeLabels(pinned,other,revision);
  const before=(await db.sql.query('SELECT data FROM outcome_label_revisions ORDER BY id')).rows;
  registry.set(input.boundaries[2].cursor.blockNumber,hash('reorg'));
  expect(await readOutcomeLabels(pinned,outcomeStreamKey(input),watermark)).toBeNull();
  expect((await db.sql.query("SELECT * FROM outcome_label_events WHERE kind='orphaned'")).rows).toHaveLength(3);
  expect((await db.sql.query('SELECT data FROM outcome_label_revisions ORDER BY id')).rows).toEqual(before);
  expect(await readOutcomeLabels(pinned,outcomeStreamKey(other),watermark)).toBeNull();
  await expect(enqueueOutcomeLabels(pinned,input,'b'.repeat(40))).rejects.toThrow('canonical mismatch');
 }finally{await db.close();}
});
it('explicit dependency invalidation reaches every revision and prevents pending timers from confirming it',async()=>{
 const {db,pinned,input,watermark}=await setup();
 try {
  await enqueueOutcomeLabels(pinned,input,revision);await runOutcomeMaturityQueue(pinned,watermark);
  const affected=await invalidateOutcomeDependency(pinned,input.dependencyIds[0],watermark);expect(affected).toHaveLength(2);
  expect(await readOutcomeLabels(pinned,outcomeStreamKey(input),watermark)).toBeNull();
  expect((await db.sql.query("SELECT * FROM outcome_label_events WHERE kind='dependency_invalidated'")).rows).toHaveLength(2);
  expect(await runOutcomeMaturityQueue(pinned,watermark)).toBeNull();
 }finally{await db.close();}
});
it('new acquired checkpoint revisions supersede pending jobs; an old timer cannot overwrite newer evidence',async()=>{
 const {db,pinned,input,watermark}=await setup();
 try {
  const old=await enqueueOutcomeLabels(pinned,input,revision);
  const updated=structuredClone(input);updated.availabilityCut={...input.availabilityCut,acquisitionSequence:'3'};
  updated.coverage.archive=false;await enqueueOutcomeLabels(pinned,updated,revision);
  const first=await runOutcomeMaturityQueue(pinned,watermark),second=await runOutcomeMaturityQueue(pinned,watermark);
  expect([first!.status,second!.status].sort()).toEqual(['completed','superseded']);
  expect((await db.sql.query('SELECT status FROM outcome_label_jobs WHERE id=$1',[old])).rows[0].status).toBe('completed');
  const completed=[first,second].find(r=>r!.status==='completed')!;
  expect(completed!.result!.label.records.find(r=>r.kind==='survived')!.status).toBe('censored');
  expect((await readOutcomeLabels(pinned,outcomeStreamKey(input),watermark))!.availabilityCut.acquisitionSequence).toBe('3');
 }finally{await db.close();}
});
