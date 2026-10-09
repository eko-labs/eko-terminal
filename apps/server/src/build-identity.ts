import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import contract from './build-identity-contract.json' with { type: 'json' };
import { effectiveIdentityConfiguration, parseIdentityConfiguration, type Config } from './config.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const BuildInfoSchema = z.strictObject({
  formatVersion: z.literal(1), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  bundles: z.record(z.string(), hash).refine(value => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(contract.bundleFiles)),
  bundleDigest: hash,
}).refine(value => digest(value.bundles) === value.bundleDigest);
export type BuildInfo = z.infer<typeof BuildInfoSchema>;

// Read the baked file, never runtime EKO_SOURCE_REVISION. Source-mode development
// has no attestation; a production image with missing/invalid metadata fails closed.
export function readBuildInfo(production: boolean, file = new URL(import.meta.url.includes('/dist/') ? './build-info.json' : './missing-build-info.json', import.meta.url)): BuildInfo | null {
  try {
    const info = BuildInfoSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (production && info.sourceRevision === null) throw new Error();
    // Check the manifest against image bytes too; stale or edited metadata must
    // not produce a production ready line or public identity.
    for (const name of contract.bundleFiles) {
      const actual = createHash('sha256').update(readFileSync(new URL(name, file))).digest('hex');
      if (actual !== info.bundles[name]) throw new Error();
    }
    return info;
  } catch {
    if (production) throw new Error('Production build identity missing or invalid');
    return null;
  }
}
export function runtimeIdentity(cfg: Config, build = readBuildInfo(cfg.NODE_ENV === 'production')) {
  return { build, role: cfg.APP_ROLE, configVersion: contract.configVersion, configDigest: digest(effectiveIdentityConfiguration(cfg)) };
}
/**
 * Identity for roles without their own ready line (indexer, engines, receipts, mcp, bots): the same baked bundle
 * hashes and effective-configuration digest the api reports at /v1/build, computed from the role's environment.
 * Production fails closed on missing or edited build metadata, like the api and worker.
 */
export function roleIdentity(env: NodeJS.ProcessEnv, build = readBuildInfo(env.NODE_ENV === 'production')) {
  const caps = readFileSync(env.TRADE_CAPS_FILE ?? new URL(import.meta.url.includes('/dist/') ? './trading-caps.yaml' : '../config/trading-caps.yaml', import.meta.url), 'utf8');
  return { build, role: env.APP_ROLE, configVersion: contract.configVersion, configDigest: digest(parseIdentityConfiguration(env, caps)) };
}
// Exported in its own deterministic bundle for the offline verifier. Does not boot
// an app, open a DB, read secrets, generate keys or access providers.
export function expectedConfigDigest(env: NodeJS.ProcessEnv, tradeCapsText: string): string {
  return digest(parseIdentityConfiguration(env, tradeCapsText));
}
