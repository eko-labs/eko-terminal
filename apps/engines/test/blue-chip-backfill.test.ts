import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { backfillBlueChip, BLUE_CHIP_BACKFILL_WIDTH } from '../src/blue-chip.js';
import { EngineWorker } from '../src/worker.js';
import { sampleAddress } from './replay-fixture.js';

let db:ChainDb;
afterEach(async()=>{await db?.close();});
async function fixture(count=4) {
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  const date=new Date('2026-10-01T00:00:00Z');await db.ensurePartitions(date);
  await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) VALUES(1,$1,$2,'sample')",[date,binary(`0x${'01'.repeat(32)}`)]);
  for(let i=1;i<=count;i++) {
    const coin=binary(sampleAddress(i));
    await db.insert('tokens',{address:coin,deployer:binary(sampleAddress(9000)),first_block:'1',block:'1',name:'Sample coin',symbol:'SAMPLE',launchpad:i===3?'pons':'other',curve:i===3?binary(sampleAddress(8000)):null});
    await db.sql.query('INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad) VALUES($1,2,$2,1,\'new\',1,\'other\') ON CONFLICT DO NOTHING',[coin,date]);
    if(i===4)continue;
    const card={identity:{createdAt:date.toISOString()},verdict:{level:i===2?'danger':'clear'}};
    await db.sql.query('INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES($1,$2,1,$1,$3)',[`sample:${i}`,coin,card]);
    await db.sql.query('INSERT INTO coin_card_latest VALUES($1,$2,1,$3)',[coin,`sample:${i}`,card]);
  }
}
describe('Blue chip local backfill',()=>{
  it('fills all listed grades, curves and missing cards without acquisitions or rating writes',async()=>{
    await fixture();const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('no outbound call'));
    const before=(await db.sql.query('SELECT * FROM coin_card_latest ORDER BY coin')).rows;
    const notices:unknown[]=[];const off=await db.bus.subscribe(m=>notices.push(m));
    try {
      expect(await backfillBlueChip(db)).toBe(4);
      const rows=(await db.sql.query('SELECT * FROM read_blue_chip ORDER BY coin')).rows;
      expect(rows).toHaveLength(4);expect(rows[0]).toMatchObject({real_pool:false,liquidity_usd:null,holders:0});
      expect(rows[3]).toMatchObject({real_pool:false,liquidity_usd:null,holders:null});
      expect(await backfillBlueChip(db)).toBe(0);
      expect((await db.sql.query('SELECT * FROM coin_card_latest ORDER BY coin')).rows).toEqual(before);
      expect((await db.sql.query('SELECT * FROM engine_runs')).rows).toHaveLength(0);
      expect(notices).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
    } finally {await off();fetcher.mockRestore();}
  });
  it('bounds each pass and resumes from durable rows after a restart',async()=>{
    await fixture(BLUE_CHIP_BACKFILL_WIDTH+1);
    expect(await backfillBlueChip(db)).toBe(BLUE_CHIP_BACKFILL_WIDTH);
    expect(await backfillBlueChip(db)).toBe(1);
    expect((await db.sql.query('SELECT * FROM read_blue_chip')).rows).toHaveLength(BLUE_CHIP_BACKFILL_WIDTH+1);
  });
  it('runs the backfill with the feature and rerating disabled',async()=>{
    await fixture();const worker=new EngineWorker(db,{blueChipEnabled:false,rerate:false,pollMs:1});
    vi.spyOn(worker,'poll').mockImplementation(async()=>{
      if((await db.sql.query('SELECT * FROM read_blue_chip')).rows.length===4)worker.stop();
      return 0;
    });
    await worker.run();expect((await db.sql.query('SELECT * FROM read_blue_chip')).rows).toHaveLength(4);
  });
  it('measures priced pools at the card block and preserves existing newer measurements',async()=>{
    await fixture();const coin=binary(sampleAddress(1)),pool=binary(sampleAddress(7000)),quote=binary(sampleAddress(9000));
    const date=new Date('2026-10-01T00:00:00Z'),hash=binary(`0x${'02'.repeat(32)}`);
    await db.insert('pools',{id:pool,venue:'uniswap_v3',currency0:coin,currency1:quote,fee:3000,tick_spacing:1,created_block:'1',block:'1'});
    await db.insert('swaps',{coin,quote_asset:quote,pool_id:pool,block:'1',ts:date,tx_hash:hash,log_index:0,venue:'uniswap_v3',side:1,amount_coin:'100',amount_quote:'100',usd:100});
    await db.insert('liquidity_events',{pool_id:pool,block:'1',ts:date,tx_hash:hash,log_index:1,venue:'uniswap_v3',kind:'Mint',data:{tickLower:'-887200',tickUpper:'887200',amount:'10000'}});
    await db.sql.query('INSERT INTO balances(token,holder,amount,last_block) VALUES($1,$2,100,1)',[coin,quote]);
    await db.sql.query('INSERT INTO read_blue_chip VALUES($1,2,$2,true,30000,300)',[binary(sampleAddress(2)),date]);
    await backfillBlueChip(db);
    const measured=(await db.sql.query<{liquidity_usd:number;holders:string;real_pool:boolean}>('SELECT * FROM read_blue_chip WHERE coin=$1',[coin])).rows[0];
    expect(measured.real_pool).toBe(true);expect(measured.liquidity_usd).toBeCloseTo(20000,4);expect(Number(measured.holders)).toBe(1);
    expect((await db.sql.query('SELECT as_of_block FROM read_blue_chip WHERE coin=$1',[binary(sampleAddress(2))])).rows[0].as_of_block).toBe(2);
  });
});
