import { describe,it,expect,vi } from 'vitest';
import { binary } from '@eko/db';
import { ReplayCache } from '../src/replay-cache.js';
import { MarketWindow,exactRanks,liveRanks,type MarketRow } from '../src/market.js';
import { sqlRanks } from './market-oracle.js';
import { refreshClock,type ClockCache } from '../src/activity.js';
import { growingReplayFixture,sampleAddress } from './replay-fixture.js';
// Dense PGlite fixture construction and SQL oracles are correctness checks, not a benchmark.
// Cover up to 90s of fixture startup plus 30s for comparisons and database close under load.
const denseMarketBudgetMs=120000;
const epoch=Date.parse('2026-10-01T00:00:00Z')/1000;
async function rows(db:Awaited<ReturnType<typeof growingReplayFixture>>):Promise<MarketRow[]>{return (await db.sql.query<{coin:Uint8Array;block:string;sec:number;usd:number}>('SELECT coin,block,extract(epoch FROM ts)::double precision AS sec,usd FROM swaps WHERE usd>0 ORDER BY block,ts,tx_hash,log_index')).rows.map(r=>({coin:`0x${Buffer.from(r.coin).toString('hex')}`,block:Number(r.block),sec:r.sec,usd:r.usd}));}
describe('replay market window',()=>{
 it('matches SQL ranks at random dense blocks, retains every creation snapshot and serves the forward path without rank SQL',async()=>{
  const db=await growingReplayFixture({coins:300,swapsPerCoin:300,holdersPerCoin:25,hours:6,staggered:true});
  try{
   // Include unpriced/zero/negative samples; the market predicate remains usd>0.
   await db.sql.query('UPDATE swaps SET usd=CASE WHEN log_index%29=0 THEN NULL WHEN log_index%31=0 THEN 0 WHEN log_index%37=0 THEN -1 ELSE 10 END');
   const clock:ClockCache=new Map();await refreshClock(db,clock);const cache=new ReplayCache(db,1800,clock);await cache.initialize();
   let state=41;const blocks=[...new Set([1,300,600,1800,...Array.from({length:45},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return 1+state%1800;})])].sort((a,b)=>a-b);
   for(const block of blocks){const sec=epoch+(block-1)*12+1;const query=vi.spyOn(db.sql,'query');let actual;
    try{actual=await cache.ranked(block,sec);expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
    expect(actual).toEqual(await sqlRanks(db,block,sec));
   }
   const read=vi.fn(async()=>[]);for(let pass=0;pass<3;pass++)for(let block=1;block<=300;block++)await cache.trending(block,read);
   expect(read).toHaveBeenCalledTimes(300);
   // Retrospective horizons must agree too, without moving the forward lane back.
   expect(await cache.ranked(2,epoch+13)).toEqual(await sqlRanks(db,2,epoch+13));
  }finally{await db.close();}
 },denseMarketBudgetMs);
 it('ranks exact fractional sums and address ties identically in live and replay, excluding non-finite USD even on historical reads',async()=>{
  const db=await growingReplayFixture({coins:3,swapsPerCoin:3,holdersPerCoin:3,hours:1});
  try{
   await db.sql.query('DELETE FROM swaps');let id=1;
   const add=async(coin:number,block:number,sec:number,usd:number)=>{await db.insert('swaps',{coin:binary(sampleAddress(coin)),block:String(block),ts:new Date(sec*1000),tx_hash:binary(`0x${(id++).toString(16).padStart(64,'0')}`),log_index:0,venue:'pons_curve',pool_id:binary(sampleAddress(coin)),quote_asset:binary(sampleAddress(0)),trader:binary(sampleAddress(999)),tx_from:binary(sampleAddress(999)),tx_to:binary(sampleAddress(coin)),side:1,amount_coin:'1',amount_quote:'1',price_quote:1,usd});};
   for(const usd of [0.1,0.2,0.3])await add(100,1,epoch,usd);
   for(const usd of [0.3,0.2,0.1])await add(101,1,epoch,usd);
   await add(99,1,epoch,0.6);await add(105,1,epoch,0.6000000000000001);
   await add(106,1,epoch,Infinity);await add(107,1,epoch,NaN);
   await add(102,2,epoch+7200,2); // Future timestamp in an already indexed block is included by SQL.
   await add(102,3,epoch+10,5); // Non-monotonic block timestamps still expire correctly.
   await add(103,4,epoch+3600,1); // Missing token metadata does not exclude a market-rank participant.
   await add(104,5,epoch+7200,NaN);
   await db.sql.query('UPDATE swaps SET ts=to_timestamp($1) WHERE coin=$2 AND block=3',[epoch+0.000001,binary(sampleAddress(102))]);
   const data=await rows(db),window=new MarketWindow(data);
   expect([...window.ranked(1,epoch).keys()]).toEqual([105,100,101,99].map(sampleAddress));
   expect(exactRanks([...data].reverse(),1,epoch)).toEqual(window.ranked(1,epoch));
   expect(window.rows.every(row=>Number.isFinite(row.usd))).toBe(true);
   for(const [block,sec] of [[1,epoch],[2,epoch+1],[3,epoch+3600],[4,epoch+7200],[5,epoch+7201],[1,epoch]]){
    const actual=window.ranked(block,sec),query=vi.spyOn(db.sql,'query');
    try{expect(actual).toEqual(await liveRanks(db,block,sec));expect(query).toHaveBeenCalledTimes(1);}finally{query.mockRestore();}
    expect(actual).toEqual(exactRanks(data,block,sec));
    expect([...actual.keys()]).not.toContain(sampleAddress(104));expect([...actual.keys()]).not.toContain(sampleAddress(106));expect([...actual.keys()]).not.toContain(sampleAddress(107));
   }
  }finally{await db.close();}
 },20000);
 it('matches live exact ranks at randomized dense fractional checkpoints with sparse repeated-size coins and no replay queries',async()=>{
  const db=await growingReplayFixture({coins:300,activeCoins:200,swapsPerCoin:300,holdersPerCoin:25,hours:6,staggered:true,fractional:true});
  try{
   const clock:ClockCache=new Map();await refreshClock(db,clock);const cache=new ReplayCache(db,1800,clock);await cache.initialize();
   let state=71;const blocks=[...new Set([1,300,600,1800,...Array.from({length:45},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return 1+state%1800;})])].sort((a,b)=>a-b);
   for(const block of blocks){const sec=epoch+(block-1)*12+1,query=vi.spyOn(db.sql,'query');let actual;
    try{actual=await cache.ranked(block,sec);expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
    expect(actual).toEqual(await liveRanks(db,block,sec));
   }
   const query=vi.spyOn(db.sql,'query');let historical;
   try{historical=await cache.ranked(2,epoch+13);expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
   expect(historical).toEqual(await liveRanks(db,2,epoch+13));
  }finally{await db.close();}
 },denseMarketBudgetMs);

});
