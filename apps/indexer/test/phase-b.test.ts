import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, hex, migrate, holders, candles, rebuildBars, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry, v3Abi, v4Abi, erc20Abi } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, toHex, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import { PonsBackfill } from '../src/backfill.js';
import { BlockDecoder } from '../src/decode.js';
import { HeadFollower } from '../src/head.js';
import { BlockRows } from '../src/rows.js';
import { Metrics, type ChainClient, type RpcBlock, type RpcLog, type RpcReceipt } from '../src/types.js';
import { native, lower } from '../src/clients.js';
const registry = loadRegistry(), quiet = () => {};
const address = (n: number): Address => `0x${n.toString(16).padStart(40,'0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64,'0')}`;
const coin = address(1), actor = address(2), dead = address(0xdead);
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
async function database() { const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db); return db; }
const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
function block(n: number, timestamp = epoch): RpcBlock { return { number: toHex(n), hash: hash(n), parentHash: hash(Math.max(0,n-1)), timestamp: toHex(timestamp), transactions: [] }; }
function event(event: AbiEvent, emitter: Address, args: Record<string, unknown>, b: RpcBlock, index = 0): RpcLog {
  return { address: emitter, topics: encodeEventTopics({ abi: [event], args }) as [Hex,...Hex[]],
    data: encodeAbiParameters(event.inputs.filter(p => !p.indexed), event.inputs.filter(p => !p.indexed).map(p => args[p.name!])),
    blockNumber: b.number, blockHash: b.hash, transactionHash: hash(Number(BigInt(b.number))+100), logIndex: toHex(index) };
}
function fixtureClient(logs: RpcLog[], end = 20): ChainClient {
  const getBlock = (n: bigint) => {
    const b = block(Number(n), epoch - (end-Number(n))*86400);
    const selected = logs.filter(l => BigInt(l.blockNumber) === n);
    if (selected[0]) b.hash = selected[0].blockHash;
    b.transactions = [...new Set(selected.map(l => l.transactionHash))].map(h => ({ hash: h, from: actor, to: registry.requireAddress('uniswapV4.universalRouter') }));
    return b;
  };
  return { chainId: async () => 4663, head: async () => BigInt(end), block: async n => getBlock(n), header: async n => getBlock(n),
    receipts: async n => getBlock(n).transactions.map(tx => ({ transactionHash: tx.hash, blockHash: getBlock(n).hash, blockNumber: toHex(n), from: tx.from, to: tx.to, logs: logs.filter(l => l.transactionHash === tx.hash && BigInt(l.blockNumber) === n) })),
    logs: async f => logs.filter(l => BigInt(l.blockNumber)>=f.from && BigInt(l.blockNumber)<=f.to &&
      (!f.address || lower(l.address)===lower(f.address)) && (!f.addresses || f.addresses.some(a => lower(a)===lower(l.address))) &&
      (f.topicFilters ? f.topicFilters.every((t,i) => t==null || (Array.isArray(t) ? t.includes(l.topics[i]) : t===l.topics[i])) : f.topics.includes(l.topics[0]))),
    tokenMetadata: async () => ({ name: 'Sample token', symbol: 'DEMO', decimals: 18, totalSupply: 1000n*10n**18n }),
    tokenMetadataBatch: async (addresses,n) => addresses.map(() => ({ name: 'Sample token', symbol: 'DEMO', decimals: 18, totalSupply: 1000n*10n**18n, supplyBlock: n })),
    code: async () => '0x', v3Pool: async () => null, ethUsdRate: async n => ({ value: 3000, block: n, source: { address: registry.requireAddress('uniswapV3.quoterV2'), venue: 'uniswap_v3' as const, fee: 3000 } }) };
}
function worker(db: ChainDb, client: ChainClient) { return new PonsBackfill(client,db,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{ workers: 2, logRange: 2000, logger: quiet }); }
async function token(db: ChainDb, launchpad: string | null = null) { await db.insert('tokens', { address: binary(coin), decimals: 2, total_supply: '100000', supply_block: '1', first_block: '0', block: '0', launchpad }); }
function swap(rows: BlockRows, n: number, seconds: number, usd: number, venue = 'uniswap_v4') {
  rows.add('swaps', { ts: new Date((epoch+seconds)*1000), block: String(n), tx_hash: binary(hash(n)), log_index: 0,
    coin: binary(coin), quote_asset: binary(native), pool_id: binary(hash(500)), trader: binary(actor), tx_from: binary(actor), tx_to: binary(actor),
    venue, side: 1, amount_coin: '100', amount_quote: '1', price_quote: 1, usd, priced_block: String(n) });
}

