import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, migrateEngines, binary, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { Address, Hex } from 'viem';
import { writeRegistryLabels, walletLabelsAt, REGISTRY_LABEL_MODEL } from '../src/registry-labels.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const owner=address(1),wallet=address(2),next=address(3),zero=address(0);
let db:ChainDb;
beforeEach(async()=>{db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);});
afterEach(async()=>{await db.close();});
const snapshot=async(id:number,block:number,w:Address,registered=5,fork=0)=>db.insert('agent_registry',{
  agent_id:String(id),owner:binary(owner),wallet:binary(w),token_uri:null,registered_block:String(registered),wallet_block:String(block),block:String(block),block_hash:binary(hash(block+fork)),
  evidence:JSON.stringify({registration:{block:registered,txHash:hash(100+id),logIndex:id},read:{block,blockHash:hash(block+fork),boundary:'block_end'}}),
});
const label=async(a:Address,b:number)=>(await walletLabelsAt(db,[a],BigInt(b)))[0];
describe('Watcher-owned point-in-time declarations',()=>{
  it('labels the declared wallet at 0.99 from wallet_block, preserving qualified crew evidence',async()=>{
    await snapshot(1,8,wallet);
    const crew={status:'qualified' as const,crewId:'crew_fixture',confidence:0.95,evidence:{kind:'qualified_coordination'}};
    await writeRegistryLabels(db,{crewAt:async()=>crew});
    expect(await label(owner,20)).toBeUndefined();expect(await label(zero,20)).toBeUndefined();expect(await label(wallet,7)).toBeUndefined();
    expect(await label(wallet,8)).toMatchObject({label:'declared_agent',confidence:0.99,tier:'high',crew_id:'crew_fixture',source:'erc8004',valid_from_block:'8',features:{permissionlessDeclaration:true,behavioralInference:false,crewEvidence:crew.evidence}});
    expect((await label(wallet,8)).features.registration).toMatchObject([{agentId:'1',registeredBlock:'5',walletBlock:'8'}]);
  });
  it('closes old wallets on transfer/change and restores independent evidence',async()=>{
    await db.sql.query("INSERT INTO wallet_labels VALUES('behavior-fixture',$1,'likely_agent',0.8,'medium','fingerprint',NULL,'{}','fp-fixture',1)",[binary(wallet)]);
    await snapshot(1,5,wallet);await snapshot(1,8,next);await snapshot(1,12,zero);
    await writeRegistryLabels(db);
    expect((await label(wallet,7)).label).toBe('declared_agent');expect(await label(wallet,8)).toMatchObject({label:'likely_agent',confidence:0.8});
    expect((await label(next,11)).label).toBe('declared_agent');expect(await label(next,12)).toMatchObject({label:'human',confidence:0,tier:null,features:{withdrawn:true,unclassified:true}});
    expect(await label(zero,20)).toBeUndefined();
  });
  it('restores independent evidence only while its fingerprint run depends on canonical blocks',async()=>{
    // The behaviour label comes from a fingerprint run that read block 4. When block 4 is no longer the block it read
    // (a reorganisation), the label is unavailable and the wallet reads as withdrawn once the declaration moves on.
    const seed=async(canonical:boolean)=>{
      await db.sql.query("INSERT INTO wallet_labels VALUES('behavior-fixture',$1,'likely_agent',0.8,'medium','fingerprint',NULL,'{}','fp-fixture',1)",[binary(wallet)]);
      await db.sql.query("INSERT INTO wallet_fingerprint_runs(id,address,block,block_hash,model_version,input_hash,features,score) VALUES('run-fixture',$1,4,$2,'fp-fixture','input','{}',0.8)",[binary(wallet),binary(hash(4))]);
      await db.sql.query("INSERT INTO wallet_fingerprint_dependencies VALUES('run-fixture',4,$1)",[binary(hash(4))]);
      await db.sql.query("INSERT INTO wallet_label_fingerprint_dependencies VALUES('behavior-fixture','run-fixture')");
      await db.insert('chain_blocks',{number:'4',block:'4',hash:binary(hash(canonical?4:404)),parent_hash:null,ts:new Date(0)});
      await snapshot(1,5,wallet);await snapshot(1,8,next);
      await writeRegistryLabels(db);
    };
    await seed(true);
    expect(await label(wallet,8)).toMatchObject({label:'likely_agent',confidence:0.8});
    await db.close();db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
    await seed(false);
    expect(await label(wallet,8)).toMatchObject({label:'human',confidence:0,features:{withdrawn:true}});
  });
  it('does not write on unchanged declarations and is replay idempotent',async()=>{
    await snapshot(1,5,wallet);await snapshot(1,8,wallet);
    expect(await writeRegistryLabels(db)).toMatchObject({written:1});
    expect(await writeRegistryLabels(db)).toMatchObject({written:0});
    expect((await db.sql.query('SELECT * FROM wallet_labels')).rows).toHaveLength(1);
  });
  it('keeps a shared wallet declared until the final registered identity leaves',async()=>{
    await snapshot(1,5,wallet);await snapshot(2,6,wallet);await snapshot(1,8,zero);await snapshot(2,10,zero);
    await writeRegistryLabels(db);
    expect((await label(wallet,9)).label).toBe('declared_agent');expect((await label(wallet,10)).label).toBe('human');
  });
  it('supports late discovery at the original cut and explicit generation filtering',async()=>{
    await snapshot(1,12,wallet);await writeRegistryLabels(db);expect(await label(wallet,11)).toBeUndefined();
    await snapshot(1,5,wallet);await writeRegistryLabels(db);
    expect((await label(wallet,5)).label).toBe('declared_agent');
    expect(await walletLabelsAt(db,[wallet],5n,'unknown-generation')).toEqual([]);
    expect(await walletLabelsAt(db,[wallet],5n,REGISTRY_LABEL_MODEL)).toHaveLength(1);
  });
  it('retains orphaned rows, excludes them at cuts and appends corrected replacement-fork labels',async()=>{
    await snapshot(1,5,wallet);await snapshot(1,8,next);await writeRegistryLabels(db);
    const before=(await db.sql.query('SELECT * FROM wallet_labels ORDER BY id')).rows;
    await db.tx(tx=>tx.deleteAbove(5n));
    expect((await label(wallet,9)).label).toBe('declared_agent');expect(await label(next,9)).toBeUndefined();
    await snapshot(1,8,zero,5,100);await writeRegistryLabels(db);
    expect(await label(wallet,9)).toMatchObject({label:'human',confidence:0});expect(await label(next,9)).toBeUndefined();
    for(const old of before)expect((await db.sql.query('SELECT * FROM wallet_labels WHERE id=$1',[(old as {id:string}).id])).rows[0]).toEqual(old);
    expect((await db.sql.query("SELECT * FROM wallet_labels WHERE model_version LIKE '%:correction:%'")).rows).toHaveLength(1);
    expect(await writeRegistryLabels(db)).toMatchObject({written:0});
  });
  it('invalidates later withdrawal fallback rows when their registry closing evidence is orphaned',async()=>{
    await snapshot(1,5,wallet);await snapshot(1,8,zero);
    await db.sql.query("INSERT INTO wallet_labels VALUES('behavior-after-close',$1,'likely_agent',0.8,'medium','fingerprint',NULL,'{}','fp-fixture',9)",[binary(wallet)]);
    await writeRegistryLabels(db);expect((await label(wallet,9)).label).toBe('likely_agent');
    await db.tx(tx=>tx.deleteAbove(5n));
    expect((await walletLabelsAt(db,[wallet],9n,REGISTRY_LABEL_MODEL))[0]?.label).toBe('declared_agent');
    await writeRegistryLabels(db);expect((await label(wallet,9)).label).toBe('declared_agent');
  });
  it('records crew changes at qualified graph boundaries and rejects soft candidates',async()=>{
    await snapshot(1,5,wallet);
    await writeRegistryLabels(db,{crewBlocks:[7n],crewAt:async(_a,b)=>b<7n?null:{status:'qualified',crewId:'crew_fixture',confidence:0.95,evidence:[]}});
    expect((await label(wallet,6)).crew_id).toBeNull();expect((await label(wallet,7)).crew_id).toBe('crew_fixture');
    await expect(writeRegistryLabels(db,{crewAt:async()=>({status:'candidate',crewId:'crew_soft',confidence:0.5,evidence:[]}) as never})).rejects.toThrow('Unqualified');
  });
  it('keeps declared precedence when independent crew evidence changes at the same historical cut',async()=>{
    await snapshot(1,5,wallet);await writeRegistryLabels(db);
    await db.sql.query("INSERT INTO wallet_labels VALUES('zz-crew-fixture',$1,'crew',0.95,'high','qualified_graph','crew_fixture','{}','crew-fixture',7)",[binary(wallet)]);
    await writeRegistryLabels(db);
    expect(await label(wallet,7)).toMatchObject({label:'declared_agent',crew_id:'crew_fixture'});
    await expect(db.sql.query("UPDATE wallet_labels SET confidence=0 WHERE source='erc8004'")).rejects.toThrow('append-only');
    await expect(db.sql.query("DELETE FROM wallet_labels WHERE source='erc8004'")).rejects.toThrow('append-only');
  });
  it('resolves successive immutable corrections at the same cut deterministically',async()=>{
    await snapshot(1,5,wallet);
    for(const crewId of ['crew_first','crew_second','crew_first','crew_second','crew_third'])await writeRegistryLabels(db,{crewAt:async()=>({status:'qualified',crewId,confidence:0.95,evidence:[]})});
    expect((await label(wallet,5)).crew_id).toBe('crew_third');
    expect((await walletLabelsAt(db,[wallet],5n,REGISTRY_LABEL_MODEL))[0].crew_id).toBe('crew_first');
    expect(await writeRegistryLabels(db,{crewAt:async()=>({status:'qualified',crewId:'crew_third',confidence:0.95,evidence:[]})})).toMatchObject({written:0});
    expect((await label(wallet,5)).crew_id).toBe('crew_third');
  });
  it('attaches existing crew evidence while declaration takes precedence',async()=>{
    await db.sql.query("INSERT INTO wallet_labels VALUES('crew-fixture',$1,'crew',0.95,'high','qualified_graph','crew_fixture','{}','crew-fixture',1)",[binary(wallet)]);
    await snapshot(1,5,wallet);await writeRegistryLabels(db);
    expect(await label(wallet,5)).toMatchObject({label:'declared_agent',crew_id:'crew_fixture'});
  });
});
