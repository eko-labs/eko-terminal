import type { AttributionCoverageGap } from '@eko/shared';
import type { SwapRow } from './sources.js';

// TODO(spec): no receipt-attribution threshold is specified. Conservatively require
// <=5% missing count AND USD volume; any missing USD on an unattributed row is incomplete.
export const ATTRIBUTION_GAP_THRESHOLD = 0.05;
export const attributedSwap = (r:SwapRow) => r.trader != null && !r.senders_pending;
export interface AttributionTotals {totalCount:number;unattributedCount:number;totalVolumeUsd:number;unattributedVolumeUsd:number;unknownVolumeCount:number}
export function gapFromTotals(totals:AttributionTotals,window:string):AttributionCoverageGap {
  const {totalCount,unattributedCount,totalVolumeUsd,unattributedVolumeUsd,unknownVolumeCount}=totals;
  const countShare=totalCount ? unattributedCount/totalCount : 0,volumeShare=totalVolumeUsd ? unattributedVolumeUsd/totalVolumeUsd : 0;
  const incomplete=countShare>ATTRIBUTION_GAP_THRESHOLD || volumeShare>ATTRIBUTION_GAP_THRESHOLD || unknownVolumeCount>0;
  return {reason:'unattributed_swaps',window,...totals,countShare,volumeShare,threshold:ATTRIBUTION_GAP_THRESHOLD,status:incomplete?'incomplete':'complete'};
}
export function attributionGap(rows:readonly SwapRow[],window:string):AttributionCoverageGap {
  const totals:AttributionTotals={totalCount:rows.length,unattributedCount:0,totalVolumeUsd:0,unattributedVolumeUsd:0,unknownVolumeCount:0};
  for(const r of rows){totals.totalVolumeUsd+=r.usd ?? 0;if(!attributedSwap(r)){totals.unattributedCount++;totals.unattributedVolumeUsd+=r.usd ?? 0;if(r.usd==null)totals.unknownVolumeCount++;}}
  return gapFromTotals(totals,window);
}
