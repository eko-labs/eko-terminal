// Synthetic execution context; no deployed route or account certification.
import { cursor, address, hash } from './guard-v2.js';
export const actualOrderSamples = { ActualOrderBinding: {
  chainId: 4663, account: address, recipient: address, coin: address, side: 'buy',
  amountIn: '1000000000000000001', minOut: '900000000000000001', slippageBps: 100,
  cursor, routeFingerprint: hash, profileHash: hash, stateFingerprint: hash, policyHash: hash,
  guardReceiptId: 'fixture-receipt', tx: { chainId: 4663, to: address, data: '0xab', value: '1000000000000000001' }, approval: null,
} };
