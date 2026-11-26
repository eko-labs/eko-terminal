import { describe, expect, it } from 'vitest';
import { EkoScoreSchema } from '../src/contracts/coin.js';
import { EKO_SCORE_BANDS, ekoScore, exitPart, holdersPart, momentumPart, moneyPart, playbookLabel, type EkoScoreInput } from '../src/score.js';

const strong: Omit<EkoScoreInput, 'verdict'> = { change1hPct: 40, volume1hUsd: 80_000, volumeBaselineUsd: 10_000, buyUsd1h: 70, sellUsd1h: 30,
  liquidityUsd: 200_000, marketCapUsd: 800_000, top10Pct: 15, devPct: 0, earlyHeldPct: 2, exitCost1kPct: 1 };
const weak: Omit<EkoScoreInput, 'verdict'> = { change1hPct: -40, volume1hUsd: 100, volumeBaselineUsd: 10_000, buyUsd1h: 10, sellUsd1h: 90,
  liquidityUsd: 300, marketCapUsd: 900_000, top10Pct: 90, devPct: 20, earlyHeldPct: 40, exitCost1kPct: 60 };
const middling: Omit<EkoScoreInput, 'verdict'> = { change1hPct: 0, buyUsd1h: 50, sellUsd1h: 50, liquidityUsd: 5_000, marketCapUsd: 60_000,
  top10Pct: 40, devPct: 3, exitCost1kPct: 8 };
const bandOf = { danger: 'danger', monitor: 'careful', clear: 'ok' } as const;

/** A small deterministic generator, so the property checks cover many shapes of input without flakiness. */
function* random(seed: number, n: number) {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const maybe = (v: number) => next() < .2 ? undefined : v;
  for (let k = 0; k < n; k++) {
    yield {
      change1hPct: maybe(next() * 400 - 100), volume1hUsd: maybe(next() * 1e6), volumeBaselineUsd: maybe(next() * 1e5), buyUsd1h: maybe(next() * 1e4),
      sellUsd1h: maybe(next() * 1e4), liquidityUsd: maybe(next() * 1e6), marketCapUsd: maybe(next() * 1e7), curvePct: next() < .3 ? next() * 100 : undefined,
      top10Pct: maybe(next() * 100), devPct: maybe(next() * 50), earlyHeldPct: maybe(next() * 80), bundlesHeldPct: maybe(next() * 80),
      exitCost1kPct: maybe(next() * 120), sellCheck: next() < .1 ? 'refused' as const : next() < .5 ? 'sellable' as const : undefined,
      historyPartial: next() < .2, hardDanger: next() < .1, playbooks: next() < .3 ? [{ id: 'honeypot', level: 'danger' }] : [{ id: 'run_up', level: 'monitor' }],
    } satisfies Omit<EkoScoreInput, 'verdict'>;
  }
}

describe('EKO score bands', () => {
  it('always matches the verdict, and parses as the contract', () => {
    for (const input of random(7, 2000)) for (const verdict of ['danger', 'monitor', 'clear'] as const) {
      const s = ekoScore({ ...input, verdict })!;
      expect(EkoScoreSchema.parse(s)).toEqual(s);
      expect(s.band).toBe(bandOf[verdict]);
      const [low, high] = EKO_SCORE_BANDS[s.band];
      expect(s.value).toBeGreaterThanOrEqual(low);
      expect(s.value).toBeLessThanOrEqual(high);
      expect(s.value).toBeLessThanOrEqual(s.cap!);
      expect(Number.isInteger(s.value)).toBe(true);
    }
  });

  it('spans each band from its weakest to its strongest setup', () => {
    expect(ekoScore({ ...weak, verdict: 'danger' })!.value).toBeLessThan(10);
    expect(ekoScore({ ...strong, verdict: 'danger' })!.value).toBeGreaterThan(33);
    expect(ekoScore({ ...weak, verdict: 'monitor' })!.value).toBeLessThan(46);
    expect(ekoScore({ ...strong, verdict: 'monitor' })!.value).toBeGreaterThan(63);
    expect(ekoScore({ ...weak, verdict: 'clear' })!.value).toBeLessThan(76);
    expect(ekoScore({ ...strong, verdict: 'clear' })!.value).toBeGreaterThan(93);
  });

  it('never lets a Danger coin outscore a Careful one, or a Careful one an OK one', () => {
    expect(ekoScore({ ...strong, verdict: 'danger' })!.value).toBeLessThan(ekoScore({ ...weak, verdict: 'monitor' })!.value);
    expect(ekoScore({ ...strong, verdict: 'monitor' })!.value).toBeLessThan(ekoScore({ ...weak, verdict: 'clear' })!.value);
  });

  it('has no score while the verdict is pending', () => {
    expect(ekoScore({ ...strong, verdict: 'pending' })).toBeUndefined();
  });
});

