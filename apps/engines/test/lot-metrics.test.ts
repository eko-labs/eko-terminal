import { describe, expect, it } from 'vitest';
import type { LotAction, LotMetricsInput } from '../src/lot-input.js';
import type { LotMetricsSnapshot, Metric, RawAmount } from '@eko/shared';
import { measureLotMetricsV2 } from '../src/lot-metrics.js';
import { address, at, base, bot, buy, coin, fixture, hash, opening, principal, quoteAsset, recipient, router, sell, supply, transfer } from './lot-fixtures.js';

const units = (m: Metric<RawAmount>) => m.value?.raw ?? null;
const cohort = (s: LotMetricsSnapshot, id: LotMetricsSnapshot['cohorts'][number]['id']) => s.cohorts.find(c => c.id === id)!;
function assertConservation(s: LotMetricsSnapshot) {
  for (const c of s.cohorts) {
    const d = c.metrics.dispositions;
    if (d.openingLiquid.value === null) continue;
    const raw = (m: Metric<RawAmount>) => BigInt(m.value!.raw);
    const out = BigInt(d.netTransferredOut.value!.amount);
    expect(raw(d.openingLiquid) + raw(d.externalAcquisition)).toBe(raw(d.held) + raw(d.sold) + raw(d.burned) + raw(d.locked) + out + raw(d.fees));
    expect(d.unexplainedResidual.value?.amount).toBe('0');
  }
}
const run = (actions: LotAction[], now = 1100) => measureLotMetricsV2({ ...fixture(now), actions });