describe('Phase B on PGlite', () => {
  it('discovers fixture pools, corrects provisional creation blocks, batches supply, and marks Pons-hook graduation', async () => {
    const db = await database();
    const captured = JSON.parse(readFileSync(new URL('./fixtures/4663/blocks.json',import.meta.url),'utf8'));
    const v3 = captured.v3PoolCreated.receipts.flatMap((r: RpcReceipt) => r.logs).filter((l: RpcLog) => l.topics[0]===toEventSelector(v3Abi[0]));
    const v4 = JSON.parse(readFileSync(new URL('../../../packages/chain/test/fixtures/4663/v4-initialize-donate-logs.json',import.meta.url),'utf8')).logs.Initialize as RpcLog[];
    const all: RpcLog[] = [...v3,...v4].map((l,i) => ({ ...l,blockNumber:toHex(i+10),blockHash:hash(i+10),transactionHash:hash(i+110),logIndex:toHex(i) }));
    const pons = event(v4Abi[0],registry.requireAddress('uniswapV4.poolManager'),{ id:hash(500), currency0:native,currency1:coin,fee:100,tickSpacing:1,hooks:registry.requireAddress('pons.v4Hook'),sqrtPriceX96:1n,tick:0 },block(15)); all.push(pons);
    const client=fixtureClient(all); const metadata=vi.spyOn(client,'tokenMetadataBatch');
    // A head read had first observed this same pool later in history.
    await db.insert('pools',{ id:binary(hash(500)),venue:'uniswap_v4',currency0:binary(native),currency1:binary(coin),fee:100,tick_spacing:1,created_block:'20',block:'20' });
    await worker(db,client).run('logs:pools',0n,20n);
    const pools=(await db.sql.query<{ created_block: string; creation_verified: boolean }>('SELECT * FROM pools ORDER BY created_block')).rows;
    expect(pools).toHaveLength(all.length); expect(pools.every(p=>p.creation_verified)).toBe(true); expect(pools.map(p=>Number(p.created_block))).toEqual(all.map(l=>Number(BigInt(l.blockNumber))));
    const graduated=(await db.sql.query<{ graduated_pool: Uint8Array; graduated_block: string; total_supply: string }>('SELECT * FROM tokens WHERE address=$1',[binary(coin)])).rows[0];
    expect(hex(graduated.graduated_pool)).toBe(hash(500)); expect(Number(graduated.graduated_block)).toBe(15); expect(graduated.total_supply).toBe((1000n*10n**18n).toString()); expect(metadata).toHaveBeenCalled();
    await worker(db,client).run('logs:pools',0n,20n); expect((await db.sql.query('SELECT * FROM pools')).rows).toHaveLength(all.length);
  });

  it('filters recent v3 pairs and old Pons v4 pools; resumes and handles provider array/density limits', async () => {
    const db=await database(); const manager=registry.requireAddress('uniswapV4.poolManager'); const recent=address(30),old=address(31);
    const logs=[event(v3Abi[0],registry.requireAddress('uniswapV3.factory'),{token0:coin,token1:registry.requireAddress('tokens.WETH'),fee:3000,tickSpacing:60,pool:recent},block(16)),
      event(v3Abi[0],registry.requireAddress('uniswapV3.factory'),{token0:coin,token1:registry.requireAddress('tokens.WETH'),fee:3000,tickSpacing:60,pool:old},block(1)),
      event(v4Abi[0],manager,{id:hash(500),currency0:native,currency1:coin,fee:100,tickSpacing:1,hooks:registry.requireAddress('pons.v4Hook'),sqrtPriceX96:1n,tick:0},block(2)),
      event(v3Abi.find(e=>e.name==='Swap')!,recent,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:2n*10n**18n,sqrtPriceX96:1n,liquidity:1n,tick:0},block(20),0),
      event(v3Abi.find(e=>e.name==='Swap')!,old,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:2n*10n**18n,sqrtPriceX96:1n,liquidity:1n,tick:0},block(20),1),
      event(v4Abi.find(e=>e.name==='Swap')!,manager,{id:hash(500),sender:actor,amount0:-2n*10n**18n,amount1:100n*10n**18n,sqrtPriceX96:1n,liquidity:1n,tick:0,fee:100},block(20),2)];
    const client=fixtureClient(logs); await worker(db,client).run('logs:pools',0n,20n);
    const original=client.logs; const calls=vi.spyOn(client,'logs').mockImplementation(async f => {
      if (f.to>f.from) throw new Error('logs matched by query exceeds limit of 10000');
      if (f.addresses && f.addresses.length>1) throw new Error('too many addresses');
      return original(f);
    });
    await worker(db,client).run('logs:pair_swaps',0n,20n);
    const swaps=(await db.sql.query<{ usd: number; pool_id: Uint8Array }>('SELECT * FROM swaps ORDER BY log_index')).rows;
    expect(swaps.map(s=>hex(s.pool_id))).toEqual([recent,hash(500)]); expect(swaps.map(s=>s.usd)).toEqual([6000,6000]);
    expect(calls.mock.calls.some(([f])=>f.addresses?.includes(recent))).toBe(true);
    expect(calls.mock.calls.some(([f])=>Array.isArray(f.topicFilters?.[1]) && f.topicFilters[1].includes(hash(500)))).toBe(true);
    const before=calls.mock.calls.length; await worker(db,client).run('logs:pair_swaps',0n,20n); expect(calls.mock.calls.length).toBe(before);
    expect((await db.sql.query('SELECT * FROM bars_1m')).rows).toHaveLength(1);
    // A new target set gets its own completion records, while event keys deduplicate old results.
    await db.insert('pools',{id:binary(address(32)),venue:'uniswap_v3',currency0:binary(coin),currency1:binary(native),fee:100,tick_spacing:1,created_block:'18',block:'18',creation_verified:true});
    await worker(db,client).run('logs:pair_swaps',0n,20n); expect(calls.mock.calls.length).toBeGreaterThan(before); expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(2);
    const logger=vi.fn(); const head=new HeadFollower(client,db,new BlockDecoder(client,registry,new Metrics(quiet),logger),{ reorgDepth:256 });
    const b=await client.block(20n);await head.ingest(b,await client.receipts(20n));
    expect(logger.mock.calls.some(([name])=>name==='unknown_pool')).toBe(false);
    expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(3);
  });

  it('backfills tracked transfers and recomputes mint/burn/self-transfer balances idempotently with historical holders', async () => {
    const db=await database(); await token(db,'pons'); await db.sql.query('UPDATE tokens SET curve=$1',[binary(address(3))]);
    const transfers: RpcLog[]=[];
    for(let i=0;i<12;i++) transfers.push(event(erc20Abi[0],coin,{from:native,to:address(i+10),value:100n},block(1),i));
    transfers.push(event(erc20Abi[0],coin,{from:address(10),to:dead,value:10n},block(2)),event(erc20Abi[0],coin,{from:address(10),to:coin,value:10n},block(3)),
      event(erc20Abi[0],coin,{from:address(10),to:address(10),value:50n},block(4)),event(erc20Abi[0],coin,{from:native,to:address(3),value:30n},block(5)));
    const client=fixtureClient(transfers); await worker(db,client).run('logs:holders',0n,20n);
    const current=await holders(db,coin,20n,20); expect(current.holderCount).toBe(13); expect(current.heldAmount).toBe('1210'); expect(current.top10Share).toBeCloseTo(1000/1210); expect(current.holders.find(h=>h.address===address(3))?.isPonsCurve).toBe(true);
    expect(current.holders.find(h=>h.address===address(10))?.amount).toBe('80'); expect(current.holders.some(h=>[native,coin,dead].includes(h.address))).toBe(false);
    expect((await holders(db,coin,1n)).heldAmount).toBe('1200');
    const before=(await db.sql.query('SELECT * FROM balances ORDER BY holder')).rows;
    await db.sql.query("UPDATE ingest_ranges SET status='todo' WHERE stream LIKE 'logs:holders:%'");
    await worker(db,client).run('logs:holders',0n,20n); expect((await db.sql.query('SELECT * FROM balances ORDER BY holder')).rows).toEqual(before);
    await db.tx(tx=>tx.deleteAbove(2n)); expect((await holders(db,coin,20n)).heldAmount).toBe('1190'); expect((await db.sql.query<{ amount: string }>('SELECT amount FROM balances WHERE holder=$1',[binary(address(10))])).rows[0].amount).toBe('90');
  });
});

