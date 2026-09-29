import { compareGuardCursors } from '@eko/shared';
import type { Address, GuardCursor, Metric, MetricId, RawAmount, SupplySnapshotV2, SaleEpisode, CampaignMeasurement } from '@eko/shared';
import type { LotMetricsInput } from './lot-input.js';
import { lotHash } from './lot-metrics.js';
import type { LotHistory, SaleFact } from './lot-metrics.js';

type MetricFactory = <T>(id: MetricId, value: T | null, unit: Metric<T>['unit'], numerator?: string | RawAmount | null,
  denominator?: string | RawAmount | null, denominatorKind?: Metric<T>['denominatorKind'], exact?: boolean) => Metric<T>;
type Units = (id: MetricId, n: bigint | null) => Metric<RawAmount>;
type Ratio = (id: MetricId, n: bigint | null, d: bigint | null, kind: 'S' | 'F' | 'other' | 'quote_cost', pct?: boolean) => Metric<string>;
type Quote = (id: MetricId, n: bigint | null, asset?: Address, decimals?: number, exact?: boolean) => Metric<{ asset: Address; decimals: number; amount: string }>;

/** Raw seller episodes and exact trailing trade sums, never causal labels. Each economic sell is counted once. */
export function rawSellingMetrics(input: LotMetricsInput, facts: SaleFact[], histories: Map<Address, LotHistory[]>,
  supplies: SupplySnapshotV2[], principal: Address | null, metric: MetricFactory, units: Units, ratio: Ratio, quote: Quote): {
  episodes: SaleEpisode[]; campaigns: CampaignMeasurement[];
} {
  const now = BigInt(input.cursor.timestampSec), episodes: SaleEpisode[] = [], campaigns: CampaignMeasurement[] = [];
  const groups = new Map<Address, SaleFact[][]>();
  for (const fact of facts) {
    const seller = fact.action.seller;
    if (!groups.has(seller)) groups.set(seller, []);
    const runs = groups.get(seller)!, run = runs.at(-1);
    if (!run || BigInt(fact.action.cursor.timestampSec) - BigInt(run.at(-1)!.action.cursor.timestampSec) > 60n ||
      BigInt(fact.action.cursor.timestampSec) - BigInt(run[0].action.cursor.timestampSec) >= 300n) runs.push([fact]);
    else run.push(fact);
  }
  const historyAt = (seller: Address, cut: GuardCursor | bigint, strictlyBefore = false): LotHistory => {
    const eligible = (histories.get(seller) ?? []).filter(h => typeof cut === 'bigint' ? BigInt(h.cursor.timestampSec) <= cut :
      compareGuardCursors(h.cursor, cut) < (strictlyBefore ? 0 : 1));
    return eligible.at(-1) ?? { cursor: input.coverage.from!, liquid: 0n, acquired: 0n, debit: 0n, receipt: 0n, cashKnown: input.coverage.complete };
  };
  const preSupply = (sale: SaleFact) => supplies.filter(s => compareGuardCursors(s.cursor, sale.action.cursor) < 0 &&
    !input.actions.some(a => compareGuardCursors(a.cursor, s.cursor) > 0 && compareGuardCursors(a.cursor, sale.action.cursor) < 0))
    .sort((a, b) => compareGuardCursors(a.cursor, b.cursor)).at(-1);
  const rawSupply = (s: SupplySnapshotV2 | undefined, field: 'total' | 'holderFloat') => s?.supply[field].status === 'observed' &&
    (field !== 'holderFloat' || s.floatState === 'stable') ? BigInt(s.supply[field].value!.raw) : null;
  const salesMetrics = (seller: Address, selected: SaleFact[], opening: LotHistory, end: LotHistory, supply: SupplySnapshotV2 | undefined) => {
    const sold = selected.reduce((n, f) => n + BigInt(f.action.swapDebit), 0n), acquired = end.acquired - opening.acquired;
    const sameQuote = selected.every(f => f.action.quoteAsset === input.quoteAsset && f.action.quoteDecimals === input.quoteDecimals);
    const net = sameQuote && selected.every(f => f.action.netQuote !== null) ? selected.reduce((n, f) => n + BigInt(f.action.netQuote!), 0n) : null;
    const gross = sameQuote && selected.every(f => f.action.grossQuote !== null) ? selected.reduce((n, f) => n + BigInt(f.action.grossQuote!), 0n) : null;
    const unknown = (id: MetricId) => metric<string>(id, null, 'pct');
    return { soldUnits: units('sold', sold), openingLiquid: units('openingLiquid', opening.liquid), externalAcquisition: units('externalAcquisition', acquired),
      openingFloat: units('openingFloat', rawSupply(supply, 'holderFloat')), openingSupply: units('openingSupply', rawSupply(supply, 'total')),
      openingRealReserve: quote('realReserves', null), soldShare: ratio('soldShare', sold, opening.liquid + acquired, 'other'),
      soldFloatPct: ratio('soldFloatPct', sold, rawSupply(supply, 'holderFloat'), 'F'), soldSupplyPct: ratio('soldSupplyPct', sold, rawSupply(supply, 'total'), 'S'),
      grossSaleReceipts: quote('grossSaleReceipts', gross), netSaleReceipts: quote('netSaleReceipts', net),
      netTradingCashOut: quote('netTradingCashOut', opening.cashKnown && end.cashKnown && sameQuote
        ? end.receipt - opening.receipt - end.debit + opening.debit : null),
      pressure: unknown('pressure'), buyerLossPct: unknown('buyerLossPct'), contributionPp: unknown('contributionPp'),
      cohortCostCoveragePct: unknown('cohortCostCoveragePct'), cohortPositionCoveragePct: unknown('cohortPositionCoveragePct') };
  };
  for (const [seller, runs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sideId = lotHash([input.coin, 'actual-seller', seller]);
    const attribution = (selected: SaleFact[]) => seller === principal ? 'operator' as const :
      selected.some(f => f.origin > 0n || f.sensitive) ? 'origin_unresolved' as const : 'unknown' as const;
    for (const run of runs) {
      const first = run[0], last = run.at(-1)!, start = BigInt(first.action.cursor.timestampSec), tail = BigInt(last.action.cursor.timestampSec);
      const open = now - tail <= 60n && now - start < 300n;
      const through = open ? input.cursor : last.action.cursor, opening = historyAt(seller, first.action.cursor, true), end = historyAt(seller, through);
      const id = lotHash([sideId, first.action.id, 'episodes-2.0.0']);
      const values = salesMetrics(seller, run, opening, end, preSupply(first));
      for (const m of Object.values(values)) { m.cursor = through; m.fromSec = first.action.cursor.timestampSec; m.throughSec = through.timestampSec; }
      const originSold = units('originSold', principal && run.every(f => !f.sensitive) ? run.reduce((n, f) => n + f.origin, 0n) : null);
      originSold.cursor = through; originSold.fromSec = first.action.cursor.timestampSec; originSold.throughSec = through.timestampSec;
      episodes.push({ id, from: first.action.cursor, through, sideId, attribution: attribution(run),
        coverage: input.coverage, evidenceIds: [...new Set(run.flatMap(f => f.action.evidenceIds))].sort(),
        ...values, status: open ? 'open' : 'closed',
        transactionIds: [...new Set(run.map(f => f.action.transactionId))],
        originSold,
        intervention: 'unavailable', interventionStatus: 'unavailable' });
    }
    for (const windowSec of [300, 3600, 86400] as const) {
      const start = now - BigInt(windowSec), selected = runs.flat().filter(f => BigInt(f.action.cursor.timestampSec) > start && BigInt(f.action.cursor.timestampSec) <= now);
      if (!selected.length) continue;
      const effectiveStart = start < BigInt(input.coverage.from!.timestampSec) && input.launch.createdAtSec !== null &&
        BigInt(input.launch.createdAtSec) >= start ? BigInt(input.coverage.from!.timestampSec) : start;
      const opening = historyAt(seller, effectiveStart), end = historyAt(seller, input.cursor);
      const supply = supplies.find(s => BigInt(s.cursor.timestampSec) === effectiveStart), from = supply?.cursor ?? selected[0].action.cursor;
      const values = salesMetrics(seller, selected, opening, end, supply);
      // Missing history before the requested cut cannot supply a zero opening balance.
      if (effectiveStart < BigInt(input.coverage.from!.timestampSec)) {
        values.openingLiquid = units('openingLiquid', null); values.externalAcquisition = units('externalAcquisition', null);
        values.soldShare = ratio('soldShare', null, null, 'other'); values.netTradingCashOut = quote('netTradingCashOut', null);
      }
      for (const m of Object.values(values)) { m.fromSec = effectiveStart < 0n ? '0' : effectiveStart.toString(); }
      campaigns.push({ id: lotHash([sideId, windowSec, input.cursor]), from, through: input.cursor, sideId, attribution: attribution(selected),
        coverage: input.coverage, evidenceIds: [...new Set(selected.flatMap(f => f.action.evidenceIds))].sort(), ...values, windowSec,
        episodeIds: runs.filter(run => run.some(f => selected.includes(f))).map(run => lotHash([sideId, run[0].action.id, 'episodes-2.0.0'])),
        transactionIds: [...new Set(selected.map(f => f.action.transactionId))] });
    }
  }
  return { episodes, campaigns };
}
