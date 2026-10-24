import { describe, expect, it } from 'vitest';
import { FLAG_NAMES } from '@eko/shared';
import { enabledRoutes, isCurrent, resolveRoute, ROUTES } from './routes';
import { match } from './lib/router';
const allFlags = Object.fromEntries(FLAG_NAMES.map((flag) => [flag, true]));
const T = ['/', '/radar', '/feed', '/pairs', '/coin/:address', '/deployer/:address', '/scan', '/scan/:id', '/bags', '/bags/r/:id', '/watch', '/official', '/transparency', '/security', '/scoreboard', '/receipt/:id', '/census', '/drops', '/mission', '/mission/agents/:id', '/mission/connect', '/oauth/consent', '/settings', '/settings/plan', '/legal/:doc'];
describe('§2.2 route table', () => {
  it('keeps every T URL, including dormant settings/plan, with all flags off', () => {
    expect(enabledRoutes().map((r) => r.path)).toEqual(T);
    expect(ROUTES.filter((r) => r.stage === 'T').map((r) => r.path)).toEqual(T);
  });
  it('registers D0 and Drop routes only under their exact shared flag', () => {
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(44);
    for (const r of ROUTES.filter((r) => r.stage !== 'T')) {
      expect(r.flag).toBeDefined(); expect(FLAG_NAMES).toContain(r.flag);
      expect(enabledRoutes()).not.toContain(r);
      expect(enabledRoutes({ [r.flag!]: true })).toContain(r);
      expect(enabledRoutes({ ...allFlags, [r.flag!]: false })).not.toContain(r);
    }
    expect(enabledRoutes(allFlags)).toEqual(ROUTES);
  });
  it('resolves deep links and rejects unknown, flagged-off and malformed paths', () => {
    expect(resolveRoute('/coin/0x123')?.params).toEqual({ address: '0x123' });
    expect(resolveRoute('/bags/r/report-1')?.route.auth).toBe('public');
    expect(resolveRoute('/bags')?.route.auth).toBe('siwe');
    expect(resolveRoute('/mission/agents/a-1')?.route.auth).toBe('siwe');
    expect(resolveRoute('/settings')?.route.auth).toBe('public');
    expect(resolveRoute('/settings/plan')?.route.stage).toBe('T');
    for (const path of ['/no-such-page', '/trade', '/lab', '/arena', '/coin/%ZZ']) expect(resolveRoute(path)).toBeNull();
    // The Burn Board was dropped (owner decision 2026-10-05); no flag brings it back.
    expect(resolveRoute('/burn', allFlags)).toBeNull();
    expect(match('/scan/:id', '/scan/a%20b')).toEqual({ id: 'a b' });
  });
  it('keeps coin and agent breadcrumbs in their parent navigation', () => {
    expect(isCurrent('/radar', '/coin/0x123')).toBe(true);
    expect(isCurrent('/mission', '/mission/agents/a-1')).toBe(true);
    expect(isCurrent('/mission', '/mission/connect')).toBe(false);
  });
  it('loads a page component for every route', async () => {
    for (const r of ROUTES) expect(typeof (await r.load()).default).toBe('function');
  });
});
