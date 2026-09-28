export interface PonsEventRow { block:string;kind:string;data:Record<string,unknown> }
export interface ProgressPoint { block:string;pct?:number }
const units=(value:unknown):bigint|undefined=>typeof value==='string' && /^\d+$/.test(value) ? BigInt(value) : undefined;

/** Pons real quote reserves exclude both trading fees (including anti-snipe) and creator tax.
 * Buy quoteIn is gross input; sell quoteOut is net payout, so sells also remove fee + tax.
 * Preserve missing/invalid history as unavailable, never substitute total-supply inventory.
 */
export function curveProgress(events:readonly PonsEventRow[],launchBlock:number):ProgressPoint[] {
  let threshold:bigint|undefined,reserve=0n,valid=true;
  const points:ProgressPoint[]=[];
  for(const event of events) {
    if(event.kind==='launch') {
      threshold=Number(event.block)===launchBlock ? units(event.data.graduationThreshold) : undefined;
      if(threshold===0n)threshold=undefined;
    } else if(event.kind==='trade') {
      const quote=units(event.data.amountEth),fee=units(event.data.feeEth),tax=units(event.data.taxEth);
      const side=event.data.side;
      if(quote==null || fee==null || tax==null || (side!==1 && side!==-1))valid=false;
      else {
        const delta=side===1 ? quote-fee-tax : -(quote+fee+tax);
        if(side===1 && delta<0n)valid=false;
        reserve+=delta;
        if(reserve<0n)valid=false;
      }
    }
    // Cap the displayed bar only. Keep raw reserve arithmetic exact in bigint units.
    points.push({block:event.block,...(valid && threshold!=null ? {pct:Math.min(100,Number(reserve*10000n/threshold)/100)} : {})});
  }
  return points;
}

export function curveProgressAt(points:readonly ProgressPoint[],block:number):number|undefined {
  let low=0,high=points.length;
  while(low<high){const mid=(low+high)>>>1;if(Number(points[mid].block)<=block)low=mid+1;else high=mid;}
  return points[low-1]?.pct;
}
