import { afterEach, describe, expect, it } from 'vitest';
import { binary, hex, migrate, migrateEngines, runRetention, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { CoinOnboardingWorker, attributeLiquidity, attributeSwaps, decodeText, type AttributionAddresses, type OnboardingChain } from '../src/coin-onboarding.js';
import type { PricingAssets } from '../src/pricing-repair.js';

// 2026-10-13: about 3,500 coins a day traded only on Uniswap. The indexer stored their swaps without a trader, a
// price or a name, so none could be rated or listed. Synthetic rows only.
const now = Date.parse('2026-10-13T12:00:00Z');
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const weth = address(0xee), usdg = address(0xd0), manager = address(0x99), native = address(0), dead = '0x000000000000000000000000000000000000dead';
const coin = address(0xa1), v3pool = address(0x31), v4pool = hash(0x41), router = address(0x70), buyer = address(0xb1), seller = address(0xb2), bot = address(0xb3), launcher = address(0xde);
const entryPoint = address(0xe9);
const addresses: AttributionAddresses = { poolManager: manager, weth, usdg, reference: [weth, usdg], entryPoints: [entryPoint] };
const assets: PricingAssets = { weth, usdg, usdgDecimals: 6 };
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

async function open() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
  await db.insert('tokens', { address: binary(coin), first_block: '100', block: '100' });
  await db.insert('pools', { id: binary(v3pool), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(weth), fee: 3000, tick_spacing: 60, created_block: '100', block: '100' });
  await db.insert('pools', { id: binary(v4pool), venue: 'uniswap_v4', currency0: binary(native), currency1: binary(coin), fee: 3000, tick_spacing: 60, created_block: '100', block: '100' });
  return db;
}
let logIndex = 0;
const at = (block: number) => new Date(now - (1000 - block) * 1000);
async function swap(db: ChainDb, block: number, tx: number, side: 1 | -1, amount: string, extra: Record<string, unknown> = {}) {
  await db.insert('swaps', { ts: at(block), block: String(block), tx_hash: binary(hash(tx)), log_index: logIndex++, venue: 'uniswap_v4', pool_id: binary(v4pool), coin: binary(coin),
    quote_asset: binary(native), trader: null, tx_from: null, tx_to: null, senders_pending: true, side, amount_coin: amount, amount_quote: '1000000000000000000',
    price_quote: null, usd: null, priced_block: null, pricing_pending: true, ...extra });
}
async function transfer(db: ChainDb, block: number, tx: number, from: string, to: string, amount: string, token = coin) {
  await db.insert('token_transfers', { ts: at(block), block: String(block), tx_hash: binary(hash(tx)), log_index: logIndex++, token: binary(token), from_address: binary(from), to_address: binary(to), amount });
}
const swaps = async (db: ChainDb) => (await db.sql.query<{ tx_hash: Uint8Array; trader: Uint8Array | null; recipient: Uint8Array | null; senders_pending: boolean }>(
  'SELECT tx_hash,trader,recipient,senders_pending FROM swaps WHERE coin=$1 ORDER BY block,log_index', [binary(coin)])).rows
  .map(r => ({ tx: Number(BigInt(hex(r.tx_hash))), trader: r.trader ? hex(r.trader) : null, recipient: r.recipient ? hex(r.recipient) : null, pending: r.senders_pending }));
const window = [new Date(0), new Date(now + 3_600_000)] as const;