describe('031 burns, transfers and actual receiver sales (owner §1)', () => {
  it('transfer alone is not a sale; a later recipient sale preserves origin without assigning ownership or fault', () => {
    const actions = [buy(1, 1001, principal, '100'), transfer(2, 1002, principal, recipient, '100')];
    const moved = run(actions);
    expect(moved.sales).toEqual([]); expect(moved.episodes).toEqual([]);
    expect(units(cohort(moved, 'principal').metrics.sold)).toBe('0');
    expect(units(moved.principalOriginOverhang.liquid)).toBe('100');
    expect(moved.lots[0]).toMatchObject({ owner: recipient, origin: principal, basisPayer: principal });
    expect(cohort(moved, 'launch_linked').members).toEqual([recipient]);
    const sold = run([...actions, sell(3, 1003, recipient, '100')]);
    expect(sold.sales[0]).toMatchObject({ seller: recipient, directPrincipal: false, responsibility: 'not_assessed', units: { raw: '100' } });
    expect(units(cohort(sold, 'principal').metrics.sold)).toBe('0');
    expect(units(cohort(sold, 'launch_linked').metrics.sold)).toBe('100');
    expect(sold.episodes[0].attribution).toBe('origin_unresolved');
    expect(units(sold.episodes[0].originSold)).toBe('100');
    expect(units(sold.principalOriginOverhang.liquid)).toBe('0');
    expect(cohort(sold, 'launch_linked').metrics.marketCashOutMultiple.value).toBeNull();
    expect(cohort(sold, 'launch_linked').metrics.realizedLotMultiple.value).toBe('1.5');
    assertConservation(moved); assertConservation(sold);
  });

  it.each(['burn', 'zero-address transfer', 'proved sink deposit'] as const)('%s is burned disposition, never a sale or quote receipt', kind => {
    const input = fixture(); input.actions = [buy(1, 1001, principal, '100')];
    if (kind === 'burn') input.actions.push({ ...base(2, 1002), kind: 'burn', owner: principal, units: '40' });
    else {
      const destination = kind === 'zero-address transfer' ? address(0) : address(20);
      input.actions.push(transfer(2, 1002, principal, destination, '40'));
      if (kind === 'proved sink deposit') input.exclusions.push({ address: destination, role: 'sink', cursor: at(1000), knownAt: input.knownAt, evidenceIds: [hash(20)] });
    }
    const s = measureLotMetricsV2(input), metrics = cohort(s, 'principal').metrics;
    expect(s.sales).toEqual([]); expect(units(metrics.sold)).toBe('0'); expect(units(metrics.dispositions.burned)).toBe('40');
    expect(metrics.marketCashOutMultiple.value).toBe('0'); expect(units(s.principalOriginOverhang.liquid)).toBe('60');
    assertConservation(s);
  });

  it('CEX custody and an unproved burn-intent wallet retain lots and unknown onward disposal', () => {
    const input = fixture(); const deposit = transfer(2, 1002, principal, recipient, '40') as Extract<LotAction, { kind: 'transfer' }>;
    deposit.cexDeposit = true; input.actions = [buy(1, 1001, principal, '100'), deposit, transfer(3, 1003, principal, address(30), '20')];
    input.exclusions = [{ address: recipient, role: 'exchange', cursor: at(1000), knownAt: input.knownAt, evidenceIds: [hash(30)] }];
    const s = measureLotMetricsV2(input);
    expect(s.sales).toEqual([]); expect(units(cohort(s, 'principal').metrics.dispositions.cexDeposits)).toBe('40');
    expect(units(cohort(s, 'principal').metrics.dispositions.burned)).toBe('0');
    expect(cohort(s, 'launch_linked').members).toEqual([address(30)]);
    expect(units(s.principalOriginOverhang.liquid)).toBe('100'); assertConservation(s);
  });

  it('unrelated early/exempt bots selling never enters the principal cohort or creates harm/history outcomes', () => {
    const input = fixture(); input.launch.roles.push({ role: 'exempt', address: bot, status: 'verified', refs: ['exempt-1'], cursor: at(1000) },
      { role: 'exempt', address: bot, status: 'verified', refs: ['exempt-2'], cursor: at(1000) });
    input.actions = [buy(1, 1001, bot, '200000', '20'), sell(2, 1002, bot, '200000', '1000')];
    const s = measureLotMetricsV2(input);
    expect(cohort(s, 'exempt').members).toEqual([bot]); expect(cohort(s, 'early').members).toEqual([bot]);
    expect(cohort(s, 'launch_linked').members).toEqual([]); expect(units(cohort(s, 'principal').metrics.sold)).toBe('0');
    expect(s.sales[0].directPrincipal).toBe(false); expect(s.sales[0].principalOriginUpper?.raw).toBe('0');
    expect(s.episodes[0].attribution).toBe('unknown');
    for (const e of s.episodes) expect(e).toMatchObject({ interventionStatus: 'unavailable', buyerLossPct: { status: 'unknown', value: null }, pressure: { status: 'unknown' } });
    expect(s).not.toHaveProperty('outcomes'); expect(s).not.toHaveProperty('history'); assertConservation(s);
  });

  it('$10 tiny-bag profit-taking remains raw selling even when half the bag returns more than the entire buy debit', () => {
    const s = run([buy(1, 1001, principal, '100', '10'), sell(2, 1002, principal, '50', '11')], 1003);
    expect(cohort(s, 'principal').soldOfAcquired.value).toBe('50');
    expect(cohort(s, 'principal').metrics.marketCashOutMultiple.value).toBe('1.1');
    expect(s.sales[0].units.raw).toBe('50'); expect(s.episodes[0].status).toBe('open');
    expect(s.episodes[0].buyerLossPct.value).toBeNull(); expect(s.episodes[0].contributionPp.value).toBeNull();
    expect(s.sales[0].responsibility).toBe('not_assessed'); assertConservation(s);
  });
});

