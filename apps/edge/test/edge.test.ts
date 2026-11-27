import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { CoinCardSchema, PairRowSchema, PublicConfigSchema, RadarResponseSchema, RadarRowSchema, ScanResultSchema, ScoreboardResponseSchema, VerdictSchema } from '@eko/shared';
import launch from '../../../packages/chain/test/fixtures/99901/montra-launch.json' with { type: 'json' };
import { barsFromTrades, changePct, priceHypeFromSqrt, spark, tradeFromSwap, type Trade } from '../src/market.js';
import { hookBits, judge, type Assessment } from '../src/assess.js';
import { chainOf } from '../src/chains/elysium/index.js';
import { swapAbi, Tracker, TRANSFER_TOPIC, type Rpc } from '../src/tracker.js';
import { flowStats } from '../src/holders.js';
import { findSnipers, type Sniper } from '../src/snipers.js';
import { CONFIG_V1, launchSnipers, reasonForMatch, type CardSources } from '@eko/playbooks';
import { coinCard, pairColumn, pairRow, publicConfig, radarRow } from '../src/views.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';

const registry = loadElysiumRegistry();
const token = getAddress(launch.launch.args.token), poolId = launch.launch.args.poolId as Hex, launchBlock = Number(launch.launch.blockNumber);
// sqrtPriceX96 of the launch's first swap, captured from mainnet with the launch.
const SQRT = 376704063821928778106310921211621n;

const LAUNCH_TX = launch.launch.transactionHash as Hex, SELL_TX = keccak256(toHex('sell')), creator = getAddress(launch.launch.args.creator);
const pm = registry.address('uniswapV4.poolManager');
function swapLog(block: number, amount0: bigint, amount1: bigint, tx: Hex, index: number) {
  const topics = encodeEventTopics({ abi: swapAbi, eventName: 'Swap', args: { id: poolId, sender: '0x00000000000000000000000000000000000000a1' } }) as Hex[];
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, SQRT, 1n, 0, 0]);
  return { address: pm, topics, data, blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(index) };
}
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
function transferLog(block: number, from: string, to: string, value: bigint, tx: Hex, index: number) {
  return { address: token.toLowerCase(), topics: [TRANSFER_TOPIC, pad(from), pad(to)] as Hex[], data: toHex(value, { size: 32 }), blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(index) };
}
const FIRST_BUY = BigInt(launch.launch.args.firstBuyOut), SOLD = 447412197279119426050332n;

/** A chain whose only activity is the captured launch plus two swaps (a buy, then a sell). */
function fakeChain(head: number): Rpc {
  const launchLog = { ...launch.launch, blockNumber: toHex(launchBlock), logIndex: toHex(Number(launch.launch.logIndex)) };
  // As on mainnet, the mint and the creator's first buy are logged before TokenLaunched in the launch transaction.
  const swaps = [swapLog(launchBlock, -970200000000000000n, FIRST_BUY, LAUNCH_TX, 1), swapLog(launchBlock + 128, 20190855456216277n, -SOLD, SELL_TX, 1)];
  const transfers = [transferLog(launchBlock, '0x0000000000000000000000000000000000000000', registry.address('montra.hook'), BigInt(launch.launch.args.supply), LAUNCH_TX, 0),
    transferLog(launchBlock, pm, creator, FIRST_BUY, LAUNCH_TX, 2), transferLog(launchBlock + 128, creator, pm, SOLD, SELL_TX, 2)];
  return { request: async ({ method, params }) => {
    if (method === 'eth_blockNumber') return toHex(head);
    if (method === 'eth_getBlockByNumber') return { timestamp: toHex(1_794_330_000 + Number(BigInt(params[0] as string)) - launchBlock) };
    if (method === 'eth_getLogs') {
      const f = params[0] as { address?: string | string[]; topics?: unknown[]; fromBlock: Hex; toBlock: Hex };
      const inRange = (l: { blockNumber: Hex }) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock);
      // The tracker's launch call filters by a list of topics (any launchpad), with no address.
      if (!f.address && Array.isArray(f.topics?.[0])) return [launchLog].filter(inRange);
      if (!f.address) return transfers.filter(inRange);
      // Swaps: the tracker asks every PoolManager it follows (Uniswap's and the unbranded launcher's fork) at once.
      if (Array.isArray(f.address)) return f.address.some(a => a.toLowerCase() === registry.address('uniswapV4.poolManager').toLowerCase()) ? swaps.filter(inRange) : [];
      if (f.address.toLowerCase() === registry.address('uniswapV4.poolManager').toLowerCase()) return swaps.filter(inRange);
      return [];
    }
    throw new Error(`unexpected ${method}`);
  } };
}

describe('market maths', () => {
  it('prices a HYPE/coin pool and reads buy and sell signs as checked on mainnet', () => {
    const p = priceHypeFromSqrt(SQRT);
    expect(p).toBeGreaterThan(4.3e-8); expect(p).toBeLessThan(4.5e-8);
    const base = { sqrtPriceX96: SQRT, sender: '0x00000000000000000000000000000000000000a1' as const, tx: '0x01' as Hex, block: 1, ts: 100 };
    expect(tradeFromSwap({ ...base, amount0: -(10n ** 18n), amount1: 5n * 10n ** 18n })).toMatchObject({ side: 'buy', hype: 1, tokens: 5 });
    expect(tradeFromSwap({ ...base, amount0: 10n ** 18n, amount1: -5n * 10n ** 18n })?.side).toBe('sell');
    expect(tradeFromSwap({ ...base, amount0: 1n, amount1: 1n })).toBeNull();
  });
  it('shows price per whole token and circulating supply at the coin\'s own decimals (Pangea: 9)', async () => {
    const { unitScale } = await import('../src/views.js');
    expect(unitScale({})).toBe(1); expect(unitScale({ decimals: 9 })).toBeCloseTo(1e-9);
    const t = (ts: number, priceHype: number): Trade => ({ ts, block: ts, tx: '0x01', sender: '0x00000000000000000000000000000000000000a1', side: 'buy', hype: 1, tokens: 1, priceHype });
    // One ETH per 1e18 base units at $1,800 is $0.0000018 a token when a token is 1e9 base units.
    expect(barsFromTrades([t(60, 1)], '1m', 1800, 0, 100, unitScale({ decimals: 9 }))[0]!.c).toBeCloseTo(1.8e-6);
  });
  it('builds USD bars, change and a sparkline from trades', () => {
    const t = (ts: number, priceHype: number, hype: number): Trade => ({ ts, block: ts, tx: '0x01', sender: '0x00000000000000000000000000000000000000a1', side: 'buy', hype, tokens: 1, priceHype });
    const trades = [t(60, 1, 1), t(90, 2, 1), t(130, 1.5, 2)];
    // The second bar opens at the first one's close (20), so its single trade at 15 shows as a body, not a sliver.
    expect(barsFromTrades(trades, '1m', 10, 0, 200)).toEqual([{ ts: 60, o: 10, h: 20, l: 10, c: 20, vUsd: 20 }, { ts: 120, o: 20, h: 20, l: 15, c: 15, vUsd: 20 }]);
    // A window that starts after a trade still opens from that trade's price.
    expect(barsFromTrades(trades, '1m', 10, 100, 200)).toEqual([{ ts: 120, o: 20, h: 20, l: 15, c: 15, vUsd: 20 }]);
    expect(changePct(trades, 60)).toBeCloseTo(50);
    expect(spark(trades, 200, 200, 4)).toEqual([1, 2, 1.5, 1.5]);
  });
  it('reads a v4 hook\'s permission bits from its address', () => {
    expect(hookBits(registry.address('montra.hook'))).toEqual({ permissionBits: 0x38ec, returnDeltaPermissionBits: 0xc });
  });
});

