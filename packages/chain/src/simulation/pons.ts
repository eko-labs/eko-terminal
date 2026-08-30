import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from 'viem';
import { GuardCursorSchema, type GuardCursor } from '@eko/shared';
import { referenceTokenAbi, type ProbeLeg } from './v3.js';
import { matchedFidelity, percent, referenceDigest } from './reference.js';
import { EKO_PROBE_RUNTIME } from './probe-runtime.js';
import { rpcStopReason } from '../rpc/metered.js';
import { sendAndMine } from './anvil.js';
import type { AnvilRpc, DeepEvidence, ForkMatch, MeteredForkLease, ReferenceSize } from './types.js';
import { ponsBuy, ponsLocalRoundTrip, ponsNoTaxSell, ponsSell, type PonsChargeTerm, type PonsCurveState } from './pons-math.js';
import { CHAIN_ID } from '@eko/shared';

export interface PonsStaticCall { target: Address; selector: Hex; words: ('amount' | 'recipient' | Hex)[] }
export interface PonsCurveRoute {
  venue: 'pons_curve'; id: string; coin: Address; curve: Address; spender: Address;
  origin: 'fixture' | 'measured';
  // TODO(spec): published executable ABI and integer rounding are absent locally; require reviewed supplied bindings and measured matches before completing a route.
  /** Supplied by 039/072 review, never inferred from the Pons brand or getter sums. */
  verification: { blockHash: Hex; profileHash: Hex; stateFingerprint: Hex; sourceRevision: Hex; evidenceIds: Hex[];
    pins: {address:Address;codeHash:Hex}[]; reviewed: boolean };
  execution: { buy: PonsStaticCall; sell: PonsStaticCall };
  stateReads: {tokens:PonsStaticCall;realQuote:PonsStaticCall;virtualQuote:PonsStaticCall;reservedTokens:PonsStaticCall};
  /** Independent one-word charge buckets; overlapping earmarks must be excluded. */
  accruals?: PonsStaticCall[];
  buyTerms: PonsChargeTerm[]; sellTerms: PonsChargeTerm[];
  /** Complete recipient list and native payout reconciliation; decomposition can remain unknown. */
  recipients: Address[]; exemptions: { accounts: Address[]; complete: boolean; evidenceIds: Hex[] };
  entryLimitSelectors: Hex[]; sellCapacitySelectors: Hex[];
  limits: { maxBuyWei: string | null; maxWalletTokens: string | null; evidenceIds: Hex[] };
  cooldown: {seconds:number;evidenceIds:Hex[]} | null;
  decayEndSec: string | null;
  feeAccounting: { gasIncludesL1: boolean; evidenceIds: Hex[] };
  /** The injected BwProbe contract class only; this never certifies an arbitrary agent account. */
  contractClass: 'bw-probe';
}
export interface PonsForkMatch extends ForkMatch {
  origin: 'fixture' | 'measured'; sourceRevision: Hex; modelVersion: 'pons-output-floor-1'; evidenceIds: Hex[];
  delaySec: number; expectedAllInEntry: string; actualAllInEntry: string; expectedNetExit: string; actualNetExit: string;
}
export function ponsMatchedFidelity(matches:PonsForkMatch[],size:100|1000,sourceRevision:Hex,delaySec=0):Hex[] {
  const eligible=matches.filter(m=>m.venue==='pons_curve' && m.sizeUsd===size && m.delaySec===delaySec && m.origin==='measured' && m.sourceRevision===sourceRevision && m.modelVersion==='pons-output-floor-1' && m.evidenceIds.length>0);
  for(const m of eligible) {
    const entry=BigInt(m.actualAllInEntry),net=BigInt(m.actualNetExit),predicted=BigInt(m.expectedNetExit);
    if(entry<=0n || entry!==BigInt(m.expectedAllInEntry) ||
      (predicted*100n<=entry*70n)!==(net*100n<=entry*70n) ||
      (net>0n ? (net>predicted?net-predicted:predicted-net)*100n>net : net!==predicted))return [];
  }
  return matchedFidelity(eligible,size,'pons_curve');
}
export interface PonsInput {
  cursor: GuardCursor; route: PonsCurveRoute; sizeUsd: 100 | 1000; sizeWei: bigint; matches: PonsForkMatch[];
  /** A local delayed trajectory preserves purchase-dependent storage and synthetic reserve impact. */
  delaySec: number;
  sellOnly?: { account: Address; accountClass: 'eoa' | 'contract'; quantity: bigint };
}
export type PonsStatus = 'ok' | 'entry_limited' | 'entry_unavailable' | 'exit_restricted' | 'cooldown_unresolved' |
  'capacity_limited' | 'provider_failure' | 'unsupported' | 'fidelity_mismatch';
