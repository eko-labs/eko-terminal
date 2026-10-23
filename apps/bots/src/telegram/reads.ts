import type { CoinCardV2, ScanResult } from '@eko/shared';
import type { TelegramServices } from './handler.js';

/** Reuse task 107's durable queue and Guard read snapshots, without a bot-side oracle or RPC. */
export function telegramReadServices(scans: { scan(query: string): Promise<ScanResult> },
  guards: { card(coin: `0x${string}`): Promise<CoinCardV2 | null> }): TelegramServices {
  return {
    /**
     * Use the injected durable scan reader and attach a Guard snapshot only for an unambiguous
     * resolved coin. No bot-side classification, simulation or RPC occurs; reader failures
     * propagate.
     */
    async scan(query) {
      const result = await scans.scan(query);
      const coin = result.card?.identity.address ?? (result.candidates?.length === 1 ? result.candidates[0].address : undefined);
      return { ...result, ...(coin && result.status !== 'ambiguous' ? { guardCard: await guards.card(coin) } : {}) };
    },
  };
}
