import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, rebuildBalances, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry } from '@eko/chain';
import { CoinCardSchema, type Address, type CoinCard, type PlaybookId } from '@eko/shared';
import { rules } from '@eko/playbooks';
import type { Hex } from 'viem';
import { evaluatedPlaybooks } from '../src/card.js';
import { loadSources } from '../src/sources.js';
import { EngineWorker, TRADED_RERATE_OTHER_SEC, TRADED_RERATE_SEC, staleRatings, tradedSinceCard } from '../src/worker.js';

// A coin that launched in a Uniswap pool, never on a Pons curve (about 3,500 traded in a day on 2026-10-13, none
// rated: no name, no launch wallet, no trader on any swap). Synthetic rows only.
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
const coin = address(0xa1), deployer = address(0xd1), zero = address(0), positions = address(0x50), pool = hash(0x41);
const manager = loadRegistry().requireAddress('uniswapV4.poolManager').toLowerCase() as Address;
// A hook address whose low bits allow it to change what a swap returns (afterSwap and its return delta).
const takingHook = `0x${'4e'.repeat(18)}0044` as Address, plainHook = `0x${'4e'.repeat(18)}0040` as Address;
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
let id = 1;
class Market {
  constructor(readonly db: ChainDb) {}
  async block(n: number, sec = n) { await this.db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: new Date((epoch + sec) * 1000) }); }
  async transfer(n: number, tx: Hex, from: Address, to: Address, amount: number) {
    await this.db.insert('token_transfers', { ts: new Date((epoch + n) * 1000), block: String(n), tx_hash: binary(tx), log_index: id++, token: binary(coin), from_address: binary(from), to_address: binary(to), amount: String(amount) });
  }
  /** A buy: the pool pays `amount` out and the buyer receives `received`. A sell: the seller sends `sent` and the pool receives `amount`. */
  async trade(n: number, side: 1 | -1, who: Address | null, amount: number, moved = amount, extra: Record<string, unknown> = {}) {
    const tx = hash(0x1000 + id++);
    await this.db.insert('swaps', { ts: new Date((epoch + n) * 1000), block: String(n), tx_hash: binary(tx), log_index: 0, venue: 'uniswap_v4', pool_id: binary(pool), coin: binary(coin), quote_asset: binary(zero),
      trader: who && binary(who), tx_from: null, tx_to: null, recipient: side === 1 && who ? binary(who) : null, side, amount_coin: String(amount), amount_quote: '100', price_quote: 1, usd: 10, priced_block: String(n), ...extra });
    if (who) await (side === 1 ? this.transfer(n, tx, manager, who, moved) : this.transfer(n, tx, who, manager, moved));
  }
  async liquidity(n: number, actor: Address, delta: number) {
    await this.db.insert('liquidity_events', { block: String(n), ts: new Date((epoch + n) * 1000), tx_hash: binary(hash(0x2000 + id++)), log_index: 0, venue: 'uniswap_v4', pool_id: binary(pool), kind: 'ModifyLiquidity',
      actor: binary(actor), data: JSON.stringify({ sender: positions, liquidityDelta: String(delta), tickLower: '-600', tickUpper: '600', salt: hash(1) }) });
  }
}
async function market(hooks: Address | null = takingHook) {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
  const m = new Market(db);
  for (const n of [1, 100, 200, 300]) await m.block(n);
  await db.insert('tokens', { address: binary(coin), deployer: binary(deployer), curve: null, name: 'Sample token', symbol: 'DEMO', launchpad: null, decimals: 0, total_supply: '1000000', supply_block: '1', first_block: '1', block: '1' });
  await db.insert('pools', { id: binary(pool), venue: 'uniswap_v4', currency0: binary(zero), currency1: binary(coin), fee: 3000, tick_spacing: 60, hooks: hooks && binary(hooks), creation_verified: true, created_block: '1', block: '1' });
  // The deployer mints the supply and pays most of it into the pool; the liquidity event carries its wallet.
  await m.transfer(1, hash(0x10), zero, deployer, 1_000_000); await m.transfer(1, hash(0x11), deployer, manager, 990_000); await m.liquidity(1, deployer, 5000);
  return m;
}
const buyers = [0xb1, 0xb2, 0xb3, 0xb4].map(address), sellers = [0xc1, 0xc2, 0xc3].map(address);
/** Four buys and three sells by different wallets after the first minute: 5% of each buy and 10% of each sell do not arrive. */
async function traded(m: Market) {
  for (const who of buyers) await m.trade(100, 1, who, 1000, 950);
  for (const who of sellers) { await m.transfer(100, hash(0x3000 + id++), manager, who, 600); await m.trade(200, -1, who, 450, 500); }
  await m.db.tx(tx => rebuildBalances(tx));
}

