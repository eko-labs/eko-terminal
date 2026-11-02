import { readdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { registerAccountRoutes } from '../accounts.js';
import { FlagNameSchema, type FlagName } from '@eko/shared';
import type { AccountStore } from '../accounts.js';
import type { HistoryStore } from '../history.js';
import type { Edge } from '../service.js';

/**
 * Post-launch features, each in its own folder: src/features/<flag>/index.ts, where <flag> is the feature's flag name
 * (packages/shared/src/flags.ts). The edge finds the folders by itself and loads only those whose flag is on
 * (EKO_FLAGS), so adding a feature never edits a shared file, and the public copy can leave a feature's folder out
 * until it is on (scripts/public/publish.mjs, docs/FLAGS.md).
 *
 * A folder's index.ts default-exports a `Feature`: `register` adds its API routes (under /v1 or /v2).
 */
export interface FeatureContext {
  app: FastifyInstance; edge: Edge; store?: HistoryStore; accounts?: AccountStore;
  /** Wallet sign-in, when accounts are open: `need(req, reply)` is the signed-in account, or sends the 401. */
  auth?: ReturnType<typeof registerAccountRoutes>;
}
export interface Feature { register(ctx: FeatureContext): void }
export interface LoadedFeature extends Feature { flag: FlagName }

const HERE = new URL('./', import.meta.url);

/** The feature folders whose flag is on. A folder not named after a flag, or without an index, is skipped. */
export async function loadFeatures(on: ReadonlySet<string>, dir: URL = HERE): Promise<LoadedFeature[]> {
  const out: LoadedFeature[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const flag = FlagNameSchema.safeParse(entry.name);
    if (!entry.isDirectory() || !flag.success || !on.has(flag.data)) continue;
    const mod = await import(new URL(`${entry.name}/index.ts`, dir).href).catch((error: Error) => {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null; throw error;
    }) as { default?: Feature } | null;
    if (mod?.default) out.push({ flag: flag.data, ...mod.default });
  }
  return out;
}
