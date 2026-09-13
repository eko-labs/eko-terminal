import type { CoinCard, PlaybookMatch } from '@eko/shared';
import type { SignalExtras, SignalInput } from '../src/index.js';

export const match = (level: PlaybookMatch['level']): PlaybookMatch => ({
  id: 'tax_trap', level, confidence: 1, evidence: [],
});

export function base(): SignalInput {
  return {
    priceChange5mPct: 0, priceChange1hPct: 0,
    buyVolumeUsd1h: 1000, buyVolumeUsdPrevious1h: 1000,
    depth2Usd: 50000, exitCost1kPct: 5,
    holdersNow: 100, holdersPrevious1h: 100,
    top10Pct: 0, freshWalletsPct: 0, bundlesHeldPct: 0,
    playbooks: [], control: { canChangeTax: false, canBlacklist: false, canMint: false },
    lpStatus: 'locked', asOfBlock: 123,
  };
}

export const extras: SignalExtras = {
  priceChange5mPct: 4, priceChange1hPct: 10,
  buyVolumeUsd1h: 3000, buyVolumeUsdPrevious1h: 2000,
  holdersNow: 120, holdersPrevious1h: 100,
  trendingRank: 12, xMentionPace: 8,
};

export function card(): CoinCard {
  const address = `0x${'1'.repeat(40)}` as const;
  return {
    identity: { address, name: { text: 'Example', truncated: false, flags: [] },
      symbol: { text: 'EX', truncated: false, flags: [] }, deployer: address,
      createdAt: '2026-10-01T00:00:00Z', launchpad: 'other', stage: 'graduated', quoteAsset: 'ETH', pools: [] },
    tradeability: { exitCostPct: { usd100: 1, usd1k: 6, usd10k: 15 }, buyTaxPct: 1, sellTaxPct: 1, honeypot: false },
    liquidity: { depthUsd: { pct2: 40000, pct5: 80000, pct10: 120000 }, lpStatus: 'removable', feeTiers: [3000] },
    supply: { top10Pct: 20, devPct: 2, bundlesHeldPct: 5, exemptWalletsHeldPct: 3,
      freshWalletsPct: 10, burnedPct: 1, circulating: '1000000' },
    control: { canChangeTax: true, canBlacklist: false, canPause: true, canMint: true, upgradeable: true },
    flow: { window: '1h', agentPct: 60, crewPct: 10, humanPct: 30, washEstPct: 5 },
    playbooks: [match('monitor')],
    verdict: { coin: address, level: 'monitor', reasons: [], playbooks: [match('monitor')],
      receipt: { id: 'fixture', hash: '0x12', status: 'pending' }, schemaVersion: 'verdict-1', asOfBlock: 124 },
    freshness: { block: 123, ageSec: 1 },
  };
}