describe('tracker', () => {
  it('replays a launch and its swaps into one coin with trades, buyers and a feed item', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!;
    expect(coin).toMatchObject({ creator: getAddress(launch.launch.args.creator), poolId, block: launchBlock, graduated: false });
    expect(coin.trades.map(t => t.side)).toEqual(['buy', 'sell']);
    // The first buy and the mint come before TokenLaunched in the same transaction and are still kept.
    expect(coin.flows).toHaveLength(3);
    expect(tracker.feed.map(e => e.kind)).toEqual(['new_pair']);
    await tracker.tick();
    expect(coin.trades).toHaveLength(2);
  });
  it('turns transfers into holders, the early cohort and the deployer\'s trading', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, supply = Number(BigInt(launch.launch.args.supply));
    const stats = flowStats(coin, { excluded: [pm, registry.address('montra.hook')], hypeUsd: 70 });
    const held = Number(FIRST_BUY - SOLD) / supply;
    expect(stats.buyers).toBe(1);
    expect(stats.holders.top10Share).toBeCloseTo(held, 5);
    expect(stats.holders.largest).toBeNull();
    expect(stats.earlyBuyers).toEqual([expect.objectContaining({ wallet: creator, deployer: true, boughtShare: expect.closeTo(Number(FIRST_BUY) / supply, 5) })]);
    expect(stats.dev).toMatchObject({ heldShare: expect.closeTo(held, 5), soldShare: expect.closeTo(Number(SOLD) / supply, 5), firstSellSec: coin.trades[1]!.ts - coin.ts,
      cashInUsd: expect.closeTo(0.9702 * 70, 3), cashOutUsd: expect.closeTo(0.020190855456216277 * 70, 3) });
  });
  it('splits a span the provider refuses as too wide, then keeps the smaller size', async () => {
    const inner = fakeChain(launchBlock + 500);
    let refused = 0;
    const picky: Rpc = { request: async (i) => {
      const f = (i.params[0] ?? {}) as { fromBlock?: Hex; toBlock?: Hex };
      if (i.method === 'eth_getLogs' && BigInt(f.toBlock!) - BigInt(f.fromBlock!) >= 100n) { refused++; throw new Error('ranges over 10000 blocks are not supported on free plan'); }
      return inner.request(i);
    } };
    const tracker = new Tracker(picky, registry, { backfillBlocks: 600, chunk: 400 });
    await tracker.start();
    expect(refused).toBeGreaterThan(0);
    expect(tracker.coin(token)?.trades).toHaveLength(2);
  });
});

function assessment(level: 'clear' | 'danger'): Assessment {
  const id = `pending:${token.toLowerCase()}:${launchBlock}`;
  const honeypot = { id: 'honeypot' as const, level: 'danger' as const, confidence: 1, evidence: [] };
  const verdict = { coin: token, level, reasons: level === 'danger' ? ['Honeypot'] : [], playbooks: level === 'danger' ? [honeypot] : [],
    receipt: { id, hash: keccak256(toHex(id)), status: 'pending' as const }, schemaVersion: 'verdict-1', asOfBlock: launchBlock, lastChecked: { block: launchBlock, at: '2026-11-10T12:00:00.000Z' } };
  return { coin: token, block: launchBlock, at: '2026-11-10T12:00:00.000Z', name: 'Test coin', symbol: 'TEST', key: null,
    config: { totalFeePips: 20000, lpFeePips: 0, protocolFeePips: 4000, liquiditySealed: false, seeded: true, feeLocked: false, earlyBuyFeeUntil: 0, stage: 0 },
    currentBuyFeePips: 20000, antiSnipe: null, probeUsd: 1000, matches: verdict.playbooks,
    stats: { holders: { top10Share: 0.12, largestShare: 0.04, largest: null, transferredShare: 0, transferredWallets: 0, evidence: [] }, earlyBuyers: [], bundles: [], copyTraders: [],
      dev: { heldShare: 0.02, cashInUsd: 70, cashOutUsd: 0, soldShare: 0, firstSellSec: null, evidence: [] }, buyers: 7, holderCount: 9 },
    probe: { method: 'sell-check-1', venue: 'uniswap_v4', routeId: 'x', block: String(launchBlock), sizeWei: '1', status: level === 'danger' ? 'sell_failed' : 'sellable',
      reason: level === 'danger' ? 'sell_reverted' : null, spentWei: '100', tokens: '5', returnedWei: level === 'danger' ? '0' : '98', quotedSellWei: null, exitCostPct: level === 'danger' ? 100 : 2, revert: null, requests: 1 },
    verdict };
}