describe('031 FIFO, basis and conserved delivery', () => {
  it('mixed acquired/gifted lots retain exact basis and compare FIFO to proportional origin attribution', () => {
    const s = run([buy(1, 1001, principal, '100', '10'), transfer(2, 1002, principal, recipient, '100'),
      buy(3, 1003, recipient, '100', '30'), sell(4, 1004, recipient, '100', '40')]);
    expect(s.sales[0].originUnits).toEqual([{ origin: principal, fifo: { asset: coin, decimals: 0, raw: '100' },
      proportional: { numerator: '50', denominator: '1' } }, { origin: recipient, fifo: { asset: coin, decimals: 0, raw: '0' },
      proportional: { numerator: '50', denominator: '1' } }]);
    expect(s.sales[0]).toMatchObject({ principalOriginLower: { raw: '50' }, principalOriginUpper: { raw: '100' }, responsibility: 'not_assessed' });
    expect(s.issues).toContain('allocation_sensitive'); expect(s.episodes[0].originSold.value).toBeNull();
    expect(s.lots[0].basis?.cost).toEqual({ numerator: '30', denominator: '1' });
    expect(cohort(s, 'launch_linked').metrics.marketCashOutMultiple.value).toBe('1.333333333333333333333333333333333333');
    expect(cohort(s, 'launch_linked').metrics.realizedLotMultiple.value).toBe('4'); assertConservation(s);
  });

  it('gifts and allocations do not invent cash cost or infinity; mixed unknown basis is named', () => {
    const input = fixture(); input.opening = [opening(90, principal, '100')];
    input.actions = [transfer(1, 1001, principal, recipient, '100'), buy(2, 1002, recipient, '100', '10'), sell(3, 1003, recipient, '150', '20')];
    const s = measureLotMetricsV2(input);
    expect(s.issues).toContain('unknown_basis'); expect(s.sales[0].basisKnown).toBe(false);
    expect(cohort(s, 'launch_linked').metrics.realizedLotMultiple.value).toBeNull();
    expect(cohort(s, 'launch_linked').metrics.basisCoveragePct).toMatchObject({ numerator: '50', denominator: '150' });
    assertConservation(s);
  });

  it('a partial mixed transfer keeps origin uncertainty through subsequent descendants and checkpoint lots', () => {
    const actions = [buy(1, 1001, principal, '100'), transfer(2, 1002, principal, recipient, '100'),
      buy(3, 1003, recipient, '100'), transfer(4, 1004, recipient, bot, '100'), transfer(5, 1005, bot, address(40), '100')];
    const moved = run(actions);
    expect(moved.lots.find(l => l.owner === address(40))).toMatchObject({ origin: principal, originAlternatives: [principal, recipient] });
    expect(moved.principalOriginOverhang.liquid.value).toBeNull();
    const s = run([...actions, sell(6, 1006, address(40), '100')]);
    expect(s.sales[0]).toMatchObject({ inheritedOriginUncertainty: true, principalOriginLower: { raw: '0' }, principalOriginUpper: { raw: '100' } });
    expect(s.episodes[0].originSold.value).toBeNull(); expect(s.sales[0].directPrincipal).toBe(false); assertConservation(s);
  });

  it('an untraced opening origin stays unknown, rather than becoming zero principal-origin units', () => {
    const input = fixture(); input.opening = [opening(90, bot, '100', null)]; input.actions = [sell(1, 1001, bot, '50')];
    const s = measureLotMetricsV2(input);
    expect(s.sales[0]).toMatchObject({ principalOriginLower: { raw: '0' }, principalOriginUpper: { raw: '50' } });
    expect(s.episodes[0].originSold.value).toBeNull(); expect(s.principalOriginOverhang.liquid.value).toBeNull();
  });

  it('remaining opening-lot basis cannot substitute for missing lifetime cash totals', () => {
    const input = fixture(); const lot = opening(90, principal, '100');
    lot.basis = { asset: quoteAsset, decimals: 0, cost: { numerator: '10', denominator: '1' } }; lot.basisPayer = principal;
    input.opening = [lot]; input.actions = [buy(1, 1001, principal, '100', '10'), sell(2, 1002, principal, '100', '40')];
    const s = measureLotMetricsV2(input);
    expect(cohort(s, 'principal').metrics.marketCashOutMultiple.value).toBeNull();
    expect(cohort(s, 'principal').metrics.realizedLotMultiple.value).toBe('4');
    expect(s.issues).toContain('unknown_lifetime_cash'); assertConservation(s);
  });

  it('rebuy is another acquisition; turnover can exceed supply without clamping', () => {
    const input = fixture(); input.currentSupply = supply(input.cursor, '100', '100');
    input.actions = [buy(1, 1001, principal, '100', '10'), sell(2, 1002, principal, '100', '12'),
      buy(3, 1003, principal, '100', '10'), sell(4, 1004, principal, '50', '7')];
    const s = measureLotMetricsV2(input), c = cohort(s, 'principal');
    expect(units(c.metrics.grossBought)).toBe('200'); expect(c.boughtSupplyPct.value).toBe('200');
    expect(c.soldOfAcquired.value).toBe('75'); expect(c.metrics.marketCashOutMultiple.value).toBe('0.95');
    expect(units(c.metrics.liquid)).toBe('50'); assertConservation(s);
  });

  it('router/outer caller does not replace economic recipient or invent that recipient cash debit', () => {
    const input = fixture(); input.actions = [buy(1, 1001, recipient, '100', '10', principal), sell(2, 1002, recipient, '50', '8')];
    input.exclusions = [{ address: router, role: 'router', cursor: at(1000), knownAt: input.knownAt, evidenceIds: [hash(8)] }];
    const first = input.actions[0] as Extract<LotAction, { kind: 'buy' }>; first.creationSubtree = true;
    const s = measureLotMetricsV2(input);
    expect(s.lots[0]).toMatchObject({ owner: recipient, origin: recipient, basisPayer: principal });
    expect(units(cohort(s, 'principal').metrics.grossBought)).toBe('0');
    expect(cohort(s, 'early').members).toEqual([recipient]); expect(cohort(s, 'launch_linked').members).toEqual([recipient]);
    expect(cohort(s, 'launch_linked').metrics.marketCashOutMultiple.value).toBeNull();
    expect(s.sales[0].directPrincipal).toBe(false); expect(s.sales[0].principalOriginUpper?.raw).toBe('0'); assertConservation(s);
  });

  it('token fee debits and net quote charges are accounted once and fractional lot basis is exact', () => {
    const input = fixture(); const moved = transfer(2, 1002, principal, recipient, '2') as Extract<LotAction, { kind: 'transfer' }>;
    moved.tokenFee = '1'; const sold = sell(3, 1003, recipient, '1', '3') as Extract<LotAction, { kind: 'sell' }>;
    sold.grossQuote = '4'; sold.quoteFee = '1'; sold.tokenFee = '1'; input.actions = [buy(1, 1001, principal, '3', '10'), moved, sold];
    const s = measureLotMetricsV2(input);
    expect(s.sales[0]).toMatchObject({ units: { raw: '1' }, feeUnits: { raw: '1' }, netQuote: { value: { amount: '3' } }, grossQuote: { value: { amount: '4' } } });
    expect(units(cohort(s, 'principal').metrics.dispositions.fees)).toBe('1');
    expect(units(cohort(s, 'launch_linked').metrics.dispositions.fees)).toBe('1');
    expect(cohort(s, 'launch_linked').metrics.realizedLotMultiple.value).toBe('0.9');
    expect(s.issues).toContain('unresolved_fee_origin'); expect(s.principalOriginOverhang.liquid.value).toBeNull();
    expect(s.lots).toEqual([]); assertConservation(s);
  });

  it('locks remove current liquid overhang, releases preserve original FIFO order and origin', () => {
    const s = run([buy(1, 1001, principal, '100'), { ...base(2, 1002), kind: 'lock', owner: principal, units: '80' },
      { ...base(3, 1003), kind: 'unlock', owner: principal, units: '30' }, sell(4, 1004, principal, '50')]);
    expect(units(cohort(s, 'principal').metrics.locked)).toBe('50'); expect(units(s.principalOriginOverhang.liquid)).toBe('0');
    expect(units(s.principalOriginOverhang.locked)).toBe('50'); expect(s.lots[0].acquiredAt).toEqual(at(1001, 1)); assertConservation(s);
  });

  it('internal transfers and self-transfers cancel for a fixed cohort union', () => {
    const input = fixture(); input.launch.roles.push(...[principal, recipient].map(a => ({ role: 'exempt' as const, address: a,
      status: 'verified' as const, refs: ['exemption-fixture'], cursor: at(1000) })));
    input.actions = [buy(1, 1001, principal, '100'), transfer(2, 1002, principal, principal, '100'),
      transfer(3, 1003, principal, recipient, '100'), sell(4, 1004, recipient, '100')];
    const s = measureLotMetricsV2(input), c = cohort(s, 'exempt');
    expect(c.soldOfAcquired.value).toBe('100'); expect(c.metrics.dispositions.netTransferredOut.value?.amount).toBe('0');
    expect(c.metrics.marketCashOutMultiple.value).toBe('1.5'); assertConservation(s);
  });
});

