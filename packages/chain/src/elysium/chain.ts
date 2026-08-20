import { defineChain } from 'viem';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';

/** Public endpoint from https://elysium.kinetiq.xyz/docs/connecting-to-elysium; shared by everyone, so use a provider in production. */
export const ELYSIUM_PUBLIC_RPC = 'https://rpc.elysium.kinetiq.xyz';
export const ELYSIUM_EXPLORER = 'https://elysium.kinetiq.xyz/explorer';

export const elysium = defineChain({
  id: ELYSIUM_CHAIN_ID,
  name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [ELYSIUM_PUBLIC_RPC] } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: ELYSIUM_EXPLORER } },
});
