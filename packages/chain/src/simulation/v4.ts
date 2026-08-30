import { randomBytes } from 'node:crypto';
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { GuardCursorSchema, type GuardCursor } from '@eko/shared';
import type { createMeteredClients } from '../rpc/clients.js';
import { rpcStopReason } from '../rpc/metered.js';
import { percent, referenceDigest } from './reference.js';
import type { ReferenceSize, RoundTripAmounts } from './types.js';
import { EKO_V4_PROBE_RUNTIME } from './v4-probe-runtime.js';
import { CHAIN_ID } from '@eko/shared';

const keyType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const v4ReferenceQuoterAbi = parseAbi([`function quoteExactInputSingle((${keyType} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`]);
export const v4ProbeAbi = parseAbi([`function roundTrip(address manager,address quoter,${keyType} key,bytes hookData,uint128 amount) returns (uint256 tokens,uint256 quotedSell,uint256 returned,uint256 spent,bool buyOk,bool sellOk,bytes err)`]);
const stateAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32 poolId) view returns (uint128)']);
export interface V4PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}], [key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));
}
export interface V4ReferenceRoute {
  venue: 'uniswap_v4'; id: string; coin: Address; poolId: Hex; key: V4PoolKey;
  manager: Address; quoter: Address; stateView: Address; hookData: Hex;
  origin: 'fixture' | 'measured'; launchpad: 'pons' | 'other';
  /** Review covers deployed core/quoter ABI, callback path and hook configuration at this cursor. */
  verification: { blockHash: Hex; reviewed: boolean; evidenceIds: Hex[]; pins: {address:Address;codeHash:Hex}[] };
  /** Per-PoolId custody from 042; a curve's custody does not certify its successor. */
  successor: {poolId:Hex;blockHash:Hex;custody:'locked'|'removable'|'burned'|'pons_locked';evidenceIds:Hex[]} | null;
}
export interface V4ReferenceInput {
  cursor: GuardCursor; route: V4ReferenceRoute; sizeUsd: ReferenceSize; sizeWei: bigint;
  /** Independent no-tax model of exactly this buy and the post-buy acquired-quantity sell; never a hook quote. */
  noTax?: {blockHash:Hex;poolId:Hex;sizeWei:string;tokens:string;buyOutput:string;sellOutput:string;evidenceIds:Hex[]};
}
export interface V4ReferenceResult {
  id:Hex; methodVersion:'v4-reference-1'; coin:Address; cursor:GuardCursor; sizeUsd:ReferenceSize;
  routeId:string; routeSnapshot:V4ReferenceRoute; requestedWei:string; origin:'fixture'|'measured';
  route:{venue:'uniswap_v4';poolId:Hex;executable:false;linkOut:string|null};
  status:'unsupported'|'provider_failure'|'entry_unavailable'|'sell_restricted'|'observed';
  /** This contract probe alone cannot complete Guard's account/fidelity manifest. */
  complete:false; honeypotConfirmed:false; probe:RoundTripAmounts|null; quoteGasEstimate:string|null;
  hookEvidence:{hook:Address;permissionBits:number;quoteBuyGapPct:number|null;quoteSellGapPct:number|null;
    buyFeePct:number|null;sellFeePct:number|null;feeAsymmetryPp:number|null;diagnostics:('quote_sim_gap'|'asymmetric_fee')[];evidenceIds:Hex[]};
  venueRoundTripCostPct:number|null; allInRoundTripCostPct:null; ekoFeeWei:'0';
  capability:{abi:'unverified'|'pinned';trace:'not_run'|'passed'|'failed';executableForkGate:'not_accepted'};
  trace:unknown[];traceDigest:Hex;
}
/** Link URLs come only from reviewed config; token metadata is never a URL source. */
// TODO(spec): no canonical graduated-Pons URL/query binding is specified; links default to null and require reviewed venue config.
export interface V4VenueLinkConfig { pons: {baseUrl:string;allowedOrigins:readonly string[]} | null }
export function v4FallbackLink(route:V4ReferenceRoute, config:V4VenueLinkConfig):string|null {
  if(route.launchpad!=='pons' || !config.pons)return null;
  try {
    const url=new URL(config.pons.baseUrl);
    if(url.protocol!=='https:' || url.username || url.password || url.hash || url.search ||
      !config.pons.allowedOrigins.includes(url.origin))return null;
    url.searchParams.set('chainId',String(CHAIN_ID));url.searchParams.set('token',route.coin);return url.href;
  } catch {return null;}
}
const hash=(x:string)=>/^0x[0-9a-f]{64}$/i.test(x);
export function supportedV4Route(route:V4ReferenceRoute,cursor:GuardCursor):boolean {
  const k=route.key,v=route.verification;
  const addresses=[route.coin,route.manager,route.quoter,route.stateView,k.hooks];
  return route.venue==='uniswap_v4' && addresses.every(a=>/^0x[0-9a-f]{40}$/i.test(a) && a!==zeroAddress) &&
    new Set(addresses.map(a=>a.toLowerCase())).size===addresses.length &&
    k.currency0===zeroAddress && k.currency1.toLowerCase()===route.coin.toLowerCase() &&
    Number.isInteger(k.fee) && (k.fee>=0 && k.fee<=1000000 || k.fee===0x800000) &&
    Number.isInteger(k.tickSpacing) && k.tickSpacing>0 && k.tickSpacing<=32767 &&
    /^0x([0-9a-f]{2})*$/i.test(route.hookData) && route.hookData.length<=8194 &&
    hash(route.poolId) && v4PoolId(k).toLowerCase()===route.poolId.toLowerCase() &&
    v.reviewed && v.blockHash===cursor.blockHash && v.evidenceIds.length>0 && v.evidenceIds.every(hash) &&
    addresses.every(a=>v.pins.some(p=>p.address.toLowerCase()===a.toLowerCase() && hash(p.codeHash))) &&
    (route.launchpad!=='pons' || route.successor!==null && route.successor.poolId===route.poolId &&
      route.successor.blockHash===cursor.blockHash && route.successor.evidenceIds.length>0 && route.successor.evidenceIds.every(hash));
}
export function v4QuoteData(route:V4ReferenceRoute,amount:bigint,sell=false):Hex {
  return encodeFunctionData({abi:v4ReferenceQuoterAbi,functionName:'quoteExactInputSingle',args:[{poolKey:route.key,zeroForOne:!sell,exactAmount:amount,hookData:route.hookData}]});
}
/** All live acquisition uses the centralized metered archive client. Each trace is independent state. */
export class V4ReferenceSimulation {
  constructor(private readonly clients:Pick<ReturnType<typeof createMeteredClients>,'archive'>,
    private readonly links:V4VenueLinkConfig={pons:null}) {}
  async run(input:V4ReferenceInput):Promise<V4ReferenceResult> {
    const cursor=GuardCursorSchema.parse(input.cursor),r=input.route;
    if(cursor.chainId!==CHAIN_ID || cursor.boundary!=='block_end' || input.sizeWei<=0n || input.sizeWei>=2n**128n || ![100,1000,10000].includes(input.sizeUsd))throw new Error('Invalid v4 reference input');
    const result:V4ReferenceResult={id:referenceDigest({cursor,route:r,size:input.sizeWei,sizeUsd:input.sizeUsd,noTax:input.noTax}),methodVersion:'v4-reference-1',coin:r.coin,cursor,sizeUsd:input.sizeUsd,
      routeId:r.id,routeSnapshot:r,requestedWei:input.sizeWei.toString(),origin:r.origin,route:{venue:'uniswap_v4',poolId:r.poolId,executable:false,linkOut:v4FallbackLink(r,this.links)},
      status:'unsupported',complete:false,honeypotConfirmed:false,probe:null,quoteGasEstimate:null,
      hookEvidence:{hook:r.key.hooks,permissionBits:Number(BigInt(r.key.hooks)&0x3fffn),quoteBuyGapPct:null,quoteSellGapPct:null,buyFeePct:null,sellFeePct:null,feeAsymmetryPp:null,diagnostics:[],evidenceIds:[]},
      venueRoundTripCostPct:null,allInRoundTripCostPct:null,ekoFeeWei:'0',capability:{abi:'unverified',trace:'not_run',executableForkGate:'not_accepted'},trace:[],traceDigest:referenceDigest([])};
    if(!supportedV4Route(r,cursor))return result;
    const request=(method:string,params:readonly unknown[])=>this.clients.archive.request({method,params} as never);
    const block=toHex(BigInt(cursor.blockNumber));
    const pin=async()=>{const b=await request('eth_getBlockByNumber',[block,false]) as {hash?:string;timestamp?:string};
      if(b?.hash?.toLowerCase()!==cursor.blockHash.toLowerCase() || BigInt(b.timestamp??'-1')!==BigInt(cursor.timestampSec))throw new Error('V4 pin mismatch');};
    try {
      await pin();
      for(const p of r.verification.pins) {
        const code=await request('eth_getCode',[p.address,block]) as Hex;
        if(code==='0x' || keccak256(code)!==p.codeHash)throw new Error('V4 code pin mismatch');
        result.trace.push({address:p.address,codeHash:p.codeHash});
      }
      const call=async(to:Address,data:Hex)=>await request('eth_call',[{to,data},block]) as Hex;
      const slot=await call(r.stateView,encodeFunctionData({abi:stateAbi,functionName:'getSlot0',args:[r.poolId]}));
      const liquidity=await call(r.stateView,encodeFunctionData({abi:stateAbi,functionName:'getLiquidity',args:[r.poolId]}));
      if(decodeAbiParameters([{type:'uint160'},{type:'int24'},{type:'uint24'},{type:'uint24'}],slot)[0]===0n || decodeAbiParameters([{type:'uint128'}],liquidity)[0]===0n)throw new Error('V4 successor state unavailable');
      result.trace.push({slot,liquidity});result.capability.abi='pinned';
      const quoted=await call(r.quoter,v4QuoteData(r,input.sizeWei));
      const [quotedBuy,gasEstimate]=decodeAbiParameters([{type:'uint256'},{type:'uint256'}],quoted);
      if(quotedBuy===0n)throw new Error('V4 quote unavailable');
      result.quoteGasEstimate=gasEstimate.toString();
      const probe=`0x${randomBytes(20).toString('hex')}` as Address,caller=`0x${randomBytes(20).toString('hex')}` as Address;
      for(const account of [probe,caller])if(await request('eth_getCode',[account,block])!=='0x')throw new Error('Probe address not fresh');
      const params=[{from:caller,to:probe,data:encodeFunctionData({abi:v4ProbeAbi,functionName:'roundTrip',args:[r.manager,r.quoter,r.key,r.hookData,input.sizeWei]}),gas:toHex(30000000n)},block,
        {tracer:'callTracer',tracerConfig:{withLog:true},stateOverrides:{[probe]:{code:EKO_V4_PROBE_RUNTIME,balance:toHex(input.sizeWei+10n**18n)}}}];
      const trace=await request('debug_traceCall',params) as {output?:Hex;error?:string};result.trace.push({quoted,params,trace});
      if(trace.error || !trace.output)throw new Error('V4 trace unavailable');
      const [tokens,quotedSell,returned,spent,buyOk,sellOk,revert]=decodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bool'},{type:'bool'},{type:'bytes'}],trace.output);
      if(buyOk && (spent<=0n || spent>input.sizeWei) || sellOk && (!buyOk || tokens===0n))throw new Error('Invalid V4 debit/output');
      await pin();
      result.probe={tokens:tokens.toString(),quotedBuy:quotedBuy.toString(),quotedSell:quotedSell.toString(),returned:returned.toString(),spent:spent.toString(),buyOk,sellOk,revert};
      result.capability.trace='passed';result.status=!buyOk?'entry_unavailable':!sellOk?'sell_restricted':'observed';
      const h=result.hookEvidence;
      h.evidenceIds=[...r.verification.evidenceIds];
      h.quoteBuyGapPct=buyOk?percent(tokens>quotedBuy?tokens-quotedBuy:quotedBuy-tokens,quotedBuy):null;
      h.quoteSellGapPct=sellOk?percent(returned>quotedSell?returned-quotedSell:quotedSell-returned,quotedSell):null;
      // Diagnostic thresholds from Guard §3.4 never dispatch a new risk verdict here.
      if(buyOk && (tokens>quotedBuy?tokens-quotedBuy:quotedBuy-tokens)*100n>quotedBuy*2n ||
        sellOk && quotedSell>0n && (returned>quotedSell?returned-quotedSell:quotedSell-returned)*100n>quotedSell*2n)h.diagnostics.push('quote_sim_gap');
      const n=input.noTax;
      if(n && n.blockHash===cursor.blockHash && n.poolId===r.poolId && n.sizeWei===input.sizeWei.toString() && n.tokens===tokens.toString() && n.evidenceIds.length>0 && n.evidenceIds.every(hash) && BigInt(n.buyOutput)>0n && BigInt(n.sellOutput)>0n && buyOk && spent===input.sizeWei) {
        h.buyFeePct=percent(BigInt(n.buyOutput)-tokens,BigInt(n.buyOutput));
        h.sellFeePct=sellOk?percent(BigInt(n.sellOutput)-returned,BigInt(n.sellOutput)):null;
        h.feeAsymmetryPp=h.sellFeePct===null?null:h.sellFeePct-h.buyFeePct!;
        h.evidenceIds.push(...n.evidenceIds);
        const buyBase=BigInt(n.buyOutput),sellBase=BigInt(n.sellOutput);
        if(sellOk && ((sellBase-returned)*buyBase-(buyBase-tokens)*sellBase)*100n>5n*buyBase*sellBase)h.diagnostics.push('asymmetric_fee');
      }
      result.venueRoundTripCostPct=buyOk && sellOk?percent(spent-returned,spent):null;
    } catch(error) {
      if(rpcStopReason(error))throw error;
      result.status='provider_failure';result.capability.trace='failed';result.probe=null;
      // Provider text may contain credentials and is deliberately not persisted.
    }
    result.traceDigest=referenceDigest(result.trace);result.id=referenceDigest({request:result.id,trace:result.traceDigest,status:result.status});return result;
  }
}
