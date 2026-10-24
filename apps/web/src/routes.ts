import { createElement, type ComponentType } from 'react';
import type { FlagName, Flags } from '@eko/shared';
import { match } from './lib/router';
import { PAGE_TITLES } from './copy/shell';
import { FEATURES } from './features';
export type Stage = 'T' | 'D0' | 'D0+1' | `Drop ${1|2|3|4|5|6|7|8|9}`;
export interface RouteDef {
  path: string; stage: Stage; flag?: FlagName; auth: 'public' | 'siwe';
  workspace: 'terminal' | 'mission' | 'trust' | 'static'; title: string;
  load: () => Promise<{ default: ComponentType<{ params: Record<string, string> }> }>;
}
function route(path: string, stage: Stage, workspace: RouteDef['workspace'], auth: RouteDef['auth'] = 'public', flag?: FlagName): RouteDef {
  const title = PAGE_TITLES[path];
  return { path, stage, workspace, auth, flag, title, load: async () => {
    if (path === '/' || path === '/scan') return import('./pages/scan/Landing');
    if (path === '/scan/:id') return import('./pages/scan/ScanResult');
    if (path === '/legal/:doc') return import('./pages/Legal');
    if (path === '/oauth/consent') return import('./pages/OAuthConsent');
    if (path === '/census') return import('./pages/Census');
    if (path === '/official' || path === '/transparency' || path === '/security') { const pages = await import('./pages/trust/Launch'); return { default: path === '/official' ? pages.Official : path === '/security' ? pages.Security : pages.Transparency }; }
    if (path === '/scoreboard') return import('./pages/trust/Scoreboard');
    if (path === '/receipt/:id') return import('./pages/trust/Receipt');
    if (path === '/drops') return import('./pages/Drops');
    if (path === '/coin/:address') return import('./pages/terminal/Coin');
    if (path === '/deployer/:address') return import('./pages/terminal/Deployer');
    if (path === '/radar') return import('./pages/terminal/Radar');
    if (path === '/pairs') return import('./pages/terminal/Pairs');
    if (path === '/watch') return import('./pages/terminal/Watch');
    if (path === '/settings/plan') return import('./pages/settings/Plan');
    if (path === '/settings') { const { Settings } = await import('./pages/Settings'); return { default: Settings }; }
    if (path === '/feed') return import('./pages/terminal/Feed');
    if (path === '/bags' || path === '/bags/r/:id') return import('./pages/terminal/Bags');
    if (path === '/research') return import('./pages/research/Research');
    if (path === '/mission') return import('./pages/mission/Agents');
    if (path === '/mission/agents/:id') return import('./pages/mission/AgentDetail');
    if (path === '/mission/connect') return import('./pages/mission/Connect');
    if (path === '/mission/approvals' || path === '/approve/:id') return import('./pages/mission/Approvals');
    const { default: Page } = await import('./pages/Placeholder');
    return { default: (props) => createElement(Page, { ...props, title }) };
  } };
}
const BASE_ROUTES: readonly RouteDef[] = [
  route('/', 'T', 'static'),
  route('/radar', 'T', 'terminal'), route('/feed', 'T', 'terminal'), route('/pairs', 'T', 'terminal'),
  route('/coin/:address', 'T', 'terminal'), route('/deployer/:address', 'T', 'terminal'), route('/scan', 'T', 'static'), route('/scan/:id', 'T', 'terminal'),
  route('/bags', 'T', 'terminal', 'siwe'), route('/bags/r/:id', 'T', 'terminal'), route('/watch', 'T', 'terminal', 'siwe'),
  route('/official', 'T', 'trust'), route('/transparency', 'T', 'trust'), route('/security', 'T', 'trust'),
  route('/scoreboard', 'T', 'trust'), route('/receipt/:id', 'T', 'trust'), route('/census', 'T', 'trust'), route('/drops', 'T', 'trust'),
  route('/mission', 'T', 'mission', 'siwe'), route('/mission/agents/:id', 'T', 'mission', 'siwe'), route('/mission/connect', 'T', 'mission', 'siwe'),
  route('/mission/approvals', 'D0', 'mission', 'siwe', 'approvals'), route('/approve/:id', 'D0', 'mission', 'siwe', 'approvals'),
  route('/lab', 'D0', 'mission', 'siwe', 'loop_lab'), route('/lab/:loopId', 'D0', 'mission', 'siwe', 'loop_lab'),
  route('/research', 'D0', 'mission', 'siwe', 'deep_research'), route('/research/:id', 'D0', 'mission', 'siwe', 'deep_research'), route('/perps', 'D0', 'terminal', 'public', 'perps_panel'),
  route('/swarm', 'D0', 'terminal', 'public', 'beat_the_swarm'),
  route('/embed/clear/:address', 'D0', 'static', 'public', 'clear_badge'),
  route('/oauth/consent', 'T', 'static', 'siwe'),
  route('/settings', 'T', 'terminal'),
  // §3.20 clarifies §2.2: plan is dormant at T; tiers_active gates its controls, not its URL.
  route('/settings/plan', 'T', 'terminal'), route('/legal/:doc', 'T', 'static'),
  route('/afi', 'Drop 1', 'terminal', 'public', 'afi'), route('/embed/afi', 'Drop 1', 'static', 'public', 'afi'),
  route('/crews', 'Drop 2', 'terminal', 'public', 'rug_ring_radar'), route('/crews/:id', 'Drop 2', 'terminal', 'public', 'rug_ring_radar'),
  route('/leaderboards', 'Drop 2', 'trust', 'public', 'leaderboards'), route('/arena', 'Drop 3', 'terminal', 'public', 'arena'),
  route('/desk/:runId', 'Drop 4', 'terminal', 'public', 'desk_live'), route('/mission/launcher', 'Drop 5', 'mission', 'siwe', 'agent_launcher'),
  route('/inside', 'Drop 7', 'static', 'public', 'eko_inside'), route('/embed/verdict/:address', 'Drop 7', 'static', 'public', 'eko_inside'),
];
/**
 * The base routes plus each feature folder's pages (features.ts). A feature page replaces the placeholder at its path,
 * or adds a new path; either way it is shown only while the feature's flag is on.
 */
