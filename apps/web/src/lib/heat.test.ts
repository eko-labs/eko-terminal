import { describe, expect, it } from 'vitest';
import { createRadarRows } from '../mocks/demo/radar';
import { activityHot, displayHeat, heatOf, HOT, marking, markClass } from './heat';
const coin = (change1hPct: number, score: number, agents: number) => { const c = createRadarRows()[0]; return { ...c, verdict: 'clear' as const, change1hPct, flow: { ...c.flow, agentPct: agents }, signal: { ...c.signal!, composite: score } }; };
describe('prototype heat and dither thresholds', () => {
  it.each([[3,60,25,'shimmer',1], [0,70,30,'shimmer',2], [10,70,40,'shimmer',3], [-8,64,10,'ember',1]] as const)('marks %s%%, signal %s, agents %s', (move, signal, flow, kind, level) => expect(marking(coin(move,signal,flow))).toEqual({ kind, level }));
  it('checks exact boundaries and pending precedence', () => {
    expect(marking(coin(2.9,60,25))).toBeNull(); expect(marking(coin(3,59,25))).toBeNull(); expect(marking(coin(3,60,24.9))).toBeNull();
    expect(marking(coin(-8,65,10))).toBeNull(); expect(heatOf(coin(-2,61,20))).toBe('fading'); expect(heatOf(coin(-2,62,20))).toBe('normal');
    expect(heatOf(coin(0,70,30))).toBe('hot'); expect(heatOf(coin(0,69,30))).toBe('normal');
    expect(marking(coin(10,90,80), {pending:true})).toBeNull(); expect(heatOf(coin(10,90,80), {pending:true})).toBe('scanning');
  });
  it('Danger wins over activity and carries red flags', () => {
    const c = { ...coin(30,90,80), verdict:'danger' as const, exitCost1kPct:74.9, topPlaybook:undefined };
    expect(heatOf(c)).toBe('avoid'); expect(marking(c)).toEqual({kind:'ember',level:2});
    for (const red of [{...c,exitCost1kPct:75},{...c,topPlaybook:'honeypot' as const}]) expect(marking(red)).toEqual({kind:'ember',level:3});
    expect(marking(c,{redFlag:true})).toEqual({kind:'ember',level:3});
  });
  it('applies remaining predicates without inventing optional readings', () => {
    for (const [move, agents, expected] of [[3,25,'mk-shimmer-1'],[0,30,'mk-shimmer-2'],[10,40,'mk-shimmer-3'],[-8,10,'mk-ember-1']] as const) expect(markClass(marking({...coin(move,50,agents),signal:undefined}))).toBe(expected);
    expect(markClass(null)).toBe('');
  });
});
describe('Hot from trading activity, for any coin', () => {
  // Agent flow unmeasured, as on live rows today: only the activity path can make a coin Hot.
  const live = (volume1hUsd: number, trades1h: number, volumeBaselineUsd: number | undefined, change1hPct = 2, verdict: 'clear' | 'danger' = 'clear') => {
    const c = createRadarRows()[0];
    return { ...c, verdict, verdictPending: false, change1hPct, unavailable: ['flow' as const], flow: { ...c.flow, agentPct: 0 }, volume1hUsd, trades1h, volumeBaselineUsd };
  };
  it('needs last-hour volume at least three times the usual hour, with real trades and a price that is not falling', () => {
    expect(heatOf(live(3_000, 10, 1_000))).toBe('hot');
    expect(heatOf(live(2_999, 40, 1_000))).toBe('normal');
    expect(heatOf(live(30_000, 9, 1_000))).toBe('normal');
    expect(heatOf(live(999, 40, 100))).toBe('normal');
    expect(heatOf(live(30_000, 40, 1_000, -0.1))).not.toBe('hot');
    // A dormant coin waking up has a usual hour of zero, so any qualifying hour is unusual.
    expect(heatOf(live(1_000, 10, 0))).toBe('hot');
  });
  it('asks a coin with no earlier trading for a busy first hour instead', () => {
    expect(heatOf(live(HOT.newVolumeUsd, HOT.newTrades, undefined))).toBe('hot');
    expect(heatOf(live(HOT.newVolumeUsd - 1, 200, undefined))).toBe('normal');
    expect(heatOf(live(50_000, HOT.newTrades - 1, undefined))).toBe('normal');
  });
  it('reads heavy trading as Hot whatever the usual hour, unless the price is falling', () => {
    // A coin a few hours past its launch: $21,600 and 202 trades in the hour against a $271,650 usual hour.
    expect(heatOf(live(21_600, 202, 271_650, 3.4))).toBe('hot');
    expect(heatOf(live(HOT.heavyVolumeUsd, HOT.heavyTrades, 1_000_000))).toBe('hot');
    expect(heatOf(live(HOT.heavyVolumeUsd - 1, 500, 1_000_000))).toBe('normal');
    expect(heatOf(live(500_000, HOT.heavyTrades - 1, 1_000_000))).toBe('normal');
    expect(heatOf(live(21_600, 202, 271_650, -5))).not.toBe('hot');
    // A Danger row keeps its styling and still says Hot.
    expect(displayHeat(live(21_600, 202, 271_650, 3.4, 'danger'))).toBe('hot');
  });
  it('never reads Hot from a missing reading, and keeps agent buying as a second path', () => {
    expect(activityHot({ ...live(30_000, 40, 1_000), unavailable: ['flow', 'volume'] })).toBe(false);
    expect(activityHot({ ...live(30_000, 40, 1_000), volume1hUsd: undefined })).toBe(false);
    expect(heatOf(coin(0, 70, 30))).toBe('hot');
  });
  it('keeps Danger styling but still says Hot on a Danger coin with unusual trading', () => {
    const danger = live(30_000, 40, 1_000, 5, 'danger');
    expect(heatOf(danger)).toBe('avoid'); expect(displayHeat(danger)).toBe('hot'); expect(marking(danger)?.kind).toBe('ember');
    expect(displayHeat(live(100, 1, 1_000, 5, 'danger'))).toBe('avoid');
  });
});
