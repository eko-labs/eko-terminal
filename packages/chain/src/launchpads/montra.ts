import { decodeEventLog, getAddress, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex } from 'viem';
import { eventSelector, type DecoderLog } from '../decoders.js';
import type { PoolRef } from '@eko/shared';
import type { ElysiumRegistry } from '../elysium/registry.js';
import type { LaunchpadAdapter, LaunchpadEvent } from './types.js';

/**
 * Montra (montramarkets.xyz), the largest launchpad on Elysium (~57% of new pools on 2026-11-10).
 *
 * One factory transaction creates the token, its dynamic-fee Uniswap v4 pool with Montra's hook, the permanently
 * locked liquidity and the creator's first buy. There is no bonding curve and no migration: "graduation" is a marker
 * in the same pool. Events from Montra's published ABI (https://montramarkets.xyz/docs/abis/events.json).
 */
export const montraFactoryAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 configId, address quote, bool quoteIsCurrency0, uint256 supply, int24 startTick, address feeRecipient, bool feeLocked, uint256 firstBuyIn, uint256 firstBuyOut)',
]);
export const montraHookAbi = parseAbi(['event Graduated(bytes32 indexed poolId)']);
const launchEvent = montraFactoryAbi[0] as AbiEvent, graduatedEvent = montraHookAbi[0] as AbiEvent;
const launchTopic = eventSelector(launchEvent), graduatedTopic = eventSelector(graduatedEvent);

/** What the caller recorded about a pool at launch; liquidity and executability are not in the Graduated event. */
export type MontraPool = { token: Address } & Pick<PoolRef, 'quote' | 'feeBps' | 'liquidityUsd' | 'executable'>;
export interface MontraContext {
  registry: ElysiumRegistry;
  /** Pools seen at launch, by v4 pool id. A graduation for an unknown pool is skipped, never guessed. */
  poolById(poolId: Hex): MontraPool | null;
}

export function decodeMontraResult(log: DecoderLog, ctx: MontraContext): { events: LaunchpadEvent[]; unknownTopics: number; malformedLogs: number } {
  const from = log.address.toLowerCase();
  const factory = ctx.registry.address('montra.factory').toLowerCase(), hook = ctx.registry.address('montra.hook');
  const topic = log.topics[0];
  const isLaunch = from === factory && topic === launchTopic;
  const isGraduated = from === hook.toLowerCase() && topic === graduatedTopic;
  if (!isLaunch && !isGraduated) return { events: [], unknownTopics: 1, malformedLogs: 0 };
  try {
    if (isLaunch) {
      const { args } = decodeEventLog({ abi: montraFactoryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      return { events: [{
        kind: 'launch', token: getAddress(args.token), deployer: getAddress(args.creator), curve: hook,
        poolId: args.poolId, quote: getAddress(args.quote), launchConfigId: args.configId, supply: args.supply,
        firstBuyIn: args.firstBuyIn, firstBuyOut: args.firstBuyOut, feeRecipient: getAddress(args.feeRecipient), feeLocked: args.feeLocked, startTick: args.startTick, quoteIsCurrency0: args.quoteIsCurrency0,
      }], unknownTopics: 0, malformedLogs: 0 };
    }
    const { args } = decodeEventLog({ abi: montraHookAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    const pool = ctx.poolById(args.poolId);
    if (!pool) return { events: [], unknownTopics: 0, malformedLogs: 0 };
    const { token, ...known } = pool;
    return { events: [{ kind: 'graduated', token, pool: { id: args.poolId, venue: 'uniswap_v4', poolId: args.poolId, hooks: hook, ...known } }],
      unknownTopics: 0, malformedLogs: 0 };
  } catch { return { events: [], unknownTopics: 0, malformedLogs: 1 }; }
}
export const decodeMontra = (log: DecoderLog, ctx: MontraContext): LaunchpadEvent[] => decodeMontraResult(log, ctx).events;

/** A launch quoted in native HYPE reports the zero address as its quote. */
export const isNativeQuote = (quote: Address) => quote === zeroAddress;

export function createMontraAdapter(ctx: MontraContext): LaunchpadAdapter {
  return {
    id: 'montra',
    addresses: () => [ctx.registry.address('montra.factory'), ctx.registry.address('montra.hook')],
    decode: log => decodeMontra(log as DecoderLog, ctx),
  };
}
