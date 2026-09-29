import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { binary, migrate, migrateEngines, guardManifestId, guardStorageHash, guardRowsKnownAt, GuardSourceStore } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { ChainDb } from '@eko/db';
import { captureLaunchRolesV2, resolveLaunchRolesV2 } from '@eko/chain';
import type { LaunchRoleInput, LaunchFeeObservation, LaunchEventObservation } from '@eko/chain';
import { CoinCardV2Schema, GuardCursorSchema } from '@eko/shared';
import type { GuardStoredRole } from '@eko/shared';
import { loadLaunchIdentityV2 } from '../src/identity-v2.js';
import { loadSources } from '../src/sources.js';
import { EngineWorker } from '../src/worker.js';
import { card as cardFixture } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';

const address = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
const coin = address(1), caller = address(2), factory = address(3), curve = address(4), customer = address(5), recipient = address(6);
const cursor = GuardCursorSchema.parse({ chainId: 4663, blockNumber: '123', blockHash: hash(123), transactionIndex: null, executionOrdinal: null, timestampSec: '1000', boundary: 'block_end' });
const sourceRevision = guardStorageHash({ candidate: '029-synthetic', methodVersion: '2.0.0' });
function input(from = caller, to: string | null = factory): Omit<LaunchRoleInput, 'events'> & { events: LaunchEventObservation[] } {
  return { coin, cursor, name: 'Sample token', symbol: 'DEMO', launchpad: 'pons', exemptions: [], senders: [], events: [
    { block: '120', logIndex: 0, txHash: hash(10), ref: `${hash(10)}:0`, emitter: factory, kind: 'launch', data: { token: coin, deployer: caller, curve, outerFrom: from, outerTo: to, timestampSec: '999', pairToken: address(0) } },
    { block: '120', logIndex: 1, txHash: hash(10), ref: `${hash(10)}:1`, emitter: curve, kind: 'trade', data: { token: coin, side: 1, buyer: caller, recipient, timestampSec: '999' } },
  ] };
}
const resolved = (s: ReturnType<typeof resolveLaunchRolesV2>, kind: GuardStoredRole['role']) => s.roles.filter(r => r.role === kind);

