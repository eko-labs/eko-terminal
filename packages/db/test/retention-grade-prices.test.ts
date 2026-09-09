import { expect, it } from 'vitest';
import { binary, migrate, migrateEngines, runRetention } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import { preserveGradePrices } from '../src/rating-retention.js';

it('saves a grade entry before its one-day horizon matures and merges the later price after raw expiry',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=binary(`0x${'01'.repeat(20)}`),hash=binary(`0x${'02'.repeat(32)}`);
  const entry=Date.parse('2026-10-12T23:50:00Z'),graded=Date.parse('2026-10-13T00:30:00Z'),sealing=Date.parse('2026-10-14T00:10:00Z');
  try {
    await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(entry));
    await db.insert('tokens',{address:coin,deployer:coin,first_block:100,block:100,decimals:0});
    const block=async(n:number,ts:number)=>{
      await db.insert('chain_blocks',{number:n,block:n,hash,parent_hash:hash,ts:new Date(ts)});
      await db.sql.query("INSERT INTO engine_block_times VALUES($1,$2,$3,'head')",[n,new Date(ts),hash]);
    };
    const trade=async(n:number,ts:number,usd:number)=>db.insert('swaps',{ts:new Date(ts),block:n,tx_hash:hash,log_index:n,
      coin,pool_id:coin,quote_asset:coin,trader:coin,side:1,amount_coin:'1',amount_quote:'1',price_quote:1,usd,venue:'uniswap_v3'});
    await block(100,entry);await block(101,graded);await block(102,graded+300000);
    await trade(100,entry,10);await trade(102,graded+300000,11);
    await db.sql.query("INSERT INTO verdicts VALUES('sample-grade',$1,101,'fixture','fixture','{\"level\":\"danger\"}')",[coin]);
    await runRetention(db,{quoteTokens:[],swapDays:1,transferDays:1,dryRun:false,pauseMs:0,now:()=>sealing});
    expect((await db.sql.query('SELECT block FROM swaps')).rows).toEqual([{block:102}]);
    const summary=async()=>(await db.sql.query('SELECT p0,p1,hi FROM retention_grade_prices WHERE coin=$1 AND horizon_sec=86400',[coin])).rows;
    expect(await summary()).toEqual([{p0:10,p1:11,hi:11}]);
    const later=Date.parse('2026-10-14T00:20:00Z');
    await block(103,later);await trade(103,later,4);
    await preserveGradePrices(db,coin,new Date(graded+86400001));
    expect(await summary()).toEqual([{p0:10,p1:4,hi:11}]);
  } finally {await db.close();}
});
