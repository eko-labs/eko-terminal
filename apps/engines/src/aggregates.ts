import { gapFromTotals, type AttributionTotals } from './attribution-coverage.js';
import { hex, binary } from '@eko/db';
import type { Address } from '@eko/shared';
import type { SwapRow, Holding } from './sources.js';
/**
 * A row's bytes as a hex address or hash. Encoded each time it is asked for: a cache keyed by the byte array (a
 * WeakMap) held an entry for every byte column of every loaded row, and on the engine's Node (22) each insert got
 * slower as it filled: the columns of 336,000 swaps took 3.9 s into an empty cache, 37 s with 1.3 million entries
 * live and 142 s with 2.7 million (1.5 s without it, every time). On 2026-10-13 a rating of a coin that large took
 * six minutes, during which no other coin was rated.
 */
export function rowHex(bytes:Uint8Array):Address {return hex(bytes) as Address;}
export const ZERO=`0x${'0'.repeat(40)}` as Address,DEAD=`0x${'0'.repeat(36)}dead` as Address;
export const isSink=(holder:Address,coin:Address)=>holder===coin || holder===ZERO || holder===DEAD;
export function prepareSwap(row:SwapRow) {row.traderHex=row.trader!=null && !row.senders_pending ? rowHex(row.trader) : undefined;row.quoteHex=rowHex(row.quote_asset);row.poolHex=rowHex(row.pool_id);row.txHex=rowHex(row.tx_hash);row.sec=new Date(row.ts).getTime()/1000;return row;}
export function prepareHolding(row:Holding){row.holderHex=rowHex(row.holder);return row;}
export function upperTime(rows:SwapRow[],sec:number,end=rows.length) {let low=0,high=end;while(low<high){const mid=(low+high)>>>1;if(rows[mid].sec!<=sec)low=mid+1;else high=mid;}return low;}
export function timeWindow(rows:SwapRow[],start:number,end:number,count=rows.length,monotonic=true) {
  if(!monotonic)return rows.slice(0,count).filter(r=>r.sec!>start && r.sec!<=end);
  return rows.slice(upperTime(rows,start,count),upperTime(rows,end,count));
}
interface Node {wallet:Address;amount:number;priority:number;left?:Node;right?:Node}
const before=(a:Pick<Node,'wallet'|'amount'>,b:Pick<Node,'wallet'|'amount'>)=>a.amount>b.amount || a.amount===b.amount && a.wallet<b.wallet;
function priority(wallet:Address){let hash=2166136261;for(let i=0;i<wallet.length;i++)hash=Math.imul(hash^wallet.charCodeAt(i),16777619);return hash>>>0;}
function merge(a:Node|undefined,b:Node|undefined):Node|undefined {if(!a)return b;if(!b)return a;if(a.priority<b.priority){a.right=merge(a.right,b);return a;}b.left=merge(a,b.left);return b;}
function remove(root:Node|undefined,key:Pick<Node,'wallet'|'amount'>):Node|undefined {if(!root)return;if(root.wallet===key.wallet && root.amount===key.amount)return merge(root.left,root.right);if(before(key,root))root.left=remove(root.left,key);else root.right=remove(root.right,key);return root;}
function insert(root:Node|undefined,node:Node):Node {if(!root)return node;if(before(node,root)){root.left=insert(root.left,node);if(root.left.priority<root.priority){const next=root.left;root.left=next.right;next.right=root;return next;}}else{root.right=insert(root.right,node);if(root.right.priority<root.priority){const next=root.right;root.right=next.left;next.left=root;return next;}}return root;}
/** Ordered positive balances make top-ten queries O(log holders + 10), without sorting at checkpoints. */
export class HolderAggregate {
  amounts=new Map<Address,{amount:bigint;block:number}>();count=0;burned=0n;inventory=0n;private root:Node|undefined;
  constructor(readonly coin:Address,readonly curve:Address|undefined,readonly burnWallet:Address|undefined){}
  positive(wallet:Address){return !isSink(wallet,this.coin) && wallet!==this.curve;}
  set(wallet:Address,amount:bigint,block:number) {
    const prior=this.amounts.get(wallet),old=prior?.amount ?? 0n;
    if(old>0n){if(isSink(wallet,this.coin))this.burned-=old;else if(wallet===this.curve || wallet===this.burnWallet)this.inventory-=old;
      if(this.positive(wallet)){this.count--;this.root=remove(this.root,{wallet,amount:Number(old)});}}
    this.amounts.set(wallet,{amount,block:Math.max(block,prior?.block ?? 0)});
    if(amount>0n){if(isSink(wallet,this.coin))this.burned+=amount;else if(wallet===this.curve || wallet===this.burnWallet)this.inventory+=amount;
      if(this.positive(wallet)){this.count++;this.root=insert(this.root,{wallet,amount:Number(amount),priority:priority(wallet)});}}
  }
  add(wallet:Address,delta:bigint,block:number){this.set(wallet,(this.amounts.get(wallet)?.amount ?? 0n)+delta,block);}
  amount(wallet:Address){const value=this.amounts.get(wallet)?.amount ?? 0n;return value>0n ? value : 0n;}
  top10(){let sum=0,left=10;const visit=(node:Node|undefined)=>{if(!node || !left)return;visit(node.left);if(left){sum+=node.amount;left--;visit(node.right);}};visit(this.root);return sum;}
  /** The `n` largest holders, largest first, skipping wallets `skip` names (pools, for holder concentration). */
  top(n:number,skip:(wallet:Address)=>boolean=()=>false){const out:{wallet:Address;amount:number}[]=[];const visit=(node:Node|undefined)=>{if(!node || out.length>=n)return;visit(node.left);if(out.length<n && !skip(node.wallet))out.push({wallet:node.wallet,amount:node.amount});visit(node.right);};visit(this.root);return out;}
  rows():Holding[]{return [...this.amounts].filter(([,v])=>v.amount>0n).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([holder,v])=>({holder:binary(holder),holderHex:holder,amount:String(v.amount),block:String(v.block)}));}
}
export interface ActorVolume {rows:SwapRow[];buy:number;sell:number}
export interface TradeView {attribution:import('@eko/shared').AttributionCoverageGap;count:number;last?:SwapRow;previous5m?:SwapRow;previous1h?:SwapRow;lastPriced?:SwapRow;usdComplete:boolean;hasEth:boolean;curveVolume:number;curveProgress:number;recent:SwapRow[];actors:Map<Address,ActorVolume>;volumeUsd1h:number;buy1h:number;buyPrevious1h:number;monotonic:boolean}
export class TradeAggregate {
  private attributionTotals:AttributionTotals={totalCount:0,unattributedCount:0,totalVolumeUsd:0,unattributedVolumeUsd:0,unknownVolumeCount:0};
  count=0;lastPriced:SwapRow|undefined;usdComplete=true;hasEth=false;curveVolume=0;curveProgress=0;
  boughtByActor=new Map<Address,number>();actorVolumes=new Map<Address,ActorVolume>();private boughtSets=new Map<string,{count:number;amount:number}>();
  private windowStart=0;private windowEnd=0;private buckets=new Map<Address,SwapRow[]>();
  readonly monotonic:boolean;
  constructor(readonly rows:SwapRow[]){this.monotonic=rows.every((r,i)=>!i || r.sec!>=rows[i-1].sec!);}
  boughtFor(actors:Set<Address>) {if(!actors.size)return 0;const key=[...actors].sort().join(':');const state=this.boughtSets.get(key) ?? {count:0,amount:0};if(state.count>this.count){state.count=0;state.amount=0;}
    for(let i=state.count;i<this.count;i++){const r=this.rows[i];if(r.side===1 && actors.has(r.traderHex!))state.amount+=Number(r.amount_coin);}state.count=this.count;this.boughtSets.set(key,state);return state.amount;}
  advance(count:number,sec:number):TradeView {
    if(count<this.count)throw new Error('Trade aggregate checkpoints must advance');
    for(let i=this.count;i<count;i++){const r=this.rows[i];this.attributionTotals.totalCount++;this.attributionTotals.totalVolumeUsd+=r.usd ?? 0;
      if(!r.traderHex){this.attributionTotals.unattributedCount++;this.attributionTotals.unattributedVolumeUsd+=r.usd ?? 0;if(r.usd==null)this.attributionTotals.unknownVolumeCount++;}
      this.usdComplete &&=r.usd!=null;this.hasEth ||=r.quoteHex===ZERO;
      if(r.usd!=null && Number(r.amount_coin)>0)this.lastPriced=r;
      if(r.traderHex && r.side===1)this.boughtByActor.set(r.traderHex!,(this.boughtByActor.get(r.traderHex!) ?? 0)+Number(r.amount_coin));
      if(r.venue==='pons_curve'){this.curveVolume+=r.usd ?? 0;this.curveProgress+=r.side*(r.usd ?? 0);}}
    this.count=count;
    // A timestamp anomaly falls back to block-bounded filtering, preserving indexed row order.
    const start=this.monotonic ? upperTime(this.rows,sec-3600,count) : 0;
    const recent=this.monotonic ? this.rows.slice(start,count) : this.rows.slice(0,count).filter(r=>r.sec!>sec-3600);
    if(this.monotonic){
      for(let i=this.windowStart;i<Math.min(start,this.windowEnd);i++){const r=this.rows[i];if(!r.traderHex)continue;const bucket=this.buckets.get(r.traderHex)!;bucket.shift();if(!bucket.length)this.buckets.delete(r.traderHex!);}
      for(let i=Math.max(this.windowEnd,start);i<count;i++){const r=this.rows[i];if(!r.traderHex)continue;const bucket=this.buckets.get(r.traderHex) ?? [];bucket.push(r);this.buckets.set(r.traderHex!,bucket);}
      this.windowStart=start;this.windowEnd=count;
    }else{this.buckets.clear();for(const r of recent){if(!r.traderHex)continue;const bucket=this.buckets.get(r.traderHex!) ?? [];bucket.push(r);this.buckets.set(r.traderHex!,bucket);}}
    // Snapshot only the active hour. Preserve row/actor order and floating summation
    // order rather than letting repeated subtraction drift near rule thresholds.
    const actors=new Map<Address,ActorVolume>();let volumeUsd1h=0;
    for(const r of recent){volumeUsd1h+=r.usd ?? 0;if(!r.traderHex)continue;if(!actors.has(r.traderHex!)){const rows=this.buckets.get(r.traderHex!)!.slice();let buy=0,sell=0;for(const row of rows){if(row.side===1)buy+=row.usd ?? 0;else if(row.side===-1)sell+=row.usd ?? 0;}actors.set(r.traderHex!,{rows,buy,sell});}}
    this.actorVolumes=actors;
    const buy=(start:number,end:number)=>timeWindow(this.rows,start,end,count,this.monotonic).reduce((sum,r)=>sum+(r.side===1 ? r.usd ?? 0 : 0),0);
    const previous=(duration:number)=>this.monotonic ? this.rows[upperTime(this.rows,sec-duration,count)-1] : this.rows.slice(0,count).filter(r=>r.sec!<=sec-duration).at(-1);
    return {attribution:gapFromTotals({...this.attributionTotals},'launch_to_checkpoint'),count,last:this.rows[count-1],previous5m:previous(300),previous1h:previous(3600),lastPriced:this.lastPriced,usdComplete:this.usdComplete,hasEth:this.hasEth,curveVolume:this.curveVolume,curveProgress:Math.max(0,this.curveProgress),recent,actors,volumeUsd1h,buy1h:buy(sec-3600,sec),buyPrevious1h:buy(sec-7200,sec-3600),monotonic:this.monotonic};
  }
}
