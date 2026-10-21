import { binary, hex, type BusMessage, type EngineBus } from '@eko/db';
import { type Address, type Tick, type Verdict } from '@eko/shared';
import type { ReadServices } from '../http/v1/reads.js';
import type { Hub } from '../ws/hub.js';
import { reportError } from '../obs/errors.js';
export class ReadLive {
  private closed=false;
  private unsubscribe?:()=>Promise<void>;
  private unwatch?:()=>void;
  private queue:Promise<void>=Promise.resolve();
  private rerank?:ReturnType<typeof setTimeout>;
  private timer?:ReturnType<typeof setInterval>;
  private flows=new Map<Address,import('@eko/shared').Flow>();
  private markers=new Map<string,string>();
  private ticks=new Map<Address,Tick>();
  private priceVerdicts=new Map<Address,Verdict>();
  private priceFacts=new Map<Address,string>();
  private seen=new Set<string>();
  private swaps=new Set<string>();
  constructor(readonly services:ReadServices,readonly hub:Hub) {}
  async start(bus:EngineBus) {
    this.unwatch=this.services.store.onRefreshed(coins=>{
      if(this.closed)return;
      this.queue=this.queue.then(async()=>{for(const coin of coins)await this.upsert(coin);}).catch(error=>reportError(error,{where:'read refresh live'}));
    });
    this.unsubscribe=await bus.subscribe(message=>{
      if(this.closed)return;
      if(!['flow_updated','card_updated','verdict_created','pair_created','swap','guard_verdict_created','guard_revision_invalidated'].includes(message.topic))return;
      this.queue=this.queue.then(()=>this.handle(message)).catch(error=>reportError(error,{where:'read live'}));
    });
    this.timer=setInterval(()=>{for(const [coin,tick] of this.ticks)this.hub.publish<'coin','tick'>(`coin:${coin}`,'tick',tick);this.ticks.clear();for(const [coin,verdict] of this.priceVerdicts)this.hub.publish<'coin','verdict'>(`coin:${coin}`,'verdict',verdict);this.priceVerdicts.clear();for(const [coin,flow] of this.flows)this.hub.publish<'flow','flow'>(`flow:${coin}`,'flow',flow);this.flows.clear();},1000);
    this.timer.unref();
  }
  async drain(){for(;;){const queue=this.queue;await queue;if(queue===this.queue)return;}}
  private async handle(message:BusMessage) {
    const db=this.services.store.db;
    let coin=message.ids.coin as Address | undefined;
    let block:number | undefined;
    if(message.topic==='flow_updated') {
      if(!coin)return;
      const flow=await this.services.coins.flow(coin,'1h');if(flow)this.flows.set(coin,flow);
      const events=(await db.sql.query<{id:string;data:import('@eko/shared').FlowEvent}>(`SELECT e.id,e.data FROM flow_events e JOIN chain_blocks b ON b.number=e.block AND b.hash=e.block_hash WHERE e.model_version=(SELECT model_version FROM watcher_flow_model WHERE singleton) AND e.coin=$1 AND e.block<=$2 AND e.ts>(SELECT as_of FROM flow_windows WHERE coin=e.coin AND window_kind='24h')-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM flow_dirty d WHERE d.coin=e.coin) ORDER BY e.ts,e.id LIMIT 5000`,[binary(coin),message.ids.block])).rows;
      for(const event of events){const data={...event.data,beta:flow?.beta??true},revision=JSON.stringify(data);if(this.markers.get(event.id)===revision)continue;this.markers.set(event.id,revision);if(this.markers.size>5000)this.markers.delete(this.markers.keys().next().value!);this.hub.publish<'flow','marker'>(`flow:${coin}`,'marker',data);}
      await this.upsert(coin);return;
    }
    if(message.topic==='guard_verdict_created' || message.topic==='guard_revision_invalidated') {
      const affected=message.topic==='guard_verdict_created' ? (await db.sql.query<{coin:string}>('SELECT coin FROM guard_verdict_revisions WHERE id=$1',[message.ids.id])).rows : (await db.sql.query<{coin:string}>(`SELECT DISTINCT coin FROM guard_verdict_revisions WHERE id IN (SELECT target_id FROM guard_verdict_events WHERE id=$1)`,[message.ids.id])).rows;
      for(const row of affected)if(this.hub.hasV2Subscribers(row.coin as Address)) {const card=await this.services.guard.card(row.coin as Address);this.hub.publishV2(row.coin as Address,'card',card);this.hub.publishV2(row.coin as Address,'verdict',card?.verdict ?? null);}
      return;
    }
    if(message.topic==='card_updated' || message.topic==='verdict_created') {
      const card=message.topic==='card_updated';
      const result=await db.sql.query<{coin:Uint8Array;data:unknown;valid_from_block:string}>(`SELECT coin,data,valid_from_block FROM ${card ? 'coin_cards' : 'verdicts'} WHERE id=$1`,[message.ids.id]);
      const source=result.rows[0];if(!source)return;
      coin=hex(source.coin);block=Number(source.valid_from_block);
      if(card){const projected=await this.services.coins.card(coin);if(projected){this.hub.publish<'coin','card'>(`coin:${coin}`,'card',projected);this.hub.publish<'coin','verdict'>(`coin:${coin}`,'verdict',projected.verdict);block=projected.verdict.lastChecked?.block ?? block;}}
      else {const projected=await this.services.coins.verdict(coin);if(projected)this.hub.publish<'coin','verdict'>(`coin:${coin}`,'verdict',projected);}
    } else if(message.topic==='swap') {
      const result=await db.sql.query<{coin:Uint8Array;ts:Date;block:string;usd:number | null;amount_coin:string;decimals:number | null}>(`SELECT s.*,t.decimals FROM swaps s JOIN tokens t ON t.address=s.coin WHERE tx_hash=$1 AND log_index=$2 AND s.ts>to_timestamp($3::double precision)-interval '1 hour' ORDER BY ts DESC LIMIT 1`,
        // A swap notice is for a trade that just happened. Without the time bound the lookup walks the swaps' time index
        // backwards until it meets the hash: a notice for an old swap took 18 seconds (2026-10-13).
        [binary(String(message.ids.txHash)),message.ids.logIndex,this.services.store.now()/1000]);
      const swap=result.rows[0];if(!swap)return;
      const key=`${message.ids.txHash}:${message.ids.logIndex}`;
      if(this.swaps.has(key))return;this.swaps.add(key);if(this.swaps.size>5000)this.swaps.delete(this.swaps.values().next().value!);
      coin=hex(swap.coin);block=Number(swap.block);
      if(swap.usd!=null && swap.decimals!=null && Number(swap.amount_coin)>0)this.ticks.set(coin,{ts:new Date(swap.ts).getTime()/1000,block,price:swap.usd/(Number(swap.amount_coin)/10**swap.decimals),volumeUsd:swap.usd+(this.ticks.get(coin)?.volumeUsd ?? 0)});
    } else {
      const result=await db.sql.query<{address:Uint8Array;created_block:string}>('SELECT t.address,p.created_block FROM pools p JOIN tokens t ON t.address IN(p.currency0,p.currency1) WHERE p.id=$1',[binary(String(message.ids.id))]);
      for(const token of result.rows)await this.upsert(hex(token.address),Number(token.created_block));
      return;
    }
    if(coin) {
      await this.upsert(coin,block);
      if(this.hub.hasV2Subscribers(coin))this.hub.publishV2(coin,'card',await this.services.guard.card(coin));
    }
  }
  private async upsert(coin:Address,block?:number) {
    const entry=(await this.services.store.rows(coin))[0];
    // Price facts are live measurements, independent of the rating queue. Coalesce them with ticks so coin pages
    // see a crash within the next second, while lastChecked still identifies the last completed engine check.
    if(entry?.card) {
      const fact=JSON.stringify(entry.card.verdict.priceMove ?? null);
      if(this.priceFacts.get(coin)!==fact) {this.priceFacts.set(coin,fact);this.priceVerdicts.set(coin,entry.card.verdict);}
      if(this.priceFacts.size>5000)this.priceFacts.delete(this.priceFacts.keys().next().value!);
    }
    const row=entry?.eligible && this.services.store.now()-entry.activity<7*86400000 ? entry.row : null;
    if(row)this.hub.publish<'radar','row_upsert'>('radar','row_upsert',row);
    else this.hub.publish<'radar','row_remove'>('radar','row_remove',{address:coin});
    const pair=await this.services.pairs.row(coin);
    if(pair) {
      for(const column of ['new','near_grad','migrated'] as const)if(column!==pair.column)this.hub.publish<'pairs','pair_remove'>('pairs','pair_remove',{address:coin,column});
      this.hub.publish<'pairs','pair_upsert'>('pairs','pair_upsert',pair);
    }
    if(!this.rerank && !this.closed) {
      this.rerank=setTimeout(()=>{
        if(this.closed)return;
        this.queue=this.queue.then(async()=>{try {this.hub.publish<'radar','rerank'>('radar','rerank',{order:await this.services.radar.order()});} finally {this.rerank=undefined;}}).catch(error=>reportError(error,{where:'read rerank'}));
      },1000);this.rerank.unref();
    }
    for(const item of (await this.services.feed.all(undefined,coin,block)).reverse()) {
      if(this.seen.has(item.id))continue;
      this.seen.add(item.id);if(this.seen.size>5000)this.seen.delete(this.seen.values().next().value!);
      this.hub.publish<'feed','item'>('feed','item',item);
    }
  }
  async close(){this.closed=true;this.unwatch?.();await this.unsubscribe?.();if(this.timer)clearInterval(this.timer);if(this.rerank)clearTimeout(this.rerank);await this.queue;}
}
