import { describe, expect, it } from 'vitest';
import { getAddress, toHex, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import fx from './fixtures/launchpads.json' with { type: 'json' };
import { decodeLaunch, flaunchTrade, FLAUNCH_POOL_SWAP } from '../src/launchpads.js';
import { SWAP_TOPIC, Tracker, TRANSFER_TOPIC, type RawLog, type Rpc } from '../src/tracker.js';

const registry = loadElysiumRegistry();
const log = (l: { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }) => l as unknown as RawLog;

describe('other launchpads', () => {
  it('decodes Flaunch-fork, HyperForge and tax-launchpad launches from mainnet logs, keys checked against their pool ids', () => {
    const f = decodeLaunch(log(fx.flaunchLaunch[0]!), registry)!;
    expect(f).toMatchObject({ launchpad: 'flaunch', token: getAddress('0x23692bb86ac3beff1e109d7c336f4eeeb05e882f'), creator: getAddress('0x58170d525583f40e53dba377237d029b6c087a04'),
      flipped: false, name: 'Kori & Mu', symbol: 'KoriMu', key: { fee: 0, tickSpacing: 60, hooks: registry.address('flaunchFork.hook') } });
    expect(decodeLaunch(log(fx.hyperforgeLaunch[0]!), registry)).toMatchObject({ launchpad: 'hyperforge', name: 'eaccat', symbol: 'EACCAT', key: { fee: 10_000, tickSpacing: 200 } });
    expect(decodeLaunch(log(fx.taxLaunch[0]!), registry)).toMatchObject({ launchpad: 'taxlaunch', supply: 10n ** 27n, key: { hooks: registry.address('otherLaunchpads.taxLaunchHook') } });
    const u = decodeLaunch(log(fx.unbrandedLaunch[0]!), registry)!;
    expect(u).toMatchObject({ launchpad: 'unbranded', creator: getAddress(fx.unbrandedFrom), manager: registry.address('unbrandedLauncher.poolManager'),
      key: { fee: 0, tickSpacing: 200, hooks: registry.address('unbrandedLauncher.hook') } });
    expect(u.name).toBeTruthy();
    // The same PoolCreated from any other contract is not a Flaunch launch; a pool id that does not match its key is dropped.
    expect(decodeLaunch({ ...log(fx.flaunchLaunch[0]!), address: '0x00000000000000000000000000000000000000f1' }, registry)).toBeNull();
    const wrongPool = { ...log(fx.hyperforgeLaunch[0]!) }; wrongPool.topics = [...wrongPool.topics]; wrongPool.topics[3] = `0x${'11'.repeat(32)}`;
    expect(decodeLaunch(wrongPool, registry)).toBeNull();
  });

  it('prices a Flaunch-fork trade from its PoolSwap: all three legs, net of fees, matching what the buyer received', () => {
    const swap = fx.flaunchBuy.find(l => l.topics[0] === FLAUNCH_POOL_SWAP)!;
    const received = fx.flaunchBuy.filter(l => l.topics[0] === TRANSFER_TOPIC).at(-1)!;
    const t = flaunchTrade(swap.data as Hex, false)!;
    expect(t.side).toBe('buy');
    expect(t.hype).toBeCloseTo(0.0157, 10);
    expect(t.tokens).toBeCloseTo(Number(BigInt(received.data)) / 1e18, 6);
    // The Uniswap leg alone (the PoolManager's Swap event) misses the internal-pool fill.
    const pm = fx.flaunchBuy.find(l => l.topics[0] === SWAP_TOPIC)!;
    expect(BigInt(`0x${pm.data.slice(66, 130)}`)).toBeLessThan(BigInt(received.data));
  });

  it('tracks a Flaunch-fork launch and counts its trades once, from PoolSwap only', () => {
    const tracker = new Tracker({ request: async () => { throw new Error('no rpc'); } } as Rpc, registry);
    const launch = log(fx.flaunchLaunch[0]!);
    const poolId = launch.topics[1]!;
    const swap = fx.flaunchBuy.find(l => l.topics[0] === FLAUNCH_POOL_SWAP)!, pm = fx.flaunchBuy.find(l => l.topics[0] === SWAP_TOPIC)!;
    const at = (l: RawLog, block: number, i: number) => ({ ...l, blockNumber: toHex(block), logIndex: toHex(i) });
    const b = Number(launch.blockNumber);
    tracker.applyAll([at(launch, b, 0), at({ ...log(pm), topics: [pm.topics[0]!, poolId, pm.topics[2]!] as Hex[] }, b + 5, 1),
      at({ ...log(swap), topics: [swap.topics[0]!, poolId] as Hex[] }, b + 5, 2)], () => 1_794_400_000);
    const coin = tracker.coin('0x23692bb86ac3beff1e109d7c336f4eeeb05e882f')!;
    expect(coin).toMatchObject({ launchpad: 'flaunch', supplyFromMints: true, launcher: registry.address('flaunchFork.hook') });
    expect(coin.trades).toHaveLength(1);
    expect(coin.trades[0]).toMatchObject({ side: 'buy', hype: 0.0157 });
    expect(tracker.feed.at(-1)).toMatchObject({ kind: 'new_pair', coin: coin.token });
  });
});
