import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate, migrateEngines, censusGate, readCensus } from '@eko/db';
import { importCensusEvaluation, evaluateCensus, FP_MODEL } from '@eko/engines';
import { CENSUS_GATE_MAX_AGE_MS, censusGateAccepted } from '@eko/shared';
import { openDb, runMigrations } from '../src/db/client.js';
import { censusEvaluationFixture, evaluationTime } from '../../engines/test/census-fixture.js';
let handle:Awaited<ReturnType<typeof openDb>>;
beforeAll(async()=>{handle=await openDb({pgliteDir:':memory:'});await migrate(handle.chain);await migrateEngines(handle.chain);await runMigrations(handle);});
afterAll(async()=>{await handle.close();});
describe('Census evaluation importer and migration 0035',()=>{
  it('upgrades task 102 rows in place, retains old evidence, and fails closed without hashes',async()=>{
    const db=handle.chain;
    await db.sql.query(`INSERT INTO eval_gates(id,metric,model_version,value,wilson_lower,recall,evaluated_at)
      VALUES('legacy','likely_agent_precision',$1,1,0.99,1,$2)`,[FP_MODEL.version,new Date(evaluationTime-1000)]);
    await runMigrations(handle);
    expect((await db.sql.query("SELECT value,model_hash FROM eval_gates WHERE id='legacy'")).rows).toEqual([{value:1,model_hash:null}]);
    const response=await readCensus(db,evaluationTime);expect(response.gated).toBe(true);expect(response.chain).toEqual([]);
  });
  it('stores reproducible metrics/hashes, preserves them on duplicate import and expires exactly at the boundary',async()=>{
    const db=handle.chain,input=censusEvaluationFixture(),result=await importCensusEvaluation(db,input,evaluationTime);
    expect(result.passed).toBe(true);
    const stored=(await db.sql.query('SELECT * FROM eval_gates WHERE id=$1',[result.id])).rows;
    expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({value:1,recall:1,model_hash:result.gate.modelHash,dataset_hash:result.gate.datasetHash,evidence:result.gate.evidence});
    expect(Number(stored[0].wilson_lower)).toBeCloseTo(result.gate.wilsonLower);
    expect(await importCensusEvaluation(db,input,evaluationTime)).toEqual(result);
    expect((await db.sql.query('SELECT * FROM eval_gates WHERE id=$1',[result.id])).rows).toEqual(stored);
    const gate=await censusGate(db,FP_MODEL.version);
    expect(censusGateAccepted(gate,evaluationTime)).toBe(true);
    expect(censusGateAccepted(gate,evaluationTime+CENSUS_GATE_MAX_AGE_MS-1)).toBe(true);
    expect(censusGateAccepted(gate,evaluationTime+CENSUS_GATE_MAX_AGE_MS)).toBe(false);
    expect((await readCensus(db,evaluationTime+CENSUS_GATE_MAX_AGE_MS)).chain).toEqual([]);
    await db.sql.query("INSERT INTO watcher_flow_model VALUES(true,'fp-next')");
    expect(await readCensus(db,evaluationTime)).toMatchObject({gated:true,gate:{modelVersion:'fp-next',value:null},chain:[],coins:[]});
    await expect(importCensusEvaluation(db,input,evaluationTime+1)).rejects.toThrow('current model');
    await db.sql.query('DELETE FROM watcher_flow_model');
    await expect(importCensusEvaluation(db,input,evaluationTime-1)).rejects.toThrow('predates');
  });
  it('records incomplete disagreement evaluations as failed gates without falling back to a previous passing row',async()=>{
    const db=handle.chain,input=censusEvaluationFixture(),row=input.rows[1];
    if(row.source!=='reviewed')throw new Error('fixture');row.reviews[1].label='human';
    const result=await importCensusEvaluation(db,input,evaluationTime+1000);
    expect(result).toMatchObject({passed:false,gate:{value:1,evidence:{agents:199,disagreements:1}}});
    const response=await readCensus(db,evaluationTime+1000);
    expect(response).toMatchObject({gated:true,chain:[],coins:[],gate:{datasetHash:result.gate.datasetHash}});
  });
  it('rejects malformed/Guard datasets before writing anything',async()=>{
    const before=(await handle.chain.sql.query('SELECT id FROM eval_gates ORDER BY id')).rows;
    await expect(importCensusEvaluation(handle.chain,{kind:'guard-buyer-harm',rows:[]})).rejects.toThrow();
    expect((await handle.chain.sql.query('SELECT id FROM eval_gates ORDER BY id')).rows).toEqual(before);
  });
  it('applies the same evidence schema when API migration precedes engine initialization',async()=>{
    const fresh=await openDb({pgliteDir:':memory:'});
    try {
      await runMigrations(fresh);await migrate(fresh.chain);await migrateEngines(fresh.chain);
      await runMigrations(fresh);await migrateEngines(fresh.chain);
      const result=await importCensusEvaluation(fresh.chain,censusEvaluationFixture(),evaluationTime);
      expect((await censusGate(fresh.chain,FP_MODEL.version)).modelHash).toBe(result.gate.modelHash);
    }finally{await fresh.close();}
  });
  it('leaves engine-only databases gated until the reserved evidence migration is applied',async()=>{
    const fresh=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(fresh.chain);await migrateEngines(fresh.chain);
      const result=evaluateCensus(censusEvaluationFixture(),evaluationTime),g=result.gate;
      await fresh.chain.sql.query('INSERT INTO eval_gates VALUES($1,$2,$3,$4,$5,$6,$7)',
        [result.id,g.metric,g.modelVersion,g.value,g.wilsonLower,g.recall,g.evaluatedAt]);
      expect((await readCensus(fresh.chain,evaluationTime)).gated).toBe(true);
      // Apply the reserved SQL directly to reproduce a database created by task 102.
      const sql=await readFile(new URL('../drizzle/0035_census_evidence.sql',import.meta.url),'utf8');
      for(const statement of sql.split('--> statement-breakpoint'))await fresh.chain.sql.query(statement);
      expect((await censusGate(fresh.chain,FP_MODEL.version)).modelHash).toBeNull();
    }finally{await fresh.close();}
  });
});
