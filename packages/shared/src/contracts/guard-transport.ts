import { z } from 'zod';
import { CoinCardSchema, PlaybookMatchSchema, VerdictSchema } from './coin.js';
import { GuardAssessmentV2Schema, GuardLevelV2Schema, GuardReasonV2Schema, CoinCardV2Schema } from './guard-v2.js';
import type { GuardAssessmentV2, GuardLevelV2, GuardReasonV2 } from './guard-v2.js';
import type { Verdict } from './coin.js';
import type { ReasonCode } from './guard-ids.js';

export const GUARD_V1_LEVELS = Object.freeze({ lower: 'clear', elevated: 'monitor', high: 'danger', incomplete: 'pending' } as const);
export function projectGuardLevelToV1(level: GuardLevelV2): Verdict['level'] { return GUARD_V1_LEVELS[GuardLevelV2Schema.parse(level)]; }
// First-party templates, Guard §6. No model or token prose enters these slots.
export const GUARD_REASON_TEMPLATES: Readonly<Record<ReasonCode, string>> = Object.freeze({
  EXIT_COST: 'A {sizeUsd} buy-then-sell returned {returnedUsd} at {snapshotId}: {costPct}% venue round-trip cost; gas {gasUsd}. Fee breakdown: {breakdownStatus}.',
  DEPTH: 'Buy/sell 2% marginal-price depth is {buyDepthUsd}/{sellDepthUsd} on {routeId}; fees and gas are additional.',
  ENTRY_LIMIT: 'Entry at {sizeUsd} is limited for {accountClass}; {limitCode}.',
  SELL_RESTRICTION: 'A valid purchased position could not be sold by {accountClass} at {sizeUsd} on the tested valid routes.',
  CONTROL: '{authorityRole} can {capability} under implementation {codeHash}; {boundCode}, earliest execution {executionTime}.',
  GROUP_HELD: '{groupType} holds {liquidUnits}: {supplyPct}% of outstanding supply and {floatPct}% of holder float; {linkClass}.',
  TOP_HOLDERS: 'The largest {holderCount} external addresses hold {rawPct}% of holder float; verified control grouping gives {groupPct}%.',
  EARLY_BUYERS: 'First-trade-window buyers acquired {grossBoughtPct}% of outstanding supply and currently hold {heldPct}% of holder float.',
  SAME_BLOCK: '{recipientCount} recipients bought in the same launchpad-pool block before graduation: {buyUsd} total and {boughtPct}% of supply. Shared control is {controlStatus}.',
  ORIGIN_SALE: 'Launch-origin tokens were sold by {sellerAddress}; seller control is {controlStatus}; {soldUnits} attributed units, {basisCoveragePct}% basis coverage.',
  SELL_PRESSURE: '{sellerClass} sold {soldPct}% of opening float over {windowSec} seconds; measured sell pressure {pressurePct}%; attribution {attributionStatus}.',
  ATTRIBUTED_DUMP: 'Operator-controlled wallets sold {soldPct}% of {denominatorName} for {netQuote}; covered buyers lost {lossPct}%. The {interventionType} replay improved return by {contributionPp} percentage points.',
  EXEMPTIONS: '{count} launch wallets are exempt from temporary buy anti-snipe tax; {affiliatedCount} have independent affiliation evidence.',
  CYCLING: 'Estimated repeated cycling is {sharePct}% of {volumeUsd} covered gross volume in 3,600 seconds; {classificationStatus}.',
  CLONE: 'Same normalized name/ticker as {tokenId}; this establishes neither authenticity nor shared control.',
  HISTORY: '{badCount} of {matureCount} completely assessed launches in the covered {historyWindowSec}-second window had operator-attributed harm; current {exposureType} receives {historyPoints} points.',
  TEXT_INSTRUCTION: 'Untrusted token text contains an agent-targeted {actionEnum} instruction; it cannot change trusted policy.',
  INCOMPLETE: 'Not fully checked: {checkNames}. {coverageCode}; retry condition {retryCode}.',
  POLICY_DENIAL: '{denialCode}: {trustedPolicyExplanation}; measured at the requested account, route and size.',
});
function slot(value: unknown): string {
  if (value === null) return 'unavailable';
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') {
    if ('raw' in value && 'asset' in value) return `${value.raw} raw units (${value.asset})`;
    if ('amount' in value && 'asset' in value) return `${value.amount} (${value.asset})`;
    if ('chainId' in value && 'address' in value) return `${value.chainId}:${value.address}`;
    throw new Error('Unsupported trusted parameter');
  }
  return String(value);
}
export function projectGuardReasonToV1(input: GuardReasonV2): string {
  const reason = GuardReasonV2Schema.parse(input);
  const params = reason.parameters as Record<string, unknown>;
  return GUARD_REASON_TEMPLATES[reason.code].replace(/\{(\w+)\}/g, (_, key: string) => slot(params[key]));
}
export const GuardExtendedVerdictSchema = VerdictSchema.extend({ schemaVersion: z.literal('verdict-1+guard-2'), guardV2: GuardAssessmentV2Schema }).superRefine((v, ctx) => {
  if (v.coin !== v.guardV2.coin || v.level !== projectGuardLevelToV1(v.guardV2.level)) ctx.addIssue({ code: 'custom', message: 'V1 projection disagrees with V2 assessment' });
});
/** Caller supplies genuine legacy evaluations and the existing V1 receipt shape. */
export function projectGuardAssessmentToV1(input: GuardAssessmentV2, legacy: Pick<Verdict, 'receipt' | 'asOfBlock' | 'evaluatedPlaybooks' | 'beta'> & { playbooks: z.infer<typeof PlaybookMatchSchema>[] }): Verdict {
  const guardV2 = GuardAssessmentV2Schema.parse(input);
  return GuardExtendedVerdictSchema.parse({ ...legacy, coin: guardV2.coin, level: projectGuardLevelToV1(guardV2.level), reasons: guardV2.reasons.map(projectGuardReasonToV1), schemaVersion: 'verdict-1+guard-2', guardV2 });
}
// Schema negotiation for REST/MCP/WS adapters; no live endpoints/cutover in 026.
export const NegotiatedGuardVerdictSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), verdict: VerdictSchema }),
  z.strictObject({ version: z.literal(2), verdict: GuardAssessmentV2Schema.nullable() }),
]);
export const NegotiatedCoinCardSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), card: CoinCardSchema }),
  z.strictObject({ version: z.literal(2), card: CoinCardV2Schema.nullable() }),
]);
