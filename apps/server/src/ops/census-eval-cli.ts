import { readFile } from 'node:fs/promises';
import { migrate, migrateEngines } from '@eko/db';
import { evaluateCensus, importCensusEvaluation } from '@eko/engines';
import { openDb, runMigrations } from '../db/client.js';

async function main() {
  const [mode,file,...extra]=process.argv.slice(2);
  if(!file||extra.length||!['check','import'].includes(mode??''))throw new Error('Usage: census-eval-cli.ts check|import dataset.json');
  const input:unknown=JSON.parse(await readFile(file,'utf8'));
  // Validate before opening or mutating a database. Check mode performs no I/O beyond the input file.
  const evaluated=evaluateCensus(input);
  if(mode==='check'){console.log(JSON.stringify({...evaluated,stored:false}));return;}
  if(!process.env.DATABASE_URL&&!process.env.PGLITE_DIR)throw new Error('Import requires an explicit database destination');
  const handle=await openDb({databaseUrl:process.env.DATABASE_URL,pgliteDir:process.env.PGLITE_DIR??'.data/census-eval'});
  try {
    await runMigrations(handle);await migrate(handle.chain);await migrateEngines(handle.chain);
    const result=await importCensusEvaluation(handle.chain,input);
    console.log(JSON.stringify({...result,stored:true}));
  } finally {await handle.close();}
}
main().catch(()=>{console.error('Census evaluation failed: verify input, current model and migration 0035.');process.exitCode=1;});
