import { binary, type ChainDb } from '@eko/db';
import { referenceDigest } from '@eko/chain';
import { AvailabilityCutSchema, Bytes32Schema, compareGuardCursors, guardKnownBy, type AvailabilityCut, type GuardCursor } from '@eko/shared';
import { evaluateOutcomeLabels, outcomeStreamKey, validateOutcomeInput, type OutcomeLabelInput, type OutcomeLabelRevision } from './outcome-labels.js';

type Job={id:string;stream_id:string;input:OutcomeLabelInput;source_revision:string};
type Row={id:string;job_id:string;revision:number;data:OutcomeLabelRevision;dependency_ids:string[];pins:GuardCursor[]};
function pins(i:OutcomeLabelInput,watermark:AvailabilityCut) {
  return [i.launchCursor,...i.boundaries.map(b=>b.cursor),watermark.cursor,
    ...i.campaigns.flatMap(c=>[c.input.checkpoint.cursor,...c.input.blocks.map(b=>b.cursor)]),
    ...[...i.campaigns,...i.withdrawals,...i.restrictions].flatMap(c=>c.responsibility&&guardKnownBy(c.responsibility.knownAt,i.availabilityCut)?
      [c.responsibility.knownAt.cursor,c.responsibility.effectiveFrom,...(c.responsibility.effectiveThrough?[c.responsibility.effectiveThrough]:[])]:[])];
}
async function canonical(db:ChainDb,cs:GuardCursor[]) {
  const unique=new Map<string,GuardCursor>();
  for(const c of cs) {const key=`${c.chainId}:${c.blockNumber}`,prev=unique.get(key);if(prev&&prev.blockHash!==c.blockHash)return false;unique.set(key,c);}
  for(const c of unique.values())if(await db.blockHash(BigInt(c.blockNumber))!==c.blockHash)return false;
  return true;
}
async function event(db:ChainDb,targetId:string,kind:'orphaned'|'superseded'|'dependency_invalidated',causeId:string,knownAt:AvailabilityCut,replacementId:string|null=null) {
  const body={targetId,kind,causeId,knownAt,replacementId};
  await db.sql.query('INSERT INTO outcome_label_events(id,target_id,kind,cause_id,known_at,replacement_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
    [referenceDigest(body),targetId,kind,causeId,JSON.stringify(knownAt),replacementId]);
}
async function orphanNoncanonical(db:ChainDb,cut:AvailabilityCut) {
  const all=(await db.sql.query<Row>('SELECT * FROM outcome_label_revisions')).rows;
  for(const dependent of all) if(!await canonical(db,dependent.pins)) {
    await event(db,dependent.id,'orphaned',referenceDigest(cut),cut);
    await db.sql.query("UPDATE outcome_label_jobs SET status='orphaned' WHERE id=$1",[dependent.job_id]);
  }
}
async function append(db:ChainDb,job:Job,watermark:AvailabilityCut) {
  const label=evaluateOutcomeLabels(job.input,watermark,true);
  const prior=(await db.sql.query<Row>('SELECT * FROM outcome_label_revisions WHERE stream_id=$1 ORDER BY revision DESC LIMIT 1',[job.stream_id])).rows[0];
  // A worker can never supersede a newer acquisition or turn a retrospective review into a past production record.
  if(prior&&!guardKnownBy(prior.data.knownAt,watermark))throw new Error('Outcome revision clock moved backwards');
  const revision=(prior?.revision??0)+1, supersedes=prior?.id??null;
  const body={label,revision,supersedes,jobId:job.id,sourceRevision:job.source_revision},id=referenceDigest(body);
  const data=label;
  const deps=[...new Set([...job.input.dependencyIds,...job.input.evidenceIds,...job.input.campaigns.flatMap(c=>[...c.input.campaign.evidenceIds,...c.input.checkpoint.evidenceIds]),
    ...[...job.input.entries,...job.input.checkpoints,...job.input.withdrawals,...job.input.restrictions,...job.input.selling.sales].flatMap(p=>p.evidenceIds),
    ...[...job.input.campaigns,...job.input.withdrawals,...job.input.restrictions].flatMap(c=>c.responsibility&&guardKnownBy(c.responsibility.knownAt,job.input.availabilityCut)?c.responsibility.evidenceIds:[])])].sort();
  await db.sql.query('INSERT INTO outcome_label_revisions(id,job_id,stream_id,revision,supersedes,data,dependency_ids,pins) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id,job.id,job.stream_id,revision,supersedes,JSON.stringify(data),JSON.stringify(deps),JSON.stringify(pins(job.input,watermark))]);
  if(prior)await event(db,prior.id,'superseded',id,watermark,id);
  return {revisionId:id,revision,supersedes,label:data};
}

// TODO(spec): §4 specifies a timer, not its public API. Explicit bounded calls keep
// V2 shadow/inactive and require acquired checkpoint revisions; the ordinary worker does not start this queue.
export async function enqueueOutcomeLabels(db:ChainDb,raw:OutcomeLabelInput,sourceRevision:string) {
  const input=validateOutcomeInput(raw);
  if(!/^[0-9a-f]{40}$/.test(sourceRevision))throw new Error('Outcome source revision required');
  const id=referenceDigest({input,sourceRevision}),stream=outcomeStreamKey(input);
  return db.tx(async tx=>{
    // Serialize the stream before checking/inserting, including empty streams.
    await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))',[stream]);
    if(!await canonical(tx,pins(input,input.availabilityCut)))throw new Error('Outcome enqueue canonical mismatch');
    const existing=(await tx.sql.query('SELECT id FROM outcome_label_jobs WHERE id=$1',[id])).rows[0];
    if(existing)return id;
    const newer=(await tx.sql.query<Row>('SELECT * FROM outcome_label_revisions WHERE stream_id=$1 ORDER BY revision DESC LIMIT 1',[stream])).rows[0];
    if(newer&&(!guardKnownBy(newer.data.availabilityCut,input.availabilityCut)||!guardKnownBy(newer.data.knownAt,input.availabilityCut)))throw new Error('Outcome capture moved backwards');
    const target=BigInt(input.launchCursor.timestampSec)+BigInt(input.horizonSec),maturity=input.boundaries.find(b=>BigInt(b.cursor.timestampSec)>=target)?.cursor;
    const due=maturity?BigInt(maturity.timestampSec)+30n:target;
    await tx.sql.query("INSERT INTO outcome_label_jobs(id,stream_id,coin,source_revision,input,next_due_sec,status) VALUES($1,$2,$3,$4,$5,$6,'queued')",
      [id,stream,binary(input.coin),sourceRevision,JSON.stringify(input),due.toString()]);
    await append(tx,{id,stream_id:stream,input,source_revision:sourceRevision},input.availabilityCut);
    if(!await canonical(tx,pins(input,input.availabilityCut)))throw new Error('Outcome capture canonical mismatch');
    return id;
  });
}