export interface PonsObservation extends DeepEvidence {
  accountClass: 'eoa' | 'contract'; mode: 'round_trip' | 'sell_only'; status: PonsStatus;
  exitTimestampSec: string; purchasedStorageRetained: boolean;
  overrides: {account:Address;kind:'native_balance'|'probe_code';value:Hex;original:Hex}[];
  balanceBefore: string; allowanceAfterApproval: string;
  refundsWei: string | null; entryNetworkWei: string | null; exitNetworkWei: string | null;
  entryL1Wei: string | null; exitL1Wei: string | null;
  buyChargeWei: string | null; sellChargeWei: string | null;
  buyReserveDeltaWei: string | null; sellReserveDeltaWei: string | null;
  buyPayouts: {recipient:Address;units:string}[]; sellPayouts: {recipient:Address;units:string}[];
  buyAccruals: {call:PonsStaticCall;units:string}[]; sellAccruals: {call:PonsStaticCall;units:string}[];
  buyTaxPct: number | null; sellTaxPct: number | null;
  venueRoundTripCostPct: number | null; allInRoundTripCostPct: number | null;
  netExitWei: string | null; existingPositionDiscountPct: number | null;
  localPrediction: {spent:string;returned:string;tokens:string} | null; fidelity: boolean;
}
export interface PonsResult {
  id: Hex; methodVersion: 'pons-reference-1'; coin: Address; cursor: GuardCursor; sizeUsd: ReferenceSize;
  trajectoryKind: 'isolated_persistent_local'; benchmarkQualified: false;
  routeId: string; profileHash: Hex; routeFingerprint: Hex; routeSnapshot: unknown; ekoFeeWei: '0'; origin: 'fixture' | 'measured';
  status: PonsStatus; complete: boolean; honeypotConfirmed: false; referenceEntryUnavailable:boolean; entryLimitedClasses: ('eoa'|'contract')[];
  observations: PonsObservation[]; fidelityEvidenceIds: Hex[]; traceDigest: Hex; trace: unknown;
  unsupportedSuccessors: ['pons_v4'];
}
class UnsupportedPonsAccount extends Error {}
const executeAbi=parseAbi(['function execute(address target,uint256 value,bytes data) returns (bytes)']);
const uint=(x:unknown)=>{if(typeof x!=='string'||!/^0x[0-9a-f]+$/i.test(x))throw new Error('Invalid quantity');return BigInt(x);};
const bytes=(x:unknown):Hex=>{if(typeof x!=='string'||!/^0x([0-9a-f]{2})*$/i.test(x))throw new Error('Invalid bytes');return x as Hex;};
const word=(x:bigint)=>toHex(x,{size:32}).slice(2);
export function ponsCall(call:PonsStaticCall,recipient:Address,amount:bigint):Hex {
  if(!/^0x[0-9a-f]{8}$/i.test(call.selector))throw new Error('Invalid selector');
  return `${call.selector}${call.words.map(w=>w==='amount'?word(amount):w==='recipient'?word(BigInt(recipient)):
    /^0x[0-9a-f]{64}$/i.test(w)?w.slice(2):(()=>{throw new Error('Invalid static argument');})()).join('')}` as Hex;
}
/** Unsigned fixture/reviewed legs for 072; no EKO curve fee leg is introduced. */
export function ponsLegs(route:PonsCurveRoute,recipient:Address,amount:bigint) {
  const leg=(call:PonsStaticCall,value:bigint):ProbeLeg=>({target:call.target,value,data:ponsCall(call,recipient,amount),amountOffset:0n,patch:false});
  const slot=route.execution.sell.words.indexOf('amount');
  if(slot<0 || route.execution.sell.words.lastIndexOf('amount')!==slot)throw new Error('Sell requires one acquired-amount slot');
  return {buy:leg(route.execution.buy,amount),sell:{...leg(route.execution.sell,0n),data:ponsCall(route.execution.sell,recipient,0n),amountOffset:BigInt(4+32*slot),patch:true},
    sellWithAmount:(tokens:bigint)=>ponsCall(route.execution.sell,recipient,tokens)};
}
function supported(i:PonsInput) {
  const r=i.route,v=r.verification;
  const calls=[r.execution.buy,r.execution.sell,...Object.values(r.stateReads),...(r.accruals??[])];
  return r.venue==='pons_curve' && v.reviewed && v.blockHash===i.cursor.blockHash && v.evidenceIds.length>0 &&
    /^0x[0-9a-f]{64}$/i.test(v.profileHash) && /^0x[0-9a-f]{64}$/i.test(v.stateFingerprint) && /^0x[0-9a-f]{64}$/i.test(v.sourceRevision) &&
    [r.coin,r.curve,r.spender,...calls.map(c=>c.target)].every(a=>v.pins.some(p=>p.address.toLowerCase()===a.toLowerCase() && /^0x[0-9a-f]{64}$/i.test(p.codeHash))) &&
    (r.accruals??[]).every(c=>c.words.length===0 && c.target.toLowerCase()===r.curve.toLowerCase()) &&
    new Set((r.accruals??[]).map(c=>`${c.target.toLowerCase()}:${c.selector.toLowerCase()}`)).size===(r.accruals??[]).length &&
    calls.every(c=>/^0x[0-9a-f]{8}$/i.test(c.selector)) && r.execution.sell.words.filter(w=>w==='amount').length===1 && r.exemptions.complete && r.exemptions.evidenceIds.length>0 &&
    [...r.buyTerms,...r.sellTerms].length<=16 && [...r.buyTerms,...r.sellTerms].every(t=>['ordinary','creator','temporary','hook'].includes(t.kind) && ['gross','remaining'].includes(t.base) && t.bps>=0n && t.bps<=10000n && t.fixedWei>=0n) &&
    r.feeAccounting.evidenceIds.length>0 && r.contractClass==='bw-probe' &&
    [...r.entryLimitSelectors,...r.sellCapacitySelectors].every(s=>/^0x[0-9a-f]{8}$/i.test(s)) &&
    (r.cooldown===null || Number.isSafeInteger(r.cooldown.seconds) && r.cooldown.seconds>=0 && r.cooldown.evidenceIds.length>0);
}
/** All upstream reads belong to the shared metered reset lease. No sockets/provider URL or automatic collector. */
export class PonsReferenceSimulation {
  constructor(private readonly lease:MeteredForkLease) {}
  async run(input:PonsInput):Promise<PonsResult> {
    const cursor=GuardCursorSchema.parse(input.cursor);
    if(cursor.chainId!==CHAIN_ID || cursor.boundary!=='block_end' || ![100,1000].includes(input.sizeUsd) || input.sizeWei<=0n ||
      !Number.isSafeInteger(input.delaySec) || input.delaySec<0 || input.delaySec>86400 ||
      input.sellOnly && input.sellOnly.quantity<=0n)throw new Error('Invalid Pons input');
    const routeFingerprint=referenceDigest(input.route);
    const result:PonsResult={id:referenceDigest({cursor,routeFingerprint,size:input.sizeWei,delay:input.delaySec,held:input.sellOnly}),methodVersion:'pons-reference-1',
      trajectoryKind:'isolated_persistent_local',benchmarkQualified:false,coin:input.route.coin,cursor,sizeUsd:input.sizeUsd,routeId:input.route.id,profileHash:input.route.verification.profileHash,routeFingerprint,
      routeSnapshot:JSON.parse(JSON.stringify(input.route,(_,v)=>typeof v==='bigint'?v.toString():v)),ekoFeeWei:'0',origin:input.route.origin,status:'unsupported',complete:false,honeypotConfirmed:false,referenceEntryUnavailable:false,entryLimitedClasses:[],observations:[],fidelityEvidenceIds:[],traceDigest:referenceDigest([]),trace:[],unsupportedSuccessors:['pons_v4']};
    if(!supported(input))return result;
    if(new Set(input.route.recipients.map(a=>a.toLowerCase())).size!==input.route.recipients.length)throw new Error('Duplicate payout recipient');
    const trace:unknown[]=[];
    try {
      await this.lease.withExclusive(async(rpc,reset)=>{
        const cases=input.sellOnly?[{accountClass:input.sellOnly.accountClass,index:0}]:
          (['eoa','contract'] as const).flatMap(accountClass=>[0,1].map(index=>({accountClass,index})));
        for(const c of cases) {
          await reset(cursor);
          result.observations.push(await this.observe(rpc,input,c.accountClass,c.index,trace));
        }
        // Recheck the archive pin after all isolated executions, not synthetic fork head hashes.
        await reset(cursor);await this.pin(rpc,input);
      });
      result.status=result.observations.find(o=>o.status!=='ok')?.status ?? 'ok';
      result.fidelityEvidenceIds=ponsMatchedFidelity(input.matches,input.sizeUsd,input.route.verification.sourceRevision,input.delaySec);
      result.referenceEntryUnavailable=result.observations.every(o=>!o.buyOk || BigInt(o.tokens)===0n);
      result.entryLimitedClasses=(['eoa','contract'] as const).filter(c=>result.observations.filter(o=>o.accountClass===c).length===2 && result.observations.filter(o=>o.accountClass===c).every(o=>o.status==='entry_limited'));
      result.complete=!input.sellOnly && input.route.origin==='measured' && result.fidelityEvidenceIds.length>0 &&
        result.observations.every(o=>o.fidelity && o.validSellState && ['ok','entry_limited'].includes(o.status));
      // Persistent restrictions require independent provider/fork outcome reproduction owned by 044/069.
    } catch(e) {
      if(rpcStopReason(e))throw e;
      result.status=e instanceof UnsupportedPonsAccount?'unsupported':'provider_failure';result.complete=false;
      // Provider messages/URLs may contain credentials and never enter stored evidence.
    }
    result.trace=trace;result.traceDigest=referenceDigest(trace);
    result.id=referenceDigest({request:result.id,trace:result.traceDigest,observations:result.observations.map(({trace:_,...o})=>o),status:result.status});
    return result;
  }
  private async pin(rpc:AnvilRpc,i:PonsInput) {
    const b=await rpc.request({method:'eth_getBlockByNumber',params:[toHex(BigInt(i.cursor.blockNumber)),false]}) as {hash?:string;timestamp?:string};
    if(b?.hash?.toLowerCase()!==i.cursor.blockHash.toLowerCase() || uint(b.timestamp)!==BigInt(i.cursor.timestampSec) ||
      uint(await rpc.request({method:'eth_chainId',params:[]}))!==BigInt(CHAIN_ID))throw new Error('Fork pin mismatch');
    for(const p of i.route.verification.pins)if(keccak256(bytes(await rpc.request({method:'eth_getCode',params:[p.address,'latest']})))!==p.codeHash)throw new Error('Code pin mismatch');
  }
  private async observe(rpc:AnvilRpc,i:PonsInput,accountClass:'eoa'|'contract',index:number,allTrace:unknown[]):Promise<PonsObservation> {
    await this.pin(rpc,i);
    const r=i.route,held=i.sellOnly;
    const account=held?.account ?? `0x${keccak256(stringToHex(`eko-pons:${i.cursor.blockHash}:${r.id}:${i.sizeUsd}:${accountClass}:${index}`)).slice(-40)}` as Address;
    const payer=accountClass==='eoa'?account:`0x${keccak256(stringToHex(`eko-pons-payer:${account}`)).slice(-40)}` as Address;
    if(r.exemptions.accounts.some(a=>a.toLowerCase()===account.toLowerCase()) || r.recipients.some(a=>[account,payer].some(b=>a.toLowerCase()===b.toLowerCase())))throw new UnsupportedPonsAccount('Privileged reference identity');
    const call=async(to:Address,data:Hex)=>bytes(await rpc.request({method:'eth_call',params:[{from:account,to,data},'latest']}));
    const tokenRead=async(name:'balanceOf'|'allowance')=>decodeAbiParameters([{type:'uint256'}],await call(r.coin,encodeFunctionData({abi:referenceTokenAbi,functionName:name,args:name==='balanceOf'?[account]:[account,r.spender]})))[0];
    const state=async():Promise<PonsCurveState>=>Object.fromEntries(await Promise.all(Object.entries(r.stateReads).map(async([key,c])=>[key,decodeAbiParameters([{type:'uint256'}],await call(c.target,ponsCall(c,account,0n)))[0]]))) as unknown as PonsCurveState;
    const native=async(a:Address)=>uint(await rpc.request({method:'eth_getBalance',params:[a,'latest']}));
    const allowanceBefore=await tokenRead('allowance'),balanceBefore=await tokenRead('balanceOf');
    const code=bytes(await rpc.request({method:'eth_getCode',params:[account,'latest']}));
    if(!held && (allowanceBefore!==0n || balanceBefore!==0n || code!=='0x'))throw new UnsupportedPonsAccount('Reference identity is not fresh');
    if(held && (balanceBefore<held.quantity || (accountClass==='eoa'?code!=='0x':code!==EKO_PROBE_RUNTIME)))throw new UnsupportedPonsAccount('Unsupported held account');
    if(accountClass==='contract' && bytes(await rpc.request({method:'eth_getCode',params:[payer,'latest']}))!=='0x')throw new UnsupportedPonsAccount('Payer is not fresh');
    const trace:unknown[]=[],overrides:PonsObservation['overrides']=[];
    allTrace.push({account,accountClass,trace});
    const funding=i.sizeWei+10n**18n;
    for(const a of [...new Set([account,payer])]) {
      const original=toHex(await native(a));
      await rpc.request({method:'anvil_setBalance',params:[a,toHex(funding)]});overrides.push({account:a,kind:'native_balance',value:toHex(funding),original});
    }
    if(accountClass==='contract' && !held){await rpc.request({method:'anvil_setCode',params:[account,EKO_PROBE_RUNTIME]});overrides.push({account,kind:'probe_code',value:EKO_PROBE_RUNTIME,original:code});}
    await rpc.request({method:'anvil_impersonateAccount',params:[payer]});
    const send=async(to:Address,data:Hex,value=0n)=>{
      const tx=accountClass==='eoa'?{from:payer,to,data,value:toHex(value)}:
        {from:payer,to:account,data:encodeFunctionData({abi:executeAbi,functionName:'execute',args:[to,value,data]}),value:'0x0'};
      const mined=await sendAndMine(rpc,{...tx,gas:toHex(30_000_000n)});
      const hash=mined.hash,receipt=mined.receipt as {status:unknown;gasUsed:unknown;effectiveGasPrice:unknown;l1Fee?:unknown};
      const frame=await rpc.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer',tracerConfig:{withLog:true}}]}) as {output?:unknown};
      trace.push({hash,receipt,frame});
      const execution=uint(receipt.gasUsed)*uint(receipt.effectiveGasPrice),l1=receipt.l1Fee===undefined?null:uint(receipt.l1Fee);
      const network=r.feeAccounting.gasIncludesL1?execution:l1===null?null:execution+l1;
      return {ok:uint(receipt.status)===1n,execution,l1,network,revert:uint(receipt.status)===1n?'0x' as Hex:bytes(frame?.output ?? '0x')};
    };
    const sum=(a:bigint|null,b:bigint|null)=>a===null||b===null?null:a+b;
    const accruals=async()=>Promise.all((r.accruals??[]).map(async c=>{
      const data=await call(c.target,ponsCall(c,account,0n));
      if(data.length!==66)throw new Error('Accrual getter must return one word');
      return {call:c,units:decodeAbiParameters([{type:'uint256'}],data)[0]};
    }));
    const accrualDelta=(before:Awaited<ReturnType<typeof accruals>>,after:Awaited<ReturnType<typeof accruals>>)=>after.map((p,k)=>({call:p.call,units:(p.units-before[k].units).toString()}));
    const payouts=async()=>Promise.all(r.recipients.map(async recipient=>({recipient,units:await native(recipient)})));
    const payoutDelta=(before:Awaited<ReturnType<typeof payouts>>,after:Awaited<ReturnType<typeof payouts>>)=>after.map((p,k)=>({recipient:p.recipient,units:(p.units-before[k].units).toString()}));
    let tokens=held?.quantity ?? 0n,spent=0n,returned=0n,quotedBuy=0n,quotedSell=0n,buyOk=!!held,sellOk=false,validSellState=false,revert:Hex='0x',status:PonsStatus='ok';
    let entryNetwork:bigint|null=held?null:0n,entryL1:bigint|null=held?null:0n,exitNetwork:bigint|null=0n,exitL1:bigint|null=0n;
    let buyReserve:bigint|null=null,sellReserve:bigint|null=null,buyCharge:bigint|null=null,sellCharge:bigint|null=null;
    let buyPayouts:PonsObservation['buyPayouts']=[],sellPayouts:PonsObservation['sellPayouts']=[],prediction:PonsObservation['localPrediction']=null,fidelity=false,approved=allowanceBefore;
    let buyAccruals:PonsObservation['buyAccruals']=[],sellAccruals:PonsObservation['sellAccruals']=[];
    let exitTimestamp=i.cursor.timestampSec,discount:number|null=null;
    try {
      const initial=await state();
      if(!held) {
        const predicted=ponsLocalRoundTrip(initial,i.sizeWei,r.buyTerms,r.sellTerms);
        if(predicted.sell.capacity)prediction={spent:predicted.buy.spent.toString(),returned:predicted.sell.returned.toString(),tokens:predicted.buy.tokens.toString()};
        quotedBuy=ponsBuy(initial,i.sizeWei,[]).tokens;
        const before=await native(account),pBefore=await payouts(),aBefore=await accruals();
        const buy=await send(r.execution.buy.target,ponsCall(r.execution.buy,account,i.sizeWei),i.sizeWei);
        const after=await native(account),sAfter=await state();
        entryNetwork=buy.network;entryL1=buy.l1;buyOk=buy.ok;revert=buy.revert;
        if(accountClass==='eoa' && buy.network===null)throw new UnsupportedPonsAccount('Native debit cannot exclude unknown L1 fees');
        spent=buy.ok?before-after-(accountClass==='eoa'?(buy.network ?? buy.execution):0n):0n;
        tokens=await tokenRead('balanceOf');
        buyAccruals=accrualDelta(aBefore,await accruals());buyPayouts=payoutDelta(pBefore,await payouts());buyReserve=sAfter.realQuote-initial.realQuote;
        buyCharge=spent-buyReserve;
        if(spent<0n || spent>i.sizeWei)throw new Error('Invalid buy debit');
        if(!buyOk)status=r.entryLimitSelectors.some(s=>revert.startsWith(s))?'entry_limited':'entry_unavailable';
        else if(tokens===0n)status='entry_unavailable';
      }
      if(buyOk && tokens>0n) {
        if(i.delaySec>0){await rpc.request({method:'evm_increaseTime',params:[i.delaySec]});await rpc.request({method:'evm_mine',params:[]});}
        const latest=await rpc.request({method:'eth_getBlockByNumber',params:['latest',false]}) as {timestamp:unknown};exitTimestamp=uint(latest.timestamp).toString();
        const approval=await send(r.coin,encodeFunctionData({abi:referenceTokenAbi,functionName:'approve',args:[r.spender,tokens]}));
        exitNetwork=sum(exitNetwork,approval.network);exitL1=sum(exitL1,approval.l1);approved=await tokenRead('allowance');
        const preSell=await state(),independent=ponsNoTaxSell(preSell,tokens);quotedSell=independent.quote;
        discount=null;
        validSellState=approval.ok && approved===tokens && await tokenRead('balanceOf')>=tokens && independent.capacity && quotedSell>0n &&
          r.cooldown!==null && i.delaySec>=r.cooldown.seconds && r.decayEndSec!==null && BigInt(exitTimestamp)>=BigInt(r.decayEndSec);
        if(!approval.ok || approved!==tokens) {status='exit_restricted';revert=approval.revert;}
        else {
          const before=await native(account),pBefore=await payouts(),aBefore=await accruals();
          const sell=await send(r.execution.sell.target,ponsCall(r.execution.sell,account,tokens));
          if(accountClass==='eoa' && sell.network===null)throw new UnsupportedPonsAccount('Native credit cannot exclude unknown L1 fees');
          returned=sell.ok?await native(account)-before+(accountClass==='eoa'?(sell.network ?? sell.execution):0n):0n;
          exitNetwork=sum(exitNetwork,sell.network);exitL1=sum(exitL1,sell.l1);sellOk=sell.ok;revert=sell.revert;
          sellReserve=preSell.realQuote-(await state()).realQuote;
          sellAccruals=accrualDelta(aBefore,await accruals());sellPayouts=payoutDelta(pBefore,await payouts());sellCharge=sellReserve-returned;
          if(held && sell.ok)discount=percent(tokens*(preSell.realQuote+preSell.virtualQuote)-returned*preSell.tokens,tokens*(preSell.realQuote+preSell.virtualQuote));
          if(returned<0n)throw new Error('Invalid sell credit');
          if(!sell.ok)status=r.sellCapacitySelectors.some(s=>revert.startsWith(s)) || !independent.capacity?'capacity_limited':validSellState?'exit_restricted':'cooldown_unresolved';
          const expected=ponsSell(preSell,tokens,r.sellTerms);
          if(held && expected.capacity)prediction={spent:'0',returned:expected.returned.toString(),tokens:tokens.toString()};
        }
      }
      const reconciled=(charge:bigint|null,ps:{units:string}[],as:{units:string}[])=>charge!==null && charge>=0n && [...ps,...as].every(p=>BigInt(p.units)>=0n) && charge===[...ps,...as].reduce((n,p)=>n+BigInt(p.units),0n);
      fidelity=!!prediction && prediction.tokens===tokens.toString() && sellReserve===quotedSell && prediction.spent===spent.toString() && (!held?entryNetwork!==null:true) && exitNetwork!==null &&
        (!held?reconciled(buyCharge,buyPayouts,buyAccruals):true) && reconciled(sellCharge,sellPayouts,sellAccruals) && sellOk &&
        (returned===0n?BigInt(prediction.returned)===0n:(returned-BigInt(prediction.returned)<0n?BigInt(prediction.returned)-returned:returned-BigInt(prediction.returned))*100n<=returned) &&
        (!!held || (BigInt(prediction.returned)*100n<=spent*70n)===(returned*100n<=spent*70n));
      if(status==='ok' && !fidelity)status='fidelity_mismatch';
      return {account,accountClass,mode:held?'sell_only':'round_trip',blockHash:i.cursor.blockHash as Hex,allowanceBefore:allowanceBefore.toString(),delaySec:i.delaySec,
        tokens:tokens.toString(),spent:spent.toString(),returned:returned.toString(),quotedBuy:quotedBuy.toString(),quotedSell:quotedSell.toString(),buyOk,sellOk,revert,validSellState,trace,
        status,exitTimestampSec:exitTimestamp,purchasedStorageRetained:!held && buyOk,overrides,balanceBefore:balanceBefore.toString(),allowanceAfterApproval:approved.toString(),
        refundsWei:held?null:(i.sizeWei-spent).toString(),entryNetworkWei:entryNetwork?.toString()??null,exitNetworkWei:exitNetwork?.toString()??null,
        entryL1Wei:entryL1?.toString()??null,exitL1Wei:exitL1?.toString()??null,buyChargeWei:buyCharge?.toString()??null,sellChargeWei:sellCharge?.toString()??null,
        buyReserveDeltaWei:buyReserve?.toString()??null,sellReserveDeltaWei:sellReserve?.toString()??null,buyPayouts,sellPayouts,buyAccruals,sellAccruals,
        buyTaxPct:held || !reconciled(buyCharge,buyPayouts,buyAccruals)?null:percent(buyCharge!,spent),sellTaxPct:!reconciled(sellCharge,sellPayouts,sellAccruals) || sellReserve===null?null:percent(sellCharge!,sellReserve),
        venueRoundTripCostPct:held || !buyOk || !sellOk?null:percent(spent-returned,spent),
        allInRoundTripCostPct:held || !buyOk || !sellOk || entryNetwork===null || exitNetwork===null?null:percent(spent+entryNetwork+exitNetwork-returned,spent+entryNetwork),
        netExitWei:exitNetwork===null?null:(returned-exitNetwork).toString(),existingPositionDiscountPct:held && sellOk?discount:null,localPrediction:prediction,fidelity};
    } finally {await rpc.request({method:'anvil_stopImpersonatingAccount',params:[payer]});}
  }
}
