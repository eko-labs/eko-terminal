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

/**
 * Pangea on Robinhood Chain ("Pangea" is GMGN's name for it; nothing on chain names it). Read from all 62 launches since
 * the launcher appeared at block 112,824,849 to block 117,470,682 (2026-11-18; docs/robinhood/CHAIN-FACTS.md §7). One
 * transaction per launch: the launcher mints the coin's whole supply (1e18 base units, one whole token, on all 62),
 * opens a Uniswap v4 pool keyed native ETH / coin with fee 0, tick spacing 60 and the registry's Pangea hook, at a price
 * the creator picks, and adds the whole supply as one position whose upper tick is one tick above the opening price.
 * So the pool opens with only the coin in it: every wei of ETH in it later was paid in by a buyer. The creator's price
 * ranged from about 0.005 ETH to 56 ETH for the whole supply (about $10 to $100,000 at $1,800 an ETH). 58 launches were
 * native-ETH pools; 4 were quoted in a token (GME, AI) and are skipped, as Pons' token-quoted curves are.
 */
export const PANGEA_TERMS = { fee: 0, tickSpacing: 60 } as const;
/**
 * Pangea's contracts, measured on chain 2026-11-18 (the registry schema has no place for them yet; scripts/
 * check-addresses.mjs lists them as measured contracts). The launcher is an ERC-1967 proxy with no admin slot set:
 * upgradeable (its implementation at block 117,470,682 is in docs/robinhood/CHAIN-FACTS.md §7).
 */
export const PANGEA = {
  /** Called by every launch transaction; logs PANGEA_POOL_TOPIC (events.ts). */
  launcher: '0xaA61764BD44df5468CaaE856232Ce9B711512449' as Address,
  /** The hook on every Pangea pool (permission flags 0x28cc, both swap return deltas). */
  hook: '0x8e1Bf182a2a1FEdF9850379127D4535F18EA68cc' as Address,
  /** Initializes each pool and holds its single-sided launch position. */
  liquidityManager: '0xbebe68fBfB62E18FBFEbf4365970D192C5f34DC1' as Address,
} as const;
/**
 * long.xyz on Robinhood Chain, read 2026-11-18 (docs/robinhood/CHAIN-FACTS.md §8). Its launches go through a Doppler-style
 * Airlock that logs Create(asset, numeraire indexed, initializer, poolOrHook) and opens a v4 pool keyed numeraire / coin
 * with a dynamic fee and the hook below (tick spacing 8 or 200: not constant, so the key is read from the pool's
 * Initialize), the whole supply in one-sided positions. 881 launches in 24 hours, 2 with native ETH as the numeraire; the
 * rest are quoted in stock tokens, WETH, USDG or other coins, and EKO follows native-ETH pools only. The Airlock is
 * Doppler's design: another front end on this same Airlock would show under the long.xyz label.
 */
export const LONGXYZ = {
  airlock: '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862' as Address,
  /** Doppler's initializer hook on every long.xyz pool (permission flags 0x2544, an after-swap return delta). */
  hook: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' as Address,
  /**
   * Reviewed 2026-11-19: the hook is Doppler's DopplerHookInitializer (whetstoneresearch/doppler at bda077cf; Sourcify full
   * match; no proxy, DELEGATECALL or SELFDESTRUCT). After each swap it takes the fee its pool's fee module (Doppler's
   * "dopplerHook", fixed per pool at launch: the asset's timelock is 0xdead or 0x0) sets, the same on buys and sells, and
   * has no blacklist. Measured on 699 swaps across 59 pools: buys and sells both 0.5% to 2.0%, equal on every pool with
   * both; the fee starts high (up to 100% of the output) and decays to that within 10 to 14 seconds of launch.
   * The hook counts as reviewed only on pools whose module's code matches public source: Rehype at bda077cf (rebuilt
   * byte for byte) and two Sourcify-verified modules. A fourth enabled module (0xe2ae…78b6) has no matching source.
   */
  reviewedModules: ['0x6f02324d20cc679d0e585290caa6b16bacbc0f77', '0x9982538f41f2ae29ddb9d3d9307010052984fdbb',
    '0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215'] as readonly Address[],
} as const;
/**
 * A hookless launcher with no public brand (DexScreener lists its pools as plain Uniswap v4), read 2026-11-18 (§8): 62
 * launches in 24 hours and 210 ETH traded on their pools. Each launch opens a native-ETH / coin v4 pool with no hook
 * (fee 0.05% to 0.2%, tick spacing 200), adds one full-range position seeded with 0.05 to 0.4 ETH, and mints that
 * position's Uniswap PositionManager NFT to the creator (62 of 62): the creator can take the liquidity out, and did on 61
 * of the 62 pools within the day.
 */
export const UNBRANDED_LAUNCHER = '0x3194e32622C5D860a0572C74EdDa99dcfD8FC827' as Address;
/**
 * Robinhood's tokenized stocks on Robinhood Chain ("<Company> • Robinhood Token"), read 2026-11-18 (docs/robinhood/
 * CHAIN-FACTS.md §9): every one checked (TTWO, SPCX, NVDA, AMC, SPY, MSFT, QQQ and 30 more) is the same 283-byte beacon
 * proxy pointing at this beacon. A token named like one with other code (a look-alike "ANTHROPIC • Robinhood Token" has
 * 16,825 bytes) is not one. EKO prices a quote token as a stock only when both match (price.ts QuotePrices).
 */
export const ROBINHOOD_STOCK_TOKEN = {
  beacon: '0xe10b6f6B275de231345c20D14Ab812db62151b00' as Address,
  /** keccak256 of the proxy's runtime code. */
  proxyCodeHash: '0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630' as Hex,
} as const;
