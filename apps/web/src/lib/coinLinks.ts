import { CHAIN_NETWORK, NETWORKS, type ChainKey } from '@eko/shared';
import { CHAIN_KEY } from './chain';

export interface ElsewhereLink { label: 'DexScreener' | 'Explorer'; href: string }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Where to open a coin outside EKO. On Robinhood Chain a graduated coin trades in a Uniswap pool that DexScreener
 * lists (chain id "robinhood"); a coin still on the Pons curve is not listed there, so it opens the explorer's token
 * page. Other chains open the explorer from the build's network config. Only a well-formed address makes a link: the
 * address comes from the URL, so anything else returns null rather than reaching another site.
 */
export function coinElsewhere(address: string, stage: string | undefined, chain: ChainKey = CHAIN_KEY): ElsewhereLink | null {
  if (!ADDRESS.test(address)) return null;
  if (chain === 'robinhood' && stage === 'graduated') return { label: 'DexScreener', href: `https://dexscreener.com/robinhood/${address}` };
  return { label: 'Explorer', href: `${NETWORKS[CHAIN_NETWORK[chain]].explorerUrl}/token/${address}` };
}
