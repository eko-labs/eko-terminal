// Run: pnpm --filter @eko/engines exec node --import tsx test/hot-reads-benchmark.ts
import { migrate,migrateEngines,binary,trendingAt } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { incrementalSwaps } from '../src/swap-reader.js';
import { holdingsAt } from '../src/sources.js';
import type { Address } from '@eko/shared';
const coin=`0x${'1'.padStart(40,'0')}` as Address,epoch=Date.parse('2026-10-01T00:00:00Z')/1000;
const db=await openDb({pgliteDir:':memory:'});
try {
 await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(epoch*1000));
 await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block) VALUES($1,$1,'Sample coin','DEMO',1,1)`,[binary(coin)]);
 await db.sql.query(`INSERT INTO engine_block_times VALUES(1,to_timestamp($1),NULL,'activity')`,[epoch]);
 await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd)
 SELECT to_timestamp($2::double precision+n/100),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,'uniswap_v3',$1,$1,$1,$1,$1,$1,1,100,20,1,20
 FROM generate_series(1,100000) n`,[binary(coin),epoch]);
 await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
 SELECT to_timestamp($2::double precision+n/100),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,$1,decode(lpad(to_hex(n%100),40,'0'),'hex'),decode(lpad(to_hex((n+1)%100),40,'0'),'hex'),100
 FROM generate_series(1,100000) n`,[binary(coin),epoch]);
 // Initialize maintained balances without timing setup or the unrelated indexer writer.
 await db.sql.query(`INSERT INTO balances SELECT token,holder,sum(amount),max(block) FROM (
 SELECT token,to_address holder,amount,block FROM token_transfers UNION ALL SELECT token,from_address,-amount,block FROM token_transfers) x GROUP BY token,holder`);
 await db.sql.query('ANALYZE');
 const measured=async(name:string,fn:()=>Promise<unknown>)=>{const values:number[]=[];for(let n=0;n<4;n++){const start=performance.now();await fn();if(n)values.push(performance.now()-start);}values.sort((a,b)=>a-b);console.log(JSON.stringify({name,medianMs:Math.round(values[1]*100)/100}));};
 await measured('history_before',()=>db.sql.query('SELECT * FROM swaps WHERE coin=$1 AND block<=$2 ORDER BY block,log_index,tx_hash',[binary(coin),100000]));
 await measured('history_warm_after',()=>incrementalSwaps(db,coin,100000));
 await measured('holders_before',()=>db.sql.query(`SELECT holder,sum(amount)::text AS amount,max(block)::text AS block FROM (
 SELECT to_address holder,amount,block FROM token_transfers WHERE token=$1 AND block<=$2
 UNION ALL SELECT from_address,-amount,block FROM token_transfers WHERE token=$1 AND block<=$2
 ) x GROUP BY holder HAVING sum(amount)>0 ORDER BY holder`,[binary(coin),99950]));
 await measured('holders_after',()=>holdingsAt(db,coin,99950));
 await measured('trending_before',()=>db.sql.query(`SELECT a.coin,t.name,t.symbol,b.ts AS created,a.started,a.volume FROM (
 SELECT coin,min(ts) AS started,sum(usd) AS volume FROM swaps WHERE block<=$1 AND ts>to_timestamp($2) AND ts<=to_timestamp($3) AND usd>0 GROUP BY coin
 ) a JOIN tokens t ON t.address=a.coin JOIN engine_block_times b ON b.number=t.first_block WHERE t.name IS NOT NULL AND t.symbol IS NOT NULL ORDER BY a.volume DESC,a.coin LIMIT 50`,[100000,epoch-3600,epoch+2000]));
 await measured('trending_warm_after',()=>trendingAt(db,100000,epoch-3600,epoch+2000));
} finally {await db.close();}
