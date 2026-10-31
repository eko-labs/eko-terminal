import { describe, expect, it } from 'vitest';
import { visibleRange } from './radarWindow';
describe('Radar windowing with page scrolling', () => {
  it('keeps the prototype 30-row table intact', () => expect(visibleRange(30,-1000,900,62)).toEqual({start:0,end:30}));
  it('bounds DOM rows for large lists while preserving offscreen row counts', () => {
    expect(visibleRange(100,400,900,62)).toEqual({start:0,end:14});
    const middle=visibleRange(100,-2000,900,62); expect(middle.start).toBeGreaterThan(0); expect(middle.end-middle.start).toBeLessThan(30);
    const bottom=visibleRange(100,-6000,900,62); expect(bottom.end).toBe(100);
    expect(visibleRange(100,-2000,900,44).start).toBeGreaterThan(middle.start);
  });
});
