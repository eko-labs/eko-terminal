import { rpcStopReason, isRpcUnavailable, safeError } from '@eko/chain';
import { stackSummary } from './stack-summary.js';
import type { Logger } from './types.js';
/** A budget refusal ends the worker path; it is not an ingest failure. */
export function reportIndexerError(error: unknown, logger: Logger): number {
  const reason = rpcStopReason(error);
  if (reason) { logger('indexer_stopped', { reason }); return 0; }
  logger('indexer_halted', { reason: isRpcUnavailable(error) ? 'rpc_unavailable' : 'startup_or_ingest_failure', action: 'check_chain_config_and_database', error: safeError(error),...(!isRpcUnavailable(error)?{stack_frames:stackSummary(error)}:{}) });
  return 1;
}
