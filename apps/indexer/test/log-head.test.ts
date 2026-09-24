import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartitionLockTimeoutError, binary, chainTables, hex, migrate, ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { AddressRegistry, createMeteredClients, decodeResult, loadRegistry, ponsCurveAbi, v3Abi, v4Abi, erc20Abi, RpcGuardError, RpcMeter, RpcReplyError, rpcStopReason } from '@eko/chain';
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, parseAbi, toEventSelector, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { BlockRows } from '../src/rows.js';
import { enrichSenders } from '../src/enrich.js';
import { DeferredEvents } from '../src/deferred.js';
import { PonsBackfill } from '../src/backfill.js';
import { BlockDecoder } from '../src/decode.js';
import { HeadFollower, ReorgDepthError } from '../src/head.js';
import { LogHeadFollower , lockContention } from '../src/log-head.js';
import { createClients, lower, native } from '../src/clients.js';
import { Metrics, type ChainClient, type PoolMetadata, type RpcBlock, type RpcLog, type RpcReceipt } from '../src/types.js';
const fake = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), http: (url:string) => () => ({ request: (r:unknown,options:unknown) => fake.send(r,options,url) }) }));
const registry = loadRegistry(), quiet = () => {};
const liveCapture = JSON.parse(readFileSync(new URL('./fixtures/4663/live-compare/blocks.json', import.meta.url),'utf8')) as { blocks: Record<string,{block:RpcBlock;receipts:RpcReceipt[];logs:RpcLog[]}> };
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/4663/blocks.json', import.meta.url), 'utf8')) as Record<string, { block: RpcBlock; receipts: RpcReceipt[] }>;
const handles: ChainDb[] = [];
const meters: { close(): Promise<void> }[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(meters.splice(0).map(m => m.close())); await Promise.all(handles.splice(0).map(db => db.close())); });
beforeEach(() => { fake.send.mockReset(); });
function virtualClock() {
  let time=0,advancing=false;const waits:{at:number;resolve:()=>void}[]=[];
  const advance=()=>{
    if(advancing||!waits.length)return;advancing=true;
    setImmediate(()=>{advancing=false;time=Math.max(time,Math.min(...waits.map(w=>w.at)));for(const w of waits.filter(w=>w.at<=time)){waits.splice(waits.indexOf(w),1);w.resolve();}advance();});
  };
  return {now:()=>time,advance:(ms:number)=>{time+=ms;},sleep:(ms:number)=>new Promise<void>(resolve=>{waits.push({at:time+ms,resolve});advance();})};
}
async function database() { const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db); return db; }
const hash = (n: number): Hex => toHex(n, { size: 32 });
const address = (n: number): Address => toHex(n, { size: 20 });
const coin = address(100), curve = address(101), actor = address(102), target = address(103);
function empty(n: number, branch = 0): RpcBlock { return { number: toHex(n), hash: hash(n + branch), parentHash: hash(Math.max(0, n - 1) + branch), timestamp: toHex(1790812800 + Math.floor(n / 10)), transactions: [] }; }
function event(event: AbiEvent, emitter: Address, args: Record<string, unknown>, block: RpcBlock, tx: Hex, index: number): RpcLog {
  return { address: emitter, topics: encodeEventTopics({ abi: [event], args }) as [Hex, ...Hex[]], data: encodeAbiParameters(event.inputs.filter(p => !p.indexed), event.inputs.filter(p => !p.indexed).map(p => args[p.name!])), blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, transactionHash: tx, logIndex: toHex(index) };
}
function trade(n: number, branch = 0) {
  const block = empty(n, branch), tx = hash(10000 + n + branch);
  block.transactions = [{ hash: tx, from: actor, to: target, type: '0x2' }];
  const buy = ponsCurveAbi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'CurveBuy')!;
  const logs = [event(buy, curve, { buyer: address(104), recipient: actor, quoteIn: 10n ** 18n, tokensOut: 100n * 10n ** 18n, fee: 0n, tax: 0n }, block, tx, 0), event(erc20Abi[0], coin, { from: curve, to: actor, value: 100n * 10n ** 18n }, block, tx, 1)];
  return { block, receipts: [{ transactionHash: tx, blockHash: block.hash, blockNumber: block.number, from: actor, to: target, type: '0x2' as Hex, logs }] };
}
type Data = Map<bigint, { block: RpcBlock; receipts: RpcReceipt[] }>;
function memory(data: Data): ChainClient {
  return { chainId: async () => 4663, head: async () => [...data.keys()].reduce((a, b) => a > b ? a : b), block: async n => data.get(n)!.block, header: async n => data.get(n)!.block, receipts: async n => data.get(n)!.receipts,
    logs: async ({ from, to, address: emitter, addresses, topics }) => [...data].filter(([n]) => n >= from && n <= to).flatMap(([, b]) => b.receipts.flatMap(r => r.logs)).filter(l => (!emitter || lower(emitter) === lower(l.address)) && (!addresses || addresses.some(a => lower(a) === lower(l.address))) && topics.includes(l.topics[0])),
    code: async () => '0x', tokenMetadata: async a => ({ symbol: '<sample>', name: '<sample>', decimals: lower(a) === lower(registry.requireAddress('tokens.USDG')) ? 6 : 18 }), v3Pool: async () => null, ethUsdRate: async n => ({value:2000,block:n,source:{ address: address(110), venue: 'uniswap_v3' as const, fee: 3000 }}) };
}
function follower(db: ChainDb, client: ChainClient, options = {}, customRegistry = registry) { return new LogHeadFollower(client, db, new BlockDecoder(client, customRegistry, new Metrics(quiet), quiet), { startBlock: 1n, maxRange:200, reorgDepth: 256, logger: quiet, ...options }); }
async function seed(db: ChainDb) {
  await db.insert('tokens', { address: binary(coin), curve: binary(curve), decimals: 18, symbol: '<sample>', name: '<sample>', launchpad: 'pons', first_block: '0', block: '0' });
  // Shared historical reference swap with prior canonical PoolCreated verification.
  await db.insert('pools', { id: binary(address(110)), venue: 'uniswap_v3', currency0: binary(registry.requireAddress('tokens.WETH')), currency1: binary(registry.requireAddress('tokens.USDG')), fee: 3000, tick_spacing: 60, creation_verified: true, created_block: '0', block: '0' });
  await db.ensurePartitions(new Date(Number(BigInt(empty(0).timestamp)) * 1000));
  await db.insert('swaps', { ts: new Date(Number(BigInt(empty(0).timestamp)) * 1000), block: '0', tx_hash: binary(hash(9000)), log_index: 0, venue: 'uniswap_v3', pool_id: binary(address(110)), coin: binary(registry.requireAddress('tokens.WETH')), quote_asset: binary(registry.requireAddress('tokens.USDG')), trader: binary(actor), tx_from: binary(actor), tx_to: binary(target), side: 1, amount_coin: '1', amount_quote: '2000', price_quote: 2000 });
}
const count = async (db: ChainDb, table: string) => Number((await db.sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
async function snapshot(db: ChainDb) {
  const tables: Record<string, unknown[]> = {};
  // Full-block and logs-first paths have different protocol input coverage; compare the existing chain facts here.
  // Protocol persistence/replay and scoped gaps are asserted in wallet-protocol.test.ts.
  const facts=chainTables.filter(t=>!['userops','delegations_7702','wallet_protocol_coverage'].includes(t));
  for (const table of [...facts, 'bars_1m', 'balances'] as const) {
    const rows = (await db.sql.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
    tables[table] = rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

async function deferredToken(pair: 'pons_coin' | 'pons_quote' | 'weth' = 'weth') {
  const db=await database();await seed(db);
  const other=address(180),pool=address(181),weth=registry.requireAddress('tokens.WETH');
  await db.insert('tokens',{address:binary(weth),decimals:18,symbol:'WETH',name:'WETH',first_block:'0',block:'0'});
  const currency0=pair==='pons_quote'?coin:other,currency1=pair==='pons_coin'?coin:pair==='pons_quote'?other:weth;
  const b=trade(1),tx=b.block.transactions[0].hash,amount0=100n*10n**6n,amount1=10n**18n,transferAmount=9007199254740993n;
  b.receipts[0].logs=[event(v3Abi[0],registry.requireAddress('uniswapV3.factory'),{token0:currency0,token1:currency1,fee:3000,tickSpacing:60,pool},b.block,tx,0),
    event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-amount0,amount1,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,1),
    event(v3Abi[3],pool,{sender:actor,owner:actor,tickLower:-60,tickUpper:60,amount:7n,amount0:11n,amount1:13n},b.block,tx,2),
    event(erc20Abi[0],other,{from:pool,to:actor,value:transferAmount},b.block,tx,3)];
  const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,b],[2n,trade(2)]]),client=memory(data);
  let available=false;
  const readMetadata=client.tokenMetadata;
  client.tokenMetadata=async(a,n)=>lower(a)===lower(other)?{name:available?'<sample>':null,symbol:available?'<sample>':null,decimals:available?6:null}:readMetadata(a,n);
  await follower(db,client).tick();
  return {db,client,data,other,pool,amount0,amount1,transferAmount,setAvailable:()=>{available=true;}};
}

const readAbi=parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  'function decimals() view returns (uint8)','function symbol() view returns (string)','function name() view returns (string)','function totalSupply() view returns (uint256)',
  'function factory() view returns (address)','function token0() view returns (address)','function token1() view returns (address)','function fee() view returns (uint24)','function tickSpacing() view returns (int24)',
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function liquidity() view returns (uint128)',
]);
function callResponse(to:Address,data:Hex,pools:Map<string,PoolMetadata>):Hex {
  const call=decodeFunctionData({abi:readAbi,data}),pool=pools.get(lower(to)),reference=address(140);
  let result:unknown;
  if(call.functionName==='aggregate3') result=call.args[0].map(c=>{try{return {success:true,returnData:callResponse(c.target,c.callData,pools)};}catch{return {success:false,returnData:'0x'};}});
  else if(call.functionName==='getPool')result=call.args[2]===3000?reference:native;
  else if(call.functionName==='slot0')result=[BigInt(Math.floor(Math.sqrt(2000/1e12)*2**96)),0,0,1,1,0,true];
  else if(call.functionName==='liquidity')result=1n;
  else if(call.functionName==='decimals')result=lower(to)===lower(registry.requireAddress('tokens.USDG'))?6:18;
  else if(call.functionName==='symbol'||call.functionName==='name')result='<sample>';
  else if(call.functionName==='totalSupply')result=10n**24n;
  else if(call.functionName==='factory') { result=pool?registry.requireAddress('uniswapV3.factory'):native; }
  else if(call.functionName==='token0')result=lower(to)===lower(reference)?registry.requireAddress('tokens.WETH'):pool?.currency0;
  else if(call.functionName==='token1')result=pool?.currency1;
  else if(call.functionName==='fee')result=pool?.fee;
  else if(call.functionName==='tickSpacing')result=pool?.tickSpacing;
  if(result==null)throw new Error('Unknown mock contract read');
  return encodeFunctionResult({abi:readAbi,functionName:call.functionName,result:result as never});
}

