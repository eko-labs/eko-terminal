import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartStage, CHART_AXES } from './ChartStage';
import { formatMc } from './chartCore';
import source from './ChartStage.tsx?raw';

describe('coin chart in market cap', () => {
  it('reads market caps short on the crosshair and the last value: $20.7K, $1.2M', () => {
    expect([20_700, 1_200_000, 1_000_000, 310_000, 2_450_000_000, 950].map(v => formatMc(v))).toEqual(['$20.7K', '$1.2M', '$1M', '$310K', '$2.45B', '$950']);
    expect(formatMc(1_205_000)).toBe('$1.21M');
  });
  it('keeps the precision a tick step needs on the axis', () => {
    expect([1_200_000, 1_250_000].map(v => formatMc(v, 50_000))).toEqual(['$1.20M', '$1.25M']);
    expect(formatMc(20_700, 10)).toBe('$20.70K');
  });
  it('opens in MC, with Price as the other choice, on the toolbar and the phone row', () => {
    expect(CHART_AXES).toEqual(['MC', 'Price']);
    const html = renderToStaticMarkup(<ChartStage market="DEMO" timeframe="5m" onTimeframe={() => {}} bars={[]} markers={[]} supply={1_000_000_000} verdict={null} />);
    expect(html.match(/aria-pressed="true"[^>]*>MC</g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"[^>]*>Price</g)).toHaveLength(2);
    expect(html).not.toContain('>FDV<'); expect(html).toContain('DEMO market cap chart');
  });
  it('remembers the choice with the other chart settings in this browser', () => {
    expect(source).toContain("axis: 'MC'"); expect(source).toContain("v?.axis === 'Price' ? 'Price' : 'MC'"); expect(source).toContain('update({axis:');
  });
});
