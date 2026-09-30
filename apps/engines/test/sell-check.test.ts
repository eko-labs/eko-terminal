import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { balanceKey, loadRegistry, probeAbi, v4PoolId, v4ProbeAbi, RpcGuardError, type SellRpc } from '@eko/chain';
import type { Address } from '@eko/shared';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, pad, parseAbi, toHex, zeroAddress, type Hex } from 'viem';
import { SellChecker, SellCheckScheduler, indexedEthUsd, readSellChecks, recordSellRefusal, sellRefusalTotals, sellRoute, usdToUnits, usdToWei } from '../src/sell-check.js';

// Synthetic indexed rows and a synthetic RPC only: no live chain data or network calls.
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const registry = loadRegistry();
const weth = registry.requireAddress('tokens.WETH').toLowerCase() as Address, usdg = registry.requireAddress('tokens.USDG').toLowerCase() as Address;
const curveCoin = address(1), curve = address(2), v3Coin = address(3), v3Pool = address(4), graduated = address(5), oldCurve = address(6), usdgCoin = address(7), fresh = address(8), hook = address(9);
const key = { currency0: zeroAddress, currency1: getAddress(graduated), fee: 10000, tickSpacing: 200, hooks: getAddress(hook) };
const poolId = v4PoolId(key);
const epoch = Date.parse('2026-10-01T00:00:00Z');
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
let tx = 1;
async function seed() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch));
  const token = (a: Address, launchpad: string, c: Address | null, block: number, extra: Record<string, unknown> = {}) =>
    db.insert('tokens', { address: binary(a), deployer: binary(address(99)), curve: c ? binary(c) : null, launchpad, name: 'Sample', symbol: 'DEMO', decimals: 18, first_block: String(block), block: String(block), ...extra });
  await token(curveCoin, 'pons', curve, 10); await token(v3Coin, 'other', null, 10); await token(usdgCoin, 'other', null, 10);
  await token(graduated, 'pons', oldCurve, 10, { graduated_block: '50', graduated_pool: binary(poolId) }); await token(fresh, 'pons', address(10), 990);
  for (const [n, sec] of [[10, 0], [50, 400], [990, 3590], [1000, 3600]] as const)
    await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) VALUES($1,$2,$3,'fixture')", [n, new Date(epoch + sec * 1000), binary(`0x${n.toString(16).padStart(64, '0')}`)]);
  await db.sql.query("INSERT INTO ingest_cursors(stream,block,hash) VALUES('head',1000,NULL)");
  await db.insert('pools', { id: binary(v3Pool), venue: 'uniswap_v3', currency0: binary(v3Coin), currency1: binary(weth), fee: 3000, tick_spacing: 60, creation_verified: true, created_block: '10', block: '10' });
  await db.insert('pools', { id: binary(address(11)), venue: 'uniswap_v3', currency0: binary(usdgCoin), currency1: binary(usdg), fee: 3000, tick_spacing: 60, creation_verified: true, created_block: '10', block: '10' });
  await db.insert('pools', { id: binary(poolId), venue: 'uniswap_v4', currency0: binary(zeroAddress), currency1: binary(graduated), fee: 10000, tick_spacing: 200, hooks: binary(hook), creation_verified: true, created_block: '50', block: '50' });
  for (const coin of [curveCoin, v3Coin, usdgCoin, graduated, fresh])
    await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad) VALUES($1,2,$2,10,'new',10,'pons')", [binary(coin), new Date(epoch + 3000_000)]);
  return db;
}
// ETH-quoted swaps priced by the indexer at $2,000 per ETH (one ETH in, $2,000 out).
async function ethSwap(db: ChainDb, sec: number, usd = 2000, coin = curveCoin) {
  await db.insert('swaps', { ts: new Date(epoch + sec * 1000), block: String(sec), tx_hash: binary(`0x${(tx++).toString(16).padStart(64, '0')}`), log_index: 0, venue: 'pons_curve', pool_id: binary(curve),
    coin: binary(coin), quote_asset: binary(zeroAddress), trader: binary(address(98)), side: 1, amount_coin: '1000', amount_quote: (10n ** 18n).toString(), price_quote: 1, usd });
}
const out = (tokens: bigint, returned: bigint, spent: bigint, buyOk = true, sellOk = true) => encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }], [tokens, returned, returned, spent, buyOk, sellOk, '0x']);
type Outcome = 'sellable' | 'honeypot' | 'down';
/** Decodes which coin the probe trades and answers with that coin's synthetic outcome. */
function chain(outcomes: Record<string, Outcome>) {
  const request = vi.fn(async ({ params }: { method: string; params: readonly unknown[] }) => {
    const { data, value } = { data: (params[0] as { data: Hex }).data, value: 0n };
    if (params.length < 3) return encodeAbiParameters([{ type: 'uint256' }], [10n ** 30n]);
    let coin: string, size: bigint;
    try { const call = decodeFunctionData({ abi: probeAbi, data }); if (call.functionName !== 'roundTrip') throw new Error(); coin = call.args[0]; size = call.args[2].value; }
    catch { const call = decodeFunctionData({ abi: v4ProbeAbi, data }); coin = call.args[2].currency1; size = call.args[4]; }
    void value;
    const outcome = outcomes[coin.toLowerCase()];
    if (outcome === 'down' || !outcome) throw new Error('synthetic provider failure');
    return outcome === 'sellable' ? out(10n ** 21n, size * 9n / 10n, size) : out(10n ** 21n, 0n, size, true, false);
  });
  return { request } satisfies SellRpc & { request: typeof request };
}

