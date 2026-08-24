import manifest from '../../abi/flap/manifest.json' with { type: 'json' };
import type { DecoderLog } from '../decoders.js';
import type { LaunchpadAdapter, LaunchpadEvent } from './types.js';

/** Deployment code presence and documented trade topics do not verify a launch ABI. */
export const flapManifest = manifest;

export function decodeFlapResult(_log: DecoderLog): { events: LaunchpadEvent[]; unknownTopics: number; malformedLogs: number } {
  // Without an accepted ABI, even documented topics remain unknown to ingestion.
  return { events: [], unknownTopics: 1, malformedLogs: 0 };
}

/** Explicit unavailable adapter: no emitters, reads, quotes or transaction builders. */
export function createFlapAdapter(): LaunchpadAdapter {
  return { id: 'flap', addresses: () => [], decode: log => decodeFlapResult(log).events };
}

// TODO(spec): Enable Flap only after its Portal launch ABI and implementation binding,
// canonical fixtures and recent leased backfill ordering/reorg checks are verified.
