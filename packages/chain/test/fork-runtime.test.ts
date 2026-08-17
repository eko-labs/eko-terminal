import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { cursor } from './reference-fixtures.js';
const mocks=vi.hoisted(()=>({spawn:vi.fn(),listen:vi.fn(),meterClose:vi.fn(async()=>{}),listenerClose:vi.fn(async()=>{}),setPin:vi.fn(async()=>{}),create:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn}));
vi.mock('../src/rpc/clients.js',()=>({createMeteredClients:mocks.create}));
vi.mock('../src/simulation/fork-gateway.js',()=>({MeteredForkGateway:class {setPin=mocks.setPin;snapshot=()=>({upstreamRequestUnits:0});},listenForkGateway:mocks.listen}));
import { startForkRuntime } from '../src/simulation/fork-runtime.js';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
const env={RPC_HTTP_URL:'https://rpc.invalid/?key=sample-key',RPC_SESSION_BUDGET:'20'};
function setup() {
  const child=Object.assign(new EventEmitter(),{kill:vi.fn(()=>{queueMicrotask(()=>child.emit('exit',0));return true;})});
  mocks.spawn.mockReturnValue(child);
  mocks.listen.mockResolvedValue({url:'http://127.0.0.1:9545',close:mocks.listenerClose});
  mocks.create.mockReturnValue({forkArchive:{request:vi.fn()},meter:{close:mocks.meterClose,usage:async()=>({sessionUnits:0})}});
  const fetch=vi.fn(async(_url:unknown,_init?:RequestInit)=>({ok:true,json:async()=>({result:'0x1237'})}));vi.stubGlobal('fetch',fetch);
  return {child,fetch};
}
it('owns one loopback Anvil, only resets through the gateway, and shuts down once',async()=>{
  const {child,fetch}=setup();const runtime=await startForkRuntime(env,cursor,{cacheDir:'fixture-cache'});
  expect(mocks.spawn).toHaveBeenCalledWith('anvil',['--host','127.0.0.1','--port','8545','--chain-id','4663','--silent'],{stdio:'ignore'});
  await runtime.lease.withExclusive(async(_,reset)=>{await reset(cursor);});
  const requests=fetch.mock.calls.map((args)=>JSON.parse((args[1] as RequestInit).body as string));
  expect(requests.find(r=>r.method==='anvil_reset').params).toEqual([{forking:{jsonRpcUrl:'http://127.0.0.1:9545',blockNumber:100}}]);
  expect(JSON.stringify(mocks.spawn.mock.calls)+JSON.stringify(requests)).not.toContain('sample-key');
  await runtime.close();await runtime.close();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');expect(mocks.listenerClose).toHaveBeenCalledTimes(1);expect(mocks.meterClose).toHaveBeenCalledTimes(1);
});
it('cleans up server and meter after Anvil spawn failure without reading an existing process',async()=>{
  const {child,fetch}=setup();mocks.spawn.mockImplementation(()=>{queueMicrotask(()=>child.emit('error',new Error('fixture spawn failure')));return child;});
  await expect(startForkRuntime(env,cursor,{cacheDir:'fixture-cache'})).rejects.toThrow('runtime unavailable');
  expect(fetch).not.toHaveBeenCalled();expect(mocks.listenerClose).toHaveBeenCalledTimes(1);expect(mocks.meterClose).toHaveBeenCalledTimes(1);
});
it('requires finite session budget and paid configuration before creating a provider or socket',async()=>{
  for(const bad of [{},{RPC_HTTP_URL:env.RPC_HTTP_URL},{...env,RPC_SESSION_BUDGET:'Infinity'}])await expect(startForkRuntime(bad,cursor,{cacheDir:'fixture-cache'})).rejects.toThrow();
  expect(mocks.create).not.toHaveBeenCalled();expect(mocks.spawn).not.toHaveBeenCalled();
});
it('waits locally for Anvil to mine, never polling the receipt upstream, and sends no priority fee',async()=>{
  const { sendAndMine } = await import('../src/simulation/anvil.js');
  let polls=0;const seen:string[]=[];
  const rpc={request:async(r:{method:string;params:unknown[]})=>{seen.push(r.method);
    if(r.method==='eth_sendTransaction'){expect((r.params[0] as {maxPriorityFeePerGas:string}).maxPriorityFeePerGas).toBe('0x0');return `0x${'cd'.repeat(32)}`;}
    if(r.method==='eth_getTransactionByHash')return ++polls<3?{blockNumber:null}:{blockNumber:'0x5'};
    if(r.method==='eth_getTransactionReceipt')return {status:'0x1'};
    throw new Error('unexpected');}};
  const out=await sendAndMine(rpc as never,{from:`0x${'01'.repeat(20)}`});
  expect(out.receipt).toEqual({status:'0x1'});expect(polls).toBe(3);
  expect(seen.filter(m=>m==='eth_getTransactionReceipt')).toHaveLength(1);
  const stuck={request:async(r:{method:string})=>r.method==='eth_sendTransaction'?`0x${'cd'.repeat(32)}`:{blockNumber:null}};
  await expect(sendAndMine(stuck as never,{},250)).rejects.toThrow('Fork transaction not mined');
});
