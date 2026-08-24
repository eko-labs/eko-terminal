import manifest from '../../abi/occupy/manifest.json' with { type: 'json' };
import type { ActorTransaction } from '../actor.js';
import type { DecoderLog } from '../decoders.js';
import type { LaunchpadAdapter, LaunchpadEvent } from './types.js';

/** Evidence status only; importing this adapter does not enable venue ingestion. */
export const occupyManifest = manifest;

// TODO(spec): Occupy factory/template/event/quote evidence is unavailable. Keep
// Phase B ingestion disabled until pinned verified sources satisfy the manifest.
export function decodeOccupyResult(_log: DecoderLog, _tx: ActorTransaction): {
  events: LaunchpadEvent[]; unknownTopics: number; malformedLogs: number;
} {
  // Without an ABI even a familiar topic is unknown, not a malformed Occupy log.
  return { events: [], unknownTopics: 1, malformedLogs: 0 };
}

/** No guessed selectors, Pons defaults or unverified registry hints. */
export function createOccupyAdapter(): LaunchpadAdapter {
  return {
    id: 'occupy',
    addresses: () => [],
    decode: (log, tx) => decodeOccupyResult(log, tx).events,
  };
}
