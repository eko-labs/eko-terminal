import { describe, expect, it } from 'vitest';
import { launchGroups } from '../src/bundles.js';
import { getAddress } from 'viem';
import { fx, nymo } from './fixtures/nymo.js';

const pct = (v: bigint) => Number(v * 10_000n / 10n ** 27n) / 100;
const PONS = { excluded: ['0xe33E9E479dF8802cb0866d5d05258bEc4cF62948', '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'], firstBlocks: 35, minWallets: 3 };

describe('bundles and copy traders at a launch', () => {
  it('finds the bundle by its one-transaction buy and follows the wallets it rotated into', () => {
    const { bundles } = launchGroups(nymo(), PONS);
    expect(bundles).toHaveLength(1);
    const [b] = bundles;
    expect(b!.oneTx).toMatchObject({ block: fx.launchBlock + 1, wallets: 2 });
    expect(b!.launchWallets.sort()).toEqual(['0x1fd3598b55ae38564d6c0c4cdfcb11d3a293cbac', '0x8a94ea7c8597673a3b7ff3406ec771852a37ef53']);
    expect(b!.wallets).toHaveLength(15);
    expect(pct(b!.bought)).toBeCloseTo(22.17, 1);
    expect(pct(b!.sold)).toBeCloseTo(22.17, 1);
    expect(b!.held).toBe(0n);
    expect(b!.lastSellBlock! - fx.launchBlock).toBe(901);
  });

  it('lists the passes between its wallets: each sold from one wallet and bought into a fresh one in the same transaction', () => {
    const [b] = launchGroups(nymo(), PONS).bundles;
    const r = b!.rotations;
    expect(r).toHaveLength(13);
    expect(r.every(x => x.how === 'swap' && b!.wallets.includes(x.from) && b!.wallets.includes(x.to) && x.from !== x.to && x.value > 0n)).toBe(true);
    expect(r.map(x => x.block)).toEqual([...r.map(x => x.block)].sort((p, q) => p - q));
    // Every wallet that did not buy at launch got its tokens passed to it, once, after the wallet that passed them.
    const into = r.map(x => x.to);
    expect(new Set(into).size).toBe(13);
    expect(b!.wallets.filter(w => !b!.launchWallets.includes(w)).sort()).toEqual([...into].sort());
    const firstIn = new Map(r.map(x => [x.to, x.block]));
    for (const x of r) if (firstIn.has(x.from)) expect(firstIn.get(x.from)!).toBeLessThan(x.block);
    expect(r[0]!.block - fx.launchBlock).toBe(39);
    expect(r.at(-1)!.block - fx.launchBlock).toBe(811);
    expect(pct(r[0]!.value)).toBeCloseTo(2.92, 2);
  });

  it('lists a plain transfer between its wallets as a pass too', () => {
    const c = nymo(), fresh = '0xabab'.padEnd(42, '1'), from = '0x8a94ea7c8597673a3b7ff3406ec771852a37ef53';
    c.flows.push({ tx: `0x${'7'.repeat(64)}`, block: fx.launchBlock + 60, ts: fx.launchTs + 6, from, to: fresh, value: 10n ** 24n });
    const [b] = launchGroups(c, PONS).bundles;
    expect(b!.wallets).toContain(fresh);
    expect(b!.rotations.find(x => x.to === fresh)).toMatchObject({ how: 'transfer', from, value: 10n ** 24n, block: fx.launchBlock + 60 });
  });

  it('does not read the graduation, which pays the launchpad fee to another wallet in the same transaction, as a bundle', () => {
    const { bundles } = launchGroups(nymo(), PONS);
    expect(bundles.flatMap(b => b.wallets)).not.toContain('0x74ab274b19f0989f9064f803e820b4e082bd058e');
  });

  it('groups the wallets that bought through one trading bot, each in its own transaction, as copy traders and not a bundle', () => {
    const { bundles, copyTraders } = launchGroups(nymo(), PONS);
    const bots = Object.fromEntries(copyTraders.map(g => [g.bot.slice(0, 10), g.wallets.length]));
    expect(bots).toMatchObject({ '0xf2c69db0': 13, '0x65050a9b': 9 });
    const bundled = new Set(bundles.flatMap(b => b.wallets));
    expect(copyTraders.flatMap(g => g.wallets).some(w => bundled.has(w))).toBe(false);
    const c = copyTraders.find(g => g.bot.startsWith('0x65050a9b'))!;
    expect(c.firstBlock).toBe(c.lastBlock); // one block, as a copy bot fans out its followers
  });

  it('leaves wallets that call the curve themselves, and public routers, out of any copy group', () => {
    const { copyTraders } = launchGroups(nymo(), PONS);
    expect(copyTraders.some(g => g.bot === fx.curve)).toBe(false);
    expect(launchGroups(nymo(), { ...PONS, publicRouters: ['0x65050a9b'.padEnd(42, '0'), copyTraders[0]!.bot] }).copyTraders.map(g => g.bot)).not.toContain(copyTraders[0]!.bot);
  });
});

