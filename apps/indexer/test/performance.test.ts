import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, hex, migrate, ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry, ponsCurveAbi, decodeResult, createMeteredClients, type FetchFn, type UsageStore } from '@eko/chain';
import { toEventSelector, toHex, getAddress, type AbiEvent, type Address, type Hex } from 'viem';
import { HeadFollower } from '../src/head.js';
import { BlockDecoder } from '../src/decode.js';
import { PonsBackfill } from '../src/backfill.js';
import { createClients } from '../src/clients.js';
import { LogHeadFollower } from '../src/log-head.js';
import { BlockRows } from '../src/rows.js';
import { catchUpChain, logsOf, seedCatchUp } from './catch-up-fixture.js';
import { Metrics, type ChainClient, type RpcBlock, type RpcReceipt, type PoolMetadata } from '../src/types.js';
import { ethUsdFromSlot0, priceSampleBlock } from '../src/price.js';
const registry = loadRegistry(); const quiet = () => {};
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/4663/blocks.json', import.meta.url), 'utf8')) as Record<string, { block: RpcBlock; receipts: RpcReceipt[] }>;
const handles: ChainDb[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map(db => db.close())); });
async function database() { const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db); return db; }
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function empty(n: number, id = n, parent = n - 1): RpcBlock {
  return { number: toHex(n), hash: hash(id), parentHash: hash(Math.max(0, parent)), timestamp: toHex(1800000000 + Math.floor(n / 10)), transactions: [] };
}
function clientFor(blocks: Map<bigint, RpcBlock>, receipts = new Map<bigint, RpcReceipt[]>()): ChainClient {
  return {
    chainId: async () => 4663, head: async () => [...blocks.keys()].reduce((a,b) => a > b ? a : b),
    block: async n => { const block = blocks.get(n); if (!block) throw new Error('Block absent from test'); return block; },
    header: async n => blocks.get(n)!, receipts: async n => receipts.get(n) ?? [], logs: async () => [],
    code: async () => '0x', v3Pool: async () => null,
    tokenMetadata: async () => ({ symbol: '<sample>', name: '<sample>', decimals: 18 }),
    tokenMetadataBatch: async addresses => addresses.map(() => ({ symbol: '<sample>', name: '<sample>', decimals: 18 })),
    ethUsdRate: async n => ({ value: 2000, block: n, source: { address: registry.requireAddress('uniswapV3.quoterV2'), venue: 'uniswap_v3' as const, fee: 3000 } }),
  };
}
function tradeBlocks(count: number, first = 1200) {
  const template = fixtures.ponsLaunch;
  const curveBuy = toEventSelector(ponsCurveAbi.find(a => a.type === 'event' && a.name === 'CurveBuy') as AbiEvent);
  const templateReceipt = template.receipts.find(r => r.logs.some(l => l.topics[0] === curveBuy))!;
  const templateLogs = templateReceipt.logs.filter(l => l.topics[0] === curveBuy);
  const blocks = new Map<bigint, RpcBlock>(), receipts = new Map<bigint, RpcReceipt[]>();
  const tx = template.block.transactions.find(t => t.hash === templateReceipt.transactionHash)!;
  for (let i = 0; i < count; i++) {
    const n = first + i, block = empty(n), txHash = hash(n + 100000);
    block.transactions = [{ ...tx, hash: txHash }];
    const logs = templateLogs.map(l => ({ ...l, blockNumber: block.number, blockHash: block.hash, transactionHash: txHash, blockTimestamp: block.timestamp }));
    blocks.set(BigInt(n), block); receipts.set(BigInt(n), [{ ...templateReceipt, blockHash: block.hash, blockNumber: block.number, transactionHash: txHash, logs }]);
  }
  return { blocks, receipts, token: '0x7d33d051e0311bcdef1063eedf7ba1c83bae0383' as Address, curve: templateLogs[0].address };
}
async function seedToken(db: ChainDb, token: Address, curve: Address) {
  await db.insert('tokens', { address: binary(token), curve: binary(curve), name: '<raw-name>', symbol: '<raw-symbol>', decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
}

describe('bounded head prefetch', () => {
  it.each([{ start: undefined, expected: 105 }, { start: 101n, expected: 101 }, { start: 0n, expected: 0 }])('chooses current head or explicit start: $expected', async ({ start, expected }) => {
    const db = await database(); const blocks = new Map(Array.from({ length: 106 }, (_, n) => [BigInt(n), empty(n)]));
    const client = clientFor(blocks); const reads = vi.spyOn(client, 'receipts'); const decoder = new BlockDecoder(client, registry, new Metrics(quiet), quiet);
    const head = new HeadFollower(client, db, decoder, { startBlock: start, prefetchBlocks: 4, reorgDepth: 256, logger: quiet });
    const applied: bigint[] = []; const write = decoder.write.bind(decoder);
    vi.spyOn(decoder, 'write').mockImplementation(async (...args) => { applied.push(BigInt(args[1].number)); await write(...args); head.stop(); });
    await head.run(); expect(applied).toEqual([BigInt(expected)]); expect(reads.mock.calls[0][0]).toBe(BigInt(expected)); expect(await db.cursor('head')).toBe(BigInt(expected));
  });
  it('resumes the saved cursor even when an explicit start disagrees', async () => {
    const db = await database(), blocks = new Map([ [100n, empty(100)], [101n, empty(101)] ]); const client = clientFor(blocks);
    await db.insert('chain_blocks', { number: '100', block: '100', hash: binary(hash(100)), parent_hash: binary(hash(99)), ts: new Date(1800000010000) }); await db.setCursor('head', 100n, hash(100));
    const decoder = new BlockDecoder(client,registry,new Metrics(quiet),quiet); const head = new HeadFollower(client,db,decoder,{startBlock:0n,reorgDepth:256,logger:quiet});
    vi.spyOn(decoder,'write').mockImplementation(async()=>{head.stop();}); await head.run(); expect(await db.cursor('head')).toBe(101n);
  });
  it('applies out-of-order fetches in order, discards the old window on reorg, and re-fetches replacement blocks', async () => {
    const db=await database();const old=new Map<bigint,RpcBlock>([[0n,empty(0)],[1n,empty(1,101,0)],[2n,empty(2,102,101)],[3n,empty(3,103,102)],[4n,empty(4,104,103)]]);
    const canonical=new Map<bigint,RpcBlock>([[0n,empty(0)],[1n,empty(1,201,0)],[2n,empty(2,202,201)],[3n,empty(3,203,202)],[4n,empty(4,204,203)]]);
    let reorg=false, active=0, maxActive=0; const calls=new Map<bigint,number>();const completion:bigint[]=[];
    let switchBranch!:()=>void;const switched=new Promise<void>(resolve=>{switchBranch=resolve;});
    const client=clientFor(old);client.header=async n=>(reorg?canonical:old).get(n)!;
    client.block=async n=>{
      const count=(calls.get(n)??0)+1;calls.set(n,count);active++;maxActive=Math.max(maxActive,active);
      try {
        const snapshot=(reorg?canonical:old).get(n)!;
        if(n===1n&&count===1)await pause(30);
        else if(n===2n&&count===1) {await switched;completion.push(n);return canonical.get(n)!;}
        else await pause(2);
        completion.push(n);return snapshot;
      } finally {active--;}
    };
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);const head=new HeadFollower(client,db,decoder,{startBlock:1n,prefetchBlocks:3,reorgDepth:256,logger:quiet});
    await head.ingest(old.get(0n)!,[]);const applied:{n:bigint;hash:Hex}[]=[];const write=decoder.write.bind(decoder);
    vi.spyOn(decoder,'write').mockImplementation(async(...args)=>{
      applied.push({n:BigInt(args[1].number),hash:args[1].hash});await write(...args);
      if(args[1].hash===hash(101)){reorg=true;switchBranch();}
      if(args[1].hash===hash(204))head.stop();
    });
    await head.run();expect(completion.indexOf(3n)).toBeLessThan(completion.indexOf(1n));expect(maxActive).toBeLessThanOrEqual(3);
    expect(applied.map(b=>b.hash)).toEqual([hash(101),hash(201),hash(202),hash(203),hash(204)]);expect(calls.get(3n)).toBeGreaterThanOrEqual(2);
    for(let n=1;n<=4;n++)expect(await db.blockHash(BigInt(n))).toBe(hash(200+n));expect(await db.cursor('head')).toBe(4n);
  },10000);
  it('benchmarks a dense ordered catch-up with 32 blocks prefetched and 25 ms simulated block/receipt latency', async () => {
    const db = await database(), data = tradeBlocks(128); await seedToken(db,data.token,data.curve);
    data.blocks.set(1199n,empty(1199));const client=clientFor(data.blocks,data.receipts);
    const readBlock=client.block, readReceipts=client.receipts;
    client.block=async n=>{await pause(25);return readBlock(n);};client.receipts=async n=>{await pause(25);return readReceipts(n);};
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);const head=new HeadFollower(client,db,decoder,{startBlock:1200n,prefetchBlocks:32,reorgDepth:256,logger:quiet});
    const write=decoder.write.bind(decoder);vi.spyOn(decoder,'write').mockImplementation(async(...args)=>{await write(...args);if(BigInt(args[1].number)===1327n)head.stop();});
    const began=performance.now();await head.run();const elapsed=performance.now()-began;
    expect(await db.cursor('head')).toBe(1327n);expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(640);
    console.log(JSON.stringify({event:'offline_catchup_benchmark',blocks:128,simulated_rpc_latency_ms:25,blocks_per_second:Number((128000/elapsed).toFixed(1))}));
  },60000);
  it('benchmarks full captured blocks with receipt logs and real v3/Pons decoding', async () => {
    const db=await database();const base=fixtures.ponsLaunch;const pools=new Map<string,PoolMetadata>();
    for(const receipt of base.receipts)for(const log of receipt.logs)for(const event of decodeResult(log,{registry,isV3Pool:()=>true}).events)if(event.source==='uniswap_v3'&&event.eventName==='Swap'){
      const currencies=new Set<Address>();
      for(const other of receipt.logs)for(const transfer of decodeResult(other,{registry}).events)if(transfer.source==='erc20'&&[transfer.args.from,transfer.args.to].some(a=>a.toLowerCase()===log.address.toLowerCase()))currencies.add(getAddress(other.address));
      const pair=[...currencies].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));if(pair.length===2)pools.set(log.address.toLowerCase(),{currency0:pair[0],currency1:pair[1],fee:3000,tickSpacing:60});
    }
    const blocks=new Map<bigint,RpcBlock>([[0n,empty(0)]]),receipts=new Map<bigint,RpcReceipt[]>();
    for(let n=1;n<=128;n++){
      const b=structuredClone(base);const hashes=new Map(b.block.transactions.map((t,i)=>[t.hash,hash(100000+n*100+i)]));
      b.block={...b.block,number:toHex(n),hash:hash(n),parentHash:hash(n-1),timestamp:empty(n).timestamp,transactions:b.block.transactions.map(t=>({...t,hash:hashes.get(t.hash)!}))};
      for(const r of b.receipts){r.transactionHash=hashes.get(r.transactionHash)!;r.blockHash=b.block.hash;r.blockNumber=b.block.number;for(const l of r.logs){l.transactionHash=r.transactionHash;l.blockHash=b.block.hash;l.blockNumber=b.block.number;l.blockTimestamp=b.block.timestamp;}}
      blocks.set(BigInt(n),b.block);receipts.set(BigInt(n),b.receipts);
    }
    const client=clientFor(blocks,receipts);client.v3Pool=async a=>pools.get(a.toLowerCase())??null;
    client.tokenMetadataBatch=async addresses=>addresses.map(a=>({symbol:'<sample>',name:'<sample>',decimals:a.toLowerCase()===registry.requireAddress('tokens.USDG').toLowerCase()?6:18}));
    for(const [id,p] of pools){for(const a of [p.currency0,p.currency1])await db.insert('tokens',{address:binary(a),symbol:'<sample>',name:'<sample>',decimals:a.toLowerCase()===registry.requireAddress('tokens.USDG').toLowerCase()?6:18,first_block:'0',block:'0'});await db.insert('pools',{id:binary(id),venue:'uniswap_v3',currency0:binary(p.currency0),currency1:binary(p.currency1),fee:p.fee,tick_spacing:p.tickSpacing,created_block:'0',block:'0'});}
    const getBlock=client.block,getReceipts=client.receipts;client.block=async n=>{await pause(25);return getBlock(n);};client.receipts=async n=>{await pause(25);return getReceipts(n);};
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);const head=new HeadFollower(client,db,decoder,{startBlock:1n,prefetchBlocks:32,reorgDepth:256,logger:quiet});const write=decoder.write.bind(decoder);
    vi.spyOn(decoder,'write').mockImplementation(async(...args)=>{await write(...args);if(BigInt(args[1].number)===128n)head.stop();});
    const began=performance.now();await head.run();const elapsed=performance.now()-began;
    expect(await db.cursor('head')).toBe(128n);expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(1152);
    console.log(JSON.stringify({event:'offline_full_block_benchmark',blocks:128,logs_per_block:57,simulated_rpc_latency_ms:25,blocks_per_second:Number((128000/elapsed).toFixed(1))}));
  },60000);
  it('computes lag from chain head time instead of the computer clock', () => {
    const metrics=new Metrics(quiet);metrics.setHead(toHex(1000));metrics.observe(toHex(997));expect(metrics.headLagMs).toBe(3000);
    metrics.setHead(toHex(1001));metrics.observe(toHex(1001));expect(metrics.headLagMs).toBe(0);
  });
});

