import { referenceDigest } from '@eko/chain';
import { AcquisitionDefinitionSchema, type AcquisitionDefinition } from '../src/acquisition-run.js';
import { probabilityFrame } from './sampling-fixtures.js';

export const ACQUISITION_DAY = 86400;
export const ACQUISITION_D = 1790812800;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** Synthetic complete calendar source only, not captured chain validation. */
export function acquisitionFixture(): AcquisitionDefinition {
  const D = ACQUISITION_D, day = ACQUISITION_DAY;
  const frame = probabilityFrame([0, 0, 0, 0, 12]);
  frame.fromSec = String(D); frame.untilSec = String(D + 14 * day);
  frame.availabilityCut.cursor.timestampSec = String(D + 21 * day);
  const offsets = [0, day, 4 * day - 3901, 4 * day - 3900, 4 * day - 1,
    4 * day, 5 * day, 7 * day - 3901, 7 * day - 3900, 7 * day, 8 * day, 14 * day - 1];
  frame.members.forEach((m, i) => {
    m.launchSec = String(D + offsets[i]);
    m.knownAt = { ...m.knownAt, cursor: { ...m.knownAt.cursor, timestampSec: m.launchSec } };
  });
  const query = { enumeration: 'synthetic_all_launch_metadata', fromSec: frame.fromSec, untilSec: frame.untilSec,
    verdictFilter: false, eligibility: 'synthetic_pinned_flags' };
  frame.query = { version: '1.0.0', artifact: query, artifactHash: referenceDigest(query) };
  const availability = { id: hash(901), sourceId: 'sample-launch-source', sourceRevision: frame.sourceRevision,
    replayMode: 'retrospective', cut: frame.availabilityCut, watermark: frame.availabilityCut.cursor,
    acquiredAt: '2026-10-23T00:00:00Z' };
  return AcquisitionDefinitionSchema.parse({ version: 'acquisition-definition-058.1', origin: 'fixture',
    chainId: 4663, startSec: String(D), labelsInspected: false, historyMetadata: true,
    sampling: { version: frame.version, seed: frame.seed, query: frame.query },
    sources: [{ id: 'sample-launch-source', role: 'launches', status: 'verified', availability },
      ...(['funding', 'recycling', 'history', 'comparator'] as const).map(role => ({
        id: `sample-${role}-source`, role, status: 'unavailable', availability: null }))],
    population: { frame, groups: frame.members.map((m, i) => ({ coin: m.coin,
      components: [{ id: hash(2000 + i), status: 'accepted', evidenceIds: [hash(3000 + i)] }], unresolved: false })) },
    budget: { approvalRef: null, pricingEvidence: null, capNanoUsd: '10000000000', unitNanoUsd: '6000',
      fixedNanoUsd: '0', checkpointUnits: 250000, weights: { header: 1, logs: 2, boundary: 3 } },
    pilotAcceptanceEvidence: null, backfill: null });
}

export function acquisitionPilotFixture() {
  const m = acquisitionFixture(), member = m.population!.frame.members[0];
  const creation = { ...member.knownAt.cursor, blockNumber: '40', boundary: 'block_end' as const };
  m.backfill = { version: 'selective-backfill-048.1', validation: 'fixture',
    sourceRevision: m.population!.frame.sourceRevision, availability: m.sources[0].availability!,
    startSec: m.startSec, mode: 'pilot7', historyMetadata: m.historyMetadata,
    metadataFilters: [{ addresses: [member.coin], topics: [hash(800)] }],
    selected: [{ launch: { coin: member.coin, creation, knownAt: m.population!.frame.availabilityCut },
      untilSec: String(ACQUISITION_D + 7 * ACQUISITION_DAY), reason: 'sample',
      filters: [{ addresses: [member.coin], topics: [hash(800)] }] }], budget: m.budget };
  return AcquisitionDefinitionSchema.parse(m);
}
