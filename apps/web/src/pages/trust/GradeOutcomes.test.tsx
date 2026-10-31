import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GradeOutcomesView, outcomeText } from './GradeOutcomes';

// Synthetic counts only.
const row = (level: 'clear' | 'monitor' | 'danger', horizonSec: number, ratings: number, down50: number, down50NeverUp20 = 0) => ({ level, horizonSec, ratings, down50, down50NeverUp20 });
describe('how each grade did', () => {
  it('prints a count and a rate, and no rate from too few coins', () => {
    expect(outcomeText(row('danger', 3600, 176, 36))).toBe('36 of 176 · 20%');
    expect(outcomeText(row('monitor', 3600, 282, 5))).toBe('5 of 282 · 1.8%');
    expect(outcomeText(row('clear', 3600, 243, 0))).toBe('0 of 243 · 0%');
    expect(outcomeText(row('danger', 86400, 12, 3))).toBe('3 of 12 (too few to read a rate)');
    expect(outcomeText(row('danger', 86400, 0, 0))).toBe('No coins old enough yet'); expect(outcomeText(undefined)).toBe('No coins old enough yet');
  });
  it('lists Danger first, names the no-match grade as the site does, and says whose measurement it is', () => {
    const html = renderToStaticMarkup(<GradeOutcomesView data={{ since: '2026-10-12T18:30:00Z', computedAt: '2026-10-12T23:30:00.000Z',
      rows: [row('clear', 3600, 243, 0), row('monitor', 3600, 282, 5, 4), row('danger', 3600, 176, 36, 23), row('danger', 86400, 0, 0)] }} />);
    expect(html.indexOf('Danger')).toBeLessThan(html.indexOf('Monitor')); expect(html).toContain('No flags'); expect(html).not.toContain('>Clear<');
    expect(html).toContain('36 of 176 · 20%'); expect(html).toContain('23 never up 20% first'); expect(html).toContain('No coins old enough yet');
    expect(html).toContain('not been independently reviewed'); expect(html).toContain('2026-10-12 18:30 UTC');
    // Without the Uniswap measurement (an older server) there is one table.
    expect(html.match(/<table/g)).toHaveLength(1);
  });
  it('shows coins that launched in a Uniswap pool in their own table, with when their grades began', () => {
    const html = renderToStaticMarkup(<GradeOutcomesView data={{ since: '2026-10-12T18:30:00Z', computedAt: '2026-10-13T23:30:00.000Z', rows: [row('danger', 3600, 176, 36, 23)],
      uniswap: { since: '2026-10-13T07:30:00Z', rows: [row('danger', 3600, 40, 31, 30), row('monitor', 3600, 12, 1)] } }} />);
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain('Pons launches'); expect(html).toContain('Coins that launched in a Uniswap pool');
    expect(html).toContain('31 of 40 · 78%'); expect(html).toContain('1 of 12 (too few to read a rate)');
    expect(html).toContain('2026-10-13 07:30 UTC'); expect(html).toContain('thresholds were set on Pons launches');
  });
});
