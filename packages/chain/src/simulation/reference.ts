import { randomBytes } from 'node:crypto';
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, toHex, type Hex, type Address } from 'viem';
import { GuardCursorSchema } from '@eko/shared';
import type { createMeteredClients } from '../rpc/clients.js';
import { rpcStopReason } from '../rpc/metered.js';
import { EKO_PROBE_RUNTIME } from './probe-runtime.js';
import { isReferenceRoute, quoteData, v3Legs } from './v3.js';
import type { DeepEvidence, ForkMatch, ReferenceInput, ReferenceResult, RoundTripAmounts } from './types.js';
import { CHAIN_ID } from '@eko/shared';

export const probeAbi = parseAbi(['function roundTrip(address token,address spender,(address target,uint256 value,bytes data,uint256 amountOffset,bool patch) buy,(address target,uint256 value,bytes data,uint256 amountOffset,bool patch) quoteSell,(address target,uint256 value,bytes data,uint256 amountOffset,bool patch) sell) returns (uint256 tokensOut,uint256 quotedBack,uint256 ethBack,uint256 spent,bool buyOk,bool sellOk,bytes err)']);
const ordered = (value:unknown):unknown => typeof value==='bigint' ? value.toString() : Array.isArray(value) ? value.map(ordered) :
  value && typeof value==='object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])) : value;
export const referenceDigest = (value:unknown) => keccak256(stringToHex(JSON.stringify(ordered(value))));
const digest=referenceDigest;
// Raw amounts never go through Number. Only the final bounded display ratio is converted.
export const percent = (n:bigint,d:bigint) => d>0n ? Number(n*1_000_000n/d)/10_000 : null;
export function matchedFidelity(matches:ForkMatch[], size:number, venue:ForkMatch['venue']='uniswap_v3', classes:readonly ForkMatch['accountClass'][]=['eoa','contract']): Hex[] {
  const ids:Hex[]=[];
  for(const accountClass of classes) {
    const cases=new Set<string>();
    for(const m of matches.filter(m=>m.venue===venue && m.sizeUsd===size && m.accountClass===accountClass)) {
      const spent=BigInt(m.actualSpent),returned=BigInt(m.actualReturned),predicted=BigInt(m.expectedReturned);
      if(spent<=0n || BigInt(m.expectedSpent)!==spent || returned<0n || predicted<0n || m.expectedBlocked!==m.actualBlocked ||
        (returned===0n ? predicted!==0n : (returned>predicted?returned-predicted:predicted-returned)*100n>returned) ||
        (predicted*100n<=spent*70n)!==(returned*100n<=spent*70n)) return [];
      if(!cases.has(m.caseId)){cases.add(m.caseId);ids.push(m.id);}
    }
    if(cases.size<30)return [];
  }
  return ids;
}
const blocked = (p:RoundTripAmounts) => p.buyOk && BigInt(p.tokens)>0n && (!p.sellOk ||
  BigInt(p.quotedSell)>0n && BigInt(p.returned)*20n<BigInt(p.quotedSell));
