// BACKEND §7.3, verbatim thresholds. No YAML parser is installed in the lockfile.
export interface PlaybookConfig {
  honeypot: { minLossPct: number; requireDeepSim: boolean };
  tax_trap: { fixedInfoMaxPct: number; fixedMonitorMaxPct: number; mutableMonitorMaxPct: number };
  removable_liquidity: { deployerLpShare: number; thinDepth2PctUsd: number; priorRemovalsDanger: number };
  fee_trap_pool: { feeTrapBps: number };
  stuck_at_bonding: { minAgeH: number; volToProgress: number; topClusters: number; topClusterShare: number; deployerStuckDanger: number };
  wash_to_trend: { roundTripSec: number; maxNetShare: number; monitorPct: number; dangerPct: number; usdPerTrader1h: number; maxTraders: number; minVolumeUsd1h: number; minRoundTripsPerActor: number };
  clone_swarm: { trendingTopN: number; originalMinAgeMin: number; trendWindowMin: number; dominantPairShare: number };
  exempt_insiders: { boughtSupplyMonitor: number; boughtSupplyDanger: number };
  bundle_dump: { minWallets: number; fundingWindowH: number; firstBlocks: number; heldMonitor: number; heldDanger: number; cohortSec: number; cohortMonitor: number; cohortDanger: number; cohortBought: number };
  migration_dump: { windowMin: number; soldMonitor: number; soldDanger: number; impactDanger: number };
  malicious_hook: { quoteSimGapPct: number; asymmetricFeePp: number };
  agent_bait: { maxScanChars: number };
  serial_deployer: { monitorRuns: number; dangerRuns: number; spamLaunches7d: number; countSelf: false; dangerOutcomes: readonly ('rugged' | 'honeypot' | 'dumped')[] };
  holder_concentration: { top10Monitor: number; top10Danger: number; largestMonitor: number; transferredMonitor: number };
  dev_dump: { cashOutMultiple: number; firstSellSec: number; minSoldShare: number; heldMonitor: number; heldDanger: number };
  run_up: { outMonitor: number; hourDanger: number };
  launch_snipers: { monitorHeld: number; dangerHeld: number; monitorBoughtDumped: number };
}

