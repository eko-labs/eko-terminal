import { PlaybookIdSchema, type CoinCardMeta, type PlaybookId } from '@eko/shared';
export const SCANNING = 'Scanning…';
/** Fast Scan normally lands within seconds; past this age a pending row is waiting, not scanning.
 * TODO(spec): FRONTEND §3.4 defines only "Scanning…"; the 60 s threshold and "Scan delayed" copy need sign-off. */
export const SCAN_DELAYED_AFTER_SEC = 60;
export const SCAN_DELAYED = 'Scan delayed';
export const SCAN_DELAYED_DETAIL = "No verdict yet. This launch is waiting in the scan queue; Trade stays off until the guard's first scan finishes.";
export const NOT_FULLY_CHECKED = 'Not fully checked';
/** Why a row's Trade button says Refused, in the reader's risk mode. */
export const REFUSED_TITLE = (mode: 'safe' | 'balanced' | 'degen', hard: boolean) => hard ? 'The guard refuses this coin in every risk mode: it cannot be sold, costs most of a position to sell, or its liquidity can be pulled.'
  : mode === 'degen' ? 'The guard refuses this coin: its sell failed in the buy-then-sell check.' : 'The guard refuses Danger coins in Careful and Balanced. Degen mode accepts a Danger grade given for who holds the coin or how far its price has run.';
export const DANGER_ACCEPTED_TITLE = 'Rated Danger. Degen mode lets you buy it after you accept the warning on the quote.';
/** No check matched (verdict level `clear`). The label names what was found, not a judgement of the coin. */
export const NO_FLAGS = 'No flags';
export const NO_FLAGS_NOTE = 'No flags is not a recommendation.';
/** Run-up score (lib/runUp.ts): the number beside a grade on a coin still on its launch curve. */
export const runUpTitle = (score: number) => `Run-up score ${score} of 100: if the price fell back to the launch curve's starting price, that would be a ${score}% drop.`;
export const runUpDetail = (score: number, multiple: number) => `Run-up score ${score} of 100. The price is ${multiple >= 10 ? Math.round(multiple) : Math.round(multiple * 10) / 10}× the launch curve's starting price, so a fall back to the start would be a ${score}% drop. On past launches the typical coin was back near its start a day later (measured October 2026). The score is a distance, not a forecast.`;
/** A coin whose launch transaction was sent by a relayer, a bundler or a bot: no wallet is recorded as its deployer. */
export const NO_DEPLOYER_TITLE = 'This coin was launched through a relayer or bot, so the wallet that sent the launch is not its creator\'s. Checks that read the deployer\'s wallet have nothing to read; holders that never bought still show under holder concentration.';
/** A coin that launched in a Uniswap pool: what its "In pool" figure counts. */
export const IN_POOL_TITLE = 'ETH, WETH or USDG held in this coin\'s pools right now: what all sellers together could take out. Coins still waiting above the price are not counted.';
export const RUN_UP_LEGEND = 'The number beside a grade is the run-up score, 0 to 100: how far the price would drop if it fell back to the launch curve\'s starting price.';
export const NOT_CHECKED = 'not checked yet';
export const PENDING_ORDER = 'Not fully checked. Some required checks have not run; review the missing checks before placing an order.';
export const NOT_INDEXED = 'Not indexed yet';
export const CARD_UNAVAILABLE = 'Coin card unavailable';
export const CARD_WAIT = 'Search the indexed token identity for its current status.';
export const NEAR_GRAD = 'Half way or more, closest first';
const checks:Record<string,string>={simulations:'buy-then-sell simulation',exitCosts:'exit costs','exitCostPct.usd100':'exit cost at $100','exitCostPct.usd1k':'exit cost at $1K','exitCostPct.usd10k':'exit cost at $10K',buyTax:'buy tax',sellTax:'sell tax',ownerPowerAnalysis:'owner powers',agentPct:'agent labels',crewPct:'crew labels',humanPct:'human labels',depthUsd:'liquidity depth',routing:'routing',completeLpOwnership:'complete LP ownership',antiSnipeTiming:'anti-snipe timing',taxes:'taxes',knownLocksAndVesting:'locks and vesting',bundlesHeldPct:'bundle holdings',freshWalletsPct:'fresh wallet holdings',circulating:'circulating supply',totalSupply:'total supply',dynamicPoolFees:'dynamic pool fees'};
export function missingChecks(evaluated?:PlaybookId[],meta?:CoinCardMeta,missing:string[]=[]) {
  const absent=evaluated ? PlaybookIdSchema.options.filter(id=>!evaluated.includes(id)) : [];
  const names=[...absent.map(id=>id.replaceAll('_',' ')),...missing,...Object.values(meta ?? {}).flatMap(m=>m.missing ?? [])];
  return `Not checked yet: ${[...new Set(names.map(n=>checks[n] ?? n.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ')))].join(', ') || 'buy-then-sell simulation, exit costs, wallet labels and owner powers'}.`;
}

export const CHECK_LEGEND='— not checked yet: exit costs and buyer mix arrive with the trade simulation and wallet labels';
// Plain-language keys for the Guard disclosures; the disclosure labels themselves stay on every row.
export const LEGACY_TITLE='Graded by EKO’s rule set 1.0.x.';
export const GUARD2_UNAVAILABLE_TITLE='Guard 2, the next buyer-risk check, has not been released, so it has no result for this coin.';
export const GUARD_LEGEND='Grades come from EKO’s rule set 1.0.x. Unscanned coins and coins that cannot be sold are refused; other Danger coins are refused unless you trade in Degen mode.';

// Live sell check (BACKEND §6.2 contract probe). A failed sell refuses buy quotes; it is not called a confirmed honeypot.
export const SELL_FAILS='Sell fails';
export const SELL_CHECK_TEXT={sellable:'Sold back in a buy-then-sell simulation',refused:'Sell failed in simulation · buys refused'} as const;
export const SELL_FAILS_TITLE='A buy went through and the sell reverted or returned under 5% in simulation at the checked block, so the guard refuses buys.';
export const NOT_CHECKED_LABEL='Not checked yet';
export const NOT_TRACKED_LABEL='Not tracked yet';
export const FEED_GAPS_LEGEND='— not tracked yet: Ghost Reports, swarm calls and burns arrive with their data sources. Trades are buys and sells of $500 or more.';
export const WALLET_LABELS_LATER='Wallet labels arrive later';
export const FULL_HISTORY='Show full history';
export const SUB_MINUTE_UNAVAILABLE='Sub-minute candle history is incomplete or unavailable';
export function emptyTradeWindow(lastTradeTs:number|null,now=Date.now()/1000) {
 if(lastTradeTs==null)return 'No trades in this window · no indexed trades yet';
 const age=Math.max(0,Math.trunc(now-lastTradeTs));
 const elapsed=age>=3600 ? `${Math.trunc(age/3600)} h` : age>=60 ? `${Math.trunc(age/60)} m` : `${age} s`;
 return `No trades in this window · last trade ${elapsed} ago`;
}
/** Trade buttons while live trading is off: the reason, and where scans and quotes still work. */
export const TRADING_PAUSED_TITLE = 'Live trading is paused. Open the coin for its scan and a quote.';