describe('views match the web app\'s contracts', () => {
  it('builds a valid card, radar row and pair row, and refuses buys on a honeypot', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, ctx = { nowSec: coin.ts + 600, head: launchBlock + 500, hypeUsd: 70 };
    for (const level of ['clear', 'danger'] as const) {
      const card = CoinCardSchema.parse(coinCard(coin, assessment(level), ctx));
      expect(card.tradeability.honeypot).toBe(level === 'danger');
      expect(card.liquidity.lpStatus).toBe('locked');
      expect(card.identity).toMatchObject({ launchpad: 'montra', quoteAsset: 'HYPE' });
      expect(BigInt(card.supply.circulating)).toBe(coin.supply / 10n ** 18n);
    }
    // Montra coins have no bonding curve, so no curve %; a Pons curve coin carries its way to graduation (coin page Venue row).
    expect(coinCard(coin, undefined, ctx).identity.curvePct).toBeUndefined();
    const curveCoin = { ...coin, launchpad: 'pons' as const, graduated: false, curve: { address: coin.token, graduationThreshold: 4_200_000_000_000_000_000n, realQuoteReserve: 1_050_000_000_000_000_000n, realTokenReserve: 1n } };
    expect(CoinCardSchema.parse(coinCard(curveCoin, undefined, { ...ctx, native: 'ETH' })).identity).toMatchObject({ stage: 'curve', curvePct: 25, quoteAsset: 'ETH' });
    expect(coinCard({ ...curveCoin, graduated: true }, undefined, ctx).identity.curvePct).toBeUndefined();
    const row = RadarResponseSchema.shape.rows.element.parse(radarRow(coin, assessment('danger'), ctx, 1));
    expect(row).toMatchObject({ verdict: 'danger', hardDanger: true, sellCheck: { status: 'refused' }, trades1h: 2 });
    expect(PairRowSchema.parse(pairRow(coin, undefined, ctx))).toMatchObject({ column: 'new', verdictPending: true, buyers: 0 });
    expect(PairRowSchema.parse(pairRow(coin, assessment('clear'), ctx))).toMatchObject({ buyers: 7, top10Pct: 12, devPct: 2 });
    expect(pairColumn({ ...coin, graduated: true }, ctx)).toBe('migrated');
    expect(PublicConfigSchema.parse(publicConfig()).trading.liveEnabled).toBe(false);
  });

  it('gives every judged row, pair and card the EKO score, in the band of its verdict', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, ctx = { nowSec: coin.ts + 600, head: launchBlock + 500, hypeUsd: 70 };
    const band = { clear: 'ok', danger: 'danger' } as const, range = { clear: [70, 100], danger: [0, 10] } as const;
    for (const level of ['clear', 'danger'] as const) {
      const row = RadarRowSchema.parse(radarRow(coin, assessment(level), ctx, 1)), pair = PairRowSchema.parse(pairRow(coin, assessment(level), ctx));
      const card = CoinCardSchema.parse(coinCard(coin, assessment(level), ctx));
      expect(row.ekoScore).toBeDefined();
      expect(row.ekoScore!.band).toBe(band[level]);
      expect(row.ekoScore!.value).toBeGreaterThanOrEqual(range[level][0]); expect(row.ekoScore!.value).toBeLessThanOrEqual(range[level][1]);
      // One score per coin, whichever view carries it.
      expect(pair.ekoScore).toEqual(row.ekoScore); expect(card.ekoScore).toEqual(row.ekoScore);
    }
    const clear = radarRow(coin, assessment('clear'), ctx, 1).ekoScore!;
    // Holders (12% top ten, 2% dev) and a 2% exit cost were measured; the hour's trades and the pool were too.
    expect(clear.parts).toMatchObject({ holders: 97, exit: 96 }); expect(clear.missing ?? []).not.toContain('holders');
    expect(clear.cappedBy).toBeUndefined();
    const danger = radarRow(coin, assessment('danger'), ctx, 1).ekoScore!;
    expect(danger).toMatchObject({ cap: 10, cappedBy: 'Sell check refused', parts: { exit: 0 } });
    // Pending: no score anywhere.
    expect(radarRow(coin, undefined, ctx, 1).ekoScore).toBeUndefined();
    expect(coinCard(coin, undefined, ctx).ekoScore).toBeUndefined();
  });
});

describe('judge', () => {
  it('recomputes the verdict from transfers as the coin trades, with no new RPC call', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, fixture = assessment('clear');
    const probed = { block: launchBlock, at: new Date(coin.ts * 1000).toISOString(), name: 'Test coin', symbol: 'TEST', key: null,
      config: fixture.config, currentBuyFeePips: 20000, probe: fixture.probe, probeUsd: 1000, tips: {} };
    const ctx = { chain: chainOf(registry), hypeUsd: 70, nowSec: coin.ts + 600, head: launchBlock + 500 };
    expect(judge(coin, probed, ctx).verdict.level).toBe('clear');
    // The deployer buys a quarter of the supply in the first minute and keeps it.
    const tx = keccak256(toHex('dev-buy')), quarter = BigInt(launch.launch.args.supply) / 4n;
    coin.trades.push({ ts: coin.ts + 20, block: launchBlock + 180, tx, sender: '0x00000000000000000000000000000000000000a1', side: 'buy', hype: 5, tokens: Number(quarter) / 1e18, priceHype: 1e-8 });
    coin.flows.push({ tx, block: launchBlock + 180, ts: coin.ts + 20, from: pm.toLowerCase(), to: creator.toLowerCase(), value: quarter });
    const after = judge(coin, probed, ctx);
    expect(after.verdict.level).toBe('danger');
    expect(after.verdict.playbooks.map(m => `${m.id}:${m.level}`)).toEqual(expect.arrayContaining(['dev_dump:danger', 'holder_concentration:monitor']));
  });
});

