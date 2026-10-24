import type { ComponentType } from 'react';
import { FlagNameSchema, type FlagName } from '@eko/shared';

/**
 * Post-launch features, each in its own folder: src/features/<flag>/index.ts, where <flag> is the feature's flag name
 * (packages/shared/src/flags.ts). Folders are found here by themselves, so adding a feature never edits a shared file,
 * and the public copy can leave a feature's folder out until its flag is on (scripts/public/publish.mjs, docs/FLAGS.md).
 *
 * A folder's index.ts default-exports a `Feature`: its pages (shown only while the flag is on) and its menu entries.
 * Pages load lazily, so a feature that is off costs one small module.
 */
export type FeaturePage = () => Promise<{ default: ComponentType<{ params: Record<string, string> }> }>;
export interface FeatureRoute {
  path: string; title: string; load: FeaturePage;
  workspace?: 'terminal' | 'mission' | 'trust' | 'static'; auth?: 'public' | 'siwe';
}
export interface FeatureNav { group: 'Terminal' | 'Mission Control' | 'Public record'; to: string; label: string; icon?: ComponentType<{ size?: number }> }
export interface Feature { routes?: FeatureRoute[]; nav?: FeatureNav[] }

/** The feature folders in a glob result, keyed by flag. Folders not named after a flag are skipped. */
export function featuresFrom(modules: Record<string, { default: Feature }>): ({ flag: FlagName } & Feature)[] {
  return Object.entries(modules).flatMap(([file, mod]) => {
    const flag = FlagNameSchema.safeParse(file.split('/').at(-2));
    return flag.success ? [{ flag: flag.data, ...mod.default }] : [];
  });
}

export const FEATURES = featuresFrom(import.meta.glob<{ default: Feature }>('./features/*/index.ts', { eager: true }));