describe('candles and derived state',()=>{
  it('keeps OHLCV ordered across minutes, aggregates 5m/1h, clips 1s/15s to six hours, and rebuilds/reorgs',async()=>{
    const db=await database(); await token(db); const rows=new BlockRows();
    [[1,0,2],[2,2,5],[3,10,1],[4,59,3],[5,60,4],[6,300,6]].forEach(([n,t,p])=>swap(rows,n,t,p));
    await db.ensurePartitions(new Date(epoch*1000));await db.tx(async tx=>{ await rows.flush(tx); });
    const minutes=await candles(db,coin,'1m',epoch,epoch+3600,epoch+3600);
    expect(minutes.bars.map(b=>[b.o,b.h,b.l,b.c,b.vUsd,b.trades])).toEqual([[2,5,1,3,11,4],[4,4,4,4,4,1],[6,6,6,6,6,1]]); expect(minutes.bars[0].marketCapUsd).toBe(3000); expect(minutes.asOfBlock).toBe(6);
    const five=await candles(db,coin,'5m',epoch,epoch+3600); expect(five.bars.map(b=>[b.o,b.h,b.l,b.c,b.vUsd])).toEqual([[2,5,1,4,15],[6,6,6,6,6]]);
    expect((await candles(db,coin,'1h',epoch,epoch+3600)).bars[0]).toMatchObject({o:2,h:6,l:1,c:6,vUsd:21,trades:6});
    expect((await candles(db,coin,'1s',epoch,epoch+3600,epoch+21602)).bars.map(b=>b.ts)).toEqual([epoch+2,epoch+10,epoch+59,epoch+60,epoch+300]);
    expect((await candles(db,coin,'15s',epoch,epoch+3600,epoch+21602)).bars[0]).toMatchObject({o:5,h:5,l:1,c:1,vUsd:6});
    expect((await candles(db,coin,'15s',epoch,epoch+3600,epoch+30000)).bars).toEqual([]);
    await db.sql.query('DELETE FROM bars_1m'); await db.tx(tx=>rebuildBars(tx,2n,5n)); expect((await candles(db,coin,'1m',epoch,epoch+300)).bars).toEqual(minutes.bars.slice(0,2));
    await db.tx(tx=>tx.deleteAbove(3n)); expect((await candles(db,coin,'1m',epoch,epoch+3600)).bars[0]).toMatchObject({o:2,h:5,l:1,c:1,vUsd:8,trades:3});
  });
  it('includes curve trades before graduation and pool swaps afterward, recalculating the graduation minute',async()=>{
    const db=await database();await token(db,'pons'); const rows=new BlockRows(); swap(rows,1,0,2,'pons_curve');swap(rows,2,2,100);swap(rows,3,3,200,'pons_curve');swap(rows,4,4,4);
    await db.ensurePartitions(new Date(epoch*1000));await db.tx(async tx=>{await rows.flush(tx);});
    expect((await candles(db,coin,'1m',epoch,epoch+60)).bars[0].vUsd).toBe(202);
    const graduation=new BlockRows(); graduation.graduation(coin,hash(500),3n); await db.tx(tx=>graduation.flush(tx));
    expect((await candles(db,coin,'1m',epoch,epoch+60)).bars[0]).toMatchObject({o:2,h:4,l:2,c:4,vUsd:6,trades:2});
    expect((await candles(db,coin,'1s',epoch,epoch+60,epoch+60)).bars.map(b=>b.vUsd)).toEqual([2,4]);
    await db.tx(tx=>tx.deleteAbove(2n));expect((await candles(db,coin,'1m',epoch,epoch+60)).bars[0].vUsd).toBe(2);
  });
  it('classifies ERC-721 and unknown topics separately, samples once per reason, and counts genuinely malformed logs',async()=>{
    const db=await database();await token(db);const b=block(1); const nft={...event(erc20Abi[0],coin,{from:native,to:actor,value:1n},b),data:'0x' as Hex};nft.topics.push(hash(7));
    const unknown={...nft,topics:[hash(999)] as [Hex],logIndex:'0x1' as Hex};const bad={...nft,topics:nft.topics.slice(0,3) as [Hex,...Hex[]],logIndex:'0x2' as Hex};
    b.transactions=[{hash:nft.transactionHash,from:actor,to:actor}];const receipts=[{transactionHash:nft.transactionHash,blockHash:b.hash,blockNumber:b.number,logs:[nft,unknown,bad]}];
    const logger=vi.fn();const metrics=new Metrics(logger);const decoder=new BlockDecoder(fixtureClient([]),registry,metrics,quiet);const state=await decoder.prepare(db,b,receipts);
    decoder.collect(b,receipts,state);decoder.collect(b,receipts,state); metrics.observe(b.timestamp);
    expect(metrics.malformedLogs).toBe(2);expect(metrics.unknownTopics).toBe(2);
    const samples=logger.mock.calls.filter(([name])=>name==='log_classification_sample').map(([,fields])=>fields);
    expect(samples.map(s=>s.reason)).toEqual(['not_erc20','unknown_topic','malformed']); expect(Object.keys(samples[0]).sort()).toEqual(['address','data_length','reason','topic0','topic_count']);
    expect(logger.mock.calls.find(([name])=>name==='ingest_metrics')?.[1].log_reasons).toEqual({not_erc20:2,unknown_topic:2,malformed:2});
  });
  it('recovers on the second HTTP header read and keeps sampled head lag accurate',async()=>{
    const db=await database(); const client=fixtureClient([],1); let attempts=0; const metrics=new Metrics(quiet);
    client.header=async n=>{if(++attempts===1) throw new Error('Head not yet visible');return block(Number(n),epoch+20);};
    client.block=async n=>{await new Promise(resolve=>setTimeout(resolve,150));return block(Number(n),epoch);};
    const decoder=new BlockDecoder(client,registry,metrics,quiet);const logger=vi.fn();
    const head=new HeadFollower(client,db,decoder,{startBlock:0n,reorgDepth:256,logger});
    const write=decoder.write.bind(decoder);vi.spyOn(decoder,'write').mockImplementation(async(...args)=>{await write(...args);head.stop();});
    await head.run(); expect(attempts).toBe(2);expect(metrics.headLagMs).toBe(20000);expect(logger.mock.calls.some(([name])=>name==='head_time_error')).toBe(false);
  });
  it('retries a lagging HTTP head header once and falls back to applied time if both reads fail',async()=>{
    const db=await database();const client=fixtureClient([],1);let attempts=0;const metrics=new Metrics(quiet);
    client.header=async n=>{attempts++;if(attempts<=2) throw new Error('HTTP backend has not seen the WS head');return block(Number(n));};
    const decoder=new BlockDecoder(client,registry,metrics,quiet); const logs:string[]=[];
    const head=new HeadFollower(client,db,decoder,{startBlock:0n,reorgDepth:256,logger:name=>logs.push(name)});
    // Let the two header reads complete before applying the prefetched block.
    client.block=async n=>{await new Promise(resolve=>setTimeout(resolve,150));return block(Number(n),epoch-10);};
    const write=decoder.write.bind(decoder);vi.spyOn(decoder,'write').mockImplementation(async(...args)=>{await write(...args);head.stop();});
    await head.run();expect(attempts).toBe(2);expect(logs).toContain('head_time_error');expect(metrics.headLagMs).toBe(0);expect(await db.cursor('head')).toBe(0n);
  });
});
