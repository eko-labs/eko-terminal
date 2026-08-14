import { decodeEventLog, getAddress, toEventSelector, type Abi, type AbiEvent, type Address, type Log } from 'viem';
import { v3Abi, v4Abi, verifiedV4Events, erc20Abi, wethAbi } from './abis.js';
import { resolveActor, type ActorContext, type ActorTransaction } from './actor.js';
import type { AddressRegistry } from './registry.js';
export type DecoderLog = Pick<Log, 'address' | 'topics' | 'data'>;
export interface DecodeContext extends ActorContext {
  registry: AddressRegistry;
  tx?: ActorTransaction;
  /** Pool addresses discovered from a previously decoded PoolCreated. */
  isV3Pool?: (address: Address) => boolean;
}
type V3 = ReturnType<typeof decodeEventLog<typeof v3Abi>>;
type V4 = ReturnType<typeof decodeEventLog<typeof v4Abi>>;
type ERC20 = ReturnType<typeof decodeEventLog<typeof erc20Abi>>;
type WETH = ReturnType<typeof decodeEventLog<typeof wethAbi>>;
export type ChainEvent = ({ source: 'uniswap_v3' } & V3 | { source: 'uniswap_v4' } & V4 | { source: 'erc20' } & ERC20 | { source: 'weth' } & WETH) & { address: Address; actor?: Address };
export interface DecodeResult { events: ChainEvent[]; unknownTopics: number; malformedLogs: number }
/**
 * An ABI event's selector, hashed once. Every log used to hash the selector of each event it was compared with (five
 * to fifteen keccak runs per log): 20% of the indexer's CPU in a burst on 2026-10-13, when it fell 30 s behind.
 */
const selectors = new Map<object, string>();
export function eventSelector(event: AbiEvent): string {
  let selector = selectors.get(event);
  if (!selector) { selector = toEventSelector(event); selectors.set(event, selector); }
  return selector;
}
const eventOf = (abi: Abi, topic: string | undefined) => abi.find((a): a is AbiEvent => a.type === 'event' && eventSelector(a) === topic);
const verifiedV4Abi = v4Abi.filter(a => (verifiedV4Events as readonly string[]).includes(a.name));
const poolCreatedTopic = eventSelector(v3Abi[0]), transferTopic = eventSelector(erc20Abi[0]);
export function decodeResult(log: DecoderLog, ctx: DecodeContext): DecodeResult {
  const address = getAddress(log.address);
  const isAddress = (key: Parameters<AddressRegistry['addressOf']>[0]) => ctx.registry.addressOf(key)?.toLowerCase() === address.toLowerCase();
  // The one event of the matching ABI that carries this log's selector.
  let event: AbiEvent | undefined;
  let source: ChainEvent['source'] | undefined;
  if (isAddress('uniswapV3.factory') || ctx.isV3Pool?.(address)) {
    const validEmitter = isAddress('uniswapV3.factory') ? log.topics[0] === poolCreatedTopic : log.topics[0] !== poolCreatedTopic;
    const found = validEmitter ? eventOf(v3Abi, log.topics[0]) : undefined;
    if (found) { event = found; source = 'uniswap_v3'; }
  }
  if (isAddress('uniswapV4.poolManager')) {
    const found = eventOf(verifiedV4Abi, log.topics[0]);
    if (found) { event = found; source = 'uniswap_v4'; }
  }
  if (!event && isAddress('tokens.WETH')) { const found = eventOf(wethAbi, log.topics[0]); if (found) { event = found; source = 'weth'; } }
  // ERC-721 uses the same selector, but indexes its token id instead of ERC-20 data.
  if (log.topics[0] === transferTopic && log.topics.length === 4 && log.data === '0x') return { events: [], unknownTopics: 0, malformedLogs: 0 };
  if (!event) { const found = eventOf(erc20Abi, log.topics[0]); if (found) { event = found; source = 'erc20'; } }
  if (!event || !source) return { events: [], unknownTopics: 1, malformedLogs: 0 };
  try {
    const decoded = decodeEventLog({ abi: [event], topics: log.topics, data: log.data, strict: true });
    return { events: [{ ...decoded, source, address, ...(ctx.tx ? { actor: resolveActor(ctx.tx, ctx) } : {}) } as unknown as ChainEvent], unknownTopics: 0, malformedLogs: 0 };
  } catch { return { events: [], unknownTopics: 0, malformedLogs: 1 }; }
}
export function decode(log: DecoderLog, ctx: DecodeContext): ChainEvent[] { return decodeResult(log, ctx).events; }
export function decodeBatch(logs: readonly DecoderLog[], ctx: DecodeContext): DecodeResult {
  return logs.reduce<DecodeResult>((total, log) => {
    const result = decodeResult(log, ctx);
    return { events: [...total.events, ...result.events], unknownTopics: total.unknownTopics + result.unknownTopics, malformedLogs: total.malformedLogs + result.malformedLogs };
  }, { events: [], unknownTopics: 0, malformedLogs: 0 });
}
