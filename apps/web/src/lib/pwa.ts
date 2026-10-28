import { create } from 'zustand';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export const usePwa = create<{ prompt: InstallEvent | null; installed: boolean; failed: boolean }>(() => ({ prompt: null, installed: false, failed: false }));

export function initializePwa() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    usePwa.setState({ prompt: event as InstallEvent, failed: false });
  });
  window.addEventListener('appinstalled', () => usePwa.setState({ prompt: null, installed: true, failed: false }));
  usePwa.setState({ installed: window.matchMedia('(display-mode: standalone)').matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone });
  if (!['/', '/scan'].includes(location.pathname)) registerPwa();
  // Push registration and permission requests belong to D0.
}

export async function installPwa() {
  const event = usePwa.getState().prompt;
  if (!event) return;
  usePwa.setState({ prompt: null, failed: false });
  try { await event.prompt(); await event.userChoice; }
  catch { usePwa.setState({ failed: true }); }
}

const registered = new WeakSet<ServiceWorkerContainer>();
/** Landing first paint never starts downloading the terminal's offline shell. */
export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || registered.has(navigator.serviceWorker)) return;
  const container = navigator.serviceWorker;
  registered.add(container);
  void container.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => registered.delete(container));
}
