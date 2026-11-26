import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeaturePage, FeatureViews } from '../features';
import { ViewLinks, activeViews, mayHaveView, navHidden, navLabel, shellHidden, viewFeatures, viewPage } from './views';

const load: FeaturePage = async () => ({ default: () => null });
const other: FeaturePage = async () => ({ default: () => null });
const views: FeatureViews = {
  useActive: () => true, pages: { '/radar': load, '/coin/:address': load },
  hideNav: to => to !== '/radar' && to !== '/watch', navLabels: { '/radar': 'Coins' }, hideShell: ['plan', 'risk'],
};
const later: FeatureViews = { useActive: () => true, pages: { '/radar': other, '/feed': other } };
const features = [
  { flag: 'size_check' as const },
  { flag: 'paper_trading' as const, views },
  { flag: 'multichart' as const, views: later },
];
const names = (found: FeatureViews[]) => found.map(v => (v === views ? 'first' : v === later ? 'later' : '?')).join(',') || 'none';

describe('alternate page views', () => {
  it('offers no view while no feature with views is on, so every route renders its own page', () => {
    expect(viewFeatures(features, undefined)).toEqual([]);
    expect(viewFeatures(features, { size_check: true })).toEqual([]);
    expect(viewPage([], '/radar')).toBeNull();
    expect(navHidden([], '/feed')).toBe(false);
    expect(navLabel([], '/radar', 'Radar')).toBe('Radar');
    expect(shellHidden([], 'plan')).toBe(false);
    expect(renderToStaticMarkup(<ViewLinks chain={[]}>{found => names(found)}</ViewLinks>)).toBe('none');
  });
  it('chains one link per feature whose flag is on, in folder order, each asking its own feature once', () => {
    expect(viewFeatures(features, { paper_trading: true, multichart: true }).map(f => f.flag)).toEqual(['paper_trading', 'multichart']);
    const first = vi.fn(() => true), second = vi.fn(() => false);
    const chain = [{ flag: 'paper_trading' as const, views: { ...views, useActive: first } }, { flag: 'multichart' as const, views: { ...later, useActive: second } }];
    const html = renderToStaticMarkup(<ViewLinks chain={chain}>{found => found.map(v => v.useActive === first ? 'first' : 'later').join(',') || 'none'}</ViewLinks>);
    expect(html).toBe('first');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(<ViewLinks chain={viewFeatures(features, { paper_trading: true, multichart: true })}>{names}</ViewLinks>)).toBe('first,later');
  });
  it('uses only the views recorded as in use', () => {
    const chain = viewFeatures(features, { paper_trading: true, multichart: true });
    expect(activeViews(chain, [])).toEqual([]);
    expect(activeViews(chain, ['multichart'])).toEqual([later]);
    expect(activeViews(chain, ['paper_trading', 'multichart'])[0]).toBe(views);
  });
  it("renders the first active view's page for a route path, loaded once and kept", () => {
    const first = viewPage([views], '/radar');
    expect(first).not.toBeNull();
    expect(viewPage([views], '/radar')).toBe(first);
    expect(viewPage([views], '/coin/:address')).toBe(first);
    expect(viewPage([views], '/feed')).toBeNull();
    expect(viewPage([views], undefined)).toBeNull();
    // An earlier feature's page wins; a later one fills only the paths the earlier one leaves.
    expect(viewPage([views, later], '/radar')).toBe(first);
    expect(viewPage([views, later], '/feed')).not.toBe(first);
  });
  it('knows which routes a built-in feature could show its own way, so they wait for the flags', () => {
    expect(mayHaveView(features, '/radar')).toBe(true);
    expect(mayHaveView(features, '/pairs')).toBe(false);
    expect(mayHaveView([{}], '/radar')).toBe(false);
    expect(mayHaveView(features, undefined)).toBe(false);
  });
  it('hides and renames menu entries and shell parts only while a view is in use', () => {
    expect(navHidden([views], '/feed')).toBe(true);
    expect(navHidden([views], '/watch')).toBe(false);
    expect(navLabel([views], '/radar', 'Radar')).toBe('Coins');
    expect(navLabel([views], '/watch', 'Watchlist')).toBe('Watchlist');
    expect(shellHidden([views], 'plan')).toBe(true);
    expect(shellHidden([views], 'search')).toBe(false);
  });
});