/** One timer job per call, including on empty blocks. Missing follow-up is explicitly indeterminate/censored. */
export async function runOutcomeMaturityQueue(db:ChainDb,rawWatermark:AvailabilityCut) {
  const watermark=AvailabilityCutSchema.parse(rawWatermark);
  if(watermark.cursor.boundary!=='block_end')throw new Error('Outcome timer requires completed watermark');
  return db.tx(async tx=>{
    const job=(await tx.sql.query<Job>("SELECT * FROM outcome_label_jobs WHERE status='queued' AND next_due_sec<=$1 ORDER BY next_due_sec,id LIMIT 1 FOR UPDATE SKIP LOCKED",[watermark.cursor.timestampSec])).rows[0];
    if(!job)return null;
    const input=validateOutcomeInput(job.input);
    if(referenceDigest({input,sourceRevision:job.source_revision})!==job.id||outcomeStreamKey(input)!==job.stream_id)throw new Error('Outcome queue digest mismatch');
    await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))',[job.stream_id]);
    if(!guardKnownBy(input.availabilityCut,watermark))throw new Error('Outcome timer precedes input');
    if(!await canonical(tx,pins(input,watermark))) {
      await orphanNoncanonical(tx,watermark);
      await tx.sql.query("UPDATE outcome_label_jobs SET status='orphaned' WHERE id=$1",[job.id]);
      return {jobId:job.id,status:'orphaned' as const,result:null};
    }
    const latest=(await tx.sql.query<Row>('SELECT * FROM outcome_label_revisions WHERE stream_id=$1 ORDER BY revision DESC LIMIT 1',[job.stream_id])).rows[0];
    if(latest&&latest.job_id!==job.id) {
      // A newer acquired input supersedes this pending timer; do not replay stale checkpoints over it.
      await tx.sql.query("UPDATE outcome_label_jobs SET status='completed' WHERE id=$1",[job.id]);
      return {jobId:job.id,status:'superseded' as const,result:null};
    }
    const result=await append(tx,job,watermark);
    if(!await canonical(tx,pins(input,watermark)))throw new Error('Outcome confirmation canonical mismatch');
    await tx.sql.query("UPDATE outcome_label_jobs SET status='completed' WHERE id=$1",[job.id]);
    return {jobId:job.id,status:'completed' as const,result};
  });
}

