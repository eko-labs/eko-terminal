/**
 * Robinhood Chain network registry.
 *
 * Every address here was taken from an official source (Robinhood Chain docs or Uniswap's
 * deployment docs) and cross-checked on-chain on 2026-09-28. Do not add addresses without
 * a source. Robinhood Chain is an Arbitrum-Nitro L2 — it is unrelated to Robinhood brokerage
 * accounts or the Robinhood brokerage/crypto trading API.
 */
export type NetworkId = 'robinhood-mainnet' | 'robinhood-testnet' | 'elysium-mainnet';

export interface TokenDef {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  source: string;
}

export interface RouteDef {
  /** Chart market this route executes. */
  market: string;
  venue: 'uniswap-v3' | 'uniswap-v4';
  venueName: string;
  /** Asset the user holds/receives for the base side. `native` means ETH (wrapped by the router). */
  base: { symbol: string; native: boolean; token: TokenDef };
  quote: { symbol: string; token: TokenDef };
  /** Fee tiers probed when quoting (hundredths of a bip). */
  feeTiers: number[];
  notes: string[];
}

export interface NetworkDef {
  id: NetworkId;
  chainId: number;
  name: string;
  shortName: string;
  /** Which trading mode uses this network. */
  mode: 'testnet' | 'live';
  nativeSymbol: string;
  publicRpcUrl: string;
  explorerUrl: string;
  faucetUrl: string | null;
  bridgeUrl: string | null;
  docsUrl: string;
  contracts: {
    uniswapV3Factory?: `0x${string}`;
    uniswapV3QuoterV2?: `0x${string}`;
    uniswapV3SwapRouter02?: `0x${string}`;
    multicall3: `0x${string}`;
  };
  tokens: Record<string, TokenDef>;
  routes: RouteDef[];
  /** Shown when a market has no route on this network. */
  unsupportedReason: string;
  verifiedAt: string;
  sources: string[];
}

const RH_DOCS = 'https://docs.robinhood.com/chain';

const MAINNET_WETH: TokenDef = {
  symbol: 'WETH',
  name: 'Wrapped Ether',
  address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  decimals: 18,
  source: 'https://docs.robinhood.com/chain/contracts',
};
const MAINNET_USDG: TokenDef = {
  symbol: 'USDG',
  name: 'Global Dollar',
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  decimals: 6,
  source: 'https://docs.robinhood.com/chain/contracts',
};

const ELYSIUM_DOCS = 'https://elysium.kinetiq.xyz/docs';
/** Elysium tokens from https://elysium.kinetiq.xyz/docs/contract-addresses, checked live by verify:elysium (2026-11-10). */
const ELYSIUM_WHYPE: TokenDef = {
  symbol: 'WHYPE', name: 'Wrapped HYPE', address: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81', decimals: 18,
  source: 'https://elysium.kinetiq.xyz/docs/contract-addresses',
};
const ELYSIUM_USDC: TokenDef = {
  symbol: 'USDC', name: 'USD Coin', address: '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65', decimals: 6,
  source: 'https://elysium.kinetiq.xyz/docs/contract-addresses',
};

export const NETWORKS: Record<NetworkId, NetworkDef> = {
  'elysium-mainnet': {
    id: 'elysium-mainnet',
    chainId: 99901,
    name: 'Elysium',
    shortName: 'Elysium',
    mode: 'live',
    nativeSymbol: 'HYPE',
    publicRpcUrl: 'https://rpc.elysium.kinetiq.xyz',
    explorerUrl: 'https://elysium.kinetiq.xyz/explorer',
    faucetUrl: null,
    bridgeUrl: null,
    docsUrl: ELYSIUM_DOCS,
    contracts: { multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    tokens: { WHYPE: ELYSIUM_WHYPE, USDC: ELYSIUM_USDC },
    // Read-only at launch: no route executes until trading opens.
    routes: [],
    unsupportedReason: 'Trading from EKO is not open on Elysium yet. Checks and charts are live; trade in your own wallet.',
    verifiedAt: '2026-11-10',
    sources: ['https://elysium.kinetiq.xyz/docs/connecting-to-elysium', 'https://elysium.kinetiq.xyz/docs/contract-addresses'],
  },
  'robinhood-mainnet': {
    id: 'robinhood-mainnet',
    chainId: 4663,
    name: 'Robinhood Chain',
    shortName: 'RH Chain',
    mode: 'live',
    nativeSymbol: 'ETH',
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    faucetUrl: null,
    bridgeUrl: 'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum',
    docsUrl: RH_DOCS,
    contracts: {
      uniswapV3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
      uniswapV3QuoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
      uniswapV3SwapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
    tokens: { WETH: MAINNET_WETH, USDG: MAINNET_USDG },
    routes: [
      {
        market: 'ETH-USD',
        venue: 'uniswap-v3',
        venueName: 'Uniswap v3',
        base: { symbol: 'ETH', native: true, token: MAINNET_WETH },
        quote: { symbol: 'USDG', token: MAINNET_USDG },
        feeTiers: [100, 500, 3000, 10000],
        notes: [
          'Chart prices are simulated ETH-USD; execution is ETH ⇄ USDG on Uniswap v3, so quotes differ from the chart.',
          'USDG (Global Dollar) is the stablecoin listed in Robinhood Chain docs; USDC is not listed.',
        ],
      },
    ],
    unsupportedReason:
      'No verified on-chain route for this market on Robinhood Chain. Only markets with official token addresses and a verified venue can execute live.',
    verifiedAt: '2026-09-28',
    sources: [
      'https://docs.robinhood.com/chain/connecting',
      'https://docs.robinhood.com/chain/contracts',
      'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments',
    ],
  },
  'robinhood-testnet': {
    id: 'robinhood-testnet',
    chainId: 46630,
    name: 'Robinhood Chain Testnet',
    shortName: 'RH Testnet',
    mode: 'testnet',
    nativeSymbol: 'ETH',
    publicRpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
    bridgeUrl: null,
    docsUrl: RH_DOCS,
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
    tokens: {},
    routes: [],
    unsupportedReason:
      'No DEX is documented on Robinhood Chain Testnet (Uniswap lists no testnet deployment and the v3 contracts have no code there). Testnet mode supports wallet, network and balance checks; swaps stay disabled. Use paper mode, or a local mainnet fork for end-to-end tests.',
    verifiedAt: '2026-09-28',
    sources: ['https://docs.robinhood.com/chain/connecting', 'https://developers.uniswap.org/docs/protocols/v3/deployments'],
  },
};

/** ETH kept aside for gas when selling native ETH (server quotes and client-side close helpers). */
export const GAS_RESERVE_ETH = 0.0005;

export const NETWORK_FOR_MODE: Record<'testnet' | 'live', NetworkId> = {
  testnet: 'robinhood-testnet',
  live: 'robinhood-mainnet',
};

export function routeFor(network: NetworkId, market: string): RouteDef | null {
  return NETWORKS[network].routes.find((r) => r.market === market) ?? null;
}

export function networkByChainId(chainId: number): NetworkDef | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}
