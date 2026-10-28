import { afterEach, describe, expect, it, vi } from 'vitest';
import { reducedMotion, sweep, sweepDelay } from './phosphor';
import { installDither } from './dither';

afterEach(() => vi.unstubAllGlobals());
function environment(system = false, setting?: string) {
  vi.stubGlobal('document', { documentElement: { dataset: { motion: setting } } });
  vi.stubGlobal('matchMedia', () => ({ matches: system }));
}
describe('phosphor motion', () => {
  it('paints the final frame immediately for system and settings reduced motion', () => {
    for (const [system, setting] of [[true, 'on'], [false, 'off']] as const) {
      environment(system, setting);
      const paint = vi.fn();
      sweep(paint);
      expect(paint.mock.calls).toEqual([[1]]);
    }
  });
  it('finishes without scheduling when animation is disabled or duration is zero', () => {
    environment();
    expect(reducedMotion()).toBe(false);
    for (const options of [{ animate: false }, { dur: 0 }]) {
      const paint = vi.fn();
      sweep(paint, options);
      expect(paint.mock.calls).toEqual([[1]]);
    }
  });
  it('cancels a scheduled sweep and responds to reduced motion during playback', () => {
    environment();
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const paint = vi.fn();
    const stop = sweep(paint);
    expect(paint.mock.calls).toEqual([[0]]);
    environment(false, 'off');
    frames[0](performance.now());
    expect(paint.mock.calls).toEqual([[0], [1]]);
    expect(frames).toHaveLength(1);
    stop();
    expect(cancel).toHaveBeenCalledWith(1);
  });
  it('clamps marker delays and can import dither without a document', () => {
    expect(sweepDelay(-1)).toBe(0);
    expect(sweepDelay(2, 640)).toBe(640);
    expect(sweepDelay(0.5, 640)).toBeGreaterThan(0);
    expect(installDither()).toBeUndefined();
  });
});
