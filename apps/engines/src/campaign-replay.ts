import { binary, type ChainDb } from '@eko/db';
import { CampaignReplayInputSchema, referenceDigest, replayPonsCampaign, type CampaignReplayInput, type CampaignReplayResult } from '@eko/chain';
import { guardKnownBy } from '@eko/shared';
import type { QualifiedGraphSnapshot } from './qualified-graphs.js';

/** Responsibility uses only qualified control; coordination and FIFO origin cannot grant it. */
export function campaignControlEligibility(input:CampaignReplayInput,result:CampaignReplayResult,graph:QualifiedGraphSnapshot|null,principal:string|null,precisionAccepted=false) {
  if(!result.attributionAvailable||!graph||!principal||!precisionAccepted||graph.coin!==input.coin||
    !guardKnownBy(graph.at,{cursor:input.campaign.from,acquisitionSequence:input.knownAt.acquisitionSequence}))return false;
  return graph.components.some(c=>c.kind==='control'&&c.historyEligible&&c.memberIds.includes(principal as `0x${string}`)&&input.campaign.sellingSide.every(a=>c.memberIds.includes(a)));
}
async function canonical(db:ChainDb,i:CampaignReplayInput) {
  for(const c of [i.checkpoint.cursor,...i.blocks.map(b=>b.cursor)])if(await db.blockHash(BigInt(c.blockNumber))!==c.blockHash) return false;
  return true;
}
// TODO(spec): no public campaign queue API is specified. This explicit engines-only queue
// retains normalized reconstruction inputs/results, never full provider traces or active labels.
export async function enqueueCampaignReplay(db:ChainDb,raw:CampaignReplayInput,sourceRevision:string) {
  const input=CampaignReplayInputSchema.parse(raw);
  if(input.origin!=='measured')throw new Error('Fixture campaign cannot enter measured queue');
  if(!/^[0-9a-f]{40}$/.test(sourceRevision))throw new Error('Source revision required');
  const id=referenceDigest({methodVersion:input.methodVersion,input,sourceRevision});
  await db.tx(async tx=>{
    if(!await canonical(tx,input))throw new Error('Campaign enqueue pin mismatch');
    await tx.sql.query(`INSERT INTO campaign_replay_jobs(id,coin,source_revision,input) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
      [id,binary(input.coin),sourceRevision,JSON.stringify(input)]);
  });
  return id;
}
/** Bounded opt-in drain; row lock and result update share one transaction, so crashes retry safely. */
export async function runQueuedCampaignReplay(db:ChainDb) {
  return db.tx(async tx=>{
    const job=(await tx.sql.query<{id:string;input:unknown;source_revision:string}>(
      "SELECT id,input,source_revision FROM campaign_replay_jobs WHERE status='queued' ORDER BY queued_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
    if(!job)return null;
    const input=CampaignReplayInputSchema.parse(job.input);
    if(input.origin!=='measured'||referenceDigest({methodVersion:input.methodVersion,input,sourceRevision:job.source_revision})!==job.id)throw new Error('Campaign queue digest mismatch');
    if(!await canonical(tx,input)) {
      await tx.sql.query("UPDATE campaign_replay_jobs SET status='orphaned',completed_at=now() WHERE id=$1",[job.id]);
      return {id:job.id,status:'orphaned' as const,result:null};
    }
    const result=replayPonsCampaign(input);
    if(!await canonical(tx,input))throw new Error('Campaign completion pin mismatch');
    await tx.sql.query("UPDATE campaign_replay_jobs SET status='completed',result=$2,completed_at=now() WHERE id=$1",[job.id,JSON.stringify(result)]);
    return {id:job.id,status:'completed' as const,result};
  });
}
/** Read paths recheck pins; an immutable old result is never served as canonical after reorg. */
export async function readCampaignReplay(db:ChainDb,id:string) {
  const row=(await db.sql.query<{input:unknown;result:CampaignReplayResult|null}>("SELECT input,result FROM campaign_replay_jobs WHERE id=$1 AND status='completed'",[id])).rows[0];
  if(!row?.result)return null;
  const input=CampaignReplayInputSchema.parse(row.input),{id:resultId,...body}=row.result;
  if(referenceDigest(body)!==resultId||row.result.inputDigest!==referenceDigest(input))throw new Error('Campaign result digest mismatch');
  return await canonical(db,input)?row.result:null;
}
