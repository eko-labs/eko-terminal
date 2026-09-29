import { type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';
import { rowHex } from './aggregates.js';
export interface MarketRow {coin:Address;block:number;sec:number;usd:number}
const bits=new DataView(new ArrayBuffer(8));
/** Exact binary units make ranking independent of accumulation order and float rounding. */
function units(value:number){bits.setFloat64(0,value);const raw=bits.getBigUint64(0),exponent=Number((raw>>52n)&2047n),mantissa=raw&((1n<<52n)-1n);return exponent ? (mantissa|(1n<<52n))<<BigInt(exponent-1) : mantissa;}
function priced(row:MarketRow){return row.usd>0 && Number.isFinite(row.usd);}
function ordered(volumes:Map<Address,bigint>){return new Map([...volumes].sort(([a,x],[b,y])=>x>y?-1:x<y?1:a<b?-1:a>b?1:0).map(([coin],i)=>[coin,i+1]));}
/** Shared pure reference for live reads and retrospective replay snapshots. */
export function exactRanks(rows:readonly MarketRow[],block:number,sec:number){
  const volumes=new Map<Address,bigint>(),cutoff=sec-3600;
  for(const row of rows)if(row.block<=block && row.sec>cutoff && priced(row))volumes.set(row.coin,(volumes.get(row.coin) ?? 0n)+units(row.usd));
  return ordered(volumes);
}
export async function liveRanks(db:ChainDb,block:number,sec:number){
  // PostgreSQL orders NaN above Infinity; this bound excludes both non-finite positives.
  const rows=(await db.sql.query<{coin:Uint8Array;block:string;sec:number;usd:number}>(`SELECT coin,block,extract(epoch FROM ts)::double precision AS sec,usd FROM swaps WHERE block<=$1 AND ts>to_timestamp($2) AND usd>0 AND usd<'Infinity'::double precision`,[block,sec-3600])).rows;
  return exactRanks(rows.map(row=>({coin:rowHex(row.coin),block:Number(row.block),sec:row.sec,usd:row.usd})),block,sec);
}
/** One forward lane; historical requests use the same exact rule over already loaded rows. */
export class MarketWindow {
  readonly rows:MarketRow[];
  private cursor=0;private block=-1;private sec=-Infinity;private heap:number[]=[];private volumes=new Map<Address,bigint>();private dirty=false;private lastRanks:Map<Address,number>|undefined;
  constructor(rows:MarketRow[]){this.rows=rows.filter(priced);}
  private earlier(a:number,b:number){return this.rows[a].sec<this.rows[b].sec || this.rows[a].sec===this.rows[b].sec && a<b;}
  private push(index:number){let slot=this.heap.length;this.heap.push(index);while(slot){const parent=(slot-1)>>>1;if(!this.earlier(index,this.heap[parent]))break;this.heap[slot]=this.heap[parent];slot=parent;}this.heap[slot]=index;}
  private pop(){const first=this.heap[0],last=this.heap.pop()!;if(this.heap.length){let slot=0;while(slot*2+1<this.heap.length){let child=slot*2+1;if(child+1<this.heap.length && this.earlier(this.heap[child+1],this.heap[child]))child++;if(!this.earlier(this.heap[child],last))break;this.heap[slot]=this.heap[child];slot=child;}this.heap[slot]=last;}return first;}
  private change(row:MarketRow,sign:1|-1){const volume=(this.volumes.get(row.coin) ?? 0n)+BigInt(sign)*units(row.usd);this.dirty=true;if(volume)this.volumes.set(row.coin,volume);else this.volumes.delete(row.coin);}
  ranked(block:number,sec:number){
    if(block<this.block || sec<this.sec)return exactRanks(this.rows,block,sec);
    this.block=block;this.sec=sec;const cutoff=sec-3600;
    while(this.cursor<this.rows.length && this.rows[this.cursor].block<=block){const index=this.cursor++,row=this.rows[index];if(row.sec>cutoff){this.change(row,1);this.push(index);}}
    while(this.heap.length && this.rows[this.heap[0]].sec<=cutoff)this.change(this.rows[this.pop()],-1);
    if(!this.dirty && this.lastRanks)return this.lastRanks;
    this.dirty=false;return this.lastRanks=ordered(this.volumes);
  }
}