describe('batched receipts, metadata and historical pricing', () => {
  it('prices slot0 with either token order and the actual decimals', () => {
    const sqrt=BigInt(Math.floor(Math.sqrt(2000/1e12)*2**96));expect(ethUsdFromSlot0(sqrt,true,18,6)).toBeCloseTo(2000,8);
    const reversed=BigInt(Math.floor(Math.sqrt(1e12/2000)*2**96));expect(ethUsdFromSlot0(reversed,false,18,6)).toBeCloseTo(2000,8);
    expect(ethUsdFromSlot0(2n**96n,true,18,18)).toBe(1);expect(()=>ethUsdFromSlot0(0n,true,18,6)).toThrow();expect(priceSampleBlock(1799n)).toBe(1200n);
  });
  it('fetches receipts once per distinct block with bounded concurrency and batches all rows; archive prices need no v3 swaps', async () => {
    const db=await database();const data=tradeBlocks(40);await seedToken(db,data.token,data.curve);
    await db.sql.query("INSERT INTO ingest_ranges(stream,from_block,to_block,status) VALUES('logs:pons_factory',1200,1239,'done')");
    const client=clientFor(data.blocks,data.receipts);let active=0,maxActive=0;
    const receiptRead=client.receipts;client.receipts=vi.fn(async n=>{active++;maxActive=Math.max(maxActive,active);try{await pause(5);return await receiptRead(n);}finally{active--;}});
    client.logs=async({from,to})=>[...data.receipts].filter(([n])=>n>=from&&n<=to).flatMap(([,rs])=>rs.flatMap(r=>r.logs));
    const fullBlocks=vi.spyOn(client,'block');const headers=vi.spyOn(client,'header');const prices=vi.spyOn(client,'ethUsdRate');
    const queries: string[] = []; const transact = db.tx.bind(db);
    db.tx = async fn => transact(async tx => { const execute = tx.sql.query.bind(tx.sql); tx.sql.query = async (sql, params) => { queries.push(sql); return execute(sql, params); }; return fn(tx); });
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    await new PonsBackfill(client,db,decoder,{workers:2,concurrency:4,logRange:2000,logger:quiet}).run('logs:pons_curves',1200n,1239n);
    expect(client.receipts).toHaveBeenCalledTimes(40);expect(maxActive).toBe(4);expect(fullBlocks).not.toHaveBeenCalled();expect(headers).not.toHaveBeenCalled();expect(prices).toHaveBeenCalledExactlyOnceWith(1200n);
    const inserts=queries.filter(sql=>sql.startsWith('INSERT INTO swaps'));
    expect(inserts).toHaveLength(10);expect(inserts.every(sql=>sql.includes('),('))).toBe(true);
    const swaps=(await db.sql.query<{usd:number;priced_block:number;trader:Uint8Array}>('SELECT * FROM swaps')).rows;
    expect(swaps).toHaveLength(200);expect(swaps.every(s=>s.usd>0&&BigInt(s.priced_block)===1200n)).toBe(true);
    expect(swaps.every(s=>hex(s.trader)==='0x820fab7b0acdaa427425689ea69486813f29e299')).toBe(true);
    expect((await db.sql.query("SELECT * FROM swaps WHERE venue='uniswap_v3'")).rows).toHaveLength(0);
  },10000);
  it('caches samples within a bucket, never uses a future sample, and invalidates orphaned cached reads', async () => {
    const db=await database(),data=tradeBlocks(2,1799);await seedToken(db,data.token,data.curve);const client=clientFor(data.blocks,data.receipts);
    client.ethUsdRate=vi.fn(async n=>({value:n===1200n?2000:3000,block:n,source:{ address: registry.requireAddress('uniswapV3.quoterV2'), venue: 'uniswap_v3' as const, fee: 3000 }}));const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    for(const n of [1799n,1800n]){const block=data.blocks.get(n)!,receipts=data.receipts.get(n)!;const prepared=await decoder.prepare(db,block,receipts,{ponsOnly:true});await db.ensurePartitions(new Date(Number(BigInt(block.timestamp))*1000));await db.tx(async tx=>{await decoder.write(tx,block,receipts,prepared,{ponsOnly:true});});}
    const rows=(await db.sql.query<{block:number;priced_block:number;usd:number;amount_quote:string}>('SELECT * FROM swaps ORDER BY block,log_index')).rows;
    expect(rows.every(r=>BigInt(r.priced_block)<=BigInt(r.block))).toBe(true);
    expect(rows.filter(r=>BigInt(r.block)===1799n).every(r=>BigInt(r.priced_block)===1200n&&Math.abs(r.usd-Number(r.amount_quote)/1e18*2000)<1e-9)).toBe(true);
    expect(rows.filter(r=>BigInt(r.block)===1800n).every(r=>BigInt(r.priced_block)===1800n&&Math.abs(r.usd-Number(r.amount_quote)/1e18*3000)<1e-9)).toBe(true);
    expect(client.ethUsdRate).toHaveBeenCalledTimes(2);decoder.invalidate();await decoder.prefetch(data.blocks.get(1800n)!,data.receipts.get(1800n)!,{ponsOnly:true});expect(client.ethUsdRate).toHaveBeenCalledTimes(3);
    client.ethUsdRate=async n=>({value:2000,block:n+600n,source:{ address: registry.requireAddress('uniswapV3.quoterV2'), venue: 'uniswap_v3' as const, fee: 3000 }});decoder.invalidate();await expect(decoder.prefetch(data.blocks.get(1799n)!,data.receipts.get(1799n)!,{ponsOnly:true})).rejects.toThrow('historical');
  });
  it('fills legacy null USD on replay, preserves amounts/actor, and does not duplicate notifications', async () => {
    const db=await database(),data=tradeBlocks(1);await seedToken(db,data.token,data.curve);const client=clientFor(data.blocks,data.receipts);
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);const block=data.blocks.get(1200n)!,receipts=data.receipts.get(1200n)!;
    const first=await decoder.prepare(db,block,receipts,{ponsOnly:true});first.rate=null;
    await db.ensurePartitions(new Date(Number(BigInt(block.timestamp))*1000));await db.tx(async tx=>{await decoder.write(tx,block,receipts,first,{ponsOnly:true});});
    const before=(await db.sql.query<{amount_coin:string;amount_quote:string;trader:Uint8Array;usd:null}>('SELECT * FROM swaps ORDER BY log_index')).rows;
    expect(before.every(r=>r.usd===null)).toBe(true);
    const query=await decoder.prepare(db,block,receipts,{ponsOnly:true});const messages=vi.spyOn(ChainDb.prototype,'notifyMany');
    await db.tx(tx=>decoder.write(tx,block,receipts,query,{ponsOnly:true}));
    const after=(await db.sql.query<{amount_coin:string;amount_quote:string;trader:Uint8Array;usd:number}>('SELECT * FROM swaps ORDER BY log_index')).rows;
    expect(after.every(r=>r.usd>0)).toBe(true);expect(after.map(r=>[r.amount_coin,r.amount_quote,hex(r.trader)])).toEqual(before.map(r=>[r.amount_coin,r.amount_quote,hex(r.trader)]));expect(messages.mock.calls.flatMap(([batch])=>batch)).toHaveLength(0);
  });
  it('uses the batched metadata API once for all launches in a block, preserving raw strings', async () => {
    const db=await database();const fixture=fixtures.ponsLaunch;const n=BigInt(fixture.block.number);const client=clientFor(new Map([[n,fixture.block]]),new Map([[n,fixture.receipts]]));
    const metadata=vi.spyOn(client,'tokenMetadataBatch');const singles=vi.spyOn(client,'tokenMetadata');const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    const prepared=await decoder.prepare(db,fixture.block,fixture.receipts,{ponsOnly:true});await db.ensurePartitions(new Date(Number(BigInt(fixture.block.timestamp))*1000));await db.tx(async tx=>{await decoder.write(tx,fixture.block,fixture.receipts,prepared,{ponsOnly:true});});
    expect(metadata).toHaveBeenCalledOnce();expect(metadata.mock.calls[0][0]).toEqual(['0x7d33D051E0311BcdeF1063EeDf7ba1c83Bae0383']);expect(singles).not.toHaveBeenCalled();
    expect((await db.sql.query<{symbol:string;name:string}>("SELECT * FROM tokens WHERE launchpad='pons'")).rows[0]).toMatchObject({symbol:'<sample>',name:'<sample>'});
  });
});

