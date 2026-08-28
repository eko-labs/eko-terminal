import { decodeEventLog, getAddress, keccak256, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { GuardCursorSchema, type GuardCursor } from '@eko/shared';
import { hex, type SqlClient } from '@eko/db';
import type { AddressRegistry } from '../registry.js';
import { rpcStopReason } from '../rpc/metered.js';
import { referenceDigest } from './reference.js';
import type { AnvilRpc } from './types.js';
import type { ForkCheckManifest } from './fork-check-cli.js';
import type { PonsCurveRoute, PonsStaticCall } from './pons.js';
import { CHAIN_ID } from '@eko/shared';

const exemptionAbi=parseAbi(['event SnipeTaxExempted(address indexed account)']);
const digestSchema=z.string().regex(/^0x[0-9a-f]{64}$/i).transform(x=>x as Hex);
const getterSchema=z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*\(address\)$/);
/** Review assertions bind to exact deployed code, not the published source or selector presence alone. */
export const ManifestReviewSchema=z.strictObject({
  schemaVersion:z.literal('pons-manifest-review-1'),
  deployments:z.array(z.strictObject({
    coinCodeHash:digestSchema, curveCodeHash:digestSchema, factoryCodeHash:digestSchema,
    sourceRevision:digestSchema, evidenceIds:z.array(digestSchema).min(1),
    // TODO(spec): no deployed per-launch timing ABI is documented. Accept only explicit code-bound reviewed getters; never use current global factory defaults.
    timing:z.strictObject({launchTimestamp:getterSchema,snipeWindow:getterSchema,launchBlock:getterSchema}),
    exemptionEventsExhaustive:z.boolean(), noCooldown:z.boolean(), noEntryLimits:z.boolean(),
  })),
});
export type ManifestReview=z.infer<typeof ManifestReviewSchema>;
export interface ReadEvidence { id:Hex; method:string; params:readonly unknown[]; result:unknown }
export interface CoinManifestStatus {coin:Address;status:'supported'|'unsupported';reason:string|null;inSnipeWindow:boolean|null;route?:PonsCurveRoute;evidenceIds:Hex[]}
export interface ManifestBuild {manifest:ForkCheckManifest;statuses:CoinManifestStatus[];evidence:ReadEvidence[];requests:number}
class Unsupported extends Error {}
const fail=(reason:string):never=>{throw new Unsupported(reason);};
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const zero=`0x${'0'.repeat(40)}` as Address;
const uint=(x:unknown):bigint=>typeof x==='string'&&/^0x[0-9a-f]+$/i.test(x)?BigInt(x):fail('invalid_quantity');
const bytes=(x:unknown):Hex=>typeof x==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(x)?x as Hex:fail('invalid_bytes');
const words=(x:unknown,count:number)=>{const data=bytes(x);if(data.length!==2+count*64)fail('unknown_return_layout');return Array.from({length:count},(_,i)=>BigInt(`0x${data.slice(2+i*64,66+i*64)}`));};
const addr=(x:bigint):Address=>x>=0n&&x<2n**160n?getAddress(toHex(x,{size:20})):fail('invalid_address_word');
const selector=(signature:string)=>toFunctionSelector(signature);
const staticCall=(target:Address,signature:string):PonsStaticCall=>({target,selector:selector(signature),words:[]});
/** Disassemble PUSH operands; require a PUSH4 followed by EQ and a conditional dispatcher jump. */
export function dispatcherSelectors(code:Hex):Set<string> {
  const ops:{op:number;value:string}[]=[];
  for(let i=2;i<code.length;) {
    const op=parseInt(code.slice(i,i+2),16);i+=2;
    const size=op>=0x60&&op<=0x7f?op-0x5f:0;
    const value=code.slice(i,i+size*2);if(value.length!==size*2)break;
    ops.push({op,value});i+=size*2;
  }
  const out=new Set<string>();
  for(let i=0;i<ops.length;i++)if(ops[i].op===0x63&&ops[i+1]?.op===0x14&&
    ops[i+2]?.op>=0x60&&ops[i+2]?.op<=0x7f&&ops[i+3]?.op===0x57)out.add(`0x${ops[i].value.toLowerCase()}`);
  return out;
}
export function exactEthUsd(sqrt:bigint,weth0:boolean,wethDecimals:number,usdgDecimals:number) {
  if(sqrt<=0n||sqrt>=2n**160n||![wethDecimals,usdgDecimals].every(d=>Number.isSafeInteger(d)&&d>=0&&d<=255))fail('invalid_eth_usd');
  const square=sqrt*sqrt,q192=2n**192n;
  let numerator=(weth0?square:q192)*10n**BigInt(wethDecimals),denominator=(weth0?q192:square)*10n**BigInt(usdgDecimals);
  let a=numerator,b=denominator;while(b){[a,b]=[b,a%b];}numerator/=a;denominator/=a;
  return {numerator:numerator.toString(),denominator:denominator.toString()};
}
/** Parameterized, pinned discovery; archive graduation/ready checks are still required for every candidate. */
export async function recentPonsCoins(db:SqlClient,pin:bigint):Promise<Address[]> {
  const result=await db.query<{coin:Uint8Array}>(`SELECT t.address AS coin FROM tokens t JOIN LATERAL
    (SELECT s.block,s.log_index,s.tx_hash FROM swaps s WHERE s.coin=t.address AND s.block<=$1 AND s.venue='pons_curve'
      ORDER BY s.block DESC,s.log_index DESC,s.tx_hash DESC LIMIT 1) latest ON true
    WHERE t.launchpad='pons' AND t.curve IS NOT NULL AND t.first_block<=$1
    AND (t.graduated_block IS NULL OR t.graduated_block>$1)
    ORDER BY latest.block DESC,latest.log_index DESC,latest.tx_hash DESC,t.address`,[pin.toString()]);
  return result.rows.map(r=>getAddress(hex(r.coin)));
}

