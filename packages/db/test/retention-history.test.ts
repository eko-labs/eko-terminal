import { afterEach, describe, expect, it } from 'vitest';
import { binary, hex, migrate, migrateEngines, pruneSwaps, rebuildBalances, rebuildBars, refreshBars, runRetention, trendingAt, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

// Per-coin history retention: quiet Danger coins after two days, every quiet coin after eight. Days are counted from
// the fixture epoch; the pass runs on day 40.
const epoch = Date.parse('2026-08-01T00:00:00Z');
const DAY = 86_400_000, MINUTE = 60_000;
const at = (day: number) => new Date(epoch + day * DAY);
const now = () => epoch + 40 * DAY;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const zero = address(0), weth = address(0xee), deployer = address(0xde);
const holders = [address(0x11), address(0x12), address(0x13)];
const coins = { dead: address(0xa1), danger: address(0xa2), calm: address(0xa3), active: address(0xa4), unlabeled: address(0xa5), pending: address(0xa6), untraded: address(0xa7) };
const poolOf = (coin: `0x${string}`) => address(Number(BigInt(coin)) + 0x100);
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

let block = 0, event = 0;
/** The block at `day`: numbers follow time (a sparse chain), and the engines' clock mirrors the indexed headers. */
const blockOf = (day: number) => Math.round(day * 1000) + 1;
async function blockAt(db: ChainDb, day: number) {
  const n = blockOf(day);
  block = Math.max(block, n);
  await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: at(day) });
  await db.sql.query("INSERT INTO engine_block_times VALUES($1,$2,$3,'head') ON CONFLICT DO NOTHING", [n, at(day), binary(hash(n))]);
  return n;
}
async function token(db: ChainDb, coin: `0x${string}`, day: number) {
  const n = await blockAt(db, day);
  await db.insert('tokens', { address: binary(coin), deployer: binary(deployer), curve: null, name: 'Sample token', symbol: 'DEMO', launchpad: null,
    decimals: 0, total_supply: '3000', supply_block: String(n), first_block: String(n), block: String(n) });
  await db.insert('pools', { id: binary(poolOf(coin)), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(weth), fee: 3000, tick_spacing: 60,
    creation_verified: true, created_block: String(n), block: String(n) });
  for (const h of holders) await transfer(db, n, day, coin, zero, h, 1000);
  return n;
}
async function transfer(db: ChainDb, n: number, day: number, coin: `0x${string}`, from: `0x${string}`, to: `0x${string}`, amount: number) {
  await db.insert('token_transfers', { ts: at(day), block: String(n), tx_hash: binary(hash(++event)), log_index: 0, token: binary(coin),
    from_address: binary(from), to_address: binary(to), amount: String(amount) });
}
async function swap(db: ChainDb, n: number, day: number, coin: `0x${string}`, trader: `0x${string}`, side: 1 | -1, extra: Record<string, unknown> = {}) {
  await db.insertMany('swaps', [{ ts: at(day), block: String(n), tx_hash: binary(hash(++event)), log_index: 0, venue: 'uniswap_v3', pool_id: binary(poolOf(coin)),
    coin: binary(coin), quote_asset: binary(weth), trader: binary(trader), tx_from: binary(trader), tx_to: null, side, amount_coin: '100', amount_quote: '1',
    price_quote: 0.01, usd: 2, priced_block: String(n), ...extra }]);
  await db.tx(tx => refreshBars(tx, [{ coin: binary(coin), minute: new Date(Math.floor(at(day).getTime() / MINUTE) * MINUTE) }]));
}
async function liquidity(db: ChainDb, n: number, day: number, coin: `0x${string}`, actor: `0x${string}`, kind: string) {
  await db.insert('liquidity_events', { block: String(n), ts: at(day), tx_hash: binary(hash(++event)), log_index: 0, venue: 'uniswap_v3', pool_id: binary(poolOf(coin)),
    kind, actor: binary(actor), data: JSON.stringify({ owner: actor, amount: '10', tickLower: '-60', tickUpper: '60' }) });
}
async function pons(db: ChainDb, n: number, coin: `0x${string}`, kind: string) {
  await db.insert('pons_events', { block: String(n), tx_hash: binary(hash(++event)), log_index: 0, token: binary(coin), emitter: binary(address(0xfa)), kind, data: '{}' });
}
async function card(db: ChainDb, coin: `0x${string}`, level: string) {
  // A Danger card names its Danger playbooks (one listed twice, and a Monitor one that is not recorded).
  const playbooks = level === 'danger' ? [{ id: 'honeypot', level: 'danger' }, { id: 'wash_to_trend', level: 'monitor' }, { id: 'bundle_dump', level: 'danger' }, { id: 'honeypot', level: 'danger' }] : [];
  const data = JSON.stringify({ verdict: { level, playbooks } });
  await db.sql.query('INSERT INTO coin_cards VALUES($1,$2,$3,$4,$5,$6)', [`card:${coin}`, binary(coin), block, 'sample-hash', data, '1.0.0']);
  await db.sql.query('INSERT INTO coin_card_latest VALUES($1,$2,$3,$4) ON CONFLICT(coin) DO UPDATE SET data=excluded.data', [binary(coin), `card:${coin}`, block, data]);
}
async function outcomes(db: ChainDb, coin: `0x${string}`, horizons = ['1h', '24h', '7d']) {
  for (const horizon of horizons) await db.sql.query("INSERT INTO outcomes VALUES($1,$2,1,'rugged','{}')", [binary(coin), horizon]);
}
/** A coin traded from `from` to `to` (days): buys by two holders, one sell, holder transfers, LP and Pons events. */
async function traded(db: ChainDb, coin: `0x${string}`, from: number, to: number) {
  const n = await blockAt(db, from + 0.001);
  // Three swaps in one minute, so retention must delete them together.
  await swap(db, n, from + 0.001, coin, holders[0]!, 1); await swap(db, n, from + 0.001, coin, holders[1]!, 1); await swap(db, n, from + 0.001, coin, holders[0]!, -1);
  await liquidity(db, n, from + 0.001, coin, holders[2]!, 'Mint'); await liquidity(db, n, from + 0.001, coin, deployer, 'Mint');
  await pons(db, n, coin, 'launch'); await pons(db, n, coin, 'trade');
  const m = await blockAt(db, (from + to) / 2);
  await transfer(db, m, (from + to) / 2, coin, holders[0]!, holders[1]!, 7); await swap(db, m, (from + to) / 2, coin, holders[1]!, 1);
  // The deployer's liquidity removal stays: other launches of this deployer read it as a prior removal.
  const last = await blockAt(db, to);
  await liquidity(db, last, to, coin, deployer, 'Burn'); await transfer(db, last, to, coin, holders[1]!, holders[2]!, 3); await swap(db, last, to, coin, holders[1]!, -1);
}

