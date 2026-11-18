import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId } from '@eko/chain';
import unbranded from './fixtures/robinhood/unbranded-launch.json' with { type: 'json' };
import longxyz from './fixtures/robinhood/longxyz-launch.json' with { type: 'json' };
import {
  decodeRobinhoodLog, INITIALIZE_TOPIC, LONG_CREATE_TOPIC, MODIFY_LIQUIDITY_TOPIC, probeRobinhoodCoin, robinhoodAddresses, robinhoodChain, robinhoodExcluded,
  robinhoodLogQueries, UNBRANDED_LAUNCH_TOPIC, type RawRobinhoodLog, type RobinhoodCoinState, type RobinhoodProbed,
} from '../src/chains/robinhood/index.js';
import { judge } from '../src/assess.js';
import { coinCard, coinSummary, pairColumn } from '../src/views.js';
import { Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';

/**
 * Robinhood Chain launchpads beside Pons and Pangea, from logs read on chain on 2026-11-18:
 * - the unbranded hookless launcher: one launch (fixtures/robinhood/unbranded-launch.json), its pool's swaps and the
 *   creator taking the launch liquidity out about ten seconds later;
 * - long.xyz (Doppler Airlock): a launch whose numeraire is native ETH (fixtures/robinhood/longxyz-launch.json).
 */
const addrs = robinhoodAddresses(loadRegistry());
const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };
const ETH_USD = 1800;
const SECONDS_PER_BLOCK = 0.1;
const stamp = (launchBlock: number, launchTs: number) => (l: RawLog) => Math.round(launchTs + (Number(BigInt(l.blockNumber)) - launchBlock) * SECONDS_PER_BLOCK);
const ub = { ...unbranded, launchTx: unbranded.launchTx as unknown as RawLog[], after: unbranded.after as unknown as RawLog[] };
const lx = { ...longxyz, launchTx: longxyz.launchTx as unknown as RawLog[] };
const ubToken = getAddress(ub.token), lxToken = getAddress(lx.token);
const ubRecord = ub.launchTx.find(l => l.topics[0] === UNBRANDED_LAUNCH_TOPIC)!;
const lxRecord = lx.launchTx.find(l => l.topics[0] === LONG_CREATE_TOPIC)!;
const pull = ub.after.find(l => l.topics[0] === MODIFY_LIQUIDITY_TOPIC && BigInt.asIntN(256, BigInt(`0x${l.data.slice(130, 194)}`)) < 0n)!;

