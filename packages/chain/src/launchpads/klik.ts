import manifest from '../../abi/klik/manifest.json' with { type: 'json' };
import type { ActorTransaction } from '../actor.js';
import type { DecoderLog } from '../decoders.js';
import type { LaunchpadAdapter, LaunchpadEvent } from './types.js';

/** Explicit coverage gap, backed by the recorded public-source verification attempt. */
export const klikSupport = manifest;

// TODO(spec): Verify Klik's 4663 deployment, event ABI, emitters and pinned receipts
// before enabling decoding or address/topic-filtered logs:klik backfill (§§4.3–4.5).
export function decodeKlikResult(_log: DecoderLog, _tx: ActorTransaction): {
  events: LaunchpadEvent[]; unknownTopics: number; malformedLogs: number;
} {
  // No payload is interpreted until an ABI and its emitter are verified.
  return { events: [], unknownTopics: 1, malformedLogs: 0 };
}

/** No I/O, filters or optional execution/read capabilities while unsupported. */
export function createKlikAdapter() {
  return {
    id: 'klik',
    addresses: () => [],
    decode: (log: DecoderLog, tx: ActorTransaction) => decodeKlikResult(log, tx).events,
  } satisfies LaunchpadAdapter;
}
