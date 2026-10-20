import { z } from 'zod';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as `0x${string}`);
const raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const block = z.number().int().nonnegative().safe();
export const SecurityCollectorsSchema = z.strictObject({
  registry: z.strictObject({ startBlock: block }).optional(),
  reference: z.boolean().default(false),
  gas: z.boolean().default(false),
  wallets: z.strictObject({
    startBlock: block,
    burnToken: address,
    assets: z.array(z.strictObject({ token: address, decimals: z.number().int().min(0).max(255), maxOutflowRaw: raw })).min(1).max(64)
      .refine(v => new Set(v.map(a => a.token)).size === v.length, 'Duplicate asset'),
    intents: z.array(z.strictObject({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase()),
      token: address, to: address, maxAmountRaw: raw, purpose: z.enum(['burn', 'bridge', 'ritual']),
    })).max(1000).default([]),
  }).optional(),
});
export type SecurityCollectorsConfig = z.infer<typeof SecurityCollectorsSchema>;
/**
 * Parse and validate bounded operator collector JSON, normalizing addresses and rejecting
 * malformed configuration with fixed text that omits values. Does not authorize or start a
 * collector.
 */
export function parseSecurityCollectors(value: string): SecurityCollectorsConfig {
  // Never include configuration values (addresses or operator input) in diagnostics.
  try { return SecurityCollectorsSchema.parse(JSON.parse(value)); }
  catch { throw new Error('Invalid SECURITY_COLLECTORS configuration'); }
}
