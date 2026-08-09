// Guard 2.0 §§2–7: closed namespaces; these are not legacy PlaybookIds.
export const GUARD_CHECK_IDS = ['reference_exit', 'effective_fees', 'controls_hooks', 'supply_float', 'recent_funding', 'coordination_coverage', 'launcher_service', 'operator_history'] as const;
export const GUARD_CHECK_TIERS = {
  reference_exit: 'buy_critical', effective_fees: 'buy_critical', controls_hooks: 'buy_critical', supply_float: 'buy_critical',
  recent_funding: 'lower_tier', coordination_coverage: 'lower_tier', launcher_service: 'lower_tier', operator_history: 'lower_tier',
} as const;
export const GUARD_FACTOR_IDS = ['execution_cost', 'thin_depth', 'operator_hold', 'coordinated_hold', 'coordinated_union', 'top10_float', 'launch_linked_hold', 'principal_origin_hold', 'early_origin_hold', 'persistent_sniper_hold', 'authenticated_dominance', 'horizon_release', 'current_sell_pressure', 'campaign_pressure', 'harmful_selling', 'operator_dump', 'mutable_control', 'arbitrary_control', 'removable_depth', 'exercised_control', 'cycling', 'agent_instruction'] as const;
export const GUARD_FACTOR_FAMILIES = {
  execution_cost: 'E', thin_depth: 'E', operator_hold: 'O', coordinated_hold: 'O', coordinated_union: 'O', top10_float: 'O', launch_linked_hold: 'O', principal_origin_hold: 'O', early_origin_hold: 'O', persistent_sniper_hold: 'O', authenticated_dominance: 'O', horizon_release: 'O',
  current_sell_pressure: 'Ff', campaign_pressure: 'Ff', harmful_selling: 'Ff', operator_dump: 'Ff', mutable_control: 'C', arbitrary_control: 'C', removable_depth: 'C', exercised_control: 'C', cycling: 'I', agent_instruction: 'I',
} as const;
// §5.1 describes decisive conditions without spelling their wire IDs.
// TODO(spec): freeze these descriptive decisive IDs with the first consumer packet.
export const GUARD_DECISIVE_IDS = ['sell_block', 'confiscatory_return', 'no_sell_capacity', 'liquidity_withdrawn', 'severe_cost'] as const;
export const GUARD_REASON_CODES = ['EXIT_COST', 'DEPTH', 'ENTRY_LIMIT', 'SELL_RESTRICTION', 'CONTROL', 'GROUP_HELD', 'TOP_HOLDERS', 'EARLY_BUYERS', 'SAME_BLOCK', 'ORIGIN_SALE', 'SELL_PRESSURE', 'ATTRIBUTED_DUMP', 'EXEMPTIONS', 'CYCLING', 'CLONE', 'HISTORY', 'TEXT_INSTRUCTION', 'INCOMPLETE', 'POLICY_DENIAL'] as const;
export const GUARD_FAILURE_CODES = ['missing', 'stale', 'failed', 'unsupported', 'unreconciled', 'uncalibrated', 'reference_entry_unavailable'] as const;
export const GUARD_SUPPRESSION_CODES = ['duplicate_mechanism', 'incompatible_assignment', 'family_max', 'unreleased'] as const;
export const GUARD_COHORT_IDS = ['insider_candidate', 'exempt', 'early', 'persistent', 'coordination', 'fresh'] as const;
export const GUARD_CAPABILITIES = ['tax_raise', 'blacklist', 'sell_pause', 'mint', 'transfer_upgrade', 'unlock', 'liquidity_remove', 'hook'] as const;
export const GUARD_METRIC_IDS = [
  'factoryDeployer', 'outerSigner', 'principal', 'creationPayer', 'createdAt', 'marketOpen', 'firstTrade', 'graduation', 'quoteAsset', 'clone',
  'entry', 'input', 'tokensReceived', 'returned', 'venueRoundTripCostPct', 'allInRoundTripCostPct', 'gasUsd', 'feeBreakdown', 'sellability', 'maxTxUsd', 'maxWalletSupplyPct', 'buyTaxPct', 'sellTaxPct', 'antiSnipe', 'hooks', 'existingPositionExit',
  'depthBuy2', 'depthBuy5', 'depthBuy10', 'depthSell2', 'depthSell5', 'depthSell10', 'depth2', 'realReserves', 'removableDepthShare', 'lpStatus',
  'minted', 'total', 'sinks', 'locked', 'curveInventory', 'poolInventory', 'circulating', 'holderFloat', 'burnedPct', 'fdvUsd', 'circulatingCapUsd', 'curveProgressPct', 'holders', 'topAddress10', 'topControl10',
  'principalHolding', 'operatorHolding', 'cohortBought', 'cohortHeld', 'largestCoordinatedHeld', 'unionCoordinatedHeld', 'principalOriginOverhang', 'earlyOriginOverhang', 'principalSold', 'operatorSold', 'originSold', 'soldShare', 'soldFloatPct', 'soldSupplyPct', 'dispositions', 'freshHeld', 'freshCount',
  'grossBought', 'sold', 'openingLiquid', 'externalAcquisition', 'held', 'burned', 'netTransferredOut', 'transferFees', 'unexplainedResidual', 'cexDeposits', 'uniqueAcquisitionEstimate', 'basisCoveragePct', 'marketCashOutMultiple', 'allInCashOutMultiple', 'realizedLotMultiple', 'creatorFees', 'lpReceipts',
  'unresolvedFloatPct', 'powers', 'currentController', 'releasableByHorizon', 'pressure', 'directRoutePressure', 'actualDrawdown', 'buyerOriginEstimate', 'buyerOriginReceipts', 'operatorBuyDebits', 'grossSaleReceipts', 'netSaleReceipts', 'netTradingCashOut', 'openingFloat', 'openingSupply', 'openingRealReserve', 'buyerLossPct', 'contributionPp', 'cohortCostCoveragePct', 'cohortPositionCoveragePct', 'drawdownPct', 'peakLiquidationValue', 'troughLiquidationValue', 'horizonLiquidationValue', 'returnPct',
  'lastHarmfulEvent', 'recoveryAsOf', 'oldSideLiquidOverhang', 'takeoverEvidenceStatus', 'buyUsd', 'grossVolumeUsd', 'netNewQuote', 'agentPct', 'declaredAgentPct', 'likelyAgentPct', 'crewPct', 'unclassifiedPct', 'rawActors', 'economicActors', 'purchasedHolderGrowth', 'airdroppedHolderGrowth', 'cyclingPct', 'curveRecyclingRatio', 'dominantPairShare', 'classifiedVolumes', 'instruction', 'launchAgeSec',
  'badRate', 'recentAdverse', 'removalValueUsd', 'removedInventoryPct', 'lostDepthPct', 'marketMaking', 'arbitrage', 'buyback', 'unclassifiedVolume', 'netProceeds', 'exitDiscountPct', 'earliestExecution', 'releaseAt', 'units', 'reserves',
  'raw', 'liquid', 'supplyPct', 'floatPct', 'feeTotal', 'feeOrdinary', 'feeCreator', 'feeTemporary', 'feeHook', 'feeEko', 'feeGas', 'lock', 'release', 'controlBound', 'controlDelay', 'quoteSimGapPct', 'asymmetricFeePp', 'sameBlockRecipients', 'firstSellSec', 'cashOutSeverity', 'freshAgeSec', 'serviceLaunchCount', 'servicePrincipalCount', 'distinctPrincipalFeePairsPct', 'hubDegree', 'fundingConservationPct', 'collectionConservationPct', 'unknownAgeMass', 'unknownAgeCount', 'trendRank', 'trendOnset', 'supplyAnomaly',
] as const;
export type MetricId = typeof GUARD_METRIC_IDS[number];
export type CheckId = typeof GUARD_CHECK_IDS[number];
export type FactorId = typeof GUARD_FACTOR_IDS[number];
export type ReasonCode = typeof GUARD_REASON_CODES[number];
export type DecisiveId = typeof GUARD_DECISIVE_IDS[number];
