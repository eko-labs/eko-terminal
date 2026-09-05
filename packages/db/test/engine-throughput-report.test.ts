import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { binary, migrate, migrateEngines } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;

it('runs the read-only production throughput SQL and separates retained runs, actual attempts and pending blockers',async()=>{
  const db=await openDb({pgliteDir:':memory:'});
  try {
    await migrate(db);await migrateEngines(db);
    await db.sql.query(`INSERT INTO engine_runs(coin,block,sec,rules_version,created_at)
      VALUES($1,1,1,'fixture',date_trunc('hour',now())-interval '2 hours'),
      ($1,2,2,'fixture',date_trunc('hour',now())-interval '1 hour'),
      ($2,3,3,'fixture',date_trunc('hour',now())-interval '1 hour')`,[binary(address(1)),binary(address(2))]);
    await db.sql.query(`INSERT INTO engine_evaluation_counts(minute,path,outcome,reason,first_rating,count)
      SELECT date_trunc('hour',now())-interval '1 hour',path,outcome,reason,first_rating,n
      FROM (VALUES ('write','completed','card',true,2),('write','completed','card',false,7),
        ('sources','failed','missing_launch_identity',true,3),('sources','retry_failed','rpc_budget_exhausted',true,5),
        ('poll','skipped','existing_run',false,11),('poll','skipped_candidate','failure_backoff',true,13))
        AS c(path,outcome,reason,first_rating,n)`);
    await db.insert('tokens',{address:binary(address(3)),first_block:1,block:1});
    const sql=readFileSync(new URL('../../../scripts/engine-throughput-report.sql',import.meta.url),'utf8')
      .split('\n').filter(line=>!line.startsWith('--')).join('\n');
    const results:Record<string,unknown>[][]=[];
    for(const statement of sql.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean)) {
      results.push((await db.sql.query(statement)).rows);
    }
    const retained=results.flat().filter(row=>'retained_run_rows' in row);
    expect(retained).toHaveLength(25);
    expect(retained.reduce((sum,r)=>sum+Number(r.retained_run_rows),0)).toBe(3);
    expect(retained.reduce((sum,r)=>sum+Number(r.first_retained_ratings),0)).toBe(2);
    expect(retained.reduce((sum,r)=>sum+Number(r.retained_reratings),0)).toBe(1);
    expect(retained.every(row=>row.historical_failed_attempts_unknown===null)).toBe(true);
    expect(results.flat().find(row=>Number(row.first_ratings)===2)).toMatchObject({
      first_ratings:'2',reratings:'7',failed_initial_attempts:'3',failed_retry_attempts:'5',
      skipped_evaluations:'11',skipped_candidate_observations:'13',
    });
    expect(results.flat().find(row=>row.reason==='no_deployer')).toMatchObject({coins:'1'});
    expect(Number((await db.sql.query('SELECT count(*) AS n FROM engine_runs')).rows[0].n)).toBe(3);
  } finally {await db.close();}
});
