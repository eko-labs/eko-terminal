import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { DeployerHistorySchema, ScoreboardResponseSchema } from '@eko/shared';
import launch from '../../../packages/chain/test/fixtures/99901/montra-launch.json' with { type: 'json' };
import { HistoryStore, HUB_FUNDEES } from '../src/history.js';
import { firstFunding } from '../src/funders.js';
import { featuresAt, outcomeAt } from '../src/outcomes.js';
import { Historian } from '../src/historian.js';
import type { Explorer, ExplorerLog } from '../src/explorer.js';
import { swapAbi, Tracker, TRANSFER_TOPIC, type CoinState, type Rpc } from '../src/tracker.js';
import { excludedFor } from '../src/assess.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';

const registry = loadElysiumRegistry();
const excluded = excludedFor(registry);
const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const token = getAddress(launch.launch.args.token), poolId = launch.launch.args.poolId as Hex, launchBlock = Number(launch.launch.blockNumber);
const creator = getAddress(launch.launch.args.creator), supply = BigInt(launch.launch.args.supply);
const pm = registry.address('uniswapV4.poolManager'), T0 = 1_794_330_000;

function coin(over: Partial<CoinState> = {}): CoinState {
  return { launchpad: 'montra', key: null, flipped: false, supplyFromMints: false, launcher: registry.address('montra.factory'), manager: registry.address('uniswapV4.poolManager'), token, creator, poolId, quote: '0x0000000000000000000000000000000000000000', supply, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: creator,
    feeLocked: false, block: launchBlock, ts: T0, tx: launch.launch.transactionHash as Hex, trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: 'X', symbol: 'X', flows: [], ...over };
}
let n = 0;
const txh = () => keccak256(toHex(`tx${n++}`));
/** A buy or sell of `share` of supply by `wallet` at `price` HYPE per token, `sec` after launch. */
function trade(c: CoinState, wallet: Address, side: 'buy' | 'sell', share: number, price: number, sec: number) {
  const tx = txh(), value = (supply * BigInt(Math.round(share * 1e6))) / 1_000_000n, w = wallet.toLowerCase(), p = pm.toLowerCase();
  c.trades.push({ ts: c.ts + sec, block: c.block + sec * 9, tx, sender: A(0xa1), side, hype: (Number(value) / 1e18) * price, tokens: Number(value) / 1e18, priceHype: price });
  c.flows.push({ tx, block: c.block + sec * 9, ts: c.ts + sec, from: side === 'buy' ? p : w, to: side === 'buy' ? w : p, value });
}

describe('history store', () => {
  it('keeps the first verdict, the strongest level of each check, outcomes, and crew history through a shared funder', () => {
    const s = new HistoryStore(':memory:');
    const L = (t: Address, d: Address, ts: number) => s.recordLaunch({ token: t, launchpad: 'montra', deployer: d, poolId: keccak256(t), createdBlock: ts, createdTs: ts, tx: null, name: 'n', symbol: 's', supply: '1' });
    L(A(1), A(100), 10); L(A(2), A(100), 20); L(A(3), A(101), 30); L(A(4), A(100), 40);
    s.recordVerdict(A(1), 'clear', [{ id: 'dev_dump', level: 'info' }], 11, 'live');
    s.recordVerdict(A(1), 'danger', [{ id: 'dev_dump', level: 'danger' }, { id: 'bundle_dump', level: 'monitor' }], 12, 'live');
    s.recordVerdict(A(1), 'monitor', [{ id: 'dev_dump', level: 'monitor' }], 13, 'live');
    const l = s.launch(A(1))!;
    expect(l).toMatchObject({ firstLevel: 'clear', firstAt: 11, level: 'monitor', source: 'live' });
    expect(l.matches).toEqual(expect.arrayContaining([{ id: 'dev_dump', level: 'danger' }, { id: 'bundle_dump', level: 'monitor' }]));
    s.recordOutcome(A(1), '24h', 'rugged', 99, { dropFromPeak: 0.95 });
    // Deployers 100 and 101 were paid by the same funder: 101's launch is crew history for 100.
    s.recordFunder({ wallet: A(100), funder: A(900), fundedTs: 1, fundedBlock: 1, tx: null }, 1);
    s.recordFunder({ wallet: A(101), funder: A(900), fundedTs: 2, fundedBlock: 2, tx: null }, 1);
    const h = s.historyFor(A(100), 35);
    expect(h.crewId).toBe(A(900).toLowerCase());
    expect(h.launches.map(x => [x.coin, x.relation])).toEqual([[A(2), 'deployer'], [A(1), 'deployer'], [A(3), 'crew']]);
    expect(h.launches.find(x => x.coin === A(1))!.outcomes[0]).toMatchObject({ horizon: '24h', outcome: 'rugged' });
    // A funder that paid many traced wallets is a hub: it ties no one together.
    for (let i = 0; i < HUB_FUNDEES; i++) s.recordFunder({ wallet: A(2000 + i), funder: A(901), fundedTs: 1, fundedBlock: 1, tx: null }, 1);
    s.recordFunder({ wallet: A(100), funder: A(901), fundedTs: 1, fundedBlock: 1, tx: null }, 1);
    expect(s.isHub(A(901))).toBe(true);
    expect(s.attributedFunder(A(100))).toBeUndefined();
    expect(s.historyFor(A(100), 35).crewId).toBeUndefined();
  });
});