describe('a coin that launched on Uniswap', () => {
  it('runs every check from its own trades: sellers, measured tax, the pool it trades in and who paid in its liquidity', async () => {
    const m = await market(); await traded(m);
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.launchpad).toBe('other');
    expect(s.observedSellers).toMatchObject({ sellers: 3 });
    expect(s.taxes).toEqual({ buyPct: 5, sellPct: 10, mutable: null, changes: [] });
    expect(s.mainPool).toEqual({ id: pool, hooks: takingHook });
    expect(s.hook).toMatchObject({ address: takingHook, permissionBits: 0x44, returnDeltaPermissionBits: 4, quoteSimGapPct: null, buyFeePct: null, sellFeePct: null });
    expect(s.liquidity?.positions).toMatchObject([{ owner: deployer, controlledBy: 'deployer', share: 1, status: 'removable' }]);
    expect(evaluatedPlaybooks(s)).toEqual((Object.keys(rules) as PlaybookId[]).sort());
    await new EngineWorker(m.db, { now: () => epoch + 300, liveBacklogSec: 900 }).poll();
    const card = CoinCardSchema.parse((await m.db.sql.query<{ data: CoinCard }>('SELECT data FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0].data);
    const level = (playbook: PlaybookId) => card.playbooks.find(p => p.id === playbook)?.level;
    expect(card.identity).toMatchObject({ launchpad: 'other', stage: 'graduated' });
    expect([level('malicious_hook'), level('removable_liquidity'), level('tax_trap')]).toEqual(['monitor', 'monitor', 'monitor']);
    if (process.env.SHOW_CARD) console.log(JSON.stringify({ verdict: card.verdict.level, reasons: card.verdict.reasons, playbooks: card.playbooks.map(p => [p.id, p.level]), evaluated: card.verdict.evaluatedPlaybooks, supply: card.supply, liq: card.liquidity }, null, 1));
    expect(card.verdict.level).not.toBe('pending');
    expect(card.verdict.reasons.join(' ')).toContain('The deployer added 100% of this coin\'s pool liquidity; EKO does not check whether it is locked.');
    expect(card.verdict.reasons.join(' ')).toContain('EKO has not reviewed the hook');
    expect(card.tradeability).toMatchObject({ buyTaxPct: 5, sellTaxPct: 10 });
  });
  it('reads only the pool the coin trades in for its hook, and needs both sides of the market for a tax', async () => {
    const m = await market(plainHook);
    // Someone else opens a second pool with a hook that takes from swaps; nothing trades there.
    await m.db.insert('pools', { id: binary(hash(0x42)), venue: 'uniswap_v4', currency0: binary(zero), currency1: binary(coin), fee: 3000, tick_spacing: 60, hooks: binary(takingHook), creation_verified: true, created_block: '1', block: '1' });
    for (const who of buyers) await m.trade(100, 1, who, 1000);
    await m.db.tx(tx => rebuildBalances(tx));
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.mainPool).toEqual({ id: pool, hooks: plainHook });
    expect(s.hook).toMatchObject({ address: plainHook, returnDeltaPermissionBits: 0 });
    // Nobody has sold: no seller evidence and no sell tax, so neither check counts as run.
    expect(s.observedSellers).toBeUndefined(); expect(s.taxes).toBeUndefined();
    expect(evaluatedPlaybooks(s)).not.toEqual(expect.arrayContaining(['honeypot']));
    expect(evaluatedPlaybooks(s)).toEqual(expect.arrayContaining(['malicious_hook', 'migration_dump', 'stuck_at_bonding', 'exempt_insiders', 'run_up']));
  });
  it('does not count a buy that was delivered to nobody as an unknown buyer or an early buyer', async () => {
    const m = await market(null);
    // In the first minute: one wallet buys, and one swap moves no coins (a hop inside the pool manager).
    await m.trade(1, 1, buyers[0], 1000);
    await m.trade(1, 1, null, 5000, 0, { recipient: binary(manager) });
    await m.db.tx(tx => rebuildBalances(tx));
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.earlyBuyers?.map(b => b.wallet)).toEqual([buyers[0]]);
    expect(s.holders).toBeDefined();
    // The pool manager holds the pool's coins: never a holder, never a hook input here.
    expect(s.holders!.largest).toBe(buyers[0]); expect(s.hook).toBeUndefined();
  });
  it('has no deployer wallet when it was launched by a relayer: liquidity its own contract paid in is nobody\'s to flag', async () => {
    const m = await market(null);
    // The worker recorded the coin's own address as launch wallet, and the token contract paid the liquidity in.
    await m.db.sql.query('UPDATE tokens SET deployer=$1 WHERE address=$1', [binary(coin)]);
    await m.db.sql.query('UPDATE liquidity_events SET actor=$1', [binary(coin)]);
    await traded(m);
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.deployer).toBe(coin);
    expect(s.liquidity?.positions).toMatchObject([{ owner: coin, controlledBy: 'other' }]);
    expect(s.history.launches).toEqual([]);
    await new EngineWorker(m.db, { now: () => epoch + 300, liveBacklogSec: 900 }).poll();
    const card = CoinCardSchema.parse((await m.db.sql.query<{ data: CoinCard }>('SELECT data FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0].data);
    expect(card.playbooks.map(p => p.id)).not.toEqual(expect.arrayContaining(['removable_liquidity', 'dev_dump', 'serial_deployer']));
    expect(card.verdict.level).not.toBe('pending');
  });
  it('rates Danger when the deployer has taken its liquidity out, though no position is left to find', async () => {
    // 2026-10-13, a live launch: liquidity in, three buys (the first the deployer's own), all liquidity out ten seconds
    // later. The card read "pending" with the liquidity check not run, because nothing removable was left.
    const m = await market(null); await traded(m);
    await m.liquidity(200, deployer, -5000);
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.liquidity).toMatchObject({ positions: [], pulled: { share: 1, by: 'deployer', wallet: deployer } });
    await new EngineWorker(m.db, { now: () => epoch + 300, liveBacklogSec: 900 }).poll();
    const card = CoinCardSchema.parse((await m.db.sql.query<{ data: CoinCard }>('SELECT data FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0].data);
    expect(card.verdict.level).toBe('danger');
    expect(card.playbooks.find(p => p.id === 'removable_liquidity')?.level).toBe('danger');
    expect(card.verdict.reasons).toContain("The deployer took all the liquidity it had added out of this coin's pool.");
  }, 20_000);
  it('rates Danger when the wallet that paid in the launch liquidity takes it out, though no deployer wallet is identified', async () => {
    // The rug factories of 2026-10-13 launch through wallets seen launching dozens of coins, recorded with no deployer wallet.
    const m = await market(null), factory = address(0xfa);
    await m.db.sql.query('UPDATE tokens SET deployer=$1 WHERE address=$1', [binary(coin)]);
    await m.db.sql.query('UPDATE liquidity_events SET actor=$1', [binary(factory)]);
    await traded(m);
    await m.liquidity(200, factory, -5000);
    const s = (await loadSources(m.db, coin, 300))!;
    expect(s.liquidity).toMatchObject({ positions: [], pulled: { share: 1, by: 'provider', wallet: factory } });
    await new EngineWorker(m.db, { now: () => epoch + 300, liveBacklogSec: 900 }).poll();
    const card = CoinCardSchema.parse((await m.db.sql.query<{ data: CoinCard }>('SELECT data FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0].data);
    expect(card.verdict.level).toBe('danger');
    expect(card.verdict.reasons).toContain("The wallet that added this coin's launch liquidity took all of it out of the pool.");
    // The same removal followed by liquidity in another pool of the coin is a move to that pool, not a pull.
    const moved = await market(null), second = hash(0x43);
    await moved.db.sql.query('UPDATE liquidity_events SET actor=$1', [binary(factory)]);
    await traded(moved);
    await moved.liquidity(200, factory, -5000);
    await moved.db.insert('pools', { id: binary(second), venue: 'uniswap_v4', currency0: binary(zero), currency1: binary(coin), fee: 3000, tick_spacing: 60, hooks: null, creation_verified: true, created_block: '200', block: '200' });
    await moved.db.insert('liquidity_events', { block: '200', ts: new Date((epoch + 200) * 1000), tx_hash: binary(hash(0x2fff)), log_index: 0, venue: 'uniswap_v4', pool_id: binary(second), kind: 'ModifyLiquidity',
      actor: binary(factory), data: JSON.stringify({ sender: positions, liquidityDelta: '5000', tickLower: '-600', tickUpper: '600', salt: hash(2) }) });
    expect((await loadSources(moved.db, coin, 300))!.liquidity?.pulled).toBeUndefined();
  }, 20_000);
  it('does not call it a pull when the deployer puts the liquidity back, or when another provider leaves', async () => {
    // Half out and half back in: the deployer's liquidity is back at its peak.
    const again = await market(null); await traded(again);
    await again.liquidity(200, deployer, -2500); await again.liquidity(200, deployer, 2500);
    expect((await loadSources(again.db, coin, 300))!.liquidity?.pulled).toBeUndefined();
    // Someone else removing their own liquidity is not the deployer's pull either.
    const other = await market(null); await traded(other);
    await other.liquidity(150, buyers[0], 4000); await other.liquidity(200, buyers[0], -4000);
    expect((await loadSources(other.db, coin, 300))!.liquidity?.pulled).toBeUndefined();
  }, 20_000);
  it('re-rates a quiet card written before the liquidity check could see a pull, once', async () => {
    const m = await market(null); await traded(m);
    await new EngineWorker(m.db, { now: () => epoch + 300, liveBacklogSec: 900 }).poll();
    await m.db.sql.query('SELECT refresh_read_models($1::bytea[],$2::bigint)', [[binary(coin)], epoch + 300]);
    const card = (await m.db.sql.query<{ card_id: string }>('SELECT card_id FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0].card_id;
    // Not selected without the cutoff, selected when the card was written before it, and not again once re-rated.
    expect(await staleRatings(m.db, [coin], 10)).toEqual([]);
    const cutoff = new Date(Date.now() + 3_600_000).toISOString();
    expect(await staleRatings(m.db, [coin], 10, new Map(), undefined, cutoff)).toEqual([{ coin, card }]);
    expect(await staleRatings(m.db, [coin], 10, new Map([[coin, card]]), undefined, cutoff)).toEqual([]);
    expect(await staleRatings(m.db, [coin], 10, new Map(), undefined, new Date(Date.now() - 3_600_000).toISOString())).toEqual([]);
  });
  it('re-rates a traded coin without a curve less often than a Pons coin', async () => {
    const m = await market(); await traded(m);
    await new EngineWorker(m.db, { now: () => epoch + 200, liveBacklogSec: 900 }).poll();
    await m.block(400, 400); await m.trade(400, 1, buyers[0], 100);
    await m.db.sql.query('SELECT refresh_read_models($1::bytea[],$2::bigint)', [[binary(coin)], epoch + 400]);
    const card = (await m.db.sql.query<{ as_of_block: string }>('SELECT as_of_block::text FROM coin_card_latest WHERE coin=$1', [binary(coin)])).rows[0];
    const cardSec = epoch + Number(card.as_of_block);
    // Settled for a Pons coin's interval, not yet for this one's.
    expect(await tradedSinceCard(m.db, epoch - 86400, cardSec + 1, 10)).toEqual([]);
    expect(await tradedSinceCard(m.db, epoch - 86400, cardSec + TRADED_RERATE_OTHER_SEC - TRADED_RERATE_SEC + 1, 10)).toHaveLength(1);
  });
});
