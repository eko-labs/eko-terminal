import { lazy, useEffect, useLayoutEffect } from 'react';
import type { Feature } from '../../features';
import { navigate } from '../../lib/router';
import { useOnboarding } from '../../store/onboarding';
import { useShell } from '../../store/shell';
import { useSimple } from './choice';
import { missionInMenu, readOwnerAgents } from './missionLink';

/**
 * Simple view (flag `simple_mode`): EKO for someone who has never traded, and the default on a first visit. A Simple |
 * Full switch in the top bar on every page; while Simple is chosen the coins list and the coin page answer one
 * question ("should I buy this?") in a word, one plain reason and one big button, the menu keeps only what a beginner
 * needs, and a short walkthrough lights up one thing at a time. Full is the terminal exactly as without the feature.
 */
/** The menu entries Simple keeps: the coins list, the watchlist, and practice trading (shown only while its flag is on). */
export const SIMPLE_MENU: ReadonlySet<string> = new Set(['/radar', '/watch', '/paper']);

/** While Simple is chosen it is the walkthrough in charge (set before paint): the old tour stays away, and Help replays Simple's own. */
const guide = { replay: () => { navigate('/radar'); useSimple.getState().startWalk('list'); } };
function useActive() {
  const simple = useSimple(s => s.choice === 'simple');
  useLayoutEffect(() => {
    if (!simple) return;
    useOnboarding.getState().setGuide(guide);
    return () => useOnboarding.getState().setGuide(null);
  }, [simple]);
  // An owner who runs agents keeps Mission Control in Simple's menu (read once per signed-in wallet).
  const wallet = useShell(s => s.me?.account.wallet ?? null);
  useEffect(() => {
    if (!simple) return;
    const c = new AbortController();
    void readOwnerAgents(wallet, c.signal);
    return () => c.abort();
  }, [simple, wallet]);
  return simple;
}

const feature: Feature = {
  views: {
    useActive,
    pages: { '/radar': () => import('./SimpleCoins'), '/coin/:address': () => import('./SimpleCoin') },
    hideNav: (to) => !SIMPLE_MENU.has(to) && !(to === '/mission' && missionInMenu()),
    navLabels: { '/radar': 'Coins' },
    hideShell: ['search', 'plan', 'risk', 'crumb'],
  },
  places: { header: lazy(() => import('./Switch')) },
  // Trading counts for the mock radar's coins in mock mode only (demos and update films): never loaded on the live site.
  demo: () => import('./demo'),
};
export default feature;
