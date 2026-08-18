// Synthetic RPC execution only. Measured-origin envelopes exercise acquisition contracts, not route acceptance.
import { expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { PonsActualOrderProbe, type PonsActualOrderRoute } from '../src/execution/pons-actual.js';
import { ponsCall } from '../src/simulation/pons.js';
import { SerializedMeteredForkLease } from '../src/simulation/anvil.js';
import { referenceTokenAbi } from '../src/simulation/v3.js';
import { referenceDigest } from '../src/simulation/reference.js';
import type { ActualOrderBinding, ActualOrderState } from '@eko/shared';
import type { AnvilRpc } from '../src/simulation/types.js';
import { address, hash, cursor } from './reference-fixtures.js';
const word=toHex(0n,{size:32});
const readCall=(target:ReturnType<typeof address>,selector:Hex)=>({target,selector,words:[]});
function fixture(side:'buy'|'sell'='buy',mode:'ok'|'delegated'|'missing_l1'|'blocked'|'changed_code'|'changed_state'|'provider'='ok') {
  const clock=Number(BigInt(cursor.timestampSec)*1000n),coin=address(10),curve=address(11),account=address(70);
  const route:PonsActualOrderRoute={depthUsdLower:100000,acceptedEvidenceIds:[hash('accepted-synthetic')],
    curveState:{tokens:1000000n,realQuote:100000n,virtualQuote:100000n,reservedTokens:500000n},
    quoteUsd:{numerator:'100000',denominator:'1',evidenceIds:[hash('usd-synthetic')]},
    route:{venue:'pons_curve',id:'fixture-actual',coin,curve,spender:curve,origin:'measured',
      verification:{blockHash:cursor.blockHash as Hex,profileHash:hash('profile'),stateFingerprint:hash('state'),sourceRevision:hash('source'),
        evidenceIds:[hash('code')],reviewed:true,pins:[coin,curve].map(a=>({address:a,codeHash:keccak256('0x1234')}))},
      execution:{buy:{target:curve,selector:'0x59a87bc1',words:['amount',word,'recipient']},sell:{target:curve,selector:'0xd04c6983',words:['amount',word,'recipient']}},
      stateReads:{tokens:readCall(curve,'0x11111111'),realQuote:readCall(curve,'0x22222222'),virtualQuote:readCall(curve,'0x33333333'),reservedTokens:readCall(curve,'0x44444444')},
      buyTerms:[],sellTerms:[],recipients:[],exemptions:{accounts:[],complete:true,evidenceIds:[hash('exemptions')]},
      limits:{maxBuyWei:null,maxWalletTokens:null,evidenceIds:[hash('limits')]},entryLimitSelectors:[],sellCapacitySelectors:[],
      cooldown:{seconds:0,evidenceIds:[hash('cooldown')]},decayEndSec:cursor.timestampSec,
      feeAccounting:{gasIncludesL1:false,evidenceIds:[hash('fees')]},contractClass:'bw-probe'} };
  const amount=side==='buy'?'1000':'100',trade={...route.route.execution[side],words:['amount',toHex(side==='buy'?99n:891n,{size:32}),'recipient'] as ('amount'|'recipient'|Hex)[]};
  const b:ActualOrderBinding={chainId:4663,account,recipient:account,coin,side,amountIn:amount,minOut:side==='buy'?'99':'891',slippageBps:100,cursor,
    routeFingerprint:referenceDigest(route.route),profileHash:route.route.verification.profileHash,stateFingerprint:route.route.verification.stateFingerprint,
    policyHash:hash('policy'),guardReceiptId:hash('guard'),tx:{chainId:4663,to:curve,data:ponsCall(trade,account,BigInt(amount)),value:side==='buy'?amount:'0'},
    approval:side==='buy'?null:{token:coin,spender:curve,amount,kind:'erc20',tx:{chainId:4663,to:coin,value:'0',data:encodeFunctionData({abi:referenceTokenAbi,functionName:'approve',args:[curve,BigInt(amount)]})}}};
  const state:ActualOrderState={observedAtMs:clock,criticalCheckedAtMs:clock,cursor,routeFingerprint:b.routeFingerprint,profileHash:b.profileHash,
    stateFingerprint:b.stateFingerprint,balanceHash:hash('balance'),feeHash:hash('fee'),controlHash:hash('control'),sourceRevision:hash('source'),
    semanticHash:hash('semantic'),policyHash:b.policyHash,guardReceiptId:b.guardReceiptId,routeAvailable:true};
  let native=100000n,tokens=side==='sell'?100n:500n,allowance=side==='sell'?100n:777n,ok=true,resets=0;
  const calls:{method:string;params:readonly unknown[]}[]=[],sent:{from:string;to:string;data:Hex;value:string}[]=[];
  const rpc:AnvilRpc={request:async r=>{
    calls.push(r);if(mode==='provider')throw new Error('private-provider-detail');
    if(r.method==='eth_getBlockByNumber')return {hash:cursor.blockHash,timestamp:toHex(BigInt(cursor.timestampSec))};
    if(r.method==='eth_chainId')return toHex(4663);
    if(r.method==='eth_getCode')return r.params[0]===account?(mode==='delegated'?'0xef01001234':'0x'):mode==='changed_code'?'0xabcd':'0x1234';
    if(r.method==='eth_getBalance')return toHex(native);
    if(r.method==='eth_call'){
      const tx=r.params[0] as {to:string;data:Hex};
      if(tx.to===coin){const d=decodeFunctionData({abi:referenceTokenAbi,data:tx.data});return encodeAbiParameters([{type:'uint256'}],[d.functionName==='balanceOf'?tokens:allowance]);}
      const key=Object.entries(route.route.stateReads).find(([,c])=>c.selector===tx.data)![0] as keyof typeof route.curveState;
      return encodeAbiParameters([{type:'uint256'}],[route.curveState[key]+(mode==='changed_state'?1n:0n)]);
    }
    if(r.method==='eth_sendTransaction'){
      const tx=r.params[0] as typeof sent[number];sent.push(tx);expect(tx.from).toBe(account);ok=true;
      if(tx.to===coin){const d=decodeFunctionData({abi:referenceTokenAbi,data:tx.data});if(d.functionName==='approve')allowance=d.args[1];}
      else if(tx.data.startsWith('0x59a87bc1')){tokens+=100n;native-=1000n;}
      else if(tx.data.startsWith('0xd04c6983')){if(mode==='blocked')ok=false;else{tokens-=100n;native+=900n;}}
      native-=3n;return hash(`tx-${sent.length}`);
    }
    if(r.method==='eth_getTransactionReceipt')return {status:ok?'0x1':'0x0',gasUsed:'0x1',effectiveGasPrice:'0x2',...(mode==='missing_l1'?{}:{l1Fee:'0x1'})};
    if(r.method==='debug_traceTransaction')return {output:'0x'};
    if(['anvil_impersonateAccount','anvil_stopImpersonatingAccount'].includes(r.method))return null;
    throw new Error(`Unexpected fixture method ${r.method}`);
  }};
  const lease=new SerializedMeteredForkLease(rpc,async()=>{resets++;native=100000n;tokens=side==='sell'?100n:500n;allowance=side==='sell'?100n:777n;});
  return {b,state,route,calls,sent,resets:()=>resets,probe:new PonsActualOrderProbe(lease,()=>route),clock};
}
it('uses actual account, exact bytes/size, preserves original holdings, approves acquired units and isolates reset',async()=>{
  const f=fixture(),q=await f.probe.observe(f.b,f.state,f.clock);
  expect(q).toMatchObject({status:'ok',mode:'round_trip',spent:'1000',returned:'900',tokens:'100',heldBefore:'500',allowanceBefore:'777',entryNetworkFee:'3',exitNetworkFee:'6',notionalUsd:100});
  expect(f.sent[0].data).toBe(f.b.tx.data);expect(f.sent[0].value).toBe(toHex(1000n));
  const a=decodeFunctionData({abi:referenceTokenAbi,data:f.sent[1].data});expect(a.args?.[1]).toBe(100n);
  expect(f.resets()).toBe(2);expect(f.calls.some(c=>/setBalance|setCode|setStorage|increaseTime/.test(c.method))).toBe(false);
  expect(q.evidenceIds).toHaveLength(3);
});
it('sell-only uses exactly held raw quantity with no buy or invented spent quote',async()=>{
  const f=fixture('sell'),q=await f.probe.observe(f.b,f.state,f.clock);
  expect(q).toMatchObject({status:'ok',mode:'sell_only',spent:'0',tokens:'100',heldBefore:'100',returned:'900',entryNetworkFee:'0',exitNetworkFee:'6',notionalUsd:90});
  expect(f.sent).toHaveLength(2);expect(f.sent.some(s=>s.data.startsWith('0x59a87bc1'))).toBe(false);
});
it.each(['delegated','missing_l1','blocked','changed_code','changed_state','provider'] as const)('fails closed for %s',async mode=>{
  const f=fixture('buy',mode),q=await f.probe.observe(f.b,f.state,f.clock);
  expect(q.status).toBe(mode==='delegated'?'unsupported':mode==='blocked'?'exit_restricted':'provider_failure');
  expect(q.evidenceIds).toEqual([]);expect(JSON.stringify(q)).not.toContain('private-provider-detail');
});
it('refuses fixture routes, missing acceptance, substituted calldata/target/value and arbitrary recipient paths',async()=>{
  for(const patch of [{tx:{...fixture().b.tx,data:'0xab' as Hex}},{tx:{...fixture().b.tx,to:address(99)}},
    {tx:{...fixture().b.tx,value:'1'}},{recipient:address(99)}]){
    const f=fixture();expect((await f.probe.observe({...f.b,...patch},f.state,f.clock)).status).toBe('unsupported');expect(f.sent).toEqual([]);
  }
  for(const kind of ['fixture','pending'] as const){const f=fixture();if(kind==='fixture')f.route.route.origin='fixture';else f.route.acceptedEvidenceIds=[];
    expect((await f.probe.observe(f.b,f.state,f.clock)).status).toBe('unsupported');expect(f.calls).toEqual([]);}
});

it('rounds pinned USD exposure upward and refuses quantities outside the exact conversion domain',async()=>{
  const f=fixture();f.route.quoteUsd.numerator='1';f.route.quoteUsd.denominator='3';
  expect((await f.probe.observe(f.b,f.state,f.clock)).notionalUsd).toBe(0.000334);
  const large=fixture();large.route.quoteUsd.numerator=(2n**100n).toString();
  expect((await large.probe.observe(large.b,large.state,large.clock)).status).toBe('unsupported');
  expect(large.sent).toEqual([]);
});