describe('launch roles: synthetic archetypes, not measured launcher validation', () => {
  it('authenticates a direct EOA factory call without substituting signer for economic recipient/payer', () => {
    const s = resolveLaunchRolesV2(input());
    for (const kind of ['factory_deployer', 'outer_signer', 'launch_principal'] as const) expect(resolved(s, kind)[0]).toMatchObject({ address: caller, status: 'verified' });
    expect(resolved(s, 'buy_recipient')[0].address).toBe(recipient);
    expect(resolved(s, 'creation_payer')[0]).toMatchObject({ address: null, status: 'missing' });
    expect(s.feeConfiguration).toBeNull();
    expect(s.jobs.map(j => j.kind)).toEqual(['creation_payer', 'fee_configuration']);
  });
  it('keeps a shared factory caller separate from independent outer customers and fees', () => {
    const first = resolveLaunchRolesV2(input(customer, caller)), second = resolveLaunchRolesV2(input(address(7), caller));
    for (const s of [first, second]) {
      expect(resolved(s, 'factory_deployer')[0].address).toBe(caller);
      expect(resolved(s, 'launch_principal')[0]).toMatchObject({ address: null, status: 'missing' });
      expect(s.jobs.map(j => j.kind)).toContain('service_review');
      expect(resolved(s, 'fee_recipient')).toEqual([]);
    }
    expect(resolved(first, 'outer_signer')[0].address).toBe(customer);
    expect(resolved(second, 'outer_signer')[0].address).toBe(address(7));
  });
  it('uses same-transaction senders for old launch rows while leaving absent signers missing', () => {
    const i = input(); delete i.events[0].data.outerFrom; delete i.events[0].data.outerTo;
    expect(resolved(resolveLaunchRolesV2(i), 'outer_signer')[0].address).toBeNull();
    i.senders = [{ txHash: hash(11), from: customer, to: caller }, { txHash: hash(10), from: caller, to: factory }];
    expect(resolved(resolveLaunchRolesV2(i), 'launch_principal')[0].address).toBe(caller);
  });
  it.each(['self-calling delegated account', 'high-nonce service-like routed account'])('leaves %s unresolved without inferring delegation/nonce control', archetype => {
    const i = input(caller, archetype.startsWith('self') ? caller : address(8));
    i.events[0].data = { ...i.events[0].data, code: `0xef0100${address(9).slice(2)}`, nonce: '12133' };
    const s = resolveLaunchRolesV2(i);
    expect(resolved(s, 'outer_signer')[0].address).toBe(caller);
    expect(resolved(s, 'launch_principal')[0].address).toBeNull();
    expect(s.jobs.map(j => j.kind)).toEqual(['trace_principal', 'service_review', 'creation_payer', 'fee_configuration']);
  });
  it('deduplicates exemptions per wallet while retaining both logs and separate fee roles', () => {
    const i = input();
    i.events.push(...[2, 3].map(logIndex => ({ block: '120', logIndex, txHash: hash(10), ref: `${hash(10)}:${logIndex}`, emitter: curve, kind: 'exempt', data: { token: coin, wallet: recipient } })));
    i.exemptions = [{ wallet: recipient, ref: `${hash(10)}:2` }];
    i.feeObservation = { coin, curve, cursor, knownAt: { cursor, acquisitionSequence: '1' }, creatorTaxBps: '250', ordinaryFeeBps: '100', feeRecipient: recipient, sourceRef: 'synthetic-curve-config' };
    const s = resolveLaunchRolesV2(i);
    expect(resolved(s, 'exempt')).toHaveLength(1);
    expect(resolved(s, 'exempt')[0].refs).toEqual([`${hash(10)}:2`, `${hash(10)}:3`]);
    expect(resolved(s, 'fee_recipient')[0].address).toBe(recipient);
    expect(s.roles.map(r => r.role)).not.toContain('treasury');
    expect(s.feeConfiguration?.creatorTaxBps).toBe('250');
    expect(() => resolveLaunchRolesV2({ ...i, feeObservation: { ...i.feeObservation!, coin: address(99) } })).toThrow('does not match');
    expect(resolveLaunchRolesV2(input(customer, caller)).feeConfiguration).toBeNull();
  });
  it('preserves batch economic destinations without treating creation-tx membership as launch control', () => {
    const i = input(customer, address(8));
    i.events.push({ block: '120', logIndex: 4, txHash: hash(10), ref: `${hash(10)}:4`, emitter: curve, kind: 'trade', data: { token: coin, side: -1, seller: address(7), recipient: address(9), timestampSec: '999' } });
    i.events.push({ block: '120', logIndex: 5, txHash: hash(10), ref: `${hash(10)}:5`, emitter: factory, kind: 'launch', data: { token: address(99), deployer: customer } });
    const s = resolveLaunchRolesV2({ ...i, events: [...i.events].reverse() });
    expect(s).toEqual(resolveLaunchRolesV2(i));
    expect(resolved(s, 'buy_recipient')[0].address).toBe(recipient);
    expect(resolved(s, 'proceeds_recipient')[0].address).toBe(address(9));
    expect(resolved(s, 'launch_principal')[0].address).toBeNull();
    expect(resolved(s, 'buy_payer')).toEqual([]);
  });
  it('does not use future events, abbreviations, actor aliases or conflicting outer senders as proof', () => {
    const i = input(); delete i.events[0].data.outerFrom; delete i.events[0].data.outerTo;
    i.events[0].data.actor = caller; i.events[0].data.deployer = '0x0e16…';
    expect(resolved(resolveLaunchRolesV2(i), 'factory_deployer')[0].address).toBeNull();
    i.events[0].data.deployer = caller;
    i.senders = [{ txHash: hash(10), from: caller, to: factory }, { txHash: hash(10), from: customer, to: factory }];
    expect(resolved(resolveLaunchRolesV2(i), 'outer_signer')[0].address).toBeNull();
    i.events[0].block = '124';
    expect(resolved(resolveLaunchRolesV2(i), 'factory_deployer')[0].address).toBeNull();
  });
});

let db: ChainDb;
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); }, 30000);
afterAll(async () => { await db?.close(); });
async function manifest(sequence = '1') {
  const key = { sourceId: 'launch-roles-fixture', sourceRevision, replayMode: 'retrospective' as const, cut: { cursor, acquisitionSequence: sequence }, watermark: cursor };
  return { ...key, id: guardManifestId(key), acquiredAt: '2026-10-02T00:00:00.000Z' };
}
const cutFor = (m: Awaited<ReturnType<typeof manifest>>, c = coin) => ({ chainId: 4663, coin: c, manifestId: m.id, availability: m.cut, state: cursor });
async function seed(c = coin, pons = true) {
  await db.insert('tokens', { address: binary(c), name: 'Sample token', symbol: 'DEMO', launchpad: pons ? 'pons' : 'other', deployer: null, curve: pons ? binary(curve) : null, first_block: '120', block: '120' });
  if (pons) for (const e of input(customer, caller).events) await db.insert('pons_events', { token: binary(c), block: e.block, tx_hash: binary(e.txHash), log_index: e.logIndex, emitter: binary(e.emitter as `0x${string}`), kind: e.kind, data: JSON.stringify(e.data) });
}

