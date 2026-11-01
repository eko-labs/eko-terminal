import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { CoinCardSchema, PairRowSchema, PublicConfigSchema, RadarResponseSchema, ScoreboardResponseSchema, VerdictSchema } from '@eko/shared';
import launch from '../../../packages/chain/test/fixtures/99901/montra-launch.json' with { type: 'json' };
import { barsFromTrades, changePct, priceHypeFromSqrt, spark, tradeFromSwap, type Trade } from '../src/market.js';
import { hookBits, judge, type Assessment } from '../src/assess.js';
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
  it('builds USD bars, change and a sparkline from trades', () => {
    const t = (ts: number, priceHype: number, hype: number): Trade => ({ ts, block: ts, tx: '0x01', sender: '0x00000000000000000000000000000000000000a1', side: 'buy', hype, tokens: 1, priceHype });
    const trades = [t(60, 1, 1), t(90, 2, 1), t(130, 1.5, 2)];
    expect(barsFromTrades(trades, '1m', 10, 0, 200)).toEqual([{ ts: 60, o: 10, h: 20, l: 10, c: 20, vUsd: 20 }, { ts: 120, o: 15, h: 15, l: 15, c: 15, vUsd: 20 }]);
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
    stats: { holders: { top10Share: 0.12, largestShare: 0.04, largest: null, transferredShare: 0, transferredWallets: 0, evidence: [] }, earlyBuyers: [],
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
    }
    const row = RadarResponseSchema.shape.rows.element.parse(radarRow(coin, assessment('danger'), ctx, 1));
    expect(row).toMatchObject({ verdict: 'danger', hardDanger: true, sellCheck: { status: 'refused' }, trades1h: 2 });
    expect(PairRowSchema.parse(pairRow(coin, undefined, ctx))).toMatchObject({ column: 'new', verdictPending: true, buyers: 0 });
    expect(PairRowSchema.parse(pairRow(coin, assessment('clear'), ctx))).toMatchObject({ buyers: 7, top10Pct: 12, devPct: 2 });
    expect(pairColumn({ ...coin, graduated: true }, ctx)).toBe('migrated');
    expect(PublicConfigSchema.parse(publicConfig()).trading.liveEnabled).toBe(false);
  });
});

describe('judge', () => {
  it('recomputes the verdict from transfers as the coin trades, with no new RPC call', async () => {
    const tracker = new Tracker(fakeChain(launchBlock + 500), registry, { backfillBlocks: 600, chunk: 100 });
    await tracker.start();
    const coin = tracker.coin(token)!, fixture = assessment('clear');
    const probed = { block: launchBlock, at: new Date(coin.ts * 1000).toISOString(), name: 'Test coin', symbol: 'TEST', key: null,
      config: fixture.config, currentBuyFeePips: 20000, probe: fixture.probe, probeUsd: 1000, tips: {} };
    const ctx = { registry, hypeUsd: 70, nowSec: coin.ts + 600, head: launchBlock + 500 };
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
    expect(CoinCardSchema.parse((await get(`/v1/coins/${token}`)).body).identity.address).toBe(token.toLowerCase());
    expect(VerdictSchema.parse((await get(`/v1/coins/${token}/verdict`)).body).level).toBe('clear');
    expect((await get(`/v2/coins/${token}`)).body).toEqual({ version: 2, card: null });
    expect((await get(`/v1/coins/${token}/candles?tf=1m&from=0`)).body.bars.length).toBeGreaterThan(0);
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
