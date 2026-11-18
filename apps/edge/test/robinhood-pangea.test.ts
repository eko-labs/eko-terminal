import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId } from '@eko/chain';
import fx from './fixtures/robinhood/pangea-launch.json' with { type: 'json' };
import {
  decodeRobinhoodLog, INITIALIZE_TOPIC, orderRobinhoodLogs, PANGEA_POOL_TOPIC, pangeaPoolKey, probeRobinhoodCoin, robinhoodAddresses, robinhoodChain,
  robinhoodExcluded, robinhoodLogQueries, type RawRobinhoodLog, type RobinhoodCoinState, type RobinhoodProbed,
} from '../src/chains/robinhood/index.js';
import { judge } from '../src/assess.js';
import { coinCard, coinSummary, pairColumn } from '../src/views.js';
import { Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';

/**
 * Pangea on Robinhood Chain: SPd's launch transaction as read from chain on 2026-11-18 (fixtures/robinhood/pangea-launch.json).
 * The creator opened a one-token supply at about 55.7 ETH (about $100,000) with no ETH in the pool, then bought 0.02 ETH
 * of it across six wallets in the same transaction.
 */
const addrs = robinhoodAddresses(loadRegistry());
const logs = fx.launchTx as unknown as RawLog[];
const record = logs.find(l => l.topics[0] === PANGEA_POOL_TOPIC)!;
const init = logs.find(l => l.topics[0] === INITIALIZE_TOPIC)!;
const token = getAddress(fx.token);
const ETH_USD = 1800;
const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };

