import type { ChainClient } from './types.js';
export type LogFilter = Parameters<ChainClient['logs']>[0];
export const ADDRESS_BLOCK_BUDGET = 200_000;
export const MAX_LOG_BLOCKS = 100_000;
export const MAX_LOG_ADDRESSES = 50;
export function logBlockLimit(filter: Pick<LogFilter, 'address' | 'addresses'>): number {
  const addresses = filter.addresses?.length || (filter.address ? 1 : 5);
  return Math.min(MAX_LOG_BLOCKS, Math.floor(ADDRESS_BLOCK_BUDGET / addresses));
}
export function addressBatches(filter: LogFilter): LogFilter[] {
  if (!filter.addresses) return [filter];
  if (!filter.addresses.length) throw new Error('Empty log address filter');
  const batches: LogFilter[] = [];
  for (let i=0;i<filter.addresses.length;i+=MAX_LOG_ADDRESSES) batches.push({ ...filter, addresses: filter.addresses.slice(i,i+MAX_LOG_ADDRESSES) });
  return batches;
}

export function* budgetedQueries(filter: LogFilter): Generator<LogFilter> {
  if (filter.from < 0n || filter.to < filter.from) throw new Error('Invalid log interval');
  for (const batch of addressBatches(filter)) {
    const limit = BigInt(logBlockLimit(batch));
    for (let from=batch.from;from<=batch.to;) {
      const to = from+limit-1n < batch.to ? from+limit-1n : batch.to;
      yield { ...batch, from, to };
      from=to+1n;
    }
  }
}