describe('ordering inside a band', () => {
  it('ranks a stronger setup higher at the same verdict', () => {
    for (const verdict of ['danger', 'monitor', 'clear'] as const) {
      const [a, b, c] = [weak, middling, strong].map(x => ekoScore({ ...x, verdict })!.value);
      expect(a).toBeLessThan(b); expect(b).toBeLessThan(c);
    }
  });

  it('moves with each part in the right direction', () => {
    const base = { ...middling, verdict: 'clear' as const }, v = (x: Partial<EkoScoreInput>) => ekoScore({ ...base, ...x })!.value;
    expect(v({ change1hPct: 30 })).toBeGreaterThan(v({ change1hPct: -30 }));
    expect(v({ buyUsd1h: 80, sellUsd1h: 20 })).toBeGreaterThan(v({ buyUsd1h: 20, sellUsd1h: 80 }));
    expect(v({ liquidityUsd: 30_000 })).toBeGreaterThan(v({ liquidityUsd: 1_000 }));
    expect(v({ top10Pct: 20 })).toBeGreaterThan(v({ top10Pct: 80 }));
    expect(v({ exitCost1kPct: 1 })).toBeGreaterThan(v({ exitCost1kPct: 40 }));
  });
});

describe('hard danger and partial history', () => {
  it('pins a refused sell, a honeypot or hardDanger to 0-10 with the reason', () => {
    const refused = ekoScore({ ...strong, verdict: 'danger', sellCheck: 'refused', playbooks: [{ id: 'run_up', level: 'danger' }] })!;
    expect(refused.value).toBeLessThanOrEqual(10); expect(refused.cap).toBe(10); expect(refused.cappedBy).toBe('Sell check refused'); expect(refused.parts.exit).toBe(0);
    const honeypot = ekoScore({ ...strong, verdict: 'danger', playbooks: [{ id: 'honeypot', level: 'danger' }] })!;
    expect(honeypot.value).toBeLessThanOrEqual(10); expect(honeypot.cappedBy).toBe('Honeypot');
    expect(ekoScore({ ...strong, verdict: 'danger', hardDanger: true, playbooks: [{ id: 'tax_trap', level: 'danger' }] })!.value).toBeLessThanOrEqual(10);
    expect(ekoScore({ ...strong, verdict: 'danger', playbooks: [{ id: 'migration_dump', level: 'danger' }] })!.value).toBeGreaterThan(10);
  });

  it('caps a Clear on part of the history at 84', () => {
    const s = ekoScore({ ...strong, verdict: 'clear', historyPartial: true })!;
    expect(s.value).toBeLessThanOrEqual(84); expect(s.value).toBeGreaterThan(80); expect(s.cap).toBe(84); expect(s.cappedBy).toBe('Partly checked');
    expect(ekoScore({ ...strong, verdict: 'clear' })!.cap).toBe(100);
    expect(ekoScore({ ...strong, verdict: 'clear' })!.cappedBy).toBeUndefined();
  });

  it('a refused sell on a coin not graded Danger sits at the bottom of its band', () => {
    expect(ekoScore({ ...strong, verdict: 'monitor', sellCheck: 'refused' })!.value).toBe(40);
  });

  it('names the strongest finding of the verdict in plain words', () => {
    const playbooks = [{ id: 'launch_snipers', level: 'monitor' }, { id: 'migration_dump', level: 'danger' }];
    expect(ekoScore({ ...middling, verdict: 'danger', playbooks })!.cappedBy).toBe('Dumped at bonding');
    expect(ekoScore({ ...middling, verdict: 'monitor', playbooks: [{ id: 'tax_trap', level: 'info' }, { id: 'malicious_hook', level: 'monitor' }] })!.cappedBy).toBe('Unreviewed hook');
    expect(ekoScore({ ...middling, verdict: 'monitor' })!.cappedBy).toBe('Something to watch');
    expect(playbookLabel('holder_concentration')).toBe('Top-heavy holders');
  });
});