describe('launch snipers', () => {
  it('finds non-deployer buyers in the first second, with their priority fee, and grades what they still hold', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, excluded = [pm, registry.address('montra.hook')];
    // Only the deployer bought at launch: no snipers.
    expect(findSnipers(coin, excluded)).toEqual([]);
    const bot = '0x00000000000000000000000000000000000000b0', tx = keccak256(toHex('snipe')), supply = BigInt(launch.launch.args.supply);
    coin.trades.push({ ts: coin.ts + 1, block: launchBlock + 3, tx, sender: '0x00000000000000000000000000000000000000a1', side: 'buy', hype: 9, tokens: 1, priceHype: 1e-8 });
    coin.flows.push({ tx, block: launchBlock + 3, ts: coin.ts + 1, from: pm.toLowerCase(), to: bot, value: (supply * 30n) / 100n });
    const snipers = findSnipers(coin, excluded, { [tx]: 441.47 });
    expect(snipers).toEqual([expect.objectContaining({ wallet: getAddress(bot), block: launchBlock + 3, boughtShare: 0.3, heldShare: 0.3, tipGwei: 441.47 })]);
    const graded = (list: Sniper[], asOfBlock = launchBlock + 500) => launchSnipers.evaluate({ coin: coin.token, asOfBlock, snipers: list } as unknown as CardSources, { launches: [] }, CONFIG_V1.launch_snipers);
    const m = graded(snipers)!;
    expect(m.level).toBe('danger');
    expect(reasonForMatch(m)).toBe('1 wallet bought 30% of supply within a second of launch, paying priority fees up to 441.47 gwei; it still holds 30%.');
    expect(graded([{ ...snipers[0]!, boughtShare: 0.01, heldShare: 0.01 }])!.level).toBe('info');
    expect(graded([{ ...snipers[0]!, boughtShare: 0.3, heldShare: 0.02 }])!.level).toBe('monitor');
  });
});

