import { z } from 'zod';
import { AddressSchema, UntrustedSchema } from './common.js';
import { VerdictSchema } from './coin.js';
import { GuardAssessmentV2Schema, type GuardAssessmentV2, type GuardReasonV2 } from './guard-v2.js';
import { GUARD_FACTOR_IDS, GUARD_REASON_CODES } from './guard-ids.js';
import { BUYER_RISK, DYOR, BUILT_ON, NON_AFFILIATION, GUARD_LABELS, GUARD_SHADOW, GUARD_CANDIDATE, GUARD_PENDING, GUARD_SHARE_TITLE, guardGapText, formatGuardReason } from './guard-copy.js';

export const GuardFactorIdSchema = z.enum(GUARD_FACTOR_IDS);
export const GuardReasonCodeSchema = z.enum(GUARD_REASON_CODES);
export const GuardSignalFieldsSchema = z.strictObject({ guardFactorId: GuardFactorIdSchema.optional(), guardReasonCode: GuardReasonCodeSchema.optional() });
export const GuardConsumerRequestSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), verdict: VerdictSchema, rulesVersion: z.string().regex(/^1\.0\.\d+$/) }),
  z.strictObject({ version: z.literal(2), assessment: GuardAssessmentV2Schema.nullable() }),
]);
export type GuardConsumerRequest = z.infer<typeof GuardConsumerRequestSchema>;
export const GUARD_CONSUMER_SURFACES = ['radar', 'pair', 'alert', 'bags', 'scan', 'widget', 'og', 'bot', 'research', 'pack'] as const;

/** Keep evaluator ordering (decisive, points, family, ID); sort same-factor size ties only. */
export function guardConsumerReasons(guard: GuardAssessmentV2): GuardReasonV2[] {
  return [...guard.reasons].sort((a, b) => a.factorId === b.factorId && a.code === b.code && 'sizeUsd' in a.parameters && 'sizeUsd' in b.parameters
    ? Number(a.parameters.sizeUsd) - Number(b.parameters.sizeUsd) : 0);
}
/** Shared inert-text boundary for DOM text and escaped OG text; never use as markup or a URL. */
export function guardInertText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF0-\uFFFF]/g, '');
}
export function compactGuardVerdict(input: GuardConsumerRequest) {
  const request = GuardConsumerRequestSchema.parse(input);
  const disclosures = [BUYER_RISK, DYOR, BUILT_ON, NON_AFFILIATION];
  if (request.version === 1) return { version: 1 as const, label: `Rule set ${request.rulesVersion}`, level: request.verdict.level,
    mode: null, gap: '', snapshot: `Snapshot block ${request.verdict.asOfBlock}`, lines: request.verdict.reasons.slice(0, 3).map(guardInertText),
    allReasons: request.verdict.reasons.map(guardInertText), evidencePath: `/coin/${request.verdict.coin}`, receiptId: request.verdict.receipt.id, disclosures };
  const guard = request.assessment;
  const reasons = guard ? guardConsumerReasons(guard).map(formatGuardReason) : [];
  return { version: 2 as const, label: guard ? GUARD_LABELS[guard.level] : GUARD_PENDING, level: guard?.level ?? null,
    mode: guard ? guard.mode === 'active' ? 'Active assessment' : guard.mode === 'shadow' ? GUARD_SHADOW : GUARD_CANDIDATE : null,
    gap: guard ? guardGapText(guard) : 'Coverage unavailable',
    snapshot: guard ? `Snapshot block ${guard.cursor.blockNumber} · timestamp ${guard.cursor.timestampSec} · $100 / $1,000 · EOA / smart account · rules ${guard.rulesVersion}` : 'Snapshot unavailable',
    lines: reasons.slice(0, 3), allReasons: reasons,
    evidencePath: guard ? `/coin/${guard.coin}${guard.mode === 'active' ? '#coin-evidence' : '#guard-shadow-evidence'}` : null,
    receiptId: guard?.receipt.id ?? null, disclosures };
}
/** Prepared plain-text bot/pack copy. No transport, acquisition or publication. */
export function guardNotification(input: GuardConsumerRequest): string {
  const view = compactGuardVerdict(input);
  return [GUARD_SHARE_TITLE, view.label, view.mode, view.gap, view.snapshot, ...view.lines, view.evidencePath ? `All reasons, checks and evidence: ${view.evidencePath}` : null, ...view.disclosures].filter(Boolean).join('\n');
}
/** Names never enter share intents or meta titles. */
export function guardShareMetadata(input: GuardConsumerRequest) {
  const view = compactGuardVerdict(input);
  return { title: GUARD_SHARE_TITLE, shareText: GUARD_SHARE_TITLE, description: [view.label, view.mode, view.gap, ...view.disclosures].filter(Boolean).join(' · ') };
}
const xml = (value: string) => guardInertText(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
/** Return an escaped, self-contained OG preview; source text only occupies inert text nodes. */
export function guardOgSvg(input: GuardConsumerRequest, symbol?: z.infer<typeof UntrustedSchema>): string {
  const view = compactGuardVerdict(input);
  const source = symbol ? guardInertText(UntrustedSchema.parse(symbol).text).slice(0, 32) : '';
  const lines = [GUARD_SHARE_TITLE, source, view.label, view.mode, view.gap, view.snapshot, ...view.lines, ...view.disclosures].filter((v): v is string => Boolean(v));
  // Wrap long trusted reasons and disclaimers without truncating required copy.
  const wrapped = lines.flatMap(line => line.match(/.{1,100}(?:\s|$)|.{1,100}/g)?.map(s => s.trim()) ?? []);
  const height = Math.max(630, 70 + wrapped.length * 32);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="1200" height="${height}" fill="#09121b"/><g fill="#d4f4fa" font-family="sans-serif" font-size="18">${wrapped.map((line, i) => `<text x="40" y="${50 + i * 32}">${xml(line)}</text>`).join('')}</g></svg>`;
}

/** V2 preparation for contract-only surfaces; historical V1 payloads stay intact. */
export const GuardSurfaceRequestSchema = z.strictObject({ surface: z.enum(GUARD_CONSUMER_SURFACES), verdict: GuardConsumerRequestSchema, coin: AddressSchema });
export function prepareGuardSurface(input: z.infer<typeof GuardSurfaceRequestSchema>) {
  const request = GuardSurfaceRequestSchema.parse(input);
  const coin = request.verdict.version === 1 ? request.verdict.verdict.coin : request.verdict.assessment?.coin;
  if (coin && coin !== request.coin) throw new Error('Consumer assessment coin mismatch');
  return { surface: request.surface, coin: request.coin, ...compactGuardVerdict(request.verdict), metadata: guardShareMetadata(request.verdict) };
}