/** Virtual time for the meter and the simulated providers; `hold` keeps it still while real database work runs. */
function virtualClock() {
  let time=0,advancing=false,held=0;const waits:{at:number;resolve:()=>void}[]=[];
  const advance=()=>{
    if(advancing||held||!waits.length)return;advancing=true;
    setImmediate(()=>{advancing=false;if(held||!waits.length)return;time=Math.max(time,Math.min(...waits.map(w=>w.at)));for(const w of waits.filter(w=>w.at<=time)){waits.splice(waits.indexOf(w),1);w.resolve();}advance();});
  };
  return {now:()=>time,sleep:(ms:number)=>new Promise<void>(resolve=>{waits.push({at:time+ms,resolve});advance();}),
    async hold<T>(work:()=>Promise<T>):Promise<T>{held++;try{return await work();}finally{held--;advance();}}};
}
// Production (one 200-block head tick, 2026-10-07): 4,370 ms of writes for about 180 stored blocks and 547 ms of block
// preparation. The benchmark charges the same per stored and per prepared block, so its write side is today's.
const WRITE_MS_PER_STORED_BLOCK = 24, PREPARE_MS_PER_BLOCK = 2.7, CATCH_UP_BLOCKS = 4000;
let builtCatchUpChain: ReturnType<typeof catchUpChain> | undefined;
type FollowerConfig = ConstructorParameters<typeof LogHeadFollower>[3];
type Request = { id: number; method: string; params: unknown[] };
/**
 * Catch up CATCH_UP_BLOCKS behind a fixed head through the real meter, at production lane caps (public 300/min, paid
 * 1,200/min) and latencies (public 350 ms, paid 150 ms, plus 8/6 ms per block of eth_getLogs range and a slow receipt
 * every 100 blocks). Public logs carry no blockTimestamp, as measured on the public provider.
 */