async function fixture() {
  block = 0; event = 0;
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(at(0));
  await db.insert('tokens', { address: binary(weth), deployer: null, curve: null, name: 'Quote token', symbol: 'QUOTE', launchpad: null, decimals: 18,
    total_supply: null, supply_block: null, first_block: '0', block: '0' });
  await token(db, coins.dead, 0); await traded(db, coins.dead, 0, 3); await outcomes(db, coins.dead); await card(db, coins.dead, 'monitor');
  // Launched while the dead coin traded: its trending window reads the dead coin's first swaps.
  await token(db, coins.active, 0.01); await traded(db, coins.active, 0.02, 39.9); await outcomes(db, coins.active); await card(db, coins.active, 'clear');
  await token(db, coins.unlabeled, 0.5); await traded(db, coins.unlabeled, 0.6, 2); await outcomes(db, coins.unlabeled, ['1h']);
  await token(db, coins.pending, 0.7); await traded(db, coins.pending, 0.8, 2); await outcomes(db, coins.pending);
  await db.sql.query('UPDATE swaps SET senders_pending=true WHERE coin=$1 AND side=-1', [binary(coins.pending)]);
  await token(db, coins.untraded, 1);
  await token(db, coins.danger, 30); await traded(db, coins.danger, 30, 37); await outcomes(db, coins.danger); await card(db, coins.danger, 'danger');
  await token(db, coins.calm, 30); await traded(db, coins.calm, 30, 37); await outcomes(db, coins.calm); await card(db, coins.calm, 'monitor');
  await blockAt(db, 39.95);
  await db.tx(tx => rebuildBalances(tx));
  return db;
}
const counts = async (db: ChainDb, coin: `0x${string}`) => {
  const n = async (sql: string) => Number((await db.sql.query<{ n: string }>(sql, [binary(coin)])).rows[0]!.n);
  return { transfers: await n('SELECT count(*) AS n FROM token_transfers WHERE token=$1'), swaps: await n('SELECT count(*) AS n FROM swaps WHERE coin=$1'),
    liquidity: await n('SELECT count(*) AS n FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE p.currency0=$1'), pons: await n('SELECT count(*) AS n FROM pons_events WHERE token=$1'),
    bars: await n('SELECT count(*) AS n FROM bars_1m WHERE coin=$1') };
};
const table = async (db: ChainDb, sql: string) => (await db.sql.query(sql)).rows.map(row => JSON.stringify(row, (_, v) => v?.type === 'Buffer' ? hex(Buffer.from(v.data)) : v));
const kept = (db: ChainDb) => Promise.all(['balances', 'bars_1m', 'coin_card_latest', 'coin_cards', 'outcomes', 'pools', 'tokens', 'read_buyers', 'read_coins']
  .map(name => table(db, `SELECT * FROM ${name} ORDER BY 1,2`)));