export async function buildForkManifest(archive:AnvilRpc,registry:AddressRegistry,input:{
  block:bigint|{headMinus:bigint}; coins?:Address[]; fromDb?:{db:SqlClient;count:number}; review?:ManifestReview;
}):Promise<ManifestBuild> {
  if(input.coins?.length&&input.fromDb||!input.coins?.length&&!input.fromDb)throw new Error('Choose coins or from-db');
  if(input.fromDb&&(!Number.isSafeInteger(input.fromDb.count)||input.fromDb.count<1))throw new Error('Invalid from-db count');
  const review=ManifestReviewSchema.parse(input.review??{schemaVersion:'pons-manifest-review-1',deployments:[]});
  const evidence:ReadEvidence[]=[],cache=new Map<Hex,ReadEvidence>();let requests=0;let used=new Set<Hex>();
  const read=async(method:string,params:readonly unknown[])=>{
    const key=referenceDigest({method,params});const prior=cache.get(key);if(prior){used.add(prior.id);return prior.result;}
    requests++;const result=await archive.request({method,params});
    const id=referenceDigest({method,params,result}),entry={id,method,params,result};evidence.push(entry);cache.set(key,entry);used.add(id);return result;
  };
  if(uint(await read('eth_chainId',[]))!==BigInt(CHAIN_ID))throw new Error('Manifest chain mismatch');
  const block=typeof input.block==='bigint'?input.block:uint(await read('eth_blockNumber',[]))-input.block.headMinus;
  if(block<0n||typeof input.block!=='bigint'&&input.block.headMinus<0n)throw new Error('Invalid manifest block');
  const header=await read('eth_getBlockByNumber',[toHex(block),false]) as {number:unknown;hash:Hex;timestamp:unknown};
  if(!header||uint(header.number)!==block)throw new Error('Manifest header mismatch');
  const cursor:GuardCursor=GuardCursorSchema.parse({chainId:CHAIN_ID,blockNumber:block.toString(),blockHash:header.hash,
    timestampSec:uint(header.timestamp).toString(),boundary:'block_end',transactionIndex:null,executionOrdinal:null});
  const pin={blockHash:cursor.blockHash,requireCanonical:true};
  const code=async(address:Address)=>{const c=bytes(await read('eth_getCode',[address,pin]));if(c==='0x')fail('missing_code');return c;};
  const call=async(target:Address,signature:string,args:bigint[]=[],count=1)=>words(await read('eth_call',[
    {to:target,data:`${selector(signature)}${args.map(v=>toHex(v,{size:32}).slice(2)).join('')}`},pin]),count);
  const checkedCall=async(target:Address,dispatch:Set<string>,signature:string,args:bigint[]=[],count=1)=>{
    if(!dispatch.has(selector(signature).toLowerCase()))fail(`missing_selector:${signature}`);
    return call(target,signature,args,count);
  };
  // Same discovery order and greatest-liquidity choice as apps/indexer/src/clients.ts, at this exact pin.
  const weth=registry.requireAddress('tokens.WETH'),usdg=registry.requireAddress('tokens.USDG');
  let best:{pool:Address;sqrt:bigint;liquidity:bigint;weth0:boolean}|undefined;
  const pools=new Set<string>();
  for(const fee of [100n,500n,3000n,10000n]) {
    const pool=addr((await call(registry.requireAddress('uniswapV3.factory'),'getPool(address,address,uint24)',[BigInt(weth),BigInt(usdg),fee]))[0]);
    if(same(pool,zero)||pools.has(pool.toLowerCase()))continue;pools.add(pool.toLowerCase());
    const sqrt=(await call(pool,'slot0()',[],7))[0],liquidity=(await call(pool,'liquidity()'))[0],token0=addr((await call(pool,'token0()'))[0]);
    if(![weth,usdg].some(a=>same(a,token0)))fail('unexpected_eth_usd_currencies');
    if(sqrt>0n&&liquidity>0n&&(!best||liquidity>best.liquidity))best={pool,sqrt,liquidity,weth0:same(token0,weth)};
  }
  if(!best)throw new Error('Pinned ETH USD unavailable');
  const ethUsd={...exactEthUsd(best.sqrt,best.weth0,registry.data.tokens.WETH.decimals!,registry.data.tokens.USDG.decimals!),
    blockHash:cursor.blockHash,evidenceIds:evidence.map(e=>e.id)};
  // On 4663 the Arbitrum receipt exposes the L1 gas component within total gasUsed.
  const receipts=await read('eth_getBlockReceipts',[toHex(block)]) as {blockHash:string;blockNumber:unknown;gasUsed:unknown;gasUsedForL1?:unknown;effectiveGasPrice:unknown;transactionHash:string}[];
  const gasIncludesL1=Array.isArray(receipts)&&receipts.some(r=>same(r.blockHash,cursor.blockHash)&&uint(r.blockNumber)===block&&
    r.gasUsedForL1!==undefined&&uint(r.gasUsedForL1)>0n&&uint(r.gasUsedForL1)<=uint(r.gasUsed)&&uint(r.effectiveGasPrice)>0n);
  const receiptEvidence=evidence.at(-1)!.id;
  const coins=input.coins??await recentPonsCoins(input.fromDb!.db,block);
  const sharedIds=[...used];
  const manifest:ForkCheckManifest={cursor,ethUsd,coins:[]},statuses:CoinManifestStatus[]=[];
  for(const coin of [...new Set(coins.map(a=>getAddress(a)))]) {
    used=new Set(sharedIds);let inSnipeWindow:boolean|null=null;
    try {
      const tokenCode=await code(coin),td=dispatcherSelectors(tokenCode);
      for(const sig of ['balanceOf(address)','allowance(address,address)','approve(address,uint256)'])if(!td.has(selector(sig)))fail(`missing_selector:${sig}`);
      const curve=addr((await checkedCall(coin,td,'curve()'))[0]),factory=addr((await checkedCall(coin,td,'launchFactory()'))[0]);
      if(!same(factory,registry.requireAddress('pons.factory')))fail('unregistered_factory');
      const curveCode=await code(curve),factoryCode=await code(factory),cd=dispatcherSelectors(curveCode),fd=dispatcherSelectors(factoryCode);
      const pins=[{address:coin,codeHash:keccak256(tokenCode)},{address:curve,codeHash:keccak256(curveCode)},{address:factory,codeHash:keccak256(factoryCode)}];
      const c=async(sig:string,args:bigint[]=[])=>checkedCall(curve,cd,sig,args);
      for(const sig of ['buy(uint256,uint256,address)','sell(uint256,uint256,address)','getReserves()','sellableTokens()','graduationThreshold()'])if(!cd.has(selector(sig)))fail(`missing_selector:${sig}`);
      if((await c('graduated()'))[0]!==0n||(await c('readyToGraduate()'))[0]!==0n)fail('graduated_or_ready');
      if(!same(addr((await c('token()'))[0]),coin)||!same(addr((await c('factory()'))[0]),factory)||(await c('pairToken()'))[0]!==0n)fail('unsupported_curve_wiring');
      const binding=review.deployments.find(d=>same(d.coinCodeHash,pins[0].codeHash)&&same(d.curveCodeHash,pins[1].codeHash)&&same(d.factoryCodeHash,pins[2].codeHash))??fail('unknown_factory_layout');
      // Published static record only; an extra/missing word is an unknown deployed layout.
      const launch=await checkedCall(factory,fd,'getLaunchedToken(address)',[BigInt(coin)],15);
      if(!same(addr(launch[0]),coin)||!same(addr(launch[1]),curve)||launch[4]!==0n||launch[10]!==0n||launch[14]!==1n)fail('unknown_factory_layout');
      const launcher=addr(launch[2]),creator=addr(launch[3]);
      const launchTime=(await checkedCall(factory,fd,binding.timing.launchTimestamp,[BigInt(coin)]))[0];
      const window=(await checkedCall(factory,fd,binding.timing.snipeWindow,[BigInt(coin)]))[0];
      const launchBlock=(await checkedCall(factory,fd,binding.timing.launchBlock,[BigInt(coin)]))[0];
      if(launchTime>BigInt(cursor.timestampSec)||launchBlock>block)fail('invalid_launch_timing');
      const decayEndSec=(launchTime+window).toString();
      const snipe=(await c('currentSnipeTaxBps(address)',[BigInt(coin)]))[0];inSnipeWindow=snipe>0n;
      if(snipe>10000n||snipe>0n&&BigInt(decayEndSec)<=BigInt(cursor.timestampSec))fail('inconsistent_snipe_window');
      const fee=(await c('feeBps()'))[0],tax=(await c('creatorTaxBps()'))[0];if(fee>10000n||tax>10000n||tax!==launch[8])fail('invalid_fee_terms');
      const stateReads={tokens:staticCall(curve,'trackedTokens()'),realQuote:staticCall(curve,'realQuoteReserve()'),virtualQuote:staticCall(curve,'phantomQuote()'),reservedTokens:staticCall(curve,'reservedTokens()')};
      const accruals=[staticCall(curve,'quoteFeeBalance()'),staticCall(curve,'creatorTaxBalance()')];
      for(const field of [...Object.values(stateReads),...accruals]) {
        if(!cd.has(field.selector))fail(`missing_selector:${field.selector}`);
        words(await read('eth_call',[{to:curve,data:field.selector},pin]),1);
      }
      const recipients:Address[]=[];for(const sig of ['deployer()','protocolFeeRecipient()','feeEscrow()'])recipients.push(addr((await c(sig))[0]));
      if(!same(recipients[0],creator))fail('creator_recipient_mismatch');
      const topic=keccak256(new TextEncoder().encode('SnipeTaxExempted(address)'));
      const accounts:Address[]=[launcher,creator];
      // Bounded pages cover the entire launch-to-pin interval, not merely indexed discovered wallets.
      for(let from=launchBlock;from<=block;from+=100000n) {
        const to=from+99999n>block?block:from+99999n;
        const logs=await read('eth_getLogs',[{address:curve,fromBlock:toHex(from),toBlock:toHex(to),topics:[topic]}]) as {address:Address;topics:[Hex,...Hex[]];data:Hex;blockNumber:unknown;removed?:boolean}[];
        if(!Array.isArray(logs))fail('invalid_exemption_logs');
        for(const log of logs) {
          if(!same(log.address,curve)||log.removed||uint(log.blockNumber)<from||uint(log.blockNumber)>to)fail('invalid_exemption_logs');
          const event=decodeEventLog({abi:exemptionAbi,eventName:'SnipeTaxExempted',topics:log.topics,data:log.data,strict:true});
          accounts.push(event.args.account);
        }
      }
      const reviewId=referenceDigest(binding),allIds=[...used,reviewId,...binding.evidenceIds];
      const terms=[{kind:'ordinary' as const,base:'gross' as const,bps:fee,fixedWei:0n},{kind:'creator' as const,base:'gross' as const,bps:tax,fixedWei:0n}];
      const route:PonsCurveRoute={venue:'pons_curve',id:`pons:${coin.toLowerCase()}:${cursor.blockHash}`,coin,curve,spender:curve,origin:'measured',
        verification:{blockHash:cursor.blockHash as Hex,profileHash:referenceDigest({pins,launch,fee,tax,snipe,decayEndSec,reviewId}),
          stateFingerprint:referenceDigest({cursor,reads:evidence.filter(e=>used.has(e.id))}),sourceRevision:binding.sourceRevision,evidenceIds:allIds,pins,reviewed:false},
        execution:{buy:{...staticCall(curve,'buy(uint256,uint256,address)'),words:['amount',toHex(0n,{size:32}),'recipient']},sell:{...staticCall(curve,'sell(uint256,uint256,address)'),words:['amount',toHex(0n,{size:32}),'recipient']}},
        stateReads,accruals,buyTerms:snipe>0n?[...terms,{kind:'temporary',base:'gross',bps:snipe,fixedWei:0n}]:terms,sellTerms:terms,
        recipients:[...new Set(recipients)],exemptions:{accounts:[...new Set(accounts)],complete:binding.exemptionEventsExhaustive,evidenceIds:allIds},
        entryLimitSelectors:[],sellCapacitySelectors:[],limits:{maxBuyWei:null,maxWalletTokens:null,evidenceIds:binding.noEntryLimits?[reviewId,...binding.evidenceIds]:[]},
        cooldown:binding.noCooldown?{seconds:0,evidenceIds:[reviewId,...binding.evidenceIds]}:null,decayEndSec,
        feeAccounting:{gasIncludesL1,evidenceIds:gasIncludesL1?[receiptEvidence]:[]},contractClass:'bw-probe'};
      const reason=!binding.exemptionEventsExhaustive?'exemptions_incomplete':!binding.noCooldown?'cooldown_unknown':!binding.noEntryLimits?'entry_limits_unknown':!gasIncludesL1?'l1_receipt_unverified':null;
      statuses.push({coin,status:reason?'unsupported':'supported',reason,inSnipeWindow,route,evidenceIds:allIds});
      if(!reason)manifest.coins.push({kind:'pons',route,matches:[],delaySec:0});
    } catch(error) {
      if(rpcStopReason(error))throw error;
      statuses.push({coin,status:'unsupported',reason:error instanceof Unsupported?error.message:'archive_read_unavailable',inSnipeWindow,evidenceIds:[...used]});
    }
    if(input.fromDb&&statuses.filter(s=>s.reason!=='graduated_or_ready').length>=input.fromDb.count)break;
  }
  // Re-read by number outside the immutable-read cache to detect a reorganization during acquisition.
  requests++;const final=await archive.request({method:'eth_getBlockByNumber',params:[toHex(block),false]}) as {hash?:string;timestamp:unknown;number:unknown};
  if(!final||!same(final.hash??'',cursor.blockHash)||uint(final.timestamp)!==BigInt(cursor.timestampSec)||uint(final.number)!==block)throw new Error('Manifest pin changed');
  const params=[toHex(block),false];evidence.push({id:referenceDigest({method:'eth_getBlockByNumber',params,result:final}),method:'eth_getBlockByNumber',params,result:final});
  return {manifest,statuses,evidence,requests};
}