describe('031 launch/first-trade windows and honest candidate membership', () => {
  it('uses half-open first-trade and launch windows, deduplicates members and excludes outside creation operations', () => {
    const input = fixture(1400);
    input.actions = [buy(1, 1001, recipient, '10'), buy(2, 1004, recipient, '10'), buy(3, 1005, bot, '10'),
      buy(4, 1006, address(20), '10'), buy(5, 1059, address(21), '10'), buy(6, 1060, address(22), '10'),
      buy(7, 1299, address(23), '10'), buy(8, 1300, address(24), '10')];
    const s = measureLotMetricsV2(input);
    expect(cohort(s, 'early').members).toEqual([recipient, bot]);
    expect(cohort(s, 'launch_5s').members).toEqual([recipient]);
    expect(units(cohort(s, 'early').metrics.grossBought)).toBe('30');
    expect(cohort(s, 'launch_60s').members).toContain(address(21)); expect(cohort(s, 'launch_60s').members).not.toContain(address(22));
    expect(cohort(s, 'launch_300s').members).toContain(address(23)); expect(cohort(s, 'launch_300s').members).not.toContain(address(24));
    expect(cohort(s, 'launch_linked').members).toEqual([]);
  });

  it('does not infer a principal from a shared caller/outer signer, or create observed zero for unknown membership', () => {
    const input = fixture(); input.launch.roles = input.launch.roles.map(r => r.role === 'launch_principal' ? { ...r, address: null, status: 'missing' } : r);
    const creationBuy = buy(1, 1001, bot, '100') as Extract<LotAction, { kind: 'buy' }>; creationBuy.creationSubtree = null;
    input.actions = [creationBuy, sell(2, 1002, bot, '100')]; input.creationSubtreeComplete = false;
    input.launch.firstTradeSec = null;
    const s = measureLotMetricsV2(input);
    expect(cohort(s, 'principal')).toMatchObject({ membershipComplete: false, metrics: { sold: { status: 'unknown', value: null } } });
    expect(cohort(s, 'launch_linked').membershipComplete).toBe(false); expect(cohort(s, 'early').metrics.grossBought.value).toBeNull();
    expect(s.sales[0].directPrincipal).toBe(false); expect(s.episodes[0].attribution).toBe('unknown');
    expect(s.sales[0].principalOriginLower).toBeNull(); expect(s.sales[0].principalOriginUpper).toBeNull();
  });

  it('broad gifts suppress automatic candidate labels but preserve origin and later sales', () => {
    const input = fixture(1200); input.opening = [opening(900, principal, '1000')];
    for (let n = 100; n < 200; n++) {
      const leg = transfer(n, 1001, principal, address(n), '1') as Extract<LotAction, { kind: 'transfer' }>;
      leg.distributionId = 'distribution-fixture'; input.actions.push(leg);
    }
    const before = { ...at(1001, 0), boundary: 'before_tx' as const }; input.supplyBoundaries.push(supply(before));
    input.completeDistributions = ['distribution-fixture']; input.actions.push(sell(300, 1002, address(100), '1'));
    const s = measureLotMetricsV2(input);
    expect(cohort(s, 'launch_linked').members).toEqual([]); expect(s.sales[0].originUnits[0]).toMatchObject({ origin: principal, fifo: { raw: '1' } });
    expect(s.sales[0].directPrincipal).toBe(false); expect(s.sales[0].responsibility).toBe('not_assessed');
    expect(units(s.principalOriginOverhang.liquid)).toBe('999'); assertConservation(s);
  });
});

