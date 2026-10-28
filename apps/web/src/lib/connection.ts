import { useSyncExternalStore } from 'react';

let apiUnavailable = false;
const listeners = new Set<() => void>();
export function setApiUnavailable(value: boolean) {
  apiUnavailable = value;
  for (const listener of listeners) listener();
}
const snapshot = () => apiUnavailable || (typeof navigator !== 'undefined' && navigator.onLine === false);
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => { listeners.delete(listener); window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
}
export function useConnectionUnavailable() { return useSyncExternalStore(subscribe, snapshot, () => false); }
