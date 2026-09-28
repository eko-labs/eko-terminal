import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256,toHex } from 'viem';
import { binary,migrate,migrateEngines,GuardSourceStore,GuardMeasurementStore,guardManifestId,guardRowsKnownAt,GuardVerdictStore,guardStorageHash } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { ChainDb } from '@eko/db';
import { CoinCardSchema, VerdictSchema } from '@eko/shared';
import type { CoinCard,GuardStoredEvidence,GuardVerdictRevisionInput } from '@eko/shared';
import { EngineWorker } from '../src/worker.js';
import { persistShadowGuardV2 } from '../src/shadow-v2.js';
import { loadSources } from '../src/sources.js';
import { assembleCard } from '../src/card.js';
import { assembleVerdict,evaluatePlaybooks } from '@eko/playbooks';
import { input,observation,address,hash,NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';

let db:ChainDb; const coin=address(1), block=NOW;
beforeAll(async()=>{
  db=await openDb({pgliteDir:':memory:'}); await migrate(db); await migrateEngines(db);
  await db.insert('tokens',{address:binary(coin),deployer:binary(address(2)),name:'Sample Token',symbol:'DEMO',launchpad:'other',decimals:0,first_block:String(block),block:String(block)});
  await db.insert('chain_blocks',{number:String(block),block:String(block),hash:binary(hash(block)),parent_hash:binary(hash(block-1)),ts:new Date(NOW*1000)});
},30000);
afterAll(async()=>{await db?.close();});

describe('033 engine shadow integration, in-memory only, zero upstream acquisition requests',()=>{
  it('skips uncaptured journals alongside byte-identical V1 card/verdict without adding policy fields',async()=>{
    const s=(await loadSources(db,coin,block))!, matches=evaluatePlaybooks({...s,history:s.history});
    // The worker applies its existing evaluation manifest/receipt. Compare the independent
    // legacy card construction against those exact resulting fields.
    const worker=new EngineWorker(db); await worker.processBlock(block);
    const card=(await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data;
    expect(CoinCardSchema.safeParse(card).success).toBe(true); expect(VerdictSchema.safeParse(card.verdict).success).toBe(true);
    expect(card).toEqual(assembleCard(s,card.verdict)); expect(card.verdict.playbooks).toEqual(matches);
    expect(card.verdict.level).not.toBe('danger'); expect(card.verdict).not.toHaveProperty('guardV2');
    const rows=(await db.sql.query<{data:unknown;manifest_id:null;revision_id:null}>('SELECT * FROM guard_shadow_runs')).rows;
    expect(rows).toHaveLength(0);
    expect((await db.sql.query('SELECT * FROM guard_availability')).rows).toHaveLength(0);
    await worker.processBlock(block,true); expect((await db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toHaveLength(0); // uncaptured replay also does no work
    await worker.processBlock(block,true); expect((await db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toHaveLength(0);
  });
  it('reads captured normalized facts into the revision store, retains shadow High, and never mutates V1',async()=>{
    const before=(await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data;
    const source=input([observation('execution_cost',60)]); source.historySource=null; source.checks=[];
    const key={sourceId:'scoring-fixture',sourceRevision:guardStorageHash({fixture:'033'}),replayMode:'production' as const,cut:source.availabilityCut,watermark:source.cursor};
    const m={...key,id:guardManifestId(key),acquiredAt:'2026-10-02T00:00:00.000Z'}; await new GuardSourceStore(db).putManifest(m);
    const content=new TextEncoder().encode(JSON.stringify(source)), digest=keccak256(toHex(content));
    await new GuardMeasurementStore(db).putEvidence({chainId:4663,coin,manifestId:m.id,sourceItemId:'guard-score-inputs',sourceRevision:m.sourceRevision,
      cursor:source.cursor,knownAt:m.cut,acquiredAt:m.acquiredAt,methodVersion:'2.0.0',dependencyIds:[],
      evidence:{id:digest,kind:'state',cursor:source.cursor,knownAt:m.cut,payloadHash:digest,objectRef:digest,supersedes:null}},content);
    await persistShadowGuardV2(db,{coin,block,sec:NOW,legacyVerdictId:before.verdict.receipt.id,replayMode:'production'});
    const rows=await guardRowsKnownAt<GuardVerdictRevisionInput>(db,'guard_verdict_revisions',{chainId:4663,coin,manifestId:m.id,state:source.cursor,availability:m.cut});
    expect(rows).toHaveLength(1); expect(rows[0].data.assessment).toMatchObject({mode:'shadow',level:'high',baseScore:60,decisiveIds:['severe_cost']});
    expect((await db.sql.query('SELECT data FROM coin_card_latest')).rows[0].data).toEqual(before);
    await persistShadowGuardV2(db,{coin,block,sec:NOW,legacyVerdictId:before.verdict.receipt.id,replayMode:'production'});
    expect((await db.sql.query('SELECT * FROM guard_verdict_revisions')).rows).toHaveLength(1);
    await new GuardVerdictStore(db).invalidateReorg({chainId:4663,fromBlock:String(block),causeId:hash(999),knownAt:m.cut,recordedAt:m.acquiredAt});
    expect(await guardRowsKnownAt(db,'guard_verdict_revisions',{chainId:4663,coin,manifestId:m.id,state:source.cursor,availability:m.cut})).toEqual([]);
    await expect(db.sql.query('UPDATE guard_shadow_runs SET status=$1',['missing_cursor'])).rejects.toThrow('append-only');
    expect((await db.sql.query('SELECT * FROM guard_shadow_runs WHERE revision_id=$1',[rows[0].id])).rows).toHaveLength(1); // historical journal is retained, never used as canonical verdict
  });
  it('does not invent a cursor or assessment for legacy activity with no indexed hash',async()=>{
    const legacy=(await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data;
    await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) VALUES($1,to_timestamp($2),NULL,'activity')",[block+1,NOW+1]);
    await persistShadowGuardV2(db,{coin,block:block+1,sec:NOW+1,legacyVerdictId:legacy.verdict.receipt.id,replayMode:'production'});
    const row=(await db.sql.query<{status:string;data:Record<string,unknown>}>('SELECT * FROM guard_shadow_runs WHERE block=$1',[block+1])).rows[0];
    expect(row.status).toBe('missing_cursor'); expect(row.data).not.toHaveProperty('assessment'); expect(row.data.failureCode).toBe('missing_cursor');
  });
});
