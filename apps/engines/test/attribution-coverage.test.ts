import { describe,expect,it } from 'vitest';
import { binary } from '@eko/db';
import { attributionGap } from '../src/attribution-coverage.js';
import { prepareSwap,TradeAggregate } from '../src/aggregates.js';
import type { SwapRow } from '../src/sources.js';
const address=`0x${'1'.repeat(40)}` as const,hash=`0x${'1'.repeat(64)}` as const;
const row=(usd:number|null,trader:Uint8Array|null=binary(address),sec=1)=>prepareSwap({block:'1',ts:new Date(sec*1000),tx_hash:binary(hash),log_index:0,trader,
  quote_asset:binary(address),pool_id:binary(address),venue:'pons_curve',side:1,amount_coin:'100',amount_quote:'1',price_quote:1,usd} satisfies SwapRow);
describe('named attribution coverage',()=>{
  it('retains exact 5% as partial coverage and marks either count or volume above 5% incomplete',()=>{
    const rows=[row(1,null),...Array.from({length:19},()=>row(1))];
    expect(attributionGap(rows,'test')).toMatchObject({status:'complete',countShare:0.05,volumeShare:0.05});
    rows[0].usd=2;expect(attributionGap(rows,'test').status).toBe('incomplete');
    rows[0].usd=0;rows.pop();expect(attributionGap(rows,'test').status).toBe('incomplete');
  });
  it('marks unknown missing volume incomplete instead of guessing a zero denominator',()=>{
    expect(attributionGap([row(null,null),...Array.from({length:30},()=>row(1))],'test')).toMatchObject({status:'incomplete',unknownVolumeCount:1});
  });
  it('keeps missing and pending actors out through window eviction and anomalous timestamp fallback',()=>{
    for(const anomalous of [false,true]){
      const rows=[row(10,null,1),row(20,binary(address),anomalous?0:2),row(30,null,3602),row(40,binary(address),3603)];
      rows[2].trader=binary(address);rows[2].senders_pending=true;prepareSwap(rows[2]);
      const aggregate=new TradeAggregate(rows);aggregate.advance(2,2);const view=aggregate.advance(4,3603);
      expect(view.actors.size).toBe(1);expect(view.actors.get(address)!.rows).toEqual([rows[3]]);
      expect(view.volumeUsd1h).toBe(70);expect(view.attribution).toMatchObject({unattributedCount:2,unattributedVolumeUsd:40,totalVolumeUsd:100});
      expect(aggregate.boughtByActor.get(address)).toBe(200);
    }
  });
});
