import type { RadarRow } from '@eko/shared';
import { heatOf } from '../../lib/heat';

/**
 * The coin list's quick filters and sorts, in the words people in the trenches use, each with one plain sentence that
 * says what it means (shown under the filters, so a beginner learns the word). Pure, so the list and tests share it.
 */
export type Lens = 'all' | 'fresh' | 'hot' | 'pumping' | 'buying' | 'bonding' | 'bonded';
export const LENSES: readonly { id: Lens; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Every coin EKO follows, busiest first.' },
  { id: 'fresh', label: 'Fresh', hint: 'Launched in the last hour.' },
  { id: 'hot', label: 'Hot', hint: 'Trading a lot more than usual right now.' },
  { id: 'pumping', label: 'Pumping', hint: 'Up 10% or more in the last hour. What goes up fast can fall fast.' },
  { id: 'buying', label: 'Buyers winning', hint: 'More money buying than selling in the last hour.' },
  { id: 'bonding', label: 'About to bond', hint: 'More than 70% of the way to leaving its launch curve for a real pool.' },
  { id: 'bonded', label: 'Bonded', hint: 'Finished its launch curve and now trades in a pool.' },
];
export type SortBy = 'hot' | 'new' | 'movers' | 'volume' | 'mcap';
export const SORTS: readonly { id: SortBy; label: string }[] = [
  { id: 'hot', label: 'Hottest' }, { id: 'new', label: 'Newest' }, { id: 'movers', label: 'Biggest movers' },
  { id: 'volume', label: 'Most traded' }, { id: 'mcap', label: 'Market cap' },
];
export const isLens = (v: unknown): v is Lens => LENSES.some(l => l.id === v);
export const isSort = (v: unknown): v is SortBy => SORTS.some(s => s.id === v);

const FRESH_SEC = 3600, PUMP_PCT = 10, BOND_PCT = 70, BUY_SHARE = 1.3, BUY_MIN_USD = 500;

/** How far along its launch curve a coin is (0-100), 100 once bonded, null when not known. */
export function bondProgress(r: RadarRow): number | null {
  if (r.stage === 'graduated') return 100;
  const p = r.graduationPct ?? r.curvePct;
  return p === undefined ? null : Math.max(0, Math.min(100, p));
}
const change = (r: RadarRow) => (r.unavailable?.includes('change') ? null : r.change1hPct);

export function matches(r: RadarRow, lens: Lens): boolean {
  switch (lens) {
    case 'all': return true;
    case 'fresh': return r.ageSec >= 0 && r.ageSec < FRESH_SEC;
    case 'hot': return heatOf(r) === 'hot';
    case 'pumping': { const c = change(r); return c !== null && c >= PUMP_PCT; }
    case 'buying': { const a = r.flow.activity; return !!a && a.buyUsd >= BUY_MIN_USD && a.buyUsd > a.sellUsd * BUY_SHARE; }
    case 'bonding': { const p = bondProgress(r); return r.stage !== 'graduated' && p !== null && p >= BOND_PCT; }
    case 'bonded': return r.stage === 'graduated';
  }
}

/** A sorted copy. Hottest keeps EKO's own rank; the others fall back to it on ties and for missing numbers. */
export function sortRows(rows: readonly RadarRow[], by: SortBy): RadarRow[] {
  const key: Record<SortBy, (r: RadarRow) => number> = {
    hot: r => -r.rank, new: r => -r.ageSec, movers: r => Math.abs(change(r) ?? 0),
    volume: r => r.volume1hUsd ?? 0, mcap: r => r.marketCapUsd ?? 0,
  };
  const k = key[by];
  return [...rows].sort((a, b) => k(b) - k(a) || a.rank - b.rank);
}

/** Short tags by the ticker, in trench words: Fresh under an hour old, then Bonding 82% on the curve or Bonded. */
export function trenchTags(r: RadarRow): string[] {
  const tags: string[] = [];
  if (r.ageSec >= 0 && r.ageSec < FRESH_SEC) tags.push('Fresh');
  const p = bondProgress(r);
  if (r.stage === 'graduated') tags.push('Bonded');
  else if (p !== null && p >= 50) tags.push(`Bonding ${Math.floor(p)}%`);
  return tags;
}
