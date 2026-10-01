import { afterEach,describe,it,expect } from 'vitest';
import { binary,migrate,migrateEngines,type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { V4ReferenceSimulation,referenceDigest } from '@eko/chain';
import { cursor,v4Route,v4Input,v4Clients } from '../../../packages/chain/test/v4-reference-fixtures.js';
import { persistV4Reference,runV4References,loadV4References,expireV4ReferenceTraces } from '../src/v4-reference.js';
const handles:ChainDb[]=[];
afterEach(async()=>{for(const db of handles.splice(0))await db.close();});
async function setup(){
  const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(1000000));
  await db.insert('chain_blocks',{number:'100',block:'100',hash:binary(cursor.blockHash),parent_hash:binary(referenceDigest('parent')),ts:new Date(1000000)});return db;
}
describe('v4 normalizer-owned quote-only evidence',()=>{
  it('persists isolated per-size observations and retains hook evidence after trace expiry',async()=>{
    const db=await setup(),{clients,request}=v4Clients();
    const results=await runV4References(db,new V4ReferenceSimulation(clients),{cursor,route:v4Route,ethUsd:{numerator:10n**18n,denominator:10n,blockHash:cursor.blockHash,evidenceIds:['fixture-price']}});
    expect(results.map(r=>r.requestedWei)).toEqual(['1000','10000','100000']);
    expect(results.map(r=>r.sizeUsd)).toEqual([100,1000,10000]);
    const traces=request.mock.calls.filter(([r])=>r.method==='debug_traceCall');
    expect(traces).toHaveLength(3);expect(new Set(traces.map(([r])=>Object.keys((r.params[2] as {stateOverrides:object}).stateOverrides)[0])).size).toBe(3);
    expect(await loadV4References(db,v4Route.coin,100n)).toHaveLength(3);
    const stored=(await db.sql.query<{data:object;trace:unknown}>('SELECT data,trace FROM v4_reference_runs')).rows[0];
    expect(stored.data).not.toHaveProperty('trace');expect(stored.trace).not.toBeNull();
    await db.sql.query("UPDATE v4_reference_runs SET trace_expires_at=now()-interval '1 second'");await expireV4ReferenceTraces(db);
    await persistV4Reference(db,results[0]);
    expect((await db.sql.query<{trace:unknown}>('SELECT trace FROM v4_reference_runs')).rows.every(r=>r.trace===null)).toBe(true);
    expect((await loadV4References(db,v4Route.coin,100n))[0].hookEvidence).toHaveProperty('quoteBuyGapPct');
    await db.sql.query('UPDATE v4_reference_runs SET block_hash=$1',[binary(referenceDigest('other-fork'))]);expect(await loadV4References(db,v4Route.coin,100n)).toEqual([]);
  });
  it('rejects digest tampering and acceptance escalation; acquisition revisions are immutable',async()=>{
    const db=await setup(),{clients}=v4Clients(),r=await new V4ReferenceSimulation(clients).run(v4Input);
    await persistV4Reference(db,r);
    await expect(persistV4Reference(db,{...r,trace:['tamper']})).rejects.toThrow('digest mismatch');
    await expect(persistV4Reference(db,{...r,status:'sell_restricted'})).rejects.toThrow('revision conflict');
    await expect(persistV4Reference(db,{...r,route:{...r.route,executable:true}} as unknown as typeof r)).rejects.toThrow('cannot grant acceptance');
    const row=(await db.sql.query('SELECT data FROM v4_reference_runs')).rows[0];expect(row.data).toMatchObject({complete:false,route:{executable:false}});
  });
  it('rolls back noncanonical persistence and rejects unavailable USD pricing',async()=>{
    const db=await setup(),{clients}=v4Clients();const simulator=new V4ReferenceSimulation(clients);
    await expect(runV4References(db,simulator,{cursor,route:v4Route,ethUsd:{numerator:0n,denominator:1n,blockHash:cursor.blockHash,evidenceIds:[]}})).rejects.toThrow('price unavailable');
    await db.sql.query('UPDATE chain_blocks SET hash=$1',[binary(referenceDigest('changed-canonical'))]);
    await expect(runV4References(db,simulator,{cursor,route:v4Route,ethUsd:{numerator:10n**18n,denominator:10n,blockHash:cursor.blockHash,evidenceIds:['fixture-price']}})).rejects.toThrow('pin mismatch');
    expect((await db.sql.query('SELECT id FROM v4_reference_runs')).rows).toHaveLength(0);
  });
});
