import { describe, expect, it } from 'vitest';
import { featuresFrom, type Feature } from './features';
import { ROUTES, withFeatures, enabledRoutes } from './routes';

const Page = async () => ({ default: () => null });
const leaderboards: Feature = { routes: [{ path: '/leaderboards', title: 'Leaderboards', load: Page }, { path: '/leaderboards/:id', title: 'Board', load: Page }],
  nav: [{ group: 'Public record', to: '/leaderboards', label: 'Leaderboards' }] };

describe('feature folders', () => {
  it('names each feature by its folder and skips folders that are not flags', () => {
    const found = featuresFrom({ './features/leaderboards/index.ts': { default: leaderboards }, './features/scratch/index.ts': { default: {} } });
    expect(found.map(f => f.flag)).toEqual(['leaderboards']);
  });
  it("replaces a flag's placeholder page, adds new paths, and shows them only while the flag is on", () => {
    const routes = withFeatures(ROUTES, featuresFrom({ './features/leaderboards/index.ts': { default: leaderboards } }));
    const board = routes.find(r => r.path === '/leaderboards')!;
    expect(board.load).toBe(Page);
    expect(board.flag).toBe('leaderboards');
    expect(routes.find(r => r.path === '/leaderboards/:id')?.flag).toBe('leaderboards');
    expect(routes.filter(r => r.path === '/leaderboards')).toHaveLength(1);
    expect(enabledRoutes({}).some(r => r.path === '/leaderboards')).toBe(false);
  });
});
