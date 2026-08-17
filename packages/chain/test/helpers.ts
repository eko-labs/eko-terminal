import { encodeAbiParameters, encodeEventTopics, getAddress, type AbiEvent, type Address, type Hex, type Log } from 'viem';
export interface RawLog { address: string; topics: string[]; data: string; blockNumber?: string; transactionHash?: string; logIndex?: number | string }
export function logOf(raw: RawLog): Log {
  return { address: getAddress(raw.address), topics: raw.topics as [Hex, ...Hex[]], data: raw.data as Hex, blockNumber: BigInt(raw.blockNumber ?? 0), blockHash: null, transactionHash: raw.transactionHash as Hex ?? null, transactionIndex: null, logIndex: raw.logIndex == null ? null : Number(raw.logIndex), removed: false };
}
/** Synthetic only: supplements event shapes absent from the pinned RPC window. */
export function syntheticLog(address: Address, event: AbiEvent, args: Record<string, unknown>): Log {
  return logOf({ address, topics: encodeEventTopics({ abi: [event], args }) as string[], data: encodeAbiParameters(event.inputs.filter(p => !p.indexed), event.inputs.filter(p => !p.indexed).map(p => args[p.name!])) });
}