/** The coin as the tracker builds it from the launch transaction's logs. */
function tracked() {
  const tracker = new Tracker(offline, robinhoodChain());
  tracker.applyAll(logs, () => fx.launchTs);
  return { tracker, coin: tracker.coin(token)! };
}
/** What the probe measured on SPd's pool at head (2026-11-18): 0.005 ETH in, 98.01% back. */
function probed(coin: CoinState): RobinhoodProbed {
  return { block: fx.launchBlock + 100, at: new Date((fx.launchTs + 10) * 1000).toISOString(), name: 'Speedd', symbol: 'SPd', key: coin.key, config: null,
    currentBuyFeePips: null, probeUsd: 1000, tips: {}, pons: null, lock: null,
    probe: { method: 'sell-check-1', venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}`, block: String(fx.launchBlock + 100), sizeWei: '5000000000000000',
      status: 'sellable', reason: null, spentWei: '5000000000000000', tokens: '88877139509273', returnedWei: '4900499999999950', quotedSellWei: null, exitCostPct: 1.99,
      revert: null, requests: 1 } as never };
}

describe('Pangea launches (Robinhood Chain)', () => {
  it('decodes the launcher\'s pool record: coin, creator, the native-ETH pool key that hashes to its id, and the opening tick', () => {
    const e = decodeRobinhoodLog(record as RawRobinhoodLog, addrs);
    expect(e).toMatchObject({ kind: 'pool_launch', launchpad: 'pangea', token, creator: getAddress(fx.creator), openTick: -40_200, block: fx.launchBlock, launchPosition: null });
    if (e?.kind !== 'pool_launch') throw new Error('not a Pangea launch');
    expect(e.key).toEqual({ currency0: zeroAddress, currency1: token, fee: 0, tickSpacing: 60, hooks: addrs.pangeaHook });
    // The same pool the PoolManager initialized in that transaction.
    expect(e.poolId).toBe(init.topics[1]!.toLowerCase());
    expect(v4PoolId(pangeaPoolKey(token, addrs.pangeaHook)).toLowerCase()).toBe(e.poolId);
  });

  it('skips a token-quoted launch, other emitters, malformed records, and decoders not given Pangea\'s addresses', () => {
    expect(decodeRobinhoodLog(fx.tokenQuotedPoolRecord as unknown as RawRobinhoodLog, addrs)).toBeNull();
    expect(decodeRobinhoodLog({ ...record, address: addrs.factory } as RawRobinhoodLog, addrs)).toBeNull();
    expect(decodeRobinhoodLog({ ...record, data: record.data.slice(0, -64) as Hex } as RawRobinhoodLog, addrs)).toBeNull();
    expect(decodeRobinhoodLog({ ...record, topics: record.topics.slice(0, 3) } as RawRobinhoodLog, addrs)).toBeNull();
    const { factory, hook, poolManager } = addrs;
    expect(decodeRobinhoodLog(record as RawRobinhoodLog, { factory, hook, poolManager })).toBeNull();
  });

  it('costs the tracker no extra log call: the record rides in the launch-and-curve topic-OR query', () => {
    const queries = robinhoodLogQueries(addrs);
    // Launch records and curve trades (no address), native Initialize, and ModifyLiquidity (launch positions, 2026-11-18).
    expect(queries).toHaveLength(3);
    expect(queries[0]!.address).toBeUndefined();
    expect(queries[0]!.topics[0]).toContain(PANGEA_POOL_TOPIC);
    // The record comes after the mint and the swaps in its transaction: launches are applied first.
    expect(orderRobinhoodLogs(logs as RawRobinhoodLog[])[0]).toBe(record);
  });

  it('follows the coin from its launch transaction: supply from its mint, its pool swaps, and the opening price', () => {
    const { tracker, coin } = tracked();
    expect(coin).toMatchObject({ launchpad: 'pangea', graduated: false, quote: zeroAddress, flipped: false, manager: addrs.poolManager, launcher: addrs.pangeaLauncher,
      creator: getAddress(fx.creator), supply: 10n ** 18n, poolId: init.topics[1]!.toLowerCase() });
    expect(coin.curve).toBeUndefined();
    // Six buys of 0.00333 ETH in the launch transaction, through the tracker's own v4 Swap path.
    expect(coin.trades).toHaveLength(6);
    expect(coin.trades.every(t => t.side === 'buy')).toBe(true);
    expect(coin.netHype).toBeCloseTo(0.02, 6);
    expect(coin.openPrice).toBeCloseTo(1.0001 ** 40_200, 6);
    expect(coin.trades.at(-1)!.priceHype).toBeCloseTo(55.7, 1);
    expect(tracker.feed.filter(f => f.kind === 'new_pair').map(f => f.coin)).toEqual([token]);
    expect(tracker.coinByPool(coin.poolId)?.token).toBe(token);
  });

  it('lists Pangea\'s launcher, liquidity manager and hook as non-holders', () => {
    const ex = robinhoodExcluded(undefined, addrs);
    for (const a of [addrs.pangeaLauncher, addrs.pangeaLiquidityManager, addrs.pangeaHook, addrs.poolManager]) expect(ex).toContain(a);
  });

  it('rates the launch Danger for its fake market cap, with the sell check run and passed', () => {
    const { coin } = tracked(), chain = robinhoodChain(), p = probed(coin), now = fx.launchTs + 60;
    const facts = chain.facts(coin, p, now);
    expect(facts.backing!.mcap).toBeCloseTo(55.7, 1);
    expect(facts.backing!.paidIn).toBeCloseTo(0.02, 6);
    expect(facts.liquidity).toBeNull();
    expect(facts.hook).toMatchObject({ reviewed: false, label: expect.stringContaining('Pangea hook') });
    const a = judge(coin, p, { chain, hypeUsd: ETH_USD, nowSec: now, head: p.block });
    expect(a.verdict.level).toBe('danger');
    const fake = a.matches.find(m => m.id === 'fake_mcap')!;
    expect(fake.level).toBe('danger');
    const stat = (label: string) => fake.evidence.find(e => e.label === label)?.value;
    expect(stat('Market cap, price × supply (USD)')).toBeGreaterThan(100_000);
    expect(stat('Paid into the pool on net (USD)')).toBeCloseTo(36, 0);
    expect(fake.evidence.some(e => e.kind === 'address' && e.ref === coin.poolId)).toBe(true);
    expect(a.verdict.reasons.join(' ')).toMatch(/market cap with \$36\.00 paid into its pool/);
    // The honeypot check ran on the pool and the sell went through: no honeypot claimed.
    expect(a.probe!.status).toBe('sellable');
    expect(a.matches.find(m => m.id === 'honeypot')).toBeUndefined();
    // The unreviewed hook can change swap amounts (return-delta bits): a Monitor of its own.
    expect(a.matches.find(m => m.id === 'malicious_hook')?.level).toBe('monitor');
  });

  it('makes no market-cap claim without an ETH price', () => {
    const { coin } = tracked(), chain = robinhoodChain(), p = probed(coin);
    const a = judge(coin, p, { chain, hypeUsd: null, nowSec: fx.launchTs + 60, head: p.block });
    expect(a.matches.find(m => m.id === 'fake_mcap')).toBeUndefined();
  });

  it('shows on New pairs as Pangea, with no graduation bar and the liquidity status named missing', () => {
    const { coin } = tracked(), chain = robinhoodChain(), p = probed(coin), now = fx.launchTs + 60;
    const a = judge(coin, p, { chain, hypeUsd: ETH_USD, nowSec: now, head: p.block });
    const ctx = { nowSec: now, head: p.block, hypeUsd: ETH_USD, native: 'ETH' as const };
    expect(pairColumn(coin, ctx)).toBe('new');
    const row = coinSummary(coin, a, ctx);
    expect(row).toMatchObject({ launchpad: 'pangea', stage: 'curve', verdict: 'danger', topPlaybook: 'fake_mcap' });
    expect(row.graduationPct).toBeUndefined();
    expect(row.marketCapUsd).toBeGreaterThan(100_000);
    expect(row.liquidityUsd).toBeCloseTo(36, 0);
    const card = coinCard(coin, a, ctx);
    expect(card.meta?.liquidity?.missing).toContain('lpStatus');
    expect(card.identity.pools[0]).toMatchObject({ venue: 'uniswap_v4', poolId: coin.poolId, hooks: addrs.pangeaHook });
  });

  it('probes the Pangea pool on the v4 route with no Pons lock reads, and refuses to trade it', async () => {
    const { coin } = tracked();
    const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
    const batches: number[] = [], routes: Address[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [tx, , overrides] = params as [{ to: Address; data: Hex }, string, Record<string, unknown> | undefined];
      if (overrides) {
        routes.push(tx.to);
        return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
          [88_877_139_509_273n, 0n, 4_900_499_999_999_950n, 5n * 10n ** 15n, true, true, '0x']);
      }
      const { args: [calls] } = decodeFunctionData({ abi: multicallAbi, data: tx.data });
      batches.push(calls.length);
      const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);
      return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: calls.map((c, i) => ({ success: true, returnData: str(i === 0 ? 'Speedd' : 'SPd') })) });
    } };
    const p = await probeRobinhoodCoin(coin as unknown as RobinhoodCoinState, BigInt(fx.launchBlock + 100), { rpc, addrs, ethUsd: () => ETH_USD });
    expect(batches).toEqual([2]);
    expect(p).toMatchObject({ name: 'Speedd', symbol: 'SPd', key: coin.key, pons: null, lock: null });
    expect(p.probe).toMatchObject({ venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}`, status: 'sellable', exitCostPct: 1.99 });
    expect(routes).toHaveLength(1);
    expect(() => robinhoodChain().trade.precheck!(coin)).toThrow(/does not trade it: its pool's hook has not been reviewed/);
  });
});

describe('Pangea fixture integrity', () => {
  it('is the launch transaction of the coin it names', () => {
    expect(new Set(logs.map(l => l.transactionHash)).size).toBe(1);
    expect(logs.some(l => l.address.toLowerCase() === fx.token && l.topics[1] === `0x${'0'.repeat(64)}`)).toBe(true);
  });
});
