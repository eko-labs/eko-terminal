import { describe, expect, it } from 'vitest';
import { getAddress, toEventSelector, zeroAddress, type Hex } from 'viem';
import { createMontraAdapter, decodeMontra, decodeMontraResult, isNativeQuote, montraFactoryAbi, montraHookAbi } from '../src/launchpads/montra.js';
import { loadElysiumRegistry } from '../src/elysium/registry.js';
import { logOf } from './helpers.js';
import launch from './fixtures/99901/montra-launch.json' with { type: 'json' };
import graduated from './fixtures/99901/montra-graduated.json' with { type: 'json' };

const registry = loadElysiumRegistry();
const gradPool = graduated.graduated.args.poolId as Hex;
const ctx = { registry, poolById: (id: Hex) => id === gradPool ? { token: getAddress(launch.launch.args.token), quote: zeroAddress, feeBps: 200, liquidityUsd: 58700, executable: true } : null };

describe('Montra adapter (Elysium, pinned mainnet logs)', () => {
  it('matches the selectors in the captured logs and takes its addresses only from the registry', () => {
    expect(launch.launch.topics[0]).toBe(toEventSelector(montraFactoryAbi[0]));
    expect(graduated.graduated.topics[0]).toBe(toEventSelector(montraHookAbi[0]));
    const adapter = createMontraAdapter(ctx);
    expect(adapter.id).toBe('montra');
    expect(adapter.addresses()).toEqual([registry.address('montra.factory'), registry.address('montra.hook')]);
  });

  it('decodes a real TokenLaunched with its first buy', () => {
    const a = launch.launch.args;
    expect(decodeMontra(logOf(launch.launch), ctx)).toEqual([{
      kind: 'launch', token: getAddress(a.token), deployer: getAddress(a.creator), curve: registry.address('montra.hook'),
      poolId: a.poolId, quote: zeroAddress, launchConfigId: BigInt(a.configId), supply: BigInt(a.supply),
      firstBuyIn: BigInt(a.firstBuyIn), firstBuyOut: BigInt(a.firstBuyOut), feeRecipient: getAddress(a.feeRecipient), feeLocked: a.feeLocked,
      startTick: Number(a.startTick), quoteIsCurrency0: a.quoteIsCurrency0,
    }]);
    expect(isNativeQuote(zeroAddress)).toBe(true);
  });

  it('ignores a launch-shaped log from any address other than the registered factory', () => {
    const spoof = { ...logOf(launch.launch), address: getAddress(launch.tx.from) };
    expect(decodeMontraResult(spoof, ctx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
  });

  it('maps a graduation to its token only when the pool is known', () => {
    expect(decodeMontra(logOf(graduated.graduated), ctx)).toEqual([{ kind: 'graduated', token: getAddress(launch.launch.args.token),
      pool: { id: gradPool, venue: 'uniswap_v4', poolId: gradPool, hooks: registry.address('montra.hook'), quote: zeroAddress, feeBps: 200, liquidityUsd: 58700, executable: true } }]);
    expect(decodeMontraResult(logOf(graduated.graduated), { registry, poolById: () => null })).toEqual({ events: [], unknownTopics: 0, malformedLogs: 0 });
  });

  it('counts a truncated launch log as malformed instead of throwing', () => {
    const broken = { ...logOf(launch.launch), data: launch.launch.data.slice(0, 66) as Hex };
    expect(decodeMontraResult(broken, ctx)).toEqual({ events: [], unknownTopics: 0, malformedLogs: 1 });
  });
});
