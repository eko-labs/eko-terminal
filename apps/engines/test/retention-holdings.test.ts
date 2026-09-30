import { afterEach, describe, expect, it } from 'vitest';
import { binary, compactTransfers, sealRawPartition, readLifetime, migrate, migrateEngines, rebuildBalances, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { Address } from '@eko/shared';
import type { Hex } from 'viem';
import { holdingsAt } from '../src/sources.js';
import { ReplayCache } from '../src/replay-cache.js';

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
const coin = address(1), zero = address(0), holders = [address(0x11), address(0x12), address(0x13)];
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
let eventId = 1;

async function fixture() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
  await db.insert('tokens', { address: binary(coin), deployer: binary(address(2)), curve: null, name: 'Sample token', symbol: 'DEMO',
    launchpad: 'other', decimals: 0, total_supply: '3000', supply_block: '1', first_block: '1', block: '1' });
  for (let n = 1; n <= 20; n++) {
    await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: new Date((epoch + n * 60) * 1000) });
    const moves: [Address, Address, number][] = n === 1 ? holders.map(h => [zero, h, 1000]) : [[holders[n % 3]!, holders[(n + 1) % 3]!, n * 7]];
    for (const [from, to, amount] of moves) await db.insert('token_transfers', { ts: new Date((epoch + n * 60) * 1000), block: String(n),
      tx_hash: binary(hash(eventId++)), log_index: 0, token: binary(coin), from_address: binary(from), to_address: binary(to), amount: String(amount) });
  }
  await db.tx(tx => rebuildBalances(tx));
  return db;
}
const amounts = (rows: { holder: Uint8Array; amount: string }[]) => rows.map(r => `${Buffer.from(r.holder).toString('hex')}:${BigInt(r.amount)}`).sort();

describe('engine holdings over compacted transfer history', () => {
  it('returns the same historical holders, live and in replay, after old transfers roll into baselines', async () => {
    const db = await fixture();
    const replay = async () => { const cache = new ReplayCache(db, 20, new Map(), false); await cache.initialize(); return cache.holdingsAt(coin, 15); };
    const [liveBefore, replayBefore] = [amounts(await holdingsAt(db, coin, 15)), amounts(await replay())];
    expect(liveBefore).toEqual(replayBefore);
    expect(await compactTransfers(db, [binary(coin)], 10n, 1000)).toBe(12);
    expect(amounts(await holdingsAt(db, coin, 15))).toEqual(liveBefore);
    expect(amounts(await replay())).toEqual(replayBefore);
    // The pre-baseline view retains the old prefix-query result, not a future compacted balance.
    expect(await holdingsAt(db,coin,1)).toEqual([]);
    // Views at the head still read the exact current balances.
    expect(amounts(await holdingsAt(db, coin, 20))).toEqual(amounts((await db.sql.query<{ holder: Uint8Array; amount: string }>(
      'SELECT holder, amount::text FROM balances WHERE token=$1 AND amount>0', [binary(coin)])).rows));
  });
});


it('invalidates cached swaps and avoids counting sealed swaps or transfer baselines twice while detach is pending',async()=>{
 const {incrementalSwaps}=await import('../src/swap-reader.js');
 const db=await fixture();
 for(let n=1;n<=5;n++)await db.insert('swaps',{ts:new Date((epoch+n*60)*1000),block:n,tx_hash:binary(hash(n)),log_index:0,coin:binary(coin),pool_id:binary(address(50)),quote_asset:binary(address(0)),trader:binary(holders[0]!),side:1,amount_coin:'10',amount_quote:'5',price_quote:0.5,usd:10,venue:'uniswap_v3'});
 expect(await incrementalSwaps(db,coin,20)).toHaveLength(5);
 const before=amounts(await holdingsAt(db,coin,20));
 await sealRawPartition(db,'swaps','swaps_d2026_10_01');
 expect(await incrementalSwaps(db,coin,20)).toHaveLength(0);expect((await readLifetime(db,binary(coin)))?.count).toBe(5);
 await sealRawPartition(db,'token_transfers','token_transfers_d2026_10_01');
 expect(amounts(await holdingsAt(db,coin,20))).toEqual(before);
 const cache=new ReplayCache(db,20,new Map(),false);await cache.initialize();expect(amounts(await cache.holdingsAt(coin,20))).toEqual(before);
 await db.tx(tx=>rebuildBalances(tx));expect(amounts(await holdingsAt(db,coin,20))).toEqual(before);
});
