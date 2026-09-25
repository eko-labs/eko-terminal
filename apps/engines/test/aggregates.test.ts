import { describe,expect,it } from 'vitest';
import { binary } from '@eko/db';
import type { Address } from '@eko/shared';
import { HolderAggregate,TradeAggregate,prepareSwap,ZERO,DEAD } from '../src/aggregates.js';
import type { SwapRow } from '../src/sources.js';
const address=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
const coin=address(1),curve=address(2),burn=address(3),deployer=address(4);
function random(){let state=77;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};}
function trades(){return Array.from({length:6000},(_,i)=>{const block=Math.floor(i/30)+1;return prepareSwap({block:String(block),ts:new Date(block*3600000),tx_hash:binary(`0x${i.toString(16).padStart(64,'0')}`),log_index:i%30,trader:binary(address(100+i%73)),quote_asset:binary(i%11 ? ZERO : burn),pool_id:binary(curve),venue:i%7 ? 'pons_curve' : 'uniswap_v3',side:i%3 ? 1 : -1,amount_coin:String(100+i%13),amount_quote:'1',price_quote:1+i/10000,usd:i===5001 ? null : i%17/3} satisfies SwapRow);});}
describe('incremental replay aggregates',()=>{
 it('matches independent from-scratch balances and trade reductions at randomized checkpoints',()=>{
  const next=random(),checkpoints=[...new Set([0,1,199,200,...Array.from({length:80},()=>next()%201)])].sort((a,b)=>a-b);
  const updates=Array.from({length:8000},(_,i)=>({block:Math.floor(i/40)+1,wallet:i%97===0 ? [ZERO,DEAD,coin,curve,burn,deployer][i%6] : address(100+next()%2400),delta:BigInt(i%5 ? 100+i%19 : -300)}));
  const rows=trades(),holders=new HolderAggregate(coin,curve,burn),trade=new TradeAggregate(rows);let cursor=0;
  for(const block of checkpoints){
   while(cursor<updates.length && updates[cursor].block<=block){const u=updates[cursor++];holders.add(u.wallet,u.delta,u.block);}
   const expected=new Map<Address,bigint>();for(const u of updates)if(u.block<=block)expected.set(u.wallet,(expected.get(u.wallet) ?? 0n)+u.delta);
   const balances=[...expected].filter(([,amount])=>amount>0n).sort(([a],[b])=>a.localeCompare(b));
   const sink=(wallet:Address)=>wallet===coin || wallet===ZERO || wallet===DEAD;
   const positive=balances.filter(([wallet])=>!sink(wallet) && wallet!==curve);
   expect(holders.count).toBe(positive.length);
   expect(holders.burned).toBe(balances.filter(([wallet])=>sink(wallet)).reduce((n,[,amount])=>n+amount,0n));
   expect(holders.inventory).toBe(balances.filter(([wallet])=>!sink(wallet) && (wallet===curve || wallet===burn)).reduce((n,[,amount])=>n+amount,0n));
   expect(holders.top10()).toBe([...positive].sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,10).reduce((n,[,amount])=>n+Number(amount),0));
   expect(holders.rows().map(r=>[r.holderHex,BigInt(r.amount)])).toEqual(balances);
   const prefix=rows.filter(r=>Number(r.block)<=block),sec=block*3600,recent=prefix.filter(r=>new Date(r.ts).getTime()/1000>sec-3600);
   const view=trade.advance(prefix.length,sec),actors=new Set(recent.map(r=>r.traderHex!));
   expect(view.count).toBe(prefix.length);expect(view.recent).toEqual(recent);expect(view.last).toBe(prefix.at(-1));
   expect(view.lastPriced).toBe(prefix.filter(r=>r.usd!=null && Number(r.amount_coin)>0).at(-1));
   expect(view.usdComplete).toBe(prefix.every(r=>r.usd!=null));expect(view.hasEth).toBe(prefix.some(r=>r.quoteHex===ZERO));
   expect(view.curveVolume).toBe(prefix.filter(r=>r.venue==='pons_curve').reduce((n,r)=>n+(r.usd ?? 0),0));
   expect(view.curveProgress).toBe(Math.max(0,prefix.filter(r=>r.venue==='pons_curve').reduce((n,r)=>n+r.side*(r.usd ?? 0),0)));
   expect(view.volumeUsd1h).toBe(recent.reduce((n,r)=>n+(r.usd ?? 0),0));
   for(const actor of actors){const actorRows=recent.filter(r=>r.traderHex===actor);expect(view.actors.get(actor)).toEqual({rows:actorRows,buy:actorRows.filter(r=>r.side===1).reduce((n,r)=>n+(r.usd ?? 0),0),sell:actorRows.filter(r=>r.side===-1).reduce((n,r)=>n+(r.usd ?? 0),0)});}
   const exempt=new Set([address(100+block%7),address(108)]);
   expect(trade.boughtFor(exempt)).toBe(prefix.filter(r=>r.side===1 && exempt.has(r.traderHex!)).reduce((n,r)=>n+Number(r.amount_coin),0));
   for(const actor of new Set(prefix.map(r=>r.traderHex!)))expect(trade.boughtByActor.get(actor) ?? 0).toBe(prefix.filter(r=>r.side===1 && r.traderHex===actor).reduce((n,r)=>n+Number(r.amount_coin),0));
   for(const [field,start,end] of [['buy1h',sec-3600,sec],['buyPrevious1h',sec-7200,sec-3600]] as const)expect(view[field]).toBe(prefix.filter(r=>r.side===1 && r.sec!>start && r.sec!<=end).reduce((n,r)=>n+(r.usd ?? 0),0));
  }
 });
 it('preserves row order with anomalous timestamps, and bounds same-block rows and exact window edges',()=>{
  const rows=trades().slice(0,6);rows[0].sec=3600;rows[1].sec=1;rows[2].sec=7200;rows[3].sec=3601;rows[4].sec=3600;rows[5].sec=7201;
  const aggregate=new TradeAggregate(rows),view=aggregate.advance(5,7200);
  expect(view.monotonic).toBe(false);expect(view.recent).toEqual([rows[2],rows[3]]);expect(view.buyPrevious1h).toBe(rows.slice(0,5).filter(r=>r.side===1 && r.sec!>0 && r.sec!<=3600).reduce((n,r)=>n+r.usd!,0));
 });
});
