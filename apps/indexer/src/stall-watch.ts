import { ProgressWatchdog } from '@eko/chain';
import type { ChainClient, Logger, Metrics } from './types.js';

/**
 * The live indexer's watchdog. Behind an advancing chain head with no cursor progress for
 * `stallMs`, or unable to read the head at all for twice that, it logs `indexer_stalled` and exits
 * 1 so the platform restarts the process. Each minute it logs `indexer_lag` and reports head lag
 * to launch monitoring; the last measured lag keeps growing while the cursor stands still.
 */
export function indexerWatchdog(input: {
  paused?: () => boolean; stallMs: number; client: Pick<ChainClient, 'head'>; metrics: Pick<Metrics, 'hasHeadMeasurement' | 'headLagMs'>;
  emit: (metric: 'head_lag_ms', value: number) => void; log: Logger; now?: () => number; exit?: (code: number) => void;
}): ProgressWatchdog {
  return new ProgressWatchdog({ role: 'indexer', paused: input.paused, stallMs: input.stallMs, trackHead: true, log: input.log, now: input.now, exit: input.exit,
    // Only used when the head loop itself has not read the head for a minute: one metered public call.
    probe: () => input.client.head(),
    onReport: state => {
      if (!input.metrics.hasHeadMeasurement()) return { head_lag_ms: null };
      const lag = input.metrics.headLagMs + state.idleMs;
      input.emit('head_lag_ms', lag);
      return { head_lag_ms: lag };
    } });
}
