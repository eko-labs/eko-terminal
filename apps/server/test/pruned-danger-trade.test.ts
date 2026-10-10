import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, rebuildBalances, runRetention, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { EngineWorker } from '@eko/engines';
import { evaluate } from '@eko/policy';
import type { Address } from '@eko/shared';
import type { Hex } from 'viem';
import { buyVerdictGateFor, guardReceiptFor, readModelVerdicts } from '../src/exec/live-trade.js';
import { ReadStore } from '../src/read/store.js';
import { actualRequest, agent, binding, deps } from '../../../packages/policy/test/actual-fixtures.js';
import { policy } from '../../../packages/policy/test/fixtures.js';

// A coin rated Danger when retention pruned its raw history (packages/db/src/retention.ts) trades again. The engines
// re-card it with partial checks but keep it Danger, so live trade admission still refuses buys; sells stay open.
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const coin = address(1), deployer = address(2), pool = address(5), zero = address(0);
const traders = [address(0x11), address(0x12), address(0x13)], newcomer = address(0x21);
const epoch = Date.parse('2026-08-01T00:00:00Z') / 1000, DAY = 86_400;
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
let event = 0;

async function block(db: ChainDb, n: number, sec: number) {
  await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: new Date((epoch + sec) * 1000) });
}
async function swap(db: ChainDb, n: number, sec: number, trader: Address) {
  await db.insert('swaps', { ts: new Date((epoch + sec) * 1000), block: String(n), tx_hash: binary(hash(++event)), log_index: 0, venue: 'uniswap_v3', pool_id: binary(pool),
    coin: binary(coin), quote_asset: binary(zero), trader: binary(trader), tx_from: binary(trader), tx_to: binary(pool), side: 1, amount_coin: '100', amount_quote: '100',
    price_quote: 1, usd: 10, priced_block: String(n) });
}
async function transfer(db: ChainDb, n: number, sec: number, from: Address, to: Address, amount: number) {
  await db.insert('token_transfers', { ts: new Date((epoch + sec) * 1000), block: String(n), tx_hash: binary(hash(++event)), log_index: 0, token: binary(coin),
    from_address: binary(from), to_address: binary(to), amount: String(amount) });
  await db.tx(tx => rebuildBalances(tx));
}

describe('a revived coin that was Danger when its history was pruned', () => {
  it('stays Danger, so buys are refused while sells remain open', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
    await block(db, 1, 0);
    await db.insert('tokens', { address: binary(coin), deployer: binary(deployer), curve: null, name: 'Sample token', symbol: 'DEMO', launchpad: 'other', decimals: 0,
      total_supply: '3000000', supply_block: '1', first_block: '1', block: '1' });
    await db.insert('pools', { id: binary(pool), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(zero), fee: 3000, tick_spacing: 1, creation_verified: true, created_block: '1', block: '1' });
    for (const t of traders) await transfer(db, 1, 0, zero, t, 1000);
    await block(db, 2, 60); await swap(db, 2, 60, traders[0]!);
    await block(db, 10, 5 * DAY); await swap(db, 10, 5 * DAY, traders[1]!); await transfer(db, 10, 5 * DAY, traders[1]!, traders[2]!, 20);
    await block(db, 11, 5 * DAY + 600);
    const worker = (sec: number) => new EngineWorker(db, { now: () => epoch + sec });
    expect(await worker(5 * DAY + 600).poll()).toBeGreaterThan(0);
    // Rated Danger, outcomes labeled, then two quiet days: the Danger rule prunes it.
    await db.sql.query(`UPDATE coin_card_latest SET data=jsonb_set(data,'{verdict,level}','"danger"') WHERE coin=$1`, [binary(coin)]);
    for (const horizon of ['1h', '24h', '7d']) await db.sql.query("INSERT INTO outcomes VALUES($1,$2,1,'rugged','{}') ON CONFLICT DO NOTHING", [binary(coin), horizon]);
    await block(db, 20, 8 * DAY);
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], dangerQuietDays: 2, now: () => (epoch + 8 * DAY) * 1000 })).toMatchObject({ dangerCoins: 1 });
    // It trades again and the engines re-card it.
    await block(db, 21, 8 * DAY + 3600); await swap(db, 21, 8 * DAY + 3600, newcomer); await transfer(db, 21, 8 * DAY + 3600, traders[2]!, newcomer, 5);
    expect(await worker(8 * DAY + 3700).poll()).toBeGreaterThan(0);

    const tv = await readModelVerdicts({ store: new ReadStore(db, () => (epoch + 8 * DAY + 3700) * 1000), guard: { verdict: async () => null } }, () => db.sql)(coin);
    expect(tv).toMatchObject({ guardV2Active: false, scanPending: false, verdict: { level: 'danger', reasons: expect.arrayContaining(['Rated Danger before its history was pruned']) } });
    const verdict = tv.verdict === 'unavailable' ? undefined : tv.verdict;
    expect(verdict?.playbooks.some(m => m.level === 'danger')).toBe(false);
    // Live trade admission (no Guard v2 release): the current-verdict gate refuses the buy.
    const p = { ...policy, blockPlaybookLevel: null };
    const run = (side: 'buy' | 'sell') => {
      const b = { ...binding(p), side, ...(side === 'sell' ? { tx: { ...binding(p).tx, value: '0' } } : {}) };
      return evaluate({ ...actualRequest(p), order: { ...actualRequest(p).order, side, execution: b, tx: { to: b.tx.to, data: b.tx.data, value: b.tx.value } } }, p, agent,
        { ...deps, verdictFor: () => tv.verdict, buyVerdictGate: buyVerdictGateFor(tv) });
    };
    const buy = run('buy');
    expect(buy.decision).toBe('deny');
    expect(buy.reasons.map(r => r.split(':')[0])).toContain('guard_danger');
    // Sells never consult the verdict and bind none.
    expect(run('sell')).toMatchObject({ decision: 'allow', reasons: [] });
    expect(guardReceiptFor('sell', tv)).toBe('not-required:sell');
  });
});