async function catchUp(config: Partial<FollowerConfig>, writeMs = WRITE_MS_PER_STORED_BLOCK) {
  const catchUpData = builtCatchUpChain ??= catchUpChain(CATCH_UP_BLOCKS);
  const db = await database(); await seedCatchUp(db);
  const clock = virtualClock(), head = BigInt(CATCH_UP_BLOCKS);
  const calls: Record<'paid'|'public', number> = { paid: 0, public: 0 }, methods: Record<string, number> = {};
  const fetchFn: FetchFn = async (url, init) => {
    const provider = String(url).includes('public') ? 'public' : 'paid';
    const body = JSON.parse(String(init!.body)) as Request | Request[];
    let latency = 0;
    const replies = (Array.isArray(body) ? body : [body]).map(r => {
      calls[provider]++; methods[`${provider}:${r.method}`] = (methods[`${provider}:${r.method}`] ?? 0) + 1;
      let extra = 0, result: unknown;
      if (r.method === 'eth_chainId') result = toHex(4663);
      else if (r.method === 'eth_blockNumber') result = toHex(head);
      else if (r.method === 'eth_getBlockByNumber') result = catchUpData.get(BigInt(r.params[0] as string))!.block;
      else if (r.method === 'eth_getBlockReceipts') { const n = BigInt(r.params[0] as string); result = catchUpData.get(n)!.receipts; if (n % 100n === 2n) extra = provider === 'public' ? 5500 : 1450; }
      else if (r.method === 'eth_getCode') result = '0x';
      else if (r.method === 'eth_getLogs') {
        const f = r.params[0] as { fromBlock: Hex; toBlock: Hex; topics: Hex[][]; address?: Address[] };
        result = logsOf(catchUpData, BigInt(f.fromBlock), BigInt(f.toBlock), f.topics[0], f.address, provider === 'paid');
        extra = Number(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n) * (provider === 'public' ? 8 : 6);
      } else throw new Error(`Unexpected catch-up RPC ${r.method}`);
      latency = Math.max(latency, (provider === 'public' ? 350 : 150) + extra);
      return { jsonrpc: '2.0', id: r.id, result };
    });
    await clock.sleep(latency);
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const env = { RPC_HTTP_URL: 'https://paid.invalid', RPC_PUBLIC_HTTP_URL: 'https://public.invalid' };
  const store: UsageStore = { reserve: async () => ({ allowed: true, total: 0 }), today: async () => [] };
  const { meter } = createMeteredClients(env, { store, fetchFn, now: clock.now, sleep: clock.sleep, log: quiet });
  const client = createClients(env, registry, meter, { head: true });
  client.ethUsdRate = async n => { await clock.sleep(150); return { value: 2000, block: n, source: { address: toHex(110, { size: 20 }), venue: 'uniswap_v3' as const, fee: 3000 } }; };
  const decoder = new BlockDecoder(client, registry, new Metrics(quiet), quiet), prepare = decoder.prepare.bind(decoder);
  vi.spyOn(decoder, 'prepare').mockImplementation(async (...args) => { await clock.sleep(PREPARE_MS_PER_BLOCK); return prepare(...args); });
  const flush = BlockRows.prototype.flush;
  const write = vi.spyOn(BlockRows.prototype, 'flush').mockImplementation(async function(this: BlockRows, tx, timings) {
    await clock.sleep(this.get('chain_blocks').length * writeMs); return clock.hold(() => flush.call(this, tx, timings));
  });
  const ticks: { blocks: number; at: number }[] = [];
  const live = new LogHeadFollower(client, db, decoder, { startBlock: 1n, reorgDepth: 256, maxRange: 200, pipeline: true, logger: (event, fields) => { if (event === 'head_tick') ticks.push({ blocks: Number(fields!.blocks_covered), at: clock.now() }); }, ...config });
  try { for (let i = 0; i < 400 && (await db.cursor('head_logs') ?? 0n) < head; i++) await live.tick(); }
  finally { write.mockRestore(); await meter.close(); }
  expect(await db.cursor('head_logs')).toBe(head);
  const elapsed = clock.now();
  const count = async (table: string) => Number((await db.sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  // Steady state: after the first window, whose read nothing can overlap (a long catch-up amortizes it).
  const steady = (CATCH_UP_BLOCKS - ticks[0].blocks) * 1000 / (elapsed - ticks[0].at);
  return { blocksPerSecond: Number(steady.toFixed(1)), overallBlocksPerSecond: Number((CATCH_UP_BLOCKS * 1000 / elapsed).toFixed(1)), simulatedMs: elapsed, paidPerBlock: Number((calls.paid / CATCH_UP_BLOCKS).toFixed(3)),
    publicPerBlock: Number((calls.public / CATCH_UP_BLOCKS).toFixed(3)), methods, rows: await count('swaps') + await count('token_transfers') + await count('chain_blocks'), ticks: ticks.length };
}
describe('live catch-up throughput', () => {
  it('catches up faster with fewer paid requests per block on the same fixture and lanes', async () => {
    // Before: the follower as configured in production on 2026-10-07 (200-block windows and commits, every parent link
    // read on the public lane, public candidate logs plus a paid timestamp scan, serial preparation and writes).
    const before = await catchUp({ catchUpRange: 200, commitRange: 200, deepParents: 'fetch', paidLogs: false, overlapWrites: false });
    // After: the CLI defaults (1,000-block windows far behind, 250-block commits, deep parent links not read).
    const optimized = { catchUpRange: 1000, commitRange: 250, deepParents: 'skip' } as const;
    const after = await catchUp(optimized);
    // The write time per block is still today's above, so the database sets the pace. With 40% of it (the share of the
    // local write path left after bars stopped reading each coin's whole swap history), the lanes set it.
    const lighterWrites = await catchUp(optimized, WRITE_MS_PER_STORED_BLOCK * .4);
    console.log(JSON.stringify({ event: 'offline_log_head_catch_up_benchmark', blocks: CATCH_UP_BLOCKS, write_ms_per_stored_block: WRITE_MS_PER_STORED_BLOCK, prepare_ms_per_block: PREPARE_MS_PER_BLOCK, before, after, lighter_writes: lighterWrites }));
    for (const run of [after, lighterWrites]) expect(run.rows).toBe(before.rows);
    // Measured 28 -> 45 blocks/s (and about 80-90 with lighter writes); margins absorb scheduling jitter in the virtual clock.
    expect(after.blocksPerSecond).toBeGreaterThanOrEqual(before.blocksPerSecond * 1.4);
    expect(after.paidPerBlock).toBeLessThanOrEqual(before.paidPerBlock);
    expect(after.publicPerBlock).toBeLessThan(before.publicPerBlock / 2);
    expect(lighterWrites.blocksPerSecond).toBeGreaterThanOrEqual(after.blocksPerSecond * 1.4);
    expect(lighterWrites.paidPerBlock).toBeLessThanOrEqual(before.paidPerBlock);
  }, 240000);
});
