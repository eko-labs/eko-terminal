import { useEffect } from 'react';
import { App } from './App';
import { registerPwa } from './lib/pwa';
import { usePath } from './lib/router';
import { requestWallet, useWalletState } from './lib/walletState';
import { useApp } from './store/app';
if (import.meta.env.DEV) (window as unknown as { __eko: typeof useApp }).__eko = useApp;
export default function TerminalApp() {
  const path = usePath(), requested = useWalletState(s => s.requested);
  const needsWallet = requested || /^\/(coin\/|bags$|settings(?:\/|$)|oauth\/|mission(?:\/|$)|approve\/|watch$|internal\/review\/)/.test(path);
  useEffect(() => { if (needsWallet && !requested) useWalletState.setState({ requested: true }); }, [needsWallet, requested]);
  useEffect(() => {
    registerPwa();
    window.addEventListener('eko:open-wallet', requestWallet);
    return () => window.removeEventListener('eko:open-wallet', requestWallet);
  }, []);
  return <App walletEnabled={needsWallet} />;
}
