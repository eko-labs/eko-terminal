import { describe, expect, it } from 'vitest';
import { createRadarRows } from '../../mocks/demo/radar';
import { applyRadarEvents, currentAgeSec, filterRows, hottest, refused, scanDelayed, SORTS, sortRows } from './radarModel';
import type { ChannelEvent } from '../../lib/realtime';
const event = (kind: string, data: unknown) => ({t:'ev',ch:'radar',seq:1,ts:1,kind,data}) as ChannelEvent<'radar'>;
describe('Radar server order and user sorting', () => {
  it('keeps server Rank order even when numeric rank disagrees', () => { const rows = createRadarRows().reverse(); expect(sortRows(rows,'Rank')).toEqual(rows); expect(sortRows(rows,'Rank')).not.toBe(rows); });
  it('sorts all controls without mutating the snapshot', () => {
    const rows = createRadarRows(), original = structuredClone(rows);
    for (const sort of SORTS) expect(sortRows(rows,sort)).toHaveLength(30);
    for (const [sort,field,direction] of [['1h move','change1hPct',-1],['Newest','ageSec',1],['Exit cost','exitCost1kPct',1]] as const) {
      const sorted = sortRows(rows,sort); for (let i=1;i<sorted.length;i++) expect((sorted[i][field]-sorted[i-1][field])*direction).toBeGreaterThanOrEqual(0);
    }
    expect(SORTS).not.toContain('Signal');
    expect(sortRows(rows,'Agent flow')[0].flow.agentPct).toBe(Math.max(...rows.map(c=>c.flow.agentPct)));
    expect(rows).toEqual(original);
  });
  it('sorts Newest by launch time when rows arrived at different times', () => {
    const [a, b] = createRadarRows().slice(0, 2), received = new Map<string, number>();
    const early = { ...a, ageSec: 5 }, late = { ...b, ageSec: 40 };
    received.set(early.address, 0); received.set(late.address, 120_000); // late launched 85 s after early
    expect(sortRows([early, late], 'Newest').map((c) => c.address)).toEqual([early.address, late.address]);
    expect(sortRows([early, late], 'Newest', received).map((c) => c.address)).toEqual([late.address, early.address]);
    expect(currentAgeSec(early, received, 60_000)).toBe(65); expect(scanDelayed({ ...early, verdictPending: true }, 65)).toBe(true);
  });
  it('preserves ranking and Hottest ordering with missing or changed Signal', () => {
    const rows = createRadarRows().slice(0,2); rows[0].signal = undefined; expect(sortRows(rows,'Rank')).toEqual(rows);
    const before=sortRows(rows,'Hottest').map(c=>c.address); rows[1].signal!.composite=0; expect(sortRows(rows,'Hottest').map(c=>c.address)).toEqual(before);
  });
  it('hides refused coins on request: Danger grades and failed sell checks, on top of any other filter', () => {
    const rows = createRadarRows(), danger = rows.filter(c => c.verdict === 'danger').length;
    expect(danger).toBeGreaterThan(0);
    expect(filterRows(rows, 'All', 'All', true)).toHaveLength(rows.length - danger);
    expect(filterRows(rows, 'Danger', 'All', true)).toHaveLength(0);
    const sold = { ...rows.find(c => c.verdict !== 'danger')!, sellCheck: { status: 'refused' as const, asOfBlock: 1, checkedAt: '2026-10-12T00:00:00.000Z' } };
    expect(refused(sold)).toBe(true); expect(filterRows([sold], 'All', 'All', true)).toHaveLength(0); expect(filterRows([sold], 'All', 'All')).toHaveLength(1);
  });
  it('reads a Danger coin as refused except in Degen mode, and a hard finding or a failed sell as refused in every mode', () => {
    const base = createRadarRows().find(c => c.verdict === 'danger')!;
    const soft = { ...base, hardDanger: undefined, sellCheck: undefined }, hard = { ...soft, hardDanger: true };
    expect([refused(soft, 'safe'), refused(soft, 'balanced'), refused(soft, 'degen')]).toEqual([true, true, false]);
    expect(refused(hard, 'degen')).toBe(true);
    expect(refused({ ...soft, verdict: 'monitor' as const, sellCheck: { status: 'refused' as const, asOfBlock: 1, checkedAt: '2026-10-12T00:00:00.000Z' } }, 'degen')).toBe(true);
    // Hiding refused coins follows the mode: Degen keeps the Danger coins it can buy.
    expect(filterRows([soft, hard], 'All', 'All', true, 'degen').map(c => c.hardDanger)).toEqual([undefined]);
    expect(filterRows([soft, hard], 'All', 'All', true, 'balanced')).toHaveLength(0);
  });
  it('filters stage/verdict/heat and combines filters', () => { const rows=createRadarRows(); expect(filterRows(rows,'Danger','Curve').every(c=>c.verdict==='danger'&&c.stage==='curve')).toBe(true); expect(filterRows(rows,'Hot','All').some(c=>c.verdict==='danger')).toBe(false); expect(filterRows(rows,'All','Migrated').every(c=>c.stage==='graduated')).toBe(true); });
  it('keeps Curve and Migrated for Pons coins and lists coins that launched in a Uniswap pool under their own stage', () => {
    const rows=createRadarRows().slice(0,3), pool={...rows[0],launchpad:'other' as const,stage:'graduated' as const}, curve={...rows[1],launchpad:'pons' as const,stage:'curve' as const}, migrated={...rows[2],launchpad:'pons' as const,stage:'graduated' as const};
    const list=[pool,curve,migrated];
    expect(filterRows(list,'All','Uniswap')).toEqual([pool]); expect(filterRows(list,'All','Migrated')).toEqual([migrated]); expect(filterRows(list,'All','Curve')).toEqual([curve]); expect(filterRows(list,'All','All')).toHaveLength(3);
  });
  it('upserts in place, removes, and applies authoritative rerank', () => {
    const rows=createRadarRows().slice(0,3), changed={...rows[1],change1hPct:99};
    const next=applyRadarEvents(rows,[event('row_upsert',changed),event('row_remove',{address:rows[0].address}),event('rerank',{order:[rows[2].address,rows[1].address]})]);
    expect(next).toEqual([rows[2],changed]); expect(next[0]).toBe(rows[2]); expect(rows[1].change1hPct).not.toBe(99);
    expect(applyRadarEvents(rows,[event('row_upsert',createRadarRows()[3])])).toHaveLength(4);
  });
});
describe('Hot right now strip', () => {
  const rows = () => createRadarRows().map((c, i) => ({ ...c, verdictPending: false, unavailable: ['flow' as const], flow: { ...c.flow, agentPct: 0 },
    verdict: (['clear', 'monitor', 'danger'] as const)[i % 3], change1hPct: 1, trades1h: 20, volumeBaselineUsd: 1_000, volume1hUsd: 500 + i * 100 }));
  it('features Hot coins first, then the most active, and never Danger, unscanned or barely traded coins', () => {
    const list = rows(); list[4] = { ...list[4], volume1hUsd: 5_000 };
    const picked = hottest(list);
    expect(picked).toHaveLength(3);
    expect(picked[0].address).toBe(list[4].address);
    for (const c of picked) { expect(c.verdict).not.toBe('danger'); expect(c.trades1h).toBeGreaterThanOrEqual(5); }
    const volumes = picked.slice(1).map(c => c.volume1hUsd ?? 0); expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
    expect(hottest(list.map(c => ({ ...c, verdictPending: true })))).toEqual([]);
    expect(hottest(list.map(c => ({ ...c, trades1h: 4 })))).toEqual([]);
    expect(hottest(list.map(c => ({ ...c, change1hPct: -0.5 })))).toEqual([]);
    expect(hottest(list.map(c => ({ ...c, unavailable: ['flow', 'volume'] as ('flow' | 'volume')[] })))).toEqual([]);
  });
  it('filters Hot by the tag rows show, including a Danger coin with unusual trading', () => {
    const list = rows(); list[2] = { ...list[2], volume1hUsd: 9_000 };
    expect(list[2].verdict).toBe('danger');
    expect(filterRows(list, 'Hot', 'All').map(c => c.address)).toContain(list[2].address);
  });
});

