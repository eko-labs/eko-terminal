import { lazy, useLayoutEffect, useMemo, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { create } from 'zustand';
import type { FlagName, Flags } from '@eko/shared';
import { FEATURES, type FeaturePage, type FeatureViews, type ShellPart } from '../features';
import { useShell } from '../store/shell';

/**
 * Alternate views of existing pages that post-launch features can offer (features.ts `views`). App renders each page
 * inside a chain with one small link per feature whose flag is on, keyed by its flag: each link calls its feature's
 * `useActive` hook (never a hook in a loop) and hands the views in use to the next, and the chain's end renders the
 * page with them, so a view's page replaces a route's own in the same render. The end also records the views in use
 * for the menu, which hides or renames entries. With no view in use, every function here answers as if there were
 * none, and the site is unchanged.
 */
type ViewFeature = { flag: FlagName; views: FeatureViews };

/** The features with views whose flag is on, in folder order: the chain's links. */
export function viewFeatures(features: readonly ({ flag: FlagName } & { views?: FeatureViews })[], flags: Partial<Flags> | undefined): ViewFeature[] {
  return features.flatMap(f => f.views && flags?.[f.flag] ? [{ flag: f.flag, views: f.views }] : []);
}
/** Of those, the ones in use (by flag, as recorded at the chain's end). */
export function activeViews(chain: readonly ViewFeature[], active: readonly FlagName[]): FeatureViews[] {
  return chain.filter(f => active.includes(f.flag)).map(f => f.views);
}
/** Whether any feature built into this site has its own view of this route: until the flags are known, it might be in use. */
export function mayHaveView(features: readonly { views?: FeatureViews }[], path: string | undefined): boolean {
  return path !== undefined && features.some(f => !!f.views?.pages[path]);
}

const useViewState = create<{ active: readonly FlagName[]; nav: number }>(() => ({ active: [], nav: 0 }));
/** A view's `hideNav` answer changed (it read state the shell does not watch): the menu is drawn again. */
export const refreshNav = () => useViewState.setState(s => ({ nav: s.nav + 1 }));

/**
 * The flags /config gave on this browser's last visit, so a returning visitor's page can be drawn at once with the view
 * it will most likely have, instead of waiting for /config (the live flags replace these the moment they arrive).
 * Storage is optional; without it every visit waits as before.
 */
const FLAGS_KEY = 'eko.flags';
let lastSeen: Partial<Flags> | null | undefined;
export function lastFlags(): Partial<Flags> | null {
  if (lastSeen !== undefined) return lastSeen;
  try { const v: unknown = JSON.parse(localStorage.getItem(FLAGS_KEY) ?? 'null'); lastSeen = v && typeof v === 'object' ? v as Partial<Flags> : null; }
  catch { lastSeen = null; }
  return lastSeen;
}
export function rememberFlags(flags: Partial<Flags>) {
  lastSeen = flags;
  try { localStorage.setItem(FLAGS_KEY, JSON.stringify(flags)); } catch { /* storage unavailable: the next visit waits for /config */ }
}
/** The live flags once /config has answered, else the last visit's. */
const useFlags = () => useShell(s => s.config?.flags) ?? lastFlags() ?? undefined;
type Render = (views: FeatureViews[]) => ReactNode;

/** The chain's end: renders with the views in use, and records them for the menu before paint. */
function ViewEnd({ found, render }: { found: readonly ViewFeature[]; render: Render }) {
  const flags = found.map(f => f.flag).join(',');
  useLayoutEffect(() => {
    const active = flags ? flags.split(',') as FlagName[] : [];
    useViewState.setState(s => (s.active.join(',') === flags ? s : { active }));
  }, [flags]);
  return <>{render(found.map(f => f.views))}</>;
}
/** One feature's link: its `useActive` hook runs here, once per render. */
function ViewLink({ chain, index, found, render }: { chain: readonly ViewFeature[]; index: number; found: readonly ViewFeature[]; render: Render }) {
  const link = chain[index]!, on = link.views.useActive();
  const next = useMemo(() => (on ? [...found, link] : found), [on, found, link]);
  return <ViewStep chain={chain} index={index + 1} found={next} render={render} />;
}
function ViewStep({ chain, index, found, render }: { chain: readonly ViewFeature[]; index: number; found: readonly ViewFeature[]; render: Render }) {
  const link = chain[index];
  return link ? <ViewLink key={link.flag} chain={chain} index={index} found={found} render={render} /> : <ViewEnd found={found} render={render} />;
}
const NONE: readonly ViewFeature[] = [];
/** The chain for these links: renders `children` with the views in use. */
export function ViewLinks({ chain, children }: { chain: readonly ViewFeature[]; children: Render }) {
  return <ViewStep chain={chain} index={0} found={NONE} render={children} />;
}
/** Renders `children` with the views in use now. App wraps its page in this, once. */
export function ViewChain({ children }: { children: Render }) {
  const flags = useFlags();
  const chain = useMemo(() => viewFeatures(FEATURES, flags), [flags]);
  return <ViewLinks chain={chain}>{children}</ViewLinks>;
}
/** The views in use now, for the shell around the page (none while no feature offers one, or none is chosen). */
export function useActiveViews(): FeatureViews[] {
  const flags = useFlags(), active = useViewState(s => s.active), nav = useViewState(s => s.nav);
  // `nav` is a dependency on purpose: a new array makes the menu ask each view's hideNav again (refreshNav).
  return useMemo(() => activeViews(viewFeatures(FEATURES, flags), active), [flags, active, nav]); // eslint-disable-line react-hooks/exhaustive-deps
}

type Page = LazyExoticComponent<ComponentType<{ params: Record<string, string> }>>;
const loaded = new Map<FeaturePage, Page>();
/** The first view's page for a route path, lazy-loaded once and kept, or null to render the route's own page. */
export function viewPage(views: readonly FeatureViews[], path: string | undefined): Page | null {
  if (path === undefined) return null;
  for (const view of views) {
    const load = view.pages[path];
    if (!load) continue;
    let page = loaded.get(load);
    if (!page) loaded.set(load, page = lazy(load));
    return page;
  }
  return null;
}
/** Whether a view in use hides this menu entry. */
export const navHidden = (views: readonly FeatureViews[], to: string) => views.some(v => v.hideNav?.(to) === true);
/** A menu entry's name: a view in use may rename it. */
export const navLabel = (views: readonly FeatureViews[], to: string, label: string) => views.find(v => v.navLabels?.[to])?.navLabels?.[to] ?? label;
/** Whether a view in use hides this part of the shell. */
export const shellHidden = (views: readonly FeatureViews[], part: ShellPart) => views.some(v => v.hideShell?.includes(part));
