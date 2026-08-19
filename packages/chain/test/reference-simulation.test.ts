import { describe,it,expect,vi } from 'vitest';
import { decodeFunctionData,encodeAbiParameters,toHex,type Hex } from 'viem';
import type { createMeteredClients } from '../src/rpc/clients.js';
import { RpcGuardError } from '../src/rpc/metered.js';
import { V3ReferenceSimulation, matchedFidelity, percent, referenceDigest } from '../src/simulation/reference.js';
import { referenceRouterAbi,v3Legs } from '../src/simulation/v3.js';
import { input,deep,matches,probeOutput,cursor,route } from './reference-fixtures.js';
function simulator(output=probeOutput(),confirmation:ReturnType<typeof deep>|null=deep()) {
  const request=vi.fn(async ({method,params}:{method:string;params:unknown[]})=>{
    if(method==='eth_getBlockByNumber')return {hash:cursor.blockHash,timestamp:toHex(BigInt(cursor.timestampSec))};
    if(method==='eth_getCode')return '0x';
    if(method==='eth_call')return encodeAbiParameters([{type:'uint256'}],[1000n]);
    if(method==='debug_traceCall')return {output};
    throw new Error('Unexpected method');
  });
  const clients={archive:{request}} as unknown as Pick<ReturnType<typeof createMeteredClients>,'archive'>;
  return {request,sim:new V3ReferenceSimulation(clients,confirmation?{confirm:vi.fn(async()=>confirmation)}:undefined)};
}
describe('v3 reference simulations (synthetic transport, no live evidence)',()=>{
  it('patches the nested router amount slot exactly and never swaps a guessed balance',()=>{
    const legs=v3Legs(route,route.coin,1000n);
    const offset=Number(legs.sell.amountOffset)*2+2;
    const patched=`${legs.sell.data.slice(0,offset)}${toHex(123n,{size:32}).slice(2)}${legs.sell.data.slice(offset+64)}` as Hex;
    const multicall=decodeFunctionData({abi:referenceRouterAbi,data:patched});
    expect(multicall.functionName).toBe('multicall');
    if(multicall.functionName!=='multicall')throw new Error('Invalid fixture');
    const swap=decodeFunctionData({abi:referenceRouterAbi,data:multicall.args[1][0]});
    expect(swap.functionName).toBe('exactInputSingle');
    if(swap.functionName!=='exactInputSingle')throw new Error('Invalid fixture');
    expect(swap.args[0].amountIn).toBe(123n);
    expect(swap.args[0].amountOutMinimum).toBe(0n);
  });
  it('pins every read and overrides only the probe code/native funding',async()=>{
    const {sim,request}=simulator();const result=await sim.run(input);
    expect(result).toMatchObject({status:'ok',complete:true,exitCostPct:1,buyTaxPct:0,sellTaxPct:0,honeypotConfirmed:false});
    expect(result.traceDigest).toBe(referenceDigest(result.trace));
    const params=request.mock.calls.find(([r])=>r.method==='debug_traceCall')![0].params;
    expect(params[1]).toBe('0x64');
    const overrides=(params[2] as {stateOverrides:Record<string,unknown>}).stateOverrides;
    expect(Object.keys(overrides)).toHaveLength(1);
    expect(Object.values(overrides)[0]).toEqual({code:expect.stringMatching(/^0x/),balance:toHex(1000n+10n**18n)});
  });
  it('refuses completion without actual fork confirmations or fidelity matches',async()=>{
    expect(await simulator(probeOutput(),null).sim.run({...input,matches:[]})).toMatchObject({complete:false,status:'fork_evidence_missing'});
    expect(await simulator().sim.run({...input,matches:[]})).toMatchObject({complete:false,status:'fork_evidence_missing'});
  });
  it('confirms blocked sells on distinct valid acquired EOAs',async()=>{
    const result=await simulator(probeOutput(1000n,990n,0n,true,false,'0x1234'),deep({sellOk:false,returned:'0',revert:'0x1234'})).sim.run(input);
    expect(result).toMatchObject({status:'blocked_exit',complete:true,honeypotConfirmed:true,exitCostPct:100});
  });
  it('uses independent no-tax sell output for near-zero return, not original invested size',async()=>{
    expect(await simulator(probeOutput(1000n,990n,1n),deep({returned:'1'})).sim.run(input)).toMatchObject({honeypotConfirmed:true,status:'blocked_exit'});
    expect(await simulator(probeOutput(1000n,1n,1n),deep({returned:'1',quotedSell:'1'})).sim.run(input)).toMatchObject({honeypotConfirmed:false,status:'ok',exitCostPct:99.9});
  });
  it('distinguishes contract restrictions, unknown cooldown and entry cap',async()=>{
    expect(await simulator(probeOutput(1000n,990n,0n,true,false),deep()).sim.run(input)).toMatchObject({status:'contract_restricted',honeypotConfirmed:false});
    expect(await simulator(probeOutput(1000n,990n,0n,true,false),deep()).sim.run({...input,route:{...route,cooldown:null}})).toMatchObject({status:'cooldown_unresolved',complete:false});
    expect(await simulator(probeOutput(0n,0n,0n,false,false,'0x12345678')).sim.run(input)).toMatchObject({status:'entry_limited',honeypotConfirmed:false,exitCostPct:null});
    expect(await simulator(probeOutput(0n,0n,0n,false,false,'0xabcdef01')).sim.run(input)).toMatchObject({status:'entry_unavailable',complete:false});
  });
  it('measures fee-on-transfer taxes and uses bigint display arithmetic',async()=>{
    expect(await simulator(probeOutput(900n,891n,800n),deep({tokens:'900',quotedSell:'891',returned:'800'})).sim.run(input)).toMatchObject({buyTaxPct:10,exitCostPct:20});
    expect(percent(10n**80n,10n**80n)).toBe(100);
  });
  it('classifies RPC failure and mixed canonical states as unavailable, preserving stop signals',async()=>{
    const {sim,request}=simulator();request.mockRejectedValueOnce(new Error('fixture failure'));
    expect(await sim.run(input)).toMatchObject({status:'provider_failure',complete:false,honeypotConfirmed:false});
    request.mockResolvedValueOnce({hash:'0x00',timestamp:'0x3e8'});
    expect(await sim.run(input)).toMatchObject({status:'provider_failure',complete:false});
    request.mockRejectedValueOnce(new RpcGuardError('rpc_session_budget_reached'));
    await expect(sim.run(input)).rejects.toThrow('rpc_session_budget_reached');
  });
  it('requires 30 distinct matched cases per class and exact raw debit',()=>{
    expect(matchedFidelity(matches(),100)).toHaveLength(60);
    expect(matchedFidelity(matches().slice(1),100)).toEqual([]);
    const bad=matches();bad[0].actualSpent='1001';expect(matchedFidelity(bad,100)).toEqual([]);
    const reverse=matches();reverse[0].actualBlocked=true;expect(matchedFidelity(reverse,100)).toEqual([]);
  });
});

it('patches multi-hop USDG routes in both router and quoter calldata',()=>{
  const multi={...route,hops:[{tokenOut:`0x${'31'.repeat(20)}` as Hex,fee:500 as const},{tokenOut:route.coin,fee:3000 as const}]};
  const legs=v3Legs(multi,route.coin,1000n),offset=Number(legs.sell.amountOffset)*2+2;
  const patched=`${legs.sell.data.slice(0,offset)}${toHex(456n,{size:32}).slice(2)}${legs.sell.data.slice(offset+64)}` as Hex;
  const call=decodeFunctionData({abi:referenceRouterAbi,data:patched});
  if(call.functionName!=='multicall')throw new Error('Invalid fixture');
  const swap=decodeFunctionData({abi:referenceRouterAbi,data:call.args[1][0]});
  if(swap.functionName!=='exactInput')throw new Error('Invalid fixture');
  expect(swap.args[0].amountIn).toBe(456n);
  expect(swap.args[0].path.slice(2,42)).toBe(route.coin.slice(2));
});
