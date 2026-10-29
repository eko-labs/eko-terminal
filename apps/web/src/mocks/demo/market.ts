import type { PairRow } from '@eko/shared';
import { createPairRows, newDemoPair } from './pairs';
import { createFeedRows, nextDemoFeed } from './feed';
import { applyPairEvents, feedRing } from '../../pages/terminal/pairsFeedModel';

let started = Date.now(), pairs = createPairRows(), feed = createFeedRows(started), step = 0, feedStep = 0;
const received = new Map(pairs.map((r) => [r.address, started]));
export function pairSnapshot(now = Date.now()) {
  return pairs.map((r) => { const elapsed = Math.max(0, now - (received.get(r.address) ?? started)) / 1000;
    return { ...r, ageSec: r.ageSec + elapsed, antiSnipe: r.antiSnipe && { taxPct: Math.max(0, Math.round(r.antiSnipe.taxPct * Math.max(0, r.antiSnipe.endsInSec - elapsed) / Math.max(1, r.antiSnipe.endsInSec))), endsInSec: Math.max(0, r.antiSnipe.endsInSec - elapsed) } };
  });
}
export const feedSnapshot = () => structuredClone(feed);
export function advancePairs(now = Date.now()): PairRow[] {
  const rows = pairSnapshot(now), next = newDemoPair(step++);
  const updates: PairRow[] = rows.filter((r) => r.verdictPending).map((r) => ({ ...r, verdictPending: false, verdict: r.symbol.text === 'MOTE' ? 'monitor' : 'clear' }));
  const near = rows.find((r) => r.column === 'near_grad');
  if (near) updates.push({ ...near, column: 'migrated', stage: 'graduated', curvePct: 100 });
  const previous = rows.find((r) => r.column === 'new' && BigInt(r.address) >= 8804000n && BigInt(r.address) < BigInt(8804000 + step - 1));
  if (previous) updates.push({ ...previous, column: 'near_grad', curvePct: 90, verdictPending: false, verdict: 'clear' });
  updates.push(next);
  pairs = applyPairEvents(rows, updates.map((data, i) => ({ t: 'ev', ch: 'pairs', kind: 'pair_upsert', data, seq: i, ts: now })));
  started = now; received.clear(); pairs.forEach((r) => received.set(r.address, now));
  return updates;
}
export function advanceFeed(now = Date.now()) { const row = nextDemoFeed(feedStep++, now); feed = feedRing([row, ...feed]); return row; }
