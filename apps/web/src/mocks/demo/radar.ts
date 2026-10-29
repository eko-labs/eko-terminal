import { CoinCardSchema, RadarRowSchema, type CoinCard, type RadarRow, type Untrusted } from '@eko/shared';
import profiles from './radar-profiles.json';
import { createCoinCard } from '../fixtures';

// Frozen output of the prototype's seeded (4663) generator: all 30 profiles, in server order.
const untrusted = (text: string, flags: Untrusted['flags'] = []): Untrusted => ({ text, flags, truncated: false });
const roles = ['momentum', 'liquidity', 'holders', 'narrative', 'risk'] as const;
const weights = { momentum: .30, liquidity: .25, holders: .20, narrative: .15, risk: .10 };
const demo = profiles.map((c) => {
  const seed = createCoinCard();
  const flow = { window: '1h', agentPct: (c.flow.agent + c.flow.likely) * 100,
    declaredAgentPct: c.flow.agent * 100, likelyAgentPct: c.flow.likely * 100,
    crewPct: c.flow.crew * 100, humanPct: c.flow.human * 100, washEstPct: 0, beta: true, confidence: .86 };
  const signal = { composite: c.composite, readings: Object.fromEntries(roles.map((role, i) => [role, c.readings[i]])), weights, beta: true, asOfBlock: c.receipt.block };
  const name = untrusted(c.name), symbol = untrusted(c.symbol, c.symbol === 'EKOX' ? ['impersonation'] : []);
  const playbooks = c.matches.map((m) => ({ id: m.id, level: m.level, confidence: m.confidence,
    evidence: [{ kind: 'stat', ref: `demo:${c.symbol.toLowerCase()}:${m.id}`, label: m.history }], history: { deployerRuns: c.deployer.flagged } }));
  const verdict = { ...seed.verdict, coin: c.address, level: c.verdict, reasons: [c.summary, ...c.matches.map((m) => m.history)],
    playbooks, asOfBlock: c.receipt.block, receipt: { ...seed.verdict.receipt, hash: c.receipt.hash, block: c.receipt.block } };
  delete verdict.beta;
  const card = CoinCardSchema.parse({ ...seed,
    identity: { ...seed.identity, address: c.address, name, symbol, deployer: c.deployer.address,
      createdAt: new Date(Date.parse('2026-10-01T12:00:00Z') - c.ageMin * 60000).toISOString(),
      launchpad: c.launchpad === 'Pons' ? 'pons' : 'other', stage: c.stage === 'migrated' ? 'graduated' : 'curve', curvePct: c.curvePct, pools: [] },
    clone: { isClone: c.symbol === 'EKOX' },
    tradeability: { exitCostPct: { usd100: c.exit['100'], usd1k: c.exit['1000'], usd10k: c.exit['10000'] },
      buyTaxPct: c.taxes.buy, sellTaxPct: c.taxes.sell, honeypot: c.matches.some((m) => m.id === 'honeypot') },
    liquidity: { depthUsd: { pct2: c.depth2, pct5: c.depth2 * 2, pct10: c.depth2 * 4 }, lpStatus: c.launchpad === 'Pons' ? 'pons_locked' : 'removable', feeTiers: c.symbol === 'EKOX' ? [79] : [.3] },
    supply: { top10Pct: c.supply.top10, devPct: c.supply.dev, bundlesHeldPct: c.supply.bundles, exemptWalletsHeldPct: c.supply.exempt,
      freshWalletsPct: c.supply.fresh, burnedPct: c.supply.burned, circulating: String(Math.round(c.mcap / c.price)) },
    control: { canChangeTax: c.control.taxChange, canBlacklist: c.control.blacklist, canPause: c.control.pause, canMint: c.control.mint, upgradeable: false },
    flow, playbooks, verdict, signal, freshness: { block: c.receipt.block, ageSec: 3 }, meta: undefined,
  });
  const top = c.matches.find((m) => m.level === 'danger') ?? c.matches.find((m) => m.level === 'monitor') ?? c.matches[0];
  const row = RadarRowSchema.parse({ address: c.address, name, symbol, launchpad: card.identity.launchpad, stage: card.identity.stage,
    curvePct: c.curvePct, priceUsd: c.price, change1hPct: c.change1h, change24hPct: c.change24h, liquidityUsd: c.liquidity, marketCapUsd: c.mcap,
    verdict: c.verdict, topPlaybook: top?.id, ageSec: c.ageMin * 60, rank: c.rank, flow, exitCost1kPct: c.exit['1000'], signal, spark8h: c.series });
  return { row, card };
});
export const createRadarRows = (): RadarRow[] => structuredClone(demo.map((c) => c.row));
export const createRadarCard = (address: string): CoinCard | undefined => {
  const card = demo.find((c) => c.row.address.toLowerCase() === address.toLowerCase())?.card;
  return card && structuredClone(card);
};
