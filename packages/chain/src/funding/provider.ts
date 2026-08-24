import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, compareGuardCursors } from '@eko/shared';
import { CHAIN_ID } from '@eko/shared';

export const FUNDING_METHOD_VERSION = '2.0.0';
const address = AddressSchema.transform(a => a.toLowerCase());
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
export const FundingStreamSchema = z.enum(['native_external', 'native_internal', 'quote']);
export type FundingStream = z.infer<typeof FundingStreamSchema>;
// TODO(spec): Guard §§8.1–8.2 define acquisition semantics, not a vendor wire envelope.
// Adapters normalize into these pinned, resumable records; no endpoint is assumed usable.
export const FundingRangeSchema = z.strictObject({
  address, from: GuardCursorSchema, through: GuardCursorSchema, quoteAssets: z.array(address),
  origin: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('bounded') }),
    z.strictObject({ kind: z.literal('genesis') }),
    z.strictObject({ kind: z.literal('proved_creation'), evidenceHash: Bytes32Schema, noEarlierFunding: z.literal(true) })]),
}).superRefine((v, ctx) => {
  if (v.from.chainId !== CHAIN_ID || v.through.chainId !== CHAIN_ID || v.from.boundary !== 'block_end' || v.through.boundary !== 'block_end' ||
    compareGuardCursors(v.from, v.through) > 0 || BigInt(v.from.timestampSec) > BigInt(v.through.timestampSec)) ctx.addIssue({ code: 'custom', message: 'Invalid funding interval' });
  if (v.origin.kind === 'genesis' && v.from.blockNumber !== '0') ctx.addIssue({ code: 'custom', message: 'Genesis coverage must start at zero' });
  if (new Set(v.quoteAssets).size !== v.quoteAssets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate quote assets' });
});
export type FundingRange = z.infer<typeof FundingRangeSchema>;
export const FundingFlowSchema = z.strictObject({
  transactionHash: Bytes32Schema, position: z.string().regex(/^(?:call:0(?:\.\d+)*|log:\d+)$/),
  cursor: GuardCursorSchema, stream: FundingStreamSchema, asset: address.nullable(), from: address, to: address,
  raw: uint.refine(v => v !== '0', 'Positive funding value required'),
  transactionSuccessful: z.boolean(), ancestorsSuccessful: z.boolean(),
  settlement: z.enum(['external', 'same_account_wrap', 'unresolved']),
}).superRefine((v, ctx) => {
  if ((v.stream === 'quote') !== (v.asset !== null) || (v.stream === 'quote') !== v.position.startsWith('log:') ||
    v.cursor.boundary !== 'after_tx' || v.stream === 'native_external' && v.position !== 'call:0' ||
    v.stream === 'native_internal' && v.position === 'call:0') ctx.addIssue({ code: 'custom', message: 'Funding position/asset mismatch' });
});
export type FundingFlow = z.infer<typeof FundingFlowSchema>;
export const fundingFlowId = (f: FundingFlow) => `${f.cursor.chainId}:${f.cursor.blockHash.toLowerCase()}:${f.transactionHash.toLowerCase()}:${f.position}`;
export const successfulFunding = (f: FundingFlow) => f.transactionSuccessful && f.ancestorsSuccessful && f.settlement === 'external' && f.from !== f.to && !/^0x0{40}$/.test(f.from);
export const FundingPageSchema = z.strictObject({
  sourceRevision: z.string().min(1), range: FundingRangeSchema, stream: FundingStreamSchema, asset: address.nullable(),
  sequence: z.number().int().nonnegative(), requestCursor: z.string().nullable(), nextCursor: z.string().min(1).nullable(),
  intervalComplete: z.boolean(), payloadHash: Bytes32Schema, flows: z.array(FundingFlowSchema).max(10000),
});
export type FundingPage = z.infer<typeof FundingPageSchema>;
export interface FundingPageRequest { range: FundingRange; stream: FundingStream; asset: string | null; sequence: number; cursor: string | null }
export interface FundingProvider {
  sourceId: string; sourceRevision: string;
  /** An indexed API page is priced independently of RPC. This callback must use its own admitted transport. */
  page(request: FundingPageRequest): Promise<unknown>;
}
export interface FundingCapability {
  sourceId: string; sourceRevision: string; validation: 'fixture' | 'measured';
  streams: FundingStream[]; verifiedStreams: FundingStream[]; verifiedQuoteAssets: string[]; usable: boolean; gaps: string[]; evidenceHashes: string[];
}
export interface FundingProbe {
  name: 'funding_only' | 'internal' | 'failed' | 'reverted_parent' | 'quote' | 'wrap' | 'pagination' | 'interval_boundaries';
  expected: FundingFlow[]; observed: FundingFlow[]; passed: boolean; evidenceHash: string;
}
/** The caller supplies acquired, independently known controls, never provider declarations alone. */
export function testFundingCapability(provider: Pick<FundingProvider, 'sourceId' | 'sourceRevision'>,
  streams: FundingStream[], validation: FundingCapability['validation'], probes: FundingProbe[]): FundingCapability {
  const required: FundingProbe['name'][] = ['funding_only', 'internal', 'failed', 'reverted_parent', 'quote', 'wrap', 'pagination', 'interval_boundaries'];
  const gaps: string[] = [];
  for (const name of required) {
    const p = probes.filter(p => p.name === name);
    if (p.length !== 1 || !p[0].passed) { gaps.push(name); continue; }
    const normalized = (flows: FundingFlow[]) => flows.map(f => FundingFlowSchema.parse(f)).filter(successfulFunding)
      .sort((a, b) => compareGuardCursors(a.cursor, b.cursor) || fundingFlowId(a).localeCompare(fundingFlowId(b)));
    if (JSON.stringify(normalized(p[0].expected)) !== JSON.stringify(normalized(p[0].observed)) ||
      ['funding_only', 'internal', 'quote'].includes(name) && normalized(p[0].expected).length === 0) gaps.push(name);
    Bytes32Schema.parse(p[0].evidenceHash);
  }
  for (const stream of FundingStreamSchema.options) if (!streams.includes(stream)) gaps.push(stream);
  const requirements: Record<FundingStream, FundingProbe['name'][]> = {
    native_external: ['funding_only', 'failed', 'pagination', 'interval_boundaries'],
    native_internal: ['internal', 'reverted_parent', 'pagination', 'interval_boundaries'],
    quote: ['quote', 'wrap', 'failed', 'pagination', 'interval_boundaries'],
  };
  const verifiedStreams = validation === 'measured' ? streams.filter(s => requirements[s].every(name => !gaps.includes(name))) : [];
  return { sourceId: provider.sourceId, sourceRevision: provider.sourceRevision, streams: [...streams], verifiedStreams, validation,
    verifiedQuoteAssets: verifiedStreams.includes('quote') ? [...new Set(probes.filter(p => p.name === 'quote').flatMap(p => p.expected.map(f => f.asset).filter((a): a is string => a !== null)))].sort() : [],
    usable: verifiedStreams.includes('native_external') && verifiedStreams.includes('native_internal'),
    gaps: validation === 'fixture' ? [...gaps, 'provider_unverified'] : gaps, evidenceHashes: probes.map(p => p.evidenceHash) };
}
export const unavailableFundingCapability = (sourceId: string, sourceRevision: string): FundingCapability => ({
  sourceId, sourceRevision, validation: 'fixture', streams: [], verifiedStreams: [], verifiedQuoteAssets: [], usable: false,
  gaps: ['indexed_native_unavailable', 'indexed_quote_unverified'], evidenceHashes: [],
});
