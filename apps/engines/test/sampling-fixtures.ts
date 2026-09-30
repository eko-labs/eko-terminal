import { referenceDigest } from '@eko/chain';
import { address, hash, cursor } from '../../../packages/chain/test/reference-fixtures.js';
import { SAMPLE_STRATA, SAMPLE_VERSION, type ProbabilityFrame } from '../src/probability-sample.js';
import { PARITY_QUESTIONS, type MatchedSourceRecord, type IncidentChallengeInput } from '../src/matched-source.js';

export function probabilityFrame(sizes = [200, 150, 150, 200, 1000]): ProbabilityFrame {
  const query = { enumeration: 'synthetic_complete_launches', halfOpenSec: ['1000', '2000'],
    eligibility: 'synthetic_pinned_flags', priority: [...SAMPLE_STRATA] };
  let n = 10;
  return { version: SAMPLE_VERSION, origin: 'fixture', sourceRevision: hash('synthetic-population'), enumerationComplete: true,
    availabilityCut: { cursor: { ...cursor, blockNumber: '300', timestampSec: '2000' }, acquisitionSequence: '100' },
    fromSec: '1000', untilSec: '2000', chainId: 4663, seed: hash('sampling-057-reproducible-seed'),
    query: { version: '1.0.0', artifact: query, artifactHash: referenceDigest(query) },
    members: sizes.flatMap((size, stratum) => Array.from({ length: size }, () => ({ coin: address(n++), launchSec: '1000',
      knownAt: { cursor, acquisitionSequence: '0' }, eligibility: { operator_sale: stratum === 0, restriction: stratum === 1,
        non_operator: stratum === 2, legacy: stratum === 3, evidenceIds: stratum < 4 ? [hash(`synthetic-eligibility-${stratum}`)] : [] } }))) };
}

export function matchedRecords(count = 100): MatchedSourceRecord[] {
  return Array.from({ length: count }, (_, n) => {
    const context: MatchedSourceRecord['context'] = { coin: address(10 + n), cursor, routeId: 'synthetic-pons', sizeUsd: 100,
      account: address(5000), accountClass: 'eoa', stage: 'curve', horizonSec: 3600, historical: true };
    const snapshots: MatchedSourceRecord['snapshots'] = (['eko', 'raw_receipts', 'codex'] as const).map(source => ({
      source, endpoint: 'synthetic-captured-endpoint', methodVersion: '1.0.0', payloadHash: hash(`synthetic-payload-${source}-${n}`),
      contextHash: referenceDigest(context), observedCursor: cursor, acquiredAt: { cursor, acquisitionSequence: '1' }, capturedAtUnixMs: '1001000',
      capability: { status: 'verified', chainId: 4663, historical: true, fromSec: '900', untilSec: '1100', reason: 'none', evidenceIds: [hash('synthetic-capability')] },
      status: 'available', quoteUsd: { numerator: '1', denominator: '1' }, priceEvidenceIds: [hash('synthetic-price')], responseTimeMs: 10,
      answers: PARITY_QUESTIONS.map(question => ({ question, status: 'answered', reason: 'none', value: '10', unit: 'raw',
        basis: 'current_held', roles: 'verified', denominator: { convention: 'total', raw: '1000' },
        coveredRaw: '1000', excludedRaw: '0', evidenceIds: [hash(`synthetic-answer-${question}`)] })),
    }));
    return { origin: 'fixture', sourceRevision: hash(`synthetic-capture-tape-${n}`), context, snapshots };
  });
}

export function unavailableIncident(): IncidentChallengeInput {
  return { version: 'incident-challenge-057.1', origin: 'fixture', sourceRevision: hash('synthetic-incident-input'),
    allegation: { reportedLaunches: 53, reportedExtractedUsd: '18430000', categoryCounts: [45, 4, 4],
      evidenceIds: [hash('synthetic-allegation-reference')], status: 'unreconciled_allegation' },
    availability: 'manifest_unavailable', members: [] };
}

export function syntheticIncidentMember(n: number): IncidentChallengeInput['members'][number] {
  const coin = address(n), transaction = hash(`synthetic-launch-${n}`);
  const launch = { ...cursor, boundary: 'after_tx' as const, transactionIndex: 0, executionOrdinal: 0 };
  return { coin, launch, launchTransaction: transaction, verification: { coin, transaction, cursor: launch,
    receiptHash: hash(`synthetic-receipt-${n}`), evidenceIds: [hash(`synthetic-receipt-evidence-${n}`)] },
    archiveComplete: true, categories: ['collector_next_funder'] };
}

export function samplingFixture() {
  return { version: 'sampling-fixture-057.1' as const, frame: probabilityFrame(), matches: matchedRecords(), incident: unavailableIncident() };
}