describe('funders', () => {
  it('takes the earliest incoming HYPE, normal or internal, and skips self-sends, outgoing and failed transfers', () => {
    const w = A(5).toLowerCase(), tx = (from: string, to: string, value: string, block: number, isError = '0') => ({ hash: txh(), from, to, value, timeStamp: String(block * 10), blockNumber: String(block), isError });
    expect(firstFunding(w, { normal: [tx(w, A(7), '5', 1), tx(A(8), w, '9', 9), tx(w, w, '1', 2)], internal: [tx(A(9), w, '3', 4, '1'), tx(A(6), w, '2', 5)] }))
      .toMatchObject({ funder: A(6), fundedBlock: 5, fundedTs: 50 });
    expect(firstFunding(w, { normal: [tx(w, A(7), '5', 1)], internal: [] })).toBeNull();
  });
});

describe('outcomes', () => {
  it('labels rugged, dumped, survived and honeypot, and nothing for a coin nobody traded', () => {
    const buyer = A(0xb1);
    const rug = coin(); trade(rug, creator, 'buy', 0.1, 1, 0); trade(rug, buyer, 'buy', 0.05, 1, 20); trade(rug, A(0xc1), 'buy', 0.05, 20, 600); trade(rug, creator, 'sell', 0.1, 1, 1200);
    expect(outcomeAt(rug, '1h', excluded, false)!.outcome).toBe('rugged');
    // A first-minute bot that flips is not an insider: only the deployer and wallets it (or its funder) paid count.
    const flip = coin(); trade(flip, creator, 'buy', 0.1, 1, 0); trade(flip, buyer, 'buy', 0.1, 1.2, 30); trade(flip, buyer, 'sell', 0.1, 1.5, 1800); trade(flip, creator, 'sell', 0.02, 1.5, 1850);
    trade(flip, A(0xc2), 'buy', 0.01, 1.4, 1900);
    expect(outcomeAt(flip, '1h', excluded, false)).toMatchObject({ outcome: 'survived', detail: { insidersSoldFirstHour: 0.2, insiderWallets: 1 } });
    const funded = (w: string) => w === buyer.toLowerCase() ? { funder: creator } : undefined;
    expect(outcomeAt(flip, '1h', excluded, false, funded)).toMatchObject({ outcome: 'dumped', detail: { insidersSoldFirstHour: 0.6, insiderWallets: 2 } });
    const ok = coin(); trade(ok, creator, 'buy', 0.05, 1, 0); trade(ok, A(0xc3), 'buy', 0.02, 1.5, 300);
    expect(outcomeAt(ok, '24h', excluded, false)).toMatchObject({ outcome: 'survived', detail: { changeFrom300: 0, halvedFrom300: 0 } });
    // Bought five minutes in at 20x, worth 1x by the next day: a buyer then lost 95%.
    expect(outcomeAt(rug, '24h', excluded, false)!.detail).toMatchObject({ changeFrom300: 0, changeFrom3600: 0 });
    const late = coin(); trade(late, creator, 'buy', 0.1, 1, 0); trade(late, A(0xc4), 'buy', 0.05, 10, 200); trade(late, A(0xc4), 'sell', 0.05, 2, 4000);
    expect(outcomeAt(late, '24h', excluded, false)!.detail).toMatchObject({ changeFrom300: -0.8, halvedFrom300: 1, changeFrom3600: -0.8, halvedFrom3600: 1 });
    expect(outcomeAt(ok, '24h', excluded, true)!.outcome).toBe('honeypot');
    const idle = coin(); idle.trades.push({ ts: T0, block: launchBlock, tx: idle.tx, sender: A(0xa1), side: 'buy', hype: 1, tokens: 1, priceHype: 1 });
    expect(outcomeAt(idle, '1h', excluded, false)).toBeNull();
    expect(featuresAt(rug, 3600, excluded)).toMatchObject({ trades: 4, buyers: 3, peakMultiple: 20, lastMultiple: 1 });
  });
});

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
function swapLog(block: number, amount0: bigint, amount1: bigint, tx: Hex, index: number): ExplorerLog {
  const topics = encodeEventTopics({ abi: swapAbi, eventName: 'Swap', args: { id: poolId, sender: A(0xa1) } }) as Hex[];
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, 376704063821928778106310921211621n, 1n, 0, 0]);
  return { address: pm, topics, data, blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(index), blockTimestamp: toHex(T0 + Math.round((block - launchBlock) * 0.111)) };
}
const transferLog = (block: number, from: string, to: string, value: bigint, tx: Hex, index: number): ExplorerLog => ({ address: token.toLowerCase(), topics: [TRANSFER_TOPIC, pad(from), pad(to)] as Hex[],
  data: toHex(value, { size: 32 }), blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(index), blockTimestamp: toHex(T0 + Math.round((block - launchBlock) * 0.111)) });

