import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createRadarRows } from '../mocks/demo/radar';
import { RadarRowView } from '../pages/terminal/RadarParts';
import { CHAIN_NAME, CHAIN_TITLE, launchpadLabel } from './chain';

describe('chain and launchpad context', () => {
  it('names the one chain and its ID', () => {
    expect(CHAIN_NAME).toBe('Elysium');
    expect(CHAIN_TITLE).toContain('99901');
  });
  it('labels launchpads the same way on every surface', () => {
    expect(launchpadLabel('pons')).toBe('Pons');
    expect(launchpadLabel('pons', true)).toBe('Pons → pool');
    expect(launchpadLabel('other')).toBe('Uniswap');
    expect(launchpadLabel('other', true)).toBe('Uniswap');
    expect(launchpadLabel('klik')).toBe('Klik');
  });
  it('shows the launchpad in every Radar coin cell', () => {
    const row = createRadarRows()[0];
    const html = render(<table><tbody><RadarRowView c={row} selected={false} select={() => {}} trade={() => {}} pulse={0} /></tbody></table>);
    expect(html).toContain(`<span class="rt-pad">${launchpadLabel(row.launchpad, row.stage === 'graduated')}</span>`);
  });
});
