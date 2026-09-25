import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, RationalSchema, guardKnownBy, compareGuardCursors } from '@eko/shared';
import { referenceDigest } from '@eko/chain';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = uint.refine(x => x !== '0');
const nonnegative = RationalSchema.refine(x => BigInt(x.numerator) >= 0n);
const price = RationalSchema.refine(x => BigInt(x.numerator) > 0n);
export const BenchmarkGasSchema = z.strictObject({ executionQuote: nonnegative, l1Quote: nonnegative, usd: nonnegative.nullable() });
export const BenchmarkPredictorSchema = z.strictObject({ verdictId: Bytes32Schema, version: z.string().min(1),
  kind: z.enum(['released', 'candidate']), level: z.enum(['low', 'medium', 'high', 'incomplete']),
  sizeUsd: z.union([z.literal(100), z.literal(1000)]), accountClass: z.enum(['eoa', 'contract']),
  cursor: GuardCursorSchema, sourceCut: AvailabilityCutSchema, evidenceKnownAt: AvailabilityCutSchema, sourceRevision: Bytes32Schema });
export const BenchmarkFrameSchema = z.strictObject({ cursor: GuardCursorSchema, parentHash: Bytes32Schema,
  knownAt: AvailabilityCutSchema, quoteUsd: price.nullable(), priceEvidenceIds: z.array(Bytes32Schema),
  relevant: z.array(z.enum(['sell', 'control', 'graduation'])),
  status: z.enum(['available', 'data_gap', 'provider_gap', 'unsupported']), state: z.json(),
  evidenceIds: z.array(Bytes32Schema).min(1), predictors: z.array(BenchmarkPredictorSchema) });
// TODO(spec): §9.1 has no benchmark wire/store contract. This engines-only envelope
// freezes a complete completed-block clock and normalized local adapter inputs; no public API or label writes.
export const BuyerBenchmarkManifestSchema = z.strictObject({ version: z.literal('buyer-benchmark-054.1'),
  origin: z.enum(['fixture', 'measured']), sourceRevision: Bytes32Schema, availabilityCut: AvailabilityCutSchema,
  coin: AddressSchema, quoteAsset: AddressSchema, quoteDecimals: z.number().int().min(0).max(255), launch: GuardCursorSchema,
  adapterVersion: z.string().min(1), venue: z.string().min(1), routeId: z.string().min(1), configHash: Bytes32Schema,
  accounts: z.array(z.strictObject({ account: AddressSchema, accountClass: z.enum(['eoa', 'contract']) })).min(1).max(2),
  retrySensitivity: z.boolean(), nextBlockStress: z.boolean(), frames: z.array(BenchmarkFrameSchema).min(1),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (m.sourceRevision !== referenceDigest(m.frames)) fail('Source tape digest mismatch');
  if (m.coin === m.quoteAsset || new Set(m.accounts.map(a => a.accountClass)).size !== m.accounts.length ||
      new Set(m.accounts.map(a => a.account.toLowerCase())).size !== m.accounts.length) fail('Asset/account identity mismatch');
  let previous = m.launch;
  for (const frame of m.frames) {
    const c = frame.cursor;
    if (c.boundary !== 'block_end' || c.chainId !== m.launch.chainId ||
        BigInt(c.blockNumber) !== BigInt(previous.blockNumber) + 1n || frame.parentHash !== previous.blockHash ||
        BigInt(c.timestampSec) < BigInt(previous.timestampSec) || !guardKnownBy({ cursor: c, acquisitionSequence: '0' }, frame.knownAt) ||
        !guardKnownBy(frame.knownAt, m.availabilityCut)) fail('Incomplete or future completed-block clock');
    if (frame.quoteUsd && !frame.priceEvidenceIds.length) fail('Unpinned USD price');
    const keys = new Set<string>();
    for (const p of frame.predictors) {
      const key = `${p.sizeUsd}:${p.accountClass}`;
      if (keys.has(key)) fail('Duplicate entry predictor'); keys.add(key);
      if (referenceDigest(p.cursor) !== referenceDigest(c) || referenceDigest(p.sourceCut.cursor) !== referenceDigest(c) ||
          !guardKnownBy(p.evidenceKnownAt, p.sourceCut) || !guardKnownBy(p.sourceCut, m.availabilityCut) ||
          compareGuardCursors(p.evidenceKnownAt.cursor, c) > 0) fail('Predictor does not match entry cut');
    }
    previous = c;
  }
});
export type BuyerBenchmarkManifest = z.infer<typeof BuyerBenchmarkManifestSchema>;
export type BenchmarkFrame = z.infer<typeof BenchmarkFrameSchema>;
export type BenchmarkGas = z.infer<typeof BenchmarkGasSchema>;
export const BenchmarkEntrySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('purchased'), quantity: positive, spentQuote: positive, gas: BenchmarkGasSchema,
    purchaseState: z.json(), persistentState: z.json(), evidenceIds: z.array(Bytes32Schema).min(1) }),
  z.strictObject({ status: z.enum(['entry_unavailable', 'censored', 'unsupported']),
    reason: z.enum(['entry_cap', 'entry_failed', 'data_gap', 'provider_gap', 'unsupported', 'usd_missing']), evidenceIds: z.array(Bytes32Schema) }),
]);
export type BenchmarkEntry = z.infer<typeof BenchmarkEntrySchema>;
export const BenchmarkExitSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('executed'), grossQuote: uint, gas: BenchmarkGasSchema, evidenceIds: z.array(Bytes32Schema).min(1) }),
  z.strictObject({ status: z.literal('token_failure'), verifiedNoExit: z.boolean(), validScheduledState: z.boolean(),
    grossQuote: z.literal('0').nullable(), gas: BenchmarkGasSchema, evidenceIds: z.array(Bytes32Schema).min(1) }),
  z.strictObject({ status: z.enum(['censored', 'unsupported', 'indeterminate']), reason: z.string().regex(/^[a-z0-9_]+$/),
    failedTransaction: Bytes32Schema.nullable(), evidenceIds: z.array(Bytes32Schema) }),
]).superRefine((x, ctx) => {
  if (x.status === 'token_failure' && (x.grossQuote === '0') !== (x.verifiedNoExit && x.validScheduledState))
    ctx.addIssue({ code: 'custom', message: 'Zero no-exit proceeds require proof at a valid state' });
});
export type BenchmarkExit = z.infer<typeof BenchmarkExitSchema>;
