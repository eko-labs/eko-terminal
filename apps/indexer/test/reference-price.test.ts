import { afterEach, describe, expect, it } from 'vitest';
import { binary, hex, migrate, migrateEngines, compactLifetimeSwaps, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry, v3Abi } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { BlockDecoder, type Prepared } from '../src/decode.js';
import { loadSenderScope } from '../src/sender-scope.js';
import { type ChainClient, type RpcBlock, type RpcLog, type RpcReceipt } from '../src/types.js';

const registry = loadRegistry();
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const weth = registry.requireAddress('tokens.WETH'), usdg = registry.requireAddress('tokens.USDG');
const canonical = registry.requireAddress('uniswapV3.factory');
const coin = address(1), trading = address(2), trusted = address(3), hostile = address(4), otherFactory = address(5);
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
const client: ChainClient = {
  chainId: async () => 4663, head: async () => 0n,
  block: async () => { throw new Error('No block reads expected'); }, receipts: async () => [], logs: async () => [],
  code: async () => '0x', tokenMetadata: async a => ({ symbol: '<sample>', name: '<sample>', decimals: a.toLowerCase() === usdg.toLowerCase() ? 6 : 18 }),
  v3Pool: async () => null, ethUsdRate: async () => null,
};
const selected = { address: trusted, venue: 'uniswap_v3' as const, fee: 3000 };
function decoder(available = true) { return new BlockDecoder({ ...client, ethUsdRate: async n => available ? { value: 2000, block: n, source: selected } : null }, registry); }
async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db);
  await db.insert('tokens', { address: binary(coin), decimals: 18, first_block: '0', block: '0' });
  await db.insert('pools', { id: binary(trading), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(weth), fee: 3000, tick_spacing: 60, created_block: '0', block: '0' });
  return db;
}
function block(n: number): RpcBlock {
  return { number: toHex(n), hash: hash(n), parentHash: hash(n - 1), timestamp: toHex(1790812800 + n), transactions: [{ hash: hash(100 + n), from: address(6), to: trading }] };
}
function event(b: RpcBlock, abi: AbiEvent, emitter: Address, args: Record<string, unknown>, index: number): RpcLog {
  return { address: emitter, topics: encodeEventTopics({ abi: [abi], args }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(abi.inputs.filter(i => !i.indexed), abi.inputs.filter(i => !i.indexed).map(i => args[i.name!])),
    blockNumber: b.number, blockHash: b.hash, transactionHash: b.transactions[0].hash, logIndex: toHex(index) };
}
function creation(b: RpcBlock, emitter: Address, pool: Address, index: number, reverse = false, fee = 3000) {
  return event(b, v3Abi[0], emitter, { token0: reverse ? usdg : weth, token1: reverse ? weth : usdg, fee, tickSpacing: fee === 500 ? 10 : 60, pool }, index);
}
function swap(b: RpcBlock, pool: Address, index: number, value = 2000, reverse = false, eth = 10n ** 18n) {
  const reference = pool !== trading;
  const usd = BigInt(value) * eth / 10n ** 12n;
  return event(b, v3Abi.find(e => e.name === 'Swap')!, pool, {
    sender: address(6), recipient: address(6), amount0: reference ? (reverse ? usd : -eth) : -100n * eth,
    amount1: reference ? (reverse ? -eth : usd) : eth, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
  }, index);
}
async function apply(db: ChainDb, d: BlockDecoder, b: RpcBlock, logs: RpcLog[], pending?: Pick<Prepared, 'tokens' | 'pools'>) {
  const receipts: RpcReceipt[] = [{ transactionHash: b.transactions[0].hash, blockNumber: b.number, blockHash: b.hash, logs }];
  const scope = await loadSenderScope(db);
  const state = await d.prepare(db, b, receipts, { scope, pending });
  await db.ensurePartitions(new Date(Number(BigInt(b.timestamp)) * 1000));
  await db.tx(tx => d.write(tx, b, receipts, state)); d.committed(state);
  return state;
}
async function trades(db: ChainDb) {
  return (await db.sql.query('SELECT block,usd,priced_block FROM swaps WHERE coin=$1 ORDER BY block', [binary(coin)])).rows;
}

describe('canonical ETH/USD reference provenance', () => {
  it.each([false, true])('pins the deep selected tier through same-block, carry-forward, restart and canonical re-index (reverse=%s)', async reverse => {
    const db = await database(), d = decoder(), b1 = block(1), b2 = block(2), b3 = block(3);
    const logs1 = [swap(b1, trading, 0), creation(b1, canonical, trusted, 1, reverse), swap(b1, trusted, 2, 2000, reverse),
      creation(b1, canonical, hostile, 3, reverse, 500), swap(b1, hostile, 4, 90000, reverse, 10n ** 14n)];
    const logs2 = [swap(b2, trading, 0), swap(b2, hostile, 1, 91000, reverse, 10n ** 14n)];
    const logs3 = [swap(b3, trading, 0), swap(b3, hostile, 1, 92000, reverse, 10n ** 14n)];
    const first = await apply(db, d, b1, logs1);
    expect(first.rate).toEqual({ value: 2000, block: 1n, source: selected });
    expect((await apply(db, d, b2, logs2, first)).rate).toEqual(first.rate);
    expect((await apply(db, decoder(), b3, logs3)).rate).toEqual(first.rate);
    const correct = [1, 2, 3].map(block => ({ block, usd: 2000, priced_block: 1 }));
    const candle = [{ open: 20, high: 20, low: 20, close: 20, volume_usd: 6000 }];
    const bars = async () => (await db.sql.query('SELECT open,high,low,close,volume_usd FROM bars_1m WHERE coin=$1', [binary(coin)])).rows;
    expect(await trades(db)).toEqual(correct); expect(await bars()).toEqual(candle);
    expect((await db.sql.query('SELECT creation_verified,fee FROM pools WHERE id=$1', [binary(hostile)])).rows[0]).toEqual({ creation_verified: true, fee: 500 });
    // Emulate accounting persisted by the vulnerable decoder; raw reference swaps remain canonical.
    await db.sql.query('UPDATE swaps SET usd=90000,priced_block=3 WHERE coin=$1', [binary(coin)]);
    await db.sql.query('UPDATE bars_1m SET open=900,high=900,low=900,close=900,volume_usd=270000 WHERE coin=$1', [binary(coin)]);
    const raw = (await db.sql.query('SELECT amount_coin,amount_quote,tx_hash,log_index FROM swaps WHERE coin=$1 ORDER BY block', [binary(coin)])).rows;
    // New decoders per block force restart recovery even while all later shallow swaps are stored.
    for (const [b, logs] of [[b1, logs1], [b2, logs2], [b3, logs3]] as const) {
      expect((await apply(db, decoder(), b, logs)).rate).toEqual(first.rate);
    }
    expect(await trades(db)).toEqual(correct); expect(await bars()).toEqual(candle);
    expect((await db.sql.query('SELECT amount_coin,amount_quote,tx_hash,log_index FROM swaps WHERE coin=$1 ORDER BY block', [binary(coin)])).rows).toEqual(raw);
    await apply(db, decoder(), b3, logs3); expect(await trades(db)).toEqual(correct); expect(await bars()).toEqual(candle);
    expect((await db.sql.query('SELECT block,pool_id,venue,fee FROM eth_usd_reference_sources')).rows.map(r => ({ ...r, pool_id: hex(r.pool_id as Uint8Array) }))).toEqual([{ block: 1, pool_id: trusted, venue: selected.venue, fee: selected.fee }]);
    await db.tx(tx => tx.deleteAbove(0n));
    expect((await db.sql.query('SELECT * FROM eth_usd_reference_sources')).rows).toEqual([]);
  });

  it('recovers the identical trusted reference after its old raw observation is compacted',async()=>{
    const db=await database();await migrateEngines(db);const b1=block(1);
    const before=await apply(db,decoder(),b1,[creation(b1,canonical,trusted,0),swap(b1,trusted,1,3000)]);
    await db.tx(tx=>compactLifetimeSwaps(tx,binary(weth),1n,1000,35,60,undefined,true));
    expect((await db.sql.query('SELECT 1 FROM swaps WHERE pool_id=$1',[binary(trusted)])).rows).toHaveLength(0);
    const after=await apply(db,decoder(),block(2),[swap(block(2),trading,0)]);
    expect(after.rate).toEqual(before.rate);expect(await trades(db)).toEqual([{block:2,usd:3000,priced_block:1}]);
  });

  it('does not promote a verified canonical event when archive discovery has no selected source', async () => {
    const db = await database(), b = block(1);
    const state = await apply(db, decoder(false), b, [creation(b, canonical, trusted, 0), swap(b, trusted, 1), swap(b, trading, 2)]);
    expect(state.rate).toBeNull(); expect(await trades(db)).toEqual([{ block: 1, usd: null, priced_block: null }]);
  });

  it.each([false, true])('ignores foreign reference swaps in the block, carry-forward and restart (reverse=%s)', async reverse => {
    const db = await database(), d = decoder(), b1 = block(1);
    const state = await apply(db, d, b1, [swap(b1, trading, 0), creation(b1, canonical, trusted, 1, reverse),
      swap(b1, trusted, 2, 2000, reverse), creation(b1, otherFactory, hostile, 3), swap(b1, hostile, 4, 9000)]);
    expect(state.rate).toEqual({ value: 2000, block: 1n, source: selected });
    const b2 = block(2);
    // Pending pool facts are used by ordered windows before they reach the DB scope.
    await apply(db, d, b2, [swap(b2, trading, 0), swap(b2, hostile, 1, 10000)], state);
    const b3 = block(3);
    await apply(db, decoder(), b3, [swap(b3, trading, 0), swap(b3, hostile, 1, 11000)]);
    expect(await trades(db)).toEqual([1, 2, 3].map(block => ({ block, usd: 2000, priced_block: 1 })));
    expect((await db.sql.query('SELECT creation_verified FROM pools WHERE id=$1', [binary(hostile)])).rows[0]).toEqual({ creation_verified: false });
  });

  it('loads verification from stored pool rows for subsequent trusted swaps', async () => {
    const db = await database(), b1 = block(1);
    await apply(db, decoder(), b1, [creation(b1, canonical, trusted, 0)]);
    const b2 = block(2);
    await apply(db, decoder(), b2, [swap(b2, trading, 0), swap(b2, trusted, 1, 3000)]);
    expect(await trades(db)).toEqual([{ block: 2, usd: 3000, priced_block: 2 }]);
  });

  it('stays unavailable without a trusted source, including after restart and provisional pool reads', async () => {
    const db = await database(), d = decoder(false), b1 = block(1);
    await db.insert('pools', { id: binary(hostile), venue: 'uniswap_v3', currency0: binary(weth), currency1: binary(usdg), fee: 3000, tick_spacing: 60, created_block: '0', block: '0', creation_verified: false });
    await apply(db, d, b1, [swap(b1, trading, 0), swap(b1, hostile, 1, 9000)]);
    const b2 = block(2); await apply(db, d, b2, [swap(b2, trading, 0), swap(b2, hostile, 1, 10000)]);
    const b3 = block(3); await apply(db, decoder(false), b3, [swap(b3, trading, 0)]);
    expect(await trades(db)).toEqual([1, 2, 3].map(block => ({ block, usd: null, priced_block: null })));
  });

  it('prevents a foreign creation event from replacing verified currencies and provenance', async () => {
    const db = await database(), b1 = block(1);
    await apply(db, decoder(), b1, [creation(b1, canonical, trusted, 0), creation(b1, otherFactory, trusted, 1, true), swap(b1, trusted, 2), swap(b1, trading, 3)]);
    const b2 = block(2);
    await apply(db, decoder(), b2, [creation(b2, otherFactory, trusted, 0, true), swap(b2, trusted, 1, 3000), swap(b2, trading, 2)]);
    const stored = (await db.sql.query<{ currency0: Uint8Array; creation_verified: boolean }>('SELECT currency0,creation_verified FROM pools WHERE id=$1', [binary(trusted)])).rows[0];
    expect(hex(stored.currency0)).toBe(weth.toLowerCase()); expect(stored.creation_verified).toBe(true);
    expect(await trades(db)).toEqual([{ block: 1, usd: 2000, priced_block: 1 }, { block: 2, usd: 3000, priced_block: 2 }]);
  });

  it.each([false, true])('repairs stored USD and candles on re-index, including clearing unavailable prices (trusted=%s)', async hasTrusted => {
    const db = await database(), b = block(1);
    const logs = [swap(b, trading, 0), creation(b, otherFactory, hostile, 1), swap(b, hostile, 2, 9000),
      ...(hasTrusted ? [creation(b, canonical, trusted, 3), swap(b, trusted, 4)] : [])];
    await apply(db, decoder(hasTrusted), b, logs);
    await db.sql.query('UPDATE swaps SET usd=9000,priced_block=1 WHERE coin=$1', [binary(coin)]);
    await db.sql.query('UPDATE bars_1m SET open=90,close=90,volume_usd=9000 WHERE coin=$1', [binary(coin)]);
    const raw = (await db.sql.query('SELECT amount_coin,amount_quote,tx_hash,log_index FROM swaps WHERE coin=$1', [binary(coin)])).rows;
    await apply(db, decoder(hasTrusted), b, logs);
    expect(await trades(db)).toEqual([{ block: 1, usd: hasTrusted ? 2000 : null, priced_block: hasTrusted ? 1 : null }]);
    expect((await db.sql.query('SELECT open,close,volume_usd FROM bars_1m WHERE coin=$1', [binary(coin)])).rows).toEqual(hasTrusted ? [{ open: 20, close: 20, volume_usd: 2000 }] : []);
    expect((await db.sql.query('SELECT amount_coin,amount_quote,tx_hash,log_index FROM swaps WHERE coin=$1', [binary(coin)])).rows).toEqual(raw);
    await apply(db, decoder(hasTrusted), b, logs);
    expect((await db.sql.query('SELECT count(*) AS n FROM swaps WHERE coin=$1', [binary(coin)])).rows[0].n).toBe(1);
  });
});
