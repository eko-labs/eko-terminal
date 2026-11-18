import type { Address, Hex } from 'viem';

/**
 * Robinhood Chain (4663) as the edge sees it: constants measured on the public endpoints on 2026-11-17 (chain head
 * about 116,850,000). Re-measure before relying on a limit that moved.
 */
export const ROBINHOOD_PROFILE = {
  key: 'robinhood',
  chainId: 4663,
  native: 'ETH',
  publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  /**
   * Blockscout's Etherscan-style API. A plain curl (no browser) gets HTTP 403 with Cloudflare's "Just a moment..."
   * challenge page, for /api and /api/v2 alike, from two networks on 2026-11-17: the historian cannot use it as it is.
   * Every fact below was read over the public RPC instead.
   */
  explorerApiUrl: 'https://robinhoodchain.blockscout.com/api',
  explorerApiBehindBotCheck: true,
  /** Mean block time: 0.102 s over the last 1,000 blocks, 0.1032 s over the last 100,000. */
  blockTimeSec: 0.102,
  /**
   * The public RPC keeps state for only about the last 6,000 blocks (about ten minutes): a read at an older block fails
   * "historical state ... is not available". Logs go back to genesis. Pinned reads and the sell probe must use a recent
   * block; the historian rebuilds from logs, never from state.
   */
  stateWindowBlocks: 6_000,
  /** eth_call accepts state overrides (code, balance and stateDiff), which the sell probe needs. */
  stateOverrides: true,
  getLogs: {
    /** Without an address filter: "only 30000 are allowed for this request". */
    maxSpanNoAddress: 30_000,
    /** With an address filter: "only 10000000 are allowed". */
    maxSpanWithAddress: 10_000_000,
    /** Results per call: "logs matched by query exceeds limit of 10000". All ERC-20 Transfers run past it in 2,000 blocks. */
    maxResults: 10_000,
  },
  /** The public RPC answers 429 under a burst of calls (seen at a few calls a second): callers back off. */
  rateLimited: true,
  /**
   * The Pons factory's deployment: its first log (OwnershipTransferred, tx 0x3817f297…deddeb) is at 26,841,846, and
   * no state is older than the window above, so eth_getCode could not bisect it. The first TokenLaunched is at
   * 27,027,321. The historian starts there.
   */
  ponsFactoryDeployBlock: 26_841_846,
  ponsFirstLaunchBlock: 27_027_321,
  /**
   * The ETH/USD cross-check: Uniswap v3 WETH/USDG at the 0.01% tier, the deepest of the four tiers by in-range
   * liquidity (the old indexer's rule: apps/indexer/src/clients.ts). WETH (18 decimals) is token0, USDG (6) token1.
   * It read 1,798.94 against Hyperliquid's 1,800.65 at the time.
   */
  ethUsdPool: { address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca' as Address, fee: 100, wethIsToken0: true, wethDecimals: 18, usdgDecimals: 6 },
} as const;

/**
 * Pons launch terms, from all 734,310 TokenLaunched logs to block 116,852,900: every launch is launchConfigId 0, and
 * every native-ETH launch (452,419) has a 4.2 ETH graduation threshold. The 40 latest each minted 1e27 tokens to their
 * curve. At graduation the curve hands the factory floor(2/7 of supply) for the pool (285,714,285.71… tokens, the same
 * on the four curves checked), so 5/7 is sold on the curve. On a live curve, sellableTokens() and realQuoteReserve()
 * equalled the values rebuilt from its logs to the wei.
 */
export const PONS_TERMS = {
  launchConfigId: 0n,
  supply: 10n ** 27n,
  nativeGraduationThreshold: 42n * 10n ** 17n,
  /** Tokens a curve sells before graduation: supply less the pool's floor(2/7). */
  sellable: (supply: bigint) => supply - supply * 2n / 7n,
} as const;

/**
 * Pons graduation liquidity lock (the old server's apps/server/src/exec/pons-graduation.ts): graduation mints one
 * full-range v4 position through Uniswap's PositionManager and parks the NFT in the Pons launch locker. Runtime code
 * hashes reviewed on 2026-10-06 (block 81,960,826); both still matched on 2026-11-17 (the factory's locker() and
 * positionManager() at the head).
 */
export const PONS_LOCK = {
  locker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952' as Address,
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address,
  lockerCodeHash: '0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025' as Hex,
  positionManagerCodeHash: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2' as Hex,
} as const;

/**
 * Tracker settings that fit this chain. At 0.102 s blocks, 32,400 blocks of backfill is 55 minutes (Elysium's default
 * is about 53). Transfer logs ran at 4.6 to 8.1 a block (200-block samples) and exceeded the 10,000-result cap within
 * 2,000 blocks, so the span starts at 500 (the tracker halves it further on a "limit" reply, and the cap's message
 * matches its retry rule).
 */
export const ROBINHOOD_TRACKER = { backfillBlocks: 32_400, chunk: 500, blockTimeSec: ROBINHOOD_PROFILE.blockTimeSec } as const;