export const CONFIG_V1: Readonly<{ [K in keyof PlaybookConfig]: Readonly<PlaybookConfig[K]> }> = Object.freeze({
  honeypot: Object.freeze({ minLossPct: 95, requireDeepSim: true }),
  tax_trap: Object.freeze({ fixedInfoMaxPct: 5, fixedMonitorMaxPct: 25, mutableMonitorMaxPct: 10 }),
  removable_liquidity: Object.freeze({ deployerLpShare: 0.5, thinDepth2PctUsd: 500, priorRemovalsDanger: 1 }),
  fee_trap_pool: Object.freeze({ feeTrapBps: 1500 }),
  stuck_at_bonding: Object.freeze({ minAgeH: 6, volToProgress: 5, topClusters: 3, topClusterShare: 0.6, deployerStuckDanger: 3 }),
  wash_to_trend: Object.freeze({ roundTripSec: 300, maxNetShare: 0.1, monitorPct: 50, dangerPct: 80, usdPerTrader1h: 5000, maxTraders: 20, minVolumeUsd1h: 10000, minRoundTripsPerActor: 2 }),
  clone_swarm: Object.freeze({ trendingTopN: 50, originalMinAgeMin: 10, trendWindowMin: 60, dominantPairShare: 0.8 }),
  exempt_insiders: Object.freeze({ boughtSupplyMonitor: 0.20, boughtSupplyDanger: 0.50 }),
  // Recalibrated on Robinhood Chain, 2026-10-12, on what a buyer got in the 24 hours after buying (7,137 Pons launches
  // with 5+ buyers, entries 5 minutes to 24 hours after launch). The early cohort is every wallet, the deployer
  // included, that bought in the first 60 seconds: the 5-second anti-snipe tax made 682 launches' bundles wait it out
  // (halved from their peak on 54%, 21% with no early buying). What the cohort still holds predicts a loss about twice
  // as well as what it bought: holding 30%+ of supply five minutes in, the price halved within 24 h on 58-67% of
  // launches (2-4% below 15%, 14% at 15-30%); having bought 30%+ whatever is left, on 23-32%.
  bundle_dump: Object.freeze({ minWallets: 3, fundingWindowH: 24, firstBlocks: 35, heldMonitor: 0.15, heldDanger: 0.30, cohortSec: 60, cohortMonitor: 0.15, cohortDanger: 0.30, cohortBought: 0.30 }),
  migration_dump: Object.freeze({ windowMin: 5, soldMonitor: 0.30, soldDanger: 0.60, impactDanger: 0.30 }),
  malicious_hook: Object.freeze({ quoteSimGapPct: 2, asymmetricFeePp: 5 }),
  agent_bait: Object.freeze({ maxScanChars: 4000 }),
  serial_deployer: Object.freeze({ monitorRuns: 1, dangerRuns: 3, spamLaunches7d: 20, countSelf: false, dangerOutcomes: Object.freeze(['rugged', 'honeypot', 'dumped'] as const) }),
  // Calibrated on Robinhood Chain, 2026-10-12, holdings one hour after launch (400 sampled Pons launches with 10+ traders,
  // next-day price halving 4.5% overall): top ten 20-35% of supply halved next day on 23% (1.7% below 20%), 35%+ on 33%
  // (20% fell 80%; 1,367 launches: 35-70% halved on 64%); a non-deployer holder at 10%+ on 27% (4% below); tokens held
  // without buying at 5%+ on 23-25% (under 1% with none). GMGN's own defaults: top ten 30%, phishing 5%.
  holder_concentration: Object.freeze({ top10Monitor: 0.20, top10Danger: 0.50, largestMonitor: 0.10, transferredMonitor: 0.05 }),
  // GMGN's dump: the deployer took out at least 1.5x what it put in and first sold within 30 seconds of launch; here it
  // must also have sold at least 1% of supply (a tiny bag is not a dump). Every such launch in the sample halved from its
  // peak; selling 1% in the first hour without that pattern did not (43% vs 40%). Deployer holding 5%+: Token Sniffer,
  // Mobula and De.Fi's line. Holding 20%+ (65 launches, 2026-10-12): the price halved within 24 h of a buy on 44% and
  // fell 80% on 29% (3% and 1% under 2%); with 30%+ of supply out of the curve, 70% and 46% (56% and 14% under 2%).
  dev_dump: Object.freeze({ cashOutMultiple: 1.5, firstSellSec: 30, minSoldShare: 0.01, heldMonitor: 0.05, heldDanger: 0.20 }),
  // Supply bought out of the Pons launch curve when a buyer arrives (2026-10-12, 29,608 entries on 7,000 launches, price
  // 24 hours after the entry). Under 15% out the price halved on 0.2-3%, at 15-30% on 3-8%; at 30%+ on 85% five
  // minutes after launch, 54% at one hour and 16-48% from three hours on. 30%+ of supply bought on net in the hour
  // before the entry: halved on 74%, fell 80% on 15%. A curve price cannot fall below its start, so the loss is the
  // run-up unwinding, with or without a bundle behind it.
  run_up: Object.freeze({ outMonitor: 0.30, hourDanger: 0.30 }),
  // Elysium, 2026-11-10, NOT calibrated: wallets other than the deployer that bought in the first ~1 s of a launch
  // (Elysium orders by priority fee, so these buys won a fee auction). What they still hold is the overhang a later
  // buyer faces; a large buy mostly sold already is a flip. Refit on a few days of Elysium outcomes.
  launch_snipers: Object.freeze({ monitorHeld: 0.10, dangerHeld: 0.25, monitorBoughtDumped: 0.20 }),
});
