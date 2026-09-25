import { readFile } from 'node:fs/promises';
import { expect,it } from 'vitest';
import { binary,type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { replayPonsCampaign } from '@eko/chain';
import { enqueueCampaignReplay,runQueuedCampaignReplay,readCampaignReplay,campaignControlEligibility } from '../src/campaign-replay.js';
import type { QualifiedGraphSnapshot } from '../src/qualified-graphs.js';
import { fixture,seller,buyer,block } from '../../../packages/chain/test/campaign-fixtures.js';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
const revision='a'.repeat(40);
const measured=()=>({...fixture(),origin:'measured' as const});
it('queues immutable inputs explicitly, resumes once, retains normalized results and rejects orphaned pins',async()=>{
 const db=await openDb({pgliteDir:':memory:'});
 try {
  const sql=await readFile(new URL('../../../packages/db/drizzle/0161_campaign_replay.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.sql.query(statement);
  let canonical=true;const input=measured();
  // Real table/transactions; pin source is a bounded synthetic block registry, not acquired chain evidence.
  const pinned=Object.assign(Object.create(db),{blockHash:async(n:bigint)=>canonical?[input.checkpoint.cursor,...input.blocks.map(b=>b.cursor)].find(c=>BigInt(c.blockNumber)===n)?.blockHash??null:hash('reorg')}) as ChainDb;
  pinned.tx=async work=>db.tx(tx=>work(Object.assign(Object.create(tx),{blockHash:pinned.blockHash}) as ChainDb));
  await expect(enqueueCampaignReplay(pinned,fixture(),revision)).rejects.toThrow('Fixture');
  const id=await enqueueCampaignReplay(pinned,input,revision);expect(await enqueueCampaignReplay(pinned,input,revision)).toBe(id);
  expect((await db.sql.query('SELECT * FROM campaign_replay_jobs')).rows).toHaveLength(1);
  const result=await runQueuedCampaignReplay(pinned);expect(result!.status).toBe('completed');expect(result!.result!.mode).toBe('shadow');
  expect(await runQueuedCampaignReplay(pinned)).toBeNull();expect((await readCampaignReplay(pinned,id))!.id).toBe(result!.result!.id);
  const resumed=await enqueueCampaignReplay(pinned,input,'c'.repeat(40));
  const transactional=pinned.tx;let interrupt=true;
  pinned.tx=async work=>db.tx(async tx=>{const output=await work(Object.assign(Object.create(tx),{blockHash:pinned.blockHash}) as ChainDb);if(interrupt)throw new Error('worker interrupted');return output;});
  await expect(runQueuedCampaignReplay(pinned)).rejects.toThrow('worker interrupted');
  expect((await db.sql.query('SELECT status FROM campaign_replay_jobs WHERE id=$1',[resumed])).rows[0].status).toBe('queued');
  interrupt=false;expect((await runQueuedCampaignReplay(pinned))!.result!.id).toBe(result!.result!.id);pinned.tx=transactional;
  canonical=false;expect(await readCampaignReplay(pinned,id)).toBeNull();await expect(enqueueCampaignReplay(pinned,input,revision)).rejects.toThrow('pin mismatch');
  canonical=true;const next=await enqueueCampaignReplay(pinned,input,'b'.repeat(40));canonical=false;
  expect(await runQueuedCampaignReplay(pinned)).toEqual({id:next,status:'orphaned',result:null});
  expect((await db.sql.query('SELECT input FROM campaign_replay_jobs WHERE id=$1',[id])).rows[0].input).toEqual(input);
 }finally{await db.close();}
});
it('requires accepted prior control, never origin/coordination or future collector evidence, for own-side eligibility',()=>{
 const input=measured();input.campaign.fidelityAccepted=true;
 const result=replayPonsCampaign(input),principal=buyer;
 const graph:QualifiedGraphSnapshot={graphVersion:'qualified-graphs-1',coin:input.coin,at:{cursor:input.checkpoint.cursor,acquisitionSequence:'0'},mode:'shadow',edges:[],observedConnections:[],retired:[],issues:[],
  components:[{id:hash('control-component'),kind:'control',memberIds:[principal,seller],edgeIds:[],graphVersion:'qualified-graphs-1',supersedes:[],participants:[],groupScoringEligible:false,historyEligible:true,diagnostics:[]}]};
 expect(campaignControlEligibility(input,result,graph,principal,true)).toBe(true);
 for(const kind of ['origin','coordination'] as const)expect(campaignControlEligibility(input,result,{...graph,components:[{...graph.components[0],kind}]},principal,true)).toBe(false);
 expect(campaignControlEligibility(input,result,graph,principal,false)).toBe(false);
 expect(campaignControlEligibility(input,result,{...graph,at:{cursor:block(100,1000),acquisitionSequence:'0'}},principal,true)).toBe(false);
 expect(campaignControlEligibility(input,result,null,principal,true)).toBe(false);
 expect(campaignControlEligibility(input,replayPonsCampaign(fixture()),graph,principal,true)).toBe(false);
});
it('rejects tampered queue identity without executing the candidate',async()=>{
 const input=measured(),job={id:hash('tampered'),input,source_revision:revision};
 const db={tx:async(work:(db:unknown)=>Promise<unknown>)=>work(db),sql:{query:async()=>({rows:[job]})}} as unknown as ChainDb;
 await expect(runQueuedCampaignReplay(db)).rejects.toThrow('digest mismatch');
});