describe('swap traders from the coin’s own transfers', () => {
  it('names the wallet whose balance moved, never a pool, a router that passes coins on, or a burn address', async () => {
    const db = await open();
    // 1: a buy through a router that forwards the coins. 2: a sell (wallet to the pool manager). 3: a v3 buy whose event names the router.
    await swap(db, 200, 1, 1, '1000'); await transfer(db, 200, 1, manager, router, '1000'); await transfer(db, 200, 1, router, buyer, '1000');
    await swap(db, 201, 2, -1, '400'); await transfer(db, 201, 2, seller, manager, '400');
    await swap(db, 202, 3, 1, '500', { venue: 'uniswap_v3', pool_id: binary(v3pool), quote_asset: binary(weth), recipient: binary(router) });
    await transfer(db, 202, 3, v3pool, router, '500'); await transfer(db, 202, 3, router, buyer, '500');
    // 4: a taxed buy (the token keeps 5%, the buyer gets the rest). 5: a buy burned on arrival: the contract that took it from the pool.
    await swap(db, 203, 4, 1, '1000'); await transfer(db, 203, 4, manager, buyer, '950'); await transfer(db, 203, 4, manager, coin, '50');
    await swap(db, 204, 5, 1, '300'); await transfer(db, 204, 5, manager, bot, '300'); await transfer(db, 204, 5, bot, dead, '300');
    expect(await attributeSwaps(db, addresses, ...window, 100, [binary(coin)])).toBe(5);
    expect(await swaps(db)).toEqual([
      { tx: 1, trader: buyer, recipient: buyer, pending: false },
      { tx: 2, trader: seller, recipient: null, pending: false },
      { tx: 3, trader: buyer, recipient: buyer, pending: false },
      { tx: 4, trader: buyer, recipient: buyer, pending: false },
      { tx: 5, trader: bot, recipient: bot, pending: false },
    ]);
    expect(await attributeSwaps(db, addresses, ...window, 100, [binary(coin)])).toBe(0);
  });
  it('names a wallet that bought and sold in one transaction, and marks a buy that moved no coins as delivered to nobody', async () => {
    const db = await open();
    // 6: an arbitrage: the bot takes coins from the v4 pool and sends the same amount to the v3 pool (net zero).
    await swap(db, 210, 6, 1, '700'); await transfer(db, 210, 6, manager, bot, '700');
    await swap(db, 210, 6, -1, '700', { venue: 'uniswap_v3', pool_id: binary(v3pool), quote_asset: binary(weth), recipient: binary(bot) }); await transfer(db, 210, 6, bot, v3pool, '700');
    // 7: the coin is one hop of a route inside the pool manager: no transfer at all, after transfers were being stored.
    await swap(db, 211, 7, 1, '900'); await swap(db, 211, 7, -1, '900');
    expect(await attributeSwaps(db, addresses, ...window, 100, [binary(coin)])).toBe(4);
    expect(await swaps(db)).toEqual([
      { tx: 6, trader: bot, recipient: bot, pending: false },
      { tx: 6, trader: bot, recipient: bot, pending: false },
      { tx: 7, trader: null, recipient: manager, pending: false },
      { tx: 7, trader: null, recipient: null, pending: false },
    ]);
  });
  it('leaves a buy unnamed when the coin’s transfers were not stored yet, and skips coins that are not onboarded', async () => {
    const db = await open();
    await swap(db, 150, 8, 1, '100');
    // Without a coin list only coins with a launch wallet are settled.
    expect(await attributeSwaps(db, addresses, ...window, 100)).toBe(0);
    await db.sql.query('UPDATE tokens SET deployer=$2 WHERE address=$1', [binary(coin), binary(launcher)]);
    expect(await attributeSwaps(db, addresses, ...window, 100)).toBe(1);
    expect(await swaps(db)).toEqual([{ tx: 8, trader: null, recipient: null, pending: false }]);
  });
});

describe('liquidity providers from the pool’s transfers', () => {
  it('names who paid in and who took out, and keeps the event’s own owner otherwise', async () => {
    const db = await open(), positions = address(0x50);
    const event = (block: number, tx: number, kind: string, data: Record<string, string>) => db.insert('liquidity_events', { block: String(block), tx_hash: binary(hash(tx)), log_index: logIndex++, ts: at(block),
      venue: 'uniswap_v4', pool_id: binary(v4pool), kind, actor: null, tx_from: null, tx_to: null, senders_pending: true, data: JSON.stringify(data) });
    await event(100, 20, 'Initialize', { id: v4pool });
    await event(101, 21, 'ModifyLiquidity', { sender: positions, liquidityDelta: '5000', tickLower: '-600', tickUpper: '600' }); await transfer(db, 101, 21, launcher, manager, '800000');
    await event(300, 22, 'ModifyLiquidity', { sender: positions, liquidityDelta: '-5000', tickLower: '-600', tickUpper: '600' }); await transfer(db, 300, 22, manager, seller, '750000');
    await event(301, 23, 'ModifyLiquidity', { sender: positions, liquidityDelta: '100', tickLower: '-600', tickUpper: '600' });
    expect(await attributeLiquidity(db, addresses, 100, [binary(coin)])).toBe(4);
    const rows = (await db.sql.query<{ actor: Uint8Array; senders_pending: boolean }>('SELECT actor,senders_pending FROM liquidity_events ORDER BY block', [])).rows;
    expect(rows.map(r => [hex(r.actor), r.senders_pending])).toEqual([[manager, false], [launcher, false], [seller, false], [positions, false]]);
  });
});

