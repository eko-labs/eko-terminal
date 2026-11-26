import { afterEach, describe, expect, it, vi } from 'vitest';
import { paintCandles, paintVolume, withAlpha, type CandlePalette, type CandlesGeometry } from './phosphor';

/** A 2D context that records the colour each candle mark was drawn in. */
function recordingCanvas() {
  const marks: [string, string][] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '' };
  const gradient = { addColorStop: (_at: number, colour: string) => { marks.push(['glow', colour]); } };
  const context: Record<string, unknown> = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { marks.push(['fill', String(target.fillStyle)]); };
      if (key === 'strokeRect') return () => { marks.push(['edge', String(target.strokeStyle)]); };
      if (key === 'stroke') return () => { marks.push(['wick', String(target.strokeStyle)]); };
      if (key === 'createRadialGradient') return () => gradient;
      if (key === 'createPattern') return () => ({ setTransform() {} });
      return () => {};
    },
    set(target, key: string, value) { target[key] = value; return true; },
  });
  const canvas = () => ({ width: 0, height: 0, getContext: () => context }) as unknown as HTMLCanvasElement;
  return { canvas: canvas(), make: canvas, marks };
}

function paint(palette?: CandlePalette, slot = 10) {
  const rec = recordingCanvas();
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('document', { createElement: () => rec.make() });
  vi.stubGlobal('DOMMatrix', class {});
  // One rising candle, then one falling.
  const candles = [{ o: 1, h: 3, l: 0.5, c: 2 }, { o: 2, h: 2.5, l: 1, c: 1.5 }];
  const g: CandlesGeometry = { W: 200, H: 100, L: 0, R: 0, T: 0, B: 100, slot, candles, x: i => 5 + i * slot, y: v => 100 - v * 20, ...(palette ? { palette } : {}) };
  paintCandles(rec.canvas, g);
  const candleMarks = [...rec.marks];
  rec.marks.length = 0;
  paintVolume(rec.canvas, { ...g, volumes: [10, 10] });
  return { candleMarks, volumeMarks: rec.marks.filter(([kind]) => kind === 'fill').map(([, c]) => c) };
}

afterEach(() => vi.unstubAllGlobals());

describe('candle palette', () => {
  it('writes a #rrggbb colour as rgba at an alpha', () => {
    expect(withAlpha('#f5c451', 0.5)).toBe('rgba(245,196,81,0.5)');
    expect(withAlpha('8fcaf0', 1)).toBe('rgba(143,202,240,1)');
  });

  it('paints the default phosphor tones when no palette is given', () => {
    const { candleMarks, volumeMarks } = paint();
    expect(candleMarks).toContainEqual(['wick', 'rgba(200,232,252,.85)']);
    expect(candleMarks).toContainEqual(['fill', 'rgba(190,228,251,.92)']);
    expect(candleMarks).toContainEqual(['wick', 'rgba(96,130,156,.8)']);
    expect(candleMarks).toContainEqual(['fill', 'rgba(20,34,46,.95)']);
    expect(candleMarks).toContainEqual(['edge', 'rgba(96,130,156,.9)']);
    expect(candleMarks).toContainEqual(['glow', 'rgba(228,246,255,0.55)']);
    expect(new Set(volumeMarks)).toEqual(new Set(['rgba(150,210,250,.35)', 'rgba(96,130,156,.25)']));
  });

  it('draws rising candles filled and falling candles hollow in the palette colours', () => {
    const { candleMarks, volumeMarks } = paint({ up: '#f5c451', down: '#f5c451', hollow: '#05080b' });
    expect(candleMarks).toContainEqual(['fill', 'rgba(245,196,81,0.92)']);
    expect(candleMarks).toContainEqual(['fill', '#05080b']);
    expect(candleMarks).toContainEqual(['edge', 'rgba(245,196,81,0.9)']);
    expect(candleMarks).toContainEqual(['glow', 'rgba(245,196,81,0.55)']);
    // No default tone leaks into a coloured chart.
    expect(candleMarks.some(([, c]) => /rgba\((200,232,252|190,228,251|96,130,156|228,246,255)/.test(c))).toBe(false);
    expect(new Set(volumeMarks)).toEqual(new Set(['rgba(245,196,81,0.35)', 'rgba(245,196,81,0.2)']));
  });

  it('keeps a thin falling candle readable as down: filled at half strength', () => {
    const { candleMarks } = paint({ up: '#a993ff', down: '#a993ff' }, 2);
    expect(candleMarks).toContainEqual(['fill', 'rgba(169,147,255,0.92)']);
    expect(candleMarks).toContainEqual(['fill', 'rgba(169,147,255,0.5)']);
  });
});