describe('029 capture/read integration, in-memory PGlite with zero upstream requests', () => {
  it('persists independent/null roles, missing coverage/jobs and immutable idempotent evidence', async () => {
    await seed(); const m = await manifest();
    const first = (await captureLaunchRolesV2(db, coin, m))!, second = (await captureLaunchRolesV2(db, coin, m))!;
    expect(second).toEqual(first);
    const roles = await guardRowsKnownAt<GuardStoredRole>(db, 'guard_roles', cutFor(m));
    expect(roles).toHaveLength(5);
    expect(roles.find(r => r.data.role === 'launch_principal')!.data).toMatchObject({ address: null, status: 'missing' });
    const coverage = await guardRowsKnownAt<{ coverage: { complete: boolean; gaps: string[] } }>(db, 'guard_source_coverage', cutFor(m));
    expect(coverage[0].data.coverage).toMatchObject({ complete: false, gaps: ['missing'] });
    const partial = (await loadLaunchIdentityV2(db, cutFor(m)))!;
    expect(partial.identity.factoryDeployer.value).toBe(caller);
    expect(partial.identity.outerSigner.value).toBe(customer);
    expect(partial.identity.principal).toMatchObject({ value: null, status: 'unknown', failureCode: 'missing' });
    expect(partial.identity.operatorGroup).toBeNull();
    expect(partial.identity.service).toMatchObject({ status: 'unresolved', codeHash: null });
    expect(partial.identity.service.implementation.value).toBeNull();
    expect(partial.economicRecipients[0].address.value).toBe(recipient);
    expect(partial.jobs.map(j => j.kind)).toContain('trace_principal');
    // Full contract accepts the partial identity; no fake deployer is necessary.
    expect(CoinCardV2Schema.safeParse({ ...cardFixture, identity: partial.identity, verdict: { ...cardFixture.verdict, coin } }).success).toBe(true);
    await expect(db.sql.query('UPDATE guard_roles SET data=$1 WHERE id=$2', ['{}', first.roleIds[0]])).rejects.toThrow('append-only');
  });
  it('permits a V2 unknown-issuer identity while the legacy loader/worker still refuse it', async () => {
    const unknown = address(222); await seed(unknown, false); const m = await manifest();
    await captureLaunchRolesV2(db, unknown, m);
    const partial = (await loadLaunchIdentityV2(db, cutFor(m, unknown)))!;
    expect(partial.identity.factoryDeployer.value).toBeNull(); expect(partial.identity.principal.value).toBeNull();
    expect(partial.identity.createdAt.value).toBeNull(); expect(partial.identity.marketOpen.value).toBeNull();
    const upperAddress = `0x${unknown.slice(2).toUpperCase()}` as `0x${string}`;
    expect((await loadLaunchIdentityV2(db, cutFor(m, upperAddress)))!.identity.address).toBe(unknown);
    expect(partial.jobs.map(j => j.kind)).toContain('launch_evidence');
    expect(await loadSources(db, unknown, 123)).toBeNull();
    await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) VALUES(123,to_timestamp(1000),$1,'fixture'),(120,to_timestamp(999),$2,'fixture')", [binary(hash(123)), binary(hash(120))]);
    await new EngineWorker(db).processBlock(123);
    expect((await db.sql.query('SELECT 1 FROM coin_cards')).rows).toHaveLength(0);
  });
  it('bounds fee evidence to the per-launch curve and known-at cut; later revisions do not leak', async () => {
    const early = await manifest(), late = await manifest('2');
    const fee: LaunchFeeObservation = { coin, curve, cursor, knownAt: late.cut, creatorTaxBps: '0', ordinaryFeeBps: '100', feeRecipient: address(8), sourceRef: 'synthetic-per-curve-read' };
    await expect(captureLaunchRolesV2(db, coin, early, fee)).rejects.toThrow('captured availability');
    await expect(captureLaunchRolesV2(db, coin, early, { ...fee, knownAt: early.cut })).rejects.toThrow('new availability revision');
    await captureLaunchRolesV2(db, coin, late, fee);
    expect((await loadLaunchIdentityV2(db, cutFor(early)))!.feeConfiguration).toBeNull();
    expect((await loadLaunchIdentityV2(db, cutFor(late)))!.feeConfiguration).toMatchObject({ creatorTaxBps: '0', feeRecipient: address(8) });
    expect((await loadLaunchIdentityV2(db, cutFor(late)))!.identity.feeRecipients[0].address.value).toBe(address(8));
    await new GuardSourceStore(db).invalidateReorg({ chainId: 4663, fromBlock: '123', causeId: hash(999), knownAt: late.cut, recordedAt: late.acquiredAt });
    expect(await loadLaunchIdentityV2(db, cutFor(late))).toBeNull();
  });
});