/** Canonical recheck on reads, immutable orphan annotations for every dependent snapshot/label. */
export async function readOutcomeLabels(db:ChainDb,streamId:string,rawCut:AvailabilityCut) {
  const cut=AvailabilityCutSchema.parse(rawCut);
  return db.tx(async tx=>{
    const rows=(await tx.sql.query<Row>('SELECT * FROM outcome_label_revisions WHERE stream_id=$1 ORDER BY revision DESC',[streamId])).rows;
    for(const row of rows) {
      if(BigInt(row.data.knownAt.cursor.blockNumber)>BigInt(cut.cursor.blockNumber)||BigInt(row.data.knownAt.acquisitionSequence)>BigInt(cut.acquisitionSequence))continue;
      const events=(await tx.sql.query<{kind:string;known_at:AvailabilityCut}>('SELECT kind,known_at FROM outcome_label_events WHERE target_id=$1',[row.id])).rows;
      if(events.some(e=>e.kind!=='superseded'&&BigInt(e.known_at.cursor.blockNumber)<=BigInt(cut.cursor.blockNumber)&&BigInt(e.known_at.acquisitionSequence)<=BigInt(cut.acquisitionSequence)))return null;
      if(!await canonical(tx,row.pins)) {
        await orphanNoncanonical(tx,cut);
        return null;
      }
      if(!await canonical(tx,[cut.cursor]))return null;
      if(!guardKnownBy(row.data.knownAt,cut))continue;
      const {id:labelId,...body}=row.data;
      if(referenceDigest(body)!==labelId)throw new Error('Outcome revision digest mismatch');
      return row.data;
    }
    return null;
  });
}

export async function invalidateOutcomeDependency(db:ChainDb,dependencyId:string,rawCut:AvailabilityCut) {
  const dep=Bytes32Schema.parse(dependencyId),cut=AvailabilityCutSchema.parse(rawCut);
  return db.tx(async tx=>{
    const rows=(await tx.sql.query<Row>('SELECT * FROM outcome_label_revisions WHERE dependency_ids @> $1::jsonb',[JSON.stringify([dep])])).rows;
    for(const r of rows){if(!guardKnownBy(r.data.knownAt,cut))throw new Error('Outcome invalidation precedes revision');await event(tx,r.id,'dependency_invalidated',dep,cut);}
    const jobs=[...new Set(rows.map(r=>r.job_id))];
    for(const id of jobs)await tx.sql.query("UPDATE outcome_label_jobs SET status='orphaned' WHERE id=$1",[id]);
    return rows.map(r=>r.id);
  });
}