const prune = async (db: ChainDb, coin: `0x${string}`) => (await db.sql.query<{ rule: string; through_block: string; swaps_through_block: string | null; first_trade_ts: Date | null;
  last_trade_ts: Date | null; buyers: string; transfers: string; swaps: string; liquidity: string; pons: string; verdict_level: string | null; danger_playbooks: string[] }>(`SELECT
  rule,through_block::text,swaps_through_block::text,first_trade_ts,last_trade_ts,buyers::text,transfers::text,swaps::text,liquidity::text,pons::text,verdict_level,danger_playbooks
  FROM history_prunes WHERE coin=$1`, [binary(coin)])).rows[0];
const refreshReads = (db: ChainDb) => db.sql.query('SELECT refresh_read_models($1::bytea[],$2::bigint)', [Object.values(coins).map(binary), Math.floor(now() / 1000)]);

describe('per-coin history retention', () => {
  it('drops raw history of quiet and quiet Danger coins, keeps their summaries, and leaves every other coin alone', async () => {
    const db = await fixture();
    await refreshReads(db);
    const before = Object.fromEntries(await Promise.all(Object.entries(coins).map(async ([k, c]) => [k, await counts(db, c)])));
    const summaries = await kept(db);
    const trending = await trendingAt(db, blockOf(0.01), (at(0.01).getTime() / 1000) - 3600);
    expect(trending.map(r => r.coin)).toContain(coins.dead);
    const result = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], dangerQuietDays: 2, quietCoinDays: 8, batchRows: 2, now });
    expect(result).toMatchObject({ finished: true, dangerCoins: 1, quietCoins: 2 });
    // Dead for 37 days: transfers rolled into baselines, liquidity, Pons and swaps gone, except the deployer's removal.
    expect(await counts(db, coins.dead)).toEqual({ transfers: 0, swaps: 0, liquidity: 1, pons: 0, bars: before.dead.bars });
    expect(await prune(db, coins.dead)).toMatchObject({ rule: 'quiet_coin', verdict_level: 'monitor', danger_playbooks: [], buyers: '2', transfers: String(before.dead.transfers), swaps: String(before.dead.swaps),
      liquidity: '2', pons: '2', first_trade_ts: at(0.001), last_trade_ts: at(3) });
    expect((await prune(db, coins.dead))!.swaps_through_block).not.toBeNull();
    // Danger and quiet for three days: transfers, events and swaps pass the one-day floor.
    expect(await counts(db, coins.danger)).toEqual({ ...before.danger, transfers: 0, swaps: 0, liquidity: 1, pons: 0 });
    // The verdict at prune time is recorded: Danger, with its Danger playbooks.
    expect(await prune(db, coins.danger)).toMatchObject({ rule: 'danger_quiet', verdict_level: 'danger', danger_playbooks: ['bundle_dump', 'honeypot'] });
    expect((await prune(db, coins.danger))!.swaps_through_block).not.toBeNull();
    // Never traded, so its outcomes are decided without labels: only its mint transfers existed.
    expect(await counts(db, coins.untraded)).toMatchObject({ transfers: 0, swaps: 0 });
    expect(await prune(db, coins.untraded)).toMatchObject({ verdict_level: null, danger_playbooks: [] });
    // Untouched: a Monitor coin quiet for three days, an active coin, a coin with an unlabeled 24h outcome and a coin
    // with a swap still waiting for sender enrichment.
    for (const coin of ['calm', 'active', 'unlabeled', 'pending'] as const) {
      expect(await counts(db, coins[coin])).toEqual(before[coin]);
      expect(await prune(db, coins[coin])).toBeUndefined();
    }
    // Summaries are intact: balances, minute bars, cards, outcomes, pools, tokens and the read models (buyers and last
    // trade of the pruned coins included).
    await db.tx(tx => rebuildBalances(tx)); await refreshReads(db);
    expect(await kept(db)).toEqual(summaries);
    // A rebuild of every bar (as after a reorg) keeps the pruned coins' bars instead of rebuilding them from nothing.
    await db.tx(tx => rebuildBars(tx, 0n, BigInt(block)));
    expect(await kept(db)).toEqual(summaries);
    // The trending list a later launch read from the dead coin's swaps was saved before they went.
    expect(result.trendingSnapshots).toBeGreaterThan(0);
    expect(await trendingAt(db, blockOf(0.01), (at(0.01).getTime() / 1000) - 3600)).toEqual(trending);
    // Nothing is left to do on the next pass.
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], dangerQuietDays: 2, quietCoinDays: 8, now })).toMatchObject({ finished: true, dangerCoins: 0, quietCoins: 0,
      historyTransfers: 0, historyLiquidity: 0, historyPons: 0, historySwaps: 0 });
    // A Danger rating survives a later prune made under a weaker card, and Danger playbooks accumulate.
    await db.sql.query(`UPDATE coin_card_latest SET data='{"verdict":{"level":"monitor","playbooks":[{"id":"fee_trap_pool","level":"danger"}]}}' WHERE coin=$1`, [binary(coins.danger)]);
    await pons(db, blockOf(37), coins.danger, 'trade');
    await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], quietCoinDays: 8, now: () => epoch + 46 * DAY });
    expect(await counts(db, coins.danger)).toMatchObject({ pons: 0 });
    expect(await prune(db, coins.danger)).toMatchObject({ rule: 'danger_quiet', verdict_level: 'danger', danger_playbooks: ['bundle_dump', 'fee_trap_pool', 'honeypot'] });
  });

  it('stops at its time budget and finishes over later passes with the same result', async () => {
    const full = await fixture();
    await runRetention(full, { dryRun: false, pauseMs: 0, quoteTokens: [weth], dangerQuietDays: 2, quietCoinDays: 8, now });
    const expected = await Promise.all(Object.values(coins).map(c => counts(full, c)));
    const db = await fixture();
    let clock = now(), passes = 0;
    for (;;) {
      passes++;
      const result = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], dangerQuietDays: 2, quietCoinDays: 8, batchRows: 1, budgetMs: 10, now: () => (clock += 1) });
      clock = now();
      if (result.finished) break;
      expect(passes).toBeLessThan(200);
    }
    expect(passes).toBeGreaterThan(1);
    expect(await Promise.all(Object.values(coins).map(c => counts(db, c)))).toEqual(expected);
    expect(await table(db, 'SELECT rule,through_block,swaps_through_block,first_trade_ts,last_trade_ts,buyers,transfers,swaps,liquidity,pons FROM history_prunes ORDER BY coin'))
      .toEqual(await table(full, 'SELECT rule,through_block,swaps_through_block,first_trade_ts,last_trade_ts,buyers,transfers,swaps,liquidity,pons FROM history_prunes ORDER BY coin'));
  });

  it('deletes swaps in whole minutes and puts the coin\'s Watcher flow mark back as it was', async () => {
    const db = await fixture(), dead = binary(coins.dead);
    const minutes = async () => (await db.sql.query<{ m: Date }>("SELECT DISTINCT date_trunc('minute',ts) AS m FROM swaps WHERE coin=$1 ORDER BY 1", [dead])).rows.map(r => r.m.getTime());
    const all = await minutes();
    await db.sql.query('INSERT INTO flow_dirty(coin,revision,from_sec) VALUES($1,77,123.5) ON CONFLICT(coin) DO UPDATE SET revision=77,from_sec=123.5', [dead]);
    // One row per batch still removes the whole first minute (three swaps).
    expect(await pruneSwaps(db, dead, BigInt(block), 1)).toBe(3);
    expect(await minutes()).toEqual(all.slice(1));
    expect((await db.sql.query('SELECT revision::text,from_sec FROM flow_dirty WHERE coin=$1', [dead])).rows).toEqual([{ revision: '77', from_sec: 123.5 }]);
    await db.sql.query('DELETE FROM flow_dirty');
    expect(await pruneSwaps(db, dead, BigInt(block), 1)).toBe(1);
    expect((await db.sql.query('SELECT 1 FROM flow_dirty')).rows).toHaveLength(0);
  });

  it('keeps tracking a revived coin, refuses an eight-day window inside the engines window, and is off unless configured', async () => {
    const db = await fixture();
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], now })).toMatchObject({ dangerCoins: 0, quietCoins: 0, historyTransfers: 0 });
    expect((await db.sql.query('SELECT 1 FROM history_prunes')).rows).toHaveLength(0);
    await expect(runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], quietCoinDays: 0, now })).rejects.toThrow('at least one quiet day');
    await expect(runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], dangerQuietDays: 0, now })).rejects.toThrow('quiet day');
    // The API keeps the read models current; buyers and the last trade survive the swaps they came from.
    await refreshReads(db);
    await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], quietCoinDays: 8, now });
    await refreshReads(db);
    const summary = (await db.sql.query<{ buyers: string; activity: Date }>('SELECT buyers::text,activity FROM read_coins WHERE coin=$1', [binary(coins.dead)])).rows[0]!;
    expect(summary).toEqual({ buyers: '2', activity: at(3) });
    // The dead coin trades again: a new buyer joins the kept buyers, the last trade moves, and it is no longer quiet.
    const n = await blockAt(db, 40.5);
    await swap(db, n, 40.5, coins.dead, address(0x99), 1); await transfer(db, n, 40.5, coins.dead, holders[2]!, address(0x99), 5);
    await refreshReads(db);
    expect((await db.sql.query('SELECT buyers::text,activity FROM read_coins WHERE coin=$1', [binary(coins.dead)])).rows[0]).toEqual({ buyers: '3', activity: at(40.5) });
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [weth], quietCoinDays: 8, now: () => epoch + 41 * DAY })).toMatchObject({ quietCoins: 0 });
    expect(await counts(db, coins.dead)).toMatchObject({ swaps: 1, transfers: 1 });
  });
});

