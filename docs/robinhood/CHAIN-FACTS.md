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
