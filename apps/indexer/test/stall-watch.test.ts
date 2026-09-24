import { describe, expect, it, vi } from 'vitest';
import { indexerWatchdog } from '../src/stall-watch.js';

describe('live indexer watchdog (fake clock)', () => {
  function harness(head = async () => 150n) {
    let now = Date.UTC(2026, 9, 6, 9, 22, 45);
    const lines: { event: string; [k: string]: unknown }[] = [], emitted: number[] = [], exit = vi.fn();
    const metrics = { hasHeadMeasurement: () => true, headLagMs: 4_000 };
    const watchdog = indexerWatchdog({ stallMs: 300_000, client: { head: vi.fn(head) }, metrics, now: () => now, exit,
      emit: (_metric, value) => emitted.push(value), log: (event, fields) => lines.push({ event, ...fields }) });
    return { watchdog, lines, emitted, exit, metrics, advance: (ms: number) => { now += ms; } };
  }
  it('reports a growing head lag every minute while stuck, then logs indexer_stalled and exits 1', () => {
    const h = harness();
    h.watchdog.progress(81_521_420n); h.watchdog.observeHead(81_521_900n);
    for (let minute = 1; minute <= 4; minute++) { h.advance(60_000); h.watchdog.observeHead(81_521_900n + BigInt(minute * 240)); expect(h.watchdog.check()).toBeUndefined(); }
    expect(h.emitted).toEqual([64_000, 124_000, 184_000, 244_000]);
    expect(h.lines.filter(l => l.event === 'indexer_lag').at(-1)).toMatchObject({ cursor: '81521420', head: '81522860', blocks_behind: 1440, head_lag_ms: 244_000 });
    expect(h.exit).not.toHaveBeenCalled();
    h.advance(60_000);
    expect(h.watchdog.check()).toBe('no_progress');
    expect(h.lines.at(-1)).toMatchObject({ event: 'indexer_stalled', reason: 'no_progress', cursor: '81521420', idle_ms: 300_000, action: 'exit_for_restart' });
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('keeps quiet and reports the measured lag while the cursor advances', () => {
    const h = harness();
    for (let minute = 1; minute <= 30; minute++) {
      h.advance(60_000); h.watchdog.observeHead(BigInt(1000 + minute * 240)); h.watchdog.progress(BigInt(1000 + minute * 240 - 2));
      expect(h.watchdog.check()).toBeUndefined();
    }
    expect(h.exit).not.toHaveBeenCalled();
    expect(new Set(h.emitted)).toEqual(new Set([4_000]));
  });
  it('reports no lag before the first measurement and still exits when nothing can read the head', async () => {
    const h = harness(() => new Promise<bigint>(() => {}));
    h.metrics.hasHeadMeasurement = () => false;
    h.advance(60_000); h.watchdog.check();
    expect(h.emitted).toEqual([]);
    expect(h.lines[0]).toMatchObject({ event: 'indexer_lag', head_lag_ms: null });
    h.advance(540_000);
    expect(h.watchdog.check()).toBe('head_unobserved');
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