describe('determination retention',()=>{
  it('settles rated coins and caps active coins while preserving their cards, balances and read projections',async()=>{
    const db=await fixture();await refreshReads(db);
    const before=await kept(db),active=await counts(db,coins.active);
    const result=await runRetention(db,{quoteTokens:[weth],settleHours:24,rawDays:7,dryRun:false,pauseMs:0,batchRows:2,now});
    expect(result.historyTransfers).toBeGreaterThan(0);expect(result.historySwaps).toBeGreaterThan(0);
    expect(await counts(db,coins.dead)).toMatchObject({transfers:0,swaps:0,liquidity:0,pons:0});
    expect((await counts(db,coins.active)).transfers).toBeLessThan(active.transfers);
    await db.tx(tx=>rebuildBalances(tx));await refreshReads(db);
    expect(await kept(db)).toEqual(before);
    const state=(await db.sql.query<{data:{count:number;buyers:string[];curveVolume:number}}>('SELECT data FROM coin_lifetime WHERE coin=$1',[binary(coins.dead)])).rows[0]!.data;
    expect(state.count).toBe(5);expect(state.buyers).toHaveLength(2);
    expect(await runRetention(db,{quoteTokens:[weth],settleHours:24,rawDays:7,dryRun:false,pauseMs:0,now})).toMatchObject({historyTransfers:0,historySwaps:0,historyLiquidity:0,historyPons:0});
  });
  it('continues Pons and liquidity summary cleanup without shortening the all-coin raw windows',async()=>{
    const db=await fixture();await refreshReads(db);const before=await kept(db);
    const result=await runRetention(db,{quoteTokens:[weth],swapDays:7,transferDays:3,settleHours:24,rawDays:7,dryRun:false,pauseMs:0,batchRows:2,now});
    expect(result.historyPons).toBeGreaterThan(0);expect(result.historyLiquidity).toBeGreaterThan(0);
    expect(await counts(db,coins.calm)).toMatchObject({swaps:2,transfers:1,pons:0,liquidity:0});
    await db.tx(tx=>rebuildBalances(tx));await refreshReads(db);expect(await kept(db)).toEqual(before);
  });
  it('defaults to a read-only report and does not create snapshots, baselines or deletion invalidations',async()=>{
    const db=await fixture(),tables=['tokens','swaps','token_transfers','liquidity_events','pons_events','transfer_baselines','history_prunes','coin_lifetime','trending_snapshots','read_dirty','flow_dirty','engine_activity_changes'];
    const snapshot=()=>Promise.all(tables.map(t=>table(db,`SELECT * FROM ${t} ORDER BY 1,2`)));
    const before=await snapshot();
    const report=await runRetention(db,{quoteTokens:[weth],settleHours:24,rawDays:7,ratingDays:7,now});
    expect(report.dryRun).toBe(true);expect(report.tables?.find(t=>t.table==='token_transfers')).toMatchObject({rows:0,estimateSkipped:true});
    expect(report.tables?.find(t=>t.table==='swaps')).toMatchObject({estimatedBytes:0,estimateSkipped:true});
    expect(await snapshot()).toEqual(before);
  });
  it('settles swaps after one quiet day and summarizes expired pending and undecided swaps without pruning their auxiliary evidence',async()=>{
    const db=await fixture(),pending=await counts(db,coins.pending),unlabeled=await counts(db,coins.unlabeled);
    await runRetention(db,{quoteTokens:[weth],settleHours:24,rawDays:7,dryRun:false,pauseMs:0,now});
    expect((await counts(db,coins.calm)).swaps).toBe(0);
    expect(await counts(db,coins.pending)).toEqual({...pending,swaps:0});expect(await counts(db,coins.unlabeled)).toEqual({...unlabeled,swaps:0});
    for(const coin of [coins.pending,coins.unlabeled])expect((await db.sql.query<{data:{count:number}}>('SELECT data FROM coin_lifetime WHERE coin=$1',[binary(coin)])).rows[0].data.count).toBe(5);
    expect((await counts(db,coins.calm)).transfers).toBe(0);
  });
});

