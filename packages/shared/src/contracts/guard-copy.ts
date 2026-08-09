import type { CheckId } from './guard-ids.js';
import type { GuardAssessmentV2, GuardLevelV2 } from './guard-v2.js';
export const BUYER_RISK = 'Buyer risk at this snapshot. Not a buy recommendation.';
export const GUARD_LABELS: Record<GuardLevelV2, string> = {
  lower: 'Lower observed risk', elevated: 'Elevated risk', high: 'High risk', incomplete: 'Not fully checked',
};
export const GUARD_SHADOW = 'Shadow assessment · does not affect orders';
export const GUARD_CANDIDATE = 'Candidate · shadow assessment · does not affect orders';
export const GUARD_UNAVAILABLE = 'Guard 2 assessment unavailable';
export const GUARD_REFRESH_FAILED = 'Stale · Guard refresh failed · prior snapshot retained';
export const GUARD_PENDING = 'No persisted Guard 2 result yet';
export const GUARD_EMPTY = 'No records · coverage unavailable';
export const GUARD_NO_RECORDS = 'No applicable records · coverage complete';
export const GUARD_DENOMINATORS = { S: 'outstanding supply (S)', C: 'circulating supply (C)', F: 'holder float (F)', quote_cost: 'quote cost', gross_volume: 'gross volume', other: 'other' };
export const guardName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
export function guardGapText(guard: GuardAssessmentV2) {
  return guard.completeness.missing.length ? `Not fully checked: ${guard.completeness.missing.map(id => GUARD_CHECK_LABELS[id]).join(', ')}` : '';
}
export const GUARD_CHECK_LABELS: Record<CheckId, string> = {
  reference_exit: 'Can a buyer sell? (exit simulation)', effective_fees: 'Fees', controls_hooks: 'Controls and hooks',
  supply_float: 'Supply', recent_funding: 'Recent funding', coordination_coverage: 'Wallet coordination',
  launcher_service: 'Launcher or service', operator_history: 'Operator history',
};

export { DYOR, NON_AFFILIATION, BUILT_ON } from '../disclosures.js';
export const GUARD_SHARE_TITLE = 'EKO · Buyer risk snapshot';
export const GUARD_REASON_LABELS = { EXIT_COST: 'Venue round-trip cost', DEPTH: 'Directional depth', ENTRY_LIMIT: 'Entry limit', SELL_RESTRICTION: 'Sell restriction', CONTROL: 'Control capability', GROUP_HELD: 'Group holdings', TOP_HOLDERS: 'Holder concentration', EARLY_BUYERS: 'Early buyers', SAME_BLOCK: 'Same-block buyers', ORIGIN_SALE: 'Launch-origin sale', SELL_PRESSURE: 'Sell pressure', ATTRIBUTED_DUMP: 'Attributed selling', EXEMPTIONS: 'Tax exemptions', CYCLING: 'Repeated cycling', CLONE: 'Identity collision', HISTORY: 'Operator history', TEXT_INSTRUCTION: 'Untrusted instruction', INCOMPLETE: 'Not fully checked', POLICY_DENIAL: 'Policy refusal' } as const;

import { GuardReasonV2Schema, type GuardReasonV2 } from './guard-v2.js';
import { GUARD_REASON_TEMPLATES } from './guard-transport.js';
function formatGuardUsd(value: string | number, fractionDigits: 0 | 2 = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return '—';
  const fraction = match[3] ?? '', scale = 10n ** BigInt(fractionDigits);
  let units = BigInt(match[2]) * scale + BigInt(fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0') || '0');
  const rest = fraction.slice(fractionDigits), tie = rest[0] === '5' && !/[1-9]/.test(rest.slice(1));
  if (rest[0] > '5' || rest[0] === '5' && (!tie || units % 2n === 1n)) units++;
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1] && units ? '-' : ''}$${whole}${fractionDigits ? `.${(units % scale).toString().padStart(fractionDigits, '0')}` : ''}`;
}

/** Display formatting only; preserve shared templates, validation and receipt bytes. */
export function formatGuardReason(input: GuardReasonV2): string {
  const reason = GuardReasonV2Schema.parse(input), parameters = reason.parameters as Record<string, unknown>;
  return GUARD_REASON_TEMPLATES[reason.code].replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = parameters[key];
    if (value === null) return 'unavailable';
    if (['sizeUsd', 'returnedUsd', 'gasUsd', 'buyDepthUsd', 'sellDepthUsd', 'buyUsd', 'volumeUsd'].includes(key)) return formatGuardUsd(value as string | number, key === 'sizeUsd' && /^\d+$/.test(String(value)) ? 0 : 2);
    if (key === 'checkNames') return (value as CheckId[]).map(id => GUARD_CHECK_LABELS[id]).join(', ');
    if (Array.isArray(value)) return value.join(', ');
    if (value && typeof value === 'object') {
      if ('raw' in value && 'asset' in value) return `${value.raw} raw units (${value.asset})`;
      if ('amount' in value && 'asset' in value) return `${value.amount} (${value.asset})`;
      if ('chainId' in value && 'address' in value) return `${value.chainId}:${value.address}`;
      throw new Error('Unsupported trusted parameter');
    }
    return String(value);
  });
}
