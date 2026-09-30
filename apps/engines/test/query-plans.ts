import { readFile,readdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { binary } from '@eko/db';
import { refreshClock } from '../src/activity.js';
import { growingReplayFixture,sampleAddress } from './replay-fixture.js';
const root=resolve(process.cwd(),'src'),queries=new Map<string,{sql:string;sites:string[]}>();
for(const file of (await readdir(root)).filter(name=>name.endsWith('.ts')).sort()){
  const source=ts.createSourceFile(file,await readFile(resolve(root,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{if(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)){
    const sql=node.text.trim();if(/^(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(sql) && /\b(swaps|token_transfers|balances|deployer_stats|outcomes|coin_cards|verdicts|engine_runs)\b/.test(sql)){
      const key=sql.replace(/\s+/g,' '),site=`src/${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1}`;const found=queries.get(key);if(found)found.sites.push(site);else queries.set(key,{sql,sites:[site]});
    }}ts.forEachChild(node,visit);};visit(source);
}
const db=await growingReplayFixture({coins:200,swapsPerCoin:600,holdersPerCoin:120,hours:24,staggered:true});
const epoch=Date.parse('2026-10-01T00:00:00Z')/1000;
try{
 await refreshClock(db);
 // Enough derived rows for the planner to distinguish wallet/range scans from table scans.
 for(const table of ['engine_runs','coin_cards','verdicts','deployer_stats']){
  const values={
   engine_runs:"coin,b*1000,b*1000,1,'{}'::jsonb,'1.0.1'",
   coin_cards:"'sample-card:'||c||':'||b,coin,b*1000,'sample-hash','{}'::jsonb,'1.0.1'",
   verdicts:"'sample-verdict:'||c||':'||b,coin,b*1000,'1.0.1','sample-signature','{}'::jsonb",
   deployer_stats:"decode(lpad(to_hex(10000+c%20),40,'0'),'hex'),coin,b*1000,'{}'::jsonb,'1.0.1'",
  }[table];
  await db.sql.query(`INSERT INTO ${table} SELECT ${values} FROM generate_series(0,4999) c CROSS JOIN generate_series(1,40) b CROSS JOIN LATERAL(SELECT decode(lpad(to_hex(c+100),40,'0'),'hex') coin) v`);
 }
 await db.sql.query(`INSERT INTO outcomes SELECT decode(lpad(to_hex(c+100),40,'0'),'hex'),h,1000,CASE WHEN c%10=0 THEN 'rugged' ELSE 'survived' END,'{}'::jsonb FROM generate_series(0,4999) c CROSS JOIN unnest(ARRAY['1h','24h','7d']) h`);
 await db.sql.query('VACUUM ANALYZE');
 const run=async()=>{
  const output=[];
  for(const query of queries.values()){
   await db.sql.query(`PREPARE engine_query_audit AS ${query.sql}`);
   const types=(await db.sql.query<{type:string}>("SELECT type::text FROM pg_prepared_statements,LATERAL unnest(parameter_types) type WHERE name='engine_query_audit'")).rows.map(r=>r.type);
   await db.sql.query('DEALLOCATE engine_query_audit');
   const args=types.map((type,i)=>type==='bytea' ? binary(sampleAddress(i===0 && /deployer\s*=\s*\$1/.test(query.sql)?10000:100)) : type==='double precision' ? epoch+24*3600-3600 : ['bigint','integer','smallint'].includes(type) ? 4800 : type==='jsonb' ? '{}' : new RegExp('horizon=\\$'+(i+1)+'\\b').test(query.sql) || /^INSERT INTO outcomes/.test(query.sql) && i===1 ? '1h' : /^INSERT INTO outcomes/.test(query.sql) && i===3 ? 'survived' : '1.0.1');
   const read=/^(SELECT|WITH)\b/i.test(query.sql),plans=(await db.sql.query<Record<string,unknown>>(`EXPLAIN (${read?'ANALYZE,BUFFERS,':''}FORMAT JSON) ${query.sql}`,args)).rows;
   output.push({...query,types,plan:plans});
  }
  return output;
 };
 if(process.env.AUDIT_MIGRATION){const sql=await readFile(resolve(process.env.AUDIT_MIGRATION),'utf8');for(const match of sql.matchAll(/CREATE INDEX (\w+)/g))await db.sql.query(`DROP INDEX IF EXISTS ${match[1]}`);}
 const before=await run();
 if(process.env.AUDIT_MIGRATION){for(const statement of (await readFile(resolve(process.env.AUDIT_MIGRATION),'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.sql.query(statement);await db.sql.query('VACUUM ANALYZE');}
 const after=await run();
 const report={shape:{swaps:120000,transfers:24000,derivedRowsPerTable:200000,outcomes:15000},queryCount:queries.size,before,after};
 await writeFile(process.env.AUDIT_OUTPUT ?? '/private/tmp/eko-engine-query-plans.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({event:'query_plans_complete',queries:queries.size,migration:Boolean(process.env.AUDIT_MIGRATION)}));
}finally{await db.close();}