describe('rating record boundaries',()=>{
  it.each([1,64])('matches the original verdict selector across coins, versions, corrections, orphaning and grade cuts (batch %i)',async batchRows=>{
    const db=await fixture();
    const {ratingSelections,GRADE_CUTS}=await import('../src/rating-retention.js');
    const cut=GRADE_CUTS.map(s=>Date.parse(s)), end=Date.parse('2026-12-01T00:00:00Z');
    const times=[cut[0]!-1000,cut[0]!,cut[1]!-1000,cut[1]!,cut[1]!+1000,cut[1]!+2000];
    for(let i=0;i<times.length;i++)await db.sql.query("INSERT INTO engine_block_times VALUES($1,$2,NULL,'head')",[100000+i,new Date(times[i]!)]);
    const all:string[]=[];
    for(const c of [address(0xf1),address(0xf2)]) {
      const rows=[['first',0,'clear','v1'],['cut-one-z',1,'monitor','v1'],['cut-one-a',1,'danger','v1'],
        ['old-orphan',2,'clear','v1'],['corrected',3,'unknown','v1'],['cut-two-z',3,'monitor','v1'],['cut-two-a',3,'danger','v1'],
        ['latest',4,'clear','v1'],['latest-orphan',5,'danger','v1'],['version-old',2,'clear','v2'],['version-latest',4,'clear','v2']] as const;
      for(const [suffix,i,level,version] of rows) {
        const id=`sample-${c.slice(-2)}-${suffix}`;all.push(id);
        await db.sql.query('INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6)',[id,binary(c),100000+i,version,id,{level}]);
        await db.sql.query("INSERT INTO receipt_publications(id,producer,kind,chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at,summary) VALUES($1,'engines','verdict',4663,$1,'sample-hash',NULL,NULL,$2,'{}')",[id,new Date(times[i]!)]);
        if(suffix.includes('orphan') || suffix==='corrected')await db.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5)',[`${id}:event`,id,suffix==='corrected' ? 'corrected':'orphaned',100000+i,{}]);
      }
    }
    const selector=ratingSelections().find(r=>r.table==='verdicts')!.select;
    const expected=(await db.sql.query<{id:string}>(selector,[new Date(end-7*DAY),GRADE_CUTS])).rows.map(r=>r.id).sort();
    expect(expected).toHaveLength(6);
    const result=await runRetention(db,{quoteTokens:[],ratingDays:7,dryRun:false,pauseMs:0,batchRows,now:()=>end});
    expect(result.skippedRules).toEqual([]);
    const remaining=(await db.sql.query<{id:string}>('SELECT id FROM verdicts')).rows.map(r=>r.id);
    expect(all.filter(id=>!remaining.includes(id)).sort()).toEqual(expected);
    expect(remaining).toEqual(expect.arrayContaining(all.filter(id=>/cut-(one|two)-z$/.test(id))));
    expect(result.ratingRows?.verdicts).toBe(expected.length);
  });
  it('keeps latest versions, first/correction verdicts and FK targets, and compacts old matches and unlabelled dependencies',async()=>{
    const db=await fixture(),coin=coins.dead;
    const {publishReceipt}=await import('../src/index.js');
    const {createGuardReceiptCodec}=await import('@eko/shared');
    const {concat,encodeAbiParameters,keccak256,stringToHex}=await import('viem');
    const codec=createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex}),input={fixture:true};
    await blockAt(db,2);
    const versions=[['retention-first',1],['retention-old',2],['retention-target',1501],['retention-correction',2001],['retention-latest',3001]] as const;
    for(const [id,n] of versions) {
      await db.sql.query('INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6)',[id,binary(coin),n,'1.0.0',id,{level:id==='retention-old' ? 'danger':'clear'}]);
      await db.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5)',[`${id}:created`,id,'created',n,{}]);
      await publishReceipt(db,'engines',{schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:id,revisionId:id,kind:'verdict',chainId:4663,coin,
        recordedAt:at(3).toISOString(),modelIds:[],personaSetVersion:null,cardSchemaVersion:'fixture-card',rulesVersion:'1.0.0',outputSchemaVersion:'verdict-1',
        snapshotHash:codec.hash(input),deterministicInput:input,decision:{level:'clear'},window:{kind:'snapshot',blockNumber:n,blockHash:hash(n)},supersedes:null,reorgOf:null});
    }
    await db.sql.query("INSERT INTO verdict_events VALUES('retention-correction:event','retention-correction','corrected',2001,'{}')");
    for(const [id,n] of [['retention-card-old',2],['retention-card-current',3001]] as const)await db.sql.query('INSERT INTO coin_cards VALUES($1,$2,$3,$4,$5,$6)',[id,binary(coin),n,id,{verdict:{level:'clear'}},'1.0.0']);
    await db.sql.query("UPDATE coin_card_latest SET card_id='retention-card-current',as_of_block=3001 WHERE coin=$1",[binary(coin)]);
    for(const [id,n,verdict] of [[hash(900),2,'retention-old'],[hash(901),3001,'retention-target']] as const)await db.sql.query("INSERT INTO guard_shadow_runs(id,coin,block,legacy_verdict_id,status,data,recorded_at) VALUES($1,$2,$3,$4,'missing_cursor','{}',$5)",[id,coin,n,verdict,at(3)]);
    for(const [n,id,level] of [[2,'honeypot','danger'],[3001,'wash_to_trend','monitor']] as const)await db.sql.query('INSERT INTO playbook_matches VALUES($1,$2,$3,$4,$5)',[binary(coin),n,'1.0.0',id,{id,level,confidence:1,evidence:[]}]);
    for(const id of ['retention-unlabelled','retention-labelled']) {
      await db.sql.query('INSERT INTO wallet_fingerprint_runs VALUES($1,$2,2,$3,$4,$5,$6,0.5)',[id,binary(holders[id.endsWith('unlabelled') ? 0:1]!),binary(hash(2)),'fixture-model',id,{}]);
      await db.sql.query('INSERT INTO wallet_fingerprint_dependencies VALUES($1,2,$2)',[id,binary(hash(2))]);
    }
    await db.sql.query("INSERT INTO wallet_labels(id,address,label,confidence,source,features,model_version,valid_from_block) VALUES('retention-label',$1,'likely_agent',0.5,'fingerprint','{}','fixture-model',2)",[binary(holders[1]!)]);
    await db.sql.query("INSERT INTO wallet_label_fingerprint_dependencies VALUES('retention-label','retention-labelled')");
    const before=(await db.sql.query('SELECT * FROM verdicts WHERE coin=$1 ORDER BY id',[binary(coin)])).rows;
    const dry=await runRetention(db,{quoteTokens:[],ratingDays:7,now});
    expect(dry.tables?.find(t=>t.table==='coin_cards')).toMatchObject({rows:0,estimateSkipped:true});
    expect(dry.tables?.find(t=>t.table==='verdicts')).toMatchObject({rows:0,estimateSkipped:true});
    expect(dry.tables?.find(t=>t.table==='verdict_events')).toMatchObject({rows:0,estimateSkipped:true});
    expect((await db.sql.query('SELECT * FROM verdicts WHERE coin=$1 ORDER BY id',[binary(coin)])).rows).toEqual(before);
    const real=await runRetention(db,{quoteTokens:[],ratingDays:7,dryRun:false,pauseMs:0,batchRows:1,now});
    expect(real.ratingRows).toMatchObject({wallet_fingerprint_dependencies:1,guard_shadow_runs:1,verdicts:1});
    expect(real.ratingRows?.coin_cards).toBeGreaterThan(0);expect(real.ratingRows?.playbook_matches).toBeGreaterThan(0);
    expect(real.skippedRules).toEqual([]);
    const ids=(await db.sql.query<{id:string}>('SELECT id FROM verdicts WHERE coin=$1 ORDER BY id',[binary(coin)])).rows.map(r=>r.id);
    expect(ids).toEqual(['retention-correction','retention-first','retention-latest','retention-target']);
    expect((await db.sql.query('SELECT coin FROM read_blue_chip_danger WHERE coin=$1',[binary(coin)])).rows).toHaveLength(1);
    expect((await db.sql.query('SELECT id FROM coin_cards WHERE coin=$1',[binary(coin)])).rows).toEqual([{id:'retention-card-current'}]);
    expect((await db.sql.query('SELECT id FROM guard_shadow_runs')).rows).toEqual([{id:hash(901)}]);
    expect((await db.sql.query('SELECT playbook_id,level,first_block::text FROM coin_match_lifetime')).rows).toEqual([{playbook_id:'honeypot',level:'danger',first_block:'2'}]);
    expect((await db.sql.query('SELECT run_id FROM wallet_fingerprint_dependencies')).rows).toEqual([{run_id:'retention-labelled'}]);
    expect((await db.sql.query('SELECT block::text FROM read_first_verdict WHERE coin=$1',[binary(coin)])).rows).toEqual([{block:'1'}]);
  });
  it('preserves Blue chip current state and historical card Danger when rating and raw history are compacted',async()=>{
    const db=await fixture(),coin=address(0xe1);
    await blockAt(db,2);
    await db.sql.query("INSERT INTO coin_cards VALUES('blue-old',$1,2,'old','{\"verdict\":{\"level\":\"danger\"}}','1.0.0'),('blue-current',$1,3001,'current','{\"verdict\":{\"level\":\"clear\"}}','1.0.0')",[binary(coin)]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'blue-current',3001,'{\"verdict\":{\"level\":\"clear\"}}')",[binary(coin)]);
    expect((await db.sql.query('SELECT coin FROM read_blue_chip_danger WHERE coin=$1',[binary(coin)])).rows).toHaveLength(0);
    await db.sql.query("INSERT INTO coin_listings(coin,source,external_id,active,first_seen,last_seen) VALUES($1,'sample-source','sample',false,$2,$2)",[binary(coins.danger),at(0)]);
    await db.sql.query('INSERT INTO read_blue_chip VALUES($1,1,$2,true,25000,100)',[binary(coins.danger),at(0)]);
    const states=async()=>Promise.all(['coin_listings','read_blue_chip','read_blue_chip_danger'].map(async table=>(await db.sql.query(`SELECT * FROM ${table} ORDER BY coin`)).rows));
    const before=await states();
    const options={quoteTokens:[weth],settleHours:24,rawDays:7,ratingDays:7,dangerQuietDays:2,now:()=>now()+30*DAY};
    const dry=await runRetention(db,options);
    expect(await states()).toEqual(before);
    expect(dry.tables?.some(t=>['coin_listings','read_blue_chip','read_blue_chip_danger'].includes(t.table))).toBe(false);
    await runRetention(db,{...options,dryRun:false,pauseMs:0});
    expect((await db.sql.query("SELECT id FROM coin_cards WHERE id='blue-old'")).rows).toHaveLength(0);
    expect((await db.sql.query('SELECT coin FROM read_blue_chip_danger WHERE coin=$1',[binary(coin)])).rows).toHaveLength(1);
    const after=await states();
    expect(after.slice(0,2)).toEqual(before.slice(0,2));
    for(const row of before[2]!)expect(after[2]).toContainEqual(row);
    expect((await db.sql.query('SELECT 1 FROM history_prunes WHERE coin=$1',[binary(coins.danger)])).rows).toHaveLength(1);
    expect((await db.sql.query('SELECT 1 FROM swaps WHERE coin=$1',[binary(coins.danger)])).rows).toHaveLength(0);
  });
});