/** An explorer holding the captured launch, its first buy, ten later buys and a deployer sell. */
function fakeExplorer(): Explorer {
  const LAUNCH_TX = launch.launch.transactionHash as Hex, FIRST = BigInt(launch.launch.args.firstBuyOut);
  const launchLog: ExplorerLog = { ...launch.launch, topics: launch.launch.topics as Hex[], data: launch.launch.data as Hex, transactionHash: LAUNCH_TX,
    blockNumber: toHex(launchBlock), logIndex: toHex(Number(launch.launch.logIndex)), blockTimestamp: toHex(T0) };
  const swaps = [swapLog(launchBlock, -970200000000000000n, FIRST, LAUNCH_TX, 1)];
  const transfers = [transferLog(launchBlock, '0x0000000000000000000000000000000000000000', registry.address('montra.hook'), supply, LAUNCH_TX, 0), transferLog(launchBlock, pm, creator, FIRST, LAUNCH_TX, 2)];
  for (let i = 0; i < 10; i++) {
    const tx = keccak256(toHex(`buy${i}`)), b = launchBlock + 100 + i * 50, v = supply / 100n;
    swaps.push(swapLog(b, -(10n ** 17n), v, tx, 1)); transfers.push(transferLog(b, pm, A(0xd00 + i), v, tx, 2));
  }
  const sell = keccak256(toHex('devsell')), sb = launchBlock + 20_000;
  swaps.push(swapLog(sb, 10n ** 17n, -FIRST, sell, 1)); transfers.push(transferLog(sb, creator, pm, FIRST, sell, 2));
  const all = [launchLog, ...swaps, ...transfers];
  return { calls: 0, logs: async (f: { address?: string; topic0?: Hex; topic1?: Hex }, from: number, to: number, onPage?: (l: ExplorerLog[], t: number) => unknown) => {
    const out = all.filter(l => (!f.address || l.address.toLowerCase() === f.address.toLowerCase()) && (!f.topic0 || l.topics[0] === f.topic0)
      && (!f.topic1 || l.topics[1]?.toLowerCase() === f.topic1.toLowerCase()) && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    await onPage?.(out, to);
    return out;
  }, firstTxs: async () => ({ normal: [], internal: [] }) } as unknown as Explorer;
}
const idleRpc: Rpc = { request: async () => { throw new Error('no rpc'); } };

describe('historian', () => {
  it('records past launches, counts their swaps, and replays a traded launch into features, outcomes and a verdict', async () => {
    const store = new HistoryStore(':memory:');
    const tracker = new Tracker(idleRpc, registry);
    tracker.head = BigInt(launchBlock + 1_000_000);
    const h = new Historian(fakeExplorer(), store, registry, { tracker }, { fromBlock: launchBlock - 10, now: () => (T0 + 2 * 86_400) * 1000 });
    await h.step();
    const l = store.launch(token)!;
    expect(l).toMatchObject({ deployer: creator, swaps: 12, source: 'replay' });
    expect(store.outcomes(token).map(o => o.horizon).sort()).toEqual(['1h', '24h']);
    expect(store.query<{ at_sec: number }>('SELECT at_sec FROM features WHERE token = ? ORDER BY at_sec', token.toLowerCase()).map(r => r.at_sec)).toEqual([300, 3600]);
    expect(h.status()).toMatchObject({ launches: 1, replayed: 1, failures: 0 });
    // Nothing left to do on the next pass.
    expect(h.due(10)).toEqual([]);
  });
});

describe('memory routes', () => {
  it('serves a deployer record and the scoreboard in the shapes the web app validates', async () => {
    const store = new HistoryStore(':memory:');
    const tracker = new Tracker(idleRpc, registry);
    const L = (t: Address, ts: number) => store.recordLaunch({ token: t, launchpad: 'montra', deployer: A(100), poolId: keccak256(t), createdBlock: ts, createdTs: ts, tx: null, name: 'n', symbol: 's', supply: '1' });
    L(A(1), T0); L(A(2), T0 + 10);
    store.recordVerdict(A(1), 'danger', [{ id: 'honeypot', level: 'danger' }], T0 + 5, 'live');
    store.recordVerdict(A(2), 'clear', [], T0 + 15, 'live');
    store.recordOutcome(A(1), '24h', 'honeypot', T0 + 90_000, {}); store.recordOutcome(A(2), '24h', 'dumped', T0 + 90_000, { dropFromPeak: 0.4 });
    store.query('UPDATE launches SET swaps = 20');
    const edge = new Edge(tracker, idleRpc, registry, new HypeUsd(async () => new Response('{}')));
    const app = buildServer(edge, { store });
    const d = await app.inject({ url: `/v1/deployers/${A(100)}` });
    const body = DeployerHistorySchema.parse(d.json());
    expect(body.summary).toMatchObject({ launches: 2, flagged: 1, outcomes: { honeypot: 1, dumped: 1 } });
    expect(body.launches[0]).toMatchObject({ address: A(2), outcome24h: 'dumped', firstLevel: 'clear' });
    for (const kind of ['calls', 'honeypots_refused', 'honeypots_missed', 'cohort']) {
      const r = ScoreboardResponseSchema.parse((await app.inject({ url: `/v1/scoreboard?kind=${kind}` })).json());
      if (kind === 'calls') expect(r.rows.map(x => [x.coin, x.grade])).toEqual([[A(2), 'miss'], [A(1), 'hit']]);
      if (kind === 'honeypots_refused') expect(r.counters).toMatchObject({ refused: 1, missed: 0 });
    }
    expect((await app.inject({ url: '/v1/memory/calibration' })).json()).toMatchObject({ horizon: '24h', samples: 0 });
    await app.close();
  });
});
