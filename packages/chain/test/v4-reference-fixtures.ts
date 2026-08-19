import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { vi } from 'vitest';
import type { createMeteredClients } from '../src/rpc/clients.js';
import { v4PoolId, type V4ReferenceInput, type V4ReferenceRoute } from '../src/simulation/v4.js';
import { address, hash, cursor } from './reference-fixtures.js';
export { cursor } from './reference-fixtures.js';
export const v4Route:V4ReferenceRoute={venue:'uniswap_v4',id:'fixture-v4-native',coin:address(10),poolId:hash('placeholder'),
  key:{currency0:address(0),currency1:address(10),fee:0,tickSpacing:60,hooks:address(40)},
  manager:address(11),quoter:address(12),stateView:address(13),hookData:'0x1234',origin:'fixture',launchpad:'other',successor:null,
  verification:{blockHash:cursor.blockHash as Hex,reviewed:true,evidenceIds:[hash('fixture-abi-hook-config')],pins:[10,11,12,13,40].map(n=>({address:address(n),codeHash:keccak256('0x1234')}))}};
v4Route.poolId=v4PoolId(v4Route.key);
export const v4Input:V4ReferenceInput={cursor,route:v4Route,sizeUsd:100,sizeWei:1000n};
export function v4Clients(options:{tokens?:bigint;quotedBuy?:bigint;quotedSell?:bigint;returned?:bigint;sellOk?:boolean;liquidity?:bigint;code?:Hex;reorg?:boolean;traceError?:string}={}) {
  let blocks=0;
  const request=vi.fn(async({method,params}:{method:string;params:unknown[]})=>{
    if(method==='eth_getBlockByNumber')return {hash:options.reorg && ++blocks>1?hash('reorg'):cursor.blockHash,timestamp:'0x3e8'};
    if(method==='eth_getCode')return v4Route.verification.pins.some(p=>p.address===params[0])?(options.code??'0x1234'):'0x';
    if(method==='eth_call') {
      const call=params[0] as {to:string;data:Hex};
      if(call.to===v4Route.quoter)return encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[options.quotedBuy??1000n,100n]);
      if(call.data.slice(0,10)==='0xfa6793d5')return encodeAbiParameters([{type:'uint128'}],[options.liquidity??1000n]);
      return encodeAbiParameters([{type:'uint160'},{type:'int24'},{type:'uint24'},{type:'uint24'}],[2n**96n,0,0,0]);
    }
    if(method==='debug_traceCall')return options.traceError?{error:options.traceError}:{output:encodeAbiParameters(
      [{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bool'},{type:'bool'},{type:'bytes'}],
      [options.tokens??1000n,options.quotedSell??1000n,options.returned??1000n,1000n,true,options.sellOk??true,'0x'])};
    throw new Error('Unexpected fixture RPC');
  });
  return {clients:{archive:{request}} as unknown as Pick<ReturnType<typeof createMeteredClients>,'archive'>,request};
}