describe('031 raw episodes and trailing campaign sums', () => {
  it.each([61, 301])('%s-second fragmentation splits episodes but remains in 3600/86400-second sums', gap => {
    const start = 1002, now = start + gap * 2;
    const s = run([buy(1, 1001, principal, '300'), sell(2, start, principal, '100'),
      sell(3, start + gap, principal, '100'), sell(4, start + gap * 2, principal, '100')], now);
    expect(s.episodes).toHaveLength(3); expect(s.episodes.slice(0, 2).every(e => e.status === 'closed')).toBe(true);
    for (const W of [3600, 86400]) expect(units(s.campaigns.find(c => c.windowSec === W)!.soldUnits)).toBe('300');
    expect(units(s.campaigns.find(c => c.windowSec === 300)!.soldUnits)).toBe(gap === 61 ? '300' : '100');
    expect(s.campaigns.find(c => c.windowSec === 3600)!.transactionIds).toHaveLength(3); assertConservation(s);
  });

  it('gap exactly 60 seconds stays together; a sell at duration 300 starts a new episode, and no-trade timers close it', () => {
    const actions = [buy(1, 1001, principal, '600'), ...Array.from({ length: 6 }, (_, n) => sell(n + 2, 1002 + n * 60, principal, '100'))];
    const s = run(actions, 1302);
    expect(s.episodes).toHaveLength(2); expect(units(s.episodes[0].soldUnits)).toBe('500'); expect(s.episodes[0].status).toBe('closed');
    expect(s.episodes[1].status).toBe('open'); expect(run(actions, 1363).episodes[1].status).toBe('closed');
  });

  it('same-second execution ordinal determines FIFO, and input reordering cannot change it', () => {
    const input = fixture(); input.actions = [buy(1, 1001, principal, '100'), transfer(2, 1001, principal, recipient, '100'), sell(3, 1001, recipient, '100')];
    const s = measureLotMetricsV2(input);
    expect(measureLotMetricsV2({ ...input, actions: [...input.actions].reverse() })).toEqual(s);
    expect(s.sales[0].originUnits[0].fifo.raw).toBe('100'); assertConservation(s);
  });

  it('episode sold-of-float uses a pinned pre-sale supply and never the current denominator', () => {
    const input = fixture(); input.actions = [buy(1, 1001, principal, '100'), sell(2, 1002, principal, '50')];
    input.supplyBoundaries.push(supply({ ...at(1002, 2), boundary: 'before_tx' }, '1000', '200'));
    input.currentSupply = supply(input.cursor, '2000', '1000');
    const s = measureLotMetricsV2(input);
    expect(s.episodes[0].soldFloatPct).toMatchObject({ value: '25', denominator: '200', denominatorKind: 'F' });
    expect(s.episodes[0].soldSupplyPct.value).toBe('5');
    expect(cohort(s, 'principal').metrics.floatPct.value).toBe('5');
    expect(s.episodes[0].soldUnits).toMatchObject({ cursor: at(1002, 2), fromSec: '1002', throughSec: '1002' });
  });

  it('a later gift does not retroactively change attribution of an unrelated earlier episode', () => {
    const s = run([buy(1, 1001, bot, '100'), sell(2, 1002, bot, '100'), buy(3, 1062, principal, '100'),
      transfer(4, 1063, principal, bot, '100'), sell(5, 1064, bot, '100')], 1065);
    expect(s.episodes.map(e => e.attribution)).toEqual(['unknown', 'origin_unresolved']);
    expect(s.episodes[0].originSold.value?.raw).toBe('0'); expect(s.episodes[1].originSold.value?.raw).toBe('100');
    expect(s.sales.every(sale => !sale.directPrincipal)).toBe(true);
  });

  it('unknown quote/basis leaves those metrics unavailable while direct units and proceeds survive', () => {
    const s = run([buy(1, 1001, principal, '100', null), sell(2, 1002, principal, '50', null)]);
    expect(s.sales[0].units.raw).toBe('50'); expect(s.sales[0].netQuote.value).toBeNull();
    expect(cohort(s, 'principal').metrics.marketCashOutMultiple.value).toBeNull(); expect(s.episodes[0].netTradingCashOut.value).toBeNull();
  });
});

