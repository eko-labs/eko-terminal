import type { Address } from 'viem';
import { receiptReadClient } from './wallet';

// TODO(address): publish the verified deployment from addresses.4663.yaml before
// enabling verification. Never accept an API-selected registry as the trust anchor.
export const PUBLISHED_RECEIPTS_REGISTRY: Address | null = null;
export const keylessReceiptReader = receiptReadClient;
