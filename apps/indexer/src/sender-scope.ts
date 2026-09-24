import { decodePoolEvents } from './pool-events.js';
import { decodePonsResult, decodeResult, type AddressRegistry } from '@eko/chain';
import { hex, type ChainDb } from '@eko/db';
import type { Address } from 'viem';
import { lower, native } from './clients.js';
import type { TokenRow } from './decode.js';
import type { PoolMetadata, RpcLog } from './types.js';
export interface PoolRow { id: Uint8Array; venue: string; currency0: Uint8Array; currency1: Uint8Array; fee: number; tick_spacing: number; hooks: Uint8Array | null; creation_verified: boolean; created_block: string }
export interface SenderScope { tokens: Set<string>; curves: Map<string,Address>; pools: Map<string,PoolMetadata>; tokenRows: TokenRow[]; poolRows: PoolRow[] }
export async function loadSenderScope(db: ChainDb): Promise<SenderScope> {
  const [tokens,pools]=await Promise.all([
    db.sql.query<TokenRow>('SELECT address,curve,symbol,name,decimals,launchpad,total_supply,supply_block FROM tokens'),
    db.sql.query<PoolRow>('SELECT * FROM pools'),
  ]);
  return {tokens:new Set(tokens.rows.filter(t=>t.launchpad==='pons'||t.curve).map(t=>hex(t.address))),
    curves:new Map(tokens.rows.filter(t=>t.curve).map(t=>[hex(t.curve!),hex(t.address) as Address])),
    pools:new Map(pools.rows.map(p=>[hex(p.id),{currency0:hex(p.currency0) as Address,currency1:hex(p.currency1) as Address,fee:p.fee,tickSpacing:p.tick_spacing}])),tokenRows:tokens.rows,poolRows:pools.rows};
}
/** Event facts activate launches/pools before any sender decision, including same-block trades. */
export function extendSenderScope(scope: SenderScope, logs: RpcLog[], registry: AddressRegistry): SenderScope {
  const next={...scope,tokens:new Set(scope.tokens),curves:new Map(scope.curves),pools:new Map(scope.pools)};
  for(const l of logs) {
    for(const e of decodePonsResult(l,{from:native,to:null},{registry,tokenForCurve:c=>next.curves.get(lower(c))??null}).events) if(e.kind==='launch'){next.tokens.add(lower(e.token));next.curves.set(lower(e.curve),e.token);}
    for(const e of decodePoolEvents(l,{registry}).events) {
      if(e.source==='uniswap_v3'&&e.eventName==='PoolCreated')next.pools.set(lower(e.args.pool),{currency0:e.args.token0,currency1:e.args.token1,fee:e.args.fee,tickSpacing:e.args.tickSpacing});
      if(e.source==='uniswap_v4'&&e.eventName==='Initialize'){next.pools.set(lower(e.args.id),{currency0:e.args.currency0,currency1:e.args.currency1,fee:e.args.fee,tickSpacing:e.args.tickSpacing});if(lower(e.args.hooks)===lower(registry.requireAddress('pons.v4Hook')))for(const a of [e.args.currency0,e.args.currency1])if(![native,lower(registry.requireAddress('tokens.WETH')),lower(registry.requireAddress('tokens.USDG'))].includes(lower(a)))next.tokens.add(lower(a));}
    }
  }
  return next;
}
export function ponsPool(scope: SenderScope, id: string) {
  const p=scope.pools.get(lower(id));return !!p && [p.currency0,p.currency1].some(a=>scope.tokens.has(lower(a)));
}
export function needsSender(l: RpcLog, scope: SenderScope, registry: AddressRegistry): boolean {
  if(decodePonsResult(l,{from:native,to:null},{registry,tokenForCurve:c=>scope.curves.get(lower(c))??null}).events.length)return true;
  return decodePoolEvents(l,{registry,isV3Pool:a=>scope.pools.has(lower(a))}).events.some(e=>(e.source==='uniswap_v3'||e.source==='uniswap_v4') && e.eventName!=='PoolCreated' && ponsPool(scope,e.source==='uniswap_v4'?e.args.id:l.address));
}