describe('031 captured source and reconciliation failures', () => {
  it('rejects mismatched quote deltas, repeated swap/transfer source legs and inadequate balances', () => {
    const badQuote = fixture(); const action = sell(2, 1002, principal, '10') as Extract<LotAction, { kind: 'sell' }>;
    action.grossQuote = '20'; badQuote.actions = [buy(1, 1001, principal, '100'), action];
    expect(() => measureLotMetricsV2(badQuote)).toThrow('quote deltas');
    const duplicate = fixture(); duplicate.actions = [buy(1, 1001, principal, '100'), sell(2, 1002, principal, '10')];
    duplicate.actions[1].sourceIds = duplicate.actions[0].sourceIds;
    expect(() => measureLotMetricsV2(duplicate)).toThrow('Duplicate');
    expect(() => run([buy(1, 1001, principal, '10'), sell(2, 1002, principal, '11')])).toThrow('Unreconciled');
  });

  it('future actions are excluded, later-known actions cannot complete aggregates, and supply cannot look ahead', () => {
    const input = fixture(); input.actions = [buy(1, 1001, principal, '100')]; const baseline = measureLotMetricsV2(input);
    input.actions.push(sell(2, 1200, principal, '100'));
    expect(measureLotMetricsV2(input)).toEqual(baseline);
    const hidden = fixture(); hidden.actions = [buy(1, 1001, principal, '100')]; hidden.actions[0].knownAt.acquisitionSequence = '2';
    expect(cohort(measureLotMetricsV2(hidden), 'principal').metrics.raw.value).toBeNull();
    const future = fixture(); future.currentSupply = supply(at(1200));
    expect(() => measureLotMetricsV2(future)).toThrow('supply exceeds');
  });

  it('preserves input objects and withholds cash ratios for different quote assets', () => {
    const input = fixture(); const action = sell(2, 1002, principal, '50') as Extract<LotAction, { kind: 'sell' }>;
    action.quoteAsset = address(99); input.actions = [buy(1, 1001, principal, '100'), action]; const before = JSON.stringify(input);
    const s = measureLotMetricsV2(input);
    expect(s.issues).toContain('mixed_quote'); expect(s.sales[0].netQuote.value?.asset).toBe(address(99));
    expect(cohort(s, 'principal').metrics.marketCashOutMultiple.value).toBeNull(); expect(JSON.stringify(input)).toBe(before);
  });
});
