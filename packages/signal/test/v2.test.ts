import { expect, it } from 'vitest';
import { CoinCardV2Schema, CoinSignalV2Schema, GUARD_CAPABILITIES, type CoinSignal } from '@eko/shared';
import { computeSignal, computeSignalV2, inputFromCardV2, riskReadingV2, signalPresentationV2, signalReadingValueV2, SIGNAL_VERSION, SIGNAL_V2_VERSION, type SignalInputV2 } from '../src/index.js';
import { guardFixture } from '../../policy/test/guard-fixtures.js';
import { guardBuyGate } from '../../policy/src/guard.js';
import { PRESETS } from '../../policy/src/presets.js';
import { card as v2Card, observed, unknown, power } from '../../shared/test/fixtures/contracts/guard-v2.js';
import { base } from './fixtures.js';
const degenPolicy = { ...PRESETS.degen, mode: 'degen' as const, killed: false, version: 1 };

function input(level: 'lower' | 'elevated' | 'high' = 'lower'): SignalInputV2 {
  const guard = guardFixture(level);
  return { guard, powers: CoinCardV2Schema.shape.control.shape.powers.parse(GUARD_CAPABILITIES.map(capability => ({
    ...power, capability, reachable: observed('powers', false, 'boolean'),
  }))), lpStatus: CoinCardV2Schema.shape.liquidity.shape.lpStatus.parse(observed('lpStatus','locked','status')) };
}
function legacy(): CoinSignal {
  return { ...computeSignal(base()), readings: { momentum: 100, liquidity: 100, holders: 100, narrative: 100, risk: 100 }, composite: 100, lowData: [] };
}

it('keeps separately versioned five readings, fixed weights, methods and exact Guard receipt', () => {
  const source = { ...input(), legacySignal: legacy() }, before = JSON.parse(JSON.stringify(source));
  const result = computeSignalV2(source);
  expect(SIGNAL_VERSION).toBe(1); expect(SIGNAL_V2_VERSION).toBe(2);
  expect(CoinSignalV2Schema.parse(result)).toEqual(result);
  expect(result).toMatchObject({ composite: 100, beta: true, asOfBlock: '123', guardReceiptId: source.guard.receipt.id,
    inputMethodVersions: { momentum: '1.0.0', liquidity: '1.0.0', holders: '1.0.0', narrative: '1.0.0', risk: '2.0.0' } });
  expect(Object.keys(result.readings)).toEqual(['momentum','liquidity','holders','narrative','risk']);
  expect(computeSignalV2(source)).toEqual(result); expect(source).toEqual(before);
});

it('deducts the Elevated band once and tax-raise/blacklist/mint once each despite duplicate authorities', () => {
  const source = input('elevated');
  const active = source.powers.map(p => ({ ...p, reachable: { ...p.reachable, status: 'observed' as const, value: true } }));
  source.powers = [...active, ...active, ...active];
  source.lpStatus = { ...source.lpStatus!, status: 'observed', value: 'removable' };
  expect(riskReadingV2(source)).toEqual({ score: 30, lowData: false }); // 100 - 25 - 30 - 15
  expect(riskReadingV2({ ...source, guard: input().guard }).score).toBe(55);
  for (const value of ['locked','burned','pons_locked'] as const)
    expect(riskReadingV2({ ...source, lpStatus: { ...source.lpStatus!, status: 'observed', value } }).score).toBe(45);
});

it.each(['reference_exit','recent_funding'] as const)('renders risk unavailable for a %s tier gap and prevents Hot', gap => {
  const source = { ...input(), guard: guardFixture('lower',[gap]), legacySignal: legacy() };
  const signal = computeSignalV2(source);
  expect(signal.readings.risk).toBe(50); expect(signal.lowData).toEqual(['risk']);
  expect(signalReadingValueV2(signal,'risk')).toBeNull();
  expect(signal.composite).toBe(95); expect(signalPresentationV2(signal,source.guard).hotEligible).toBe(false);
});

