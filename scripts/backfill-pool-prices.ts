/** After engines migration 0221, with DATABASE_URL configured:
 * pnpm --filter @eko/server exec node --import tsx ../../scripts/backfill-pool-prices.ts [batch-coins=100]
 * Rerunnable keyset batches commit independently. No table lock or raw-history migration scan.
 */
import { pathToFileURL } from 'node:url';
import { openDb, hex, type ChainDb } from '../packages/db/src/index.js';

export const BACKFILL_POOL_PRICES_SQL=`INSERT INTO coin_pool_prices(coin,pool_id,trade_pool_id,amount_coin,amount_quote,usd,block,log_index,tx_hash)
 SELECT k.coin,p.pool_id,p.trade_pool_id,p.amount_coin,p.amount_quote,p.usd,p.block,p.log_index,p.tx_hash
 FROM unnest($1::bytea[]) k(coin) CROSS JOIN LATERAL (
  SELECT DISTINCT ON(s.pool_id) s.pool_id,s.pool_id AS trade_pool_id,s.amount_coin,s.amount_quote,s.usd,s.block,s.log_index,s.tx_hash
  FROM swaps s WHERE s.coin=k.coin AND s.usd>0 AND s.amount_coin>0 AND s.amount_quote>0
  ORDER BY s.pool_id,s.block DESC,s.log_index DESC,s.tx_hash DESC
 ) p
 UNION ALL
 SELECT k.coin,''::bytea,p.pool_id,p.amount_coin,p.amount_quote,p.usd,p.block,p.log_index,p.tx_hash
 FROM unnest($1::bytea[]) k(coin) CROSS JOIN LATERAL (
  SELECT pool_id,amount_coin,amount_quote,usd,block,log_index,tx_hash FROM swaps s
  WHERE s.coin=k.coin AND s.usd>0 AND s.amount_coin>0 AND s.amount_quote>0
  ORDER BY block DESC,log_index DESC,tx_hash DESC LIMIT 1
 ) p
 ORDER BY coin,pool_id
 ON CONFLICT(coin,pool_id) DO UPDATE SET valid=true,trade_pool_id=excluded.trade_pool_id,amount_coin=excluded.amount_coin,
 amount_quote=excluded.amount_quote,usd=excluded.usd,block=excluded.block,log_index=excluded.log_index,tx_hash=excluded.tx_hash
 WHERE NOT coin_pool_prices.valid OR (excluded.block,excluded.log_index,excluded.tx_hash)>(coin_pool_prices.block,coin_pool_prices.log_index,coin_pool_prices.tx_hash)`;

export async function backfillPoolPrices(db:ChainDb,batchCoins=100,onBatch?:(coins:number)=>void) {
  if(!Number.isInteger(batchCoins) || batchCoins<1 || batchCoins>1000)throw new Error('Batch size must be between 1 and 1000');
  let after=new Uint8Array(),coins=0;
  const start=performance.now();
  for(;;) {
    const batch=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens WHERE address>$1 ORDER BY address LIMIT $2',[after,batchCoins])).rows.map(r=>r.address);
    if(!batch.length)break;
    await db.tx(async tx=>{
      await tx.sql.query("SET LOCAL lock_timeout='2s'");
      await tx.sql.query("SET LOCAL statement_timeout='60s'");
      await tx.sql.query(BACKFILL_POOL_PRICES_SQL,[batch]);
      // Wake existing liquidity projections even if they were already refreshed before backfill.
      await tx.sql.query('INSERT INTO read_dirty(coin) SELECT unnest($1::bytea[]) ORDER BY 1 ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision',[batch]);
    });
    after=Uint8Array.from(batch.at(-1)!);coins+=batch.length;onBatch?.(coins);
  }
  return {coins,elapsedMs:performance.now()-start,lastCoin:hex(after)};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const db=await openDb({databaseUrl:process.env.DATABASE_URL,pgliteDir:process.env.PGLITE_DIR});
  try {console.info(JSON.stringify(await backfillPoolPrices(db,Number(process.argv[2] ?? 100),coins=>console.info('backfilled_coins',coins))));}
  finally {await db.close();}
}