describe('logs-first head', () => {
  it('matches all chain tables and derived rows on the 41 live disagreement blocks through metered fake transports, including timestamps',async()=>{
    const oldDb=await database(),db=await database();
    const capture=Object.values(liveCapture.blocks).sort((a,b)=>Number(BigInt(a.block.number)-BigInt(b.block.number))),first=capture[0].block,last=capture.at(-1)!.block;
    expect(capture).toHaveLength(41);expect(capture.every(b=>b.logs.every(l=>l.blockTimestamp==='0x0'))).toBe(true);
    const v3Pools=new Map<string,PoolMetadata>(),v4Pools=new Map<string,PoolMetadata>(),curves=new Map<string,Address>();
    const initialized=new Set<string>();
    for(const b of capture)for(const r of b.receipts){
      const transfers=r.logs.flatMap(l=>decodeResult(l,{registry}).events.filter(e=>e.source==='erc20').map(e=>({address:l.address,args:e.args})));
      for(const l of r.logs){
        for(const e of decodeResult(l,{registry,isV3Pool:()=>true}).events){
          if(e.source==='uniswap_v3' && e.eventName!=='PoolCreated'){
            const pair=[...new Set(transfers.filter(t=>[t.args.from,t.args.to].some(a=>lower(a)===lower(l.address))).map(t=>lower(t.address)))].sort();
            if(pair.length===2)v3Pools.set(lower(l.address),{currency0:pair[0] as Address,currency1:pair[1] as Address,fee:3000,tickSpacing:60});
          }
          if(e.source==='uniswap_v4'&&e.eventName==='Initialize')initialized.add(lower(e.args.id));
          if(e.source==='uniswap_v4'&&e.eventName==='Swap'){
            const amount=(n:bigint)=>n<0n?-n:n;
            const zero=transfers.find(t=>t.args.value===amount(e.args.amount0)),one=transfers.find(t=>t.args.value===amount(e.args.amount1));
            if(zero||one)v4Pools.set(lower(e.args.id),{currency0:zero?.address??native,currency1:one?.address??native,fee:e.args.fee,tickSpacing:1});
          }
        }
        const buy=ponsCurveAbi.find((e):e is AbiEvent=>e.type==='event'&&e.name==='CurveBuy')!;
        if(l.topics[0]===toEventSelector(buy)){
          const token=transfers.find(t=>lower(t.args.from)===lower(l.address)&&![native,lower(registry.requireAddress('tokens.WETH'))].includes(lower(t.address)));
          if(token)curves.set(lower(l.address),token.address);
        }
      }
    }
    const tokenSeed=async(d:ChainDb,a:Address,c?:Address)=>d.insert('tokens',{address:binary(a),curve:c?binary(c):null,symbol:'<sample>',name:'<sample>',decimals:lower(a)===lower(registry.requireAddress('tokens.USDG'))?6:18,launchpad:c?'pons':null,total_supply:(10n**24n).toString(),supply_block:'77587741',first_block:'77587741',block:'77587741'});
    for(const d of [oldDb,db]){
      for(const name of ['WETH','USDG'] as const)await tokenSeed(d,registry.requireAddress(`tokens.${name}`));
      for(const [c,token] of curves)await tokenSeed(d,token,c as Address);
      for(const [id,pool] of v3Pools){
        for(const token of [pool.currency0,pool.currency1])if(lower(token)!==native)await tokenSeed(d,token);
        await d.insert('pools',{id:binary(id),venue:'uniswap_v3',currency0:binary(pool.currency0),currency1:binary(pool.currency1),fee:pool.fee,tick_spacing:pool.tickSpacing,created_block:'77587741',block:'77587741',creation_verified:false});
      }
      for(const [id,pool] of v4Pools)if(!initialized.has(id)){
        for(const token of [pool.currency0,pool.currency1])if(lower(token)!==native)await tokenSeed(d,token);
        await d.insert('pools',{id:binary(id),venue:'uniswap_v4',currency0:binary(pool.currency0),currency1:binary(pool.currency1),fee:pool.fee,tick_spacing:pool.tickSpacing,created_block:'77587741',block:'77587741',creation_verified:true});
      }
    }
    const anchor:RpcBlock={...first,number:toHex(BigInt(first.number)-1n),hash:first.parentHash,parentHash:hash(0),transactions:[]};
    const byNumber=new Map(capture.map(b=>[BigInt(b.block.number),b]));
    const calls:Record<string,number>={};
    fake.send.mockImplementation(async(r:{method:string;params:unknown[]})=>{
      calls[r.method]=(calls[r.method]??0)+1;
      if(r.method==='eth_chainId')return toHex(4663);
      if(r.method==='eth_blockNumber')return last.number;
      if(r.method==='eth_getBlockByNumber'){const n=BigInt(r.params[0] as string);return n===BigInt(anchor.number)?anchor:byNumber.get(n)!.block;}
      if(r.method==='eth_getBlockReceipts')return byNumber.get(BigInt(r.params[0] as string))!.receipts;
      if(r.method==='eth_getCode')return '0x';
      if(r.method==='eth_getLogs'){const f=r.params[0] as {fromBlock:string;toBlock:string;topics:Hex[][];address?:Address[]};return capture.filter(b=>BigInt(b.block.number)>=BigInt(f.fromBlock)&&BigInt(b.block.number)<=BigInt(f.toBlock)).flatMap(b=>b.logs).filter(l=>f.topics[0].includes(l.topics[0])&&(!f.address||f.address.some(a=>lower(a)===lower(l.address))));}
      if(r.method==='eth_call'){const call=r.params[0] as {to:Address;data:Hex};return callResponse(call.to,call.data,v3Pools);}
      throw new Error(`Unexpected fixture RPC ${r.method}`);
    });
    const env={RPC_HTTP_URL:'https://paid.invalid',RPC_PUBLIC_HTTP_URL:'https://public.invalid',RPC_PAID_MAX_RPM:'1000000',RPC_PUBLIC_MAX_RPM:'1000000'};
    const makeClient=(d:ChainDb,head:boolean)=>{let now=0;const {meter}=createMeteredClients(env,{db:d,now:()=>now,sleep:async ms=>{now+=ms;},log:quiet});meters.push(meter);return createClients(env,registry,meter,{head});};
    const oldClient=makeClient(oldDb,false),old=new HeadFollower(oldClient,oldDb,new BlockDecoder(oldClient,registry,new Metrics(quiet),quiet),{reorgDepth:256,logger:quiet});
    await old.ingest(anchor,[]);
    for(const b of capture){const n=BigInt(b.block.number);expect(await old.ingest(await oldClient.block(n),await oldClient.receipts(n))).toBe(true);}
    const oldCalls={...calls};
    const liveClient=makeClient(db,true),live=follower(db,liveClient,{startBlock:BigInt(first.number)});await live.tick();
    const expected=await snapshot(oldDb),actual=await snapshot(db);
    expect(actual).toEqual(expected);
    const swaps=(await db.sql.query<{ts:Date;usd:number;priced_block:number}>('SELECT * FROM swaps')).rows;
    expect(swaps.length).toBeGreaterThan(0);expect(swaps.every(s=>s.ts.getUTCFullYear()===2026)).toBe(true);
    expect(swaps.some(s=>s.usd>0 && BigInt(s.priced_block)===77844600n)).toBe(true);
    expect((await db.sql.query('SELECT * FROM liquidity_events WHERE kind=$1',['ModifyLiquidity'])).rows.length).toBeGreaterThan(0);
    expect((await db.sql.query('SELECT * FROM pools WHERE venue=$1 AND NOT creation_verified',['uniswap_v3'])).rows.length).toBeGreaterThan(0);
    console.log(JSON.stringify({event:'offline_live_fixture_equivalence',blocks:41,swaps:swaps.length,old_calls:oldCalls,log_calls:Object.fromEntries(Object.entries(calls).map(([method,count])=>[method,count-(oldCalls[method]??0)]))}));
  },30000);

  it.each([[false,200],[true,200],[false,1000]] as const)('matches 2,000 blocks and budgets timestamp recovery (zero log timestamps: %s; fetch: %i)', async (zeroTimestamps,maxRange) => {
    const oldDb = await database(), db = await database(); await seed(oldDb); await seed(db);
    const data: Data = new Map([[0n, { block: empty(0), receipts: [] }]]);
    for (let n = 1; n <= 2000; n++) {
      if (n % 20 < 9) data.set(BigInt(n), trade(n));
      else { const block = empty(n), tx = hash(20000 + n); block.transactions = [{ hash: tx, from: actor, to: target }]; const log = event(erc20Abi[0], coin, { from: actor, to: curve, value: 1n }, block, tx, 0); data.set(BigInt(n), { block, receipts: [{ transactionHash: tx, blockNumber: block.number, blockHash: block.hash, from: actor, to: target, logs: [log] }] }); }
    }
    const oldClient = memory(data); oldClient.code = async () => `0xef0100${'9'.repeat(40)}`;
    const old = new HeadFollower(oldClient, oldDb, new BlockDecoder(oldClient, registry, new Metrics(quiet), quiet), { reorgDepth: 256, logger: quiet });
    for (const b of data.values()) expect(await old.ingest(b.block, b.receipts)).toBe(true);
    const env = { RPC_HTTP_URL: 'https://paid.invalid', RPC_PUBLIC_HTTP_URL: 'https://public.invalid' };
    const clock=virtualClock();
    const { meter } = createMeteredClients(env, { db, ...clock, log: quiet }); meters.push(meter);
    const calls: Record<string, number> = {}; const receiptNumbers: bigint[] = [];
    fake.send.mockImplementation(async (r: { method: string; params: unknown[] }) => {
      calls[r.method] = (calls[r.method] ?? 0) + 1;
      if (r.method === 'eth_blockNumber') return toHex(2000);
      if (r.method === 'eth_getBlockByNumber') { expect(r.params[1]).toBe(false); return data.get(BigInt(r.params[0] as string))!.block; }
      if (r.method === 'eth_getBlockReceipts') { const n = BigInt(r.params[0] as string); receiptNumbers.push(n); return data.get(n)!.receipts; }
      if (r.method === 'eth_getCode') return `0xef0100${'9'.repeat(40)}`;
      if (r.method === 'eth_getLogs') { const f = r.params[0] as { fromBlock: string; toBlock: string; topics: Hex[][]; address?: Address[] }; const logs=await oldClient.logs({ from: BigInt(f.fromBlock), to: BigInt(f.toBlock), topics: f.topics[0], addresses: f.address });return zeroTimestamps?logs.map(l=>({...l,blockTimestamp:'0x0' as Hex})):logs; }
      throw new Error(`Unexpected head RPC ${r.method}`);
    });
    const client = createClients(env, registry, meter, { head: true });client.ethUsdRate=oldClient.ethUsdRate;
    const ticks=2000/maxRange,totalCalls=zeroTimestamps?2032:900+ticks*3+1;
    const ticksLog:Record<string,unknown>[]=[];const live = follower(db, client,{maxRange, logger:(event:string,fields:Record<string,unknown>)=>{if(event==='head_tick')ticksLog.push(fields);} });
    for (let tick = 0; tick < ticks; tick++) await live.tick();
    expect(clock.now()).toBeLessThan(zeroTimestamps?180000:120000);
    expect(clock.now()).toBeGreaterThan(totalCalls/25*1000-1000);
    expect(await db.cursor('head_logs')).toBe(2000n);
    expect(receiptNumbers).toHaveLength(900); expect(receiptNumbers.every(n => Number(n % 20n) < 9)).toBe(true);
    expect(calls).toEqual({ eth_blockNumber: ticks, eth_getBlockByNumber: zeroTimestamps?1110:ticks, eth_getLogs: zeroTimestamps?11:ticks, eth_getBlockReceipts: 900, eth_getCode: 1 });
    const chunks = 0, codeReads = 1, startup = 0;
    expect(Object.values(calls).reduce((a,b) => a+b,0)).toBeLessThanOrEqual(ticks * 3 + chunks + receiptNumbers.length + codeReads + startup + (zeroTimestamps?1101:0));
    const usage = (await meter.usage()).today;
    expect(usage.filter(r => r.provider === 'public').reduce((sum,r) => sum+r.calls,0)).toBeGreaterThanOrEqual(ticks*2);
    expect(usage.reduce((sum,r)=>sum+r.calls,0)).toBe(totalCalls);
    expect(usage.some(r=>r.provider==='public'&&r.method==='eth_getBlockReceipts'&&r.calls>0)).toBe(true);
    expect(usage.some(r=>r.provider==='paid'&&r.method==='eth_getBlockReceipts'&&r.calls>0)).toBe(true);
    expect(await snapshot(db)).toEqual(await snapshot(oldDb));
    expect(ticksLog).toHaveLength(ticks);expect(ticksLog.every(t=>t.blocks_covered===maxRange && Number(t.tick_ms)<10000 && Number(t.db_write_ms)>0)).toBe(true);
    console.log(JSON.stringify({event:'offline_log_head_benchmark',blocks:2000,ticks,fetch_blocks:maxRange,zero_log_timestamps:zeroTimestamps,default_cap_simulated_ms:clock.now(),usage,receipts_by_reason:ticksLog.map(t=>t.receipts_by_reason),meter_admission_ms:ticksLog.map(t=>Number(Number(t.meter_admission_ms).toFixed(1))),meter_rate_wait_ms:ticksLog.map(t=>t.meter_rate_wait_ms),tick_ms:ticksLog.map(t=>Number(Number(t.tick_ms).toFixed(1))),db_write_ms:ticksLog.map(t=>Number(Number(t.db_write_ms).toFixed(1))),rpc_wall_ms:ticksLog.map(t=>Number(Number(t.rpc_wall_ms).toFixed(1))),total_calls:Object.values(calls).reduce((a,b)=>a+b,0)}));
  }, 120000);

  it.each([[false,false,0],[true,false,0],[true,true,0],[false,false,350],[true,true,350]])('catches a moving 2,000-block gap and sustains 10 blocks/s with 20% Pons receipts (zero timestamps: %s; paid timestamps: %s; receipt latency: %s ms)',async (zeroTimestamps,paidTimestamps,receiptLatency)=>{
    const db=await database();await seed(db);
    const other=address(105),pool=address(106);
    await db.insert('tokens',{address:binary(other),decimals:18,first_block:'0',block:'0'});
    await db.insert('pools',{id:binary(pool),venue:'uniswap_v3',currency0:binary(other),currency1:binary(registry.requireAddress('tokens.WETH')),fee:3000,tick_spacing:60,creation_verified:true,created_block:'0',block:'0'});
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=6000;n++){
      const part=n%100;
      if(part%5===0){data.set(BigInt(n),trade(n));continue;}
      const block=empty(n),tx=hash(20000+n);block.transactions=[{hash:tx,from:actor,to:target}];
      const transferOnly=[88,89,93,94,96,97,98,99].includes(part);
      const liquidity=[91,92].includes(part);
      const transfer=event(erc20Abi[0],!transferOnly?other:coin,{from:actor,to:curve,value:1n},block,tx,0),logs=[transfer];
      if(!transferOnly&&!liquidity)logs.push(event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},block,tx,1));
      else if(liquidity)logs.push(event(v3Abi[3],pool,{sender:actor,owner:actor,tickLower:-60,tickUpper:60,amount:1n,amount0:1n,amount1:1n},block,tx,1));
      data.set(BigInt(n),{block,receipts:[{transactionHash:tx,blockNumber:block.number,blockHash:block.hash,from:actor,to:target,logs}]});
    }
    const clock=virtualClock(),env={RPC_HTTP_URL:'https://paid.invalid',RPC_PUBLIC_HTTP_URL:'https://public.invalid'};
    const {meter}=createMeteredClients(env,{db,...clock,log:quiet});meters.push(meter);
    const source=memory(data),head=()=>2000n+BigInt(Math.floor(clock.now()/100));
    const trace:{provider:string;method:string;at:number}[]=[];
    fake.send.mockImplementation(async(r:{method:string;params:unknown[]},_options:unknown,url:string)=>{
      trace.push({provider:url.includes('public')?'public':'paid',method:r.method,at:clock.now()});
      if(receiptLatency)await clock.sleep(r.method==='eth_getBlockReceipts'?receiptLatency:100);
      if(r.method==='eth_blockNumber')return toHex(head());
      if(r.method==='eth_getBlockByNumber')return data.get(BigInt(r.params[0] as string))!.block;
      if(r.method==='eth_getBlockReceipts')return data.get(BigInt(r.params[0] as string))!.receipts;
      if(r.method==='eth_getCode')return '0x';
      if(r.method==='eth_getLogs'){const f=r.params[0] as {fromBlock:string;toBlock:string;topics:Hex[][]};return (await source.logs({from:BigInt(f.fromBlock),to:BigInt(f.toBlock),topics:f.topics[0]})).map(l=>zeroTimestamps && !(paidTimestamps&&url.includes('paid'))?({...l,blockTimestamp:'0x0' as Hex}):l);}
      if(r.method==='eth_call') {const call=r.params[0] as {to:Address;data:Hex};return callResponse(call.to,call.data,new Map());}
      throw new Error(`Unexpected synthetic RPC ${r.method}`);
    });
    const client=createClients(env,registry,meter,{head:true});if(!receiptLatency)client.ethUsdRate=async()=>null;
    if(receiptLatency){const flush=BlockRows.prototype.flush;vi.spyOn(BlockRows.prototype,'flush').mockImplementation(async function(this:BlockRows,tx){await clock.sleep(3700);await flush.call(this,tx);});}
    const ticks:Record<string,unknown>[]=[];const live=follower(db,client,{pipeline:true,logger:(event:string,fields:Record<string,unknown>)=>{if(event==='head_tick')ticks.push({...fields,virtual_at:clock.now()});}});
    const maxLag=receiptLatency?60n:10n;
    for(let tick=0;tick<100 && head()-(await db.cursor('head_logs')??0n)>maxLag;tick++)await live.tick();
    const caughtAt=clock.now(),caughtBlock=await db.cursor('head_logs');
    expect(head()-caughtBlock!).toBeLessThanOrEqual(maxLag);expect(caughtAt).toBeLessThan(300000);
    const full=ticks.filter(t=>t.blocks_covered===200);
    expect(full.length).toBeGreaterThanOrEqual(10);
    expect(full.every(t=>t.receipts_fetched===40 && JSON.stringify(t.receipts_by_reason)===JSON.stringify({pons_coin_trade:40,other_indexed_token:0,launch:0,liquidity:0,other_event:0}))).toBe(true);
    if(receiptLatency){
      const calls=trace.filter(r=>r.method==='eth_call');
      const samples=new Set(calls.map(r=>r.at));
      expect(calls.length).toBeLessThanOrEqual(Number(caughtBlock!/600n)+3);
      expect(samples.size).toBeGreaterThan(0);
      expect(full.every(t=>Number(t.enrichment_concurrency)>1&&Number(t.receipt_concurrency)>1)).toBe(true);
    }
    const steadyStart=trace.length;
    for(let tick=0;tick<30;tick++){const began=clock.now();await live.tick();expect(head()-(await db.cursor('head_logs'))!).toBeLessThanOrEqual(receiptLatency?60n:10n);clock.advance(Math.max(0,1000-(clock.now()-began)));}
    for(const [provider,spacing] of [['public',200],['paid',50]] as const){const calls=trace.filter(r=>r.provider===provider);for(let i=1;i<calls.length;i++)expect(calls[i].at-calls[i-1].at).toBeGreaterThanOrEqual(spacing);}
    const usage=(await meter.usage()).today;
    const steadyCalls=trace.slice(steadyStart),steadyByProvider=Object.fromEntries(['public','paid'].map(p=>[p,steadyCalls.filter(r=>r.provider===p).length]));
    console.log(JSON.stringify({event:'offline_moving_head_benchmark',receipt_latency_ms:receiptLatency,other_rpc_latency_ms:receiptLatency?100:0,db_latency_ms:receiptLatency?3700:0,steady_elapsed_ms:clock.now()-caughtAt,catchup_calls:Object.fromEntries(['public','paid'].map(p=>[p,trace.slice(0,steadyStart).filter(r=>r.provider===p).length])),steady_calls:steadyByProvider,zero_timestamps:zeroTimestamps,paid_timestamps:paidTimestamps,receipt_share:.20,event_share:.92,start_gap:2000,caught_up_ms:caughtAt,caught_up_block:caughtBlock?.toString(),steady_ticks:30,final_gap:(head()-(await db.cursor('head_logs'))!).toString(),usage,head_ticks:full.slice(0,10)}));
  },120000);

  it('separates intentionally unindexed Pons topics and deferred pools from unknown topics',async()=>{
    const db=await database();await seed(db);
    const b=trade(1),tx=b.block.transactions[0].hash;
    const fees=ponsCurveAbi.find((e):e is AbiEvent=>e.type==='event'&&e.name==='FeesSwept')!;
    const initialized=ponsCurveAbi.find((e):e is AbiEvent=>e.type==='event'&&e.name==='Initialized')!;
    b.receipts[0].logs=[event(fees,curve,{a:1n,b:2n,c:3n},b.block,tx,0),event(initialized,curve,{a:actor},b.block,tx,1),
      event(v3Abi[1],address(999),{sender:actor,recipient:actor,amount0:-1n,amount1:1n,sqrtPriceX96:2n**96n,liquidity:1n,tick:0},b.block,tx,2)];
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,b]]),client=memory(data),logger=vi.fn(),metrics=new Metrics(logger);
    await new LogHeadFollower(client,db,new BlockDecoder(client,registry,metrics,quiet),{startBlock:1n,reorgDepth:256,logger:quiet}).tick();
    expect(metrics.unknownTopics).toBe(0);
    const report=logger.mock.calls.find(([event])=>event==='ingest_metrics')![1];
    expect(report.log_reasons).toEqual({unindexed_pons_event:2,deferred_pool:1});
    expect(report.log_topics).toEqual({[`unindexed_pons_event:${toEventSelector(fees)}`]:1,[`unindexed_pons_event:${toEventSelector(initialized)}`]:1,[`deferred_pool:${toEventSelector(v3Abi[1])}`]:1});
    expect(Number((await db.sql.query('SELECT count(*) AS n FROM pending_pool_events')).rows[0].n)).toBe(1);
    expect(Number((await db.sql.query('SELECT count(*) AS n FROM pons_events')).rows[0].n)).toBe(0);
    for(let n=0;n<80;n++)metrics.classify('unknown_topic',{...b.receipts[0].logs[0],topics:[hash(100000+n)]});
    metrics.observeLogs(b.block.timestamp,0n);
    const bounded=logger.mock.calls.at(-1)![1].log_topics as Record<string,number>;
    expect(Object.keys(bounded).length).toBe(65);expect(bounded.other).toBe(19);
  });

  it.each([200,1000])('models dense live payloads, registry load and real provider latency with %i-block fetches',async maxRange=>{
    const db=await database();await seed(db);
    const other=address(105),pool=address(106),weth=registry.requireAddress('tokens.WETH');
    const background=new BlockRows();
    background.add('tokens',{address:binary(other),decimals:18,first_block:'0',block:'0'});
    background.add('pools',{id:binary(pool),venue:'uniswap_v3',currency0:binary(other),currency1:binary(weth),fee:3000,tick_spacing:60,creation_verified:true,created_block:'0',block:'0'});
    for(let n=0;n<2000;n++){
      background.add('tokens',{address:binary(address(100000+n)),curve:binary(address(200000+n)),launchpad:'pons',decimals:18,first_block:'0',block:'0'});
      background.add('pools',{id:binary(address(300000+n)),venue:'uniswap_v3',currency0:binary(address(100000+n)),currency1:binary(weth),fee:3000,tick_spacing:60,creation_verified:false,created_block:'0',block:'0'});
    }
    await db.tx(tx=>background.flush(tx));
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=6000;n++){
      const b=n%20===2||n%20===3||n%20===4?trade(n):{block:empty(n),receipts:[] as RpcReceipt[]};
      if(n%10!==0&&!b.receipts.length){
        const tx=hash(20000+n);b.block.transactions=[{hash:tx,from:actor,to:target}];
        b.receipts=[{transactionHash:tx,blockHash:b.block.hash,blockNumber:b.block.number,from:actor,to:target,logs:[
          event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,0)]}];
      }
      if(b.receipts.length){const r=b.receipts[0];for(let i=r.logs.length;i<12;i++)r.logs.push(event(erc20Abi[0],n%20<5?coin:other,{from:curve,to:actor,value:1n},b.block,r.transactionHash,i));}
      data.set(BigInt(n),b);
    }
    const clock=virtualClock(),env={RPC_HTTP_URL:'https://paid.invalid',RPC_PUBLIC_HTTP_URL:'https://public.invalid'};
    const {meter}=createMeteredClients(env,{db,...clock,log:quiet});meters.push(meter);
    const source=memory(data),head=()=>2000n+BigInt(Math.floor(clock.now()/100)),trace:{provider:string;method:string;at:number}[]=[];
    fake.send.mockImplementation(async(r:{method:string;params:unknown[]},_options:unknown,url:string)=>{
      const provider=url.includes('public')?'public':'paid';trace.push({provider,method:r.method,at:clock.now()});
      const f=r.params?.[0] as {fromBlock:string;toBlock:string;topics:Hex[][]};
      const range=r.method==='eth_getLogs'?Number(BigInt(f.toBlock)-BigInt(f.fromBlock)+1n):0;
      // Public sustains five requests/s. Payload size and occasional receipt tails matter.
      const tail=r.method==='eth_getBlockReceipts'&&BigInt(r.params[0] as string)%100n===2n;
      await clock.sleep((provider==='public'?350:150)+range*(provider==='public'?8:6)+(tail?provider==='public'?5500:1450:0));
      if(r.method==='eth_blockNumber')return toHex(head());
      if(r.method==='eth_getBlockByNumber')return data.get(BigInt(r.params[0] as string))!.block;
      if(r.method==='eth_getBlockReceipts')return data.get(BigInt(r.params[0] as string))!.receipts;
      if(r.method==='eth_getCode')return '0x';
      if(r.method==='eth_getLogs')return (await source.logs({from:BigInt(f.fromBlock),to:BigInt(f.toBlock),topics:f.topics[0]})).map(l=>({...l,blockTimestamp:provider==='paid'?l.blockTimestamp:'0x0' as Hex}));
      if(r.method==='eth_call'){const call=r.params[0] as {to:Address;data:Hex};return callResponse(call.to,call.data,new Map());}
      throw new Error(`Unexpected synthetic RPC ${r.method}`);
    });
    const client=createClients(env,registry,meter,{head:true}),ticks:Record<string,unknown>[]=[];
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet),prepare=decoder.prepare.bind(decoder);
    let localPrepareMs=0,maxPreparedTokens=0,maxPreparedPools=0;
    // Retain the measured 3 s/200 serial preparation cost even after registry narrowing.
    vi.spyOn(decoder,'prepare').mockImplementation(async(...args)=>{await clock.sleep(15);const began=performance.now(),state=await prepare(...args);localPrepareMs+=performance.now()-began;maxPreparedTokens=Math.max(maxPreparedTokens,state.tokens.size);maxPreparedPools=Math.max(maxPreparedPools,state.pools.size);return state;});
    const flush=BlockRows.prototype.flush;
    vi.spyOn(BlockRows.prototype,'flush').mockImplementation(async function(this:BlockRows,tx){await clock.sleep(3500);return flush.call(this,tx);});
    const live=new LogHeadFollower(client,db,decoder,{startBlock:1n,reorgDepth:256,pipeline:true,...(maxRange===1000?{maxRange}:{}),logger:(event,fields)=>{if(event==='head_tick')ticks.push({...fields,virtual_at:clock.now()});}});
    for(let tick=0;tick<100&&head()-(await db.cursor('head_logs')??0n)>100n;tick++)await live.tick();
    const caughtAt=clock.now(),caughtBlock=(await db.cursor('head_logs'))!,catchupTrace=trace.slice();
    expect(head()-caughtBlock).toBeLessThanOrEqual(100n);expect(caughtAt).toBeLessThan(300000);
    const full=ticks.filter(t=>t.blocks_covered===maxRange);
    expect(full.length).toBeGreaterThan(0);
    expect(full.every(t=>Number(t.receipts_fetched)===maxRange*.15&&Number((t.headers_by_reason as {missing_parent:number}).missing_parent)>=maxRange*.095)).toBe(true);
    for(let tick=0;tick<10;tick++){const began=clock.now();await live.tick();expect(head()-(await db.cursor('head_logs'))!).toBeLessThanOrEqual(100n);clock.advance(Math.max(0,1000-(clock.now()-began)));}
    for(const [provider,spacing] of [['public',200],['paid',50]] as const){const calls=trace.filter(r=>r.provider===provider);for(let i=1;i<calls.length;i++)expect(calls[i].at-calls[i-1].at).toBeGreaterThanOrEqual(spacing);}
    // Dense logs are retained exactly; no filtering trick can produce the throughput result.
    const covered=(await db.cursor('head_logs'))!,expected=[...data].filter(([n])=>n>0n&&n<=covered).flatMap(([,b])=>b.receipts.flatMap(r=>r.logs)).filter(l=>l.topics[0]===toEventSelector(erc20Abi[0])).length;
    expect(Number((await db.sql.query('SELECT count(*) AS n FROM token_transfers')).rows[0].n)).toBe(expected);
    expect(maxPreparedTokens).toBeLessThanOrEqual(4);expect(maxPreparedPools).toBeLessThanOrEqual(1);
    console.log(JSON.stringify({event:'offline_dense_head_benchmark',local_prepare_ms:localPrepareMs,max_prepared_tokens:maxPreparedTokens,max_prepared_pools:maxPreparedPools,fetch_blocks:maxRange,registry_tokens:2000,registry_pools:2000,logs_per_nonempty_block:12,receipt_share:.15,public_latency_ms:350,paid_latency_ms:150,public_range_ms_per_block:8,paid_range_ms_per_block:6,receipt_tail_every_blocks:100,prepare_ms_per_block:15,write_ms_per_200:3500,caught_up_ms:caughtAt,caught_up_block:caughtBlock.toString(),final_gap:(head()-covered).toString(),catchup_calls:Object.fromEntries(['public','paid'].map(p=>[p,catchupTrace.filter(r=>r.provider===p).length])),steady_elapsed_ms:clock.now()-caughtAt,steady_calls:Object.fromEntries(['public','paid'].map(p=>[p,trace.slice(catchupTrace.length).filter(r=>r.provider===p).length])),head_ticks:full.slice(0,3)}));
  // Dense fixture has an explicit timeout; preserve its normal limit under V8 overhead.
  }, process.env.EKO_CORE_COVERAGE === '1' ? 300000 : 120000);

  it.each(['pons_coin','pons_quote'] as const)('commits raw swaps with an unknown %s currency and retains resolved Pons senders in live and backfill',async pair=>{
    const {db,client,other,amount0,amount1}=await deferredToken(pair);
    const row=(await db.sql.query('SELECT * FROM swaps WHERE block=1')).rows[0];
    expect(row).toMatchObject({amount_coin:amount0.toString(),amount_quote:amount1.toString(),price_quote:null,usd:null,priced_block:null,pricing_pending:true,senders_pending:false});
    expect(hex(row.trader as Uint8Array)).toBe(lower(actor));expect(hex(row.tx_from as Uint8Array)).toBe(lower(actor));expect(hex(row.tx_to as Uint8Array)).toBe(lower(target));
    expect((await db.sql.query('SELECT decimals FROM tokens WHERE address=$1',[binary(other)])).rows[0]).toEqual({decimals:null});
    expect(await db.cursor('head_logs')).toBe(2n);
    expect((await db.sql.query("SELECT price_quote,pricing_pending FROM swaps WHERE venue='pons_curve' AND block=2")).rows[0]).toEqual({price_quote:.01,pricing_pending:false});
    const backfillDb=await database();await seed(backfillDb);
    const backfill=new PonsBackfill(client,backfillDb,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{workers:1,logRange:200,logger:quiet});
    await backfill.run('logs:pools',1n,2n);await backfill.run('logs:pair_swaps',1n,2n);
    expect((await backfillDb.sql.query('SELECT * FROM swaps WHERE block=1')).rows).toEqual([row]);
  });

  it('commits transfers of a token with unknown decimals as exact raw integers',async()=>{
    const {db,other,transferAmount}=await deferredToken();
    const row=(await db.sql.query('SELECT * FROM token_transfers WHERE token=$1',[binary(other)])).rows[0];
    expect(row.amount).toBe(transferAmount.toString());expect(hex(row.from_address as Uint8Array)).toBe(lower(address(181)));expect(hex(row.to_address as Uint8Array)).toBe(lower(actor));
    expect(await db.cursor('head_logs')).toBe(2n);
  });

  it('commits liquidity events with unknown token decimals without scaling their raw data',async()=>{
    const {db,pool}=await deferredToken();
    const row=(await db.sql.query('SELECT * FROM liquidity_events WHERE pool_id=$1',[binary(pool)])).rows[0];
    // Outside the sender scope the event's own owner stands in for the sender (no coins left a wallet in this transaction).
    expect(row).toMatchObject({kind:'Mint',senders_pending:false,tx_from:null});expect(hex(row.actor as Uint8Array)).toBe(lower(actor));expect(row.data).toMatchObject({amount:'7',amount0:'11',amount1:'13'});
    expect(await db.cursor('head_logs')).toBe(2n);
  });

  it('defers bars for unknown decimals, then enriches prices and rebuilds the same bars as full metadata ingest',async()=>{
    const {db,client,data,other,setAvailable}=await deferredToken();
    expect((await db.sql.query('SELECT * FROM bars_1m WHERE coin=$1',[binary(other)])).rows).toHaveLength(0);
    expect((await db.sql.query('SELECT price_quote,usd,priced_block,pricing_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0]).toEqual({price_quote:null,usd:null,priced_block:null,pricing_pending:true});
    await expect(enrichSenders(db,other,client)).resolves.toEqual({enriched:2});
    expect((await db.sql.query('SELECT price_quote,usd,pricing_pending,senders_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0]).toEqual({price_quote:null,usd:null,pricing_pending:true,senders_pending:false});
    await expect(enrichSenders(db,other,client)).resolves.toEqual({enriched:0});
    expect((await db.sql.query('SELECT * FROM bars_1m WHERE coin=$1',[binary(other)])).rows).toHaveLength(0);
    setAvailable();
    await expect(enrichSenders(db,other,client)).resolves.toEqual({enriched:1});
    const row=(await db.sql.query('SELECT price_quote,usd,priced_block,pricing_pending,senders_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0];
    expect(row).toEqual({price_quote:.01,usd:2000,priced_block:0,pricing_pending:false,senders_pending:false});
    const truth=await database();await seed(truth);await truth.insert('tokens',{address:binary(registry.requireAddress('tokens.WETH')),decimals:18,symbol:'WETH',name:'WETH',first_block:'0',block:'0'});
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    for(const {block,receipts} of [...data.values()].slice(1)){
      const state=await decoder.prepare(truth,block,receipts,{forceSenders:true});
      await truth.ensurePartitions(new Date(Number(BigInt(block.timestamp))*1000));await truth.tx(async tx=>{await decoder.write(tx,block,receipts,state);});decoder.committed(state);
    }
    for(const table of ['swaps','liquidity_events','bars_1m','balances'] as const){const query=`SELECT * FROM ${table} ORDER BY ${table==='bars_1m'?'coin,minute':table==='balances'?'token,holder':'block,log_index'}`;expect((await db.sql.query(query)).rows).toEqual((await truth.sql.query(query)).rows);}
    const bars=(await db.sql.query('SELECT open,close,volume_usd,trades FROM bars_1m WHERE coin=$1',[binary(other)])).rows;
    expect(bars).toEqual([{open:20,close:20,volume_usd:2000,trades:1}]);
    client.receipts=vi.fn(client.receipts);await expect(enrichSenders(db,other,client)).resolves.toEqual({enriched:0});expect(client.receipts).not.toHaveBeenCalled();
  });

  it('rebuilds and replays balances for an unknown token using raw integers without rounding',async()=>{
    const {db,client,data,other,pool,transferAmount}=await deferredToken();
    const query='SELECT holder,amount,last_block FROM balances WHERE token=$1 ORDER BY holder';
    const before=(await db.sql.query(query,[binary(other)])).rows;
    expect(before).toHaveLength(2);expect(before.find(r=>hex(r.holder as Uint8Array)===lower(actor))).toMatchObject({amount:transferAmount.toString(),last_block:1});
    expect(before.find(r=>hex(r.holder as Uint8Array)===lower(pool))).toMatchObject({amount:(-transferAmount).toString(),last_block:1});
    const {block,receipts}=data.get(1n)!,decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet),state=await decoder.prepare(db,block,receipts);
    await db.tx(tx=>decoder.write(tx,block,receipts,state));expect((await db.sql.query(query,[binary(other)])).rows).toEqual(before);
  });

  it('keeps pricing pending when metadata remains unavailable and safely retries coin and quote enrichment',async()=>{
    const {db,client,other,setAvailable}=await deferredToken('pons_coin');
    client.receipts=vi.fn(client.receipts);
    await expect(enrichSenders(db,coin,client)).resolves.toEqual({enriched:0});expect(client.receipts).toHaveBeenCalledOnce();
    expect((await db.sql.query('SELECT price_quote,pricing_pending,senders_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0]).toEqual({price_quote:null,pricing_pending:true,senders_pending:false});
    setAvailable();
    await expect(enrichSenders(db,coin,client)).resolves.toEqual({enriched:1});
    expect((await db.sql.query('SELECT price_quote,pricing_pending,senders_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0]).toEqual({price_quote:.01,pricing_pending:false,senders_pending:false});
    expect((await db.sql.query('SELECT decimals FROM tokens WHERE address=$1',[binary(other)])).rows[0]).toEqual({decimals:6});
  });

  it('fills token decimals and deferred prices on replay without a totalSupply read or replacing raw rows',async()=>{
    const {db,client,data,other,setAvailable}=await deferredToken('pons_coin');
    const before=(await db.sql.query('SELECT amount_coin,amount_quote,trader,tx_from,tx_to FROM swaps WHERE coin=$1',[binary(other)])).rows;
    setAvailable();
    const {block,receipts}=data.get(1n)!,decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet),state=await decoder.prepare(db,block,receipts);
    await db.tx(tx=>decoder.write(tx,block,receipts,state));
    expect((await db.sql.query('SELECT decimals,total_supply FROM tokens WHERE address=$1',[binary(other)])).rows[0]).toEqual({decimals:6,total_supply:null});
    expect((await db.sql.query('SELECT price_quote,pricing_pending FROM swaps WHERE coin=$1',[binary(other)])).rows[0]).toEqual({price_quote:.01,pricing_pending:false});
    expect((await db.sql.query('SELECT amount_coin,amount_quote,trader,tx_from,tx_to FROM swaps WHERE coin=$1',[binary(other)])).rows).toEqual(before);
  });

  it('upgrades existing nullable prices to pending pricing without changing known prices and migrates idempotently',async()=>{
    const {db}=await deferredToken();
    // These later views did not exist in the pre-0112 schema being simulated.
    await db.sql.query('DROP VIEW watcher_read_swaps');
    await db.sql.query('DROP VIEW raw_history_live_swaps');
    await db.sql.query('ALTER TABLE swaps DROP COLUMN pricing_pending');
    await db.sql.query("DELETE FROM eko_indexer_migrations WHERE id='0112_pending_pricing'");
    await migrate(db);await migrate(db);
    expect((await db.sql.query('SELECT block,price_quote,pricing_pending FROM swaps ORDER BY block')).rows).toEqual([
      {block:0,price_quote:2000,pricing_pending:false},{block:1,price_quote:null,pricing_pending:true},{block:2,price_quote:.01,pricing_pending:false},
    ]);
  });

  it('names non-Pons traders from the coin’s transfers in head and backfill without receipts, then enriches one coin idempotently to the full receipt rows',async()=>{
    const db=await database(),backfillDb=await database(),truth=await database();
    const other=address(150),pool=address(151),weth=registry.requireAddress('tokens.WETH');
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=3;n++){
      const b=trade(n),tx=b.block.transactions[0].hash;
      b.receipts[0].logs=[...(n===1?[event(v3Abi[0],address(152),{token0:other,token1:weth,fee:3000,tickSpacing:60,pool},b.block,tx,0)]:[]),
        event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,1),
        event(v3Abi[3],pool,{sender:actor,owner:actor,tickLower:-60,tickUpper:60,amount:1n,amount0:1n,amount1:1n},b.block,tx,2),
        event(erc20Abi[0],other,{from:pool,to:actor,value:100n*10n**18n},b.block,tx,3)];data.set(BigInt(n),b);
    }
    const client=memory(data);client.code=vi.fn(async()=>`0xef0100${'9'.repeat(40)}` as Hex);client.receipts=vi.fn(client.receipts);client.tokenMetadataBatch=vi.fn(async (addresses:Address[])=>Promise.all(addresses.map(a=>client.tokenMetadata(a,0n))));
    await follower(db,client).tick();expect(client.receipts).not.toHaveBeenCalled();expect(client.code).not.toHaveBeenCalled();expect(client.tokenMetadataBatch).not.toHaveBeenCalled();
    expect((await db.sql.query('SELECT creation_verified FROM pools')).rows[0]).toEqual({creation_verified:false});
    const pending=(await db.sql.query('SELECT trader,tx_from,tx_to,senders_pending,price_quote FROM swaps')).rows;
    // Each buy's coins went from the pool to one wallet: that wallet is the trader. The transaction sender is not read.
    expect(pending).toHaveLength(3);expect(pending.every(r=>hex(r.trader as Uint8Array)===lower(actor)&&r.tx_from===null&&r.tx_to===null&&r.senders_pending===false&&r.price_quote===null)).toBe(true);
    expect((await db.sql.query('SELECT actor,tx_from,tx_to,senders_pending FROM liquidity_events')).rows.every(r=>hex(r.actor as Uint8Array)===lower(actor)&&r.tx_from===null&&r.tx_to===null&&r.senders_pending===false)).toBe(true);
    // The pool stream records event facts without archive metadata; pair swaps use the same pending scope.
    const backfill=new PonsBackfill(client,backfillDb,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{workers:1,logRange:200});
    await backfill.run('logs:pools',1n,3n);await backfill.run('logs:pair_swaps',1n,3n);await backfill.run('logs:holders',1n,3n);
    expect(client.receipts).not.toHaveBeenCalled();expect(client.code).not.toHaveBeenCalled();
    // A backfill stream reads swaps without the transaction's transfers: those rows stay pending, as before.
    const streamed=(await backfillDb.sql.query('SELECT trader,tx_from,tx_to,senders_pending,price_quote FROM swaps ORDER BY block')).rows;
    expect(streamed).toHaveLength(3);expect(streamed.every(r=>r.trader===null&&r.tx_from===null&&r.tx_to===null&&r.senders_pending===true&&r.price_quote===null)).toBe(true);
    const truthDecoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    for(const {block,receipts} of [...data.values()].slice(1)){
      const state=await truthDecoder.prepare(truth,block,receipts,{forceSenders:true});
      await truth.ensurePartitions(new Date(Number(BigInt(block.timestamp))*1000));await truth.tx(async tx=>{await truthDecoder.write(tx,block,receipts,state);});truthDecoder.committed(state);
    }
    const before=vi.mocked(client.receipts).mock.calls.length;
    expect(await enrichSenders(db,other,client)).toEqual({enriched:6}); // Three swaps plus three Mint events.
    expect(vi.mocked(client.receipts).mock.calls.length-before).toBe(3);
    // The receipts cannot resolve this sender (its delegation is unknown), so the full-receipt rows have no trader or
    // actor; the enriched rows keep the wallet the transfers named and match in every other column.
    for(const [table,field] of [['swaps','trader'],['liquidity_events','actor']] as const){
      const query=`SELECT * FROM ${table} ORDER BY block,log_index`,rows=(await db.sql.query<Record<string,unknown>>(query)).rows,full=(await truth.sql.query<Record<string,unknown>>(query)).rows;
      expect(full.every(r=>r[field]===null)).toBe(true);expect(rows.every(r=>hex(r[field] as Uint8Array)===lower(actor))).toBe(true);
      expect(rows.map(r=>({...r,[field]:null}))).toEqual(full);
    }
    expect((await db.sql.query('SELECT * FROM bars_1m ORDER BY minute')).rows).toEqual((await truth.sql.query('SELECT * FROM bars_1m ORDER BY minute')).rows);
    for(const table of ['tokens','pools'] as const)expect((await snapshot(db))[table]).toEqual((await snapshot(truth))[table]);
    const enrichedCalls=vi.mocked(client.receipts).mock.calls.length;expect(await enrichSenders(db,other,client)).toEqual({enriched:0});expect(vi.mocked(client.receipts).mock.calls.length).toBe(enrichedCalls);
    expect((await db.sql.query('SELECT decimals,symbol FROM tokens WHERE address=$1',[binary(other)])).rows[0]).toEqual({decimals:18,symbol:'<sample>'});
  });

  it('retains unknown non-Pons pool events without discovery reads and canonically materializes them on demand',async()=>{
    const db=await database(),oldDb=await database();
    const other=address(160),pool=address(161),weth=registry.requireAddress('tokens.WETH');
    const b=trade(1),tx=b.block.transactions[0].hash;
    b.receipts[0].logs=[event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,0),event(erc20Abi[0],other,{from:pool,to:actor,value:100n*10n**18n},b.block,tx,1),event(erc20Abi[0],weth,{from:actor,to:pool,value:10n**18n},b.block,tx,2)];
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,b]]),client=memory(data);
    client.v3Pool=vi.fn(async()=>({currency0:other,currency1:weth,fee:3000,tickSpacing:60}));client.receipts=vi.fn(client.receipts);client.code=vi.fn(client.code);
    const old=new HeadFollower(client,oldDb,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{reorgDepth:256,logger:quiet});
    await old.ingest(empty(0),[]);await old.ingest(b.block,b.receipts);vi.mocked(client.receipts).mockClear();
    await follower(db,client).tick();expect(client.v3Pool).not.toHaveBeenCalled();expect(client.code).not.toHaveBeenCalled();expect(client.receipts).not.toHaveBeenCalled();
    expect((await db.sql.query('SELECT * FROM pending_pool_events')).rows).toEqual((await oldDb.sql.query('SELECT * FROM pending_pool_events')).rows);expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(0);
    expect(await enrichSenders(db,other,client)).toEqual({enriched:1});expect(client.v3Pool).toHaveBeenCalledOnce();expect(client.receipts).toHaveBeenCalledOnce();
    const swap=(await db.sql.query('SELECT * FROM swaps')).rows[0];expect(swap).toMatchObject({senders_pending:false,price_quote:.01});expect(hex(swap.trader as Uint8Array)).toBe(lower(actor));
    expect((await db.sql.query('SELECT * FROM pending_pool_events')).rows).toHaveLength(0);expect((await db.sql.query('SELECT * FROM pools')).rows[0]).toMatchObject({creation_verified:false});
    await expect(enrichSenders(db,other,client)).resolves.toEqual({enriched:0});expect(client.receipts).toHaveBeenCalledOnce();
  });

  it('indexes an unknown v3 pool once the canonical factory names it, rejects a contract that only answers like a pool, and turns its stored events into rows',async()=>{
    const db=await database();await seed(db);
    const other=address(190),pool=address(191),fake=address(192),weth=registry.requireAddress('tokens.WETH');
    const swap=(n:number,emitter:Address)=>{const b=trade(n),tx=b.block.transactions[0].hash;
      b.receipts[0].logs=[event(v3Abi[1],emitter,{sender:target,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,0),event(erc20Abi[0],other,{from:emitter,to:actor,value:100n*10n**18n},b.block,tx,1)];return b;};
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,swap(1,pool)],[2n,swap(2,fake)]]),client=memory(data);
    // Without a factory to ask, both stay stored as raw events (as before).
    client.v3Pool=vi.fn(async()=>({currency0:other,currency1:weth,fee:3000,tickSpacing:60}));
    await follower(db,client).tick();
    expect(client.v3Pool).not.toHaveBeenCalled();expect(await count(db,'pending_pool_events')).toBe(2);expect(await count(db,'swaps')).toBe(1);
    // The factory names only `pool` for that pair and fee.
    client.canonicalV3Pool=vi.fn(async()=>pool);
    data.set(3n,swap(3,pool));data.set(4n,swap(4,fake));
    const live=follower(db,client);await live.tick();
    expect(client.v3Pool).toHaveBeenCalledTimes(2);
    const rows=(await db.sql.query<{block:string;trader:Uint8Array;senders_pending:boolean}>('SELECT block::text,trader,senders_pending FROM swaps WHERE pool_id=$1 ORDER BY block',[binary(pool)])).rows;
    // From its discovery on, the pool's swaps are rows with the wallet their transfers name.
    expect(rows.map(r=>[r.block,hex(r.trader),r.senders_pending])).toEqual([['3',lower(actor),false]]);
    expect((await db.sql.query('SELECT creation_verified FROM pools WHERE id=$1',[binary(pool)])).rows).toEqual([{creation_verified:false}]);
    expect((await db.sql.query('SELECT 1 FROM pools WHERE id=$1',[binary(fake)])).rows).toHaveLength(0);
    // The rejected emitter is not read again.
    data.set(5n,swap(5,fake));await live.tick();expect(client.v3Pool).toHaveBeenCalledTimes(2);expect(await count(db,'pending_pool_events')).toBe(4);
    // The pool's earlier event (block 1) is still raw: materialized without a chain read once it is deeper than the reorg depth.
    const reads=vi.mocked(client.v3Pool).mock.calls.length,deferred=new DeferredEvents(db,client,registry,{reorgDepth:2,logger:quiet});
    expect(await deferred.step()).toBe(1);
    expect(vi.mocked(client.v3Pool).mock.calls.length).toBe(reads);
    const old=(await db.sql.query<{trader:Uint8Array|null;recipient:Uint8Array;senders_pending:boolean;price_quote:number|null;usd:number|null}>('SELECT trader,recipient,senders_pending,price_quote,usd FROM swaps WHERE pool_id=$1 AND block=1',[binary(pool)])).rows[0];
    // Stored without its transfers in hand: no trader yet, the event's own recipient. The token's decimals are not read
    // here either: the worker's onboarding reads them and prices the swap.
    expect({...old,recipient:hex(old.recipient)}).toEqual({trader:null,recipient:lower(actor),senders_pending:true,price_quote:null,usd:null});
    expect((await db.sql.query<{emitter:Uint8Array}>('SELECT DISTINCT emitter FROM pending_pool_events')).rows.map(r=>hex(r.emitter))).toEqual([lower(fake)]);
    // Nothing left of known pools: the next step waits, and a second pass writes nothing twice.
    expect(await deferred.step()).toBe(0);deferred.wake();expect(await deferred.step()).toBe(0);expect(await count(db,'swaps')).toBe(3);
  });

  it('leaves swaps of WETH and USDG as the coin without a trader, while naming the trader of any other coin outside the sender scope',async()=>{
    const db=await database();await seed(db);
    const weth=registry.requireAddress('tokens.WETH'),usdg=registry.requireAddress('tokens.USDG'),reference=address(110),b=trade(1),tx=b.block.transactions[0].hash;
    // The reference pool (WETH against USDG, seeded as known): the wallet receives WETH from the pool.
    const wethFirst=lower(weth)<lower(usdg);
    b.receipts[0].logs=[event(v3Abi[1],reference,{sender:target,recipient:actor,amount0:wethFirst?-(10n**18n):2000n*10n**6n,amount1:wethFirst?2000n*10n**6n:-(10n**18n),sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,0),
      event(erc20Abi[0],weth,{from:reference,to:actor,value:10n**18n},b.block,tx,1)];
    const client=memory(new Map([[0n,{block:empty(0),receipts:[]}],[1n,b]]));await follower(db,client).tick();
    const row=(await db.sql.query<{trader:Uint8Array|null;senders_pending:boolean;coin:Uint8Array}>('SELECT trader,senders_pending,coin FROM swaps WHERE block=1')).rows[0];
    expect(hex(row.coin)).toBe(lower(weth));expect(row).toMatchObject({trader:null,senders_pending:true});
  });

  it('reads a window again after the database reports a deadlock, instead of halting',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)]]),client=memory(data),events:string[]=[];
    const live=follower(db,client,{tickMs:1,logger:(event:string,fields?:Record<string,unknown>)=>{if(event==='head_retry')events.push(String(fields?.reason));}});
    // The first commit is the deadlock's victim; nothing of it is stored.
    const tx=db.tx.bind(db);let failed=false;
    db.tx=(async fn=>{if(!failed){failed=true;throw Object.assign(new Error('deadlock detected'),{code:'40P01'});}return tx(fn as never);}) as typeof db.tx;
    const running=live.run();
    for(let i=0;i<200&&(await db.cursor('head_logs'))!==1n;i++)await new Promise(resolve=>setTimeout(resolve,10));
    live.stop();await running;
    expect(events).toEqual(['database_lock_contention']);
    expect(await db.cursor('head_logs')).toBe(1n);expect(await count(db,'swaps')).toBe(2);
    expect(lockContention(new Error('could not serialize access due to concurrent update'))).toBe(true);expect(lockContention(new Error('relation does not exist'))).toBe(false);
  });

  it('retries a partition timeout before opening the data transaction, then commits the same batch',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)]]),client=memory(data),events:string[]=[];
    const live=follower(db,client,{tickMs:1,logger:(event:string)=>events.push(event)});
    const ensure=db.ensurePartitions.bind(db),tx=db.tx.bind(db);let inTransaction=false,failed=false;
    db.tx=work=>tx(async handle=>{inTransaction=true;try{return await work(handle);}finally{inTransaction=false;}});
    db.ensurePartitions=async(date,options)=>{expect(inTransaction).toBe(false);if(!failed){failed=true;throw new PartitionLockTimeoutError();}await ensure(date,options);};
    const running=live.run();
    for(let i=0;i<300&&(await db.cursor('head_logs'))!==1n;i++)await new Promise(resolve=>setTimeout(resolve,10));
    live.stop();await running;
    expect(events.filter(e=>e==='head_retry')).toHaveLength(1);expect(await db.cursor('head_logs')).toBe(1n);expect(await count(db,'swaps')).toBe(2);
  });

  it('does not restore sender rows when their stored block is rolled back during enrichment',async()=>{
    const db=await database();const other=address(170),pool=address(171),weth=registry.requireAddress('tokens.WETH');
    const b=trade(1),tx=b.block.transactions[0].hash;b.receipts[0].logs=[event(v3Abi[0],registry.requireAddress('uniswapV3.factory'),{token0:other,token1:weth,fee:3000,tickSpacing:60,pool},b.block,tx,0),event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,1)];
    const client=memory(new Map([[0n,{block:empty(0),receipts:[]}],[1n,b]]));await follower(db,client).tick();
    client.receipts=async()=>{await db.tx(tx=>tx.deleteAbove(0n));return b.receipts;};
    await expect(enrichSenders(db,other,client)).rejects.toThrow('Reorg before sender enrichment commit');
    expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(0);expect(await db.cursor('head')).toBe(0n);expect(await db.blockHash(1n)).toBeNull();
  });

  it('carries untracked boundary hashes through prefetched, empty and final partial windows',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=7;n++)data.set(BigInt(n),trade(n));
    for(const n of [2,4]){const b=data.get(BigInt(n))!;b.receipts[0].logs=[event(erc20Abi[0],address(500),{from:actor,to:target,value:1n},b.block,b.block.transactions[0].hash,0)];}
    data.set(6n,{block:empty(6),receipts:[]});
    const client=memory(data);let head=6n;client.head=async()=>head;
    const live=follower(db,client,{maxRange:2,pipeline:true});
    await live.tick();expect(await db.blockHash(2n)).toBeNull();
    await live.tick();expect(await db.cursor('head_logs')).toBe(4n);
    expect(hex((await db.sql.query<{parent_hash:Uint8Array}>('SELECT parent_hash FROM chain_blocks WHERE number=3')).rows[0].parent_hash)).toBe(hash(2));
    await live.tick();head=7n;await live.tick();
    expect(await db.cursor('head_logs')).toBe(7n);expect(await db.cursor('head')).toBe(7n);
    expect((await db.sql.query('SELECT block FROM swaps WHERE block>0 ORDER BY block')).rows.map(r=>Number(r.block))).toEqual([1,3,5,7]);
  });
  it('coalesces overlapping ticks instead of applying one frontier twice',async()=>{
    const db=await database();await seed(db);
    const client=memory(new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)]]));client.head=vi.fn(client.head);
    const live=follower(db,client);await Promise.all([live.tick(),live.tick(),live.tick()]);
    expect(client.head).toHaveBeenCalledOnce();expect(await db.cursor('head_logs')).toBe(1n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(1);
  });
  it('commits only a completed 200-block prefix of a larger fetch on shutdown',async()=>{
    const db=await database();await seed(db);
    const client=memory(new Map([[0n,{block:empty(0),receipts:[]}],...Array.from({length:600},(_,i)=>[BigInt(i+1),trade(i+1)] as const)]));
    const live=new LogHeadFollower(client,db,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{startBlock:1n,maxRange:1000,reorgDepth:256,logger:quiet});
    const flush=BlockRows.prototype.flush;vi.spyOn(BlockRows.prototype,'flush').mockImplementation(async function(this:BlockRows,tx){await flush.call(this,tx);live.stop();});
    await live.run();expect(await db.cursor('head_logs')).toBe(200n);expect(await db.cursor('head')).toBe(200n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>200')).rows).toHaveLength(0);
  });

  it('pipelines the next window before the current write, batches commits and drains without advancing discarded work',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],...Array.from({length:60},(_,i)=>[BigInt(i+1),trade(i+1)] as const)]),client=memory(data);
    const live=follower(db,client,{maxRange:20,tickMs:1});
    let writing=false,overlapped=false;const scans:{from:bigint;cursor:bigint|null}[]=[];
    const read=client.logs.bind(client);client.logs=async filter=>{const cursor=await db.cursor('head_logs');if(filter.from>1n)await new Promise(resolve=>setTimeout(resolve,15));if(writing)overlapped=true;scans.push({from:filter.from,cursor});return read(filter);};
    const flush=BlockRows.prototype.flush;
    let writes=0;
    vi.spyOn(BlockRows.prototype,'flush').mockImplementation(async function(this:BlockRows,tx){
      writes++;writing=true;await new Promise(resolve=>setTimeout(resolve,20));await flush.call(this,tx);writing=false;if(writes===2)live.stop();
    });
    await live.run();expect(writes).toBe(2);expect(overlapped).toBe(true);expect(await db.cursor('head_logs')).toBe(40n);expect(await db.cursor('head')).toBe(40n);
    expect(scans.some(s=>s.from===21n&&s.cursor===0n)).toBe(true);expect(scans.some(s=>s.from===41n&&s.cursor===20n)).toBe(true);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>40')).rows).toHaveLength(0);
  });

  it('retries a transport failure inside the tick, keeps the scan cursor, and commits the same rows',async()=>{
    const db=await database();await seed(db);const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)]]),source=memory(data);
    const clock=virtualClock(),env={RPC_HTTP_URL:'https://paid.invalid',RPC_PUBLIC_HTTP_URL:'https://public.invalid'};
    const {meter}=createMeteredClients(env,{db,...clock,transientRetrySec:1,random:()=>.25,log:quiet});meters.push(meter);
    let failed=0;
    fake.send.mockImplementation(async(r:{method:string;params:unknown[]})=>{
      if(r.method==='eth_blockNumber')return toHex(1);
      if(r.method==='eth_getBlockByNumber')return data.get(BigInt(r.params[0] as string))!.block;
      if(r.method==='eth_getBlockReceipts'){expect(r.params).toEqual(['0x1']);if(failed++<2){expect(await db.cursor('head_logs')).toBe(0n);throw new Error('HTTP/2 GOAWAY');}return data.get(1n)!.receipts;}
      if(r.method==='eth_getLogs'){const f=r.params[0] as {fromBlock:string;toBlock:string;topics:Hex[][]};return source.logs({from:BigInt(f.fromBlock),to:BigInt(f.toBlock),topics:f.topics[0]});}
      if(r.method==='eth_getCode')return '0x';throw new Error('Unexpected retry RPC');
    });
    const client=createClients(env,registry,meter,{head:true});client.ethUsdRate=async()=>null;await follower(db,client).tick();
    expect(await db.cursor('head_logs')).toBe(1n);expect((await db.sql.query('SELECT * FROM swaps WHERE block=1')).rows).toHaveLength(1);
    expect((await meter.usage()).today.filter(r=>r.method==='eth_getBlockReceipts').reduce((n,r)=>n+r.calls,0)).toBe(3);
  });

  it('replays captured Pons/v3/v4 blocks with identical indexed rows, actors, prices, USD, and timestamps', async () => {
    const oldDb = await database(), db = await database();
    const data: Data = new Map([[0n,{ block: empty(0), receipts: [] }]]);
    for (const [i,name] of ['v4Initialize','v3PoolCreated','ponsLaunch','ponsSell'].entries()) {
      const b = structuredClone(fixtures[name]), n = i + 1; const original = b.block;
      b.block = { ...original, number: toHex(n), hash: hash(n), parentHash: hash(n-1) };
      for (const r of b.receipts) { r.blockNumber = toHex(n); r.blockHash = hash(n); for (const l of r.logs) { l.blockNumber = toHex(n); l.blockHash = hash(n); l.blockTimestamp = b.block.timestamp; } }
      data.set(BigInt(n),b);
    }
    const pools = new Map<string, PoolMetadata>(); const tokenAddresses = new Set<Address>();
    for (const b of data.values()) for (const r of b.receipts) for (const l of r.logs) {
      for (const e of decodeResult(l,{ registry, isV3Pool: () => true }).events) if (e.source === 'uniswap_v3' && e.eventName === 'Swap') {
        const currencies = new Set<Address>(); for (const t of r.logs) for (const e of decodeResult(t,{registry}).events) if (e.source === 'erc20' && [e.args.from,e.args.to].some(a => lower(a) === lower(l.address))) currencies.add(t.address);
        const pair = [...currencies].sort(); if (pair.length === 2) pools.set(lower(l.address),{ currency0: pair[0], currency1: pair[1], fee: 3000, tickSpacing: 60 });
      }
      for (const e of decodeResult(l,{registry}).events) if (e.source === 'erc20') tokenAddresses.add(l.address);
    }
    const client = memory(data); client.v3Pool = async a => pools.get(lower(a)) ?? null;
    for (const d of [oldDb,db]) {
      for (const a of tokenAddresses) await d.insert('tokens',{ address: binary(a), ...await client.tokenMetadata(a,0n), first_block:'0',block:'0' });
      // Model canonical creation evidence for the reference pair; other pool reads remain provisional.
      for (const [id,p] of pools) await d.insert('pools',{ id:binary(id),venue:'uniswap_v3',currency0:binary(p.currency0),currency1:binary(p.currency1),fee:p.fee,tick_spacing:p.tickSpacing,creation_verified:[p.currency0,p.currency1].every(a=>[lower(registry.requireAddress('tokens.WETH')),lower(registry.requireAddress('tokens.USDG'))].includes(lower(a))),created_block:'0',block:'0' });
    }
    const old = new HeadFollower(client,oldDb,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{reorgDepth:256,logger:quiet});
    for (const b of data.values()) await old.ingest(b.block,b.receipts);
    const metadata = vi.spyOn(client,'tokenMetadata'), price = vi.spyOn(client,'ethUsdRate'), reads = vi.spyOn(client,'v3Pool'); metadata.mockClear(); price.mockClear(); reads.mockClear();
    const ticks:Record<string,unknown>[]=[];
    await follower(db,client,{logger:(event:string,fields:Record<string,unknown>)=>{if(event==='head_tick')ticks.push(fields);}}).tick();
    expect(ticks.some(t=>Number((t.receipts_by_reason as Record<string,number>).launch)>0)).toBe(true);
    expect((await db.sql.query('SELECT * FROM liquidity_events WHERE tx_from IS NULL AND actor IS NOT NULL AND NOT senders_pending')).rows.length).toBeGreaterThan(0);
    expect(price).toHaveBeenCalledTimes(new Set([...data.values()].filter(b=>b.receipts.length).map(b=>BigInt(b.block.number)/600n)).size); expect(reads).not.toHaveBeenCalled();
    expect(await snapshot(db)).toEqual(await snapshot(oldDb));
    const swaps = (await db.sql.query<{ recipient: Uint8Array; trader: Uint8Array; usd: number }>("SELECT * FROM swaps WHERE venue='pons_curve'")).rows;
    expect(swaps).toHaveLength(6); expect(swaps.every(s=>s.recipient != null && s.usd > 0)).toBe(true);
  },30000);

  it.each(['hash','removed'] as const)('rolls back a %s reorg and replays replacements, retaining idempotent bus notifications', async mode => {
    const db=await database(); await seed(db); const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)],[2n,trade(2)]]); const client=memory(data), live=follower(db,client,{maxRange:1});
    await live.tick(); await live.tick();
    data.set(1n,trade(1,100));data.set(2n,trade(2,100)); data.set(3n,trade(3,100));
    if(mode==='removed') { const original=client.header!; client.header=vi.fn(async n=>{ if(n===2n && (client.header as ReturnType<typeof vi.fn>).mock.calls.length===1)return empty(2); return original(n); }); const getLogs=client.logs; client.logs=vi.fn(async f=>(await getLogs(f)).map(l=>({...l,removed:true}))); }
    await live.tick(); expect(await db.cursor('head')).toBe(0n); expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(0);
    client.header=async n=>data.get(n)!.block;client.logs=memory(data).logs;
    const messages=vi.spyOn(db,'notify');
    for(let i=0;i<3;i++)await live.tick();
    expect(await db.blockHash(3n)).toBe(hash(103)); expect(await db.cursor('head_logs')).toBe(3n);
    const before=await snapshot(db); await live.tick(); expect(await snapshot(db)).toEqual(before); expect(messages).not.toHaveBeenCalled();
  });

  it('persists empty-window progress across restart, caps catch-up windows, and halts at the sparse reorg depth limit', async()=>{
    const db=await database(); const data:Data=new Map(Array.from({length:10},(_,n)=>[BigInt(n),{block:empty(n),receipts:[]}])) ; const client=memory(data), logs=vi.spyOn(client,'logs');
    await follower(db,client,{maxRange:3}).tick(); expect(await db.cursor('head_logs')).toBe(3n);
    const restarted=follower(db,client,{maxRange:3});await restarted.tick();await restarted.tick();expect(await db.cursor('head_logs')).toBe(9n);
    expect(logs.mock.calls.map(([f])=>[f.from,f.to])).toEqual([[1n,3n],[4n,6n],[7n,9n]]);expect((await db.sql.query('SELECT * FROM chain_blocks')).rows).toHaveLength(1);
    data.set(0n,{block:empty(0,100),receipts:[]});await expect(restarted.tick()).rejects.toBeInstanceOf(ReorgDepthError);
  });

  it('splits Transfer address and response limits without dropping logs, and never splits guard errors',async()=>{
    const db=await database();const b=trade(1), data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,b],[2n,trade(2)]]);await seed(db);
    for(let n=120;n<123;n++){await db.insert('tokens',{address:binary(address(n)),decimals:18,first_block:'0',block:'0'});for(const item of [b,data.get(2n)!])item.receipts[0].logs.push(event(erc20Abi[0],address(n),{from:actor,to:curve,value:1n},item.block,item.block.transactions[0].hash,n));}
    const client=memory(data), normal=client.logs;client.logs=vi.fn(async f=>{if(!f.addresses&&f.topics.includes(toEventSelector(erc20Abi[0])))throw new Error('HTTP response body exceeded the size limit');if(f.addresses&&f.addresses.length>2)throw new Error('too many addresses');return normal(f);});
    const chunked=follower(db,client);await chunked.tick();await chunked.tick();expect((await db.sql.query('SELECT * FROM token_transfers')).rows).toHaveLength(8);expect((client.logs as ReturnType<typeof vi.fn>).mock.calls.some(([f])=>f.addresses?.length===2)).toBe(true);
    const stop=new RpcGuardError('rpc_session_budget_reached');client.logs=vi.fn(async()=>{throw stop;});const live=follower(db,client);await db.setCursor('head_logs',0n,null);await expect(live.tick()).rejects.toBe(stop);expect(client.logs).toHaveBeenCalledOnce();
  });

  it('picks up a new pool and its next-block swaps in one tick, retains unverified UserOps as missing, and refreshes code on SetCode or TTL only',async()=>{
    const db=await database();await db.insert('tokens',{address:binary(coin),decimals:18,launchpad:'pons',first_block:'0',block:'0'});const entry=address(131), user=address(132), manager=registry.requireAddress('uniswapV4.poolManager');
    const custom=new AddressRegistry({...registry.data,entryPoints:{...registry.data.entryPoints,v07:{address:entry}}});
    const aa=parseAbi(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=4;n++){
      const b=trade(n),tx=b.block.transactions[0].hash;
      const args={id:hash(130),sender:target,amount0:-(10n**18n),amount1:100n*10n**18n,sqrtPriceX96:1n,liquidity:1n,tick:0,fee:100};
      b.receipts[0].logs=[...(n===1?[event(v4Abi[0],manager,{id:hash(130),currency0:native,currency1:coin,fee:100,tickSpacing:1,hooks:native,sqrtPriceX96:1n,tick:0},b.block,tx,0)]:[]),event(aa[0],entry,{},b.block,tx,1),event(v4Abi[1],manager,args,b.block,tx,2),event(aa[1],entry,{userOpHash:hash(131),sender:user,paymaster:native,nonce:0n,success:true,actualGasCost:0n,actualGasUsed:0n},b.block,tx,3),event(v4Abi[1],manager,args,b.block,tx,4)];
      if(n===3)b.receipts[0].type='0x4';data.set(BigInt(n),b);
    }
    const client=memory(data);client.code=vi.fn(async(): Promise<Hex>=>`0xef0100${'9'.repeat(40)}`);let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
    const live=follower(db,client,{maxRange:2,codeCacheSec:10},custom);await live.tick();expect(client.code).toHaveBeenCalledOnce();expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(4);
    await live.tick();expect(client.code).toHaveBeenCalledTimes(2);expect((await db.sql.query<{trader:Uint8Array|null}>('SELECT trader FROM swaps ORDER BY block,log_index')).rows.map(r=>r.trader)).toEqual(Array.from({length:8},()=>null));
    data.set(5n,trade(5));await db.sql.query('UPDATE tokens SET curve=$2,launchpad=$3 WHERE address=$1',[binary(coin),binary(curve),'pons']);now+=10001;await live.tick();expect(client.code).toHaveBeenCalledTimes(3);
    expect((await db.sql.query('SELECT * FROM pools')).rows).toHaveLength(1);
  });

  it('attributes smart-account swaps identically in backfill and live follower, and enriches old null rows',async()=>{
    const liveDb=await database(),backfillDb=await database(),legacyDb=await database();await seed(liveDb);await seed(backfillDb);await seed(legacyDb);
    const b=trade(1),tx=b.block.transactions[0],entry=registry.requireAddress('entryPoints.v08'),first=address(210),second=address(211),paymaster=address(212);
    tx.to=entry;b.receipts[0].to=entry;
    const aa=parseAbi(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);
    const original=b.receipts[0].logs;
    b.receipts[0].logs=[event(aa[0],entry,{},b.block,tx.hash,0),...original.map((l,i)=>({...l,logIndex:toHex(i+1)})),
      event(aa[1],entry,{userOpHash:hash(213),sender:first,paymaster,nonce:0n,success:true,actualGasCost:1n,actualGasUsed:1n},b.block,tx.hash,3),
      ...original.map((l,i)=>({...l,logIndex:toHex(i+4)})),
      event(aa[1],entry,{userOpHash:hash(214),sender:second,paymaster:native,nonce:1n,success:true,actualGasCost:1n,actualGasUsed:1n},b.block,tx.hash,6)];
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,b]]),client=memory(data);
    client.ethUsdRate=async()=>({value:2000,block:0n,source:{ address: address(110), venue: 'uniswap_v3' as const, fee: 3000 }});
    await follower(liveDb,client).tick();
    await backfillDb.sql.query("INSERT INTO ingest_ranges(stream,from_block,to_block,status) VALUES('logs:pons_factory',0,1,'done')");
    const backfill=new PonsBackfill(client,backfillDb,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{workers:1,logRange:10,logger:quiet});
    const logRead=vi.spyOn(client,'logs');
    await backfill.run('logs:pons_curves',1n,1n);
    expect(logRead).toHaveBeenCalled();
    expect((await backfillDb.sql.query('SELECT * FROM pons_events')).rows).toHaveLength(2);
    const read=async(db:ChainDb)=>(await db.sql.query('SELECT block,trader,tx_from,tx_to,log_index,amount_coin,usd FROM swaps WHERE coin=$1 ORDER BY log_index',[binary(coin)])).rows;
    expect(await read(backfillDb)).toEqual(await read(liveDb));
    expect((await read(liveDb)).map(r=>hex(r.trader as Uint8Array))).toEqual([first,second]);
    const coverage=async(db:ChainDb)=>JSON.parse(JSON.stringify((await db.sql.query<{data:{holderAttribution:unknown;principalBindings:string}}>('SELECT data FROM wallet_protocol_coverage WHERE tx_hash=$1',[binary(tx.hash)])).rows[0].data));
    expect((await coverage(backfillDb)).holderAttribution).toEqual((await coverage(liveDb)).holderAttribution);
    expect((await coverage(liveDb)).principalBindings).toBe('missing_043');
    // A previously unknown deployment records a terminal gap. Its registry revision
    // differs after verification, so existing null rows become enrichment candidates.
    const priorRegistry=new AddressRegistry({...registry.data,entryPoints:{...registry.data.entryPoints,v08:{address:'TODO'}}});
    const priorDecoder=new BlockDecoder(client,priorRegistry,new Metrics(quiet),quiet),priorState=await priorDecoder.prepare(legacyDb,b.block,b.receipts);
    await legacyDb.tx(tx=>priorDecoder.collect(b.block,b.receipts,priorState).flush(tx));
    expect((await read(legacyDb)).map(r=>r.trader)).toEqual([null,null]);
    expect((await enrichSenders(legacyDb,coin,client)).enriched).toBe(2);
    expect(await read(legacyDb)).toEqual(await read(liveDb));
    expect((await enrichSenders(legacyDb,coin,client)).enriched).toBe(0);
    await backfillDb.sql.query('UPDATE swaps SET trader=NULL,senders_pending=false WHERE coin=$1',[binary(coin)]);
    expect((await enrichSenders(backfillDb,coin,client)).enriched).toBe(2);
    expect(await read(backfillDb)).toEqual(await read(liveDb));
    // Re-decoding already stored canonical rows also fills missing actors without replacing amounts.
    await liveDb.sql.query('UPDATE swaps SET trader=NULL WHERE coin=$1',[binary(coin)]);
    const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet),state=await decoder.prepare(liveDb,b.block,b.receipts);
    await liveDb.tx(tx=>decoder.collect(b.block,b.receipts,state).flush(tx));expect(await read(liveDb)).toEqual(await read(backfillDb));
  });

  it('keeps delegation caches per address, shares in-flight reads, and refreshes only changed or expired entries',async()=>{
    const client=memory(new Map()),decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet);
    const other=address(160);let now=1000;
    vi.spyOn(Date,'now').mockImplementation(()=>now);
    client.code=vi.fn(async():Promise<Hex>=> '0x');
    const scope={tokens:new Set([lower(coin)]),curves:new Map([[lower(curve),coin]]),pools:new Map(),tokenRows:[],poolRows:[]};
    const read=async(n:number,to:Address,setCode=false)=>{
      const b=trade(n);b.block.transactions[0].to=to;b.receipts[0].to=to;
      if(setCode)b.receipts[0].type='0x4';
      return decoder.prefetch(b.block,b.receipts,{head:true,codeCacheSec:10,scope});
    };
    const initial=await Promise.all([read(1,target),read(2,target),read(3,other)]);expect(client.code).toHaveBeenCalledTimes(2);
    expect(initial.map(r=>[...r.codeBlocks!.values()][0])).toEqual([1n,1n,3n]);
    now=6000;await read(4,target,true);await read(5,other);expect(client.code).toHaveBeenCalledTimes(3);
    now=11001;await read(6,other);await read(7,target);expect(client.code).toHaveBeenCalledTimes(4);
    expect(vi.mocked(client.code).mock.calls.map(([a])=>a)).toEqual([target,other,target,other]);
    decoder.invalidate();await read(8,target);expect(client.code).toHaveBeenCalledTimes(5);
  });

  it('reuses newly filled currency metadata instead of rereading a window placeholder on every block',async()=>{
    const db=await database();await seed(db);
    const quote=address(170),pool=address(171);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=40;n++){
      const b=trade(n),tx=b.block.transactions[0].hash;
      b.receipts[0].logs=[event(v3Abi[1],pool,{sender:actor,recipient:actor,amount0:-100n*10n**18n,amount1:10n**18n,sqrtPriceX96:2n**96n,liquidity:1000n,tick:0},b.block,tx,1)];
      if(n===1)b.receipts[0].logs.unshift(event(v3Abi[0],registry.requireAddress('uniswapV3.factory'),{token0:coin,token1:quote,fee:3000,tickSpacing:60,pool},b.block,tx,0));
      data.set(BigInt(n),b);
    }
    const client=memory(data);client.tokenMetadata=vi.fn(client.tokenMetadata);client.ethUsdRate=vi.fn(async n=>({value:2000,block:n,source:{ address: address(110), venue: 'uniswap_v3' as const, fee: 3000 }}));
    await follower(db,client).tick();
    expect(client.tokenMetadata).toHaveBeenCalledOnce();
    expect(lower(vi.mocked(client.tokenMetadata).mock.calls[0][0])).toBe(lower(quote));expect(vi.mocked(client.tokenMetadata).mock.calls[0][1]).toBe(1n);
    expect(client.ethUsdRate).toHaveBeenCalledExactlyOnceWith(0n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(40);
  });

  it('overlaps distinct target enrichment with bounded concurrency and drains failures before retry',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}]]);
    for(let n=1;n<=40;n++){const b=trade(n);b.block.transactions[0].to=address(200+n);b.receipts[0].to=address(200+n);data.set(BigInt(n),b);}
    const client=memory(data);let active=0,peak=0,fail=true;
    client.code=vi.fn(async(a):Promise<Hex>=>{
      peak=Math.max(peak,++active);
      try {await new Promise(resolve=>setTimeout(resolve,15));if(fail&&lower(a)===lower(address(201)))throw new Error('code unavailable');return '0x';}
      finally {active--;}
    });
    const live=follower(db,client);
    await expect(live.tick()).rejects.toThrow('code unavailable');expect(active).toBe(0);expect(await db.cursor('head_logs')).toBe(0n);expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(0);
    fail=false;await live.tick();expect(peak).toBe(32);expect(active).toBe(0);expect(await db.cursor('head_logs')).toBe(40n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(40);
  });

  it('loads sparse parent hashes publicly and preserves exact stored rows without paid headers',async()=>{
    const db=await database();await seed(db);
    const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,{block:empty(1),receipts:[]}],[2n,trade(2)]]),client=memory(data);
    client.header=vi.fn(client.header);client.parentHeader=vi.fn(async n=>data.get(n)!.block);
    const ticks:Record<string,unknown>[]=[];
    await follower(db,client,{logger:(event:string,fields:Record<string,unknown>)=>{if(event==='head_tick')ticks.push(fields);}}).tick();
    expect(client.header).toHaveBeenCalledExactlyOnceWith(0n);expect(client.parentHeader).toHaveBeenCalledExactlyOnceWith(2n);
    expect(hex((await db.sql.query<{parent_hash:Uint8Array}>('SELECT parent_hash FROM chain_blocks WHERE number=2')).rows[0].parent_hash)).toBe(hash(1));
    expect(ticks[0].headers_by_reason).toEqual({cursor:1,missing_timestamp:0,missing_parent:1});
  });

  it('rejects missing timestamps, inconsistent receipts and writes atomically; reports wall-clock lag and blocks behind',async()=>{
    const db=await database();await seed(db);const data:Data=new Map([[0n,{block:empty(0),receipts:[]}],[1n,trade(1)],[2n,trade(2)]]), client=memory(data),live=follower(db,client,{maxRange:1});
    const timestamp=data.get(1n)!.receipts[0].logs[0].blockTimestamp!;for(const log of data.get(1n)!.receipts[0].logs)delete log.blockTimestamp;const header=vi.spyOn(client,'header').mockResolvedValueOnce(empty(0)).mockRejectedValueOnce(new Error('missing timestamp header'));await expect(live.tick()).rejects.toThrow('missing timestamp header');header.mockRestore();
    for(const log of data.get(1n)!.receipts[0].logs)log.blockTimestamp=timestamp;const insert=ChainDb.prototype.insertMany;const write=vi.spyOn(ChainDb.prototype,'insertMany').mockImplementation(async function(this:ChainDb,table,rows){if(table==='swaps')throw new Error('write failed');return insert.call(this,table,rows);});await expect(live.tick()).rejects.toThrow('write failed');expect(await db.blockHash(1n)).toBeNull();write.mockRestore();
    await live.tick();expect(live.decoder.metrics.blocksBehind).toBe(1);expect(Math.abs(live.decoder.metrics.headLagMs-Math.max(0,Date.now()-Number(BigInt(timestamp))*1000))).toBeLessThan(100);
  });
});