it('uses neutral lowData for unknown/missing/incomplete control or LP observations', () => {
  const source = input();
  expect(riskReadingV2({ ...source, powers: [] })).toEqual({ score: 50, lowData: true });
  expect(riskReadingV2({ ...source, lpStatus: null })).toEqual({ score: 50, lowData: true });
  const p = source.powers[0];
  for (const reachable of [CoinCardV2Schema.shape.control.shape.powers.parse([{ ...p, reachable: unknown('powers','boolean') }])[0].reachable,
    { ...p.reachable, status: 'observed' as const, value: true, coverage: { ...p.reachable.coverage, complete: false, gaps: ['missing' as const] } },
    { ...p.reachable, knownAt: { ...p.reachable.knownAt, acquisitionSequence: '2' } }]) {
    expect(riskReadingV2({ ...source, powers: [{ ...p, reachable }, ...source.powers.slice(1)] })).toEqual({ score: 50, lowData: true });
  }
});

it('preserves High risk zero with gaps, overlays a cached high Signal and still denies Guard buys', () => {
  const source = { ...input('high'), guard: guardFixture('high',['reference_exit']), legacySignal: legacy() };
  const signal = computeSignalV2(source);
  expect(signal.readings.risk).toBe(0); expect(signal.lowData).toEqual([]); expect(signal.composite).toBe(90);
  expect(signalPresentationV2(signal,source.guard)).toEqual({ overlay: 'high', hotEligible: false });
  const withSignal = { ...baseVerdict(source), signal };
  expect(guardBuyGate(withSignal, degenPolicy, source.guard.coin,4663, Number(BigInt(source.guard.cursor.timestampSec) * 1000n)).deny[0]).toContain('guard_high');
  const cached = computeSignalV2({ ...input(), legacySignal: legacy() });
  expect(signalPresentationV2(cached,source.guard)).toEqual({ overlay: 'high', hotEligible: false });
});
function baseVerdict(source: SignalInputV2) {
  return { coin: source.guard.coin, level: 'clear' as const, reasons: [], playbooks: [],
    receipt: { id:'legacy',hash:'0x12',status:'pending' as const },schemaVersion:'verdict-1',asOfBlock:123,guardV2:source.guard };
}

it('cannot turn a high activity score into permission under incomplete Guard', () => {
  const source = { ...input(), guard: guardFixture('lower',['reference_exit']), legacySignal: legacy() };
  expect(computeSignalV2(source).composite).toBe(95);
  const verdict = baseVerdict(source);
  expect(guardBuyGate(verdict,degenPolicy,source.guard.coin,4663, Number(BigInt(source.guard.cursor.timestampSec) * 1000n)).deny[0]).toContain('guard_incomplete');
  expect(guardBuyGate({ ...verdict, signal: computeSignalV2(source) } as typeof verdict,degenPolicy,source.guard.coin,4663, Number(BigInt(source.guard.cursor.timestampSec) * 1000n))).toEqual(
    guardBuyGate(verdict,degenPolicy,source.guard.coin,4663, Number(BigInt(source.guard.cursor.timestampSec) * 1000n)));
});

it('reuses legacy definitions only; absent/lowData readings become 50 without V2 float/depth substitutions', () => {
  const source = input(), original = computeSignal(base());
  const measured = computeSignalV2({ ...source, legacySignal: original });
  expect(measured.readings).toEqual(original.readings); expect(measured.lowData).toEqual(['narrative']);
  const low = computeSignalV2({ ...source, legacySignal: { ...legacy(), lowData:['liquidity','holders'] } });
  expect(low.readings.liquidity).toBe(50); expect(low.readings.holders).toBe(50);
  expect(computeSignalV2(source).lowData).toEqual(['momentum','liquidity','holders','narrative']);
  const card = CoinCardV2Schema.parse(v2Card); card.verdict = source.guard; card.identity.address = source.guard.coin;
  expect(inputFromCardV2(card)?.legacySignal).toBeUndefined();
  expect(computeSignalV2(inputFromCardV2(card)!)).toMatchObject({ readings:{liquidity:50,holders:50} });
  card.verdict = null; expect(inputFromCardV2(card)).toBeNull();
});

it('rejects future legacy samples and card/Guard context mismatches', () => {
  expect(() => computeSignalV2({ ...input(), legacySignal:{ ...legacy(),asOfBlock:124 } })).toThrow('snapshot');
  const card = CoinCardV2Schema.parse(v2Card); card.verdict = input().guard;
  card.freshness.cursor = { ...card.freshness.cursor, blockHash: `0x${'34'.repeat(32)}` };
  expect(() => inputFromCardV2(card)).toThrow('fork mismatch');
});