describe('server', () => {
  it('answers the web app\'s routes from memory and refuses what it does not serve', async () => {
    const rpc = fakeChain(launchBlock + 500);
    const tracker = new Tracker(rpc, registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const hype = new HypeUsd(async () => new Response(JSON.stringify({ HYPE: '70' })));
    await hype.get();
    const edge = new Edge(tracker, rpc, registry, hype, { now: () => (tracker.coin(token)!.ts + 60) * 1000 });
    const fixture = assessment('clear');
    // A cached probe; the verdict is judged from it and the coin's transfers.
    edge.probes.set(token.toLowerCase(), { block: launchBlock, at: new Date((tracker.coin(token)!.ts + 30) * 1000).toISOString(), name: 'Test coin', symbol: 'TEST',
      key: null, config: fixture.config, currentBuyFeePips: 20000, probe: fixture.probe, probeUsd: 1000, tips: {} });
    const app = buildServer(edge);
    const get = async (url: string) => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.json() }; };
    expect(RadarResponseSchema.parse((await get('/v2/radar')).body).rows[0]).toMatchObject({ address: token.toLowerCase(), verdict: 'clear' });
    // One coin's row for its page, the same as its row in the list; null for a coin the edge does not follow.
    const one = (await get(`/v1/radar/${token}`)).body.row;
    expect(one.address.toLowerCase()).toBe(token.toLowerCase()); expect(one.verdict).toBe('clear');
    expect((await get('/v1/radar/0x000000000000000000000000000000000000dEaD')).body).toEqual({ row: null });
    expect(CoinCardSchema.parse((await get(`/v1/coins/${token}`)).body).identity.address).toBe(token.toLowerCase());
    expect(VerdictSchema.parse((await get(`/v1/coins/${token}/verdict`)).body).level).toBe('clear');
    expect((await get(`/v2/coins/${token}`)).body).toEqual({ version: 2, card: null });
    expect((await get(`/v1/coins/${token}/candles?tf=1m&from=0`)).body.bars.length).toBeGreaterThan(0);
    // Share metadata for a coin page; an empty 204 for anything else (no 404 noise in the browser console).
    const share = await app.inject({ method: 'GET', url: `/v1/share-meta?path=${encodeURIComponent(`/coin/${token}`)}`, headers: { host: 'ekoterminal.test' } });
    expect(share.statusCode).toBe(200);
    expect(share.json()).toMatchObject({ title: expect.stringMatching(/^\$.+ · No flags · EKO$/), url: `http://ekoterminal.test/coin/${token}` });
    // A Clear grade on part of the coin's history reads as the coin page's chip does, not "No flags".
    const graded = edge.assessment(token)!, partly = { ...graded, verdict: { ...graded.verdict, historyPartial: { since: '2026-01-01T00:00:00.000Z' } } };
    const spy = vi.spyOn(edge, 'assessment').mockReturnValue(partly);
    const partlyShare = await app.inject({ method: 'GET', url: `/v1/share-meta?path=${encodeURIComponent(`/coin/${token}`)}` });
    expect(partlyShare.json()).toMatchObject({ title: expect.stringMatching(/^\$.+ · Partly checked · EKO$/), description: expect.stringMatching(/^Partly checked on EKO's checks/) });
    spy.mockRestore();
    expect((await app.inject({ method: 'GET', url: '/v1/share-meta?path=/scan/x' })).statusCode).toBe(204);
    // The header search: the ticker (with or without $), a prefix of it, the address; nothing for no match or no query.
    const sym = 'TEST';
    for (const q of [sym, '$' + sym.toLowerCase(), sym.slice(0, 2), token]) {
      const found = (await get('/v1/search?q=' + encodeURIComponent(q))).body.rows as { address: string }[];
      expect(found.map(r => r.address.toLowerCase())).toEqual([token.toLowerCase()]);
    }
    expect((await get('/v1/search?q=zzzz-nothing')).body.rows).toEqual([]);
    expect((await get('/v1/search')).body.rows).toEqual([]);
    // A scan by address, ticker or name answers with the coin's card; GET, POST and a share link agree.
    for (const res of [await get(`/v1/scan?q=${token}`), await get('/v1/scan?q=%24TEST'), await get(`/v1/scan/${token}`),
      { status: 200, body: (await app.inject({ method: 'POST', url: '/v1/scan', payload: { query: 'test' } })).json() }]) {
      const result = ScanResultSchema.parse(res.body);
      expect(result).toMatchObject({ status: 'ready', id: expect.stringMatching(new RegExp(`^${token}$`, 'i')) });
      expect(result.card?.identity.address.toLowerCase()).toBe(token.toLowerCase());
    }
    // A coin the edge does not follow, or no match at all, says why plainly (never the catch-all "not available").
    const stranger = ScanResultSchema.parse((await get('/v1/scan?q=0x000000000000000000000000000000000000dEaD')).body);
    expect(stranger).toMatchObject({ status: 'not_found', message: expect.stringMatching(/last 24 hours/) });
    expect(ScanResultSchema.parse((await get('/v1/scan?q=zzzz-nothing')).body).status).toBe('not_found');
    expect((await get('/v1/scan')).status).toBe(400);
    // The web app's usage pings and the grades panel get empty answers, not 404s.
    expect((await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { events: [] } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/scoreboard/grades' })).statusCode).toBe(204);
    // The RFC 9116 contact file: plain text, pointing at the public repository's private reporting.
    const sec = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(sec.statusCode).toBe(200);
    expect(sec.headers['content-type']).toMatch(/^text\/plain/);
    expect(sec.body).toContain('Contact: mailto:security@ekoterminal.com');
    expect(sec.body).toContain('Contact: https://github.com/eko-labs/eko-terminal/security/advisories/new');
    expect(sec.body).toMatch(/Expires: 2027-/);
    expect(ScoreboardResponseSchema.parse((await get('/v1/scoreboard')).body).counters.refused).toBe(0);
    expect((await get('/v1/coins/not-an-address')).status).toBe(400);
    expect((await get('/v1/coins/0x0000000000000000000000000000000000000001')).status).toBe(404);
    expect((await get('/v1/me')).status).toBe(401);
    expect((await get('/v1/agents')).body).toMatchObject({ error: 'not_found' });
    expect((await get('/health')).body).toMatchObject({ ok: true, coins: 1 });
    await app.close();
  });
});

describe('memory usage store', () => {
  it('counts units per day and provider and refuses past the limit', async () => {
    const { memoryUsageStore } = await import('../src/usage.js');
    const store = memoryUsageStore();
    expect(await store.reserve('2026-11-10', 'paid', 'eth_call', 3, 5)).toEqual({ allowed: true, total: 3 });
    expect(await store.reserve('2026-11-10', 'paid', 'eth_call', 3, 5)).toEqual({ allowed: false, total: 3 });
    expect(await store.reserve('2026-11-10', 'public', 'eth_getLogs', 3, 5)).toEqual({ allowed: true, total: 3 });
    expect(await store.today('2026-11-10')).toEqual([{ provider: 'paid', method: 'eth_call', calls: 1, units: 3 }, { provider: 'public', method: 'eth_getLogs', calls: 1, units: 3 }]);
    expect(await store.today('2026-11-11')).toEqual([]);
  });
});

describe('check scheduling', () => {
  it('pauses all checks when the provider quota is spent and backs off the failed coin', async () => {
    const chain = fakeChain(launchBlock + 500);
    let calls = 0;
    const rpc: Rpc = { request: async (input) => {
      if ((input as { method: string }).method === 'eth_call') { calls++; throw new Error('An unknown RPC error occurred. Details: provider_quota_exceeded'); }
      return chain.request(input);
    } };
    const tracker = new Tracker(rpc, registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    let now = (tracker.coin(token)!.ts + 60) * 1000;
    const events: string[] = [];
    const edge = new Edge(tracker, rpc, registry, new HypeUsd(async () => new Response('{}')), { now: () => now, log: (e) => events.push(e) });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
    edge.schedule(); await settle();
    const first = calls;
    expect(first).toBeGreaterThan(0);
    expect(events).toContain('assess_paused');
    // Paused: repeated scheduling makes no calls.
    for (let i = 0; i < 5; i++) { edge.schedule(); await settle(); }
    expect(calls).toBe(first);
    // Past the pause and the coin's one-minute backoff, it is tried again once.
    now += 61_000; edge.schedule(); await settle();
    expect(calls).toBeGreaterThan(first);
  });
});

describe('check scheduling when the sell test cannot run', () => {
  it('backs the coin off instead of checking it again on every tick', async () => {
    const { encodeFunctionResult, parseAbi } = await import('viem');
    const aggregate3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
    const chain = fakeChain(launchBlock + 500);
    let calls = 0;
    // Every read in the batch fails, so there is no pool key and no sell test: the check finishes without one.
    const rpc: Rpc = { request: async (input) => {
      if ((input as { method: string }).method === 'eth_call') { calls++; return encodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', result: [] }); }
      return chain.request(input);
    } };
    const tracker = new Tracker(rpc, registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    let now = (tracker.coin(token)!.ts + 60) * 1000;
    const edge = new Edge(tracker, rpc, registry, new HypeUsd(async () => new Response('{}')), { now: () => now });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
    edge.schedule(); await settle();
    expect(edge.probes.get(token.toLowerCase())?.probe).toBeNull();
    const first = calls;
    for (let i = 0; i < 5; i++) { edge.schedule(); await settle(); }
    expect(calls).toBe(first);
    // After its one-minute backoff it is tried once more.
    now += 61_000; edge.schedule(); await settle();
    expect(calls).toBe(first * 2);
  });
  it('reads names at the latest block, so they can use the public RPC', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    tracker.coin(token)!.name = null;
    const blocks: unknown[] = [];
    const rpc: Rpc = { request: async (input) => { blocks.push(input.params?.[1]); throw new Error('stop'); } };
    await new Edge(tracker, rpc, registry, new HypeUsd(async () => new Response('{}'))).name();
    expect(blocks).toEqual(['latest']);
  });
});

describe('a coin quoted in another token', () => {
  it('counts none of its swaps as HYPE and shows no price', async () => {
    let head = launchBlock + 10;
    const rpc: Rpc = { request: (input) => fakeChain(head).request(input) };
    const tracker = new Tracker(rpc, registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!;
    const before = coin.trades.length;
    coin.quote = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0';
    head = launchBlock + 500; await tracker.tick();
    // The sell at launch + 128 is left out.
    expect(coin.trades.length).toBe(before);
    coin.trades = [];
    const row = radarRow(coin, undefined, { nowSec: coin.ts + 60, head, hypeUsd: 70 }, 1);
    expect(row.priceUsd).toBe(0);
    expect(row.priceUnavailable).toBe(true);
    expect(row.unavailable).toEqual(expect.arrayContaining(['marketCap', 'volume']));
  });
});

describe('feature flags', () => {
  it('turns on the features EKO_FLAGS names and skips unknown names', async () => {
    const { parseFlags } = await import('../src/flags.js');
    const { on, unknown } = parseFlags(' leaderboards, referrals  nonsense ');
    expect([...on]).toEqual(['leaderboards', 'referrals']);
    expect(unknown).toEqual(['nonsense']);
    expect(parseFlags('none').on.size).toBe(0);
    expect(parseFlags(undefined).on.size).toBe(0);
    const config = PublicConfigSchema.parse(publicConfig(undefined, { accounts: true, flags: on }));
    expect(config.flags.leaderboards).toBe(true);
    expect(config.flags.approvals).toBe(true);
    expect(config.flags.arena).toBe(false);
  });
});

describe('feature folders', () => {
  it('loads only the folders whose flag is on and serves their routes', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const { loadFeatures } = await import('../src/features/index.js');
    const dir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/eko-features-`);
    const feature = (name: string, route: string) => { mkdirSync(`${dir}/${name}`);
      writeFileSync(`${dir}/${name}/index.ts`, `export default { register({ app }) { app.get('${route}', async () => ({ ok: '${name}' })); } };`); };
    feature('leaderboards', '/v2/leaderboards'); feature('arena', '/v2/arena'); feature('scratch', '/v2/scratch');
    const features = await loadFeatures(new Set(['leaderboards', 'scratch']), pathToFileURL(`${dir}/`));
    expect(features.map(f => f.flag)).toEqual(['leaderboards']);
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    const app = buildServer(new Edge(tracker, fakeChain(launchBlock + 500), registry, new HypeUsd(async () => new Response('{}'))), { features });
    expect((await app.inject('/v2/leaderboards')).json()).toEqual({ ok: 'leaderboards' });
    expect((await app.inject('/v2/arena')).statusCode).toBe(404);
    await app.close();
  });
  it('hands a feature the funder tracer when the server has one', async () => {
    const { HistoryStore } = await import('../src/history.js');
    const { FunderTracer } = await import('../src/funders.js');
    const store = new HistoryStore(':memory:');
    const funders = new FunderTracer({ firstTxs: async () => ({ normal: [], internal: [] }) } as never, store);
    const seen: unknown[] = [];
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    const edge = new Edge(tracker, fakeChain(launchBlock + 500), registry, new HypeUsd(async () => new Response('{}')));
    const feature = { flag: 'leaderboards' as const, register: (ctx: { funders?: unknown }) => { seen.push(ctx.funders); } };
    await buildServer(edge, { store, funders, features: [feature] }).close();
    await buildServer(edge, { store, features: [feature] }).close();
    expect(seen).toEqual([funders, undefined]);
    store.close();
  });
});

describe('graduation columns across a restart', () => {
  const now = () => 1_794_330_600;
  it('restores saved coins without counting the replayed blocks twice', async () => {
    const { ColumnSnapshot, decodeCoins, encodeCoins } = await import('../src/snapshot.js');
    const before = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    await before.start();
    const saved = before.coin(token)!; saved.graduated = true; saved.graduatedTs = saved.ts + 60;
    const file = `${process.env.TMPDIR ?? '/tmp'}/eko-columns-${process.pid}.json`;
    const snap = new ColumnSnapshot(file, before);
    expect(snap.saveSync()).toBe(1);
    expect(decodeCoins(encodeCoins([saved], 1))[0]!.supply).toBe(saved.supply);

    // The new process replays only the last 400 blocks: the launch is before them, the sell inside them.
    const after = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 400, chunk: 100, now });
    after.seed(new ColumnSnapshot(file, after).load());
    await after.start();
    expect(after.restored).toBe(1);
    const coin = after.coin(token)!;
    expect(coin.trades.map(t => t.side)).toEqual(['buy', 'sell']);
    expect(coin.flows).toHaveLength(3);
    expect(coin.netHype).toBeCloseTo(saved.netHype, 12);
    expect(coin.supply).toBe(saved.supply);
    expect(pairColumn(coin, { nowSec: now(), head: launchBlock + 500, hypeUsd: 70 })).toBe('migrated');
    expect(coin.graduatedTs).toBe(saved.ts + 60);
  });
  it('saves every followed coin, and lets the chain rebase what it restored before the replay', async () => {
    const { ColumnSnapshot } = await import('../src/snapshot.js');
    const { elysiumChain } = await import('../src/chains/elysium/index.js');
    const before = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    await before.start();
    // Not graduated and nowhere near the line: still saved, so a restart cannot drop it from the radar.
    expect(before.coin(token)!.graduated).toBe(false);
    expect(new ColumnSnapshot(`${process.env.TMPDIR ?? '/tmp'}/eko-all-${process.pid}.json`, before).coins()).toHaveLength(1);
    const rebase = vi.fn(async (_coins: unknown[], _block: bigint) => {});
    const after = new Tracker(fakeChain(launchBlock + 500), { ...elysiumChain(registry), rebase }, { backfillBlocks: 400, chunk: 100, now });
    after.seed([structuredClone(before.coin(token)!)]);
    await after.start();
    expect(after.restored).toBe(1);
    expect(rebase).toHaveBeenCalledOnce();
    expect(rebase.mock.calls[0]![1]).toBe(after.head - 400n);
  });
  it('keeps a coin for a day after it graduates, however long ago it launched', async () => {
    const t = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    await t.start();
    const coin = t.coin(token)!; const old = { ...structuredClone(coin), ts: now() - 5 * 86_400 };
    expect(t.restore([{ ...old }])).toBe(0);
    const t2 = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 400, chunk: 100, now });
    t2.seed([{ ...old, token: '0x2222222222222222222222222222222222222222' as never, block: 1, graduated: true, graduatedTs: now() - 3600 }]);
    await t2.start();
    expect(t2.restored).toBe(1);
  });
  it('keeps a graduate past the window while it still trades (activeQuote24h), and lets a dead one go', async () => {
    const t = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    await t.start();
    const coin = t.coin(token)!, longAgo = now() - 5 * 86_400;
    const trade = (ts: number, hype: number) => ({ ...coin.trades[0]!, ts, block: 1, hype });
    const graduate = (address: string, trades: ReturnType<typeof trade>[]) =>
      ({ ...structuredClone(coin), token: address as never, block: 1, ts: longAgo, graduated: true, graduatedTs: longAgo + 60, trades });
    const busy = graduate('0x3333333333333333333333333333333333333333', [trade(now() - 7200, 2), trade(now() - 600, 1.5)]);
    const dead = graduate('0x4444444444444444444444444444444444444444', [trade(now() - 3 * 86_400, 50), trade(now() - 600, 0.2)]);
    const curve = { ...busy, token: '0x5555555555555555555555555555555555555555' as never, graduated: false, graduatedTs: undefined };
    const keeper = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 400, chunk: 100, now, activeQuote24h: 2.5 });
    keeper.seed([busy, dead, curve]);
    await keeper.start();
    expect(keeper.coin(busy.token)).toBeDefined();
    expect(keeper.coin(dead.token)).toBeUndefined();
    expect(keeper.coin(curve.token)).toBeUndefined();
    // Off (0, Elysium's profile): the memory window alone decides.
    const off = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 400, chunk: 100, now, activeQuote24h: 0 });
    off.seed([structuredClone(busy)]);
    await off.start();
    expect(off.coin(busy.token)).toBeUndefined();
  });
  it('leaves a coin launched inside the replay to the backfill, and skips an unreadable file', async () => {
    const { ColumnSnapshot } = await import('../src/snapshot.js');
    const before = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    await before.start();
    const after = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100, now });
    after.seed([before.coin(token)!]);
    await after.start();
    expect(after.restored).toBe(0);
    expect(after.coin(token)!.trades).toHaveLength(2);
    expect(new ColumnSnapshot('/nonexistent/eko/columns.json', after).load()).toEqual([]);
  });
});

describe('checks across a restart (probe-snapshot.ts)', () => {
  const file = (name: string) => `${process.env.TMPDIR ?? '/tmp'}/eko-${name}-${process.pid}.json`;
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  const TIP_TX = keccak256(toHex('early buy'));
  /** A cached check taken at `atSec`, as the Elysium probe leaves it (the fixture's sell test: sellable, 2% exit). */
  const probeAt = (atSec: number) => { const f = assessment('clear');
    return { block: launchBlock, at: new Date(atSec * 1000).toISOString(), name: 'Test coin', symbol: 'TEST', key: null, config: f.config,
      currentBuyFeePips: 20000, probe: f.probe, probeUsd: 1000, tips: { [TIP_TX]: 1.5 } as Record<string, number> }; };
  /** The chain, with its log reads held until `release` (a start-up replay still running) and its eth_calls counted. */
  const heldChain = () => {
    const chain = fakeChain(launchBlock + 500);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const calls = { eth_call: 0 };
    const rpc: Rpc = { request: async (input) => {
      const { method } = input as { method: string };
      if (method === 'eth_call') { calls.eth_call++; throw new Error('test chain: no eth_call'); }
      if (method === 'eth_getLogs') await gate;
      return chain.request(input);
    } };
    return { rpc, release, calls };
  };
  /** A process that followed the coin and checked it at `probedAt` with `trades` trades, saved to disk as at shutdown. */
  const before = async (probedAt: (ts: number) => number, trades: number) => {
    const { ColumnSnapshot } = await import('../src/snapshot.js');
    const { ProbeSnapshot } = await import('../src/probe-snapshot.js');
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const edge = new Edge(tracker, fakeChain(launchBlock + 500), registry, new HypeUsd(async () => new Response('{}')));
    edge.restoreProbes([{ token: token.toLowerCase(), trades, probe: probeAt(probedAt(tracker.coin(token)!.ts)) }]);
    const paths = { columns: file('restart-columns'), probes: file('restart-probes') };
    new ColumnSnapshot(paths.columns, tracker).saveSync();
    expect(new ProbeSnapshot(paths.probes, edge).saveSync()).toBe(1);
    return paths;
  };
  /** The next process, as main.ts starts it: coins seeded, checks restored, then the tracker started (its replay held). */
  const after = async (paths: { columns: string; probes: string }, nowMs: (ts: number) => number) => {
    const { ColumnSnapshot } = await import('../src/snapshot.js');
    const { ProbeSnapshot } = await import('../src/probe-snapshot.js');
    const held = heldChain();
    const seeded = new ColumnSnapshot(paths.columns, new Tracker(held.rpc, registry)).load();
    const now = nowMs(seeded[0]!.ts);
    const tracker = new Tracker(held.rpc, registry, { backfillBlocks: 400, chunk: 100, now: () => now / 1000 });
    tracker.seed(seeded);
    const hype = new HypeUsd(async () => new Response(JSON.stringify({ HYPE: '70' }))); await hype.get();
    const edge = new Edge(tracker, held.rpc, registry, hype, { now: () => now });
    const restored = edge.restoreProbes(new ProbeSnapshot(paths.probes, edge).load(new Set(seeded.map(c => c.token.toLowerCase())), now));
    const started = tracker.start();
    for (let i = 0; i < 100 && !tracker.coin(token); i++) await new Promise(r => setTimeout(r, 0));
    expect(tracker.restored).toBe(1);
    return { tracker, edge, restored, started, ...held };
  };

  it('writes bigints, dates and fees and reads them back the same', async () => {
    const { decodeProbes, encodeProbes } = await import('../src/probe-snapshot.js');
    const probe = { ...probeAt(1_794_330_060), pons: { realQuoteReserve: 12_345_678_901_234_567_890n, realTokenReserve: -1n, graduated: false },
      lock: { locked: true, tokenId: 42n, liquidity: 2n ** 200n, locker: null }, seenAt: new Date('2026-11-27T10:00:00.000Z') };
    const { text, kept } = encodeProbes([{ token, trades: 7, probe }], 1_794_330_100);
    expect(kept).toBe(1);
    const decoded = decodeProbes(text);
    if ('error' in decoded) throw new Error(decoded.error);
    expect(decoded.savedAt).toBe(1_794_330_100);
    expect(decoded.probes).toEqual([{ token: token.toLowerCase(), trades: 7, probe }]);
    const back = decoded.probes[0]!.probe as unknown as typeof probe;
    expect(typeof back.pons.realQuoteReserve).toBe('bigint'); expect(back.lock.liquidity).toBe(2n ** 200n);
    expect(back.seenAt).toBeInstanceOf(Date); expect(back.tips[TIP_TX]).toBe(1.5);
  });

  it('stays inside its bounds: fees per check capped, an oversized check skipped', async () => {
    const { decodeProbes, encodeProbes, MAX_TIPS } = await import('../src/probe-snapshot.js');
    const many = Object.fromEntries(Array.from({ length: MAX_TIPS + 10 }, (_, i) => [keccak256(toHex(i)), i]));
    const huge = { ...probeAt(1_794_330_060), name: 'x'.repeat(70 * 1024) };
    const other = '0x2222222222222222222222222222222222222222';
    const { text, kept } = encodeProbes([{ token, trades: 0, probe: { ...probeAt(1_794_330_060), tips: many } }, { token: other, trades: 0, probe: huge }], 1);
    expect(kept).toBe(1);
    const decoded = decodeProbes(text);
    if ('error' in decoded) throw new Error(decoded.error);
    expect(decoded.probes.map(p => p.token)).toEqual([token.toLowerCase()]);
    expect(Object.keys(decoded.probes[0]!.probe.tips)).toHaveLength(MAX_TIPS);
  });

  it('shows the last verdict and score right after a start, before the replay is done, with no new check', async () => {
    // Checked 30 s before the restart, after both trades; the new process starts a minute later.
    const paths = await before(ts => ts + 500, 2);
    const next = await after(paths, ts => (ts + 560) * 1000);
    expect(next.restored).toBe(1);
    // The replay is still held: the coin is back from the snapshot with its launch trade only.
    expect(next.tracker.coin(token)!.trades).toHaveLength(1);
    const row = (await buildServer(next.edge).inject({ method: 'GET', url: `/v1/radar/${token}` })).json().row;
    expect(row.verdict).toBe('clear');
    expect(row.ekoScore).toBeDefined();
    // The check is fresh, so the scheduler (running during the replay, as main.ts does) spends nothing on it.
    next.edge.schedule(); await settle();
    next.release(); await next.started;
    next.edge.prune(); next.edge.schedule(); await settle();
    expect(next.calls.eth_call).toBe(0);
    expect(next.edge.probes.get(token.toLowerCase())!.tips[TIP_TX]).toBe(1.5);
    // The counts over every coin read it as well once warm() has judged it.
    const fresh = await after(paths, ts => (ts + 560) * 1000);
    expect(fresh.edge.cachedLevel(token)).toBe('pending');
    fresh.release(); await fresh.started;
    expect(fresh.edge.warm(1000)).toBe(1);
    expect(fresh.edge.cachedLevel(token)).toBe('clear');
  });

  it('re-checks a restored check older than the recheck window once the coin has traded since', async () => {
    // Checked when the coin had one trade, twenty minutes before the new process starts; it sold since.
    const paths = await before(ts => ts + 10, 1);
    const next = await after(paths, ts => (ts + 1210) * 1000);
    expect(next.restored).toBe(1);
    // Its last verdict meanwhile, not pending.
    expect(next.edge.assessment(token)?.verdict.level).toBe('clear');
    // During the replay the coin has no trade the check did not see yet: nothing to redo.
    next.edge.schedule(); await settle();
    expect(next.calls.eth_call).toBe(0);
    next.release(); await next.started;
    next.edge.schedule(); await settle();
    expect(next.calls.eth_call).toBeGreaterThan(0);
  });

  it('ignores a corrupt, foreign-version or missing file with a log line, and keeps only coins still followed', async () => {
    const { writeFileSync } = await import('node:fs');
    const { ProbeSnapshot, encodeProbes } = await import('../src/probe-snapshot.js');
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const log = (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); };
    const path = file('probes-corrupt'), none = { savedProbes: () => [] };
    writeFileSync(path, '{"version":1,"probes":[{"tok');
    expect(new ProbeSnapshot(path, none, log).load()).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 999, savedAt: 1, probes: [] }));
    expect(new ProbeSnapshot(path, none, log).load()).toEqual([]);
    expect(events.map(e => [e.event, e.fields.reason])).toEqual([['probes_ignored', 'unparseable'], ['probes_ignored', 'version 999 (expected 1)']]);
    expect(new ProbeSnapshot('/nonexistent/eko/probes.json', none, log).load()).toEqual([]);
    expect(events).toHaveLength(2);
    // Malformed entries are dropped one by one; a coin the coin snapshot no longer holds is left out.
    const gone = '0x3333333333333333333333333333333333333333';
    const { text } = encodeProbes([{ token, trades: 1, probe: probeAt(1_794_330_060) }, { token: gone, trades: 1, probe: probeAt(1_794_330_060) }], 1);
    writeFileSync(path, text.replace(/\]\}$/, ',{"token":"0x1","trades":1,"probe":{}}]}'));
    expect(new ProbeSnapshot(path, none, log).load(undefined, 1_794_330_100_000).map(s => s.token)).toEqual([token.toLowerCase(), gone]);
    expect(new ProbeSnapshot(path, none, log).load(new Set([token.toLowerCase()]), 1_794_330_100_000).map(s => s.token)).toEqual([token.toLowerCase()]);
  });

  it('queues due coins in the radar list\'s order, coins with no verdict yet first', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const base = tracker.coin(token)!, nowSec = base.ts + 3000;
    const trade = (hype: number) => ({ ...base.trades[0]!, ts: nowSec - 600, hype });
    const addr = (d: number) => getAddress(`0x${String(d).repeat(40)}`).toLowerCase();
    // Five more coins: hour volumes 5, 1 and 9, then two that never traded (an older launch, and a newer one never checked).
    ([[5, 0], [1, 0], [9, 0], [null, -100], [null, 100]] as const).forEach(([vol, age], i) => {
      const c = { ...structuredClone(base), token: getAddress(addr(i + 1)), ts: base.ts + age, trades: vol === null ? [] : [trade(vol)] };
      tracker.coins.set(c.token.toLowerCase(), c);
    });
    const hype = new HypeUsd(async () => new Response(JSON.stringify({ HYPE: '70' }))); await hype.get();
    const edge = new Edge(tracker, fakeChain(launchBlock + 500), registry, hype, { now: () => nowSec * 1000, concurrency: 100 });
    // Every coin but the newest has a check older than the window, taken before any of its trades.
    edge.restoreProbes([...tracker.coins.keys()].filter(k => k !== addr(5)).map(k => ({ token: k, trades: 0, probe: probeAt(nowSec - 1200) })));
    const order: string[] = [];
    vi.spyOn(edge, 'check').mockImplementation(async (c) => { order.push(c.token.toLowerCase()); return null; });
    edge.schedule();
    const radar = RadarResponseSchema.parse((await buildServer(edge).inject({ method: 'GET', url: '/v2/radar' })).json()).rows.map(r => r.address.toLowerCase());
    // The never-checked coin first; then the radar's order, without the coin that has not traded since its check.
    expect(order[0]).toBe(addr(5));
    expect(order.slice(1)).toEqual(radar.filter(a => a !== addr(5) && a !== addr(4)));
    expect(order.slice(1, 4)).toEqual([addr(3), addr(1), addr(2)]);
  });
});
