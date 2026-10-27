import { lazy, Suspense } from 'react';
import { requestWallet, useWalletState } from '../lib/walletState';
import { IconWallet } from './icons';
const ConnectedButton = lazy(() => import('../WalletRuntime').then(m => ({ default: m.WalletControls })));
export function WalletButton() {
  const ready = useWalletState(s => s.ready);
  const button = <button className="wallet-btn btn btn-primary" onClick={requestWallet} aria-label="Connect wallet" data-testid="wallet-button" data-tour="wallet"><IconWallet size={16} /><span className="wallet-label">Connect wallet</span></button>;
  return ready ? <Suspense fallback={button}><ConnectedButton /></Suspense> : button;
}
