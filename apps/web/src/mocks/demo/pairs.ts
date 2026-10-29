import { CoinCardSchema, PairRowSchema, type PairRow } from '@eko/shared';
import profiles from './pairs-profiles.json';
import { createRadarRows, createRadarCard } from './radar';
import { createCoinCard } from '../fixtures';
import { MOCK_HEAD_BLOCK } from '../head';

/** Frozen seedPairs(8804) plus the approved prototype's COINS, without UI-only fields. */
export function createPairRows(): PairRow[] {
  return [...profiles.map((r) => PairRowSchema.parse(r)), ...createRadarRows().sort((a, b) => a.ageSec - b.ageSec).map((row) => PairRowSchema.parse({ ...row,
    column: row.stage === 'graduated' ? 'migrated' : (row.curvePct ?? 0) >= 80 ? 'near_grad' : 'new',
    buyers: 0, exitCost100Pct: createRadarCard(row.address)!.tradeability.exitCostPct.usd100, verdictPending: false,
  }))];
}
export function createPairCard(row: PairRow) {
  const seed = createCoinCard();
  return CoinCardSchema.parse({ ...seed, identity: { ...seed.identity, address: row.address, symbol: row.symbol, name: row.name, launchpad: row.launchpad, stage: row.stage, curvePct: row.curvePct },
    tradeability: { ...seed.tradeability, exitCostPct: { usd100: row.exitCost100Pct, usd1k: row.exitCost100Pct, usd10k: row.exitCost100Pct }, antiSnipe: row.antiSnipe }, flow: row.flow,
    playbooks: [], verdict: { ...seed.verdict, coin: row.address, level: row.verdict, reasons: [row.verdictPending ? 'Waiting for the first scan.' : 'Demo first scan.'], playbooks: [], asOfBlock: MOCK_HEAD_BLOCK, receipt: { ...seed.verdict.receipt, block: MOCK_HEAD_BLOCK } }, freshness: { block: MOCK_HEAD_BLOCK, ageSec: 0 },
  });
}
export function newDemoPair(step: number): PairRow {
  const template = createPairRows()[0];
  const symbol = ['ASTER', 'BRINE', 'CAIRN', 'DUSK', 'FLINT', 'GROVE'][step % 6];
  return PairRowSchema.parse({ ...template, address: `0x${(8804000 + step).toString(16).padStart(40, '0')}`, name: { text: `${symbol[0]}${symbol.slice(1).toLowerCase()}`, flags: [], truncated: false }, symbol: { text: symbol, flags: [], truncated: false }, ageSec: 0, verdict: 'monitor', verdictPending: true, column: 'new', curvePct: 1, antiSnipe: { taxPct: 99, endsInSec: 40 } });
}
