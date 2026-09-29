import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, guardManifestId, guardStorageHash, GuardSourceStore, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { captureLaunchRolesV2 } from '@eko/chain';
import { CoinCardV2Schema, GuardCursorSchema } from '@eko/shared';
import { loadLaunchIdentityV2 } from '../src/identity-v2.js';
import { card as cardFixture } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';

// This independently seeded token is synthetic, not an Occupy launch observation.
const coin = `0x${'12'.repeat(20)}` as const;
const cursor = GuardCursorSchema.parse({ chainId: 4663, blockNumber: '123', blockHash: guardStorageHash('occupy-synthetic-fork'), timestampSec: '1000', transactionIndex: null, executionOrdinal: null, boundary: 'block_end' });
const key = { sourceId: 'occupy-partial-fixture', sourceRevision: guardStorageHash('occupy-synthetic-source'), replayMode: 'retrospective' as const, cut: { cursor, acquisitionSequence: '1' }, watermark: cursor };
const manifest = { ...key, id: guardManifestId(key), acquiredAt: '2026-10-03T00:00:00.000Z' };
const cut = { chainId: 4663, coin, manifestId: manifest.id, availability: manifest.cut, state: cursor };
let db: ChainDb;
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); }, 30000);
afterAll(async () => { await db?.close(); });

describe('Occupy partial identity through existing indexer-owned evidence', () => {
  it('creates a schema-valid partial card, replays idempotently and invalidates orphan evidence', async () => {
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', launchpad: 'occupy', deployer: null, curve: null, first_block: '120', block: '120' });
    const first = (await captureLaunchRolesV2(db, coin, manifest))!;
    expect(await captureLaunchRolesV2(db, coin, manifest)).toEqual(first);
    const partial = (await loadLaunchIdentityV2(db, cut))!;
    expect(partial.identity.launchpad).toBe('occupy');
    expect(partial.identity.stage).toBe('unknown');
    for (const field of ['factoryDeployer', 'outerSigner', 'principal', 'creationPayer', 'createdAt', 'marketOpen', 'firstTrade', 'graduation', 'quoteAsset'] as const) expect(partial.identity[field]).toMatchObject({ value: null, status: 'unknown', failureCode: 'missing' });
    expect(partial.identity.pools).toEqual([]);
    expect(partial.identity.exemptions).toEqual([]);
    expect(partial.identity.feeRecipients).toEqual([]);
    expect(partial.feeConfiguration).toBeNull();
    expect(partial.jobs.map(j => j.kind)).toEqual(['launch_evidence', 'trace_principal', 'service_review', 'creation_payer', 'fee_configuration']);
    const card = CoinCardV2Schema.parse({ ...cardFixture, identity: partial.identity, verdict: { ...cardFixture.verdict, coin } });
    expect(card.control.currentController).toMatchObject({ value: null, status: 'unknown' });
    expect(card.liquidity.lpStatus).toMatchObject({ value: null, status: 'unknown' });
    expect((await db.sql.query('SELECT 1 FROM pons_events')).rows).toHaveLength(0);
    expect((await db.sql.query('SELECT 1 FROM guard_chain_evidence')).rows).toHaveLength(1);

    const store = new GuardSourceStore(db);
    const reorg = { chainId: 4663, fromBlock: '123', causeId: guardStorageHash('occupy-synthetic-reorg'), knownAt: { cursor, acquisitionSequence: '2' }, recordedAt: manifest.acquiredAt };
    expect(await store.invalidateReorg(reorg)).toContain(first.evidenceId);
    expect(await store.invalidateReorg(reorg)).toEqual([]);
    expect(await loadLaunchIdentityV2(db, cut)).toBeNull();
    expect(await loadLaunchIdentityV2(db, { ...cut, validity: 'historic' })).not.toBeNull();
  });
});
