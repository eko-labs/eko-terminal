import { expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { PonsReferenceSimulation, ponsMatchedFidelity, ponsCall, ponsLegs, type PonsInput, type PonsForkMatch } from '../src/simulation/pons.js';
import { ponsBuy, ponsSell, ponsCharges, ponsLocalRoundTrip, type PonsCurveState } from '../src/simulation/pons-math.js';
import { acquiredMatches } from '../src/simulation/fork-check-cli.js';
import { SerializedMeteredForkLease } from '../src/simulation/anvil.js';
import { referenceTokenAbi } from '../src/simulation/v3.js';
import type { AnvilRpc } from '../src/simulation/types.js';
import { EKO_PROBE_RUNTIME } from '../src/simulation/probe-runtime.js';
import { address, hash, cursor } from './reference-fixtures.js';
const uint=(n:bigint)=>encodeAbiParameters([{type:'uint256'}],[n]);
const base:PonsCurveState={tokens:1000000n,realQuote:100000n,virtualQuote:100000n,reservedTokens:500000n};
const terms=[{kind:'ordinary' as const,base:'gross' as const,bps:100n,fixedWei:0n},{kind:'creator' as const,base:'gross' as const,bps:400n,fixedWei:0n}];
const staticCall=(selector:Hex,words:('amount'|'recipient'|Hex)[]=[])=>({target:address(11),selector,words});
function input():PonsInput {return {cursor,sizeUsd:100,sizeWei:1000n,delaySec:0,matches:[],route:{venue:'pons_curve',id:'fixture-curve',coin:address(10),curve:address(11),spender:address(11),origin:'fixture',
 verification:{blockHash:cursor.blockHash as Hex,profileHash:hash('profile'),stateFingerprint:hash('state'),sourceRevision:hash('source'),evidenceIds:[hash('route')],reviewed:true,pins:[10,11].map(n=>({address:address(n),codeHash:keccak256('0x1234')}))},
 execution:{buy:staticCall('0x11111111',['amount','recipient']),sell:staticCall('0x22222222',['amount','recipient'])},
 stateReads:{tokens:staticCall('0x33333333'),realQuote:staticCall('0x44444444'),virtualQuote:staticCall('0x55555555'),reservedTokens:staticCall('0x66666666')},
 buyTerms:terms,sellTerms:terms,recipients:[address(12)],exemptions:{accounts:[],complete:true,evidenceIds:[hash('exemptions')]},limits:{maxBuyWei:null,maxWalletTokens:null,evidenceIds:[hash('limits')]},entryLimitSelectors:['0xaaaaaaaa'],sellCapacitySelectors:['0xbbbbbbbb'],cooldown:{seconds:0,evidenceIds:[hash('cooldown')]},decayEndSec:'1000',feeAccounting:{gasIncludesL1:false,evidenceIds:[hash('network')]},contractClass:'bw-probe'}};}
function fixture(i:PonsInput,mode:'ok'|'cap'|'blocked'|'contract'|'provider'|'cooldown'='ok',accounting:'payout'|'accrual'|'mix'|'negative'='payout') {
 let accrued=100n,buyback=20n;
 const charge=(total:bigint)=>{const paid=accounting==='payout'?total:accounting==='mix'?total/2n:accounting==='negative'?total+1n:0n;
   accrued+=total-paid;buyback+=total/5n;balances.set(address(12),(balances.get(address(12))??0n)+paid);};
 let state={...base},now=1000n,tokens=0n,allowance=0n,resetCount=0,txOk=true,revert:Hex='0x',txCount=0;
 const balances=new Map<string,bigint>(),codes=new Map<string,Hex>(),calls:{method:string;params:readonly unknown[]}[]=[];
 const rpc:AnvilRpc={request:async r=>{
  calls.push(r);if(mode==='provider')throw new Error('credential-bearing provider error');
  if(r.method==='eth_getBlockByNumber')return {hash:cursor.blockHash,timestamp:`0x${now.toString(16)}`};
  if(r.method==='eth_chainId')return '0x1237';
  if(r.method==='eth_getCode')return [address(10),address(11)].includes(r.params[0] as Hex)?'0x1234':codes.get(r.params[0] as string)??'0x';
  if(r.method==='eth_getBalance')return `0x${(balances.get(r.params[0] as string)??0n).toString(16)}`;
  if(r.method==='anvil_setBalance'){balances.set(r.params[0] as string,BigInt(r.params[1] as string));return null;}
  if(r.method==='anvil_setCode'){codes.set(r.params[0] as string,r.params[1] as Hex);return null;}
  if(r.method==='evm_increaseTime'){now+=BigInt(r.params[0] as number);return null;}
  if(r.method==='eth_call') {
    const tx=r.params[0] as {to:Hex;data:Hex};
    if(tx.to===i.route.coin){const d=decodeFunctionData({abi:referenceTokenAbi,data:tx.data});return uint(d.functionName==='balanceOf'?tokens:allowance);}
    if(tx.data==='0x77777777')return uint(accrued);
    if(tx.data==='0x88888888')return uint(buyback);
    const key=Object.entries(i.route.stateReads).find(([,c])=>c.selector===tx.data.slice(0,10))![0] as keyof PonsCurveState;
    return uint(state[key]);
  }
  if(r.method==='eth_sendTransaction') {
    const tx=r.params[0] as {from:Hex;to:Hex;data:Hex;value:Hex};
    let account=tx.from,to=tx.to,data=tx.data;
    if(codes.has(tx.to)) {account=tx.to;const abi=[{type:'function',name:'execute',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'},{type:'bytes'}],outputs:[{type:'bytes'}]}] as const;
      const d=decodeFunctionData({abi,data});to=d.args[0];data=d.args[2];}
    txOk=true;revert='0x';
    if(to.toLowerCase()===i.route.coin.toLowerCase()){const d=decodeFunctionData({abi:referenceTokenAbi,data});if(d.functionName==='approve')allowance=d.args[1];}
    else if(data.startsWith('0x11111111')) {
      if(mode==='cap'){txOk=false;revert='0xaaaaaaaa';}else{const p=ponsBuy(state,i.sizeWei,i.route.buyTerms);tokens=p.tokens;state=p.state;balances.set(account,balances.get(account)!-p.spent);charge(p.fees.total);}
    }else if(data.startsWith('0x22222222')) {
      if(mode==='blocked'||mode==='contract'&&codes.has(account)||mode==='cooldown'&&now<1003n){txOk=false;revert='0xcccccccc';}
      else{const p=ponsSell(state,tokens,i.route.sellTerms);if(!p.capacity)throw new Error('fixture capacity');state=p.state;tokens=0n;allowance=0n;balances.set(account,balances.get(account)!+p.returned);charge(p.fees.total);}
    }
    balances.set(tx.from,balances.get(tx.from)!-3n);txCount++;return hash(`tx-${resetCount}-${txCount}`);
  }
  if(r.method==='eth_getTransactionByHash')return {blockNumber:'0x1'};
  if(r.method==='eth_getTransactionReceipt')return {status:txOk?'0x1':'0x0',gasUsed:'0x1',effectiveGasPrice:'0x2',l1Fee:'0x1'};
  if(r.method==='debug_traceTransaction')return {output:revert};
  if(['evm_mine','anvil_impersonateAccount','anvil_stopImpersonatingAccount'].includes(r.method))return null;
  throw new Error(`Unexpected fixture method ${r.method}`);
 }};
 const lease=new SerializedMeteredForkLease(rpc,async()=>{resetCount++;accrued=100n;buyback=20n;state={...base};now=1000n;tokens=i.sellOnly?500n:0n;allowance=0n;balances.clear();codes.clear();});
 return {sim:new PonsReferenceSimulation(lease),calls,resets:()=>resetCount};
}
it('measures Q/R, exact acquired approval, charge/payout reconciliation, network/L1 and isolated classes',async()=>{
 const i=input(),f=fixture(i),r=await f.sim.run(i),p=ponsLocalRoundTrip(base,i.sizeWei,terms,terms);
 expect(p.sell.capacity).toBe(true);if(!p.sell.capacity)return;
 expect(r.status).toBe('ok');expect(r.complete).toBe(false);expect(r.observations).toHaveLength(4);expect(f.resets()).toBe(5);
 for(const o of r.observations){expect(o.spent).toBe(p.buy.spent.toString());expect(o.returned).toBe(p.sell.returned.toString());expect(o.fidelity).toBe(true);expect(o.allowanceAfterApproval).toBe(o.tokens);expect(o.entryNetworkWei).toBe('3');expect(o.exitNetworkWei).toBe('6');expect(o.entryL1Wei).toBe('1');expect(o.exitL1Wei).toBe('2');expect(o.purchasedStorageRetained).toBe(true);}
 expect(new Set(r.observations.map(o=>o.account)).size).toBe(4);
 expect(acquiredMatches(r)).toEqual([]);
 const acquired=acquiredMatches({...r,origin:'measured'});expect(acquired).toHaveLength(4);
 expect(new Set(acquired.map(m=>m.caseId)).size).toBe(2);
 expect(acquired.every(m=>m.expectedSpent===m.actualSpent && m.expectedReturned===m.actualReturned)).toBe(true);
 expect(f.calls.some(c=>/setStorage|stateOverride/.test(c.method))).toBe(false);
});
it('keeps entry caps separate, refuses privileged identities, and censors provider errors',async()=>{
 const i=input(),r=await fixture(i,'cap').sim.run(i);expect(r.entryLimitedClasses).toEqual(['eoa','contract']);expect(r.referenceEntryUnavailable).toBe(true);expect(r.complete).toBe(false);expect(r.honeypotConfirmed).toBe(false);
 const p=await fixture(i,'provider').sim.run(i);expect(p.status).toBe('provider_failure');expect(JSON.stringify(p)).not.toContain('credential-bearing');
 const clean=await fixture(i).sim.run(i);i.route.exemptions.accounts=[clean.observations[0].account];expect((await fixture(i).sim.run(i)).status).toBe('unsupported');
});
it('records token/class failures and unresolved cooldown without confirming a honeypot',async()=>{
 const i=input();const blocked=await fixture(i,'blocked').sim.run(i);expect(blocked.status).toBe('exit_restricted');expect(blocked.honeypotConfirmed).toBe(false);
 const classes=await fixture(i,'contract').sim.run(i);expect(classes.observations.map(o=>o.status)).toEqual(['ok','ok','exit_restricted','exit_restricted']);
 i.route.cooldown=null;expect((await fixture(i,'blocked').sim.run(i)).status).toBe('cooldown_unresolved');
});
it('retains purchased state for a delayed sell and records the first failed attempt',async()=>{
 const i=input();i.route.cooldown={seconds:3,evidenceIds:[hash('verified-delay')]};
 expect((await fixture(i,'cooldown').sim.run(i)).status).toBe('cooldown_unresolved');
 i.delaySec=3;const r=await fixture(i,'cooldown').sim.run(i);expect(r.status).toBe('ok');expect(r.observations.every(o=>o.exitTimestampSec==='1003'&&o.delaySec===3)).toBe(true);expect(r.complete).toBe(false);
});
it('sell-only uses held quantity and never fabricates Q or a round trip',async()=>{
 const i=input();i.sellOnly={account:address(70),accountClass:'eoa',quantity:500n};const f=fixture(i),r=await f.sim.run(i),o=r.observations[0];
 expect(r.status).toBe('ok');expect(o.tokens).toBe('500');expect(o.spent).toBe('0');expect(o.venueRoundTripCostPct).toBeNull();expect(o.allInRoundTripCostPct).toBeNull();expect(o.existingPositionDiscountPct).not.toBeNull();expect(o.purchasedStorageRetained).toBe(false);expect(f.calls.some(c=>c.method==='anvil_setCode')).toBe(false);
});
it('handles refund caps, sequential temporary charges and severe fixed cost as costs',async()=>{
 const capped=ponsBuy(base,1000000n,terms);expect(capped.refund).toBeGreaterThan(0n);expect(capped.tokens).toBe(500000n);expect(capped.state.realQuote-base.realQuote).toBe(200000n);
 expect(ponsCharges(10000n,[{kind:'temporary',base:'gross',bps:9900n,fixedWei:0n},{kind:'ordinary',base:'remaining',bps:100n,fixedWei:0n}])).toMatchObject({temporary:9900n,ordinary:1n,total:9901n});
 const i=input();i.route.sellTerms=[{kind:'ordinary',base:'gross',bps:0n,fixedWei:900n}];const r=await fixture(i).sim.run(i);expect(r.status).toBe('ok');expect(r.observations[0].venueRoundTripCostPct).toBeGreaterThan(90);expect(r.honeypotConfirmed).toBe(false);
});
it('requires measured diverse matches per size/class and rejects debit, proceeds and all-in harm reversals',()=>{
 const i=input();const matches:PonsForkMatch[]=['eoa','contract'].flatMap(accountClass=>Array.from({length:30},(_,n)=>({id:hash(`${accountClass}-${n}`),venue:'pons_curve',sizeUsd:100,accountClass:accountClass as 'eoa'|'contract',caseId:`case-${n}`,expectedSpent:'1000',actualSpent:'1000',expectedReturned:'800',actualReturned:'800',expectedBlocked:false,actualBlocked:false,origin:'fixture',sourceRevision:i.route.verification.sourceRevision,modelVersion:'pons-output-floor-1',delaySec:0,evidenceIds:[hash('synthetic-proof')],expectedAllInEntry:'1003',actualAllInEntry:'1003',expectedNetExit:'794',actualNetExit:'794'})));
 expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision)).toEqual([]);
 // Synthetic measured envelopes test the gate, never constitute acquisition evidence.
 for(const m of matches)m.origin='measured';expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision)).toHaveLength(60);
 expect(ponsMatchedFidelity(matches,1000,i.route.verification.sourceRevision)).toEqual([]);
 expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision,3)).toEqual([]);
 matches[0].expectedReturned='780';expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision)).toEqual([]);matches[0].expectedReturned='800';
 matches[0].actualSpent='999';expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision)).toEqual([]);matches[0].actualSpent='1000';
 matches[0].expectedNetExit='700';expect(ponsMatchedFidelity(matches,100,i.route.verification.sourceRevision)).toEqual([]);
});
it('requires profile/code/config bindings and preserves recipient and raw static arguments',async()=>{
 const i=input();expect(ponsCall(i.route.execution.sell,address(70),123n).slice(10,74)).toBe('7b'.padStart(64,'0'));
 const legs=ponsLegs(i.route,address(70),1000n);expect(legs.buy.value).toBe(1000n);expect(legs.sell.patch).toBe(true);expect(legs.sell.amountOffset).toBe(4n);expect(legs.sellWithAmount(123n)).toBe(ponsCall(i.route.execution.sell,address(70),123n));
 expect(BigInt(`0x${legs.sell.data.slice(10,74)}`)).toBe(0n);
 i.route.verification.reviewed=false;expect((await fixture(i).sim.run(i)).status).toBe('unsupported');
});

