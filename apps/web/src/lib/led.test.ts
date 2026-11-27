import { describe, expect, it } from 'vitest';
import { LED_CELLS, LED_N, LED_PATTERNS, LED_PERIOD, LED_STILL, RING, SPIRAL, TRAIL, hash01, ledDone, ledFrame, ledStep, type LedPattern } from './led';
import { alertLed } from './alertSummary';

const lit = (f: Float32Array, min = 0.99) => [...f].flatMap((v, i) => (v >= min ? [i] : []));
const xy = (i: number) => [i % LED_N, Math.floor(i / LED_N)] as const;

describe('LED patterns', () => {
  it.each(LED_PATTERNS)('%s: 49 intensities between 0 and 1, the same for the same step, looping each period', (p) => {
    for (let s = 0; s < LED_PERIOD[p] * 2; s++) {
      const f = ledFrame(p, s);
      expect(f).toHaveLength(LED_CELLS);
      expect([...f].every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(ledFrame(p, s)).toEqual(f);
    }
    if (p !== 'sparkle') for (let s = 0; s < LED_PERIOD[p]; s++) expect(ledFrame(p, s + LED_PERIOD[p])).toEqual(ledFrame(p, s));
  });
  it.each(LED_PATTERNS)('%s: something is lit at its still frame (what reduced motion shows)', (p) => {
    expect(Math.max(...ledFrame(p, LED_STILL[p]))).toBeGreaterThan(0.5);
  });
  it('ring: 16 cells round the centre in order, one bright head stepping one cell a step, a two-step trail behind it', () => {
    expect(RING).toHaveLength(16);
    expect(RING[0]).toBe(3); // top centre
    expect(new Set(RING).size).toBe(16);
    for (let s = 0; s < 16; s++) {
      const f = ledFrame('ring', s);
      expect(lit(f)).toEqual([RING[s]]);
      expect(f[RING[(s + 15) % 16]!]).toBeCloseTo(TRAIL[1]);
      expect(f[RING[(s + 14) % 16]!]).toBeCloseTo(TRAIL[2]);
      // The rest of the ring stays faintly visible; cells off the ring stay dark.
      expect(f[24]).toBe(0);
    }
  });
  it('scan: a full column that sweeps across and back, fading behind', () => {
    const cols = Array.from({ length: LED_PERIOD.scan }, (_, s) => new Set(lit(ledFrame('scan', s)).map((i) => xy(i)[0])));
    expect(cols.map((c) => [...c])).toEqual([[0], [1], [2], [3], [4], [5], [6], [5], [4], [3], [2], [1]]);
    expect(lit(ledFrame('scan', 2))).toHaveLength(LED_N);
    expect(ledFrame('scan', 2)[1]).toBeCloseTo(TRAIL[1]);
  });
  it('sweep: a diagonal band from the top-left to the bottom-right', () => {
    for (let k = 0; k <= 12; k++) expect(lit(ledFrame('sweep', k)).every((i) => xy(i)[0] + xy(i)[1] === k)).toBe(true);
    expect(lit(ledFrame('sweep', 0))).toEqual([0]);
    expect(lit(ledFrame('sweep', 12))).toEqual([48]);
  });
  it('fall: drops only ever move down, one row a step', () => {
    for (let s = 1; s < 40; s++) {
      const before = lit(ledFrame('fall', s - 1)), now = lit(ledFrame('fall', s));
      for (const i of now) {
        const [x, y] = xy(i);
        if (y > 0) expect(before).toContain(i - LED_N);
        else expect(x).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('snake: a six-dot body on the spiral, head brightest, moving one cell a step', () => {
    expect(new Set(SPIRAL).size).toBe(LED_CELLS);
    const f = ledFrame('snake', 10);
    expect(f[SPIRAL[10]!]).toBe(1);
    expect(f[SPIRAL[9]!]).toBeLessThan(1);
    expect([...f].filter((v) => v > 0)).toHaveLength(6);
  });
  it('pulse: breathes from a small bright centre to a wide disc and back', () => {
    const litCount = (s: number) => [...ledFrame('pulse', s)].filter((v) => v > 0.05).length;
    expect(litCount(0)).toBeLessThan(litCount(LED_PERIOD.pulse / 2));
    expect(ledFrame('pulse', LED_PERIOD.pulse / 2)[24]).toBeGreaterThan(0.9);
  });
  it('sparkle: a few random dots each step, stable for a given step', () => {
    const counts = Array.from({ length: 200 }, (_, s) => lit(ledFrame('sparkle', s), 0.5).length);
    expect(Math.max(...counts)).toBeLessThan(15);
    expect(counts.reduce((a, b) => a + b, 0) / counts.length).toBeGreaterThan(1);
    expect(hash01(3, 4)).toBe(hash01(3, 4));
  });
  it('steps on one shared clock, and a pattern that plays N cycles is done after N periods', () => {
    expect(ledStep('ring', 0)).toBe(0);
    expect(ledStep('ring', 1000)).toBe(11);
    expect(ledStep('pulse', 2000, 0.5)).toBe(11);
    expect(ledDone('fall', 5, 5 + LED_PERIOD.fall - 1, 1)).toBe(false);
    expect(ledDone('fall', 5, 5 + LED_PERIOD.fall, 1)).toBe(true);
    expect(ledDone('ring', 0, 1e9, Infinity)).toBe(false);
  });
});

describe('alert LEDs', () => {
  it('falls in coral for money leaving, sparkles for a match, scans ice for a verdict change, breathes for price and curve', () => {
    const want: [Parameters<typeof alertLed>[0], LedPattern, string][] = [
      ['dev_sell', 'fall', 'coral'], ['dump_risk', 'fall', 'coral'], ['launch_match', 'sparkle', 'blue'],
      ['verdict_change', 'scan', 'ice'], ['price', 'pulse', 'blue'], ['curve', 'pulse', 'blue'],
    ];
    for (const [kind, pattern, tone] of want) expect(alertLed(kind)).toEqual({ pattern, tone });
    expect(alertLed('order')).toBeUndefined();
  });
});
