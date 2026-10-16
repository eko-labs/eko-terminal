import { loadRegistry, type AddressRegistry } from '@eko/chain';
import { NETWORKS, type NetworkDef, type TokenDef } from '@eko/shared';
/** Keep heritage network metadata; take mainnet execution addresses from the registry. */
export function executionNetworks(registry: AddressRegistry = loadRegistry()): typeof NETWORKS {
  const mainnet = NETWORKS['robinhood-mainnet'];
  const WETH: TokenDef = { ...mainnet.tokens.WETH, address: registry.requireAddress('tokens.WETH') };
  const USDG: TokenDef = { ...mainnet.tokens.USDG, address: registry.requireAddress('tokens.USDG') };
  const tokens = { WETH, USDG };
  const network: NetworkDef = {
    ...mainnet,
    contracts: {
      uniswapV3Factory: registry.requireAddress('uniswapV3.factory'),
      uniswapV3QuoterV2: registry.requireAddress('uniswapV3.quoterV2'),
      uniswapV3SwapRouter02: registry.requireAddress('uniswapV3.swapRouter02'),
      multicall3: registry.requireAddress('multicall3'),
    },
    tokens,
    routes: mainnet.routes.map(route => ({ ...route, base: { ...route.base, token: WETH }, quote: { ...route.quote, token: USDG } })),
  };
  return { ...NETWORKS, 'robinhood-mainnet': network };
}
