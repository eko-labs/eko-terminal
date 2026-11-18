# Robinhood Chain (4663): facts trading depends on

Nov 17, 2026 · Measured read-only on mainnet at head block 116,861,404 (20:33 UTC) · Re-run with
`node scripts/robinhood/verify-chain.mjs` (add `NODE_USE_ENV_PROXY=1` behind an HTTP proxy, `--json out.json` for the raw
results, `--strict` to exit 1 on a FAIL).

Every read went to the public RPC `https://rpc.mainnet.chain.robinhood.com`, plus Ethereum mainnet's public RPC (Permit2
comparison), Hyperliquid's public `allMids` and Uniswap's published deployment record. Nothing was signed or sent. The
registry `packages/chain/addresses.4663.yaml` was checked against chain and needed no correction.

Result of the run: **20 PASS, 1 FAIL (Blockscout), 0 UNKNOWN.** Three earlier runs the same afternoon gave the same
verdicts.

## 1. Chain

| Check | Result | Evidence |
| --- | --- | --- |
| `eth_chainId` | PASS | `0x1237` = 4663 |
| Block time | PASS | 100 s over blocks 116,860,404 to 116,861,404 = **0.100 s per block**; 0.1015 s over 10,000 blocks, so 24 h ≈ 850,000 blocks. Timestamps are whole seconds, so about 10 blocks share each timestamp |

## 2. Uniswap v4

| Check | Result | Evidence |
| --- | --- | --- |
| PoolManager, Universal Router, V4Quoter and Permit2 have code | PASS | PoolManager `0x8366…0951` 24,009 bytes `0xbd388118…95626`; UniversalRouter `0x204F…0498` 24,380 bytes `0x76b92a5b…3d296`; V4Quoter `0x8Dc1…8F94` 6,118 bytes `0xd707b1da…868f6`; Permit2 9,152 bytes `0x5208783f…a7fca`. All four equal the hashes recorded at block 77,438,572 (`packages/chain/test/fixtures/4663/registry-code.json`) |
| `router.poolManager()`, `quoter.poolManager()` | PASS | both return `0x8366a39CC670B4001A1121B8F6A443A643e40951`, the registry's PoolManager |
| Permit2 is canonical | PASS | Ethereum mainnet's Permit2 code (`0xc67d1657…51131`) with its two immutables swapped for 4663's (chain id 4663 and the EIP-712 domain separator for chain 4663) hashes to `0x5208783f…a7fca`, exactly the 4663 code |
| Universal Router version | PASS: **v2.1.2** | Uniswap/contracts `deployments/4663.md` labels `0x204F…0498` as `UniversalRouter#v2.1.2` (commit 802fe4c); its deployment tx `0xf669b9a4…6da339` succeeded at block 65,727,895 |
| V4 `SWAP_EXACT_IN_SINGLE` input layout | PASS: **6-field** | 43 of 43 `SWAP_EXACT_IN_SINGLE` params in 80 recent router txs re-encode byte-for-byte only as `(PoolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256, bytes hookData)`; none as the 5-field form. The extra `uint256` was 0 in every one. Examples: `0x48ed50c7e178da7ee2206b58b1dc1d6250b0c56ea93b3ad76ef0cc5867138ee8`, `0x95aaf2d4a0e67ba5f4c909d1794f21a013ac2c9f16c823e49d8ffb0ec0a567a1`, `0x791c5bf298a44f595d00bd09723debbcdce2e9a603d7b640f17ee93afced2127`. An earlier run decoded 49 of 49 the same way |

## 3. Pons

