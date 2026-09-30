import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { RpcGuardError, type PonsProfileClient } from '@eko/chain';
import type { Address } from '@eko/shared';
import { ownerPowers, ponsProfiles } from '../src/pons-profile.js';
import { toFunctionSelector } from 'viem';

// A spent daily paid budget must not stop the scanner: the restart's cold refresh met the same spent budget, so the
// process restarted all night without rating anything. The checkpoint's getters stay unknown instead.
const coin = `0x${'a1'.repeat(20)}` as Address, curve = `0x${'c1'.repeat(20)}` as Address, hash = new Uint8Array(32).fill(7);
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db);
  return db;
}
const failing = (code: RpcGuardError['code']): PonsProfileClient => ({
  getCode: async () => { throw new RpcGuardError(code); }, readContract: async () => { throw new RpcGuardError(code); },
});

describe('Pons profile reads without paid budget', () => {
  it('leaves the checkpoint unknown and unstored when the daily budget is spent', async () => {
    const db = await database();
    await expect(ponsProfiles(db).read(coin, curve, 10, hash, failing('rpc_budget_exhausted'))).resolves.toBeUndefined();
    expect((await db.sql.query('SELECT 1 FROM engine_reads WHERE coin=$1', [binary(coin)])).rows).toHaveLength(0);
  });
  it('still stops on a session budget or shutdown', async () => {
    const db = await database();
    await expect(ponsProfiles(db).read(coin, curve, 11, hash, failing('rpc_session_budget_reached'))).rejects.toMatchObject({ code: 'rpc_session_budget_reached' });
  });
});

describe('scanner run loop without paid budget', () => {
  it('waits and polls again on a spent daily budget instead of stopping, and still stops on other errors', async () => {
    const { EngineWorker } = await import('../src/worker.js');
    const db = await database();
    const waits: number[] = [];
    const worker = new EngineWorker(db, { budgetWaitMs: 5, onBudgetWait: () => waits.push(Date.now()) });
    let polls = 0;
    worker.poll = async () => { polls++; if (polls <= 2) throw new RpcGuardError('rpc_budget_exhausted'); worker.stop(); return 0; };
    await worker.run();
    expect(waits).toHaveLength(2); expect(polls).toBe(3);
    const failing = new EngineWorker(db, { budgetWaitMs: 5 });
    failing.poll = async () => { throw new Error('database unavailable'); };
    await expect(failing.run()).rejects.toThrow('database unavailable');
  });
});

describe('owner powers from the dispatch table', () => {
  const push4 = (sig: string) => `63${toFunctionSelector(sig).slice(2)}`;
  it('finds mint, blacklist, pause, upgrade and owner selectors, and none in a plain token', () => {
    const plain = `0x6080${push4('transfer(address,uint256)')}${push4('approve(address,uint256)')}${push4('burn(uint256)')}`;
    expect(ownerPowers(plain)).toEqual({ mint: false, blacklist: false, pause: false, upgrade: false, owner: false, codeBytes: (plain.length - 2) / 2 });
    const owned = `${plain}${push4('mint(address,uint256)')}${push4('setBlacklist(address,bool)')}${push4('pause()')}${push4('upgradeTo(address)')}${push4('owner()')}`;
    expect(ownerPowers(owned)).toMatchObject({ mint: true, blacklist: true, pause: true, upgrade: true, owner: true });
  });
});
