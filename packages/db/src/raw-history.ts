import { retentionPhase } from './retention-errors.js';
import type { ChainDb } from './client.js';
import type { RetentionOptions, RetentionResult } from './retention.js';
import { rawMaintenance, sealRawPartitionOnSession, sealTx, type RawSeal, type RawTable, rawSealStatementMs } from './raw-partitions.js';

/** One backend owns the existing reorg/retention mutex across the independently committed phases. */
export async function rawPartitionPass(db: ChainDb, options: RetentionOptions, result: RetentionResult, now: number) {
  const windows = {swaps: options.swapDays ?? 1,token_transfers: options.transferDays ?? 1};
  if(!Number.isInteger(windows.swaps) || windows.swaps<1 || !Number.isInteger(windows.token_transfers) || windows.token_transfers<1)
    throw new Error('Raw history requires at least one swap day and one transfer day');
  const pass=async (session:ChainDb)=>{
    if(options.dryRun)for(const table of options.rawPartitionTables ?? ['swaps','token_transfers'])
      (result.tables ??=[]).push({table,rows:0,estimatedBytes:0,estimateSkipped:true});
    const attached=(await retentionPhase('raw_partition_discovery', () => sealTx(session, tx => tx.sql.query<{name:RawTable;partition_name:string;bound:string}>(`SELECT p.relname AS name,c.relname AS partition_name,pg_get_expr(c.relpartbound,c.oid) AS bound
      FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent IN ('swaps'::regclass,'token_transfers'::regclass)
      AND c.relname ~ ('^'||p.relname||'_d[0-9]{4}_[0-9]{2}_[0-9]{2}$') ORDER BY p.relname,c.relname`)))).rows;
    const due=attached.filter(p=>{
      if(options.rawPartitionTables && !options.rawPartitionTables.includes(p.name))return false;
      if(!p.partition_name.startsWith(`${p.name}_d`))return false;
      const end=[...p.bound.matchAll(/'([^']+)'/g)][1]?.[1];
      return end!==undefined && Date.parse(end)<now-windows[p.name]*86400000;
    });
    // A crash after detach/drop must not strand a table or omit its fence advance.
    const pending=(await retentionPhase('raw_partition_recovery', () => sealTx(session, tx => tx.sql.query<RawSeal>(`SELECT * FROM raw_history_seals WHERE partition_name ~ ('^'||name||'_d[0-9]{4}_[0-9]{2}_[0-9]{2}$') AND
      (NOT dropped OR through_block>(SELECT through_block FROM raw_history_watermarks WHERE name=raw_history_seals.name)) ORDER BY start_ts,name`)))).rows;
    const partitions=[...new Map([...due,...pending.filter(p=>!options.rawPartitionTables || options.rawPartitionTables.includes(p.name))].map(p=>[p.partition_name,p])).values()]
      .sort((a,b)=>a.name.localeCompare(b.name)||a.partition_name.localeCompare(b.partition_name));
    const blockedTables=new Map<RawTable,string>();
    for(const p of partitions) {
      if(blockedTables.has(p.name)){(result.partitionSkips ??=[]).push({partition:p.partition_name,code:blockedTables.get(p.name)!});continue;}
      if(options.dryRun){(result.tables ??=[]).push({table:p.partition_name,rows:0,estimatedBytes:0,estimateSkipped:true});continue;}
      const started=Date.now();
      try {
        const seal=await retentionPhase(`seal:${p.partition_name}`, () => sealRawPartitionOnSession(session,p.name,p.partition_name,{firstBlocks:options.firstBlocks,cohortSec:options.cohortSec,poolManager:options.poolManager,now:new Date(now),checkpointBefore:new Date(now-windows[p.name]*86400000)}));
        await retentionPhase(`detach:${p.partition_name}`, () => session.tx(async tx=>{
          await tx.sql.query(`SET LOCAL statement_timeout='${rawSealStatementMs()}ms'`);
          await tx.sql.query("SET LOCAL lock_timeout='5s'");
          const isAttached=(await tx.sql.query(`SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass($1) AND inhparent=$2::regclass`,[p.partition_name,p.name])).rows.length;
          if(isAttached)await tx.sql.query(`ALTER TABLE ${p.name} DETACH PARTITION ${p.partition_name}`);
        }));
        await retentionPhase(`drop:${p.partition_name}`, () => session.tx(async tx=>{
          await tx.sql.query(`SET LOCAL statement_timeout='${rawSealStatementMs()}ms'`);
          await tx.sql.query("SET LOCAL lock_timeout='5s'");
          await tx.sql.query(`DROP TABLE IF EXISTS ${p.partition_name}`);
          await tx.sql.query('UPDATE raw_history_seals SET dropped=true WHERE name=$1 AND partition_name=$2',[p.name,p.partition_name]);
        }));
        await retentionPhase(`watermark:${p.partition_name}`, () => session.tx(async tx=>{
          await tx.sql.query(`SET LOCAL statement_timeout='${rawSealStatementMs()}ms'`);
          await tx.sql.query("SET LOCAL lock_timeout='5s'");
          await tx.sql.query('UPDATE raw_history_watermarks SET through_block=greatest(through_block,$2) WHERE name=$1',[p.name,seal.through_block]);
        }));
        result[p.name==='swaps'?'historySwaps':'historyTransfers']+=Number(seal.rows);
        (result.partitions ??=[]).push({table:p.name,partition:p.partition_name,rows:Number(seal.rows),seconds:(Date.now()-started)/1000});
      } catch(error) {
        if((error as {code?:string}).code!=='55P03' && (error as {code?:string}).code!=='57014')throw error;
        blockedTables.set(p.name,(error as {code:string}).code);result.finished=false;result.skippedRules.push(p.partition_name);
        (result.partitionSkips ??=[]).push({partition:p.partition_name,code:(error as {code:string}).code}); // Next hourly pass resumes the persisted phase.
      }
    }
  };
  try { if(options.dryRun)await pass(db);else await rawMaintenance(db,pass); } catch(error) {
    if((error as {code?:string}).code!=='55P03' && (error as {code?:string}).code!=='57014')throw error;
    result.finished=false;result.skippedRules.push('raw_partitions');
  }
}