| Check | Result | Evidence |
| --- | --- | --- |
| Factory `0x7eD5…EC7e` still launches | PASS | **925 launches in the last 24 h** (blocks 115,997,404 to 116,861,404). Latest: block 116,857,304, tx `0x8c36c156f3150830d6ca3a135d40bea76ab10eefcc142a4ea30e1c0d829f661a` |
| Quote assets (`TokenLaunched.pairToken`, 24 h) | PASS | **native ETH 800 (86.5%)**, **USDG 93 (10.1%)**, other tokens 32 (3.4%): NVDA `0xd060…9EEC` 13, TTWO `0x5e81…9786` 5, the Pons coin ORBIO 4, nine others 1 to 2 each. All use `launchConfigId` 0; ETH curves graduate at 4.2 ETH, USDG curves at 8,090 USDG |
| Curve, token and factory selectors | PASS | Using the fork manifest's dispatcher scan, 3 ETH curves and 1 USDG curve launched today have all 23 selectors `fork-manifest.ts` and `pons.ts` use, including `buy(uint256,uint256,address)` `0x59a87bc1`, `sell(uint256,uint256,address)` `0xd04c6983`, `getReserves`, `sellableTokens`, `graduationThreshold`, `graduated`, `readyToGraduate`, `currentSnipeTaxBps`, `trackedTokens`, `realQuoteReserve`, `phantomQuote`, `reservedTokens`. Tokens have `curve()`, `launchFactory()` and the ERC-20 calls; the factory has `getLaunchedToken`, `locker`, `positionManager`, `memeHook`. `getLaunchedToken` returns the 15 words the manifest expects ([0] token, [1] curve, [4] 0, [10] 0, [14] 1) |
| Curve code identity | see note | Each curve's code hash is different, because three immutables vary: the deployer address and `creatorTaxBps` and `feeBps` (PUSH32 operands). With those masked, every ETH curve hashes to `0x2c748a64dd846189…` and the USDG curve to `0xab27ed3690f87e3b…` |
| Curve math | PASS | 6 of 6 recent trades replayed **exactly** from their pre-trade state at block − 1. Buy: fee = gross × `feeBps`/10⁴ and creator tax = gross × `creatorTaxBps`/10⁴, both on the gross quote; tokens out = net × trackedTokens / (realQuoteReserve + phantomQuote + net). Sell: quote = tokensIn × (real + phantom) / (trackedTokens + tokensIn), then the same two charges come off the quote. This is `ponsBuy`/`ponsSell` in `packages/chain/src/simulation/pons-math.ts`. Buys: `0x231988dd…74c9`, `0xe7f7e0d4…35da`, `0x392d4963…fd16`. Sells: `0x71f3e837…033e`, `0x155eb995…ad31`, `0x72e4a75a…d12`. `feeBps` is 100 on all curves; `creatorTaxBps` varies (0 to 300 seen) |
| Factory code unchanged since the registry date | PASS | factory `0x89a27da6…a67d84`, hook `0xc21b1e6c…a10db`, Pons router `0xed906518…2e7`: all equal the hashes recorded at block 77,438,572 (registry `verified: 2026-10-01`) |
| Pons v4 hook and `hookData` | PASS: **not needed** | Hook flags `0x2044` = beforeInitialize, afterSwap, **afterSwapReturnDelta**, so the hook takes its cut after the swap and the V4Quoter's quote includes it. All 30 graduation pools in the last 6,000,000 blocks are keyed native ETH / coin, fee 0, tick spacing 200. Router swaps on Pons pools pass `hookData = 0x` (`0x030b3725d8726c6e23e0727810e5c58988c55ae6325b86c8b4e0e1d32563db6a`, `0xb05f40c0228b9df538ab7cd36bca90378db71572930de6a3d26b8f19663d9e05`, `0x538f8407753429ba354acd5270da0ab5b3026296344f6c6af0f88330266b9acc`). `V4Quoter.quoteExactInputSingle` with `hookData 0x` on pool `0x9aee7ac9…31a2` returned a quote at head. The newest graduated coin's `curve.graduated()` is true |
| Locker and PositionManager pins | PASS | `factory.locker()` `0x2674…4952` hashes to `0x58455f80…742025`, and `factory.positionManager()` `0x58da…4fA7` (Uniswap's v4 PositionManager) hashes to `0xc873e135…670b2`, both equal to the pins in the frozen copy's `apps/server/src/exec/pons-graduation.ts`. Its `poolManager()` is the registry PoolManager and `factory.memeHook()` is the registry hook |
| When the anti-snipe tax ends | PASS: **3 s after launch** | `currentSnipeTaxBps(token)` read block by block from the launch block. Time is counted from `curve.launchedAt()`, which equals the launch block's timestamp. The tax was **9,900 bps at t+0 s, 618 at t+1 s, 19 at t+2 s and 0 from t+3 s** (about 30 blocks), the same on every sample: ETH coin `0x8bc7…4257` (launch tx `0x6ceffa49…3535`), USDG coin `0x71fC…7a64` (tx `0x8c36c156…f661a`), and, in earlier runs the same day, ETH coins `0x72B5…10f5`, `0x7996…6543`, `0x94Fd…Aa9E` and `0xC3b3…7f39`. Block timestamps are whole seconds, so these four values are the whole schedule for launch config 0 |

## 4. Public RPC

| Check | Result | Evidence |
| --- | --- | --- |
| `eth_call` with a state override | PASS | A code override on an empty address returned the injected value (`0x…2a`). A balance override let an unfunded throwaway address simulate `buy(0.001 ETH)` on curve `0xd151…D441`, which returned 542,844,301,378,162,627,711,700 tokens; the same call without the override fails with "insufficient funds". The sell probe's override path works |
| `eth_getLogs` limits | PASS | **10,000 logs per response** ("logs matched by query exceeds limit of 10000"). **100,000-block span** when any topic position holds more than one value ("only 100000 are allowed for this request; narrow the block range, or send one value per position"). With one address and one value per topic there is no span limit: 5,000,001 blocks of factory launches came back in 0.6 s |
| Rate limit near 5 req/s | PASS: **no 5 req/s cap** | 30 light calls paced at 5/s, 60 back-to-back at 14.5/s and 40 concurrent all returned 200. 429s are rare (1 in 306 requests in the final run, 5 in 316 in the first) and come mostly with heavy `eth_getLogs`, as JSON-RPC error code 429 "Too Many Requests". Retry with backoff |
| How far back state is kept | **important** | `eth_call` and `eth_getBalance` work only about **5,000 to 6,200 blocks back (8 to 10 minutes)**. Older blocks fail with "historical state … is not available". Logs, blocks, transactions and receipts are kept for the whole chain |

## 5. Blockscout

| Check | Result | Evidence |
| --- | --- | --- |
| `/api?module=logs&action=getLogs` without a key | **FAIL** | HTTP 403 with `cf-mitigated: challenge` from `server: cloudflare`, serving Cloudflare's "Just a moment" HTML page. `/api/v2/stats` gives the same. Scripts cannot use it without a key or an allowlist |

## 6. ETH/USD

| Check | Result | Evidence |
| --- | --- | --- |
| WETH/USDG v3 pool vs Hyperliquid | PASS | The deepest pool is fee 100, `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (liquidity 1.15e18): **1,797.95 USDG per WETH**. Hyperliquid `allMids` ETH was 1,799.25, a difference of **−0.07%**. The other tiers read 1,798.11 (fee 500), 1,796.85 (fee 3000) and 1,785.37 (fee 10000, thin) |

## 7. Pangea (added Nov 18, 2026)

Measured with the paid archive RPC the edge uses (dRPC) at head block 117,470,682 (Nov 18, 2026). Nothing was signed or
sent. The three contracts are pinned in `apps/edge/src/chains/robinhood/profile.ts` (`PANGEA`) and listed as measured
contracts in `scripts/check-addresses.mjs`: the registry's schema has no place for them yet, and every registry entry
needs captured code for `verify:chain`'s tests. "Pangea" is GMGN's name for this launchpad: nothing on chain names it, and its contracts have no verified source
(Blockscout cannot be scripted, §5). The coins the owner saw on GMGN are on chain under these symbols, all launched by
the contract below: SPDA `0xf1b9b807be71299e56b73fcacd918bd4c38d76ea`, SPc `0x9c732ed7c2740cb99f282bf8228819162c9b16ea`,
SPd `0xf3475f0cb31c5167e91033b51ee53cbd7a52f6ea`, SPb `0x5ca6bab43a75aa6ee710a81c5bfd9c76b3a166ea`, SPe
`0xb82b79100c77e1c29970f3d423b473729038d6ea`, SPf `0xad0dbfd58877fd518660c94b4d9852901aaaa6ea`. Found by scanning every
ERC-20 mint in the last 800,000 blocks (4,113 tokens) for these symbols.

| Check | Result | Evidence |
| --- | --- | --- |
| Launcher | `0xaA61764BD44df5468CaaE856232Ce9B711512449` (`PANGEA.launcher` in `apps/edge/src/chains/robinhood/profile.ts`) | Every SP\* launch transaction calls it (selector `0x2b3ea872`). 130 bytes of code: an ERC-1967 proxy whose implementation is `0x9edFF721992e4bDcA07b8D9A7e73eDe1f7581909`, with no admin slot set, so it is upgradeable by whatever the implementation allows. Its code first appears at block 112,824,849; first launch at block 112,878,001 (tx `0xf947c000e7c488eeecad96a83b324384cd08b86da73d34fcb89c8f5c8dc6dc70`) |
| Launches | **62** to block 117,470,682 | 4, 4, 3, 3, 26 and 22 over the last six days, newest last. Counted from the launcher's records below |
| Launch transaction | **one transaction, pool from the first block** | The launcher mints the whole supply to itself, passes it to the liquidity manager `0xbebe68fBfB62E18FBFEbf4365970D192C5f34DC1` (`PANGEA.liquidityManager`), which initializes a Uniswap v4 pool on the registry PoolManager and adds the whole supply as one position from tick −887,220 up to one tick above the opening tick. Then the creator's optional buys go through `0x8414D1B0aE32ee2e08AbcDeA8855e30a181a4C92` to wallets the creator names (SPd: six buys of 0.00333 ETH to six wallets, tx `0x81be7eb02493563f46d9ebb2c7c44d651e3022dd8bf662455e86eb98e903c5f5`) |
| Supply | **1e18 base units (one whole token)** on all 62 | The mint `Transfer(0 → launcher)` in each launch transaction |
| Pool key | **native ETH / coin, fee 0, tick spacing 60, hook `0x8e1Bf182a2a1FEdF9850379127D4535F18EA68cc`** (`PANGEA.hook`) | 58 of 62 pool ids equal the id of that key. The other 4 are quoted in a token: 3 in GME `0x1b0e319c6a659f002271b69db8a7df2f911c153e`, 1 in AI `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18`. **Not WETH**: GMGN shows these pools as WETH-quoted, but on chain currency0 is native ETH (`0x0`), not WETH `0x0Bd7…AD73` |
| Opening price | **set by the creator; the pool opens with no ETH in it** | The position sits entirely below the opening price, so it holds only the coin: buying moves the price into it, and every wei of ETH in the pool was paid in by a buyer. At $1,800 an ETH, 52 native launches opened between $10 and $4,617 of market cap; the six SP\* coins opened at $100,242 to $100,845 (tick −40,201 or −40,261: 55.7 to 56.0 ETH for the one token) |
| Launch records | two launcher events per launch (names and ABI not published) | `0x726b030b…6d53` (topics: launch id, coin; data: name, symbol, a cross-chain registry `0x52a4b40fa6d72f44fbAADb0e38cBc087b3Af0880`, the hook, and the numbers 100 and 10,000). `0xbdca3fcd…40ca` (topics: launch id, coin, creator = the transaction's sender on all 62; data: pool id, a per-launch contract, the position's upper tick, and a flag set on 39 of the 58 native launches whose meaning is unknown: it is not the quote). EKO reads the second. The registry logs the chain ids 4663, 8453, 99901 and `0x536f6c4d` ("SolM") for each coin; what that registration does was not checked |
| Hook permissions | **flags `0x28cc`** | beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, **beforeSwapReturnDelta, afterSwapReturnDelta**: the hook can change what a swap pays or returns. Not reviewed |
| Trading on the native pools | 2,703 swaps since the first launch | 1,114 buys (5.78 ETH in), 1,589 sells (5.72 ETH out); 40 of the 58 pools traded, 38 of them with sells; 2,052 of the swaps sent by the Universal Router `0x204F…0498` |
| The six SP\* coins an hour after launch | **$0 to $1.06 of ETH in the pool, $104 to $216 of volume, 0 to 2 holders** | Volume is many tiny round trips (33 to 312 swaps each). Holders here count balances built from transfers to and from the PoolManager and the launcher, so a wallet-to-wallet transfer would be missed: an approximation |
| Sell check (honeypot) | **sellable, 1.99% round trip** | EKO's own `runSellProbe` on the `uniswap_v4` route with empty `hookData`, 0.005 ETH, at the head, on SPc, SPd, SPb, SPe and SPf: buy and sell both went through and returned 98.01% of the ETH. Consistent with a 1% hook fee each way (the launch record's 100 / 10,000), not verified. With the native key, the GME-quoted pool's buy fails, as it should |

### What EKO does with it

- The tracker reads `0xbdca3fcd…` in the existing topic-OR launch query (no extra `eth_getLogs` per span), keeps only records from
  the registry's launcher whose pool id equals the native-ETH key's id, and follows the coin from its launch: its pool's swaps
  and its transfers come through the tracker's own Swap and Transfer calls. Supply is summed from the coin's mint.
- New playbook `fake_mcap`: price × supply against the ETH buyers paid into the pool on net. Danger at a market cap of $20,000
  or more with under 2% of it paid in, when 24-hour volume is also under 2% of it or there are 3 holders or fewer; Monitor
  when only the first two hold. Set from these launches, not calibrated on outcomes.
- The sell check runs on the Pangea pool (v4 route, empty `hookData`); the hook shows as unreviewed (a `malicious_hook`
  Monitor); the liquidity status is named missing, never claimed. EKO checks Pangea coins but does not trade them.

### Unknown

- The launcher events' names and full layout, the flag word, and what the per-launch contract does.
- Whether the liquidity manager can remove a pool's launch position, and who can upgrade the launcher.
- The hook's fee rule beyond the measured 1.99% round trip, and whether it can block sells for some wallets.
- Pangea coins launched before a restart are kept only through the snapshot and the start-up replay (about 55 minutes); the
  start-up warm-up does not rebuild older Pangea launches the way it rebuilds Pons launches.
- The fake_mcap thresholds against outcomes (what buyers of these coins got back a day later).

## Blocks trading / safe to ship / unknown

### Blocks trading until handled

1. **The 5-field v4 swap encoder.** The 4663 router (v2.1.2) decodes `SWAP_EXACT_IN_SINGLE` as the 6-field struct. The old product's `apps/server/src/exec/v4-routes.ts` (`singleParams`, line 105, both in this repo and in the frozen copy) encodes 5 fields, so its graduated-coin swaps would be misread or revert. Do not port it. `apps/edge/src/trade.ts` `buildSwap` already encodes the 6-field form with `reserved: 0`, which matches every real swap, so reuse it for 4663.
2. **The public RPC keeps only about 9 minutes of state.** Any read at a pinned block older than about 5,000 blocks fails. This hits fork-manifest pins, `readPonsProfile` and `antiSnipe` at a past block, anvil forks of an older block, and replays. Pin within about 4,000 blocks of head, or configure an archive RPC for these reads.
3. **Exact curve code hashes in the fork manifest's review.** `fork-manifest.ts` binds a review by exact `curveCodeHash`, but every curve's hash differs because of its immutables. With exact hashes, every coin falls to `unknown_factory_layout`. Bind to the masked hash (deployer, `creatorTaxBps` and `feeBps` zeroed) or to the factory.
4. **Blockscout cannot be scripted.** `abi:pull` and any explorer-API lookup are behind Cloudflare. Use RPC `eth_getLogs` instead, chunked to 100,000 blocks for multi-value topics and split when a call returns over 10,000 logs.

### Safe to ship

- Chain id 4663, 0.1 s blocks (about 850,000 a day). Do not reuse Elysium's block-time constants.
- The registry's v4 addresses and wiring, canonical Permit2, and Universal Router v2.1.2 with the 6-field `ExactInputSingle` (extra field 0, `hookData` `0x`).
- The Pons factory, hook and router are unchanged since 2026-10-01. Curve selectors, the `getLaunchedToken` layout and the curve math in `pons-math.ts` match chain exactly for ETH curves.
- Graduated Pons pools: native ETH / coin, fee 0, tick spacing 200, empty `hookData`. Quote them with the V4Quoter, since the hook's after-swap cut is not in pool math. The locker and PositionManager match the reviewed pins.
- Anti-snipe: tax ends at `launchedAt + 3 s` (9,900 / 618 / 19 / 0 bps by whole second). `pons.ts`'s `endsInSec` can be `max(0, launchedAt + 3 − now)` for launch config 0.
- Sell probe: `eth_call` state overrides (code and balance) work on the public RPC.
- ETH/USD: the fee-100 WETH/USDG pool, within 0.1% of Hyperliquid.
- Pacing at 4 to 5 req/s is safe. Treat 429 as backoff-and-retry.

### Unknown

- **USDG and coin-quoted curves (about 13.5% of launches).** They have the same selectors and snipe schedule, but the math replay covered ETH curves only, and buying needs an ERC-20 approve. The USDG curve's masked code differs from the ETH curve's.
- **Other launch configs.** Every launch seen uses `launchConfigId` 0. A new config could change the snipe window or the fees.
- **The size of the Pons hook's after-swap cut.** Not measured; the quoter includes it.
- **Graduation events** (`CurveCompleted`, `PoolGraduated`, `LaunchSwept`) and the Pons router topic `0xdcacba5e…` are still not decoded. Graduation tx `0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4` (block 116,825,292) is a fresh sample. About 30 coins graduated in 7 days, against about 900 launches a day.
- **Who routes graduated-pool swaps.** Of 4,656 Swap logs on Pons pools, the top PoolManager callers are four unlabelled contracts; the Universal Router is a small share. This does not affect EKO's own route.
- **The exact RPC cost budget behind the occasional 429.**
