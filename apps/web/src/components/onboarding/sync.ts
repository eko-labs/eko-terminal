import { useEffect } from 'react';
import { PreferencesSchema } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { useApp } from '../../store/app';
import { onboardingFromPrefs, persistProgress, useOnboarding } from '../../store/onboarding';

type AppState = ReturnType<typeof useApp.getState>;
const ownerOf = (s: AppState) => s.account?.kind === 'wallet' ? s.account.id : null;

/** Rebind hydration and pending saves when the account changes, including sign-in after boot. */
export function startOnboardingSync(): () => void {
  let stopPersist = () => {};
  let controller = new AbortController();
  let syncing = false;
  const bind = (s: AppState, prev?: AppState) => {
    if (syncing || (prev && ownerOf(s) === ownerOf(prev) && s.preferences === prev.preferences)) return;
    syncing = true;
    stopPersist(); controller.abort(); controller = new AbortController();
    const owner = ownerOf(s), signal = controller.signal;
    const remote = s.account ? onboardingFromPrefs(s.preferences) : null;
    useOnboarding.getState().hydrate(remote, owner);
    stopPersist = persistProgress(remote, async onboarding => {
      if (signal.aborted || ownerOf(useApp.getState()) !== owner || !useApp.getState().account) return;
      const preferences = await fetchParsed('/me/preferences', PreferencesSchema, {
        method: 'PUT', signal, body: { ...useApp.getState().preferences, onboarding },
      });
      if (!signal.aborted && ownerOf(useApp.getState()) === owner) useApp.setState({ preferences });
    });
    syncing = false;
  };
  bind(useApp.getState());
  const unsubscribe = useApp.subscribe(bind);
  return () => { unsubscribe(); stopPersist(); controller.abort(); };
}
export function useOnboardingSync() { useEffect(startOnboardingSync, []); }
