import { binary, migrate, migrateEngines, rebuildBalances, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { Address } from '@eko/shared';
export const sampleAddress=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
const txHash=(n:number)=>binary(`0x${n.toString(16).padStart(64,'0')}`);
/** A fixed, timestamped backfill with distinct deployers, no head-follower rows and no RPC. */
export async function replayFixture(coins=100,steps=20,pgliteDir=':memory:'):Promise<ChainDb> {
  const db=await openDb({pgliteDir});await migrate(db);await migrateEngines(db);
  const epoch=Date.parse('2026-10-01T00:00:00Z')/1000;await db.ensurePartitions(new Date(epoch*1000));
  const tokens=[],swaps=[],transfers=[];
  for(let i=0;i<coins;i++) {
    const coin=binary(sampleAddress(i+100)),actor=binary(sampleAddress(i+10000));
    tokens.push({address:coin,deployer:actor,name:'Sample coin',symbol:'DEMO',launchpad:'other',decimals:0,total_supply:'100000',supply_block:'1',first_block:'1',block:'1'});
    transfers.push({token:coin,from_address:binary(sampleAddress(0)),to_address:actor,amount:'100',block:'1',ts:new Date((epoch+1)*1000),tx_hash:txHash(i+1),log_index:0});
    for(let j=0;j<steps;j++) {
      const block=j+1,ts=new Date((epoch+(j===0?1:j*60+1))*1000);
      swaps.push({coin,block:String(block),ts,tx_hash:txHash(coins+i*steps+j+1),log_index:0,venue:'pons_curve',pool_id:coin,quote_asset:binary(sampleAddress(0)),trader:actor,tx_from:actor,tx_to:coin,side:j%2===0?1:-1,amount_coin:'100',amount_quote:'100',price_quote:1+j*.1,usd:100,priced_block:String(block)});
    }
  }
  await db.insertMany('tokens',tokens);await db.insertMany('swaps',swaps);await db.insertMany('token_transfers',transfers);
  return db;
}
/** Realistic skew: 2,000 coins, 200 with 1,200 swaps, dense blocks and holder transfers. */
export async function heavyReplayFixture():Promise<ChainDb> {
  const db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  const epoch=Date.parse('2026-10-01T00:00:00Z')/1000;await db.ensurePartitions(new Date(epoch*1000));
  const tokens=[],swaps=[],transfers=[];let id=1;
  for(let i=0;i<2000;i++) {
    const coin=binary(sampleAddress(i+100)),owner=binary(sampleAddress(i+10000));
    tokens.push({address:coin,deployer:owner,name:`Sample coin ${i}`,symbol:`D${i}`,launchpad:'other',decimals:0,total_supply:'1000000',supply_block:'1',first_block:'1',block:'1'});
    const blocks=i<200 ? Array.from({length:1200},(_,j)=>j+1) : [1,2,10,60,500,600];
    for(const block of blocks) {
      const actor=binary(sampleAddress(20000+i*20+block%10)),ts=new Date((epoch+block*2)*1000);
      swaps.push({coin,block:String(block),ts,tx_hash:txHash(id++),log_index:0,venue:'pons_curve',pool_id:coin,quote_asset:binary(sampleAddress(0)),trader:actor,tx_from:actor,tx_to:coin,side:block%2===0?1:-1,amount_coin:'100',amount_quote:'100',price_quote:1+(block%4)*.08,usd:100,priced_block:String(block)});
      if(block%3===0 || block===1)transfers.push({token:coin,from_address:binary(sampleAddress(0)),to_address:actor,amount:'100',block:String(block),ts,tx_hash:txHash(id++),log_index:0});
    }
  }
  await db.insertMany('tokens',tokens);await db.insertMany('swaps',swaps);await db.insertMany('token_transfers',transfers);await db.tx(tx=>rebuildBalances(tx));
  return db;
}

/** Growing histories over six days: hourly observations, thousands of distinct holders per coin. */
export async function growingReplayFixture(shape:{coins:number;swapsPerCoin:number;holdersPerCoin:number;hours:number;staggered?:boolean;denseClock?:boolean;fractional?:boolean;activeCoins?:number}):Promise<ChainDb> {
  const db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  const epoch=Date.parse('2026-10-01T00:00:00Z')/1000;await db.ensurePartitions(new Date(epoch*1000));
  const stride=shape.denseClock ? Math.min(7,Math.floor(1800/shape.coins)) : 1,slots=shape.denseClock ? 1800 : shape.coins;
  if(shape.denseClock)await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) SELECT b,to_timestamp($1+(b-1)*2+1),NULL,'activity' FROM generate_series(1,$2::int) b",[epoch,shape.hours*slots]);
  await db.insertMany('tokens',Array.from({length:shape.coins},(_,i)=>({address:binary(sampleAddress(i+100)),deployer:binary(sampleAddress(i+10000)),name:'Sample coin',symbol:'DEMO',launchpad:'other',decimals:0,total_supply:'1000000000',supply_block:'1',first_block:String(shape.staggered ? i*stride+1 : 1),block:String(shape.staggered ? i*stride+1 : 1)})));
  const blockSql=shape.staggered ? '(ceil(j*$5::numeric/$2)-1)*'+slots+'+c*'+stride+'+1' : 'ceil(j*$5::numeric/$2)';
  const timeSql=shape.staggered ? '(b-1)*'+(3600/slots)+'+1' : 'b*3600';
  for(let offset=0;offset<shape.coins;offset+=20){
    const end=Math.min(shape.coins-1,offset+19);
    const active=shape.activeCoins ?? shape.coins;
    // Keep batch boundaries at the skew boundary so sparse coins have exactly one trade/hour.
    if(offset<active && end>=active)throw new Error('activeCoins must align with the 20-coin fixture batches');
    const sparse=offset>=active,swapCount=sparse ? shape.hours : shape.swapsPerCoin,holderCount=sparse ? Math.min(25,shape.holdersPerCoin) : shape.holdersPerCoin;
    const usdSql=shape.fractional ? (sparse ? "CASE WHEN c%3=0 THEN 394.12 WHEN c%3=1 THEN 25 ELSE 0.37 END" : "CASE WHEN j%10<3 THEN CASE WHEN j%3=0 THEN 394.12 WHEN j%3=1 THEN 25 ELSE 0.37 END ELSE ((c*7919+j*104729)%100000+1)::double precision/137 END") : '10';
    await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd,priced_block)
      SELECT to_timestamp($1+${timeSql}),b,decode(lpad(to_hex(10000000+c*$2+j),64,'0'),'hex'),j,'pons_curve',coin,coin,decode(repeat('00',20),'hex'),actor,actor,coin,CASE WHEN j%2=0 THEN 1 ELSE -1 END,100,100,1,${usdSql},b
      FROM generate_series($3::int,$4::int) c CROSS JOIN generate_series(1,$2::int) j
      CROSS JOIN LATERAL(SELECT (${blockSql})::bigint b,decode(lpad(to_hex(c+100),40,'0'),'hex') coin,decode(lpad(to_hex(20000+c*10000+j%$6),40,'0'),'hex') actor) values`,[epoch,swapCount,offset,end,shape.hours,holderCount]);
    await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
      SELECT to_timestamp($1+${timeSql}),b,decode(lpad(to_hex(20000000+c*$2+j),64,'0'),'hex'),j,decode(lpad(to_hex(c+100),40,'0'),'hex'),decode(repeat('00',20),'hex'),decode(lpad(to_hex(20000+c*10000+j),40,'0'),'hex'),100+j%20
      FROM generate_series($3::int,$4::int) c CROSS JOIN generate_series(1,$2::int) j CROSS JOIN LATERAL(SELECT (${blockSql})::bigint b) values`,[epoch,holderCount,offset,end,shape.hours]);
  }
  await db.tx(tx=>rebuildBalances(tx));return db;
}
