import {
  CoinCardV2Schema, CoinSignalSchema, CoinSignalV2Schema, GuardAssessmentV2Schema,
  GUARD_CAPABILITIES, compareGuardCursors, guardKnownBy,
  type CoinCardV2, type CoinSignal, type CoinSignalV2, type GuardAssessmentV2, type Metric,
} from '@eko/shared';
import { compositeFromReadings, SIGNAL_WEIGHTS, type SignalReading } from './index.js';

export const SIGNAL_V2_VERSION = 2;
export const SIGNAL_V2_INPUT_METHOD_VERSIONS = Object.freeze({
  momentum: '1.0.0', liquidity: '1.0.0', holders: '1.0.0', narrative: '1.0.0', risk: '2.0.0',
});

/** Captured inputs only. Legacy readings retain their original denominators/methods.
 * Missing legacy observations never get substituted with V2 float/depth/flow values. */
export interface SignalInputV2 {
  guard: GuardAssessmentV2;
  powers: CoinCardV2['control']['powers'];
  lpStatus: CoinCardV2['liquidity']['lpStatus'] | null;
  legacySignal?: CoinSignal;
}

export function inputFromCardV2(card: CoinCardV2, legacySignal?: CoinSignal): SignalInputV2 | null {
  const parsed = CoinCardV2Schema.parse(card);
  if (!parsed.verdict) return null;
  if (parsed.identity.address !== parsed.verdict.coin ||
      compareGuardCursors(parsed.freshness.cursor, parsed.verdict.cursor) !== 0)
    throw new Error('Signal card/Guard context mismatch');
  return { guard: parsed.verdict, powers: parsed.control.powers, lpStatus: parsed.liquidity.lpStatus, legacySignal };
}

function captured<T>(metric: Metric<T>, guard: GuardAssessmentV2): boolean {
  return compareGuardCursors(metric.cursor, guard.cursor) === 0 &&
    guardKnownBy(metric.knownAt, guard.availabilityCut) && metric.coverage.complete &&
    metric.coverage.gaps.length === 0 && metric.failureCode === null;
}

/** Guard §7.2 CALIBRATE adapter: band once, each confirmed power once, LP once. */
export function riskReadingV2(input: SignalInputV2): { score: number; lowData: boolean } {
  const guard = GuardAssessmentV2Schema.parse(input.guard);
  const powers = CoinCardV2Schema.shape.control.shape.powers.parse(input.powers);
  const lp = input.lpStatus === null ? null : CoinCardV2Schema.shape.liquidity.shape.lpStatus.parse(input.lpStatus);
  // A confirmed High is retained even with gaps; it is never neutralized to 50.
  if (guard.level === 'high') return { score: 0, lowData: false };
  if (guard.level === 'incomplete' || !guard.completeness.buyCriticalComplete ||
      !guard.completeness.lowerTierComplete || guard.completeness.missing.length > 0)
    return { score: 50, lowData: true };
  // TODO(spec): Signal has no narrower required-control manifest; use the shared
  // capability set before treating an unobserved power as absent.
  const confirmed = new Set<string>();
  for (const capability of GUARD_CAPABILITIES) {
    const rows = powers.filter(p => p.capability === capability);
    if (rows.some(p => captured(p.reachable, guard) && p.reachable.status === 'observed' && p.reachable.value)) {
      confirmed.add(capability);
    } else if (!rows.length || rows.some(p => !captured(p.reachable, guard) ||
        (p.reachable.status !== 'observed' && p.reachable.status !== 'not_applicable'))) {
      return { score: 50, lowData: true };
    }
  }
  // Unknown custody cannot establish that the removable-LP deduction is absent.
  if (!lp || !captured(lp, guard) || (lp.status !== 'observed' && lp.status !== 'not_applicable'))
    return { score: 50, lowData: true };
  const count = ['tax_raise', 'blacklist', 'mint'].filter(p => confirmed.has(p)).length;
  return { score: Math.max(0, 100 - 25 * Number(guard.level === 'elevated') - 10 * count -
    15 * Number(lp.status === 'observed' && lp.value === 'removable')), lowData: false };
}

/** Separately versioned shadow computation; never grants permission or supplies a rank. */
export function computeSignalV2(input: SignalInputV2): CoinSignalV2 {
  const guard = GuardAssessmentV2Schema.parse(input.guard);
  const legacy = input.legacySignal === undefined ? undefined : CoinSignalSchema.parse(input.legacySignal);
  if (legacy && (!Number.isSafeInteger(legacy.asOfBlock) || legacy.asOfBlock < 0 ||
      BigInt(legacy.asOfBlock) > BigInt(guard.cursor.blockNumber)))
    throw new Error('Signal legacy input exceeds Guard snapshot');
  const lowData: SignalReading[] = [];
  const readings: CoinSignalV2['readings'] = { momentum: 50, liquidity: 50, holders: 50, narrative: 50, risk: 50 };
  for (const reading of ['momentum', 'liquidity', 'holders', 'narrative'] as const) {
    if (!legacy || legacy.lowData?.includes(reading)) lowData.push(reading);
    else readings[reading] = legacy.readings[reading];
  }
  const risk = riskReadingV2(input);
  readings.risk = risk.score;
  if (risk.lowData) lowData.push('risk');
  return CoinSignalV2Schema.parse({ schemaVersion: 'signal-2', composite: compositeFromReadings(readings),
    readings, weights: { ...SIGNAL_WEIGHTS }, beta: true, asOfBlock: guard.cursor.blockNumber,
    lowData, guardReceiptId: guard.receipt.id, inputMethodVersions: { ...SIGNAL_V2_INPUT_METHOD_VERSIONS } });
}

/** Neutral lowData is serialization compatibility, not an observed reading. */
export function signalReadingValueV2(signal: CoinSignalV2, reading: SignalReading): number | null {
  return signal.lowData.includes(reading) ? null : signal.readings[reading];
}

/** Presentation overlay consumes the CURRENT Guard even when Signal is throttled.
 * High overlays the whole Signal. A completeness gap suppresses Hot at any score. */
export function signalPresentationV2(signal: CoinSignalV2, guard: GuardAssessmentV2) {
  return { overlay: guard.level === 'high' ? 'high' as const : null,
    hotEligible: guard.level !== 'high' && guard.level !== 'incomplete' &&
      guard.completeness.buyCriticalComplete && guard.completeness.lowerTierComplete &&
      guard.completeness.missing.length === 0 && signal.lowData.length === 0 &&
      signal.guardReceiptId === guard.receipt.id && signal.composite >= 70 };
}