describe('missing data', () => {
  it('counts a missing part as 50 and names it', () => {
    const s = ekoScore({ verdict: 'monitor' })!;
    expect(s.missing).toEqual(['momentum', 'money', 'holders', 'exit']);
    expect(s.parts).toEqual({ momentum: 50, money: 50, holders: 50, exit: 50 });
    expect(s.value).toBe(40 + Math.round(.5 * 29));
    const some = ekoScore({ ...middling, verdict: 'clear', top10Pct: undefined, devPct: undefined })!;
    expect(some.missing).toEqual(['holders']); expect(some.parts.holders).toBe(50);
    expect(ekoScore({ ...strong, verdict: 'clear' })!.missing).toBeUndefined();
  });

  it('reads each part from what is measured', () => {
    expect(momentumPart({ verdict: 'clear', change1hPct: 0 })).toBe(50);
    expect(momentumPart({ verdict: 'clear', buyUsd1h: 0, sellUsd1h: 0 })).toBeUndefined();
    expect(momentumPart({ verdict: 'clear', volume1hUsd: 40, volumeBaselineUsd: 10 })).toBeCloseTo(50 + 50 * Math.tanh(1));
    expect(moneyPart({ verdict: 'clear', liquidityUsd: 100_000 })).toBe(100);
    expect(moneyPart({ verdict: 'clear', liquidityUsd: 8_000, marketCapUsd: 100_000 })).toBeCloseTo(.6 * 50 + .4 * 100 * Math.log10(80) / 3);
    expect(moneyPart({ verdict: 'clear', liquidityUsd: 10_000, curvePct: 50 })).toBeCloseTo(.6 * 50 + .4 * 200 / 3);
    expect(holdersPart({ verdict: 'clear', top10Pct: 20, devPct: 0 })).toBe(100);
    expect(holdersPart({ verdict: 'clear', top10Pct: 50, devPct: 10, earlyHeldPct: 5, bundlesHeldPct: 12 })).toBe(100 - 30 - 15 - 12);
    expect(exitPart({ verdict: 'clear', exitCost1kPct: 0 })).toBe(100);
    expect(exitPart({ verdict: 'clear', exitCost1kPct: 50 })).toBe(0);
    expect(exitPart({ verdict: 'clear', exitCost1kPct: 25 })).toBe(50);
    expect(exitPart({ verdict: 'clear', sellCheck: 'refused', exitCost1kPct: 1 })).toBe(0);
    expect(exitPart({ verdict: 'clear' })).toBeUndefined();
  });

  it('ignores non-finite inputs rather than producing NaN', () => {
    const s = ekoScore({ verdict: 'clear', change1hPct: NaN, liquidityUsd: Infinity, marketCapUsd: 0, top10Pct: Number.NaN, exitCost1kPct: -Infinity })!;
    expect(Number.isInteger(s.value)).toBe(true);
    expect(s.missing).toEqual(['momentum', 'money', 'holders', 'exit']);
  });
});
