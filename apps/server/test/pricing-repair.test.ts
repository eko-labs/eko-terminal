import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { rebuildCandles, PricingRepairWorker, repricePonsSwaps, repricePoolQuotes, retagPairQuotes, type PricingAssets } from '../src/pricing-repair.js';

// 2026-10-11: 694,000 of 1.96 million Pons swaps in seven days had no USD (USDG quotes, and curve swaps decoded before
// the coin's decimals were known), so those coins never got wash and curve checks and could never be rated Clear.
const now = Date.parse('2026-10-11T12:00:00Z');
// Candles are rebuilt for the two days before the run; the default counts from the machine's clock, which left this
// file's fixed day behind on 2026-10-13.
const candleFloor = new Date(now - 2 * 86_400_000);
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const weth = address(0xee), usdg = address(0xd0), pool = address(0x77), coin = address(0xa1), other = address(0xb1), native = address(0);
const assets: PricingAssets = { weth, usdg, usdgDecimals: 6 };
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
let id = 1;
async function swap(db: ChainDb, n: number, c: string, quote: string, amountQuote: string, extra: Record<string, unknown> = {}) {
  const row = { ts: new Date(now - (100 - n) * 60_000), block: String(n), tx_hash: binary(hash(id++)), log_index: 0, venue: 'pons_curve', pool_id: binary(c === weth ? pool : c),
    coin: binary(c), quote_asset: binary(quote), trader: null, tx_from: null, tx_to: null, senders_pending: false, side: 1, amount_coin: '2000000000000000000', amount_quote: amountQuote,
    price_quote: null, usd: null, priced_block: null, pricing_pending: true, ...extra };
  await db.insert('swaps', row);
  return row;
}
const priced = async (db: ChainDb) => (await db.sql.query<{ block: string; usd: number | null; pending: boolean; priced_block: string | null }>(
  'SELECT block::text,usd,pricing_pending AS pending,priced_block::text FROM swaps WHERE coin<>$1 ORDER BY swaps.block', [binary(weth)])).rows;

