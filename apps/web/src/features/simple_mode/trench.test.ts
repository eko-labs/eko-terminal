import { describe, expect, it } from 'vitest';
import type { RadarRow } from '@eko/shared';
import { LENSES, bondProgress, isLens, isSort, matches, sortRows, trenchTags } from './trench';

const row = (over: Partial<RadarRow> & { rank: number }): RadarRow => ({
  address: `0x${String(over.rank).padStart(40, '0')}`, verdict: 'clear', stage: 'curve', ageSec: 7200, change1hPct: 0,
  flow: { activity: undefined }, unavailable: [], ...over,
} as unknown as RadarRow);

describe('trench filters', () => {
  const fresh = row({ rank: 1, ageSec: 600 }), pump = row({ rank: 2, change1hPct: 24 }), bonding = row({ rank: 3, curvePct: 82 }),
    bonded = row({ rank: 4, stage: 'graduated' }), buying = row({ rank: 5, flow: { activity: { buyUsd: 4000, sellUsd: 1000 } } as RadarRow['flow'] }),
    quiet = row({ rank: 6, curvePct: 20, change1hPct: -3 });
  const all = [fresh, pump, bonding, bonded, buying, quiet];
  it('keeps the coins each filter names', () => {
    expect(all.filter(r => matches(r, 'fresh'))).toEqual([fresh]);
    expect(all.filter(r => matches(r, 'pumping'))).toEqual([pump]);
    expect(all.filter(r => matches(r, 'bonding'))).toEqual([bonding]);
    expect(all.filter(r => matches(r, 'bonded'))).toEqual([bonded]);
    expect(all.filter(r => matches(r, 'buying'))).toEqual([buying]);
    expect(all.filter(r => matches(r, 'all'))).toHaveLength(all.length);
  });
  it('never counts a move it could not measure as pumping', () => {
    expect(matches(row({ rank: 7, change1hPct: 40, unavailable: ['change'] }), 'pumping')).toBe(false);
  });
  it('explains every filter in one plain sentence', () => {
    for (const l of LENSES) expect(l.hint).toMatch(/^[A-Z].+\.$/);
  });
  it('sorts newest, biggest movers and market cap, keeping EKO rank on ties', () => {
    expect(sortRows(all, 'new')[0]).toBe(fresh);
    expect(sortRows(all, 'movers')[0]).toBe(pump);
    expect(sortRows([row({ rank: 2, marketCapUsd: 10 }), row({ rank: 1, marketCapUsd: 90 })], 'mcap').map(r => r.rank)).toEqual([1, 2]);
    expect(sortRows([pump, fresh], 'hot').map(r => r.rank)).toEqual([1, 2]);
  });
  it('tags fresh coins and how far along the curve they are, in trench words', () => {
    expect(trenchTags(fresh)).toEqual(['Fresh']);
    expect(trenchTags(bonding)).toEqual(['Bonding 82%']);
    expect(trenchTags(bonded)).toEqual(['Bonded']);
    expect(trenchTags(quiet)).toEqual([]);
    expect(bondProgress(row({ rank: 8 }))).toBeNull();
  });
  it('reads only filters and sorts it knows from storage', () => {
    expect(isLens('fresh') && !isLens('moon')).toBe(true);
    expect(isSort('mcap') && !isSort('random')).toBe(true);
  });
});
