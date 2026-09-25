import { describe, expect, it } from 'vitest';
import { checkpoints, type Activity, type CoinActivity } from '../src/activity.js';
const coin = '0x0000000000000000000000000000000000000001' as const;
const event = (block:number,sec:number,kind='swap',price=1):Activity => ({coin,block,sec,kind,price,low:price,high:price});
const activity = (events:Activity[]=[]):CoinActivity => ({coin,firstBlock:1,createdSec:0,events,revision:'fixture'});
const clock = (times:number[]) => times.map((sec,i)=>({number:i+1,sec}));
describe('activity checkpoint cadence',()=>{
 it('uses all early checkpoints and switches from ten-minute to hourly cadence',()=>{
  const times=[0,2,10,60,300,900,1500,2100,2700,3300,3900,6900,10500];
  const points=checkpoints(activity([event(1,0)]),clock(times),1,times.length);
  expect(points.map(p=>p.sec)).toEqual([0,2,10,60,300,900,1500,2100,2700,3300,6900,10500]);
 });
 it('stops at seven idle days and resumes on new activity',()=>{
  const times=[0,300,3900,7*86400,7*86400+1,7*86400+2];
  const points=checkpoints(activity([event(5,7*86400+1,'transfer')]),clock(times),1,times.length);
  expect(points.map(p=>p.block)).toEqual([1,2,3,5]);
 });
 it('bounds the plan by FROM/TO while retaining historical price-change triggers',()=>{
  const times=[0,2,10,60,300,301,302];
  const points=checkpoints(activity([event(1,0),event(6,301,'swap',1.04),event(7,302,'swap',1.06)]),clock(times),5,7);
  expect(points.map(p=>p.block)).toEqual([5,7]);
 });
});
describe('resumed checkpoint plans',()=>{
 // Every block with non-swap activity and a time is checkpointed whatever came before, so a plan resumed right after
 // such a block, from state derived from that block and the newest swap at or before it, equals the plan over the whole
 // history (live-activity.ts resumes live plans this way). Random monotone clocks and histories, random plan starts.
 it('equals the whole-history plan from any later start',()=>{
  let seed=7;const random=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/2**32;};
  const pick=<T,>(items:T[])=>items[Math.floor(random()*items.length)]!;
  let compared=0;
  for(let round=0;round<400;round++){
   const points:{number:number;sec:number}[]=[];let number=10,sec=1000;
   for(let i=0;i<60+Math.floor(random()*120);i++){number+=1+Math.floor(random()*4);sec+=pick([0,2,30,300,600,900,1800,3600,7200,90000]);points.push({number,sec});}
   const launch=points[Math.floor(random()*10)]!,timed=new Map(points.map(p=>[p.number,p]));
   const events:Activity[]=[];
   // Events at blocks with and without a stored time, some before the launch block; one aggregated swap row per block.
   for(let block=points[0]!.number;block<=points.at(-1)!.number;block++){
    if(random()>0.35)continue;
    const at=timed.get(block)?.sec ?? points.find(p=>p.number>block)?.sec ?? points.at(-1)!.sec;
    for(const kind of ['swap','transfer','liquidity','pons'])if(random()<(kind==='swap' ? 0.6 : 0.2)){
     const price=kind==='swap' ? pick([1,1.02,1.06,0.9,1.5,null]) : null;
     events.push({coin,block,sec:at,kind,price,low:price==null ? null : price*pick([1,0.97]),high:price==null ? null : price*pick([1,1.04])});
    }
   }
   const whole:CoinActivity={coin,firstBlock:launch.number,createdSec:launch.sec,events,revision:'fixture'};
   const to=points.at(-1)!.number;
   for(let start=0;start<4;start++){
    const previous=pick(points).number;
    const forced=events.filter(e=>e.block<=previous && e.kind!=='swap' && timed.has(e.block)).at(-1)?.block;
    if(forced===undefined)continue;
    const swap=events.filter(e=>e.block<=forced && e.kind==='swap' && timed.has(e.block)).at(-1);
    const at=timed.get(forced)!.sec,price=swap ? swap.price : null,index=points.findIndex(p=>p.number>forced);
    const resumed=checkpoints({...whole,events:events.filter(e=>e.block>forced)},points,previous+1,to,undefined,{after:forced,index:index<0 ? points.length : index,
     state:{lastRun:at,lastActivity:at,lastTrade:swap ? timed.get(swap.block)!.sec : -Infinity,lastPrice:price,lastObservedPrice:price}});
    expect(resumed).toEqual(checkpoints(whole,points,previous+1,to));
    compared++;
   }
  }
  expect(compared).toBeGreaterThan(800);
 });
});
