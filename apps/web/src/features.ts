import type { ComponentType } from 'react';
import { FlagNameSchema, type FlagName, type Flags } from '@eko/shared';
import type { ChartCore } from './components/chart/chartCore';

/**
 * Post-launch features, each in its own folder: src/features/<flag>/index.ts, where <flag> is the feature's flag name
 * (packages/shared/src/flags.ts). Folders are found here by themselves, so adding a feature never edits a shared file,
 * and the public copy can leave a feature's folder out until its flag is on (scripts/public/publish.mjs, docs/FLAGS.md).
 *
 * A folder's index.ts default-exports a `Feature`: its pages (shown only while the flag is on) and its menu entries.
 * Pages load lazily, so a feature that is off costs one small module. A feature may also fill places on the coin page
 * (`coin`: components/coinSlots.tsx); make those lazy too.
 */
export type FeaturePage = () => Promise<{ default: ComponentType<{ params: Record<string, string> }> }>;
export interface FeatureRoute {
  path: string; title: string; load: FeaturePage;
  workspace?: 'terminal' | 'mission' | 'trust' | 'static'; auth?: 'public' | 'siwe';
}
export interface FeatureNav { group: 'Terminal' | 'Mission Control' | 'Public record'; to: string; label: string; icon?: ComponentType<{ size?: number }> }
/** Places on the coin page a feature can fill, shown only while its flag is on (components/coinSlots.tsx). */
export interface CoinSlots {
  /** Over the price chart's plot: position with the chart core's coordinates and redraw on `core.onRedraw`. */
  chartOverlay?: ComponentType<{ coin: string; core: ChartCore }>;
  /** In a row under the chart (a key, toggles). */
  chartKey?: ComponentType<{ coin: string }>;
  /** After a wallet address in the coin page's Flow and Trades tabs. */
  wallet?: ComponentType<{ coin: string; wallet: string }>;
}
/** Links a feature takes over while its flag is on. Shared pages ask for a link by kind (featureLink), never by feature. */
export interface FeatureLinks { deployer?: (address: string) => string }
/** Mock mode only (src/mocks/transport.ts): answers for the feature's API routes, undefined for routes it does not serve. */
export type FeatureMocks = () => Promise<{ default: (route: string, method: string) => unknown }>;
/**
 * Example data for mock mode (VITE_MOCKS=1, with the feature's flag in VITE_FLAGS), loaded only there: it answers the
 * feature's own API routes and pushes its socket events, so the feature renders offline (demos, update films).
 */
export interface FeatureDemo {
  /** Answer a request to one of the feature's routes (`route` has no /v1 prefix), or return undefined to pass. */
  fetch?(req: { method: string; route: string; query: URLSearchParams; body: unknown }): { status?: number; body: unknown } | undefined;
  /** Start pushing events on a channel a page subscribed to; return a stop function, or undefined to pass. */
  channel?(ch: string, push: (kind: string, data: unknown) => void): (() => void) | undefined;
}
export interface Feature { routes?: FeatureRoute[]; nav?: FeatureNav[]; coin?: CoinSlots; links?: FeatureLinks; mocks?: FeatureMocks; demo?: () => Promise<{ default: FeatureDemo }> }

/** The feature folders in a glob result, keyed by flag. Folders not named after a flag are skipped. */
export function featuresFrom(modules: Record<string, { default: Feature }>): ({ flag: FlagName } & Feature)[] {
  return Object.entries(modules).flatMap(([file, mod]) => {
    const flag = FlagNameSchema.safeParse(file.split('/').at(-2));
    return flag.success ? [{ flag: flag.data, ...mod.default }] : [];
  });
}

export const FEATURES = featuresFrom(import.meta.glob<{ default: Feature }>('./features/*/index.ts', { eager: true }));

/** The link an enabled feature gives for `kind` (a deployer's page, say), or null when no feature that is on gives one. */
export function featureLink(kind: keyof FeatureLinks, address: string, flags: Partial<Flags> = {}, features: readonly ({ flag: FlagName } & Feature)[] = FEATURES): string | null {
  for (const feature of features) { const make = feature.links?.[kind]; if (make && flags[feature.flag]) return make(address); }
  return null;
}

/** Mock mode: the first answer an enabled feature's mocks give for this route, or undefined. */
export async function featureMock(route: string, method: string, flags: Partial<Flags> = {}, features: readonly ({ flag: FlagName } & Feature)[] = FEATURES): Promise<unknown> {
  for (const feature of features) {
    if (!feature.mocks || !flags[feature.flag]) continue;
    const answer = (await feature.mocks()).default(route, method);
    if (answer !== undefined) return answer;
  }
  return undefined;
}
