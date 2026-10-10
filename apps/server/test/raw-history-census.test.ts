import { expect, it } from 'vitest';
import { binary, migrate, migrateEngines, readMarkers, runRetention } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { refreshCensus, refreshCoinFlow, FP_MODEL } from '@eko/engines';
const addr=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
const hash=(n:number)=>binary(`0x${n.toString(16).padStart(64,'0')}`);
it('keeps the seven-day Census identical and ends individual trade markers at the compacted window',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),epoch=Date.parse('2026-10-01'),day=86400000,coin=addr(1);
  try {
    await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(epoch));
    await db.insert('tokens',{address:binary(coin),first_block:1,block:1,deployer:binary(addr(2)),decimals:0});
    for(let d=0;d<=20;d++)await db.insert('chain_blocks',{number:d+1,block:d+1,hash:hash(d+1),parent_hash:hash(d),ts:new Date(epoch+d*day)});
    for(const [wallet,kind] of [[3,'likely_agent'],[4,'human']] as const)await db.sql.query(
      "INSERT INTO wallet_labels VALUES($1,$2,$3,0.8,'medium','fingerprint',NULL,'{}',$4,1)",[`sample-label-${wallet}`,binary(addr(wallet)),kind,FP_MODEL.version]);
    for(const [d,wallet,usd] of [[0,3,1000],[14,3,10],[20,4,30]])await db.insert('swaps',{
      ts:new Date(epoch+d*day),block:d+1,tx_hash:hash(100+d),log_index:0,venue:'pons_curve',pool_id:binary(coin),coin:binary(coin),quote_asset:binary(addr(0)),
      trader:binary(addr(wallet)),side:1,amount_coin:'10',amount_quote:'1',price_quote:0.1,usd});
    const options={crewAt:async()=>({status:'available' as const,member:null})};
    await refreshCoinFlow(db,coin,21,options,epoch/1000-1);
    const census=()=>refreshCensus(db,{...options,finalized:{status:'available',block:21} as const});
    expect(await census()).toEqual({status:'available'});
    const read=async()=>(await db.sql.query('SELECT data FROM census_snapshots')).rows;
    const before=await read();expect((await readMarkers(db,coin,epoch/1000-1,(epoch+21*day)/1000)).markers).toHaveLength(3);
    expect((await runRetention(db,{quoteTokens:[],swapDays:1,transferDays:1,dryRun:false,pauseMs:0,now:()=>epoch+20*day})).historySwaps).toBe(2);
    expect(await read()).toEqual(before);expect(await census()).toEqual({status:'available'});expect(await read()).toEqual(before);
    const markers=await readMarkers(db,coin,epoch/1000-1,(epoch+21*day)/1000);
    expect(markers.markers).toHaveLength(1);expect(markers.markers.every(m=>m.ts>epoch/1000)).toBe(true);
  } finally {await db.close();}
});
