import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AddressRegistry } from './registry.js';

export const RegistryBuildRecordSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('src/ReceiptsRegistry.sol:ReceiptsRegistry'),
  runtimeCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  // ReceiptsRegistry has no immutables. Refuse a future build needing substitution.
  immutableReferences: z.record(z.string(), z.unknown()).refine(value => Object.keys(value).length === 0, 'Unsupported immutables'),
});
export type RegistryBuildRecord = z.infer<typeof RegistryBuildRecordSchema>;
export type BuildRecords = Readonly<Record<string, RegistryBuildRecord>>;

export function loadBuildRecords(registry: AddressRegistry): BuildRecords {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const records: Record<string, RegistryBuildRecord> = {};
  for (const [key, entry] of registry.entries()) {
    if (!key.startsWith('ours.') || !entry.build_record || entry.build_record === 'TODO') continue;
    records[entry.build_record] = RegistryBuildRecordSchema.parse(JSON.parse(readFileSync(resolve(root, entry.build_record), 'utf8')));
  }
  return records;
}