function track(logs: RawLog[], launchBlock: number, launchTs: number) {
  const tracker = new Tracker(offline, robinhoodChain());
  tracker.applyAll(logs, stamp(launchBlock, launchTs));
  return tracker;
}
/** A sell check that went through (as it does on these pools: a hookless pool, no transfer tax measured). */
function probed(coin: CoinState, block: number, ts: number): RobinhoodProbed {
  return { block, at: new Date(ts * 1000).toISOString(), name: 'Sample', symbol: 'SMPL', key: coin.key, config: null, currentBuyFeePips: null, probeUsd: 1000,
    tips: {}, pons: null, lock: null,
    probe: { method: 'sell-check-1', venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}`, block: String(block), sizeWei: '5000000000000000', status: 'sellable',
      reason: null, spentWei: '5000000000000000', tokens: '1', returnedWei: '4950000000000000', quotedSellWei: null, exitCostPct: 1, revert: null, requests: 1 } as never };
}

describe('the unbranded hookless launcher (Robinhood Chain)', () => {
  it('decodes its launch record: creator, coin, the hookless native-ETH key that hashes to the logged pool id, and the launch position', () => {
    const e = decodeRobinhoodLog(ubRecord as RawRobinhoodLog, addrs);
    expect(e).toMatchObject({ kind: 'pool_launch', launchpad: 'unbranded', token: ubToken, creator: getAddress(ub.creator), launcher: addrs.unbrandedLauncher });
    if (e?.kind !== 'pool_launch') throw new Error('not a launch');
    expect(e.key).toMatchObject({ currency0: zeroAddress, currency1: ubToken, tickSpacing: 200, hooks: zeroAddress });
    expect(v4PoolId(e.key!).toLowerCase()).toBe(e.poolId);
    expect(e.poolId).toBe(ub.launchTx.find(l => l.topics[0] === INITIALIZE_TOPIC)!.topics[1]!.toLowerCase());
    expect(e.launchPosition!.owner).toBe(getAddress(ub.creator));
    expect(e.launchPosition!.seed).toBeGreaterThan(0n);
  });

  it('skips the record from another contract, a malformed one, and one whose key does not hash to its pool id', () => {
    expect(decodeRobinhoodLog({ ...ubRecord, address: addrs.factory } as RawRobinhoodLog, addrs)).toBeNull();
    expect(decodeRobinhoodLog({ ...ubRecord, data: ubRecord.data.slice(0, -64) as Hex } as RawRobinhoodLog, addrs)).toBeNull();
    // The fee word changed: the rebuilt key no longer hashes to the logged pool id.
    const data = `${ubRecord.data.slice(0, 2 + 64)}${'0'.repeat(60)}0bb8${ubRecord.data.slice(2 + 128)}` as Hex;
    expect(decodeRobinhoodLog({ ...ubRecord, data } as RawRobinhoodLog, addrs)).toBeNull();
  });

  it('follows the coin from its launch: supply from its mint, the launch position, its swaps, then the pull', () => {
    const before = track([...ub.launchTx, ...ub.after.filter(l => BigInt(l.blockNumber) < BigInt(pull.blockNumber))], ub.launchBlock, ub.launchTs).coin(ubToken)!;
    expect(before).toMatchObject({ launchpad: 'unbranded', graduated: false, quote: zeroAddress, manager: addrs.poolManager, creator: getAddress(ub.creator) });
    expect(before.supply).toBeGreaterThan(0n);
    expect(before.trades.length).toBeGreaterThan(0);
    expect(before.launchPosition!.liquidity).toBeGreaterThan(0n);
    expect(before.launchPosition!.removed).toBe(0n);
    const after = track([...ub.launchTx, ...ub.after], ub.launchBlock, ub.launchTs).coin(ubToken)!;
    expect(after.launchPosition!.removed).toBeGreaterThan(0n);
    expect(after.launchPosition!.removedTx).toBe(pull.transactionHash);
  });

  it('rates the creator\'s removable launch liquidity Monitor, and Danger once it is taken out', () => {
    const chain = robinhoodChain();
    const rate = (logs: RawLog[]) => {
      const coin = track(logs, ub.launchBlock, ub.launchTs).coin(ubToken)!, block = Number(BigInt(logs.at(-1)!.blockNumber)), now = ub.launchTs + 30;
      return { coin, a: judge(coin, probed(coin, block, now), { chain, hypeUsd: ETH_USD, nowSec: now, head: block }), now, block };
    };
    const live = rate([...ub.launchTx, ...ub.after.filter(l => BigInt(l.blockNumber) < BigInt(pull.blockNumber))]);
    expect(live.a.matches.find(m => m.id === 'removable_liquidity')?.level).toBe('monitor');
    expect(live.a.lp).toBe('removable');
    const pulled = rate([...ub.launchTx, ...ub.after]);
    const m = pulled.a.matches.find(x => x.id === 'removable_liquidity')!;
    expect(m.level).toBe('danger');
    expect(m.evidence.some(e => e.kind === 'tx' && e.ref === pull.transactionHash)).toBe(true);
    expect(pulled.a.verdict.level).toBe('danger');
    // Shown on New pairs as the unbranded launcher's, with no graduation bar and its liquidity status claimed (checked).
    const ctx = { nowSec: pulled.now, head: pulled.block, hypeUsd: ETH_USD, native: 'ETH' as const };
    expect(pairColumn(pulled.coin, ctx)).toBe('new');
    expect(coinSummary(pulled.coin, pulled.a, ctx)).toMatchObject({ launchpad: 'unbranded', verdict: 'danger' });
    expect(coinSummary(pulled.coin, pulled.a, ctx).graduationPct).toBeUndefined();
    const card = coinCard(pulled.coin, pulled.a, ctx);
    expect(card.liquidity.lpStatus).toBe('removable');
    expect(card.meta?.liquidity?.missing).not.toContain('lpStatus');
  });

  it('is tradeable through the Universal Router (no hook), and lists its launcher as a non-holder', () => {
    const coin = track(ub.launchTx, ub.launchBlock, ub.launchTs).coin(ubToken)!;
    expect(() => robinhoodChain().trade.precheck!(coin)).not.toThrow();
    expect(robinhoodExcluded(undefined, addrs)).toContain(addrs.unbrandedLauncher);
  });

  it('probes its pool on the v4 route, with no Pons lock reads', async () => {
    const coin = track(ub.launchTx, ub.launchBlock, ub.launchTs).coin(ubToken)!;
    const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
    const batches: number[] = [], routes: Address[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [tx, , overrides] = params as [{ to: Address; data: Hex }, string, Record<string, unknown> | undefined];
      if (overrides) {
        routes.push(tx.to);
        return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
          [10n ** 20n, 0n, 9n * 10n ** 15n, 10n ** 16n, true, true, '0x']);
      }
      const { args: [calls] } = decodeFunctionData({ abi: multicallAbi, data: tx.data });
      batches.push(calls.length);
      return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: calls.map(() => ({ success: true, returnData: encodeAbiParameters([{ type: 'string' }], ['X']) })) });
    } };
    const p = await probeRobinhoodCoin(coin as unknown as RobinhoodCoinState, BigInt(ub.launchBlock + 10), { rpc, addrs, ethUsd: () => ETH_USD });
    expect(batches).toEqual([2]);
    expect(p).toMatchObject({ key: coin.key, pons: null, lock: null });
    expect(p.probe).toMatchObject({ venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}`, status: 'sellable' });
    expect(routes).toHaveLength(1);
  });
});

