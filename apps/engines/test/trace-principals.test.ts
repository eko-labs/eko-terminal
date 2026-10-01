import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, guardManifestId, guardStorageHash, guardRowsKnownAt, GuardSourceStore } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { ChainDb } from '@eko/db';
import { captureLaunchRolesV2 } from '@eko/chain';
import { loadLaunchIdentityV2 } from '../src/identity-v2.js';
import { traceFixture, fakeAcquisition, coin, cursor, at, hash, address, account, otherAccount, tool, txHash } from '../../../packages/chain/test/fixtures/trace-principals.js';
let db: ChainDb;
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); }, 30000);
afterAll(async () => { await db?.close(); });
const sourceRevision = guardStorageHash({ packet: '043', fixture: 'trace-principals-2.1.0' });
function manifest(sequence: string) {
  const key = { sourceId: 'trace-principals-fixture', sourceRevision, replayMode: 'retrospective' as const,
    cut: { cursor, acquisitionSequence: sequence }, watermark: cursor };
  return { ...key, id: guardManifestId(key), acquiredAt: '2026-10-02T00:00:00.000Z' };
}
const cut = (m: ReturnType<typeof manifest>) => ({ chainId: 4663, coin, manifestId: m.id, availability: m.cut, state: cursor });
describe('043 append-only trace integration, in-memory PGlite and fake metered upstreams', () => {
  it('captures unresolved then authenticated revisions, keeps raw proof/operation refs, and exposes service/economic roles', async () => {
    const fixture = traceFixture(), first = manifest('1'), second = manifest('2');
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', launchpad: 'pons', first_block: '123', block: '123' });
    for (const e of fixture.roleInput.events) await db.insert('pons_events', { token: binary(coin), block: e.block, tx_hash: binary(txHash), log_index: e.logIndex,
      emitter: binary(e.emitter as `0x${string}`), kind: e.kind, data: JSON.stringify(e.data) });
    await captureLaunchRolesV2(db, coin, first);
    expect((await loadLaunchIdentityV2(db, cut(first)))!.identity.principal.value).toBeNull();
    const block = await fakeAcquisition(fixture.responses).acquisition.acquire(cursor);
    const service = { registry: { version: '2.1.0', entries: [] }, address: tool, codeHash: hash(50), implementation: address(55), at: second.cut,
      launches: Array.from({ length: 20 }, (_, i) => ({ id: `launch-${i}`, service: tool, codeHash: hash(50), implementation: address(55), cursor,
        knownAt: second.cut, principal: address(100 + i), authenticated: true, feeRecipient: address(200 + i) })), launchCoverageComplete: true };
    const observation = { block, options: { at: second.cut, entryPoints: fixture.profiles, service } };
    const result = (await captureLaunchRolesV2(db, coin, second, undefined, observation))!;
    expect(await captureLaunchRolesV2(db, coin, second, undefined, observation)).toEqual(result);
    expect((await loadLaunchIdentityV2(db, cut(first)))!.identity.principal.value).toBeNull();
    const resolved = (await loadLaunchIdentityV2(db, cut(second)))!;
    expect(resolved.identity.principal.value).toBe(account);
    expect(resolved.identity.service).toMatchObject({ status: 'candidate', launches: { value: 20 }, principals: { value: 20 }, distinctPairsPct: { value: '100', numerator: '2000', denominator: '20' } });
    expect(resolved.economicRoles.filter(r => r.role === 'buy_payer').map(r => r.address.value)).toEqual([account, otherAccount]);
    expect(resolved.identity.operatorGroup).toBeNull();
    const roles = await guardRowsKnownAt<{ role: string; address: string | null; methodVersion: string }>(db, 'guard_roles', cut(second));
    expect(roles.filter(r => r.data.role === 'launch_principal').at(-1)!.data).toMatchObject({ address: account, methodVersion: '2.1.0' });
    await expect(db.sql.query('UPDATE guard_roles SET data=$1 WHERE id=$2', ['{}', result.roleIds[0]])).rejects.toThrow('append-only');
    const changed = { ...observation, options: { ...observation.options, entryPoints: [] } };
    await expect(captureLaunchRolesV2(db, coin, second, undefined, changed)).rejects.toThrow('new availability revision');
  });
  it('rejects later acquisitions and invalidates traced role dependencies on reorg', async () => {
    const fixture = traceFixture(), block = await fakeAcquisition(fixture.responses).acquisition.acquire(cursor), m = manifest('2');
    await expect(captureLaunchRolesV2(db, coin, m, undefined, { block, options: { at: { ...at, acquisitionSequence: '3' }, entryPoints: fixture.profiles } })).rejects.toThrow('captured availability');
    await new GuardSourceStore(db).invalidateReorg({ chainId: 4663, fromBlock: cursor.blockNumber, causeId: hash(999), knownAt: m.cut, recordedAt: m.acquiredAt });
    expect(await loadLaunchIdentityV2(db, cut(m))).toBeNull();
  });
});