export function withFeatures(base: readonly RouteDef[], features: typeof FEATURES): readonly RouteDef[] {
  const routes = [...base];
  for (const feature of features) for (const page of feature.routes ?? []) {
    const i = routes.findIndex(r => r.path === page.path), base = i >= 0 ? routes[i]! : undefined;
    const def: RouteDef = { path: page.path, stage: base?.stage ?? 'D0', flag: feature.flag, auth: page.auth ?? base?.auth ?? 'public',
      workspace: page.workspace ?? base?.workspace ?? 'terminal', title: page.title, load: page.load };
    if (i >= 0) routes[i] = def; else routes.push(def);
  }
  return routes;
}
export const ROUTES = withFeatures(BASE_ROUTES, FEATURES);
// TODO(spec): §9.3 gives no review URL/stage. Keep the assigned internal view
// outside launch navigation and public route stages; API sessions enforce access.
export const INTERNAL_ROUTES: readonly RouteDef[] = [{
  path: '/internal/review/:revisionId', stage: 'T', workspace: 'static', auth: 'siwe',
  title: 'Blinded evidence review', load: () => import('./pages/review/Review'),
}];
export function enabledRoutes(flags: Partial<Flags> = {}) { return ROUTES.filter((r) => !r.flag || flags[r.flag]); }
export function resolveRoute(path: string, flags: Partial<Flags> = {}) {
  for (const route of [...INTERNAL_ROUTES, ...enabledRoutes(flags)]) { const params = match(route.path, path); if (params) return { route, params }; }
  return null;
}
export function isCurrent(to: string, path: string) {
  if (to === '/radar') return path === to || path.startsWith('/coin/') || path.startsWith('/scan/');
  if (to === '/mission') return path === to || path.startsWith('/mission/agents/');
  return path === to || path.startsWith(`${to}/`);
}
