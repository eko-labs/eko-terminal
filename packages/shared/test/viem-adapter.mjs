import { createRequire } from 'node:module';

// Test-only adapter: viem is already a server dependency. Shared stays dependency-free
// apart from zod; production callers supply these same functions to the pure encoder.
const { keccak256, encodeAbiParameters, stringToHex, concat } = createRequire(
  new URL('../../../apps/server/package.json', import.meta.url),
)('viem');
export const receiptHashing = { keccak256, encodeAbiParameters, stringToHex, concat };
