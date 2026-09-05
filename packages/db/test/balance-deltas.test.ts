import { afterEach, describe, expect, it } from 'vitest';
import { applyBalanceDeltas, binary, compactTransfers, hex, migrate, rebuildBalances, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

const epoch = Date.parse('2026-10-01T00:00:00Z');
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const zero = address(0), tokens = [address(0xa1), address(0xa2)], holders = [zero, address(0x11), address(0x12), address(0x13)];
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await db.ensurePartitions(new Date(epoch));
  for (const t of tokens) await db.insert('tokens', { address: binary(t), deployer: binary(zero), curve: null, name: 'Sample token', symbol: 'DEMO',
    launchpad: null, decimals: 0, total_supply: '1000000', supply_block: '1', first_block: '1', block: '1' });
  return db;
}
// A deterministic mix of mints, burns, self-transfers and WETH-style Deposit rows that balances must ignore.
function transfers(fromBlock: number, toBlock: number) {
  const rows: Record<string, unknown>[] = [];
  let seed = fromBlock * 7919;
  const next = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  for (let block = fromBlock; block <= toBlock; block++) for (let i = 0; i < 6; i++) rows.push({
    ts: new Date(epoch + block * 60_000), block: String(block), tx_hash: binary(hash(block * 100 + i)), log_index: i,
    token: binary(tokens[next(2)]!), from_address: binary(holders[next(4)]!), to_address: binary(holders[next(4)]!),
    amount: String(1 + next(1000)), kind: next(5) === 0 ? 'Deposit' : 'Transfer',
  });
  return rows;
}
async function blocks(db: ChainDb, from: number, to: number) {
  for (let n = from; n <= to; n++) await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: new Date(epoch + n * 60_000) });
}
const balances = async (db: ChainDb) => (await db.sql.query<{ token: Uint8Array; holder: Uint8Array; amount: string; last_block: string }>(
  'SELECT token, holder, amount::text, last_block::text FROM balances ORDER BY token, holder')).rows.map(r => `${hex(r.token)}:${hex(r.holder)}:${r.amount}:${r.last_block}`);
const flush = (db: ChainDb, rows: Record<string, unknown>[]) => db.tx(async tx => { await applyBalanceDeltas(tx, await tx.insertMany('token_transfers', rows)); });

describe('incremental balance deltas', () => {
  it('match a full recompute, ignore replayed and duplicate rows, and build on compacted baselines', async () => {
    const db = await database();
    await blocks(db, 1, 40);
    for (let start = 1; start <= 20; start += 5) await flush(db, transfers(start, start + 4));
    const first = await balances(db);
    await db.tx(tx => rebuildBalances(tx));
    expect(first.length).toBeGreaterThan(0);
    expect(await balances(db)).toEqual(first);

    // Replaying blocks already stored inserts nothing, so nothing moves; a batch repeating its own rows counts them once.
    await flush(db, transfers(6, 15));
    expect(await balances(db)).toEqual(first);
    const repeated = transfers(21, 25);
    await flush(db, [...repeated, ...repeated]);

    // History rolled into baselines, then new blocks applied as deltas, still equals a recompute from scratch.
    await compactTransfers(db, tokens.map(t => binary(t)), 18n, 10_000);
    await flush(db, transfers(26, 40));
    const incremental = await balances(db);
    await db.tx(tx => rebuildBalances(tx));
    expect(await balances(db)).toEqual(incremental);
  });

  it('does nothing for a batch without plain transfers', async () => {
    const db = await database();
    await blocks(db, 1, 1);
    await flush(db, transfers(1, 1).map(r => ({ ...r, kind: 'Withdrawal' })));
    expect(await balances(db)).toEqual([]);
  });
});