describe('Pons swap repricing', () => {
  it('rebuilds candles with the coin\'s read-model row taken before the candle coin\'s row lock', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
    const row = await swap(db, 60, coin, native, '1000000000000000000', { usd: 2000, price_quote: 0.5, pricing_pending: false });
    // 2026-10-13: the indexer holds this row from its swap write when it asks for the candle lock; a rebuild that took
    // the lock first and the row second deadlocked with it 18 times in a morning.
    const statements: string[] = [], tx = db.tx.bind(db);
    (db as { tx: unknown }).tx = (work: (inner: ChainDb) => Promise<unknown>) => tx(inner => {
      const query = inner.sql.query.bind(inner.sql);
      (inner.sql as { query: unknown }).query = (text: string, params?: unknown[]) => { statements.push(text.trim()); return query(text, params); };
      return work(inner);
    });
    await rebuildCandles(db, [{ coin: binary(coin), minute: new Date(Math.floor(row.ts.getTime() / 60_000) * 60_000) }]);
    const marked = statements.findIndex(sql=>sql.startsWith('INSERT INTO read_dirty')), locked = statements.indexOf('SELECT coin FROM bar_write_locks WHERE coin=$1 FOR UPDATE');
    expect(statements.some(sql=>sql.startsWith('LOCK TABLE bars_1m'))).toBe(false);
    expect(marked).toBe(0);
    expect(locked).toBeGreaterThan(marked);
    expect((await db.sql.query<{ volume_usd: number }>('SELECT volume_usd FROM bars_1m WHERE coin=$1', [binary(coin)])).rows).toEqual([{ volume_usd: 2000 }]);
  });
  it('prices pending ETH swaps at the reference rate of their block and USDG swaps at par, then refreshes candles', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
    for (const [c, launchpad] of [[coin, 'pons'], [other, null]] as const)
      await db.insert('tokens', { address: binary(c), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad, first_block: '1', block: '1' });
    await db.insert('eth_usd_reference_sources', { block: '10', pool_id: binary(pool), venue: 'uniswap_v3', fee: 100 });
    // Reference swaps: 2,000 then 3,000 USDG per WETH.
    await swap(db, 10, weth, usdg, '1', { venue: 'uniswap_v3', price_quote: 2000, pricing_pending: false });
    await swap(db, 30, weth, usdg, '1', { venue: 'uniswap_v3', price_quote: 3000, pricing_pending: false });
    await swap(db, 5, coin, native, '1000000000000000000');              // before any reference: stays unpriced
    await swap(db, 20, coin, native, '1000000000000000000');             // 1 ETH at 2,000
    await swap(db, 40, coin, native, '500000000000000000');              // 0.5 ETH at 3,000
    await swap(db, 41, coin, usdg, '25000000', { pricing_pending: false }); // 25 USDG
    await swap(db, 42, other, native, '1000000000000000000');            // not a Pons coin
    expect(await repricePonsSwaps(db, assets, new Date(now - 200 * 60_000), new Date(now), undefined, candleFloor)).toBe(3);
    expect(await priced(db)).toEqual([
      { block: '5', usd: null, pending: true, priced_block: null },
      { block: '20', usd: 2000, pending: false, priced_block: '10' },
      { block: '40', usd: 1500, pending: false, priced_block: '30' },
      { block: '41', usd: 25, pending: false, priced_block: '41' },
      { block: '42', usd: null, pending: true, priced_block: null },
    ]);
    const bars = (await db.sql.query<{ volume: number }>('SELECT sum(volume_usd) AS volume FROM bars_1m WHERE coin=$1', [binary(coin)])).rows[0];
    expect(Number(bars.volume)).toBe(3525);
    expect(await repricePonsSwaps(db, assets, new Date(now - 200 * 60_000), new Date(now), undefined, candleFloor)).toBe(0);
  });
  it('uses the retained reference price after the last old reference swap is gone',async()=>{
    const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);await migrateEngines(db);
    await db.insert('tokens',{address:binary(coin),deployer:binary(other),decimals:18,launchpad:'pons',first_block:1,block:1});
    await db.insert('eth_usd_reference_sources',{block:10,pool_id:binary(pool),venue:'uniswap_v3',fee:100});
    await db.sql.query('INSERT INTO reference_price_baselines VALUES($1,$2,$3,10,0,2000)',[binary(pool),binary(weth),binary(usdg)]);
    await swap(db,20,coin,native,'1000000000000000000');
    expect(await repricePonsSwaps(db,assets,new Date(now-200*60000),new Date(now),undefined,candleFloor)).toBe(1);
    expect(await priced(db)).toEqual([{block:'20',usd:2000,pending:false,priced_block:'10'}]);
  });
  it('resumes an hour the budget cut short instead of skipping it', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now - 30 * 3_600_000));
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
    // Twelve USDG swaps one hour apart from twenty hours ago: beyond the six recent hours, in the backfill.
    for (let i = 0; i < 12; i++) await db.insert('swaps', { ts: new Date(now - (20 - i * 0.1) * 3_600_000), block: String(10 + i), tx_hash: binary(hash(500 + i)), log_index: 0,
      venue: 'uniswap_v3', pool_id: binary(pool), coin: binary(coin), quote_asset: binary(usdg), trader: null, tx_from: null, tx_to: null, senders_pending: false, side: 1,
      amount_coin: '1000000000000000000', amount_quote: '1000000', price_quote: 1, usd: null, priced_block: null, pricing_pending: false });
    // Each clock read advances 10 s against a 100 s budget: a pass checks the six recent hours, then prices about three
    // batches of two, so an hour of ten swaps spans passes.
    let clock = now;
    const worker = new PricingRepairWorker(db, () => undefined, () => (clock += 10_000), 30_000, 100_000, assets, 2);
    for (let pass = 0; pass < 40; pass++) await worker.tick();
    expect((await db.sql.query('SELECT 1 FROM swaps WHERE usd IS NULL')).rows).toHaveLength(0);
  });
  it('re-tags a non-native curve pair recorded as ETH and prices pair-token quotes from the pair token itself', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
    const stock = address(0x5a), curve = address(0xc1), stockCoin = address(0xa2);
    for (const [c, launchpad] of [[coin, 'pons'], [stockCoin, 'pons'], [stock, null]] as const)
      await db.insert('tokens', { address: binary(c), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad, first_block: '1', block: '1' });
    // coin's curve pairs with USDG; stockCoin's curve pairs with a stock token that trades at 150 USD.
    for (const [c, pair] of [[coin, usdg], [stockCoin, stock]] as const) await db.insert('pons_events', { block: '1', tx_hash: binary(hash(9000 + Number(BigInt(c)))), log_index: 0,
      token: binary(c), emitter: binary(curve), kind: 'launch', data: JSON.stringify({ kind: 'launch', token: c, curve: c === coin ? curve : address(0xc2), pairToken: pair }) });
    await swap(db, 10, stock, usdg, '150000000', { venue: 'uniswap_v3', amount_coin: '1000000000000000000', price_quote: 150, usd: 150, pricing_pending: false });
    await swap(db, 20, coin, native, '25000000', { pool_id: binary(curve), price_quote: 1e-11, usd: 0.00000005, pricing_pending: false });   // recorded as ETH
    await swap(db, 21, stockCoin, stock, '2000000000000000000', { pool_id: binary(address(0xc2)), pricing_pending: false });                 // 2 stock tokens
    expect(await retagPairQuotes(db)).toBe(1);expect(await retagPairQuotes(db)).toBe(0);
    expect(await repricePonsSwaps(db, assets, new Date(now - 200 * 60_000), new Date(now), undefined, candleFloor)).toBe(2);
    const rows = (await db.sql.query<{ block: string; quote: Uint8Array; usd: number }>('SELECT block::text,quote_asset AS quote,usd FROM swaps WHERE block IN (20,21) ORDER BY swaps.block')).rows;
    expect(rows.map(r => [r.block, `0x${Buffer.from(r.quote).toString('hex')}`, r.usd])).toEqual([['20', usdg, 25], ['21', stock, 300]]);
  });
  it('prices swaps quoted in a token with no indexed price at its pool price, once per token and hour', async () => {
    // Robinhood stock tokens trade in Uniswap v3 USDG pools that are not indexed, so their curves' swaps had no USD.
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
    const stock = address(0x5c), indexed = address(0x5d), unknown = address(0x5e);
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
    for (const t of [stock, indexed, unknown]) await db.insert('tokens', { address: binary(t), name: 'Stock', symbol: 'DEMO', decimals: 18, first_block: '1', block: '1' });
    // `indexed` has its own priced swap; `stock` and `unknown` have none.
    await swap(db, 50, indexed, usdg, '250000000', { venue: 'uniswap_v3', usd: 250, pricing_pending: false, amount_coin: '1000000000000000000' });
    await swap(db, 60, coin, stock, '2000000000000000000', { pricing_pending: false });   // 2 shares
    await swap(db, 61, coin, stock, '1000000000000000000', { pricing_pending: false });   // 1 share, same hour
    await swap(db, 62, coin, indexed, '1000000000000000000', { pricing_pending: false }); // left to repricePonsSwaps
    await swap(db, 63, coin, unknown, '1000000000000000000', { pricing_pending: false }); // no pool: stays unpriced
    const reads: string[] = [];
    const spot = async (token: string, decimals: number, block: bigint) => { reads.push(`${token}:${decimals}:${block}`); return token === stock ? 26.5 : null; };
    const prices = new Map<string, number | null>(), from = new Date(now - 200 * 60_000), to = new Date(now);
    expect(await repricePoolQuotes(db, assets, spot, from, to, prices, candleFloor)).toEqual({ priced: 2, reads: 2 });
    // One read per token and hour, at the hour's first such swap.
    expect(reads.sort()).toEqual([`${stock}:18:60`, `${unknown}:18:63`].sort());
    const rows = new Map((await priced(db)).map(r => [r.block, r]));
    expect(rows.get('60')).toMatchObject({ usd: 53, pending: false, priced_block: '60' });
    expect(rows.get('61')).toMatchObject({ usd: 26.5, priced_block: '60' });
    expect(rows.get('62')!.usd).toBeNull(); expect(rows.get('63')!.usd).toBeNull();
    // Kept readings are not read again.
    expect(await repricePoolQuotes(db, assets, spot, from, to, prices, candleFloor)).toEqual({ priced: 0, reads: 0 });
  });
  it('fills a quiet pair token\'s missing decimals, prices its own swaps, then the curve swaps quoted in it', async () => {
    // 38 of 65 pair tokens had no decimals on 2026-10-12 (the indexer reads them only when the curve trades again).
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
    const pair = address(0x6a);
    await db.insert('tokens', { address: binary(coin), name: 'Sample token', symbol: 'DEMO', decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
    await db.insert('tokens', { address: binary(pair), first_block: '1', block: '1' });
    await db.insert('pons_events', { block: '1', tx_hash: binary(hash(9999)), log_index: 0, token: binary(coin), emitter: binary(address(0x99)), kind: 'launch',
      data: JSON.stringify({ kind: 'launch', token: coin, curve: address(0x98), pairToken: pair }) });
    await swap(db, 60, pair, usdg, '3000000', { venue: 'uniswap_v4', amount_coin: '1000000000000000000' }); // the pair at $3
    await swap(db, 70, coin, pair, '2000000000000000000', { pricing_pending: false });                       // 2 pair tokens
    const asked: string[] = [];
    const worker = new PricingRepairWorker(db, () => {}, () => now, 30_000, 28_000, assets, undefined, undefined,
      async token => { asked.push(token); return { decimals: 18, symbol: 'PAIR', name: 'Pair token' }; });
    await worker.tick();
    expect(asked).toEqual([pair]);
    expect((await db.sql.query<{ decimals: number; symbol: string }>('SELECT decimals,symbol FROM tokens WHERE address=$1', [binary(pair)])).rows[0]).toEqual({ decimals: 18, symbol: 'PAIR' });
    const rows = (await db.sql.query<{ block: string; usd: number | null }>('SELECT block::text,usd FROM swaps ORDER BY swaps.block')).rows;
    expect(rows).toEqual([{ block: '60', usd: 3 }, { block: '70', usd: 6 }]);
    // A token with decimals already is not read again.
    await worker.tick(); expect(asked).toEqual([pair]);
  });
});
