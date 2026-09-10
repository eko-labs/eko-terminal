import { createHash, randomUUID } from 'node:crypto';
import { PlaybookIdSchema, type Address, type CoinCard, type ScanResult } from '@eko/shared';
import { binary, hex } from './types.js';
import type { ChainDb } from './client.js';

export interface ScanJob {
  id:string; query:string; coin:Uint8Array|null; phase:'queued'|'acquiring'|'evaluating'|'running'|'waiting'|'done';
  status:ScanResult['status']; created_at:Date; first_pending_at:Date|null; started_at:Date|null; finished_at:Date|null;
  lease_id:string|null; lease_until:Date|null; attempts:number; last_error:string|null;
}
export class ScanQueueFull extends Error { readonly statusCode=429; constructor(){super('Scan queue is full. Retry later.');} }
export class ScanJobs {
  // TODO(spec): Queue admission/lease/retry defaults are unspecified; use 256 active targets, 30s leases and three attempts per lane.
  constructor(readonly db:ChainDb, readonly now:()=>number=Date.now, readonly capacity=256) {}
  async ensure(query:string,coin:Address|undefined,status:ScanResult['status']) {
    const key=coin ?? query;
    const id=`scan-${createHash('sha256').update(key).digest('hex')}`;
    return this.db.tx(async tx=>{
      await tx.sql.query('LOCK TABLE scan_jobs IN SHARE ROW EXCLUSIVE MODE');
      const existing=(await tx.sql.query<ScanJob>('SELECT * FROM scan_jobs WHERE id=$1 OR ($2::bytea IS NOT NULL AND coin=$2)',[id,coin ? binary(coin) : null])).rows[0];
      if(existing)return existing;
      if(status==='pending') {
        const count=(await tx.sql.query<{n:string}>("SELECT count(*) AS n FROM scan_jobs WHERE phase IN ('queued','acquiring','evaluating','running')")).rows[0];
        if(Number(count.n)>=this.capacity)throw new ScanQueueFull();
      }
      return (await tx.sql.query<ScanJob>('INSERT INTO scan_jobs(id,query,coin,phase,status,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id,query,coin ? binary(coin) : null,status==='pending' ? 'queued' : 'done',status,new Date(this.now())])).rows[0];
    });
  }
  async get(id:string) {return (await this.db.sql.query<ScanJob>('SELECT * FROM scan_jobs WHERE id=$1',[id])).rows[0];}
  async claim(lane:'acquisition'|'engine') {
    const queued=lane==='acquisition' ? 'queued' : 'evaluating', running=lane==='acquisition' ? 'acquiring' : 'running';
    const lease=randomUUID();
    return this.db.tx(async tx=>{
      const job=(await tx.sql.query<ScanJob>(`SELECT * FROM scan_jobs WHERE coin IS NOT NULL AND
        (phase=$1 OR (phase=$2 AND lease_until<=$3)) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[queued,running,new Date(this.now())])).rows[0];
      if(!job)return;
      // Expired last attempts are retained as missing work, never manufactured not_found/ready.
      if(job.attempts>=3){await tx.sql.query("UPDATE scan_jobs SET phase='waiting',lease_id=NULL,lease_until=NULL,last_error='retry_limit' WHERE id=$1",[job.id]);return;}
      return (await tx.sql.query<ScanJob>('UPDATE scan_jobs SET phase=$2,lease_id=$3,lease_until=$4,started_at=coalesce(started_at,$5),attempts=attempts+1 WHERE id=$1 RETURNING *',
        [job.id,running,lease,new Date(this.now()+30_000),new Date(this.now())])).rows[0];
    });
  }
  async finish(job:ScanJob,phase:'evaluating'|'waiting'|'done',status:ScanResult['status'],error:string|null=null) {
    return (await this.db.sql.query('UPDATE scan_jobs SET phase=$3,status=$4,last_error=$5,lease_id=NULL,lease_until=NULL,attempts=CASE WHEN $3=\'evaluating\' THEN 0 ELSE attempts END,finished_at=CASE WHEN $3=\'done\' THEN $6::timestamptz ELSE NULL END WHERE id=$1 AND lease_id=$2 RETURNING id',
      [job.id,job.lease_id,phase,status,error,new Date(this.now())])).rows.length>0;
  }
  async fail(job:ScanJob,lane:'acquisition'|'engine') {
    await this.db.sql.query("UPDATE scan_jobs SET phase=CASE WHEN attempts>=3 THEN 'waiting' ELSE $3 END,lease_id=NULL,lease_until=NULL,last_error='acquisition_unavailable' WHERE id=$1 AND lease_id=$2",[job.id,job.lease_id,lane==='acquisition' ? 'queued' : 'evaluating']);
  }
}

/** Checks without an input source yet (apps/engines card.ts UNSOURCED_PLAYBOOKS); completion does not wait for them. */
const UNSOURCED_PLAYBOOKS:string[]=[];
/** Completion requires measured buying checks; a persisted pending/danger card alone is insufficient. */
export function scanChecksComplete(card:CoinCard) {
  return card.verdict.level!=='pending' && new Set([...(card.verdict.evaluatedPlaybooks ?? []),...UNSOURCED_PLAYBOOKS]).size===PlaybookIdSchema.options.length &&
    ['tradeability','control','liquidity','supply'].every(section=>{
      const meta=card.meta?.[section as keyof NonNullable<CoinCard['meta']>];
      return !!meta && !meta.unavailable && !meta.missing?.length;
    });
}
/** Called after the card transaction commits, never from retrospective replay. */
export async function recordScanVerdict(db:ChainDb,card:CoinCard,now=Date.now()) {
  const complete=scanChecksComplete(card);
  const row=(await db.sql.query<{discovered_at:Date;critical_complete_at:Date|null}>(`UPDATE scan_timings SET
    first_verdict_at=coalesce(first_verdict_at,$2),critical_complete_at=CASE WHEN $3 THEN coalesce(critical_complete_at,$2) ELSE critical_complete_at END,
    verdict_id=CASE WHEN critical_complete_at IS NULL THEN $4 ELSE verdict_id END
    WHERE coin=$1 AND discovery_block<=$5 AND (first_verdict_at IS NULL OR ($3 AND critical_complete_at IS NULL)) RETURNING discovered_at,critical_complete_at`,
    [binary(card.identity.address),new Date(now),complete,card.verdict.receipt.id,card.verdict.asOfBlock])).rows[0];
  await db.sql.query("UPDATE scan_jobs SET status='ready',phase='done',finished_at=coalesce(finished_at,$2),lease_id=NULL,lease_until=NULL WHERE coin=$1 AND status='pending'",[binary(card.identity.address),new Date(now)]);
  return row?.critical_complete_at ? Math.max(0,new Date(row.critical_complete_at).getTime()-new Date(row.discovered_at).getTime()) : undefined;
}
export const scanTarget=(job:ScanJob)=>job.coin ? hex(job.coin) as Address : undefined;

/** Discovery-to-worker-start is distinct from acquisition/check execution and first output. */
export async function recordScanStart(db:ChainDb,coin:Address,now=Date.now()) {
  await db.sql.query('UPDATE scan_timings SET engine_started_at=coalesce(engine_started_at,$2) WHERE coin=$1 AND engine_started_at IS NULL',[binary(coin),new Date(now)]);
}
