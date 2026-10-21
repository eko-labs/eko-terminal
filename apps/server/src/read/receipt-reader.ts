import { RpcMeter, createMeteredPublicClient, type RpcEnv, type UsageStore } from '@eko/chain';
import { robinhood } from 'viem/chains';

/** Registry receipt/header verification only; no health polling or simulation. */
export function createReceiptReader(env: RpcEnv, store: UsageStore) {
  const meter = new RpcMeter(env, { store });
  meter.start();
  const reader = createMeteredPublicClient(meter, robinhood);
  return { reader, close: () => meter.close() };
}
