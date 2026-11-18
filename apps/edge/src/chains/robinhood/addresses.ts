import type { Address } from 'viem';
import type { AddressRegistry } from '@eko/chain';
import { ROBINHOOD_PROFILE } from './profile.js';

/**
 * The Robinhood Chain (4663) contracts the read modules use, from the registry (packages/chain/addresses.4663.yaml)
 * plus the ETH/USD reference pool pinned in profile.ts. Plain addresses, so tests and the integrator can pass their own.
 */
export interface RobinhoodAddresses {
  /** Pons factory: emits TokenLaunched; each launch gets its own bonding-curve contract. */
  factory: Address;
  /** Pons Uniswap v4 hook: a v4 Initialize with this hook is a graduation. */
  hook: Address;
  router: Address;
  poolManager: Address;
  v4Quoter: Address;
  multicall3: Address;
  weth: Address;
  usdg: Address;
  /** The Uniswap v3 WETH/USDG pool that cross-checks the ETH price (price.ts). */
  ethUsdPool: Address;
}

export function robinhoodAddresses(registry: AddressRegistry): RobinhoodAddresses {
  if (registry.data.chainId !== ROBINHOOD_PROFILE.chainId) throw new Error('Not the Robinhood Chain registry');
  return {
    factory: registry.requireAddress('pons.factory'), hook: registry.requireAddress('pons.v4Hook'), router: registry.requireAddress('pons.router'),
    poolManager: registry.requireAddress('uniswapV4.poolManager'), v4Quoter: registry.requireAddress('uniswapV4.v4Quoter'),
    multicall3: registry.requireAddress('multicall3'), weth: registry.requireAddress('tokens.WETH'), usdg: registry.requireAddress('tokens.USDG'),
    ethUsdPool: ROBINHOOD_PROFILE.ethUsdPool.address,
  };
}
