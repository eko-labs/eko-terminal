import { z } from 'zod';
import { AddressSchema, ApprovalSchema, BurnEventSchema, ChartMarkerSchema, CoinCardSchema,
  FeedItemSchema, JournalEntrySchema, JournalWriteSchema, PairRowSchema, TradeOrderSchema, VerdictSchema } from '@eko/shared';
import type { JournalService } from '../harness/journal.js';

// CA-27 supplies kinds, but no request envelope. Retain the owning writer's
// input for journal; all other inputs are their shared public contracts.
// TODO(spec): Freeze the CA-27 envelope; use {synthetic:true,data} for now.
export const fixtureSchemas = {
  card: CoinCardSchema.strict(), verdict: VerdictSchema.strict(),
  marker: z.object({ coin: AddressSchema, marker: ChartMarkerSchema.strict() }).strict(),
  pair: PairRowSchema.strict(), feed: FeedItemSchema.strict(),
  journal: z.object({ agentId: z.uuid(), entry: JournalWriteSchema }).strict(),
  approval: ApprovalSchema.strict(), order: TradeOrderSchema.strict(), burn: BurnEventSchema.strict(),
} as const;
export type FixtureKind = keyof typeof fixtureSchemas;
export type FixtureInput<K extends FixtureKind> = z.infer<(typeof fixtureSchemas)[K]>;
export type FixtureOutput<K extends FixtureKind> = K extends 'journal' ? z.infer<typeof JournalEntrySchema> : FixtureInput<K>;
export const fixtureOwners = {
  card: 'engines/normalizer', verdict: 'engines/playbooks', marker: 'engines/watcher', pair: 'indexer',
  feed: 'api', journal: 'mcp', approval: 'api', order: 'api', burn: 'indexer',
} as const;
/** Producers own persistence and any post-commit typed WS publication. The HTTP
 * adapter never writes source tables or publishes a payload before its writer. */
export interface FixtureProducer<K extends FixtureKind> {
  readonly owner: (typeof fixtureOwners)[K];
  readonly storage: 'isolated-dev';
  inject(input: FixtureInput<K>, accountId?: string): Promise<FixtureOutput<K>>;
}
export type FixtureProducers = { [K in FixtureKind]?: FixtureProducer<K> };
export function journalFixtureProducer(journal: JournalService): FixtureProducer<'journal'> {
  return { owner: 'mcp', storage: 'isolated-dev', async inject(input, accountId) {
    if (!accountId) throw new Error('Fixture owner is required');
    return journal.append(accountId, input.agentId, input.entry);
  } };
}

const freeText = new Set(['name', 'symbol', 'text', 'summary', 'reason', 'reasons', 'agentName', 'crewName', 'cloneOf']);
/** Synthetic identities use low numeric addresses, neutral text and example
 * URLs. This checks data before parsing strips unknown fields. Journal payloads
 * deliberately have a small vocabulary rather than accepting arbitrary PII. */
export function neutralFixture(value: unknown, key = ''): boolean {
  if (Array.isArray(value)) return value.every(item => neutralFixture(item, key));
  if (value && typeof value === 'object') {
    if (key === 'payload') {
      const payload = value as Record<string, unknown>;
      if (Object.keys(payload).some(k => !['text','side','decision','qty','notionalUsd','index'].includes(k))) return false;
      if ('text' in payload && (typeof payload.text !== 'string' || !/^(Synthetic|Fixture|Sample)\b/.test(payload.text))) return false;
      if ('side' in payload && !['buy','sell'].includes(payload.side as string)) return false;
      if ('decision' in payload && !['allow','deny','needs_approval'].includes(payload.decision as string)) return false;
      if (['qty','notionalUsd','index'].some(k => k in payload && (typeof payload[k] !== 'number' || !Number.isFinite(payload[k])))) return false;
    }
    return Object.entries(value).every(([k, v]) => neutralFixture(v, k));
  }
  if (typeof value !== 'string') return true;
  if (value.includes('@')) return false;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return /^0x0{32}[0-9a-fA-F]{8}$/.test(value);
  if (/https?:\/\//i.test(value)) {
    try { const url = new URL(value); return url.hostname === 'example.invalid' && !url.username && !url.password; }
    catch { return false; }
  }
  return !freeText.has(key) || /^(Synthetic|Fixture|Sample)\b/.test(value);
}