describe('price and market cap columns', () => {
  it('sorts by price and by market cap, highest first, with unknown values last', async () => {
    const { sortRows, sortAvailable } = await import('./radarModel');
    const base = createRadarRows()[0]!;
    const make = (address: string, priceUsd: number, marketCapUsd: number | undefined, extra: Partial<typeof base> = {}) =>
      ({ ...base, address, priceUsd, marketCapUsd, unavailable: marketCapUsd === undefined ? ['marketCap'] : [], ...extra }) as typeof base;
    const list = [make('0xa', 0.001, 1000), make('0xb', 0.5, 50_000), make('0xc', 0.02, undefined, { priceUnavailable: true })];
    expect(sortRows(list, 'Price').map(r => r.address)).toEqual(['0xb', '0xa', '0xc']);
    expect(sortRows(list, 'Market cap').map(r => r.address)).toEqual(['0xb', '0xa', '0xc']);
    expect(sortAvailable([list[2]!], 'Price')).toBe(false);
  });
  it('remembers which columns show, keeping only known ones in table order', async () => {
    const { parseColumns, hiddenColumnClasses, DEFAULT_COLUMNS } = await import('./radarModel');
    expect(parseColumns(null)).toEqual([...DEFAULT_COLUMNS]);
    expect(parseColumns('not json')).toEqual([...DEFAULT_COLUMNS]);
    expect(parseColumns(JSON.stringify(['exit', 'price', 'bogus']))).toEqual(['price', 'exit']);
    expect(hiddenColumnClasses(['price', 'mcap'])).toContain(' hide-watch');
    expect(hiddenColumnClasses(['price', 'mcap'])).not.toContain('hide-price');
  });
});
