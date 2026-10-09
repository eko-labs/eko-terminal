import { describe, expect, it } from 'vitest';
import { loadRegistry } from '@eko/chain';
import { NETWORKS } from '@eko/shared';
import { executionNetworks } from '../src/exec/networks.js';
describe('execution address registry', () => {
  it('uses registry mainnet contracts and tokens without changing shared network metadata', () => {
    const registry = loadRegistry();
    const original = NETWORKS['robinhood-mainnet'].tokens.WETH.address;
    const replacement = registry.requireAddress('pons.router');
    registry.data.tokens.WETH.address = replacement;
    const networks = executionNetworks(registry); const mainnet = networks['robinhood-mainnet'];
    expect(mainnet.tokens.WETH.address).toBe(replacement);
    expect(mainnet.routes[0].base.token.address).toBe(replacement);
    expect(mainnet.routes[0].quote.token.address).toBe(registry.addressOf('tokens.USDG'));
    expect(mainnet.contracts.uniswapV3Factory).toBe(registry.addressOf('uniswapV3.factory'));
    expect(mainnet.contracts.uniswapV3QuoterV2).toBe(registry.addressOf('uniswapV3.quoterV2'));
    expect(mainnet.contracts.uniswapV3SwapRouter02).toBe(registry.addressOf('uniswapV3.swapRouter02'));
    expect(NETWORKS['robinhood-mainnet'].tokens.WETH.address).toBe(original);
    expect(networks['robinhood-testnet']).toBe(NETWORKS['robinhood-testnet']);
  });
  it('fails if an execution address remains TODO', () => {
    const registry = loadRegistry(); registry.data.uniswapV3.factory.address = 'TODO';
    expect(() => executionNetworks(registry)).toThrow('Registry address is TODO');
  });
});
