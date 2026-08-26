import { batchedReads } from './batched-reads.js';
import { createPublicClient, type Chain, type PublicClient } from 'viem';
import { robinhood } from 'viem/chains';
import type { PonsReadClient } from '../launchpads/pons.js';
import { RpcMeter, type MeterOptions, type RpcEnv } from './metered.js';
let standaloneMeter: RpcMeter | undefined;
const applicationMeters = new WeakMap<object, RpcMeter>();
/** One meter for blocks, reads, archive and backfill. Engines should use header and pons. */
export function createMeteredClients(env: RpcEnv, options: MeterOptions & { chain?: Chain; meter?: RpcMeter } = {}) {
  let meter = options.meter;
  if (!meter) {
    const dbOrStore = options.db ?? options.store;
    if (dbOrStore) {
      meter = applicationMeters.get(dbOrStore);
      if (!meter) { meter = new RpcMeter(env, options); applicationMeters.set(dbOrStore, meter); }
    } else {
      if (!options.standalone) throw new Error('RPC clients require the application database/store, or standalone: true');
      meter = standaloneMeter ??= new RpcMeter(env, options);
    }
  }
  meter.start();
  const chain = options.chain ?? robinhood;
  const paid = createPublicClient({ chain, transport: meter.transport() });
  const reads = createPublicClient({ chain, transport: meter.transport() });
  const archive = createPublicClient({ chain, transport: meter.transport('archive') });
  // Fork metadata, headers and lazy state loads are paid-only, including on budget closure.
  const forkArchive = createPublicClient({ chain, transport: meter.transport('fork') });
  const publicClient = createPublicClient({ chain, transport: meter.transport('backfill') });
  const head = createPublicClient({ chain, transport: meter.transport('head') });
  const headTimestamp = createPublicClient({ chain, transport: meter.transport('head_timestamp') });
  const headWs = meter.env.RPC_WS_URL ? createPublicClient({ chain, transport: meter.wsTransport() }) : null;
  return { paid, reads, archive, forkArchive, public: publicClient, head, headTimestamp, headWs, meter,
    header: (blockNumber: bigint) => paid.getBlock({ blockNumber, includeTransactions: false }),
    pons: archive as unknown as PonsReadClient,
  };
}
/** Execution may use another chain, while sharing the process meter and paid budget. */
export function createMeteredPublicClient(meter: RpcMeter, chain: Chain, publicUrl?: string): PublicClient {
  return batchedReads(createPublicClient({ chain, transport: meter.transport(publicUrl ? 'public' : 'default', publicUrl) }) as PublicClient);
}
