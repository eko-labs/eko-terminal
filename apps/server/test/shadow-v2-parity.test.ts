import { afterEach, expect, it, vi } from 'vitest';
import { binary, migrate, migrateEngines, GuardSourceStore, GuardMeasurementStore, GuardVerdictStore,
  guardManifestId, guardStorageHash, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { keccak256, toHex } from 'viem';
import type { CoinCard } from '@eko/shared';
import { EngineWorker } from '../../engines/src/worker.js';
import { persistShadowGuardV2 } from '../../engines/src/shadow-v2.js';
import { persistShadowGuardV2 as before } from '../../engines/test/reference/shadow-v2-before.js';
import { IncrementalGuardCache } from '../../engines/src/incremental-guard.js';
import { ReadStore } from '../src/read/store.js';
import { GuardReadStore } from '../src/read/guard-store.js';
import { input, observation, address, hash, NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';

// Compare complete persisted rows, including run IDs and receipt bytes, at an identical fixture clock.
vi.mock('node:crypto',async importOriginal=>({...await importOriginal<typeof import('node:crypto')>(),
  randomUUID:()=> '00000000-0000-4000-8000-000000000001'}));
const databases:ChainDb[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();for(const db of databases.splice(0))await db.close();});
async function setup() {
  const db=await openDb({pgliteDir:':memory:'});databases.push(db);await migrate(db);await migrateEngines(db);
  await db.insert('tokens',{address:binary(address(1)),deployer:binary(address(2)),name:'Sample Token',symbol:'DEMO',
    launchpad:'other',decimals:0,first_block:String(NOW),block:String(NOW)});
  await db.insert('chain_blocks',{number:String(NOW),block:String(NOW),hash:binary(hash(NOW)),ts:new Date(NOW*1000)});
  await new EngineWorker(db).processBlock(NOW);
  const card=(await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data;
  return {db,target:{coin:address(1),block:NOW,sec:NOW,legacyVerdictId:card.verdict.receipt.id,replayMode:'production' as const}};
}
const tables=['guard_availability','guard_source_events','guard_chain_evidence','guard_roles','guard_source_coverage',
  'guard_measurement_evidence','guard_check_coverage','guard_measurement_events',
  'guard_verdict_revisions','guard_verdict_runs','guard_verdict_events','guard_receipt_payloads','guard_receipt_anchors',
  'guard_receipt_anchor_events','signal_shadow_runs','coin_cards','coin_card_latest','verdicts','verdict_events','read_coins'];
async function compare(old:ChainDb,current:ChainDb) {
  for(const table of tables)expect((await current.sql.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,table)
    .toEqual((await old.sql.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);
  const readers=(db:ChainDb)=>new GuardReadStore(new ReadStore(db,()=>NOW*1000));
  for(const version of [1,2] as const) {
    expect(await readers(current).negotiatedCard(address(1),version)).toEqual(await readers(old).negotiatedCard(address(1),version));
    expect(await readers(current).negotiatedVerdict(address(1),version)).toEqual(await readers(old).negotiatedVerdict(address(1),version));
  }
}
async function capture(db:ChainDb,sequence='1',envelope=true,partialWatermark=false) {
  const source=input([observation('execution_cost',60)]);source.historySource=null;source.checks=[];
  source.availabilityCut={...source.availabilityCut,acquisitionSequence:sequence};
  const key={sourceId:'parity-fixture',sourceRevision:guardStorageHash({fixture:'parity',sequence}),replayMode:'production' as const,
    cut:source.availabilityCut,watermark:partialWatermark?{...source.cursor,transactionIndex:0,executionOrdinal:0,boundary:'after_tx' as const}:source.cursor};
  const manifest={...key,id:guardManifestId(key),acquiredAt:'2026-10-02T00:00:00.000Z'};
  await new GuardSourceStore(db).putManifest(manifest);
  if(envelope) {
    const content=new TextEncoder().encode(JSON.stringify(source)),digest=keccak256(toHex(content));
    await new GuardMeasurementStore(db).putEvidence({chainId:4663,coin:address(1),manifestId:manifest.id,sourceItemId:'guard-score-inputs',
      sourceRevision:manifest.sourceRevision,cursor:source.cursor,knownAt:manifest.cut,acquiredAt:manifest.acquiredAt,
      methodVersion:'2.0.0',dependencyIds:[],evidence:{id:digest,kind:'state',cursor:source.cursor,knownAt:manifest.cut,
        payloadHash:digest,objectRef:digest,supersedes:null}},content);
  }
  return manifest;
}

it('removes uncaptured scoring and exactly one journal INSERT while preserving all reader rows and both card versions',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
  const old=await setup(),current=await setup();
  const evaluate=vi.spyOn(IncrementalGuardCache.prototype,'evaluate');
  await before(old.db,old.target);expect(evaluate).toHaveBeenCalledTimes(1);evaluate.mockClear();
  const query=vi.spyOn(current.db.sql,'query');
  await persistShadowGuardV2(current.db,current.target);expect(evaluate).not.toHaveBeenCalled();
  expect(query.mock.calls).toHaveLength(2);expect(query.mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);
  await compare(old.db,current.db);
  expect((await old.db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toHaveLength(1);
  expect((await current.db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toEqual([]);
  // A same-block manifest with a different cursor is still uncaptured for this card.
  await capture(current.db,'1',false,true);
  evaluate.mockClear();await persistShadowGuardV2(current.db,current.target);
  expect(evaluate).not.toHaveBeenCalled();
  // Missing-cursor journals keep their prior behavior and remain byte-identical.
  for(const db of [old.db,current.db])await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) VALUES($1,to_timestamp($2),NULL,'activity')",[NOW+2,NOW+2]);
  await before(old.db,{...old.target,block:NOW+2,sec:NOW+2});
  await persistShadowGuardV2(current.db,{...current.target,block:NOW+2,sec:NOW+2});
  expect((await current.db.sql.query('SELECT * FROM guard_shadow_runs WHERE block=$1',[NOW+2])).rows)
    .toEqual((await old.db.sql.query('SELECT * FROM guard_shadow_runs WHERE block=$1',[NOW+2])).rows);
});

it('preserves captured revisions, receipt bytes, journals, signals and served cards with and without a scoring envelope',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
  const old=await setup(),current=await setup();
  await capture(old.db);const manifest=await capture(current.db);
  await before(old.db,old.target);await persistShadowGuardV2(current.db,current.target);await compare(old.db,current.db);
  expect((await current.db.sql.query('SELECT * FROM guard_verdict_revisions')).rows).toHaveLength(1);
  expect((await current.db.sql.query('SELECT * FROM signal_shadow_runs')).rows).toHaveLength(1);
  expect((await current.db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toEqual((await old.db.sql.query('SELECT * FROM guard_shadow_runs')).rows);
  await before(old.db,old.target);await persistShadowGuardV2(current.db,current.target);await compare(old.db,current.db);
  for(const db of [old.db,current.db])await new GuardVerdictStore(db).invalidateReorg({chainId:4663,fromBlock:String(NOW),
    causeId:hash(999),knownAt:manifest.cut,recordedAt:manifest.acquiredAt});
  await compare(old.db,current.db);
  // A captured manifest without a current envelope must still score explicit unknowns.
  const oldEmpty=await setup(),currentEmpty=await setup();await capture(oldEmpty.db,'2',false);await capture(currentEmpty.db,'2',false);
  await before(oldEmpty.db,oldEmpty.target);await persistShadowGuardV2(currentEmpty.db,currentEmpty.target);
  await compare(oldEmpty.db,currentEmpty.db);
  expect((await currentEmpty.db.sql.query('SELECT * FROM guard_verdict_revisions')).rows).toHaveLength(1);
});
