import { referenceDigest, type CampaignState } from '@eko/chain';
import { address, hash } from '../../../packages/chain/test/reference-fixtures.js';
import { block, emptyFees } from '../../../packages/chain/test/campaign-fixtures.js';
import { type BuyerBenchmarkManifest } from '../src/buyer-benchmark-input.js';
import { PonsBenchmarkSnapshotSchema, zeroBenchmarkGas } from '../src/buyer-benchmark-pons.js';
import { benchmarkRational, initialBenchmarkCheckpoint, runBuyerBenchmark, type BenchmarkAdapter, type BenchmarkIO } from '../src/buyer-benchmark.js';
import { ponsBenchmarkFixtureAdapter } from '../src/buyer-benchmark-pons.js';

export const candidate = hash('benchmark-candidate-fixture');
export const snapshot = (m: BuyerBenchmarkManifest, time: number) => PonsBenchmarkSnapshotSchema.parse(m.frames.find(f => Number(f.cursor.timestampSec) === time)!.state);
export function changeSnapshot(m: BuyerBenchmarkManifest, change: (s: ReturnType<typeof snapshot>, time: number) => void) {
  for (const f of m.frames) { const s = PonsBenchmarkSnapshotSchema.parse(f.state); change(s, Number(f.cursor.timestampSec)); f.state = s; }
  return seal(m);
}
export const seal = (m: BuyerBenchmarkManifest) => { m.sourceRevision = referenceDigest(m.frames); return m; };
export function buyerFixture(): BuyerBenchmarkManifest {
  const launch = block(1, 1000), configHash = hash('benchmark-fixture-config');
  const times = [1005, 1030, ...Array.from({ length: 70 }, (_, k) => 1060 + k * 60), 87500, 87530, 87560, 87800];
  const campaign: CampaignState = { curve: { tokens: '1000000000', realQuote: '1000000', virtualQuote: '100000', reservedTokens: '100' },
    fees: emptyFees(), wallets: [], lots: [] };
  const frames = times.map((time, k) => {
    const cursor = block(k + 2, time), knownAt = { cursor, acquisitionSequence: '0' };
    return { cursor, parentHash: k ? block(k + 1, times[k - 1]).blockHash : launch.blockHash, knownAt,
      quoteUsd: benchmarkRational(1n), priceEvidenceIds: [hash('quote-usd-fixture')], relevant: [], status: 'available' as const,
      state: { campaign: structuredClone(campaign), transactions: [], gas: zeroBenchmarkGas(), supportedClasses: ['eoa', 'contract'],
        capQuote: null, cooldownSec: '0', blockedClasses: [], verifiedFailure: true, profileHash: configHash },
      evidenceIds: [hash(`benchmark-state-${k}`)], predictors: ([100, 1000] as const).flatMap(sizeUsd => (['eoa', 'contract'] as const).map(accountClass =>
        ({ verdictId: hash(`entry-verdict-${k}-${sizeUsd}-${accountClass}`), version: '2.0.0', kind: 'candidate' as const, level: 'low' as const,
          sizeUsd, accountClass, cursor, sourceCut: { cursor, acquisitionSequence: '1' }, evidenceKnownAt: knownAt, sourceRevision: hash('predictor-input-source') }))) };
  });
  return seal({ version: 'buyer-benchmark-054.1', origin: 'fixture', sourceRevision: hash('pending'),
    availabilityCut: { cursor: frames.at(-1)!.cursor, acquisitionSequence: '9' }, coin: address(10), quoteAsset: address(11), quoteDecimals: 0,
    launch, adapterVersion: ponsBenchmarkFixtureAdapter.version, venue: 'pons_curve', routeId: 'fixture-curve', configHash,
    accounts: [{ account: address(30), accountClass: 'eoa' }], retrySensitivity: true, nextBlockStress: false, frames });
}
export function memoryIO(m: BuyerBenchmarkManifest) {
  const artifacts = new Map<string, unknown>(); let stopped = false, source = m.sourceRevision, writes = 0;
  const io: BenchmarkIO = { artifact: async k => artifacts.get(k) ?? null, putArtifact: async (k, v) => { writes++; artifacts.set(k, structuredClone(v)); },
    save: async () => {}, sourceRevision: async () => source, stopped: () => stopped };
  return { artifacts, io, stop: (value = true) => { stopped = value; }, reorg: () => { source = hash('benchmark-reorg'); }, writes: () => writes };
}
export async function runFixture(m = buyerFixture(), adapter: BenchmarkAdapter = ponsBenchmarkFixtureAdapter) {
  const memory = memoryIO(m), checkpoint = initialBenchmarkCheckpoint(m, candidate);
  const result = await runBuyerBenchmark(m, checkpoint, memory.io, adapter, candidate);
  return { m, memory, checkpoint, result };
}
