import type { Address, ChartMarker } from '@eko/shared';
import { WALLET_LABEL_WORD } from '../ui';
export const markerId = (m: ChartMarker) => `${m.ts}:${m.wallet}:${m.side}:${m.sizeUsd}:${m.label}`;
export const markerSize = (usd: number) => usd < 100 ? 8 : usd < 1000 ? 10 : 12;
export function burnLabel(m: ChartMarker, ownToken: boolean, wallet?: Address, launchTs?: number) {
  if(!ownToken||m.side!=='buy'||!wallet||m.wallet.toLowerCase()!==wallet.toLowerCase())return undefined;
  return launchTs !== undefined && Math.abs(m.ts-launchTs)<1 ? 'Launch burn' : 'Daily burn';
}
export const markerName = (m: ChartMarker, burn?: string) => `${burn ?? WALLET_LABEL_WORD[m.label]} ${m.side}, $${m.sizeUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}, ${new Date(m.ts*1000).toISOString().slice(11,19)}, wallet ${m.wallet.slice(0,6)}…${m.wallet.slice(-4)}.`;
export interface PositionedMarker { marker: ChartMarker; x: number; y: number }
export interface Cluster extends PositionedMarker { items: PositionedMarker[] }
const priority={declared_agent:0,crew:1,likely_agent:2,human:3};
/** Greedy 15 × 20 px clustering. Spatial bins keep the redraw cost bounded for dense feeds. */
export function clusterMarkers(markers: readonly PositionedMarker[]): Cluster[] {
  const sorted=[...markers].sort((a,b)=>priority[a.marker.label]-priority[b.marker.label]||b.marker.sizeUsd-a.marker.sizeUsd||b.marker.ts-a.marker.ts);
  const out:Cluster[]=[], bins=new Map<string,Cluster[]>();
  for(const p of sorted){const bx=Math.floor(p.x/15),by=Math.floor(p.y/20);let same:Cluster|undefined;
    for(let dx=-1;dx<=1&&!same;dx++)for(let dy=-1;dy<=1&&!same;dy++)same=bins.get(`${bx+dx}:${by+dy}`)?.find(c=>Math.abs(c.x-p.x)<15&&Math.abs(c.y-p.y)<20);
    if(same){same.items.push(p);continue;}const c={...p,items:[p]};out.push(c);const key=`${bx}:${by}`;bins.set(key,[...(bins.get(key)??[]),c]);
  }return out;
}
