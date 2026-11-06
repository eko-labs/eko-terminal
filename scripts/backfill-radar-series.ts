/** After engines migration 0223:
 * pnpm --filter @eko/server exec node --import tsx ../../scripts/backfill-radar-series.ts [batch-coins=100]
 * DATABASE_URL or PGLITE_DIR selects the database. Rerunnable, independently committed keyset batches.
 */
import { pathToFileURL } from 'node:url';
import { openDb, type ChainDb } from '../packages/db/src/index.js';

export async function backfillRadarSeries(db:ChainDb,batchCoins=100,atSec=Date.now()/1000,onBatch?:(coins:number)=>void) {
  if(!Number.isInteger(batchCoins) || batchCoins<1 || batchCoins>1000)throw new Error('Batch size must be between 1 and 1000');
  let after=new Uint8Array(),coins=0;
  for(;;) {
    const batch=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens WHERE address>$1 ORDER BY address LIMIT $2',[after,batchCoins])).rows.map(r=>r.address);
    if(!batch.length)break;
    await db.tx(async tx=>{
      await tx.sql.query("SET LOCAL lock_timeout='2s'");
      await tx.sql.query("SET LOCAL statement_timeout='60s'");
      await tx.sql.query('SELECT refresh_read_row_series($1::bytea[],$2::double precision)',[batch,atSec]);
    });
    after=Uint8Array.from(batch.at(-1)!);coins+=batch.length;onBatch?.(coins);
  }
  return {coins};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const db=await openDb({databaseUrl:process.env.DATABASE_URL,pgliteDir:process.env.PGLITE_DIR});
  try {console.info(JSON.stringify(await backfillRadarSeries(db,Number(process.argv[2] ?? 100),Date.now()/1000,coins=>console.info('backfilled_coins',coins))));}
  finally {await db.close();}
}
