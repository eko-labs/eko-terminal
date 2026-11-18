import type { Hex } from 'viem';
import type { ElysiumRegistry } from '@eko/chain';
import type { RawLog } from '../../tracker.js';
import { SWAP_TOPIC, TRANSFER_TOPIC } from '../logs.js';
import type { HistorianSource } from '../types.js';
import { LAUNCH_TOPIC } from './tracker.js';

/**
 * The historian on Elysium: Montra launches from its factory, swaps counted on Uniswap's PoolManager, and a launch's
 * first day rebuilt from its launch log, its pool's swaps and its token's transfers.
 */
export function elysiumHistorian(registry: ElysiumRegistry): HistorianSource {
  const factory = registry.address('montra.factory'), manager = registry.address('uniswapV4.poolManager');
  return {
    launches: { address: factory, topic0: LAUNCH_TOPIC },
    swaps: { address: manager, topic0: SWAP_TOPIC },
    async replayLogs(explorer, { token, poolId, createdBlock }, end) {
      const launch = (await explorer.logs({ address: factory, topic0: LAUNCH_TOPIC }, createdBlock, createdBlock)).filter(l => l.data.length > 2);
      const swaps = await explorer.logs({ address: manager, topic0: SWAP_TOPIC, topic1: poolId }, createdBlock, end);
      const transfers = await explorer.logs({ address: token, topic0: TRANSFER_TOPIC as Hex }, createdBlock, end);
      return [...launch, ...swaps, ...transfers] as RawLog[];
    },
  };
}