describe('head loop through provider outages', () => {
  const outage = (message = 'RPC reply rejected the whole batch: rate limit hit') => new RpcGuardError('rpc_unavailable', message, true);
  async function trades(count: number) {
    const db = await database(); await seed(db);
    const data: Data = new Map([[0n, { block: empty(0), receipts: [] }], ...Array.from({ length: count }, (_, i) => [BigInt(i + 1), trade(i + 1)] as const)]);
    return { db, data, client: memory(data) };
  }
  it('pauses paid ingest in place and resumes the same follower and decoder after a balance outage', async () => {
    const { db, client } = await trades(2);
    let now=0,available=true,release!:()=>void,paused!:()=>void;
    const entered=new Promise<void>(resolve=>{paused=resolve;});
    const meter=new RpcMeter({RPC_HTTP_URL:'https://paid.invalid'}, {store:{reserve:async()=>({allowed:true,total:1}),today:async()=>[]},
      pauseOnOutage:true,now:()=>now,log:quiet,onPauseChange:state=>{if(state)paused();},sleep:async ms=>{now+=ms;if(ms>=10000)await new Promise<void>(resolve=>{release=resolve;});}});
    meters.push(meter);
    const logs=client.logs.bind(client);
    const send=async(r:{method:string})=>{if(!available)throw new Error('User balance exceeded');return r.method==='eth_blockNumber'?'0x2':'ok';};
    client.logs=async filter=>{await meter.request({method:'eth_call'},{paid:send,public:send},'archive');return logs(filter);};
    const live=follower(db,client,{maxRange:1});
    const decoder=live.decoder,invalidated=vi.spyOn(decoder,'invalidate');
    await live.tick();expect(await db.cursor('head_logs')).toBe(1n);
    available=false;const pending=live.tick();await entered;
    expect(meter.pause?.reason).toBe('provider_balance_exceeded');expect(await db.cursor('head_logs')).toBe(1n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(1);
    available=true;release();await pending;
    expect(live.decoder).toBe(decoder);expect(invalidated).not.toHaveBeenCalled();
    expect(meter.pause).toBeNull();expect(await db.cursor('head_logs')).toBe(2n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(2);
  });
  it('backs off with capped jittered delays and keeps running instead of halting, reporting heads and committed cursors', async () => {
    const { db, client } = await trades(2);
    const logs = client.logs.bind(client); let failures = 0;
    // As thrown through viem's custom transport: an unknown RPC error whose cause is the meter's verdict.
    client.logs = vi.fn(async filter => { if (failures++ < 4) throw Object.assign(new Error('An unknown RPC error occurred.'), { code: -1, cause: outage() }); return logs(filter); });
    const events: { event: string; fields: Record<string, unknown> }[] = [], heads: bigint[] = [], cursors: bigint[] = [];
    let live!: LogHeadFollower;
    live = follower(db, client, { tickMs: 1, retryBaseMs: 2, retryCapMs: 8, random: () => .5,
      logger: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
      onHead: (n: bigint) => heads.push(n), onProgress: (n: bigint) => { cursors.push(n); if (n >= 2n) live.stop(); } });
    await live.run();
    const retries = events.filter(e => e.event === 'head_retry').map(e => e.fields);
    expect(retries.map(r => [r.attempt, r.backoff_ms])).toEqual([[1, 2], [2, 3], [3, 6], [4, 6]]);
    expect(retries.every(r => r.reason === 'rpc_unavailable' && String(r.error).includes('rate limit hit'))).toBe(true);
    expect(await db.cursor('head_logs')).toBe(2n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(2);
    expect(heads).toEqual([2n, 2n, 2n, 2n, 2n]);
    expect(cursors).toEqual([0n, 0n, 0n, 0n, 0n, 2n]);
  });
  it('recovers through the metered client when both providers keep returning bad batch replies for a while', async () => {
    const { db, data, client: source } = await trades(1);
    const clock = virtualClock(), env = { RPC_HTTP_URL: 'https://paid.invalid', RPC_PUBLIC_HTTP_URL: 'https://public.invalid' };
    const { meter } = createMeteredClients(env, { db, ...clock, transientRetrySec: 1, random: () => .25, log: quiet }); meters.push(meter);
    let bad = 12;
    fake.send.mockImplementation(async (r: { method: string; params: unknown[] }) => {
      if (r.method === 'eth_chainId') return '0x1237';
      if (r.method === 'eth_blockNumber') return toHex(1);
      if (r.method === 'eth_getBlockByNumber') return data.get(BigInt(r.params[0] as string))!.block;
      if (r.method === 'eth_getBlockReceipts') return data.get(1n)!.receipts;
      if (r.method === 'eth_getLogs') {
        if (bad-- > 0) throw new RpcReplyError('batch_error', true, 'RPC reply rejected the whole batch: rate limit hit');
        const f = r.params[0] as { fromBlock: string; toBlock: string; topics: Hex[][] };
        return source.logs({ from: BigInt(f.fromBlock), to: BigInt(f.toBlock), topics: f.topics[0] });
      }
      if (r.method === 'eth_getCode') return '0x'; throw new Error('Unexpected RPC');
    });
    const client = createClients(env, registry, meter, { head: true }); client.ethUsdRate = async () => null;
    const retries: Record<string, unknown>[] = [];
    let live!: LogHeadFollower;
    live = follower(db, client, { tickMs: 1, retryBaseMs: 1, retryCapMs: 2, logger: (event: string, fields: Record<string, unknown>) => { if (event === 'head_retry') retries.push(fields); },
      onProgress: (n: bigint) => { if (n >= 1n) live.stop(); } });
    await live.run();
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.every(r => !String(r.error).includes('Cannot read properties'))).toBe(true);
    expect(await db.cursor('head_logs')).toBe(1n);
  });
  it.each([
    ['a wrong chain', (client: ChainClient) => { client.chainId = async () => 1; }, 'RPC chain ID must be 4663'],
    ['a database write failure', () => { const insert = ChainDb.prototype.insertMany; vi.spyOn(ChainDb.prototype, 'insertMany').mockImplementation(async function(this: ChainDb, table, rows) { if (table === 'swaps') throw new Error('write failed'); return insert.call(this, table, rows); }); }, 'write failed'],
    ['a permanent provider rejection', (client: ChainClient) => { client.logs = async () => { throw new RpcGuardError('rpc_unavailable', 'invalid params'); }; }, 'invalid params'],
    ['a usage-store failure', (client: ChainClient) => { client.logs = async () => { throw new RpcGuardError('rpc_unavailable', 'RPC usage persistence unavailable'); }; }, 'RPC usage persistence unavailable'],
    // A spent paid daily budget no longer halts (see below); the per-process session budget still ends the run.
    ['the session budget', (client: ChainClient) => { client.logs = async () => { throw new RpcGuardError('rpc_session_budget_reached'); }; }, 'rpc_session_budget_reached'],
  ] as const)('still halts on %s', async (_name, breakIt, message) => {
    const { db, client } = await trades(1);
    breakIt(client);
    const events: string[] = [];
    await expect(follower(db, client, { tickMs: 1, logger: (event: string) => events.push(event) }).run()).rejects.toThrow(message);
    expect(events).not.toContain('head_retry');
  });
  // Replaces "still halts on the paid daily budget": a spent budget used to end the run (exit 0, no restart) for the rest of the UTC day.
  it('keeps running when the paid daily budget is spent: says so once, and waits out a pinned read the public lane cannot serve', async () => {
    const { db, client } = await trades(2);
    client.paidExhausted = () => true;
    const code = client.code.bind(client); let refusals = 0;
    client.code = vi.fn(async (a: Address, n: bigint) => { if (refusals++ < 3) throw Object.assign(new Error('An unknown RPC error occurred.'), { cause: new RpcGuardError('rpc_budget_exhausted', 'Paid budget spent; the public lane cannot serve this pinned read') }); return code(a, n); });
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    let live!: LogHeadFollower;
    live = follower(db, client, { tickMs: 1, retryBaseMs: 2, retryCapMs: 8, random: () => .5,
      logger: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }), onProgress: (n: bigint) => { if (n >= 2n) live.stop(); } });
    await live.run();
    expect(events.filter(e => e.event === 'head_public_lane').map(e => e.fields)).toEqual([expect.objectContaining({ reason: 'rpc_budget_exhausted', lane: 'public' })]);
    const retries = events.filter(e => e.event === 'head_retry').map(e => e.fields);
    expect(retries.map(r => [r.reason, r.lane, r.backoff_ms])).toEqual([['rpc_budget_exhausted', 'public', 2], ['rpc_budget_exhausted', 'public', 3], ['rpc_budget_exhausted', 'public', 6]]);
    expect(events.filter(e => e.event === 'head_tick').every(e => e.fields.paid_budget === 'exhausted' && e.fields.lane === 'public')).toBe(true);
    expect(await db.cursor('head_logs')).toBe(2n);
    expect((await db.sql.query('SELECT * FROM swaps WHERE block>0')).rows).toHaveLength(2);
  });
  it('reads pinned state on the public lane once the paid budget is spent, and keeps the budget error when public cannot serve it', async () => {
    const env = { RPC_HTTP_URL: 'https://paid.invalid', RPC_PUBLIC_HTTP_URL: 'https://public.invalid' };
    const store = { reserve: async (_day: string, provider: string) => provider === 'paid' ? { allowed: false, total: 200_000 } : { allowed: true, total: 0 }, today: async () => [] };
    const { meter } = createMeteredClients(env, { store, log: quiet }); meters.push(meter);
    const sent: string[] = []; let pruned = false;
    fake.send.mockImplementation(async (r: { method: string; params: unknown[] }, _options: unknown, url: string) => {
      sent.push(`${url.includes('public') ? 'public' : 'paid'}:${r.method}`);
      if (r.method === 'eth_getCode') { if (pruned) throw new Error('missing trie node'); expect(r.params[1]).toBe('0x7b'); return `0xef0100${'9'.repeat(40)}`; }
      throw new Error(`Unexpected pinned RPC ${r.method}`);
    });
    const client = createClients(env, registry, meter, { head: true });
    expect(await client.code(target, 123n)).toBe(`0xef0100${'9'.repeat(40)}`);
    expect(client.paidExhausted!()).toBe(true);
    expect(sent).toEqual(['public:eth_getCode']);
    pruned = true;
    const error = await client.code(target, 123n).catch((e: unknown) => e);
    expect(rpcStopReason(error)).toBe('rpc_budget_exhausted');
    expect(sent.slice(1)).toEqual(['public:eth_getCode']);
  });
});
