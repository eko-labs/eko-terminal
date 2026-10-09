import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { binary, runRetention } from '@eko/db';
import type { CoinCard } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BlueChipListingWorker } from '../src/blue-chip-listings.js';
import { BlueChipReader } from '../src/read/blue-chip.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
const now=Date.parse('2026-10-13T12:00:00Z');
let built:Awaited<ReturnType<typeof buildApp>>, card:CoinCard;
const listed=sampleAddress(8101),earned=sampleAddress(8102),recovered=sampleAddress(8103),curve=sampleAddress(8104),both=sampleAddress(8105);
const config={enabled:true,minAgeDays:3,minLiquidityUsd:25000,minHolders:250};
beforeAll(async()=>{
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'test-only-placeholder'.repeat(2),LEGACY_API:'false',RUN_WORKER:'false',MARKET_DATA_SOURCE:'onchain',BLUE_CHIP_ENABLED:'true'}),{startBackground:false});
  built.ctx.reads.store.now=()=>now;
  built.ctx.reads.store.blueChip=new BlueChipReader(built.ctx.dbh.chain,config,()=>now);
  card=await seedReadFixture(built.ctx.dbh.chain,now);
  const db=built.ctx.dbh.chain;
  for(const coin of [listed,earned,recovered,curve,both]){
    const copy=structuredClone(card);copy.identity.address=coin;copy.verdict.coin=coin;copy.verdict.level='clear';
    await db.insert('tokens',{address:binary(coin),first_block:String(card.verdict.asOfBlock),block:String(card.verdict.asOfBlock),deployer:binary(sampleAddress(8200)),name:'Sample coin',symbol:'SAMPLE',launchpad:'pons',curve:binary(sampleAddress(Number(BigInt(coin))+1000))});
    await db.sql.query('INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES($1,$2,$3,$1,$4)',[`sample:${coin}`,binary(coin),card.verdict.asOfBlock,copy]);
    await db.sql.query('INSERT INTO coin_card_latest VALUES($1,$2,$3,$4)',[binary(coin),`sample:${coin}`,card.verdict.asOfBlock,copy]);
    await db.sql.query('INSERT INTO read_blue_chip VALUES($1,$2,$3,$4,$5,$6)',[binary(coin),card.verdict.asOfBlock,new Date(now-3*86400000),coin!==curve,coin===listed ? 0 : 25000,250]);
  }
  await db.sql.query("INSERT INTO verdicts VALUES('sample-danger',$1,1,'sample','sample',$2)",[binary(recovered),{level:'danger'}]);
  for(const coin of [listed,both])await db.sql.query("INSERT INTO coin_listings(coin,source,external_id) VALUES($1,'coingecko','sample')",[binary(coin)]);
});
afterAll(async()=>{await built.close();});
describe('Blue chip indexed membership and routes',()=>{
  it('qualifies by either route and rejects curves and any past danger',async()=>{
    const reader=built.ctx.reads.store.blueChip!;
    const members=await reader.members([listed,earned,recovered,curve,both]);
    expect(members.get(listed)).toEqual({member:true,via:['coingecko']});
    expect(members.get(earned)).toEqual({member:true,via:['earned']});
    expect(members.get(both)).toEqual({member:true,via:['coingecko','earned']});
    expect(members.get(recovered)).toEqual({member:false,via:[]});expect(members.get(curve)?.member).toBe(false);
    await built.ctx.dbh.chain.sql.query("INSERT INTO verdict_events VALUES('sample-danger:orphaned','sample-danger','orphaned',1,'{}')");
    expect((await reader.members([recovered])).get(recovered)?.member).toBe(false);
    const response=await built.app.inject(`/v1/coins/${earned}`);expect(response.json().blueChip).toEqual({member:true,via:['earned']});expect(response.json().blueChipCriteria).toEqual(reader.criteria);
  });
  it('filters Radar and New pairs before pagination on both API versions without changing default lists',async()=>{
    for(const version of ['v1','v2'])for(const route of ['radar','pairs?stage=new']){
      const url=`/${version}/${route}`,separator=url.includes('?')?'&':'?';
      const all=(await built.app.inject(url)).json();const filtered=(await built.app.inject(`${url}${separator}blueChip=true`)).json();
      expect(all.rows.map((r:{address:string})=>r.address)).toEqual(expect.arrayContaining([listed,earned,recovered,curve,both]));
      expect(filtered.rows.map((r:{address:string})=>r.address).sort()).toEqual([listed,earned,both].sort());
      expect((await built.app.inject(`${url}${separator}blueChip=false`)).payload).toBe((await built.app.inject(url)).payload);
    }
  });
  it('enforces each earned floor, current Clear, and matching measurement block',async()=>{
    const db=built.ctx.dbh.chain,reader=built.ctx.reads.store.blueChip!;
    for(const [column,value] of [['created_at',new Date(now-3*86400000+1)],['liquidity_usd',24999],['holders',249],['as_of_block',0]] as const){
      await db.sql.query(`UPDATE read_blue_chip SET ${column}=$2 WHERE coin=$1`,[binary(earned),value]);
      expect((await reader.members([earned])).get(earned)?.member).toBe(false);
      await db.sql.query('UPDATE read_blue_chip SET as_of_block=$2,created_at=$3,liquidity_usd=25000,holders=250 WHERE coin=$1',[binary(earned),card.verdict.asOfBlock,new Date(now-3*86400000)]);
    }
    await db.sql.query("UPDATE coin_card_latest SET data=jsonb_set(data,'{verdict,level}','\"monitor\"') WHERE coin=$1",[binary(earned)]);
    expect((await reader.members([earned])).get(earned)?.member).toBe(false);
  });
  it('keeps every disabled response byte-identical, including filter requests and public config',async()=>{
    const store=built.ctx.reads.store,prior=store.blueChip;
    store.blueChip=new BlueChipReader(built.ctx.dbh.chain,{...config,enabled:false},()=>now);
    try{
      for(const url of ['/v1/radar','/v2/radar','/v1/pairs?stage=new','/v2/pairs?stage=new',`/v1/coins/${listed}`]){
        const disabled=(await built.app.inject(url)).payload;
        store.blueChip=undefined;expect((await built.app.inject(url)).payload).toBe(disabled);
        store.blueChip=new BlueChipReader(built.ctx.dbh.chain,{...config,enabled:false},()=>now);
        if(!url.includes('/coins/'))expect((await built.app.inject(`${url}${url.includes('?')?'&':'?'}blueChip=true`)).payload).toBe(disabled);
        expect(disabled).not.toContain('blueChip');
      }
      built.ctx.cfg.BLUE_CHIP_ENABLED=false;const disabled=(await built.app.inject('/v1/config')).payload;
      expect(disabled).not.toContain('blueChip');
      built.ctx.cfg.BLUE_CHIP_ENABLED=true;expect((await built.app.inject('/v1/config')).json().blueChip).toEqual(prior!.criteria);
    }finally{store.blueChip=prior;}
  });
});
describe('CoinGecko daily listing sync',()=>{
  it('uses one request, chain contracts only, retains first_seen and keeps the last list on failure',async()=>{
    const db=built.ctx.dbh.chain;let clock=now;
    const fetcher=vi.fn(async(_url:string | URL | Request,_init?:RequestInit)=>new Response(JSON.stringify([{id:'sample-coin',platforms:{robinhood:listed,ethereum:sampleAddress(8991)}},{id:'other',platforms:{ethereum:sampleAddress(8992)}}])));
    const worker=new BlueChipListingWorker(db,true,fetcher,()=>clock);
    expect(await worker.sync()).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
    const before=(await db.sql.query('SELECT * FROM coin_listings ORDER BY coin')).rows;
    expect(await worker.sync()).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
    clock+=86400000;fetcher.mockImplementationOnce(async()=>{throw new Error('offline');});
    expect(await worker.sync()).toBe(false);expect((await db.sql.query('SELECT * FROM coin_listings ORDER BY coin')).rows).toEqual(before);
    expect(await worker.sync()).toBe(true);const after=(await db.sql.query<{first_seen:Date;last_seen:Date}>('SELECT first_seen,last_seen FROM coin_listings WHERE coin=$1',[binary(listed)])).rows[0];
    expect(after.first_seen).toEqual((before.find((r)=>Buffer.from(r.coin as Uint8Array).equals(binary(listed)))!).first_seen);expect(after.last_seen).toEqual(new Date(clock));
  });
  it('makes no request or database read when disabled',async()=>{
    const fetcher=vi.fn(),db={sql:{query:()=>{throw new Error('disabled');}}} as unknown as typeof built.ctx.dbh.chain;
    const worker=new BlueChipListingWorker(db,false,fetcher);worker.start();expect(await worker.sync()).toBe(false);await worker.stop();expect(fetcher).not.toHaveBeenCalled();
  });
});


it('keeps published blue-chip membership when expired raw partitions are sealed and dropped',async()=>{
 const reader=built.ctx.reads.store.blueChip!,coins=[listed,earned,recovered,curve,both];
 await built.ctx.dbh.chain.sql.query("UPDATE coin_card_latest SET data=jsonb_set(data,'{verdict,level}','\"clear\"') WHERE coin=$1",[binary(earned)]);
 const before=await reader.members(coins);expect(before.get(earned)?.member).toBe(true);
 await runRetention(built.ctx.dbh.chain,{quoteTokens:[],swapDays:7,transferDays:3,dryRun:false,now:()=>now+8*86400000});
 expect(await reader.members(coins)).toEqual(before);
});
