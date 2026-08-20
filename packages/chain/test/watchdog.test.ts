import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressWatchdog, type WatchdogOptions } from '../src/watchdog.js';

function fake(options: Partial<WatchdogOptions> = {}) {
  let now = Date.UTC(2026, 9, 6, 9, 22, 45);
  const lines: { event: string; [k: string]: unknown }[] = [], exit = vi.fn();
  const watchdog = new ProgressWatchdog({ role: 'indexer', stallMs: 300_000, trackHead: true, now: () => now,
    log: (event, fields) => lines.push({ event, ...fields }), exit, ...options });
  return { watchdog, lines, exit, advance: (ms: number) => { now += ms; } };
}
afterEach(() => { vi.useRealTimers(); });

describe('indexer progress watchdog (fake clock)', () => {
  it('exits non-zero after five minutes behind an advancing head without cursor progress', () => {
    const h = fake();
    h.watchdog.progress(100n); h.watchdog.observeHead(150n);
    h.advance(299_000); expect(h.watchdog.check()).toBeUndefined();
    h.watchdog.progress(120n); h.watchdog.observeHead(160n);
    h.advance(299_999); expect(h.watchdog.check()).toBeUndefined(); expect(h.exit).not.toHaveBeenCalled();
    h.advance(1); expect(h.watchdog.check()).toBe('no_progress');
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.lines.at(-1)).toMatchObject({ event: 'indexer_stalled', reason: 'no_progress', cursor: '120', head: '160', blocks_behind: 40,
      idle_ms: 300_000, stall_after_ms: 300_000, action: 'exit_for_restart' });
    // Tripped once; later checks are inert.
    h.advance(600_000); expect(h.watchdog.check()).toBeUndefined(); expect(h.exit).toHaveBeenCalledOnce();
  });
  it('stays quiet while caught up on an idle chain, and starts counting when the head moves past the cursor', () => {
    const h = fake();
    h.watchdog.progress(150n);
    for (let minute = 0; minute < 60; minute++) { h.watchdog.observeHead(150n); h.advance(60_000); expect(h.watchdog.check()).toBeUndefined(); }
    h.watchdog.observeHead(151n);
    h.advance(299_000); h.watchdog.observeHead(151n); expect(h.watchdog.check()).toBeUndefined();
    h.advance(1_000); expect(h.watchdog.check()).toBe('no_progress');
  });
  it('treats a reorg rollback as a lower cursor, not as progress', () => {
    const h = fake();
    h.watchdog.progress(100n); h.watchdog.observeHead(120n);
    h.advance(200_000); h.watchdog.progress(90n);
    h.advance(100_000); expect(h.watchdog.check()).toBe('no_progress');
    expect(h.lines.at(-1)).toMatchObject({ cursor: '90', blocks_behind: 30 });
  });
  it('counts a first tick that never reads its cursor as pending work', () => {
    const h = fake();
    h.watchdog.observeHead(500n);
    h.advance(300_000); h.watchdog.observeHead(510n);
    expect(h.watchdog.check()).toBe('no_progress');
  });
  it('probes the head itself when the worker stops reporting, and exits when even the probe cannot see it', async () => {
    const probe = vi.fn(async () => 200n);
    const h = fake({ probe });
    h.watchdog.progress(100n);
    h.advance(59_000); h.watchdog.check(); expect(probe).not.toHaveBeenCalled();
    h.advance(1_000); h.watchdog.check(); expect(probe).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.watchdog.state().head).toBe(200n));
    h.advance(300_000); expect(h.watchdog.check()).toBe('no_progress');

    vi.useFakeTimers();
    const hung = fake({ probe: () => new Promise(() => {}), probeTimeoutMs: 20_000 });
    hung.advance(60_000); hung.watchdog.check();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hung.lines).toContainEqual({ event: 'indexer_head_probe_failed', reason: 'timeout' });
    hung.advance(540_000); expect(hung.watchdog.check()).toBe('head_unobserved');
    expect(hung.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('logs lag once a minute, including the caller report, even while stuck', () => {
    const onReport = vi.fn(() => ({ head_lag_ms: 42 }));
    const h = fake({ onReport });
    h.watchdog.progress(100n); h.watchdog.observeHead(130n);
    h.advance(30_000); h.watchdog.check(); expect(h.lines).toHaveLength(0);
    h.advance(30_000); h.watchdog.check();
    expect(h.lines).toEqual([{ event: 'indexer_lag', cursor: '100', head: '130', blocks_behind: 30, idle_ms: 60_000, since_progress_ms: 60_000, head_age_ms: 60_000, head_lag_ms: 42 }]);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ idleMs: 60_000, blocksBehind: 30 }));
    h.advance(60_000); h.watchdog.check(); expect(h.lines.filter(l => l.event === 'indexer_lag')).toHaveLength(2);
  });
  it('runs on its own timer and stops cleanly', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const watchdog = new ProgressWatchdog({ role: 'indexer', stallMs: 300_000, trackHead: true, log: () => {}, exit }).start();
    watchdog.progress(1n); watchdog.observeHead(2n);
    await vi.advanceTimersByTimeAsync(300_000); expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const quiet = vi.fn();
    const stopped = new ProgressWatchdog({ role: 'indexer', stallMs: 1_000, log: () => {}, exit: quiet }).start();
    stopped.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(quiet).not.toHaveBeenCalled();
  });
});
describe('engines loop watchdog (heartbeat mode)', () => {
  it('exits when the poll loop is silent for the threshold, whatever the head', () => {
    const h = fake({ role: 'engines', trackHead: false, stallMs: 600_000 });
    for (let i = 0; i < 10; i++) { h.advance(500_000); h.watchdog.progress(); expect(h.watchdog.check()).toBeUndefined(); }
    h.advance(600_000); expect(h.watchdog.check()).toBe('no_heartbeat');
    expect(h.lines.at(-1)).toMatchObject({ event: 'engines_stalled', reason: 'no_heartbeat', since_progress_ms: 600_000 });
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