it('independently executes the $1k band and refuses unsupported successor/pins',async()=>{
 const i=input();i.sizeUsd=1000;i.sizeWei=10000n;const r=await fixture(i).sim.run(i);expect(r.status).toBe('ok');expect(r.observations.every(o=>o.spent==='10000')).toBe(true);expect(r.unsupportedSuccessors).toEqual(['pons_v4']);
 i.route.verification.pins[0].codeHash=hash('changed-code');expect((await fixture(i).sim.run(i)).status).toBe('provider_failure');
});

it.each(['accrual','mix','payout'] as const)('reconciles charges with %s accounting and records independent deltas',async accounting=>{
 const i=input();i.route.accruals=[staticCall('0x77777777')];
 const r=await fixture(i,'ok',accounting).sim.run(i);expect(r.status).toBe('ok');
 for(const o of r.observations){
   expect(BigInt(o.buyPayouts[0].units)+BigInt(o.buyAccruals[0].units)).toBe(BigInt(o.buyChargeWei!));
   expect(BigInt(o.sellPayouts[0].units)+BigInt(o.sellAccruals[0].units)).toBe(BigInt(o.sellChargeWei!));
   expect(o.fidelity).toBe(true);expect(o.buyTaxPct).not.toBeNull();expect(o.sellTaxPct).not.toBeNull();
 }
});
it('rejects negative accrual deltas even when payouts plus deltas sum to the charge',async()=>{
 const i=input();i.route.accruals=[staticCall('0x77777777')];
 const r=await fixture(i,'ok','negative').sim.run(i);expect(r.status).toBe('fidelity_mismatch');
 expect(r.observations[0].buyAccruals[0].units).toBe('-1');expect(r.observations[0].buyTaxPct).toBeNull();
});
it('does not count a buyback earmark twice and rejects duplicate or argument-bearing accrual getters',async()=>{
 const i=input();i.route.accruals=[staticCall('0x77777777')];
 expect((await fixture(i,'ok','accrual').sim.run(i)).status).toBe('ok');
 i.route.accruals.push(staticCall('0x88888888'));
 expect((await fixture(i,'ok','accrual').sim.run(i)).status).toBe('fidelity_mismatch');
 i.route.accruals=[staticCall('0x77777777'),staticCall('0x77777777')];
 expect((await fixture(i).sim.run(i)).status).toBe('unsupported');
 i.route.accruals=[staticCall('0x77777777',['amount'])];
 expect((await fixture(i).sim.run(i)).status).toBe('unsupported');
});
