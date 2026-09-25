import { describe, expect, it } from 'vitest';
import { binary, emptyLifetime, packSwap, addLifetimeLiquidity } from '@eko/db';
import { blueChipMeasurements } from '../src/blue-chip.js';
import type { LoadedSources } from '../src/sources.js';
const coin=`0x${'11'.repeat(20)}` as const,quote=`0x${'22'.repeat(20)}` as const,pool=`0x${'33'.repeat(20)}` as const;
function fixture(pons=false):LoadedSources {
  return {coin,launchpad:pons?'pons':'other',asOfBlock:10,blueChipHolderCount:250,
    token:{curve:pons?binary(`0x${'44'.repeat(20)}`):null,graduated_block:pons?'9':null},
    poolRefs:[{id:pool,quote}],holdings:[],
    events:[{pool_id:binary(pool),block:'9',kind:'ModifyLiquidity',data:{tickLower:'-887200',tickUpper:'887200',liquidityDelta:'10000'}}],
    swaps:[{pool_id:binary(pool),block:'10',venue:'uniswap_v4',amount_coin:'100',amount_quote:'100',usd:100}],
  } as unknown as LoadedSources;
}
describe('Blue chip latest measurements',()=>{
  it('measures both sides of a graduated launchpad pool and Uniswap launch pool',()=>{
    for(const pons of [true,false]){const m=blueChipMeasurements(fixture(pons));expect(m.realPool).toBe(true);expect(m.liquidityUsd).toBeCloseTo(20000,4);expect(m.holders).toBe(250);}
  });
  it('values every pool from retained summaries after its last raw trade is deleted',()=>{
    const s=fixture(),before=blueChipMeasurements(s),life=emptyLifetime();
    const trade={...s.swaps[0],ts:new Date('2026-10-01'),tx_hash:binary(`0x${'ab'.repeat(32)}`),log_index:0,quote_asset:binary(quote),trader:null,side:1,price_quote:1};
    life.poolLastPriced={[pool]:packSwap(trade)};
    addLifetimeLiquidity(life,s.events.map(e=>({...e,tx_hash:trade.tx_hash,log_index:0,actor:null})),s.launchpad,'');
    s.lifetime=life;s.swaps=[];s.events=[];
    expect(blueChipMeasurements(s)).toEqual(before);
  });
  it('rejects an ungraduated curve even if somebody opened a pool for it',()=>{
    const s=fixture(true);s.token.graduated_block=null;expect(blueChipMeasurements(s).realPool).toBe(false);
  });
  it('does not claim an unpriced pool value or count a future trade',()=>{
    const s=fixture();s.swaps[0].block='11';expect(blueChipMeasurements(s)).toMatchObject({realPool:false,liquidityUsd:null});
  });
  it('subtracts removed liquidity and retains a measured zero after all positions are removed',()=>{
    const s=fixture();s.events.push({...s.events[0],kind:'Burn',data:{...s.events[0].data,amount:'10000',liquidityDelta:'10000'}});
    expect(blueChipMeasurements(s).liquidityUsd).toBe(0);
  });
  it('counts positive external holders while excluding inventory and sinks',()=>{
    const s=fixture(true);delete s.blueChipHolderCount;
    s.holdings=[{holder:binary(coin),amount:'10',block:'10'},{holder:binary(pool),amount:'10',block:'10'},{holder:s.token.curve!,amount:'10',block:'10'},
      {holder:binary(quote),amount:'10',block:'10'},{holder:binary(`0x${'55'.repeat(20)}`),amount:'0',block:'10'}];
    expect(blueChipMeasurements(s).holders).toBe(1);
  });
});
