import type { ChainDb } from './client.js';
import { sealRawPartition, rawSealStatementMs, type RawTable, type RawSealOptions } from './raw-partitions.js';

/** Operator-only; the persisted range fence fixes the cutoff across retries and midnight. */
export async function sealOctober(db: ChainDb, asOf: Date, swapDays=1, transferDays=1,inputs:Pick<RawSealOptions,'firstBlocks'|'cohortSec'|'poolManager'|'onProgress'>={}) {
  if (!Number.isFinite(+asOf) || swapDays<1 || transferDays<1)throw new Error('Invalid maintenance window');
  for(const [table,days] of [['swaps',swapDays],['token_transfers',transferDays]] as const) {
    const prior=await db.tx(async tx=>{
      await tx.sql.query(`SET LOCAL statement_timeout='${rawSealStatementMs()}ms'`);
      return (await tx.sql.query<{end_ts:Date}>(`SELECT end_ts FROM raw_history_seals WHERE name=$1 AND partition_name=$2`,[table,`${table}_2026_10`])).rows[0];
    });
    const before=prior?.end_ts ?? new Date(+asOf-days*86400000);
    await sealRawPartition(db,table as RawTable,`${table}_2026_10`,{...inputs,tsBefore:new Date(before)});
  }
}