describe('long.xyz (Doppler Airlock, Robinhood Chain)', () => {
  it('decodes the Airlock\'s Create for a native-ETH numeraire: the coin, no deployer identified, the key left to the Initialize', () => {
    const e = decodeRobinhoodLog(lxRecord as RawRobinhoodLog, addrs);
    expect(e).toMatchObject({ kind: 'pool_launch', launchpad: 'longxyz', token: lxToken, creator: lxToken, key: null, launcher: addrs.longAirlock });
  });

  it('skips a Create in another numeraire (stock tokens, WETH, USDG: 879 of 881 launches in 24 hours) or from another contract', () => {
    const quoted = { ...lxRecord, topics: [lxRecord.topics[0]!, `0x${'0'.repeat(24)}${'0bd7d308f8e1639fab988df18a8011f41eacad73'}` as Hex] };
    expect(decodeRobinhoodLog(quoted as RawRobinhoodLog, addrs)).toBeNull();
    expect(decodeRobinhoodLog({ ...lxRecord, address: addrs.factory } as RawRobinhoodLog, addrs)).toBeNull();
  });

  it('follows the coin: key and opening price from its Doppler hook\'s Initialize, then its swaps; checked, never traded', () => {
    const tracker = track(lx.launchTx, lx.launchBlock, lx.launchTs), coin = tracker.coin(lxToken)!;
    const init = lx.launchTx.find(l => l.topics[0] === INITIALIZE_TOPIC)!;
    expect(coin).toMatchObject({ launchpad: 'longxyz', graduated: false, quote: zeroAddress, poolId: init.topics[1]!.toLowerCase() });
    expect(coin.key).toMatchObject({ currency0: zeroAddress, currency1: lxToken, hooks: addrs.longHook });
    expect(coin.supply).toBeGreaterThan(0n);
    expect(coin.openPrice).toBeGreaterThan(0);
    expect(tracker.coinByPool(coin.poolId)?.token).toBe(lxToken);
    expect(coin.trades.length).toBeGreaterThan(0);
    const facts = robinhoodChain().facts(coin, probed(coin, lx.launchBlock, lx.launchTs), lx.launchTs + 5);
    expect(facts.hook).toMatchObject({ reviewed: false, label: expect.stringContaining('long.xyz') });
    expect(facts.backing).toBeDefined();
    // The key's fee is v4's dynamic-fee flag (0x800000), not a fee: no fee-trap reading of it.
    expect(coin.key!.fee).toBe(0x800000);
    expect(facts.feeBps).toBe(0);
    const a = judge(coin, probed(coin, lx.launchBlock, lx.launchTs), { chain: robinhoodChain(), hypeUsd: ETH_USD, nowSec: lx.launchTs + 5, head: lx.launchBlock });
    expect(a.matches.find(m => m.id === 'fee_trap_pool')).toBeUndefined();
    expect(a.matches.find(m => m.id === 'malicious_hook')?.level).toBe('monitor');
    expect(() => robinhoodChain().trade.precheck!(coin)).toThrow(/hook has not been reviewed/);
  });
});

describe('Robinhood log queries', () => {
  it('fetch the new launch records in the existing topic-OR call and liquidity changes in one more', () => {
    const q = robinhoodLogQueries(addrs);
    expect(q).toHaveLength(3);
    expect(q[0]!.topics[0]).toEqual(expect.arrayContaining([LONG_CREATE_TOPIC, UNBRANDED_LAUNCH_TOPIC]));
    expect(q[2]).toEqual({ address: addrs.poolManager, topics: [MODIFY_LIQUIDITY_TOPIC] });
  });
});