export function classifyReference(input:ReferenceInput, probe:RoundTripAmounts, deep:DeepEvidence[]): ReferenceResult['status'] {
  if(!probe.buyOk) return input.route.entryLimitSelectors.some(s=>probe.revert.startsWith(s)) ? 'entry_limited' : 'entry_unavailable';
  if(!probe.sellOk && input.route.cooldown===null)return 'cooldown_unresolved';
  if(deep.length!==2 || deep[0].account===deep[1].account || deep.some(d=>d.blockHash!==input.cursor.blockHash))return 'fork_evidence_missing';
  if(blocked(probe) && deep.every(d=>d.validSellState && blocked(d)))return 'blocked_exit';
  if(blocked(probe) && deep.every(d=>d.buyOk && d.sellOk && !blocked(d)))return 'contract_restricted';
  if(deep.some(d=>!d.buyOk || !d.sellOk || !d.validSellState))return 'fork_evidence_missing';
  return 'ok';
}
export class V3ReferenceSimulation {
  constructor(private readonly clients:Pick<ReturnType<typeof createMeteredClients>,'archive'>,
    private readonly confirmation?: {confirm(input:ReferenceInput,quotedBuy:bigint):Promise<DeepEvidence[]>}) {}
  async run(input:ReferenceInput):Promise<ReferenceResult> {
    const cursor=GuardCursorSchema.parse(input.cursor);
    if(cursor.chainId!==CHAIN_ID || cursor.boundary!=='block_end' || input.sizeWei<=0n || ![100,1000,10000].includes(input.sizeUsd))throw new Error('Invalid reference input');
    const result:ReferenceResult={id:digest({cursor,route:input.route,sizeUsd:input.sizeUsd,sizeWei:input.sizeWei.toString(),method:'v3-reference-1'}),
      methodVersion:'v3-reference-1',coin:input.route.coin,cursor,sizeUsd:input.sizeUsd,routeId:input.route.id,routeSnapshot:{...input.route,deadline:input.route.deadline.toString()},requestedWei:input.sizeWei.toString(),
      probe:null,deep:[],status:'unsupported',complete:false,honeypotConfirmed:false,buyTaxPct:null,sellTaxPct:null,exitCostPct:null,
      traceDigest:digest([]),trace:[],fidelityEvidenceIds:[]};
    if(!isReferenceRoute(input.route,cursor.blockHash as Hex))return result;
    const raw:unknown[]=[];
    const request=(method:string,params:readonly unknown[])=>this.clients.archive.request({method,params} as never);
    const pin=async()=>{
      const b=await request('eth_getBlockByNumber',[toHex(BigInt(cursor.blockNumber)),false]) as {hash?:string;timestamp?:string};
      if(b?.hash?.toLowerCase()!==cursor.blockHash.toLowerCase() || BigInt(b.timestamp ?? '-1')!==BigInt(cursor.timestampSec))throw new Error('Reference pin mismatch');
    };
    try {
      await pin();
      const probe=`0x${randomBytes(20).toString('hex')}` as Address,caller=`0x${randomBytes(20).toString('hex')}` as Address;
      for(const a of [probe,caller])if(await request('eth_getCode',[a,toHex(BigInt(cursor.blockNumber))])!=='0x')throw new Error('Probe address not fresh');
      const quoted=await request('eth_call',[{to:input.route.quoter,data:quoteData(input.route,input.sizeWei)},toHex(BigInt(cursor.blockNumber))]);
      const quotedBuy=decodeAbiParameters([{type:'uint256'}],(quoted as Hex).slice(0,66) as Hex)[0];
      const legs=v3Legs(input.route,probe,input.sizeWei);
      const traceParams=[{from:caller,to:probe,data:encodeFunctionData({abi:probeAbi,functionName:'roundTrip',args:[input.route.coin,input.route.router,legs.buy,legs.quoteSell,legs.sell]}),gas:toHex(30_000_000n)},toHex(BigInt(cursor.blockNumber)),{tracer:'callTracer',tracerConfig:{withLog:true},stateOverrides:{[probe]:{code:EKO_PROBE_RUNTIME,balance:toHex(input.sizeWei+10n**18n)}}}];
      const trace=await request('debug_traceCall',traceParams) as {output?:Hex;error?:string};
      raw.push({probe,caller,quoted,traceParams,trace});
      if(trace.error || !trace.output)throw new Error('Probe transport/execution unavailable');
      const [tokens,quotedSell,returned,spent,buyOk,sellOk,revert]=decodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bool'},{type:'bool'},{type:'bytes'}],trace.output);
      result.probe={tokens:tokens.toString(),quotedBuy:quotedBuy.toString(),quotedSell:quotedSell.toString(),returned:returned.toString(),spent:spent.toString(),buyOk,sellOk,revert};
      if(buyOk && (spent<=0n || spent>input.sizeWei))throw new Error('Invalid probe debit');
      result.deep=this.confirmation ? await this.confirmation.confirm(input,quotedBuy) : [];
      raw.push(...result.deep.map(d=>d.trace));await pin();
      if(result.deep.some(d=>d.buyOk && (BigInt(d.spent)<=0n || BigInt(d.spent)>input.sizeWei)))throw new Error('Invalid EOA debit');
      result.status=classifyReference(input,result.probe,result.deep);
      result.fidelityEvidenceIds=matchedFidelity(input.matches,input.sizeUsd);
      result.complete=result.fidelityEvidenceIds.length>0 && (result.status!=='entry_limited' || result.deep.length===2 && result.deep[0].account!==result.deep[1].account && result.deep.every(d=>d.blockHash===cursor.blockHash && !d.buyOk && input.route.entryLimitSelectors.some(selector=>d.revert.startsWith(selector)))) && (result.status!=='ok' || quotedBuy>0n && quotedSell>0n) && ['ok','entry_limited','contract_restricted','blocked_exit'].includes(result.status);
      if(!result.complete && ['ok','blocked_exit','contract_restricted'].includes(result.status))result.status='fork_evidence_missing';
      result.honeypotConfirmed=result.complete && result.status==='blocked_exit';
      result.buyTaxPct=percent(quotedBuy-tokens,quotedBuy);
      result.sellTaxPct=sellOk?percent(quotedSell-returned,quotedSell):null;
      result.exitCostPct=buyOk && sellOk?percent(spent-returned,spent):result.honeypotConfirmed?100:null;
    } catch(error) {
      if(rpcStopReason(error))throw error;
      result.status='provider_failure';result.complete=false;result.honeypotConfirmed=false;
      // Do not persist provider messages/URLs, which can contain credentials.
    }
    result.trace=raw;result.traceDigest=digest(raw);result.id=digest({requestId:result.id,traceDigest:result.traceDigest,status:result.status,fidelity:result.fidelityEvidenceIds});return result;
  }
}
