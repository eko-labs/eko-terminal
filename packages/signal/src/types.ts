import type { CoinCard, PlaybookMatch } from '@eko/shared';

/** Percentages use percentage points (0–100), USD amounts and counts are nonnegative. */
export interface SignalInput {
  priceChange5mPct: number;
  priceChange1hPct: number;
  buyVolumeUsd1h: number;
  buyVolumeUsdPrevious1h: number;
  depth2Usd: number;
  exitCost1kPct: number;
  holdersNow: number;
  holdersPrevious1h: number;
  top10Pct: number;
  freshWalletsPct: number;
  bundlesHeldPct: number;
  trendingRank?: number;
  /** Optional when no buying-flow measurement exists; observed zero is data. */
  agentBuyPct?: number;
  /** X mentions per hour, when available. */
  xMentionPace?: number;
  playbooks: readonly PlaybookMatch[];
  control: Pick<CoinCard['control'], 'canChangeTax' | 'canBlacklist' | 'canMint'>;
  lpStatus: CoinCard['liquidity']['lpStatus'];
  asOfBlock: number;
}

// TODO(spec): CoinCard lacks price changes, hourly buy volumes, holder counts/history,
// trending rank and X pace. Until their source contract exists, callers supply these extras.
export type SignalExtras = Pick<SignalInput,
  'priceChange5mPct' | 'priceChange1hPct' | 'buyVolumeUsd1h' | 'buyVolumeUsdPrevious1h'
  | 'holdersNow' | 'holdersPrevious1h' | 'trendingRank' | 'xMentionPace'>;

/** BACKEND §6 and §5.6: flow.agentPct already measures agents' share of buy USD. */
export function inputFromCard(card: CoinCard, extras: SignalExtras): SignalInput {
  return {
    priceChange5mPct: extras.priceChange5mPct,
    priceChange1hPct: extras.priceChange1hPct,
    buyVolumeUsd1h: extras.buyVolumeUsd1h,
    buyVolumeUsdPrevious1h: extras.buyVolumeUsdPrevious1h,
    holdersNow: extras.holdersNow,
    holdersPrevious1h: extras.holdersPrevious1h,
    trendingRank: extras.trendingRank,
    xMentionPace: extras.xMentionPace,
    depth2Usd: card.liquidity.depthUsd.pct2,
    exitCost1kPct: card.tradeability.exitCostPct.usd1k,
    top10Pct: card.supply.top10Pct,
    freshWalletsPct: card.supply.freshWalletsPct,
    bundlesHeldPct: card.supply.bundlesHeldPct,
    agentBuyPct: card.flow.agentPct,
    playbooks: card.playbooks,
    control: {
      canChangeTax: card.control.canChangeTax,
      canBlacklist: card.control.canBlacklist,
      canMint: card.control.canMint,
    },
    lpStatus: card.liquidity.lpStatus,
    asOfBlock: card.freshness.block,
  };
}
