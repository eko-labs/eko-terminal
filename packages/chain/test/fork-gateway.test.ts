import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MeteredForkGateway, forkMethods } from '../src/simulation/fork-gateway.js';
import { gatewayReset, localForkRpc } from '../src/simulation/fork-runtime.js';
import { RpcMeter, type RpcEnv } from '../src/rpc/metered.js';
import type { UsageRow, UsageStore } from '../src/rpc/usage.js';
import { SerializedMeteredForkLease } from '../src/simulation/anvil.js';
import { cursor } from './reference-fixtures.js';
const directories:string[]=[],meters:RpcMeter[]=[];
afterEach(async()=>{for(const meter of meters.splice(0))await meter.close();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function harness(env:RpcEnv={},directory?:string,cap?:number) {
  const dir=directory??await mkdtemp(join(tmpdir(),'eko-fork-test-'));if(!directory)directories.push(dir);
  const rows:UsageRow[]=[],logs:string[]=[];
  const store:UsageStore={reserve:async(_day,provider,method,units,limit)=>{
    const total=rows.filter(r=>r.provider===provider).reduce((n,r)=>n+r.units,0);
    if(total+units>limit)return {allowed:false,total};rows.push({provider,method,calls:1,units});return {allowed:true,total:total+units};
  },today:async()=>rows};
  const meter=new RpcMeter({RPC_HTTP_URL:'https://rpc.invalid',...env},{store,now:()=>0,sleep:async()=>{},log:(event,fields)=>logs.push(JSON.stringify({event,...fields})),onSessionBudget:()=>{}});meters.push(meter);
  const paid=vi.fn(async(r:{method:string;params?:readonly unknown[]}):Promise<unknown>=> {
    if(r.method==='eth_chainId')return '0x1237';if(r.method==='net_version')return '4663';
    if(r.method.startsWith('eth_getBlockBy'))return {number:`0x${BigInt(cursor.blockNumber).toString(16)}`,hash:cursor.blockHash,timestamp:`0x${BigInt(cursor.timestampSec).toString(16)}`};
    return '0x01';
  });
  const publicSend=vi.fn(async()=>{throw new Error('must not fall back');});
  const gateway=new MeteredForkGateway({request:r=>meter.request(r,{paid,public:publicSend},'fork')},meter,dir,cap,(event,fields)=>logs.push(JSON.stringify({event,...fields})));
  await gateway.setPin(cursor);
  let id=0;
  const call=(method:string,params:unknown[]=[])=>gateway.dispatch({jsonrpc:'2.0',id:++id,method,params}) as Promise<{result?:unknown;error?:{message:string;code:number}}>;
  return {gateway,meter,dir,logs,paid,publicSend,call};
}
const block=`0x${BigInt(cursor.blockNumber).toString(16)}`,account=`0x${'a1'.repeat(20)}`,hash=`0x${'b2'.repeat(32)}`;
it('explicitly permits fork reads, rejects all writes/debug/unknown methods, and pins the synthetic head',async()=>{
  const h=await harness();
  const params:Record<string,unknown[]>={eth_getStorageAt:[account,'0x0',block],eth_getCode:[account,block],eth_getBalance:[account,block],eth_getTransactionCount:[account,block],
    eth_getProof:[account,['0x0'],block],eth_getBlockByNumber:[block,false],eth_getBlockByHash:[cursor.blockHash,false],eth_getTransactionByHash:[hash],eth_getTransactionReceipt:[hash],eth_getBlockReceipts:[block]};
  h.paid.mockImplementation(async r=> {
    if(['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(r.method))return {blockNumber:block};
    if(r.method==='eth_getBlockReceipts')return [];
    if(r.method==='eth_chainId')return '0x1237';if(r.method==='net_version')return '4663';
    if(r.method.startsWith('eth_getBlockBy'))return {number:block,hash:cursor.blockHash,timestamp:`0x${BigInt(cursor.timestampSec).toString(16)}`};
    return '0x01';
  });
  for(const method of forkMethods)expect((await h.call(method,params[method]??[])).error,method).toBeUndefined();
  expect((await h.call('eth_blockNumber')).result).toBe(block);
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','debug_traceCall','trace_call','eth_call','web3_clientVersion','eth_gasPrice','anvil_reset'])expect((await h.call(method)).error?.code).toBe(-32601);
  expect(h.paid).toHaveBeenCalledTimes(forkMethods.length-1);expect(h.publicSend).not.toHaveBeenCalled();
});
it('accepts an omitted params member as Anvil sends it, and still rejects non-array params',async()=>{
  const h=await harness();
  expect((await h.gateway.dispatch({jsonrpc:'2.0',id:0,method:'eth_blockNumber'}) as {result?:unknown}).result).toBe(block);
  expect((await h.gateway.dispatch({jsonrpc:'2.0',id:1,method:'eth_chainId'}) as {result?:unknown}).result).toBe('0x1237');
  expect((await h.gateway.dispatch({jsonrpc:'2.0',id:2,method:'eth_getCode'}) as {error?:{message:string}}).error?.message).toBe('fork_unpinned_read');
  expect((await h.gateway.dispatch({jsonrpc:'2.0',id:3,method:'eth_chainId',params:{}}) as {error?:{message:string}}).error?.message).toBe('fork_invalid_request');
});
it.each(['RPC_SESSION_BUDGET','RPC_PAID_DAILY_BUDGET'] as const)('closes %s with a clear JSON-RPC refusal and never sends to fallback',async budget=>{
  const h=await harness({[budget]:'2',RPC_WEIGHTS:'{"eth_getStorageAt":2}'});
  expect((await h.call('eth_getStorageAt',[account,'0x0',block])).result).toBe('0x01');
  const refused=await h.call('eth_getStorageAt',[account,'0x1',block]);
  expect(refused.error?.message).toBe(budget==='RPC_SESSION_BUDGET'?'rpc_session_budget_reached':'rpc_budget_exhausted');
  expect(h.paid).toHaveBeenCalledTimes(1);expect(h.publicSend).not.toHaveBeenCalled();
  expect(h.gateway.snapshot()).toMatchObject({upstreamRequestUnits:2,forwarded:1});
});
it('reuses disk cache across gateway instances and charges nothing on pinned reruns, even with budget closed',async()=>{
  const h=await harness({RPC_SESSION_BUDGET:'1'});
  await h.call('eth_getStorageAt',[account,'0x0',block]);
  expect((await h.call('eth_getStorageAt',[account,'0x0',block])).result).toBe('0x01');
  const second=await harness({RPC_PAID_DAILY_BUDGET:'0'},h.dir);
  expect((await second.call('eth_getStorageAt',[account,'0x0',block])).result).toBe('0x01');
  expect(second.paid).not.toHaveBeenCalled();expect(second.gateway.snapshot()).toMatchObject({cacheHits:1,upstreamRequestUnits:0});
  const other={...cursor,blockHash:hash};await second.gateway.setPin(other);
  expect((await second.call('eth_getStorageAt',[account,'0x0',block])).error?.message).toBe('rpc_budget_exhausted');
});
it('rejects latest, omitted, future, wrong block/hash state reads and moving tags before upstream admission',async()=>{
  const h=await harness();
  for(const selector of ['latest','pending','safe','finalized',undefined,'0x0',{blockHash:hash,requireCanonical:true},{blockHash:cursor.blockHash}, {blockHash:cursor.blockHash,blockNumber:block,requireCanonical:true}]) {
    expect((await h.call('eth_getStorageAt',[account,'0x0',selector])).error?.message).toBe('fork_unpinned_read');
  }
  for(const selector of ['latest','pending',`0x${(BigInt(cursor.blockNumber)+1n).toString(16)}`])expect((await h.call('eth_getBlockByNumber',[selector,false])).error).toBeDefined();
  expect(h.paid).not.toHaveBeenCalled();
  expect((await h.call('eth_getStorageAt',[account,'0x0',{blockHash:cursor.blockHash,requireCanonical:true}])).result).toBe('0x01');
});
it('caps disk bytes, evicts oldest records, does not cache failed attempts, and redacts arbitrary provider text',async()=>{
  const h=await harness({},undefined,1024);
  h.paid.mockResolvedValue(`0x${'ab'.repeat(300)}`);
  for(const slot of ['0x0','0x1','0x2'])await h.call('eth_getStorageAt',[account,slot,block]);
  expect(Buffer.byteLength(await readFile(join(h.dir,'cache.json'),'utf8'))).toBeLessThanOrEqual(1024);
  const before=h.paid.mock.calls.length;await h.call('eth_getStorageAt',[account,'0x0',block]);expect(h.paid.mock.calls.length).toBe(before+1);
  h.paid.mockRejectedValue(new Error('https://rpc.invalid/path?key=sample-provider-key sample-response-secret'));
  for(let i=0;i<2;i++)expect((await h.call('eth_getStorageAt',[account,'0xff',block])).error?.message).toBe('fork_upstream_unavailable');
  await h.meter.summary();const output=h.logs.join('\n');
  for(const secret of ['https://','sample-provider-key','sample-response-secret'])expect(output).not.toContain(secret);
  expect(h.publicSend).not.toHaveBeenCalled();
});
it('serializes batch duplicates, isolates cache by pin, and verifies chain and cursor before caching headers',async()=>{
  const h=await harness();const request={jsonrpc:'2.0',method:'eth_getCode',params:[account,block]};
  await h.gateway.dispatch([{...request,id:1},{...request,id:2}]);expect(h.paid).toHaveBeenCalledTimes(1);
  h.paid.mockResolvedValue({number:block,hash,timestamp:'0x0'});
  expect((await h.call('eth_getBlockByNumber',[block,false])).error?.message).toBe('fork_pin_mismatch');
  h.paid.mockResolvedValue('0x1');expect((await h.call('eth_chainId')).error?.message).toBe('fork_chain_mismatch');
});
it('uses the same offline HTTP handler for JSON-RPC batches and refuses origins and oversized inputs',async()=>{
  const h=await harness();let output='',status=200;
  const res={setHeader:vi.fn(),writeHead:(code:number)=>{status=code;},end:(data:string)=>{output=data;}} as unknown as ServerResponse;
  const req=Object.assign(Readable.from([JSON.stringify([{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}])]),{method:'POST',url:'/',headers:{}}) as IncomingMessage;
  await h.gateway.handle(req,res);expect(JSON.parse(output)[0].result).toBe('0x1237');
  await h.gateway.handle(Object.assign(Readable.from([]),{method:'POST',url:'/',headers:{origin:'https://example.invalid'}}) as IncomingMessage,res);expect(status).toBe(403);
  await h.gateway.handle(Object.assign(Readable.from(['x'.repeat(1024*1024+1)]),{method:'POST',url:'/',headers:{}}) as IncomingMessage,res);expect(status).toBe(400);
});
it('resets through the pinned loopback gateway between serialized cases, and releases the lease after failure',async()=>{
  const h=await harness(),sequence:string[]=[];
  const rpc={request:vi.fn(async(r:{method:string;params:readonly unknown[]})=>{sequence.push(r.method);expect(r.params).toEqual([{forking:{jsonRpcUrl:'http://127.0.0.1:9545',blockNumber:Number(cursor.blockNumber)}}]);return null;})};
  const reset=gatewayReset(rpc,h.gateway,'http://127.0.0.1:9545'),lease=new SerializedMeteredForkLease(rpc,reset);
  await Promise.all([lease.withExclusive(async(_,r)=>{await r(cursor);sequence.push('case1');throw new Error('fixture');}).catch(()=>{}),lease.withExclusive(async(_,r)=>{await r(cursor);sequence.push('case2');})]);
  expect(sequence).toEqual(['anvil_reset','case1','anvil_reset','case2']);
  for(const url of ['https://127.0.0.1:9545','http://rpc.invalid','http://demo-account:sample-key@127.0.0.1:9545','http://127.0.0.1:9545/?key=sample-key'])expect(()=>localForkRpc(url)).toThrow('loopback');
});