describe('coin onboarding', () => {
  const chain = (facts: Awaited<ReturnType<OnboardingChain['facts']>>, mint: Awaited<ReturnType<OnboardingChain['firstMint']>>, calls: string[] = [], txs: number | null = 12): OnboardingChain => ({
    facts: async token => { calls.push(`facts:${token}`); return facts; },
    firstMint: async (token, upTo) => { calls.push(`mint:${token}:${upTo}`); return mint; },
    sent: async wallet => { calls.push(`sent:${wallet}`); return txs; },
  });
  it('fills in the coin, prices and names its swaps, and records the launch wallet last', async () => {
    const db = await open(), calls: string[] = [];
    await db.insert('chain_blocks', { number: '990', block: '990', hash: binary(hash(0x990)), parent_hash: null, ts: at(990) });
    await db.insert('tokens', { address: binary(usdg), name: 'USDG', symbol: 'USDG', decimals: 6, first_block: '1', block: '1' });
    await swap(db, 900, 30, 1, '2000000000000000000', { quote_asset: binary(usdg), amount_quote: '5000000' });
    await transfer(db, 900, 30, manager, buyer, '2000000000000000000');
    let clock = now;
    const worker = new CoinOnboardingWorker(db, chain({ decimals: 18, symbol: 'DEMO', name: null, totalSupply: 10n ** 27n }, { wallet: launcher, to: null, block: 99n, tx: hash(0x77), mintTo: launcher }, calls),
      () => undefined, { now: () => clock, assets, addresses });
    await worker.tick();
    const token = (await db.sql.query<{ name: string; symbol: string; decimals: number; total_supply: string; supply_block: string; deployer: Uint8Array }>(
      'SELECT name,symbol,decimals,total_supply::text,supply_block::text,deployer FROM tokens WHERE address=$1', [binary(coin)])).rows[0];
    // A token with only a symbol is listed under it.
    expect({ ...token, deployer: hex(token.deployer) }).toEqual({ name: 'DEMO', symbol: 'DEMO', decimals: 18, total_supply: '1000000000000000000000000000', supply_block: '990', deployer: launcher });
    expect(calls).toEqual([`facts:${coin}`, `mint:${coin}:200`, `sent:${launcher}`]);
    const row = (await db.sql.query<{ usd: number; price_quote: number; trader: Uint8Array; pricing_pending: boolean }>('SELECT usd,price_quote,trader,pricing_pending FROM swaps WHERE coin=$1', [binary(coin)])).rows[0];
    expect({ ...row, trader: hex(row.trader) }).toEqual({ usd: 5, price_quote: 2.5, trader: buyer, pricing_pending: false });
    // Its candle for that minute is built after pricing, in a transaction of its own.
    expect((await db.sql.query<{ volume_usd: number; trades: number }>('SELECT volume_usd,trades FROM bars_1m WHERE coin=$1', [binary(coin)])).rows).toEqual([{ volume_usd: 5, trades: 1 }]);
    expect((await db.sql.query<{ status: string }>('SELECT status FROM coin_onboarding WHERE coin=$1', [binary(coin)])).rows[0].status).toBe('done');
    // The read model lists it once it has a launch wallet, before any card.
    await db.sql.query('SELECT refresh_read_models(ARRAY[$1::bytea],$2)', [binary(coin), Math.floor(now / 1000)]);
    expect((await db.sql.query('SELECT 1 FROM read_coins WHERE coin=$1', [binary(coin)])).rows).toHaveLength(1);
    // A swap of the onboarded coin stored later without a wallet or a price (here an old one: a pool's stored raw events
    // turned into rows) is priced and named without any chain read, once the list of such coins is read again (every
    // two minutes).
    await swap(db, 150, 31, -1, '1000000000000000000', { quote_asset: binary(usdg), amount_quote: '3000000' }); await transfer(db, 150, 31, seller, manager, '1000000000000000000');
    await worker.tick();
    expect((await swaps(db))[0]).toMatchObject({ tx: 31, pending: true });
    clock += 120_000;
    await db.insert('chain_blocks', { number: '991', block: '991', hash: binary(hash(0x991)), parent_hash: null, ts: new Date(clock - 5_000) });
    await worker.tick();
    expect((await swaps(db))[0]).toEqual({ tx: 31, trader: seller, recipient: null, pending: false });
    expect((await db.sql.query<{ usd: number }>('SELECT usd FROM swaps WHERE block=150')).rows[0].usd).toBe(3);
    expect(calls).toHaveLength(3);
  });
  it.each([300,-1])('settles live rows with a watermark and an open seal through %i, leaving protected rows intact',async through=>{
    const db=await open(),events:string[]=[];
    await db.insert('tokens',{address:binary(usdg),decimals:6,first_block:'1',block:'1'});
    for(const block of [200,300,900]) {
      await swap(db,block,block,1,'1000000000000000000',{quote_asset:binary(usdg),amount_quote:'5000000'});
      await transfer(db,block,block,manager,buyer,'1000000000000000000');
      await db.insert('liquidity_events',{ts:at(block),block:String(block),tx_hash:binary(hash(block+1)),log_index:logIndex++,venue:'uniswap_v4',pool_id:binary(v4pool),kind:'ModifyLiquidity',data:{liquidityDelta:'100'},senders_pending:true});
    }
    await db.sql.query("UPDATE raw_history_watermarks SET through_block=250 WHERE name='swaps'");
    await db.sql.query("INSERT INTO raw_history_watermarks VALUES('liquidity_events',300)");
    await db.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,rows,through_block)
      VALUES('swaps','swaps_fixture',$1,$2,2,$3)`,[at(200),at(301),through]);
    await expect(db.sql.query('UPDATE swaps SET usd=1 WHERE block=300')).rejects.toThrow('sealed raw history');
    const protectedRows=async()=>({swaps:(await db.sql.query('SELECT * FROM swaps WHERE block<=300 ORDER BY block')).rows,
      liquidity:(await db.sql.query('SELECT * FROM liquidity_events WHERE block<=300 ORDER BY block')).rows});
    const before=await protectedRows(),calls:string[]=[];
    const worker=new CoinOnboardingWorker(db,chain({decimals:18,symbol:'DEMO',name:'Sample token',totalSupply:1000n},null,calls),event=>events.push(event),{now:()=>now,assets,addresses});
    await worker.tick();await worker.tick();
    expect(await protectedRows()).toEqual(before);
    expect((await db.sql.query('SELECT usd,senders_pending FROM swaps WHERE block=900')).rows).toEqual([{usd:5,senders_pending:false}]);
    expect((await db.sql.query('SELECT senders_pending FROM liquidity_events WHERE block=900')).rows).toEqual([{senders_pending:false}]);
    expect((await db.sql.query('SELECT status FROM coin_onboarding')).rows).toEqual([{status:'done'}]);
    expect(events).not.toContain('coin_onboarding_failed');expect(calls.filter(c=>c.startsWith('facts:'))).toHaveLength(1);
  });
  it('finishes onboarding and pricing with only one day of raw rows after its early day is dropped',async()=>{
    const db=await open(),early=new Date(now-3*86400000);
    await db.ensurePartitions(early);
    await db.insert('tokens',{address:binary(usdg),decimals:6,first_block:'1',block:'1'});
    await db.insert('chain_blocks',{number:200,block:200,hash:binary(hash(200)),parent_hash:null,ts:early});
    await db.insert('chain_blocks',{number:990,block:990,hash:binary(hash(990)),parent_hash:null,ts:at(990)});
    await swap(db,200,200,1,'1000000000000000000',{ts:early,quote_asset:binary(usdg),amount_quote:'5000000'});
    await swap(db,900,900,1,'1000000000000000000',{quote_asset:binary(usdg),amount_quote:'5000000'});
    await transfer(db,900,900,manager,buyer,'1000000000000000000');
    await runRetention(db,{quoteTokens:[],swapDays:1,transferDays:1,dryRun:false,pauseMs:0,now:()=>now});
    expect((await db.sql.query('SELECT block FROM swaps ORDER BY block')).rows).toEqual([{block:900}]);
    expect((await db.sql.query('SELECT 1 FROM raw_history_seals WHERE sealed AND dropped')).rows.length).toBeGreaterThan(0);
    const events:string[]=[];
    const worker=new CoinOnboardingWorker(db,chain({decimals:18,symbol:'DEMO',name:'Sample token',totalSupply:1000n},
      {wallet:launcher,to:null,block:99n,tx:hash(77),mintTo:launcher}),event=>events.push(event),{now:()=>now,assets,addresses});
    await worker.tick();await worker.tick();
    expect((await db.sql.query('SELECT status FROM coin_onboarding')).rows).toEqual([{status:'done'}]);
    expect((await db.sql.query('SELECT usd,senders_pending,pricing_pending FROM swaps')).rows).toEqual([{usd:5,senders_pending:false,pricing_pending:false}]);
    expect((await db.sql.query('SELECT trades FROM bars_1m WHERE coin=$1 AND minute>$2',[binary(coin),new Date(now-86400000)])).rows).toEqual([{trades:1}]);
    expect(events).not.toContain('coin_onboarding_failed');
  });
  it('records done with sealed history when a seal arrives after the pass snapshot',async()=>{
    const db=await open(),events:string[]=[];
    await db.insert('tokens',{address:binary(usdg),decimals:6,first_block:'1',block:'1'});
    await swap(db,900,900,1,'1000000000000000000',{quote_asset:binary(usdg),amount_quote:'5000000'});
    const source=chain({decimals:18,symbol:'DEMO',name:'Sample token',totalSupply:1000n},null);
    const facts=source.facts;let fenced=false;
    source.facts=async token=>{
      if(!fenced) {
        fenced=true;
        await db.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,rows,through_block)
          VALUES('swaps','swaps_fixture',$1,$2,1,900)`,[at(899),at(901)]);
      }
      return facts(token);
    };
    const worker=new CoinOnboardingWorker(db,source,event=>events.push(event),{now:()=>now,assets,addresses});
    await worker.tick();await worker.tick();
    expect((await db.sql.query('SELECT usd,senders_pending FROM swaps')).rows).toEqual([{usd:null,senders_pending:true}]);
    expect((await db.sql.query("SELECT status,data->>'settlement' AS settlement FROM coin_onboarding")).rows).toEqual([{status:'done',settlement:'done_with_sealed_history'}]);
    expect((await db.sql.query('SELECT deployer IS NOT NULL AS listed FROM tokens WHERE address=$1',[binary(coin)])).rows).toEqual([{listed:true}]);
    expect(events).not.toContain('coin_onboarding_failed');
  });
  it('sets aside a token it cannot read, and records no deployer wallet when its first mint is not found', async () => {
    const db = await open();
    await swap(db, 900, 40, 1, '1000');
    const unreadable = new CoinOnboardingWorker(db, chain({ decimals: null, symbol: 'DEMO', name: 'Sample token', totalSupply: null }, null), () => undefined, { now: () => now, assets, addresses });
    await unreadable.tick();
    expect((await db.sql.query<{ status: string }>('SELECT status FROM coin_onboarding WHERE coin=$1', [binary(coin)])).rows[0].status).toBe('unreadable');
    expect((await db.sql.query<{ deployer: Uint8Array | null }>('SELECT deployer FROM tokens WHERE address=$1', [binary(coin)])).rows[0].deployer).toBeNull();
    // Set aside for six hours: the same worker does not read it again.
    await unreadable.tick();
    expect((await db.sql.query<{ attempts: number }>('SELECT attempts FROM coin_onboarding WHERE coin=$1', [binary(coin)])).rows[0].attempts).toBe(1);
    // Later (past the wait) the token reads but has no mint near its first pool: it is listed with no deployer wallet
    // (its own address), never with the sender of some later transfer.
    await transfer(db, 120, 41, launcher, buyer, '5');
    const calls: string[] = [];
    const later = new CoinOnboardingWorker(db, chain({ decimals: 18, symbol: 'DEMO', name: 'Sample token', totalSupply: 1000n }, null, calls), () => undefined, { now: () => now + 7 * 3_600_000, assets, addresses });
    await later.tick();
    expect(calls).toEqual([`facts:${coin}`, `mint:${coin}:200`]);
    expect(hex((await db.sql.query<{ deployer: Uint8Array }>('SELECT deployer FROM tokens WHERE address=$1', [binary(coin)])).rows[0].deployer)).toBe(coin);
    expect((await db.sql.query<{ data: { shared?: string } }>('SELECT data FROM coin_onboarding WHERE coin=$1', [binary(coin)])).rows[0].data.shared).toBe('mint_not_found');
  });
  it('records no deployer wallet for a launch sent by a bot, a bundler or a sender seen launching many coins', async () => {
    const facts = { decimals: 18, symbol: 'DEMO', name: 'Sample token', totalSupply: 1000n };
    const launched = async (mint: NonNullable<Awaited<ReturnType<OnboardingChain['firstMint']>>>, txs: number | null, before?: (db: ChainDb) => Promise<void>) => {
      const db = await open(); await swap(db, 900, 50 + logIndex, 1, '1000'); await before?.(db);
      await new CoinOnboardingWorker(db, chain(facts, mint, [], txs), () => undefined, { now: () => now, assets, addresses }).tick();
      const row = (await db.sql.query<{ deployer: Uint8Array; data: { shared?: string; sender?: string } }>('SELECT t.deployer,o.data FROM tokens t JOIN coin_onboarding o ON o.coin=t.address WHERE t.address=$1', [binary(coin)])).rows[0];
      return { deployer: hex(row.deployer), shared: row.data.shared, sender: row.data.sender };
    };
    const mint = { wallet: launcher, to: address(0x4a) as string | null, block: 99n, tx: hash(0x77), mintTo: address(0x4b) };
    // One person: the sender is the launch wallet.
    expect(await launched(mint, 292)).toEqual({ deployer: launcher, shared: undefined, sender: launcher });
    // A relayer (153,190 transactions on 2026-10-13), an unreadable count, and a launch through an entry point: the coin's own address.
    expect(await launched(mint, 153_190)).toEqual({ deployer: coin, shared: 'automated_sender', sender: launcher });
    expect(await launched(mint, null)).toEqual({ deployer: coin, shared: 'unreadable_sender', sender: launcher });
    expect(await launched({ ...mint, to: entryPoint }, 3)).toEqual({ deployer: coin, shared: 'entry_point', sender: launcher });
    // Twenty launches by the same sender already on record this week.
    expect(await launched(mint, 3, async db => { for (let i = 0; i < 20; i++) await db.sql.query(`INSERT INTO coin_onboarding(coin,status,data,created_at) VALUES($1,'done',$2::jsonb,$3)`,
      [binary(address(0x7000 + i)), JSON.stringify({ sender: launcher }), new Date(now - 3_600_000)]); })).toEqual({ deployer: coin, shared: 'many_launches', sender: launcher });
  });
  it('does nothing while the indexer is behind, and resumes once it has caught up', async () => {
    const db = await open(), events: string[] = [];
    await swap(db, 900, 60, 1, '1000');
    // The newest indexed block is two minutes old.
    await db.insert('chain_blocks', { number: '990', block: '990', hash: binary(hash(0x990)), parent_hash: null, ts: new Date(now - 120_000) });
    const facts = { decimals: 18, symbol: 'DEMO', name: 'Sample token', totalSupply: 1000n }, mint = { wallet: launcher, to: null, block: 99n, tx: hash(0x77), mintTo: launcher };
    const worker = new CoinOnboardingWorker(db, chain(facts, mint), event => events.push(event), { now: () => now, assets, addresses });
    await worker.tick(); await worker.tick();
    expect(events).toEqual(['coin_onboarding_paused']);
    expect((await db.sql.query('SELECT 1 FROM coin_onboarding')).rows).toHaveLength(0);
    await db.insert('chain_blocks', { number: '991', block: '991', hash: binary(hash(0x991)), parent_hash: null, ts: new Date(now - 5_000) });
    await worker.tick();
    expect(hex((await db.sql.query<{ deployer: Uint8Array }>('SELECT deployer FROM tokens WHERE address=$1', [binary(coin)])).rows[0].deployer)).toBe(launcher);
  });
  // 2026-10-13 08:25Z: 479 Uniswap coins traded in the hour were not listed, 30 of them with 90% of those swaps. The
  // hour's 335 launches filled every pass, and from 08:17Z four listed coins with swaps that cannot be priced took all of it.
  const facts = { decimals: 18, symbol: 'DEMO', name: 'Sample token', totalSupply: 1000n }, mint = { wallet: launcher, to: null, block: 99n, tx: hash(0x77), mintTo: launcher };
  const other = async (db: ChainDb, token: string, first: number, n: number, extra: Record<string, unknown> = {}) => {
    await db.insert('tokens', { address: binary(token), first_block: String(first), block: String(first), ...extra });
    await db.insert('pools', { id: binary(address(0x3200 + n)), venue: 'uniswap_v3', currency0: binary(token), currency1: binary(weth), fee: 3000, tick_spacing: 60, created_block: String(first), block: String(first) });
  };
  const deployer = async (db: ChainDb, token: string) => { const row = (await db.sql.query<{ deployer: Uint8Array | null }>('SELECT deployer FROM tokens WHERE address=$1', [binary(token)])).rows[0]; return row.deployer ? hex(row.deployer) : null; };
  const unnamed = async (db: ChainDb, token: string) => Number((await db.sql.query<{ n: string }>('SELECT count(*) AS n FROM swaps WHERE coin=$1 AND senders_pending', [binary(token)])).rows[0].n);
  it('onboards a coin with fifty swaps in the last hour before a newer launch', async () => {
    const db = await open(), launch = address(0xa2);
    await other(db, launch, 990, 1);
    for (let i = 0; i < 50; i++) { await swap(db, 900 + i, 600 + i, 1, '10'); await transfer(db, 900 + i, 600 + i, manager, buyer, '10'); }
    await swap(db, 995, 700, 1, '10', { coin: binary(launch) }); await transfer(db, 995, 700, manager, buyer, '10', launch);
    const worker = new CoinOnboardingWorker(db, chain(facts, mint), () => undefined, { now: () => now, assets, addresses, perTick: 1 });
    await worker.tick();
    expect([await deployer(db, coin), await deployer(db, launch)]).toEqual([launcher, null]);
    await worker.tick();
    expect(await deployer(db, launch)).toBe(launcher);
  });
  it('gives listed coins, busy coins and launches each a share of a pass, so a long history holds up nothing else', async () => {
    const db = await open(), listed = address(0xa2), launch = address(0xa3);
    await other(db, listed, 100, 1, { decimals: 18, name: 'Listed token', symbol: 'LIST', deployer: binary(launcher) });
    await other(db, launch, 990, 2);
    // Sixty stored swaps without a wallet for a listed coin and for a traded coin that is not onboarded; one for the launch.
    for (let i = 0; i < 60; i++) {
      await swap(db, 900 + i, 800 + i, 1, '10'); await transfer(db, 900 + i, 800 + i, manager, buyer, '10');
      await swap(db, 900 + i, 900 + i, 1, '10', { coin: binary(listed) }); await transfer(db, 900 + i, 900 + i, manager, buyer, '10', listed);
    }
    await swap(db, 995, 1000, 1, '10', { coin: binary(launch) }); await transfer(db, 995, 1000, manager, buyer, '10', launch);
    // One swap named per statement and a clock that moves with every reading: neither long history fits a pass.
    let clock = now;
    const worker = new CoinOnboardingWorker(db, chain(facts, mint), () => undefined, { now: () => (clock += 50), assets, addresses, batch: 1, budgetMs: 3000 });
    await worker.tick();
    expect(await deployer(db, launch)).toBe(launcher);
    expect(await deployer(db, coin)).toBeNull();
    for (const token of [listed, coin]) { const left = await unnamed(db, token); expect(left).toBeGreaterThan(0); expect(left).toBeLessThan(60); }
    for (let pass = 0; pass < 20 && (await deployer(db, coin)) == null; pass++) await worker.tick();
    expect(await deployer(db, coin)).toBe(launcher);
    await worker.tick(); await worker.tick();
    expect([await unnamed(db, listed), await unnamed(db, coin), await unnamed(db, launch)]).toEqual([0, 0, 0]);
  });
  it('starts the chain reads of the coins a pass will reach together, and reads no coin twice', async () => {
    const db = await open(), launches = [address(0xa2), address(0xa3), address(0xa4)], calls: string[] = [];
    for (const [i, token] of launches.entries()) {
      await other(db, token, 990 + i, i + 1);
      await swap(db, 995, 1200 + i, 1, '10', { coin: binary(token) }); await transfer(db, 995, 1200 + i, manager, buyer, '10', token);
    }
    await swap(db, 900, 1210, 1, '10'); await transfer(db, 900, 1210, manager, buyer, '10');
    // Every read answers only after all four coins' facts were asked for: one at a time, the first would never answer.
    let asked = 0, release!: () => void;
    const all = new Promise<void>(resolve => { release = resolve; });
    const slow: OnboardingChain = { ...chain(facts, mint, calls), facts: async token => { calls.push(`facts:${token}`); if (++asked === 4) release(); await all; return facts; } };
    const worker = new CoinOnboardingWorker(db, slow, () => undefined, { now: () => now, assets, addresses });
    await worker.tick();
    for (const token of [coin, ...launches]) expect(await deployer(db, token)).toBe(launcher);
    // One read of each coin's facts and first mint, and one of the launch wallet's transaction count for all four.
    expect(calls.filter(call => call.startsWith('facts:')).sort()).toEqual([coin, ...launches].map(token => `facts:${token}`).sort());
    expect(calls.filter(call => call.startsWith('mint:'))).toHaveLength(4);
    expect(calls.filter(call => call.startsWith('sent:'))).toEqual([`sent:${launcher}`]);
  });
  it('goes on to the next coin when one coin\'s read fails, and leaves that coin alone for five minutes', async () => {
    const db = await open(), launch = address(0xa2), events: string[] = [];
    await other(db, launch, 990, 1);
    await swap(db, 900, 1100, 1, '10'); await transfer(db, 900, 1100, manager, buyer, '10');
    await swap(db, 995, 1101, 1, '10', { coin: binary(launch) }); await transfer(db, 995, 1101, manager, buyer, '10', launch);
    // The newer launch is read first; its read fails (the public endpoint answered the box with 403s on 2026-10-13).
    let clock = now, reads = 0;
    const failing: OnboardingChain = { ...chain(facts, mint), facts: async token => { if (token === launch) { reads++; throw new Error('HTTP 403'); } return facts; } };
    const worker = new CoinOnboardingWorker(db, failing, event => events.push(event), { now: () => clock, assets, addresses });
    await worker.tick();
    expect([await deployer(db, coin), await deployer(db, launch), reads]).toEqual([launcher, null, 1]);
    expect(events).toEqual(['coin_onboarding_failed', 'coin_onboarding']);
    clock += 60_000; await worker.tick();
    expect(reads).toBe(1);
    clock += 300_000; await worker.tick();
    expect(reads).toBe(2);
  });
  it('tries a coin again on the next pass when its statement lost a deadlock', async () => {
    const db = await open(), events: string[] = [];
    await swap(db, 900, 1300, 1, '10'); await transfer(db, 900, 1300, manager, buyer, '10');
    // 2026-10-13: a busy coin's candle rebuild deadlocked with the indexer's write and the coin was left for five minutes.
    let lost = 0;
    const contended: OnboardingChain = { ...chain(facts, mint), sent: async () => { if (!lost++) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return 12; } };
    const worker = new CoinOnboardingWorker(db, contended, event => events.push(event), { now: () => now, assets, addresses });
    await worker.tick();
    expect([await deployer(db, coin), events]).toEqual([null, ['coin_onboarding_retry', 'coin_onboarding']]);
    await worker.tick();
    expect(await deployer(db, coin)).toBe(launcher);
  });
  it('searches for the first mint in windows the endpoint accepts, and stops reading once the day\'s reads are spent', async () => {
    const { chainOnboarding, OnboardingReadsSpent } = await import('../src/coin-onboarding.js');
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', mintLog = (block: number) => ({ blockNumber: `0x${block.toString(16)}`, logIndex: '0x1', transactionHash: hash(block), topics: [TRANSFER, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${launcher.slice(2)}`] });
    const fixture = (mints: number[], limit = 100) => {
      const requests: string[] = [];
      const client = { request: async ({ method, params }: { method: string; params: unknown[] }) => {
        requests.push(method);
        if (method === 'eth_getLogs') { const f = params[0] as { fromBlock: string; toBlock: string }; expect(Number(BigInt(f.toBlock) - BigInt(f.fromBlock))).toBeLessThanOrEqual(100_000);
          return mints.filter(n => n >= Number(BigInt(f.fromBlock)) && n <= Number(BigInt(f.toBlock))).map(mintLog); }
        if (method === 'eth_getTransactionByHash') return { from: launcher, to: buyer };
        throw new Error(`unexpected ${method}`);
      } };
      return { requests, chain: chainOnboarding(() => client as never, undefined, limit, () => now) };
    };
    // Minted 150,000 blocks before its first pool: found in the second window, confirmed by the third.
    const old = fixture([850_000]);
    expect(await old.chain.firstMint(coin, 1_000_000n)).toMatchObject({ wallet: launcher, to: buyer, block: 850_000n });
    expect(old.requests).toEqual(['eth_getLogs', 'eth_getLogs', 'eth_getLogs', 'eth_getTransactionByHash']);
    // A token that mints in every window: its first mint is not established. One with none nearby: none.
    expect(await fixture([999_000, 880_000, 760_000]).chain.firstMint(coin, 1_000_000n)).toBeNull();
    expect(await fixture([]).chain.firstMint(coin, 1_000_000n)).toBeNull();
    // Two reads allowed today: the third is refused before it is sent.
    const capped = fixture([999_000], 2);
    await expect(capped.chain.firstMint(coin, 1_000_000n)).rejects.toBeInstanceOf(OnboardingReadsSpent);
    expect(capped.requests).toEqual(['eth_getLogs', 'eth_getLogs']);
  });
  it('reads token text returned as a string or as bytes32', () => {
    expect(decodeText('0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000444454d4f00000000000000000000000000000000000000000000000000000000')).toBe('DEMO');
    expect(decodeText('0x44454d4f00000000000000000000000000000000000000000000000000000000')).toBe('DEMO');
    expect(decodeText('0x')).toBeNull();
  });
});