describe('live sell checks (indexed routes, synthetic probe outputs)', () => {
  it('routes a curve before graduation, the graduated v4 pool after it, and native v3 pools; others are unsupported', async () => {
    const db = await seed();
    expect(await sellRoute(db, curveCoin, 1000)).toEqual({ venue: 'pons_curve', coin: getAddress(curveCoin), curve: getAddress(curve) });
    expect(await sellRoute(db, graduated, 1000)).toMatchObject({ venue: 'uniswap_v4', poolId, key, hookData: '0x' });
    expect(await sellRoute(db, graduated, 40)).toMatchObject({ venue: 'pons_curve', curve: getAddress(oldCurve) });
    expect(await sellRoute(db, v3Coin, 1000)).toMatchObject({ venue: 'uniswap_v3', pool: getAddress(v3Pool), fee: 3000, weth: getAddress(weth) });
    expect(await sellRoute(db, usdgCoin, 1000)).toBeNull();
    expect(await sellRoute(db, address(77), 1000)).toBeNull();
    // With several native pools, the one with the most recent USD volume wins over the newest.
    const busy = address(12);
    await db.insert('pools', { id: binary(busy), venue: 'uniswap_v3', currency0: binary(v3Coin), currency1: binary(weth), fee: 10000, tick_spacing: 200, creation_verified: true, created_block: '5', block: '5' });
    await db.insert('swaps', { ts: new Date(epoch + 3000_000), block: '900', tx_hash: binary(`0x${(tx++).toString(16).padStart(64, '0')}`), log_index: 0, venue: 'uniswap_v3', pool_id: binary(busy),
      coin: binary(v3Coin), quote_asset: binary(weth), trader: binary(address(98)), side: 1, amount_coin: '1000', amount_quote: '1', price_quote: 1, usd: 5000 });
    expect(await sellRoute(db, v3Coin, 1000)).toMatchObject({ venue: 'uniswap_v3', pool: getAddress(busy), fee: 10000 });
  });
  it('sizes with the indexed ETH-USD of recent ETH-quoted swaps, never a default price', async () => {
    const db = await seed();
    expect(await indexedEthUsd(db, epoch + 3600_000)).toBeNull();
    for (const [sec, usd] of [[3000, 1900], [3100, 2000], [3200, 2100], [100, 9999]] as const) await ethSwap(db, sec, usd);
    expect(await indexedEthUsd(db, epoch + 3600_000)).toBe(2000);
    expect(usdToWei(1000, 2000)).toBe(5n * 10n ** 17n);
    expect(() => usdToWei(1000, 0)).toThrow();
  });
  it('checks due coins at the indexed head, stores readings and evidence, and skips coins younger than the minimum age', async () => {
    const db = await seed(); await ethSwap(db, 3500);
    let now = epoch + 3600_000;
    const rpc = chain({ [curveCoin]: 'sellable', [v3Coin]: 'honeypot', [graduated]: 'sellable' });
    const scheduler = new SellCheckScheduler(db, new SellChecker(db, rpc, { now: () => now }));
    expect(await scheduler.tick()).toBe(4);
    const latest = new Map((await db.sql.query<{ coin: Uint8Array; status: string; block: string; exit_cost_100_pct: number | null; exit_cost_1k_pct: number | null; venue: string | null }>(
      'SELECT coin,status,block,exit_cost_100_pct,exit_cost_1k_pct,venue FROM sell_check_latest')).rows.map(r => [`0x${Buffer.from(r.coin).toString('hex')}`, { ...r, block: Number(r.block) }]));
    expect(latest.get(curveCoin)).toMatchObject({ status: 'sellable', block: 1000, exit_cost_100_pct: 10, exit_cost_1k_pct: 10, venue: 'pons_curve' });
    expect(latest.get(graduated)).toMatchObject({ status: 'sellable', venue: 'uniswap_v4' });
    expect(latest.get(v3Coin)).toMatchObject({ status: 'refused', exit_cost_1k_pct: 100, venue: 'uniswap_v3' });
    expect(latest.get(usdgCoin)).toMatchObject({ status: 'unsupported', exit_cost_1k_pct: null, venue: null });
    expect(latest.has(fresh)).toBe(false);
    // Each size is one eth_call at the head block; the refused curve-free coin needed no capacity read.
    expect(rpc.request).toHaveBeenCalledTimes(6);
    expect(rpc.request.mock.calls.every(([r]) => r.method === 'eth_call' && r.params[1] === '0x3e8')).toBe(true);
    expect(Number((await db.sql.query<{ n: string }>('SELECT sum(requests) AS n FROM sell_check_runs')).rows[0]!.n)).toBe(6);
    // Nothing is due again until there is new activity past the minimum interval.
    expect(await scheduler.tick()).toBe(0);
    now += 30_000; expect(await scheduler.tick()).toBe(1);
    await db.sql.query('UPDATE read_coins SET activity=$1 WHERE coin=$2', [new Date(now), binary(curveCoin)]);
    expect(await scheduler.tick()).toBe(0);
    now += 601_000; expect((await scheduler.due(now)).map(d => d.coin)).toEqual([curveCoin]);
  });
  it('keeps the earlier reading through a provider failure on the same route, and reads only measured, recent readings', async () => {
    const db = await seed(); await ethSwap(db, 3500);
    let now = epoch + 3600_000, outcome: Outcome = 'sellable';
    const rpc = { request: vi.fn((r: { method: string; params: readonly unknown[] }) => chain({ [curveCoin]: outcome }).request(r)) };
    const checker = new SellChecker(db, rpc, { now: () => now });
    const scheduler = new SellCheckScheduler(db, checker, { minIntervalSec: 600 });
    await scheduler.tick();
    outcome = 'down'; now += 700_000;
    await db.sql.query('UPDATE read_coins SET activity=$1 WHERE coin=$2', [new Date(now - 1000), binary(curveCoin)]);
    await scheduler.tick();
    const row = (await db.sql.query<{ status: string; attempt_status: string; checked_at: Date }>('SELECT status,attempt_status,checked_at FROM sell_check_latest WHERE coin=$1', [binary(curveCoin)])).rows[0]!;
    expect(row).toMatchObject({ status: 'sellable', attempt_status: 'unavailable' });
    expect(new Date(row.checked_at).getTime()).toBe(epoch + 3600_000);
    const readings = await readSellChecks(db, [curveCoin, v3Coin, usdgCoin], now);
    expect([...readings.keys()]).toEqual([curveCoin]);
    expect(readings.get(curveCoin)).toMatchObject({ status: 'sellable', exit100: 10, exit1k: 10, block: 1000, venue: 'pons_curve' });
    expect((await readSellChecks(db, [curveCoin], now + 49 * 3600_000)).size).toBe(0);
  });
  it('stops at the daily request cap and pauses for the day when the RPC budget is exhausted', async () => {
    const db = await seed(); await ethSwap(db, 3500);
    const now = epoch + 3600_000, rpc = chain({ [curveCoin]: 'sellable', [v3Coin]: 'sellable', [graduated]: 'sellable' });
    expect(await new SellCheckScheduler(db, new SellChecker(db, rpc, { now: () => now }), { parallel: 1, dailyRequests: 7 }).tick()).toBe(2);
    const log = vi.fn();
    const exhausted = new SellCheckScheduler(db, new SellChecker(db, { request: async () => { throw new RpcGuardError('rpc_budget_exhausted'); } }, { now: () => now }), {}, log);
    const run = exhausted.run(10);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('sell_check_paused', { reason: 'rpc_budget_exhausted' }));
    exhausted.stop(); await run;
    expect(await exhausted.tick()).toBe(0);
  });
  it('counts refused quotes per coin, today and per hour', async () => {
    const db = await seed();
    const now = epoch + 5 * 3600_000 + 600_000;
    const result = await new SellChecker(db, chain({ [v3Coin]: 'honeypot' }), { now: () => now }).check(v3Coin, 1000, [250], 2000);
    expect(result).toMatchObject({ status: 'refused', exit100: null, exit1k: null, requests: 1, ethUsd: 2000 });
    // Repeated refusals of one coin count once; a refusal from yesterday never counts today.
    for (const offset of [0, 60_000]) await recordSellRefusal(db, result, new Date(now - offset), 250);
    await recordSellRefusal(db, { ...result, coin: curveCoin }, new Date(now - 2 * 3600_000), 250);
    await recordSellRefusal(db, { ...result, coin: graduated }, new Date(epoch - 3600_000), 250);
    const totals = await sellRefusalTotals(db, now + 1000);
    expect(totals.today).toBe(2);
    expect(totals.byHour).toHaveLength(24);
    expect(totals.byHour[23]).toBe(1);
    expect(totals.byHour[21]).toBe(1);
    expect(totals.byHour.reduce((a, b) => a + b, 0)).toBe(3);
  });
  it('probes a curve paired with a token in that token: $100 and $1,000 at its USD price, through its balance slot found once', async () => {
    const db = await seed();
    const paired = address(13), pairedCurve = address(14), stock = address(15), unpriced = address(16), stockCurve = address(17), unpricedCurve = address(18), unpricedCoin = address(19);
    const token = (a: Address, c: Address) => db.insert('tokens', { address: binary(a), deployer: binary(address(99)), curve: binary(c), launchpad: 'pons', name: 'Sample', symbol: 'DEMO', decimals: 18, first_block: '10', block: '10' });
    await token(paired, pairedCurve); await token(stockCurve, address(20)); await token(unpricedCoin, unpricedCurve);
    await db.insert('tokens', { address: binary(stock), deployer: binary(address(99)), launchpad: 'other', name: 'Stock', symbol: 'DEMO', decimals: 18, first_block: '10', block: '10' });
    await db.insert('tokens', { address: binary(unpriced), deployer: binary(address(99)), launchpad: 'other', name: 'Stock', symbol: 'DEMO', decimals: 18, first_block: '10', block: '10' });
    const launch = (coin: Address, c: Address, pair: Address) => db.insert('pons_events', { block: '10', tx_hash: binary(`0x${(tx++).toString(16).padStart(64, '0')}`), log_index: 0, token: binary(coin),
      emitter: binary(address(97)), kind: 'launch', data: JSON.stringify({ curve: c, pairToken: pair }) });
    await launch(paired, pairedCurve, usdg); await launch(stockCurve, address(20), stock); await launch(unpricedCoin, unpricedCurve, unpriced);
    // The stock token's own swaps price it at $250.
    await db.insert('swaps', { ts: new Date(epoch + 3500_000), block: '990', tx_hash: binary(`0x${(tx++).toString(16).padStart(64, '0')}`), log_index: 0, venue: 'uniswap_v3', pool_id: binary(address(21)),
      coin: binary(stock), quote_asset: binary(usdg), trader: binary(address(98)), side: 1, amount_coin: (4n * 10n ** 18n).toString(), amount_quote: '1000000000', price_quote: 250, usd: 1000 });
    expect(await sellRoute(db, paired, 1000)).toEqual({ venue: 'pons_curve', coin: getAddress(paired), curve: getAddress(pairedCurve), pair: { token: getAddress(usdg) } });
    // Synthetic chain: both pair tokens keep balances in a Solidity mapping at slot 1; every round trip returns 98.01%.
    const tripAbi = parseAbi(['struct Trip { address pair; address token; address curve; uint256 amountIn; bytes buyData; bytes sellData; }', 'function roundTrip(Trip trip)']);
    const sizes: { pair: string; amount: bigint }[] = [];
    // The only Uniswap v3 USDG pool is the pool-priced pair's (fee 3000), at $50 a share (18 decimals against USDG's 6).
    const v3 = parseAbi(['function getPool(address,address,uint24) view returns (address)', 'function liquidity() view returns (uint128)',
      'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)']);
    const spotPool = address(25), poolPriced = address(24), sqrt = BigInt(Math.round(Math.sqrt(50 * 1e6 / 1e18) * 2 ** 96));
    const request = vi.fn(async ({ params }: { method: string; params: readonly unknown[] }) => {
      const [call, , overrides] = params as [{ to: Address; data: Hex }, Hex, Record<string, { stateDiff?: Record<Hex, Hex> }> | undefined];
      if (call.data.startsWith(encodeFunctionData({ abi: v3, functionName: 'getPool', args: [zeroAddress, zeroAddress, 0] }).slice(0, 10))) {
        const [token, , fee] = decodeFunctionData({ abi: v3, data: call.data }).args as [Address, Address, number];
        return pad(token.toLowerCase() === poolPriced && fee === 3000 ? spotPool : zeroAddress);
      }
      if (call.to.toLowerCase() === spotPool) return call.data.startsWith(encodeFunctionData({ abi: v3, functionName: 'liquidity' }))
        ? pad(toHex(10n ** 18n)) : encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }], [sqrt, 0, 0, 0, 0, 0, true]);
      if (call.data.startsWith('0x70a08231')) {
        const holder = `0x${call.data.slice(34)}` as Address;
        return overrides?.[call.to]?.stateDiff?.[balanceKey({ layout: 'solidity', slot: 1 }, holder)] ?? pad(toHex(0n));
      }
      const [trip] = decodeFunctionData({ abi: tripAbi, data: call.data }).args;
      sizes.push({ pair: trip.pair.toLowerCase(), amount: trip.amountIn });
      expect(overrides![trip.pair]!.stateDiff![balanceKey({ layout: 'solidity', slot: 1 }, call.to)]).toBe(pad(toHex(trip.amountIn * 2n)));
      return out(10n ** 21n, trip.amountIn * 9801n / 10000n, trip.amountIn);
    });
    // A layout lookup the provider fails is unavailable (retried soon), not unsupported, and is not remembered.
    let down = true;
    const checker = new SellChecker(db, { request: async (input: { method: string; params: readonly unknown[] }) => { if (down) throw new Error('synthetic provider failure'); return request(input); } },
      { now: () => epoch + 3600_000 });
    expect(await checker.check(paired, 1000, [100, 1000], 2000)).toMatchObject({ status: 'unavailable', requests: 1 });
    down = false;
    const first = await checker.check(paired, 1000, [100, 1000], 2000);
    expect(first).toMatchObject({ status: 'sellable', pairUsd: 1, exit100: 1.99, exit1k: 1.99, route: { pair: { token: getAddress(usdg), balance: { layout: 'solidity', slot: 1 } } } });
    // Three layouts tried (ERC-7201, then Solidity slots 0 and 1), then one call per size.
    expect(first.requests).toBe(3 + 2);
    expect(sizes.splice(0)).toEqual([{ pair: usdg, amount: 100_000_000n }, { pair: usdg, amount: 1_000_000_000n }]);
    // The USDG layout is not looked up again; the stock token's is, and $100 is 0.4 of a share at $250.
    expect((await checker.check(paired, 1000, [100], 2000)).requests).toBe(1);
    const stockCheck = await checker.check(stockCurve, 1000, [100], 2000);
    expect(stockCheck).toMatchObject({ status: 'sellable', pairUsd: 250, requests: 3 + 1 });
    expect(sizes.at(-1)).toEqual({ pair: stock, amount: 4n * 10n ** 17n });
    // A pair token with neither indexed swaps nor a v3 USDG pool cannot be sized: unsupported after the four pool lookups.
    const calls = request.mock.calls.length;
    expect(await checker.check(unpricedCoin, 1000, [100, 1000], 2000)).toMatchObject({ status: 'unsupported', requests: 4, probes: [] });
    expect(request.mock.calls.length).toBe(calls + 4);
    // A stock token without indexed swaps is sized at its v3 USDG pool's price ($100 is two shares at $50), kept ten minutes.
    const poolCoin = address(26), poolCurve = address(27);
    await token(poolCoin, poolCurve); await launch(poolCoin, poolCurve, poolPriced);
    await db.insert('tokens', { address: binary(poolPriced), deployer: binary(address(99)), launchpad: 'other', name: 'Stock', symbol: 'DEMO', decimals: 18, first_block: '10', block: '10' });
    const pooled = await checker.check(poolCoin, 1000, [100], 2000);
    expect(pooled).toMatchObject({ status: 'sellable', pairUsdSource: 'pool' }); expect(pooled.pairUsd).toBeCloseTo(50, 6);
    expect(sizes.at(-1)!.amount).toBeGreaterThan(2n * 10n ** 18n - 10n ** 9n); expect(sizes.at(-1)!.amount).toBeLessThan(2n * 10n ** 18n + 10n ** 9n);
    // Four fee tiers, one liquidity and one slot0 read, three layouts tried, one probe; then only the probe.
    expect(pooled.requests).toBe(4 + 2 + 3 + 1);
    expect((await checker.check(poolCoin, 1000, [100], 2000)).requests).toBe(1);
    expect(usdToUnits(100, 250, 18)).toBe(4n * 10n ** 17n); expect(usdToUnits(100, 0, 18)).toBeNull();
  });
  it('keeps old unsupported readings in cooldown across a restart', async () => {
    const db = await seed(); await ethSwap(db, 3500);
    const now = epoch + 3600_000;
    await db.sql.query("INSERT INTO sell_check_latest(coin,block,checked_at,activity_at,venue,route_id,status,method_version,data,attempted_at,attempt_status) VALUES($1,1000,$2,$2,NULL,NULL,'unsupported','sell-check-1','{}',$2,'unsupported')",
      [binary(usdgCoin), new Date(now - 60_000)]);
    const scheduler = new SellCheckScheduler(db, new SellChecker(db, chain({}), { now: () => now }));
    expect((await scheduler.due(now)).map(d => d.coin)).not.toContain(usdgCoin);
    // Restarting must not bypass the unsupported cooldown.
    await db.sql.query('UPDATE sell_check_latest SET attempted_at=$1 WHERE coin=$2', [new Date(now), binary(usdgCoin)]);
    expect((await scheduler.due(now)).map(d => d.coin)).not.toContain(usdgCoin);
  });
});