describe('the bundle check on a real launch', () => {
  it('names the bundle apart from the copy traders and the rest of the first minute', async () => {
    const { flowStats } = await import('../src/holders.js');
    const { evaluatePlaybooks, reasonForMatch } = await import('@eko/playbooks');
    const { ROBINHOOD_PROFILE } = await import('../src/chains/profiles.js');
    const c = nymo(), cfg = ROBINHOOD_PROFILE.playbooks;
    // The chain's own lists (robinhoodExcluded, publicRouters): the curve, factory, Pons router and hook, PoolManager; Uniswap's routers.
    const excluded = [fx.curve, fx.factory, fx.manager, ...PONS.excluded].map(a => getAddress(a));
    const publicRouters = ['0x204FAca1764B154221e35c0d20aBb3c525710498', '0xCaf681a66D020601342297493863E78C959E5cb2', PONS.excluded[0]!];
    const stats = flowStats(c, { excluded, hypeUsd: 3000, launch: { firstBlocks: cfg.bundle_dump.firstBlocks, minWallets: cfg.bundle_dump.minWallets, publicRouters } });
    expect(stats.earlyBuyers.filter(b => b.bundled).length).toBeGreaterThan(0);
    const m = evaluatePlaybooks({ coin: c.token, deployer: c.creator, asOfBlock: c.block + 1200, asOfSec: c.ts + 130, createdAtSec: c.ts, createdAtBlock: c.block, launchpad: 'pons',
      name: 'Anonymo', symbol: 'NYMO', antiSnipeActive: false, simulations: [], holders: stats.holders, earlyBuyers: stats.earlyBuyers, dev: stats.dev,
      bundles: stats.bundles, copyTraders: stats.copyTraders, snipers: [], history: { launches: [] } } as never, cfg).find(x => x.id === 'bundle_dump')!;
    // Monitor: the bundle bought over 15% (all sold now); the first minute's other buyers hold 20.7% two minutes in.
    expect(m.level).toBe('monitor');
    const reason = reasonForMatch(m);
    expect(reason).toMatch(/^A bundle: 2 wallets bought 22\.2% of supply in one transaction at launch and passed it through 13 more; it has sold all of it within 9\d seconds\. \d+ other wallets, the deployer among them, bought /);
    expect(reason).toMatch(/\. 27 of those wallets were copy traders, not a bundle: they bought through 3 trading bots, each wallet in its own transaction; they bought 20\.3% and have sold 19%\.$/);
    // The rotated wallets are the bundle's, not separate early buyers.
    expect(m.evidence.filter(e => e.label === 'Early buyer').map(e => e.ref.toLowerCase())).not.toContain('0x404d3dc7e48d83ea4058ef1e9f0a864a04d2df48');
  });
});