describe('settlement evidence floor',()=>{
  it('keeps the day of tax transfer evidence when a shorter settlement window is configured',async()=>{
    const db=await fixture();
    const n=await blockAt(db,39.5);
    await db.sql.query("INSERT INTO pons_events(tx_hash,log_index,block,kind,token,emitter,data) VALUES($1,999,$2,'trade',$3,$3,'{}')",[binary(hash(n)),n,binary(coins.active)]);
    await db.sql.query('UPDATE coin_card_latest SET as_of_block=$2 WHERE coin=$1',[binary(coins.active),n]);
    await runRetention(db,{quoteTokens:[weth],settleHours:1,dryRun:false,pauseMs:0,now});
    expect((await db.sql.query('SELECT 1 FROM token_transfers WHERE token=$1 AND ts>=$2',[binary(coins.active),at(39)])).rows).toHaveLength(1);
    expect((await db.sql.query("SELECT 1 FROM pons_events WHERE token=$1 AND block=$2",[binary(coins.active),n])).rows).toHaveLength(1);
  });
  it('retains ungraded auxiliary activity while preserving expired swaps in lifetime summaries',async()=>{
    const db=await fixture(),before=await counts(db,coins.dead);
    await db.sql.query('UPDATE coin_card_latest SET as_of_block=1 WHERE coin=$1',[binary(coins.dead)]);
    await runRetention(db,{quoteTokens:[weth],settleHours:24,rawDays:7,dryRun:false,pauseMs:0,now});
    expect(await counts(db,coins.dead)).toEqual({...before,swaps:0});
    expect((await db.sql.query<{data:{count:number}}>('SELECT data FROM coin_lifetime WHERE coin=$1',[binary(coins.dead)])).rows[0].data.count).toBe(before.swaps);
  });
});
