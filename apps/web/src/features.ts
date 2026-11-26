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
 * (`coin`: components/coinSlots.tsx) and places elsewhere (`places`: components/placeSlots.tsx); make those lazy too.
 * And it may offer its own view of existing pages, used while it says so at run time (`views`: components/views.tsx).
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
  /**
   * One tile in the glance row at the top of the coin page: what a trader should take in within two seconds. Render a
   * `GlanceTile` (components/GlanceTile.tsx): a two- or three-word label, one short value, one plain line, a tone. Tiles
   * are laid out by `order` (the page's own: verdict 0, can you sell 10, who holds it 70); render null when there is
   * nothing worth a tile.  The verdict has the band's left column;
   * every tile from order 5 up is a stat in the row beside it.
   */
  glance?: { order: number; component: ComponentType<{ coin: string }> };
  /** A button in the tool row under the chart; its panel opens under the row, one panel at a time. */
  tool?: { label: string; order: number; panel: ComponentType<{ coin: string; close: () => void }> };
  /**
   * A section in one of the coin page's detail tabs (a tab shows only when something fills it). Lead with one plain
   * sentence; tables and long lists go under it, collapsed or short. `id` lets a glance tile jump to it.
   */
  section?: { tab: CoinDetailTab; id: string; title: string; order: number; component: ComponentType<{ coin: string }> };
}
/** The coin page's detail tabs that features can add sections to. */
export const COIN_DETAIL_TABS = ['Overview', "Who's in", 'Odds'] as const;
export type CoinDetailTab = (typeof COIN_DETAIL_TABS)[number];
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
/**
 * Places outside the coin page a feature can fill, shown only while its flag is on (components/placeSlots.tsx). A place
 * is named by what it sits next to, never by a feature.
 */
export interface PlaceSlots {
  /** Next to a launch filter being edited. `filter` is the form's filter as the launch filter API takes it (name,
   *  launchpads, maxVerdict, minimums, quotes, noDevSells), or null while what is typed is not a filter yet: parse it. */
  launchFilter?: ComponentType<{ filter: unknown }>;
  /** In the top bar on every page, desktop and phone (`compact` on the phone bar): a short control, never a menu. */
  header?: ComponentType<{ compact: boolean }>;
}
/**
 * Places in the trade panel a feature can fill, shown only while its flag is on (components/trade/tradeSlots.tsx).
 */
export interface TradeSlots {
  /**
   * Under the amount of a buy being entered: one short line about that amount, updating as it is typed. `onLimit`
   * names the largest amount the line considers sound, or null for none; the panel marks the amount buttons above it.
   */
  amount?: ComponentType<{ coin: string; amountUsd: number; onLimit: (usd: number | null) => void }>;
  /**
   * Another way to trade beside real trading. The panel shows a switch (Real, then `label`) and, while it is chosen,
   * renders `panel` in place of its own. The panel must make plain on its face that it is not real trading.
   */
  mode?: { label: string; panel: ComponentType<{ coin: string; symbol?: string; priceUsd?: number; back: () => void }> };
}
/**
 * Parts of the shell an alternate view can hide while it is in use (FeatureViews.hideShell): the search box atop the side
 * menu, the plan box, the risk mode switch, and the breadcrumb in the top bar.
 */
export const SHELL_PARTS = ['search', 'plan', 'risk', 'crumb'] as const;
export type ShellPart = (typeof SHELL_PARTS)[number];
/**
 * Alternate views of existing pages (components/views.tsx). While the feature's flag is on and `useActive` says so, a
 * route whose path is a key of `pages` renders the feature's page instead of its own; every other route is unchanged,
 * and with `useActive` false the site is exactly as without the feature. Pages load lazily, once.
 */
export interface FeatureViews {
  /** Whether the views are in use now. A hook: called once per render, in its own small component (one per feature). */
  useActive(): boolean;
  /** Its own page for a route, keyed by the route's path pattern (as in routes.ts, e.g. `/coin/:address`). */
  pages: Partial<Record<string, FeaturePage>>;
  /** Menu entries hidden while the views are in use, by the entry's path. The pages still open by URL. */
  hideNav?: (to: string) => boolean;
  /** Other names for menu entries while the views are in use, by the entry's path. */
  navLabels?: Partial<Record<string, string>>;
  /** Parts of the shell hidden while the views are in use. */
  hideShell?: readonly ShellPart[];
}
export interface Feature { views?: FeatureViews; routes?: FeatureRoute[]; nav?: FeatureNav[]; coin?: CoinSlots; places?: PlaceSlots; trade?: TradeSlots; links?: FeatureLinks; mocks?: FeatureMocks; demo?: () => Promise<{ default: FeatureDemo }> }

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
